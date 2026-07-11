/**
 * git-bridge extension tests (P5c part 2) — the git interchange coverage now
 * lives with the extension that owns the bridge.
 *
 * Exercises the bridge core against the REAL gad-store DO (workerd
 * test-utils) with in-memory host bridges, mirroring the pattern of
 * `workspace/workers/gad-store/gadStoreVcs.test.ts`:
 *
 *  - `blobstore` — in-memory blob + tree store over the SHARED canonical
 *    hashing, so the import's mirror tripwire (`putTree(root).stateHash ===
 *    locally staged hash`) genuinely exercises hash agreement;
 *  - `refs` — in-memory protected-ref map;
 *  - `importPublish` — a test double of the DO's `vcsImportPublish`: reads the
 *    ingested staging head and adopts it into the ref map. The REAL gated
 *    single-writer publish (write-ahead intent → refs.updateMains(import) →
 *    provenance) is exercised end-to-end in
 *    `tests/workspace-integration/doImport.test.ts`;
 *  - `state` — in-memory marker/checkout-map store (extension storage in
 *    production).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { manifestHashForEntries, stateHashForRoot } from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "../../workers/gad-store/index.js";
import { GitBridge, type BridgeHost } from "./bridge.js";
import { withRepoLock } from "./repoLocks.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

type TreeEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

// The bridge exports/imports a single repo; its checkout is fixed to
// `workspace/<repoPath>`, so we operate on one repo per test.
const REPO = "packages/bridge";
const LOG = `vcs:repo:${REPO}`;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** In-memory host content store over the shared canonical tree hashing. */
function createMemoryBlobstore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, TreeEntry[]>();
  const states = new Map<string, string>(); // state:… → manifest:…

  const resolveRoot = (ref: string): string | null =>
    ref.startsWith("state:") ? (states.get(ref) ?? null) : ref;

  const walk = (
    manifestHash: string,
    prefix: string,
    out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }>
  ): void => {
    const entries = trees.get(manifestHash);
    if (!entries) throw new Error(`memory store: missing interior tree ${manifestHash}`);
    for (const entry of entries) {
      const p = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({ path: p, kind: "file", contentHash: entry.contentHash, mode: entry.mode });
      } else {
        out.push({ path: p, kind: "dir" });
        walk(entry.childHash, p, out);
      }
    }
  };

  const store = {
    async has(digest: string) {
      return blobs.has(digest);
    },
    async putBase64(bytesBase64: string) {
      const bytes = Buffer.from(bytesBase64, "base64");
      const digest = sha256Hex(bytes);
      blobs.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    async getBase64(digest: string) {
      const bytes = blobs.get(digest);
      return bytes ? bytes.toString("base64") : null;
    },
    async putTree(entries: TreeEntry[], opts?: { root?: boolean }) {
      const treeHash = manifestHashForEntries(entries);
      trees.set(treeHash, entries);
      if (!opts?.root) return { treeHash };
      const stateHash = stateHashForRoot(treeHash);
      states.set(stateHash, treeHash);
      return { treeHash, stateHash };
    },
    async getTree(ref: string) {
      const root = resolveRoot(ref);
      return root !== null && trees.has(root) ? trees.get(root)! : null;
    },
    async listTree(ref: string) {
      const root = resolveRoot(ref);
      if (root === null || !trees.has(root)) return null;
      const out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }> = [];
      walk(root, "", out);
      return out;
    },
  };
  return { store, blobs, trees, states };
}

