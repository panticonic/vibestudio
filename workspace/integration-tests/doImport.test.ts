/**
 * P4 — git import as staged-lineage-then-publish (docs/narrow-host-vcs-plan.md
 * §6 "Git import", §8-P4; kills Motivation finding 2 structurally).
 *
 * Drives the REAL git-bridge core (`GitBridge`) against the REAL gad-store DO
 * with in-process host bridges (RefService + content store over a blob dir),
 * mirroring the doVcsPush harness. Exercises the full new flow end-to-end:
 *
 *   git checkout on disk → bridge scans + mirrors + ingests onto a NON-MAIN
 *   `import:main` staging head → DO `vcsImportPublish` records a write-ahead
 *   intent → `refs.updateMains({ operation: "import" })` (approval-gated,
 *   single-writer) → provenance recorded onto the main lineage.
 *
 * Asserts: main moves, the gate sees operation "import", imported history is
 * preserved (main log + staging log carry the import commit), re-import is a
 * no-op, and the import publish path never pre-validates builds (the host
 * approval prompt's build-status line is the truthfulness surface, not a DO
 * gate). Negative: a generic extension ingesting onto a main head is rejected,
 * and the deleted adoption surface no longer resolves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../workers/gad-store/index.js";
import { GitBridge, type BridgeHost } from "../extensions/git-bridge/bridge.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../src/server/services/refService.js";
import {
  ensureLayout,
  getBytes,
  getTree,
  listTree,
  putBytes,
  putTree,
  statBlob,
} from "../../src/server/services/blobstoreService.js";
import type { ManifestHashEntry } from "@vibez1/shared/contentTree/worktreeHash";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const REPO = "packages/imported";
const LOG = `vcs:repo:${REPO}`;
const STAGING = "import:main";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("git import (staged-lineage → gated single-writer publish, P4)", () => {
  let root: string;
  let blobsDir: string;
  let workspaceRoot: string;
  let repoDir: string;
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let refs: ReturnType<typeof createRefService>;
  let gateCalls: Array<{ operation: string; entries: unknown[]; onBehalfOf: string | null }>;
  let buildValidateCalls: number;
  let bridge: GitBridge;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "do-import-"));
    blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    workspaceRoot = path.join(root, "workspace");
    repoDir = path.join(workspaceRoot, ...REPO.split("/"));
    await fsp.mkdir(repoDir, { recursive: true });
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    doi = gad.instance;
    gateCalls = [];
    buildValidateCalls = 0;
    refs = createRefService({
      statePath: path.join(root, "refs"),
      // The main-advance approval gate. A git import advances a repo's main, so
      // it flows through here exactly like a push — recorded for assertions.
      gate: async (batch) => {
        gateCalls.push({
          operation: batch.operation,
          entries: batch.entries,
          onBehalfOf: batch.onBehalfOf,
        });
      },
    });
    attachLocalHostBridges(gad.instance, {
      blobsDir,
      refs: () => refs,
      buildValidate: async (input) => {
        buildValidateCalls += 1;
        return input.repoPaths.map((p) => ({ unit: p, required: true, status: "ok" }));
      },
    });

    const host: BridgeHost = {
      workspaceRoot: async () => workspaceRoot,
      store: {
        vcsLog: async (repoPath, limit, head) => doi.vcsLog(repoPath, limit, head),
        ingestWorktreeState: (input) =>
          doi.ingestWorktreeState(input as Parameters<GadWorkspaceDO["ingestWorktreeState"]>[0]),
        listStateFiles: async (stateHash) =>
          doi.listStateFiles({ stateHash }) as unknown as Array<{
            path: string;
            content_hash: string;
            mode: number;
          }>,
        importPublish: (input) =>
          (doi as unknown as {
            vcsImportPublish: (i: unknown) => Promise<{
              status: "published" | "up-to-date";
              repoPath: string;
              stateHash: string;
            }>;
          }).vcsImportPublish(input),
      },
      // The bridge's content store IS the host content store the DO reads via
      // attachLocalHostBridges — the same blob dir, so the mirror + publish see
      // one tree.
      blobstore: {
        has: async (digest) => (await statBlob(blobsDir, digest)) !== null,
        putBase64: async (bytesBase64) => {
          const { digest, size } = await putBytes(blobsDir, Buffer.from(bytesBase64, "base64"));
          return { digest, size };
        },
        getBase64: async (digest) => {
          const bytes = await getBytes(blobsDir, digest);
          return bytes ? bytes.toString("base64") : null;
        },
        putTree: (entries: ManifestHashEntry[], opts) => putTree(blobsDir, entries, opts),
        getTree: (ref) => getTree(blobsDir, ref),
        listTree: async (ref, opts) => {
          const entries = await listTree(blobsDir, ref, opts);
          return entries
            ? entries.map((e) => ({
                path: e.path,
                kind: e.kind,
                contentHash: e.contentHash,
                mode: e.mode,
              }))
            : null;
        },
      },
      refs: {
        readMain: async (repoPath) => {
          const record = refs.readMain(repoPath);
          return record ? { stateHash: record.stateHash } : null;
        },
      },
      state: (() => {
        const map = new Map<string, string>();
        return {
          get: async (key) => map.get(key) ?? null,
          set: async (key, value) => {
            map.set(key, value);
          },
        };
      })(),
    };
    bridge = new GitBridge(host);

    // A git checkout with outside-world history.
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "ext@example.com"]);
    git(repoDir, ["config", "user.name", "External Dev"]);
    await fsp.writeFile(path.join(repoDir, "README.md"), "# imported\n");
    await fsp.writeFile(path.join(repoDir, "index.js"), "export const x = 1;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "initial import"]);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const readMain = (): string | null => refs.readMain(REPO)?.stateHash ?? null;

  it("stages imported history then publishes onto main through updateMains(import)", async () => {
    expect(readMain()).toBeNull();

    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);

    // Main advanced to the imported tree via the gated single-writer path.
    expect(readMain()).toBe(imported.stateHash);
    // The advance went through the approval gate as an IMPORT operation.
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]?.operation).toBe("import");
    expect((gateCalls[0]?.entries as Array<{ repoPath: string; next: string | null }>)[0]).toMatchObject({
      repoPath: REPO,
      old: null,
      next: imported.stateHash,
    });

    // Imported history is preserved on BOTH the staging lineage and, after
    // publish, the main provenance lineage (the DO's recorded main head).
    const staging = doi.resolveWorktreeHead({ logId: LOG, head: STAGING });
    expect(staging?.stateHash).toBe(imported.stateHash);
    const mainHead = (doi as unknown as {
      resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
    }).resolveWorktreeHeadInternal(LOG, "main");
    expect(mainHead?.stateHash).toBe(imported.stateHash);
    const mainLog = doi.vcsLog(REPO, 5, "main");
    expect(mainLog[0]?.outputStateHash).toBe(imported.stateHash);
    expect(mainLog[0]?.summary).toContain(`Import ${REPO} from git`);

    // The pending intent completed and was cleared.
    const pending = (gad.instance as unknown as {
      sql: { exec: (s: string) => { toArray: () => unknown[] } };
    }).sql
      .exec("SELECT * FROM gad_publish_intents")
      .toArray();
    expect(pending).toHaveLength(0);

    // Import publish never pre-validates builds — the host approval prompt's
    // HOST-SOURCED build-status line is the truthfulness surface, not a DO gate.
    expect(buildValidateCalls).toBe(0);
  });

  it("re-import of an unchanged checkout is a no-op against the published main", async () => {
    const first = await bridge.importRepoTree(REPO);
    expect(first.changed).toBe(true);
    expect(gateCalls).toHaveLength(1);

    const again = await bridge.importRepoTree(REPO);
    expect(again).toEqual({ stateHash: first.stateHash, changed: false });
    // No second advance — main untouched, gate not re-invoked.
    expect(gateCalls).toHaveLength(1);
    expect(readMain()).toBe(first.stateHash);
  });

  it("publishes a subsequent outside-world change onto main (import over existing)", async () => {
    const first = await bridge.importRepoTree(REPO);
    expect(readMain()).toBe(first.stateHash);

    // An outside-world edit lands in the checkout.
    await fsp.writeFile(path.join(repoDir, "index.js"), "export const x = 2;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "upstream change"]);

    const second = await bridge.importRepoTree(REPO);
    expect(second.changed).toBe(true);
    expect(second.stateHash).not.toBe(first.stateHash);
    expect(readMain()).toBe(second.stateHash);
    // Second advance: expectedOld is the previously-published main (FF-CAS).
    expect(gateCalls).toHaveLength(2);
    expect(gateCalls[1]?.operation).toBe("import");
    expect((gateCalls[1]?.entries as Array<{ old: string | null }>)[0]?.old).toBe(first.stateHash);
  });

  it("rejects a generic extension ingesting directly onto a repo main lineage (finding 2)", async () => {
    const contentHash = sha256Hex(Buffer.from("payload\n", "utf8"));
    await expect(
      gad.callAs("extension", "ingestWorktreeState", {
        logId: LOG,
        head: "main",
        logKind: "vcs",
        actor: { id: "evil-ext", kind: "system" },
        files: [{ path: "a.txt", contentHash, size: 8, mode: 33188 }],
      })
    ).rejects.toThrow(/may not ingest onto a protected main lineage/);
    // Main never advanced; nothing attributed.
    expect(readMain()).toBeNull();
  });

  it("the deleted adoptImportedRepo surface no longer resolves", async () => {
    await expect(
      gad.callAs("extension", "adoptImportedRepo", REPO)
    ).rejects.toThrow();
  });
});
