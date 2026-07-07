/**
 * End-to-end git upstream (push/pull) coverage for the git-bridge feature.
 *
 * Drives the REAL git-bridge core (`GitBridge`) against the REAL gad-store DO
 * with in-process host bridges (RefService + content store over a blob dir) —
 * the same harness as `doImport.test.ts` — and layers the OUTSIDE-WORLD git
 * interchange on top with the system `git` CLI:
 *
 *   fixture repo (system git, 2 commits)  --clone --bare-->  bare "upstream"
 *          │ clone
 *          ▼
 *   workspace/<repoPath> checkout  (origin → bare)
 *
 * The UpstreamEngine wires config/credentials/notifications that this harness
 * deliberately does not stand up; its push path uses isomorphic-git, which does
 * NOT support push over `file://`. So the REQUIRED coverage — the bridge+git
 * fast-forward round trip — exercises the bridge export/import directly and
 * performs the wire PUSH with the system `git` CLI from the checkout (exactly
 * what validates the fast-forward story). The GitClient push path is unit-tested
 * elsewhere.
 *
 * The suite is sequential: one shared fixture (beforeAll), each `it` builds on
 * the prior. gad `main` is advanced between export cycles through the DO's OWN
 * gated single-writer import-publish path (ingest onto the non-main staging head
 * → `vcsImportPublish` → RefService), which is the faithful stand-in for a
 * workspace-internal commit: it advances the protected ref WITHOUT moving the
 * git-bridge export marker (only export/import move the marker), so the next
 * export has exactly one new transition to emit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../workspace/workers/gad-store/index.js";
import {
  GitBridge,
  IMPORT_STAGING_HEAD,
  type BridgeHost,
} from "../../workspace/extensions/git-bridge/bridge.js";
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
import type { ManifestHashEntry } from "@vibestudio/shared/contentTree/worktreeHash";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const REPO = "packages/imported";
const LOG = `vcs:repo:${REPO}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Run git tolerating a non-zero exit; returns combined stdout+stderr so the
 *  non-fast-forward rejection is inspectable. */