describe("git-bridge extension (real DO, memory host bridges)", () => {
  let root: string;
  let workspaceRoot: string;
  let repoDir: string;
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let mem: ReturnType<typeof createMemoryBlobstore>;
  let refs: Map<string, string>;
  let published: string[];
  let bridge: GitBridge;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "git-bridge-ext-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    repoDir = path.join(workspaceRoot, ...REPO.split("/"));
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "git-bridge" });
    doi = gad.instance;
    mem = createMemoryBlobstore();
    refs = new Map();
    published = [];
    const state = new Map<string, string>();
    const host: BridgeHost = {
      workspaceRoot: async () => workspaceRoot,
      store: {
        vcsLog: async (repoPath, limit, head) => doi.vcsLog(repoPath, limit, head),
        ingestWorktreeState: (input) =>
          doi.ingestWorktreeState(input as Parameters<GadWorkspaceDO["ingestWorktreeState"]>[0]),
        // Test double of the DO's `vcsImportPublish`: adopt the ingested
        // staging head into the ref map and mirror the publish on the main log.
        // The gated single-writer publish is exercised in doImport.test.ts.
        importPublish: async ({ repoPath, sourceHead }) => {
          const head = doi.resolveWorktreeHead({ logId: `vcs:repo:${repoPath}`, head: sourceHead });
          const stateHash = head?.stateHash ? String(head.stateHash) : "";
          if (stateHash && refs.get(`${repoPath} main`) !== stateHash) {
            const listing = await mem.store.listTree(stateHash);
            if (!listing) throw new Error(`missing mirrored tree for ${stateHash}`);
            const files = listing
              .filter(
                (
                  entry
                ): entry is {
                  path: string;
                  kind: string;
                  contentHash: string;
                  mode: number;
                } => entry.kind === "file" && !!entry.contentHash
              )
              .map((entry) => ({
                path: entry.path,
                contentHash: entry.contentHash,
                size: mem.blobs.get(entry.contentHash)?.byteLength ?? 0,
                mode: entry.mode ?? 33188,
              }));
            const published = await doi.ingestWorktreeState({
              logId: `vcs:repo:${repoPath}`,
              head: "main",
              logKind: "vcs",
              actor: { id: "git-bridge", kind: "system" },
              files,
              summary: "import publish",
            });
            if (published.stateHash !== stateHash) {
              throw new Error(
                `publish mirror returned ${published.stateHash}, expected ${stateHash}`
              );
            }
          }
          refs.set(`${repoPath} main`, stateHash);
          published.push(repoPath);
          return { status: "published" as const, repoPath, stateHash };
        },
      },
      blobstore: mem.store,
      refs: {
        readMain: async (repoPath) => {
          const value = refs.get(`${repoPath} main`);
          return value ? { stateHash: value } : null;
        },
      },
      state: {
        get: async (key) => state.get(key) ?? null,
        set: async (key, value) => {
          state.set(key, value);
        },
      },
    };
    bridge = new GitBridge(host);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** Mirror a file map into the memory content store (blobs + bottom-up trees). */
  async function mirrorTree(files: Array<{ path: string; contentHash: string; mode: number }>) {
    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, { contentHash: string; mode: number }>;
    }
    const rootNode: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const segments = file.path.split("/");
      let node = rootNode;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments.at(-1) as string, {
        contentHash: file.contentHash,
        mode: file.mode,
      });
    }
    const put = async (node: DirNode, isRoot: boolean): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, child] of node.dirs) {
        entries.push({ name, kind: "dir", childHash: await put(child, false) });
      }
      for (const [name, file] of node.files) {
        entries.push({ name, kind: "file", contentHash: file.contentHash, mode: file.mode });
      }
      const result = await mem.store.putTree(entries, isRoot ? { root: true } : undefined);
      return isRoot ? (result.stateHash as string) : result.treeHash;
    };
    return put(rootNode, true);
  }

  /**
   * Advance the repo's `main` by one transition: blobs + mirrored tree into
   * the content store, snapshot ingest onto the DO's repo log, protected ref
   * updated (the userland commit/push flow's net effect, seeded directly).
   */
  async function commitRepo(treeFiles: Record<string, string>): Promise<string> {
    const files: Array<{ path: string; contentHash: string; size: number; mode: number }> = [];
    for (const [rel, text] of Object.entries(treeFiles)) {
      const bytes = Buffer.from(text, "utf8");
      const { digest } = await mem.store.putBase64(bytes.toString("base64"));
      files.push({ path: rel, contentHash: digest, size: bytes.length, mode: 33188 });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const stateHash = await mirrorTree(files);
    const result = await doi.ingestWorktreeState({
      logId: LOG,
      head: "main",
      logKind: "vcs",
      actor: { id: "user", kind: "user" },
      files,
      summary: "seed",
    });
    expect(result.stateHash).toBe(stateHash);
    refs.set(`${REPO} main`, result.stateHash);
    return result.stateHash;
  }

  it("exports a repo's vcs history as git commits with GAD trailers, incrementally", async () => {
    await commitRepo({ "a.txt": "one\n" });
    await commitRepo({ "a.txt": "two\n", "b.txt": "bee\n" });

    const result = await bridge.exportRepoHead(REPO);
    expect(result.exported).toBe(2);
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const log = git(repoDir, ["log", "--format=%s%n%b---"]);
    expect(log.match(/GAD-State: state:[0-9a-f]{64}/g)).toHaveLength(2);
    expect(log.match(/GAD-Event: /g)).toHaveLength(2);
    expect(log).toContain(`GAD-Repo: ${REPO}`);
    expect(await fsp.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("two\n");
    expect(await fsp.readFile(path.join(repoDir, "b.txt"), "utf8")).toBe("bee\n");

    // Incremental: nothing new → no commits.
    const again = await bridge.exportRepoHead(REPO);
    expect(again.exported).toBe(0);

    // One more transition exports exactly one more commit.
    await commitRepo({ "a.txt": "two\n", "b.txt": "bee\n", "c.txt": "sea\n" });
    const incremental = await bridge.exportRepoHead(REPO);
    expect(incremental.exported).toBe(1);
  });

  it("rejects a state without its canonical content-store tree", async () => {
    const content = Buffer.from("unmirrored\n", "utf8");
    const result = await doi.ingestWorktreeState({
      logId: LOG,
      head: "main",
      logKind: "vcs",
      actor: { id: "user", kind: "user" },
      files: [
        {
          path: "orphan.txt",
          contentHash: sha256Hex(content),
          size: content.byteLength,
          mode: 33188,
        },
      ],
      summary: "unmirrored state",
    });
    expect(await mem.store.listTree(result.stateHash)).toBeNull();

    await expect(bridge.exportRepoHead(REPO)).rejects.toThrow(
      `state ${result.stateHash} is missing its canonical content-store tree`
    );
  });

  it("propagates cross-transition deletions to the exported git tree", async () => {
    await commitRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
    // Next transition deletes b.txt.
    await commitRepo({ "a.txt": "two\n" });

    const result = await bridge.exportRepoHead(REPO);
    expect(result.exported).toBe(2);

    // The deletion must reach the exported git HEAD tree.
    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toContain("a.txt");
    expect(tree).not.toContain("b.txt");
    // Bridge bookkeeping lives in extension storage — nothing extra on disk.
    const entries = await fsp.readdir(path.dirname(repoDir));
    expect(entries).toEqual(["bridge"]);
  });

  it("does not persist checkout tracking before deletion staging succeeds", async () => {
    await commitRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
    await bridge.exportRepoHead(REPO);

    await commitRepo({ "a.txt": "two\n" });
    const originalStage = (
      bridge as unknown as {
        stageMaterializedChanges(
          gitDir: string,
          materialized: { tracked: unknown; stagePaths: string[]; removePaths: string[] }
        ): Promise<void>;
      }
    ).stageMaterializedChanges.bind(bridge);
    let fail = true;
    (
      bridge as unknown as {
        stageMaterializedChanges(
          gitDir: string,
          materialized: { tracked: unknown; stagePaths: string[]; removePaths: string[] }
        ): Promise<void>;
      }
    ).stageMaterializedChanges = async () => {
      if (fail) {
        fail = false;
        throw new Error("staging failed");
      }
    };

    await expect(bridge.exportRepoHead(REPO)).rejects.toThrow("staging failed");
    (
      bridge as unknown as {
        stageMaterializedChanges(
          gitDir: string,
          materialized: { tracked: unknown; stagePaths: string[]; removePaths: string[] }
        ): Promise<void>;
      }
    ).stageMaterializedChanges = originalStage;
    await bridge.exportRepoHead(REPO);

    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toEqual(["a.txt"]);
  });

  it("exports tracked directory-to-file path swaps", async () => {
    await commitRepo({ "foo/bar.txt": "nested\n" });
    await commitRepo({ foo: "file\n" });

    await bridge.exportRepoHead(REPO);

    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toEqual(["foo"]);
    expect(await fsp.readFile(path.join(repoDir, "foo"), "utf8")).toBe("file\n");
  });

  it("does not stage untracked checkout files during export", async () => {
    await commitRepo({ "a.txt": "one\n" });
    await bridge.exportRepoHead(REPO);

    await fsp.writeFile(path.join(repoDir, "local-only.txt"), "do not export\n");
    await commitRepo({ "a.txt": "two\n" });
    await bridge.exportRepoHead(REPO);

    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toEqual(["a.txt"]);
    expect(await fsp.readFile(path.join(repoDir, "local-only.txt"), "utf8")).toBe(
      "do not export\n"
    );
    expect(git(repoDir, ["status", "--porcelain"])).toContain("?? local-only.txt");
  });

  it("refreshes unchanged tracked files from the content store before export", async () => {
    await commitRepo({ "a.txt": "one\n" });
    await bridge.exportRepoHead(REPO);

    await fsp.writeFile(path.join(repoDir, "a.txt"), "tampered locally\n");
    await commitRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
    await bridge.exportRepoHead(REPO);

    expect(await fsp.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("one\n");
    expect(git(repoDir, ["show", "HEAD:a.txt"])).toBe("one\n");
    expect(git(repoDir, ["show", "HEAD:b.txt"])).toBe("bee\n");
  });

  it("imports an edited git tree as a snapshot transition and adopts main", async () => {
    await commitRepo({ "a.txt": "one\n" });
    await bridge.exportRepoHead(REPO);

    // Outside-world edit in the repo's git checkout.
    git(repoDir, ["config", "user.email", "ext@example.com"]);
    git(repoDir, ["config", "user.name", "External"]);
    await fsp.writeFile(path.join(repoDir, "external.txt"), "from github\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "external change"]);

    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);

    // The vcs (gad-store DO) sees the imported history on the NON-MAIN staging
    // head — extensions never write the protected main lineage directly…
    const staging = doi.resolveWorktreeHead({ logId: LOG, head: "import:main" });
    expect(staging?.stateHash).toBe(imported.stateHash);
    // …the protected ref was published through the DO's import path (doubled)…
    expect(published).toEqual([REPO]);
    expect(refs.get(`${REPO} main`)).toBe(imported.stateHash);
    // …the imported tree is fully mirrored in the content store…
    const listing = await mem.store.listTree(imported.stateHash);
    const external = listing?.find((e) => e.path === "external.txt" && e.kind === "file");
    expect(external?.contentHash).toBeTruthy();
    const blob = await mem.store.getBase64(external!.contentHash!);
    expect(Buffer.from(blob!, "base64").toString("utf8")).toBe("from github\n");
    // …and the transition is on the staging lineage with the import summary.
    const log = doi.vcsLog(REPO, 1, "import:main");
    expect(log[0]).toMatchObject({
      outputStateHash: imported.stateHash,
      summary: expect.stringContaining(`Import ${REPO} from git @ `),
    });

    // Unchanged re-import no-ops against the adopted protected ref.
    const again = await bridge.importRepoTree(REPO);
    expect(again).toEqual({ stateHash: imported.stateHash, changed: false });
  });

  it("round-trips an external git edit through import and a later export", async () => {
    await commitRepo({ "foo/bar.txt": "nested\n", "keep.txt": "keep\n" });
    await bridge.exportRepoHead(REPO);

    git(repoDir, ["config", "user.email", "ext@example.com"]);
    git(repoDir, ["config", "user.name", "External"]);
    await fsp.rm(path.join(repoDir, "foo"), { recursive: true, force: true });
    await fsp.writeFile(path.join(repoDir, "foo"), "file now\n");
    await fsp.writeFile(path.join(repoDir, "external.txt"), "from git\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "external directory-to-file swap"]);

    const imported = await bridge.importRepoTree(REPO, { summary: "external sync" });
    expect(imported.changed).toBe(true);
    expect(refs.get(`${REPO} main`)).toBe(imported.stateHash);

    const immediate = await bridge.exportRepoHead(REPO);
    expect(immediate.exported).toBe(0);

    await commitRepo({
      foo: "file now\n",
      "keep.txt": "keep\n",
      "external.txt": "from git\n",
      "after.txt": "after import\n",
    });
    const exported = await bridge.exportRepoHead(REPO);
    expect(exported.exported).toBe(1);

    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toEqual(["after.txt", "external.txt", "foo", "keep.txt"]);
    expect(await fsp.readFile(path.join(repoDir, "foo"), "utf8")).toBe("file now\n");
    expect(await fsp.readFile(path.join(repoDir, "after.txt"), "utf8")).toBe("after import\n");
    expect(git(repoDir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("rejects an extension ingesting directly onto a repo main lineage (finding 2)", async () => {
    await commitRepo({ "a.txt": "one\n" });
    const contentHash = sha256Hex(Buffer.from("one\n", "utf8"));
    // A generic (or the git-bridge) extension caller may ONLY ingest to a
    // non-main staging head — a direct main ingest is the finding-2 vector.
    await expect(
      gad.callAs("extension", "ingestWorktreeState", {
        logId: LOG,
        head: "main",
        logKind: "vcs",
        actor: { id: "evil-ext", kind: "system" },
        files: [{ path: "a.txt", contentHash, size: 4, mode: 33188 }],
      })
    ).rejects.toThrow(/may not ingest onto a protected main lineage/);
    // …but the same caller MAY ingest onto a non-main staging head.
    const ok = await gad.callAs<{ stateHash: string }>("extension", "ingestWorktreeState", {
      logId: LOG,
      head: "import:main",
      logKind: "vcs",
      actor: { id: "git-bridge", kind: "system" },
      files: [{ path: "a.txt", contentHash, size: 4, mode: 33188 }],
    });
    expect(ok.stateHash).toBeTruthy();
  });

  it("never ingests platform-ignored paths (.git, .env, node_modules)", async () => {
    await commitRepo({ "a.txt": "one\n" });
    await bridge.exportRepoHead(REPO);

    await fsp.writeFile(path.join(repoDir, ".env"), "SECRET=1\n");
    await fsp.mkdir(path.join(repoDir, "node_modules", "x"), { recursive: true });
    await fsp.writeFile(path.join(repoDir, "node_modules", "x", "i.js"), "x\n");
    await fsp.writeFile(path.join(repoDir, "kept.txt"), "kept\n");

    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);
    const paths = (await mem.store.listTree(imported.stateHash))
      ?.filter((e) => e.kind === "file")
      .map((e) => e.path);
    expect(paths).toEqual(["a.txt", "kept.txt"]);
  });

  it("keeps per-actor author names when only authorEmail is overridden", async () => {
    // Two transitions authored by the `user` actor (see commitRepo).
    await commitRepo({ "a.txt": "one\n" });
    await commitRepo({ "a.txt": "two\n" });

    // Only the email is supplied: the author NAME must fall back to the
    // transition's actor id (`user`), not to a fixed override.
    const result = await bridge.exportRepoHead(REPO, { authorEmail: "person@example.com" });
    expect(result.exported).toBe(2);

    const authors = git(repoDir, ["log", "--format=%an <%ae>"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(authors).toEqual([
      "user <person@example.com>",
      "user <person@example.com>",
    ]);
  });

  it("serializes concurrent operations on the SAME repo via withRepoLock (start order = completion order)", async () => {
    const order: string[] = [];
    const gateA = deferred();
    const gateB = deferred();
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    const first = withRepoLock("packages/serial", async () => {
      order.push("start-a");
      await gateA.promise;
      order.push("end-a");
    });
    const second = withRepoLock("packages/serial", async () => {
      order.push("start-b");
      await gateB.promise;
      order.push("end-b");
    });

    // The second op cannot start until the first releases the per-repo lock.
    await flush();
    expect(order).toEqual(["start-a"]);

    gateA.resolve();
    await first;
    await flush();
    expect(order).toEqual(["start-a", "end-a", "start-b"]);

    gateB.resolve();
    await second;
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("runs operations on DIFFERENT repos concurrently under withRepoLock", async () => {
    const order: string[] = [];
    const gate = deferred();
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    const a = withRepoLock("packages/repo-x", async () => {
      order.push("start-x");
      await gate.promise;
      order.push("end-x");
    });
    const b = withRepoLock("packages/repo-y", async () => {
      order.push("start-y");
      order.push("end-y");
    });

    // Different repos don't share a lock: both start before the first releases.
    await flush();
    expect(order).toContain("start-x");
    expect(order).toContain("start-y");
    expect(order).toContain("end-y");

    gate.resolve();
    await Promise.all([a, b]);
    expect(order[order.length - 1]).toBe("end-x");
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { promise, resolve };
}
