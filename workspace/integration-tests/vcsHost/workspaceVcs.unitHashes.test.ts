/**
 * CACHE-KEY STABILITY PROOF for the content-store unit-hash migration
 * (blob-addressed-cleanly step 3).
 *
 * buildV2 effective versions — and therefore build keys and the entire build
 * cache — are pure functions of per-unit subtree hashes. This suite pins the
 * critical invariant of moving `WorkspaceVcs.unitHashes` off the gad DO onto
 * content-store tree resolution: for the SAME ingested state, the hashes
 * resolved from the content store are BYTE-IDENTICAL to the shared reference
 * implementation (`buildWorktreeManifest().subtreeHash` over the DO's durable
 * file listing — the canonical hashing both the server and the DO implement).
 * Identical hashes ⇒ identical EVs ⇒ identical build keys ⇒ the build cache
 * survives the source swap without a BUILD_CACHE_VERSION bump.
 *
 * Verified against the REAL gad-store DO (workerd test-utils), matching the
 * treeMirror.test.ts / workspaceVcs.bootstrap.test.ts patterns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { buildWorktreeManifest } from "@vibez1/shared/contentTree/worktreeHash";
import { GadWorkspaceDO } from "../../workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../../src/server/services/refService.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const USER = { id: "user", kind: "user" };
const text = (t: string) => ({ kind: "text" as const, text: t });

function callerFor(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

/**
 * Reference unit hashes: the DO's durable per-repo `main` listings (recorded
 * through the direct provenance ingest — drained first), re-rooted under
 * their repo paths and re-hashed with the shared reference implementation
 * (`buildWorktreeManifest().subtreeHash`). Since P5a the composed workspace
 * view is SERVER-minted (the DO never holds a state row for it), so the
 * cross-implementation oracle asserts that the DO's durable listings
 * reproduce the exact composed state hash the server handed out.
 */
async function referenceUnitHashes(
  vcs: WorkspaceVcs,
  gad: TestGad,
  stateHash: string,
  paths: string[]
): Promise<Record<string, string | null>> {
  await vcs.flushMainProvenance();
  const heads = gad.instance.listWorktreeHeads({
    logIdPrefix: "vcs:repo:",
    head: "main",
  }) as Array<{ logId: string; stateHash: string }>;
  const files: Array<{ path: string; contentHash: string; mode: number }> = [];
  for (const head of heads) {
    const repoPath = head.logId.slice("vcs:repo:".length);
    const listing = gad.instance.listStateFiles({ stateHash: head.stateHash }) as Array<{
      path: string;
      content_hash: string;
      mode: number;
    }>;
    for (const file of listing) {
      files.push({
        path: `${repoPath}/${file.path}`,
        contentHash: file.content_hash,
        mode: file.mode,
      });
    }
  }
  const manifest = buildWorktreeManifest(files);
  // The DO's durable listings must reproduce the composed state the server
  // handed out — otherwise the oracle itself is meaningless.
  expect(manifest.stateHash).toBe(stateHash);
  return Object.fromEntries(paths.map((p) => [p, manifest.subtreeHash(p)]));
}