function gitTry(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function headOf(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

describe("git upstream push/pull round trip (bridge + system git, real DO)", () => {
  let root: string;
  let blobsDir: string;
  let fixtureDir: string;
  let bareDir: string;
  let workspaceRoot: string;
  let repoDir: string;
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let refs: ReturnType<typeof createRefService>;
  let bridge: GitBridge;
  const stateMap = new Map<string, string>();

  // Shared, mutated across the sequential steps below.
  let clonedHead: string;
  let state1: string;
  let state2: string;
  let state3: string;
  let exportCommit1: string;

  const readMain = (): string | null => refs.readMain(REPO)?.stateHash ?? null;

  const getMarker = async (): Promise<{ stateHash: string; commitSha: string } | null> => {
    const raw = stateMap.get(`marker:${REPO}`);
    return raw ? (JSON.parse(raw) as { stateHash: string; commitSha: string }) : null;
  };

  const mainActorId = (): string => {
    const top = doi.vcsLog(REPO, 1, "main")[0];
    const actor = top?.actor as { id?: unknown } | null | undefined;
    return actor && typeof actor === "object" ? String(actor.id) : "";
  };

  /**
   * Advance the repo's protected `main` by one snapshot through the DO's OWN
   * gated import-publish path — the faithful net effect of a workspace-internal
   * commit. Mirrors blob bytes into the shared content store (so a later export
   * can materialize them), ingests the full tree onto the non-main staging head,
   * then publishes onto `main` via `vcsImportPublish` (→ RefService). Does NOT
   * touch the git checkout or the git-bridge export marker.
   */
  async function advanceMain(
    files: Record<string, string>,
    opts: { actorId: string; summary: string }
  ): Promise<string> {
    const fileList: Array<{ path: string; contentHash: string; size: number; mode: number }> = [];
    for (const [rel, text] of Object.entries(files)) {
      const bytes = Buffer.from(text, "utf8");
      const { digest, size } = await putBytes(blobsDir, bytes);
      fileList.push({ path: rel, contentHash: digest, size, mode: 33188 });
    }
    fileList.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    await doi.ingestWorktreeState({
      logId: LOG,
      head: IMPORT_STAGING_HEAD,
      logKind: "vcs",
      actor: { id: "git-bridge", kind: "system" },
      files: fileList,
      summary: opts.summary,
    });
    const published = await (
      doi as unknown as {
        vcsImportPublish: (i: {
          repoPath: string;
          sourceHead: string;
          message?: string;
          actor?: { id: string; kind: string };
        }) => Promise<{ status: string; repoPath: string; stateHash: string }>;
      }
    ).vcsImportPublish({
      repoPath: REPO,
      sourceHead: IMPORT_STAGING_HEAD,
      message: opts.summary,
      actor: { id: opts.actorId, kind: "system" },
    });
    return published.stateHash;
  }

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "git-upstream-"));
    blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    workspaceRoot = path.join(root, "workspace");
    fixtureDir = path.join(root, "fixture");
    bareDir = path.join(root, "upstream.git");
    repoDir = path.join(workspaceRoot, ...REPO.split("/"));

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    doi = gad.instance;
    refs = createRefService({
      statePath: path.join(root, "refs"),
      // A git import/publish advances a repo's main, flowing through this
      // approval gate exactly like a push. Semantics-free here.
      gate: async () => {},
    });
    attachLocalHostBridges(gad.instance, {
      blobsDir,
      refs: () => refs,
      buildValidate: async (input) =>
        input.repoPaths.map((p) => ({
          repoPath: p,
          kind: "package",
          role: "pushed" as const,
          required: true,
          status: "ok" as const,
          builds: [],
        })),
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
          (
            doi as unknown as {
              vcsImportPublish: (i: unknown) => Promise<{
                status: "published" | "up-to-date";
                repoPath: string;
                stateHash: string;
              }>;
            }
          ).vcsImportPublish(input),
      },
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
                ...(e.kind === "file" ? { contentHash: e.contentHash, mode: e.mode } : {}),
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
      state: {
        get: async (key) => stateMap.get(key) ?? null,
        set: async (key, value) => {
          stateMap.set(key, value);
        },
      },
    };
    bridge = new GitBridge(host);

    // (1) Fixture git repo with two commits.
    await fsp.mkdir(fixtureDir, { recursive: true });
    git(fixtureDir, ["init", "-b", "main"]);
    git(fixtureDir, ["config", "user.email", "fixture@example.com"]);
    git(fixtureDir, ["config", "user.name", "Fixture Dev"]);
    await fsp.writeFile(path.join(fixtureDir, "README.md"), "# fixture\n");
    await fsp.mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(fixtureDir, "src", "app.js"), "v1\n");
    git(fixtureDir, ["add", "."]);
    git(fixtureDir, ["commit", "-m", "initial commit"]);
    await fsp.writeFile(path.join(fixtureDir, "src", "app.js"), "v2\n");
    git(fixtureDir, ["add", "."]);
    git(fixtureDir, ["commit", "-m", "second commit"]);

    // A bare clone of the fixture is the outside-world "upstream".
    git(root, ["clone", "--bare", fixtureDir, bareDir]);

    // Clone the fixture into the workspace checkout location, remote → bare.
    await fsp.mkdir(path.dirname(repoDir), { recursive: true });
    git(root, ["clone", fixtureDir, repoDir]);
    git(repoDir, ["config", "user.email", "checkout@example.com"]);
    git(repoDir, ["config", "user.name", "Checkout Dev"]);
    git(repoDir, ["remote", "set-url", "origin", bareDir]);
    clonedHead = headOf(repoDir);

    // Sanity: fixture, bare, and checkout all start at the same HEAD.
    expect(headOf(fixtureDir)).toBe(clonedHead);
    expect(git(bareDir, ["rev-parse", "HEAD"]).trim()).toBe(clonedHead);
  }, 60_000);

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("imports the cloned checkout tree onto gad main and marks the cloned HEAD", async () => {
    expect(readMain()).toBeNull();

    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);
    state1 = imported.stateHash;

    // gad main advanced to the imported tree through the gated publish path.
    expect(readMain()).toBe(state1);

    // The export marker points at the cloned git HEAD with the imported state.
    const marker = await getMarker();
    expect(marker).not.toBeNull();
    expect(marker?.stateHash).toBe(state1);
    expect(marker?.commitSha).toBe(clonedHead);

    // Main log carries the import transition.
    expect(doi.vcsLog(REPO, 1, "main")[0]?.outputStateHash).toBe(state1);
  });

  it("advances gad main then exports exactly one new commit with GAD trailers", async () => {
    // (3) Advance main with a NEW snapshot via the DO's gated publish path
    // (leaves the git-bridge export marker at the cloned HEAD).
    state2 = await advanceMain(
      { "README.md": "# fixture\n", "src/app.js": "v3\n", "docs/NOTES.md": "first note\n" },
      { actorId: "release-bot-actor", summary: "workspace edit: bump app + add notes" }
    );
    expect(state2).not.toBe(state1);
    expect(readMain()).toBe(state2);
    const publishedActor = mainActorId();
    expect(publishedActor).toBe("release-bot-actor");

    // (4) Export — exactly one new commit on top of the imported (cloned) HEAD.
    const exported = await bridge.exportRepoHead(REPO, {
      authorEmail: "release-bot@example.com",
    });
    expect(exported.exported).toBe(1);
    expect(exported.headCommit).toMatch(/^[0-9a-f]{40}$/);
    exportCommit1 = exported.headCommit!;

    // The new commit sits directly on top of the cloned HEAD.
    expect(git(repoDir, ["rev-parse", "HEAD^"]).trim()).toBe(clonedHead);

    // Trailers identify repo/state/event; the exported tree is state2.
    const body = git(repoDir, ["log", "-1", "--format=%B"]);
    expect(body).toContain(`GAD-Repo: ${REPO}`);
    expect(body).toContain(`GAD-State: ${state2}`);
    expect(body).toMatch(/GAD-Event: \S+/);

    // author name falls back to the gad actor id when only authorEmail is given.
    expect(git(repoDir, ["log", "-1", "--format=%ae"]).trim()).toBe("release-bot@example.com");
    const authorName = git(repoDir, ["log", "-1", "--format=%an"]).trim();
    expect(authorName).toBe(publishedActor);
    expect(authorName).not.toBe("release-bot@example.com");
    expect(authorName).not.toBe("vibestudio@local");

    // The materialized tree matches the exported snapshot.
    expect(await fsp.readFile(path.join(repoDir, "src", "app.js"), "utf8")).toBe("v3\n");
    expect(await fsp.readFile(path.join(repoDir, "docs", "NOTES.md"), "utf8")).toBe("first note\n");
  });

  it("pushes the exported head to the bare upstream as a fast-forward", async () => {
    // (5) System git push from the checkout to the bare upstream.
    const pushed = gitTry(repoDir, ["push", "origin", "main"]);
    expect(pushed.ok).toBe(true);
    expect(git(bareDir, ["rev-parse", "main"]).trim()).toBe(exportCommit1);
    expect(git(bareDir, ["rev-parse", "main"]).trim()).toBe(headOf(repoDir));
  });

  it("re-exports as a no-op once main and the marker agree", async () => {
    // (6) Nothing advanced main since the last export → zero new commits.
    const again = await bridge.exportRepoHead(REPO, { authorEmail: "release-bot@example.com" });
    expect(again.exported).toBe(0);
    expect(headOf(repoDir)).toBe(exportCommit1);
    const marker = await getMarker();
    expect(marker?.stateHash).toBe(state2);
    expect(marker?.commitSha).toBe(exportCommit1);
  });

  it("fails the push non-fast-forward when the upstream moved independently", async () => {
    // Advance main + export so the checkout has a local commit (state3) the bare
    // does not yet have.
    state3 = await advanceMain(
      { "README.md": "# fixture\n", "src/app.js": "v4\n", "docs/NOTES.md": "first note\n" },
      { actorId: "release-bot-actor", summary: "workspace edit: bump app again" }
    );
    expect(readMain()).toBe(state3);
    const localExport = await bridge.exportRepoHead(REPO, {
      authorEmail: "release-bot@example.com",
    });
    expect(localExport.exported).toBe(1);
    const localHead = headOf(repoDir);
    expect(git(repoDir, ["rev-parse", "HEAD^"]).trim()).toBe(exportCommit1);

    // (7) Move the bare upstream INDEPENDENTLY: clone it elsewhere, commit, push
    // back. Now the bare has a commit the checkout lacks, and vice versa.
    const otherDir = path.join(root, "other");
    git(root, ["clone", bareDir, otherDir]);
    git(otherDir, ["config", "user.email", "other@example.com"]);
    git(otherDir, ["config", "user.name", "Other Dev"]);
    await fsp.writeFile(path.join(otherDir, "UPSTREAM.md"), "upstream only\n");
    git(otherDir, ["add", "."]);
    git(otherDir, ["commit", "-m", "independent upstream commit"]);
    const pushOther = gitTry(otherDir, ["push", "origin", "main"]);
    expect(pushOther.ok).toBe(true);
    const bareHead = git(bareDir, ["rev-parse", "main"]).trim();
    expect(bareHead).not.toBe(localHead);

    // The checkout push now fails as a non-fast-forward — histories diverged.
    const rejected = gitTry(repoDir, ["push", "origin", "main"]);
    expect(rejected.ok).toBe(false);
    expect(rejected.out).toMatch(/non-fast-forward|rejected|fetch first/i);

    // Local checkout is unchanged by the failed push.
    expect(headOf(repoDir)).toBe(localHead);
  });

  it("recovers by merging upstream, re-importing, then fast-forwards the push", async () => {
    const bareHead = git(bareDir, ["rev-parse", "main"]).trim();

    // (8) Merge the upstream divergence into the checkout with system git.
    const pulled = gitTry(repoDir, [
      "-c",
      "pull.rebase=false",
      "pull",
      "--no-edit",
      "origin",
      "main",
    ]);
    expect(pulled.ok).toBe(true);
    const mergedHead = headOf(repoDir);
    // The merge commit has the upstream head as a parent.
    const parents = git(repoDir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
    expect(parents).toContain(bareHead);
    // Merge brought the upstream-only file into the checkout worktree.
    expect(await fsp.readFile(path.join(repoDir, "UPSTREAM.md"), "utf8")).toBe("upstream only\n");

    // Re-import the merged tree — gad main advances with the merged snapshot.
    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);
    expect(imported.stateHash).not.toBe(state3);
    expect(readMain()).toBe(imported.stateHash);
    // Import moved the marker to the merged git HEAD.
    const marker = await getMarker();
    expect(marker?.stateHash).toBe(imported.stateHash);
    expect(marker?.commitSha).toBe(mergedHead);

    // Export after the import is a no-op (marker updated by import).
    const exported = await bridge.exportRepoHead(REPO, { authorEmail: "release-bot@example.com" });
    expect(exported.exported).toBe(0);
    expect(headOf(repoDir)).toBe(mergedHead);

    // The push now fast-forwards the bare upstream to the merged head.
    const pushed = gitTry(repoDir, ["push", "origin", "main"]);
    expect(pushed.ok).toBe(true);
    expect(git(bareDir, ["rev-parse", "main"]).trim()).toBe(mergedHead);
    expect(git(bareDir, ["rev-parse", "main"]).trim()).toBe(headOf(repoDir));
  });
});