describe("WorkspaceVcs.unitHashes — content store vs canonical reference equality", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  // Unit-shaped paths of every flavor the build system asks about: unit
  // directories (some nested), a FILE unit path, and an absent path.
  const UNIT_PATHS = [
    "packages/foo",
    "panels/chat",
    "skills/onboarding",
    "meta",
    "meta/vibez1.yml", // file → plain content hash
    "panels/chat/src", // nested dir inside a unit
    "panels/nope", // absent → null
  ];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "unithash-eq-"));
    workspaceRoot = path.join(root, "workspace");
    const write = async (rel: string, body: string) => {
      const abs = path.join(workspaceRoot, ...rel.split("/"));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, body);
    };
    await write("packages/foo/package.json", '{ "name": "@workspace/foo" }\n');
    await write("packages/foo/index.ts", "export const x = 1;\n");
    await write("panels/chat/package.json", '{ "name": "@workspace-panels/chat" }\n');
    await write("panels/chat/src/index.tsx", "export const Chat = () => null;\n");
    await write("panels/chat/src/deep/util.ts", "export const u = 0;\n");
    await write("skills/onboarding/SKILL.md", "# Onboarding\n");
    await write("meta/vibez1.yml", "name: test\n");
    // An executable, so modes flow through both hash sources.
    const script = path.join(workspaceRoot, "packages/foo/run.sh");
    await fsp.writeFile(script, "#!/bin/sh\necho hi\n");
    await fsp.chmod(script, 0o755);

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });

    // The in-process test DO has no RPC gateway; give computeMerge a local

    // content store over this test's blob dir (production uses blobstore.* RPC).

    const refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("resolves BYTE-IDENTICAL unit hashes from the content store and the reference implementation", async () => {
    await vcs.attachGad(callerFor(gad));
    const { stateHash } = await vcs.ensureFresh();

    const fromStore = await vcs.unitHashes(stateHash, UNIT_PATHS);
    const fromReference = await referenceUnitHashes(vcs, gad, stateHash, UNIT_PATHS);
    expect(fromStore).toEqual(fromReference);

    // Shape sanity: dirs are manifest hashes, files plain content digests,
    // absent paths null — the exact values effectiveVersion.ts folds into EVs.
    expect(fromStore["packages/foo"]).toMatch(/^manifest:[0-9a-f]{64}$/);
    expect(fromStore["panels/chat/src"]).toMatch(/^manifest:[0-9a-f]{64}$/);
    expect(fromStore["meta/vibez1.yml"]).toMatch(/^[0-9a-f]{64}$/);
    expect(fromStore["panels/nope"]).toBeNull();
  });

  it("stays byte-identical across an edit → commit → push advance, shifting ONLY the touched unit", async () => {
    await vcs.attachGad(callerFor(gad));
    const before = await vcs.ensureFresh();
    const hashesBefore = await vcs.unitHashes(before.stateHash, UNIT_PATHS);

    // Advance panels/chat through the real flow (main only advances via push).
    const head = vcsContextHead("eq-test");
    await vcs.recordEdit({
      head,
      repoPath: "panels/chat",
      actor: USER,
      edits: [
        { kind: "write", path: "src/index.tsx", content: text("export const Chat = () => 1;\n") },
      ],
    });
    await vcs.commit({ head, repoPath: "panels/chat", message: "edit chat", actor: USER });
    const pushed = await pushToMain(gad, { repoPaths: ["panels/chat"], sourceHead: head, actor: USER });
    expect(pushed.status).toBe("pushed");

    const after = await vcs.ensureFresh();
    expect(after.stateHash).not.toBe(before.stateHash);

    const fromStore = await vcs.unitHashes(after.stateHash, UNIT_PATHS);
    expect(fromStore).toEqual(await referenceUnitHashes(vcs, gad, after.stateHash, UNIT_PATHS));

    // Only the touched unit (and its nested dir) shifted — untouched units'
    // hashes (⇒ EVs ⇒ build keys) are unchanged, keeping their cache valid.
    expect(fromStore["panels/chat"]).not.toBe(hashesBefore["panels/chat"]);
    expect(fromStore["panels/chat/src"]).not.toBe(hashesBefore["panels/chat/src"]);
    expect(fromStore["packages/foo"]).toBe(hashesBefore["packages/foo"]);
    expect(fromStore["skills/onboarding"]).toBe(hashesBefore["skills/onboarding"]);
    expect(fromStore["meta"]).toBe(hashesBefore["meta"]);
    expect(fromStore["meta/vibez1.yml"]).toBe(hashesBefore["meta/vibez1.yml"]);
  });

  it("bootstrap (pre-attach) unit hashes equal the post-attach reference hashes for the same tree", async () => {
    // Pre-attach: local scan manifest (the deliberate bootstrap exception).
    const local = await vcs.ensureFresh();
    const bootstrapHashes = await vcs.unitHashes(local.stateHash, UNIT_PATHS);

    // Attach: the DO ingests the same tree; the composed workspace view state
    // is hash-identical by construction (no EV churn at handover).
    await vcs.attachGad(callerFor(gad));
    const attached = await vcs.ensureFresh();
    expect(attached.stateHash).toBe(local.stateHash);

    expect(bootstrapHashes).toEqual(
      await referenceUnitHashes(vcs, gad, attached.stateHash, UNIT_PATHS)
    );
    // And the attached (content-store) path agrees with both.
    expect(await vcs.unitHashes(attached.stateHash, UNIT_PATHS)).toEqual(bootstrapHashes);
  });
});
