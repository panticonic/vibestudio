/**
 * Git bridge core (eviction stage P5c part 2) — interchange with the outside
 * world only, re-homed from the host's gad layer onto platform primitives.
 * The workspace's own substrate is the userland VCS; this bridge exports a
 * repo's `main` transition history to its local git checkout (for pushing to
 * GitHub etc.) and imports a git checkout's tree back as a snapshot transition
 * on a non-main staging lineage, then publishes it onto `main` through the
 * DO's gated single-writer import path.
 *
 * Runs inside the trusted `git-bridge` extension (a Node child process with
 * disk access). Everything host-side is reached through the injected
 * {@link BridgeHost}:
 *
 *  - `store`   — the userland `vcs` service (gad-store DO, vibestudio.vcs.v1):
 *                `vcsLog` for the export walk, `ingestWorktreeState` for the
 *                import staging transition (non-main head), and
 *                `importPublish` to advance the protected `main` through the
 *                gated single-writer path.
 *  - `blobstore` — host content store RPC: blob bytes (`getBase64`/`putBase64`)
 *                and immutable trees (`putTree`/`getTree`/`listTree`). Import
 *                mirrors the scanned tree bottom-up (the eager half of the
 *                mirroring invariant, now upheld by this bridge for the states
 *                it introduces); export materializes checkouts from tree reads.
 *  - `refs`    — protected-ref reads: the import no-op check compares against
 *                the repo's `main` ref (the single main-head authority).
 *  - `state`   — bridge-private bookkeeping (export markers + per-checkout
 *                tracked-file maps), extension storage in production.
 *
 * Mapping discipline: every exported commit carries `GAD-Repo:`, `GAD-State:`
 * and `GAD-Event:` trailers, so a commit unambiguously identifies its repo
 * log + state. The last exported state per repo is tracked in the bridge
 * state store, so exports are incremental and idempotent.
 *
 * Full per-commit history IMPORT (topo-walk → multi-parent transitions) is
 * intentionally not implemented: pre-bridge history stays in git; interchange
 * needs tree-level fidelity, not historical replay.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { GitClient } from "@vibestudio/git";
import { VCS_IGNORED_DIRS, VCS_IGNORED_FILES } from "@workspace/vcs-engine";
import {
  buildWorktreeManifest,
  type ManifestHashEntry,
} from "@vibestudio/shared/contentTree/worktreeHash";
import {
  STATE_HASH_RE,
  TREE_EXEC_MODE,
  TREE_FILE_MODE,
  splitTreePath,
} from "@vibestudio/shared/contentTree/treeObjects";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/workspace/remotes";
import { withRepoLock } from "./repoLocks.js";

export const VCS_MAIN_HEAD = "main";

/** Non-main staging head the import ingests outside-world history onto. The
 *  imported snapshot lands here (store-authoritative, never the protected
 *  ref), then the DO publishes it onto `main` through the gated single-writer
 *  `refs.updateMains({ operation: "import" })` path. */
export const IMPORT_STAGING_HEAD = "import:main";

/** listTree caps results; a truncated listing must fail, never export. */
const LIST_TREE_LIMIT = 100_000;

/** Root-only worktree merge-conflict summary — never tracked (parity with the
 *  scan-side denylist). */
const MERGE_CONFLICTS_FILE = "MERGE_CONFLICTS.md";

/** Basename glob patterns never tracked (secret/env/scratch files). Twin of
 *  the host scan's SNAPSHOT_IGNORE_PATTERNS / vcs-engine's segment patterns —
 *  the lists must stay in sync. */
const SNAPSHOT_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  "*.sublime-workspace",
  "*~",
  "*.tsbuildinfo",
  "*.tgz",
  ".npmrc.dist-tag-temp",
];

/** A raw vcs transition read off a repo's `main` log (newest first). */
export interface VcsTransition {
  seq: number;
  envelopeId: string;
  actor: unknown;
  summary: string | null;
  outputStateHash: string | null;
}

export interface BridgeVcsStore {
  /** Snapshot/merge transitions for a repo head, NEWEST first (`vcsLog`). */
  vcsLog(repoPath: string, limit: number | null, head: string | null): Promise<VcsTransition[]>;
  ingestWorktreeState(input: {
    logId: string;
    head: string;
    logKind: string;
    actor: { id: string; kind: string };
    files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ stateHash: string; eventId: string }>;
  /** Publish an ingested import staging head onto the repo's protected `main`
   *  through the DO's gated single-writer `refs.updateMains({operation:"import"})`
   *  path (write-ahead intent + provenance). No-ops when main already matches. */
  importPublish(input: {
    repoPath: string;
    sourceHead: string;
    message?: string;
  }): Promise<{ status: "published" | "up-to-date"; repoPath: string; stateHash: string }>;
}

export interface BridgeBlobstore {
  has(digest: string): Promise<boolean>;
  putBase64(bytesBase64: string): Promise<{ digest: string; size: number }>;
  getBase64(digest: string): Promise<string | null>;
  putTree(
    entries: ManifestHashEntry[],
    opts?: { root?: boolean }
  ): Promise<{ treeHash: string; stateHash?: string }>;
  getTree(ref: string): Promise<unknown | null>;
  listTree(
    ref: string,
    opts?: { prefix?: string; limit?: number }
  ): Promise<Array<{ path: string; kind: string; contentHash?: string; mode?: number }> | null>;
}

export interface BridgeRefs {
  readMain(repoPath: string): Promise<{ stateHash: string } | null>;
}

/** Bridge-private durable bookkeeping (markers + checkout maps). */
export interface BridgeStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface BridgeHost {
  workspaceRoot(): Promise<string>;
  store: BridgeVcsStore;
  blobstore: BridgeBlobstore;
  refs: BridgeRefs;
  state: BridgeStateStore;
}

export interface ExportResult {
  exported: number;
  headCommit: string | null;
}

export interface ImportResult {
  stateHash: string;
  changed: boolean;
}

interface ExportMarker {
  stateHash: string;
  commitSha: string;
}

/** Tracked file map of a checkout: what the bridge last materialized. */
type CheckoutMap = Record<string, { contentHash: string; mode: number }>;

const BRIDGE_STATE_VERSION = 1 as const;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;

interface StoredExportMarker extends ExportMarker {
  version: typeof BRIDGE_STATE_VERSION;
  kind: "export-marker";
}

interface StoredCheckoutMap {
  version: typeof BRIDGE_STATE_VERSION;
  kind: "checkout-map";
  files: CheckoutMap;
}

interface MaterializeResult {
  tracked: CheckoutMap;
  stagePaths: string[];
  removePaths: string[];
}

interface ScannedFile {
  path: string;
  absPath: string;
  contentHash: string;
  size: number;
  mode: number;
}

const fsLike = {
  readFile: (p: string, encoding?: BufferEncoding) =>
    encoding ? fsp.readFile(p, encoding) : fsp.readFile(p),
  writeFile: (p: string, data: Uint8Array | string) => fsp.writeFile(p, data),
  unlink: (p: string) => fsp.unlink(p),
  readdir: (p: string) => fsp.readdir(p),
  mkdir: (p: string, options?: { recursive?: boolean }) => fsp.mkdir(p, options),
  rmdir: (p: string) => fsp.rmdir(p),
  stat: (p: string) => fsp.stat(p),
  lstat: (p: string) => fsp.lstat(p),
  symlink: (target: string, p: string) => fsp.symlink(target, p),
  readlink: (p: string) => fsp.readlink(p),
} as never;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseStoredExportMarker(value: unknown): ExportMarker | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "kind", "stateHash", "commitSha"]) ||
    value["version"] !== BRIDGE_STATE_VERSION ||
    value["kind"] !== "export-marker" ||
    typeof value["stateHash"] !== "string" ||
    !STATE_HASH_RE.test(value["stateHash"]) ||
    typeof value["commitSha"] !== "string" ||
    !GIT_COMMIT_RE.test(value["commitSha"])
  ) {
    return null;
  }
  return { stateHash: value["stateHash"], commitSha: value["commitSha"] };
}

function parseStoredCheckoutMap(value: unknown): CheckoutMap | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "kind", "files"]) ||
    value["version"] !== BRIDGE_STATE_VERSION ||
    value["kind"] !== "checkout-map" ||
    !isRecord(value["files"])
  ) {
    return null;
  }

  const entries: Array<[string, { contentHash: string; mode: number }]> = [];
  for (const [filePath, candidate] of Object.entries(value["files"])) {
    try {
      if (splitTreePath(filePath).length === 0) return null;
    } catch {
      return null;
    }
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["contentHash", "mode"]) ||
      typeof candidate["contentHash"] !== "string" ||
      !CONTENT_HASH_RE.test(candidate["contentHash"]) ||
      (candidate["mode"] !== TREE_FILE_MODE && candidate["mode"] !== TREE_EXEC_MODE)
    ) {
      return null;
    }
    entries.push([filePath, { contentHash: candidate["contentHash"], mode: candidate["mode"] }]);
  }
  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Join a state path onto the checkout dir and assert it stays inside it —
 *  defense-in-depth at the disk sink (a poisoned state must never escape). */
function safeCheckoutJoin(dir: string, relPath: string): string {
  const abs = path.join(dir, ...relPath.split("/"));
  const base = path.resolve(dir);
  const resolved = path.resolve(abs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`vcs path escapes checkout: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

async function loadIgnoreMatcher(
  dir: string
): Promise<(relPath: string, isDir: boolean) => boolean> {
  const { default: ignore } = await import("ignore");
  const platformMatcher = ignore().add(SNAPSHOT_IGNORE_PATTERNS);
  let userPatterns: string[] = [];
  try {
    const raw = await fsp.readFile(path.join(dir, ".gadignore"), "utf8");
    userPatterns = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    // No repo policy file; platform exclusions still apply.
  }
  const userMatcher = userPatterns.length > 0 ? ignore().add(userPatterns) : null;
  return (relPath, isDir) => {
    const subject = isDir ? `${relPath}/` : relPath;
    return platformMatcher.ignores(subject) || (userMatcher?.ignores(subject) ?? false);
  };
}

export class GitBridge {
  private readonly git: GitClient;

  constructor(private readonly host: BridgeHost) {
    this.git = new GitClient(fsLike, {
      // Local-only operations; network interchange (push/pull) is done by
      // the caller's own git tooling or a credentialed http client.
      http: {
        request: () => {
          throw new Error("GitBridge is local-only; push/pull with external tooling");
        },
      } as never,
    });
  }

  private trace(message: string, details: Record<string, unknown>): void {
    if (process.env["VIBESTUDIO_DEBUG_GIT_BRIDGE"] !== "1") return;
    console.info(`[GitBridge] ${message}`, details);
  }

  // -------------------------------------------------------------------------
  // Bridge state (markers + checkout maps), keyed per repo.
  // -------------------------------------------------------------------------

  private async getMarker(repoPath: string): Promise<ExportMarker | null> {
    const raw = await this.host.state.get(`marker:${repoPath}`);
    if (!raw) return null;
    try {
      return parseStoredExportMarker(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async setMarker(repoPath: string, marker: ExportMarker): Promise<void> {
    const stored: StoredExportMarker = {
      version: BRIDGE_STATE_VERSION,
      kind: "export-marker",
      ...marker,
    };
    await this.host.state.set(`marker:${repoPath}`, JSON.stringify(stored));
  }

  private async getCheckoutMap(repoPath: string): Promise<CheckoutMap> {
    const raw = await this.host.state.get(`checkout:${repoPath}`);
    if (!raw) return {};
    try {
      return parseStoredCheckoutMap(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }

  private async setCheckoutMap(repoPath: string, map: CheckoutMap): Promise<void> {
    const stored: StoredCheckoutMap = {
      version: BRIDGE_STATE_VERSION,
      kind: "checkout-map",
      files: map,
    };
    await this.host.state.set(`checkout:${repoPath}`, JSON.stringify(stored));
  }

  /** `workspace/<repoPath>` — a repo's own checkout dir (its `.git/`). */
  async repoGitDir(repoPath: string): Promise<string> {
    return path.join(await this.host.workspaceRoot(), ...repoPath.split("/"));
  }

  // -------------------------------------------------------------------------
  // Export: repo `main` lineage → git commits with GAD trailers.
  // -------------------------------------------------------------------------

  /**
   * Export ONE repo's `main` transition history into its own git checkout
   * (`workspace/<repoPath>`, its `.git/`). Each commit carries `GAD-Repo:`,
   * `GAD-State:` and `GAD-Event:` trailers. Incremental: transitions at or
   * before the export marker are skipped. Never composes the workspace —
   * strictly per-repo.
   */
  async exportRepoHead(
    repoPath: string,
    opts: { authorName?: string; authorEmail?: string } = {}
  ): Promise<ExportResult> {
    return withRepoLock(repoPath, async (repo) => {
      const result = await this.exportLockedInner(repo, opts);
      this.trace("export complete", {
        repo,
        exported: result.exported,
        headCommit: result.headCommit,
      });
      return result;
    });
  }

  async exportLockedInner(
    repo: string,
    opts: { authorName?: string; authorEmail?: string }
  ): Promise<ExportResult> {
    repo = normalizeWorkspaceRepoPath(repo);
    const gitDir = await this.repoGitDir(repo);
    const logId = `vcs:repo:${repo}`;
    const newestFirst = await this.host.store.vcsLog(repo, Number.MAX_SAFE_INTEGER, VCS_MAIN_HEAD);
    const ordered = [...newestFirst].reverse(); // oldest first

    // Initialize the checkout when absent.
    let initialized = true;
    try {
      await fsp.access(path.join(gitDir, ".git"));
    } catch {
      initialized = false;
    }
    if (!initialized) {
      await fsp.mkdir(gitDir, { recursive: true });
      await this.git.init(gitDir, "main");
    }

    const marker = await this.getMarker(repo);
    const markerIndex = marker
      ? ordered.findIndex((entry) => entry.outputStateHash === marker.stateHash)
      : -1;
    if (marker && markerIndex < 0) {
      throw new Error(
        `Git bridge marker state ${marker.stateHash} is not present in ${logId}#${VCS_MAIN_HEAD}; ` +
          `export into an empty checkout or reset the marker`
      );
    }
    const startIndex = marker ? markerIndex + 1 : 0;

    let exported = 0;
    let lastSha = marker?.commitSha ?? null;
    let tracked = await this.getCheckoutMap(repo);
    for (const entry of ordered.slice(Math.max(0, startIndex))) {
      if (!entry.outputStateHash) continue;
      // Materialize this transition's tree over the checkout from the content
      // store (tracked files only; `.git` and untracked paths are untouched
      // because deletions apply only to bridge-tracked files). The tracked map
      // persists across exports so cross-transition deletions are detected.
      const materialized = await this.materializeStateToCheckout(
        entry.outputStateHash,
        gitDir,
        tracked
      );
      tracked = materialized.tracked;
      await this.stageMaterializedChanges(gitDir, materialized);
      const actorId =
        entry.actor && typeof entry.actor === "object" && "id" in entry.actor
          ? String((entry.actor as { id: unknown }).id)
          : "vibestudio";
      const trailers = [
        `GAD-Repo: ${repo}`,
        `GAD-State: ${entry.outputStateHash}`,
        `GAD-Event: ${entry.envelopeId}`,
      ];
      const message = `${entry.summary ?? "workspace transition"}\n\n${trailers.join("\n")}`;
      const sha = await this.git.commit({
        dir: gitDir,
        message,
        author: {
          name: opts.authorName ?? actorId,
          email: opts.authorEmail ?? "vibestudio@local",
        },
      });
      lastSha = sha;
      exported += 1;
      await this.setCheckoutMap(repo, tracked);
      await this.setMarker(repo, { stateHash: entry.outputStateHash, commitSha: sha });
    }
    return { exported, headCommit: lastSha };
  }

  /** Full file listing of a state from the canonical content-tree authority. */
  private async listStateFiles(
    stateHash: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>> {
    const listing = await this.host.blobstore.listTree(stateHash, { limit: LIST_TREE_LIMIT });
    if (listing === null) {
      throw new Error(`git export: state ${stateHash} has no canonical content tree`);
    }
    if (listing.length >= LIST_TREE_LIMIT) {
      // A silently truncated listing would export a WRONG tree — fail loudly.
      throw new Error(`git export: state ${stateHash} exceeds ${LIST_TREE_LIMIT} tree entries`);
    }
    return listing
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({
        path: entry.path,
        contentHash: entry.contentHash ?? "",
        mode: entry.mode ?? 33188,
      }));
  }

  /**
   * Project `stateHash` onto the checkout. Deletions run FIRST (only paths the
   * bridge itself previously materialized), then files are written from
   * content-store blobs. Unchanged tracked paths are still refreshed from the
   * store so local checkout edits cannot leak into an export commit. Returns
   * the new tracked map plus the exact paths to stage.
   */
  private async materializeStateToCheckout(
    stateHash: string,
    gitDir: string,
    tracked: CheckoutMap
  ): Promise<MaterializeResult> {
    const files = (await this.listStateFiles(stateHash)).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const targetPaths = new Set(files.map((file) => file.path));
    const removePaths: string[] = [];

    for (const relPath of Object.keys(tracked)) {
      if (!targetPaths.has(relPath)) {
        await this.rmTolerant(safeCheckoutJoin(gitDir, relPath));
        removePaths.push(relPath);
      }
    }
    await this.pruneEmptyDirs(gitDir);

    const next: CheckoutMap = {};
    const stagePaths: string[] = [];
    for (const file of files) {
      const absPath = safeCheckoutJoin(gitDir, file.path);
      next[file.path] = { contentHash: file.contentHash, mode: file.mode };
      const base64 = await this.host.blobstore.getBase64(file.contentHash);
      if (base64 === null) {
        throw new Error(
          `git export: blob ${file.contentHash} for ${file.path} is missing from the content store`
        );
      }
      await this.clearNonDirAncestors(gitDir, file.path);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, Buffer.from(base64, "base64"), {
        mode: file.mode === 33261 ? 0o755 : 0o644,
      });
      // An overwrite of an existing file keeps its old mode bits — enforce.
      await fsp.chmod(absPath, file.mode === 33261 ? 0o755 : 0o644);
      stagePaths.push(file.path);
    }

    await this.pruneEmptyDirs(gitDir);
    return { tracked: next, stagePaths, removePaths };
  }

  private async stageMaterializedChanges(
    gitDir: string,
    materialized: MaterializeResult
  ): Promise<void> {
    const seen = new Set<string>();
    for (const relPath of [...materialized.removePaths, ...materialized.stagePaths]) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      await this.git.add(gitDir, relPath);
    }
  }

  // -------------------------------------------------------------------------
  // Import: git checkout tree → snapshot transition + main-ref adoption.
  // -------------------------------------------------------------------------

  /**
   * Import ONE repo's current git tree as a snapshot transition on its repo
   * log's non-main import staging head, then publish the result onto the
   * protected `main` through the DO's gated single-writer import path. Mirror
   * of {@link exportRepoHead}. No-ops when the scanned tree already equals the
   * repo's protected `main` ref.
   */
  async importRepoTree(repoPath: string, opts: { summary?: string } = {}): Promise<ImportResult> {
    return withRepoLock(repoPath, (repo) => this.importLockedInner(repo, opts));
  }

  async importLockedInner(repo: string, opts: { summary?: string }): Promise<ImportResult> {
    repo = normalizeWorkspaceRepoPath(repo);
    const gitDir = await this.repoGitDir(repo);
    const logId = `vcs:repo:${repo}`;
    const commitSha = await this.git.getCurrentCommit(gitDir);

    // Scan + hash the checkout entirely locally (same denylist as the host
    // scan: platform-ignored dirs/files, `.gadignore`, root conflict summary).
    const files = await this.scanCheckout(gitDir);
    const manifest = buildWorktreeManifest(
      files.map((file) => ({ path: file.path, contentHash: file.contentHash, mode: file.mode }))
    );

    // No-op check against the PROTECTED ref — the single main-head authority.
    const refValue = (await this.host.refs.readMain(repo))?.stateHash ?? null;
    if (refValue && refValue === manifest.stateHash) {
      this.trace("import no-op", { repo, stateHash: refValue, commitSha });
      return { stateHash: refValue, changed: false };
    }

    // Mirror the scanned tree into the content store BEFORE the hash is handed
    // to anyone (blobs, then tree nodes bottom-up, root state pointer last).
    await this.mirrorTree(files, manifest.stateHash);

    const summary =
      opts.summary ?? `Import ${repo} from git${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ""}`;
    const metadata: Record<string, unknown> = { gitDir, repoPath: repo };
    if (commitSha) metadata["gitCommitSha"] = commitSha;

    // Ingest the imported history onto a NON-MAIN staging head — extensions
    // are confined to non-main heads (the DO rejects an extension ingest onto
    // a `vcs:repo:* main` lineage). The protected ref is untouched here.
    const result = await this.host.store.ingestWorktreeState({
      logId,
      head: IMPORT_STAGING_HEAD,
      logKind: "vcs",
      actor: { id: "git-bridge", kind: "system" },
      files: files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        size: file.size,
        mode: file.mode,
      })),
      summary,
      metadata,
    });
    if (result.stateHash !== manifest.stateHash) {
      throw new Error(
        `git import hash mismatch: store returned ${result.stateHash}, local manifest is ${manifest.stateHash}`
      );
    }

    // Publish the staged import onto the protected `main` through the DO's
    // gated single-writer path (write-ahead intent → refs.updateMains(import)
    // → provenance). Approval-gated and attributed to this extension via the
    // host-minted invocation token — never an ungated adoption.
    const published = await this.host.store.importPublish({
      repoPath: repo,
      sourceHead: IMPORT_STAGING_HEAD,
      message: summary,
    });

    if (commitSha) {
      await this.setMarker(repo, { stateHash: result.stateHash, commitSha });
    }
    this.trace("import published", {
      repo,
      stateHash: published.stateHash,
      commitSha,
      files: files.length,
    });
    return { stateHash: published.stateHash, changed: true };
  }

  /** Walk + hash the checkout (platform denylist + `.gadignore`), sorted by path. */
  private async scanCheckout(dir: string): Promise<ScannedFile[]> {
    const ignores = await loadIgnoreMatcher(dir);
    const out: ScannedFile[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childAbs = path.join(abs, entry.name);
          if (entry.isDirectory()) {
            if (VCS_IGNORED_DIRS.has(entry.name)) return;
            if (ignores(childRel, true)) return;
            await walk(childAbs, childRel);
          } else if (entry.isFile()) {
            if (VCS_IGNORED_FILES.has(entry.name)) return;
            // Root-only: the merge-conflict summary is written at the worktree
            // root; ignore it there without shadowing a nested same-name file.
            if (childRel === MERGE_CONFLICTS_FILE) return;
            if (ignores(childRel, false)) return;
            const bytes = await fsp.readFile(childAbs);
            const stat = await fsp.stat(childAbs);
            out.push({
              path: childRel,
              absPath: childAbs,
              contentHash: sha256Hex(bytes),
              size: bytes.byteLength,
              mode: stat.mode & 0o111 ? 33261 : 33188,
            });
          }
          // symlinks / sockets / etc. are not part of the vcs file model
        })
      );
    };
    await walk(dir, "");
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Mirror a scanned tree into the content store: missing blobs first, then
   * directory nodes bottom-up via `putTree`, root `state:` pointer last (so a
   * present state node always implies a complete tree). Verified: the root
   * put must reproduce `expectStateHash` or nothing is trusted.
   */
  private async mirrorTree(files: ScannedFile[], expectStateHash: string): Promise<void> {
    if ((await this.host.blobstore.getTree(expectStateHash)) !== null) return; // already mirrored

    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.contentHash)) continue;
      seen.add(file.contentHash);
      if (await this.host.blobstore.has(file.contentHash)) continue;
      const bytes = await fsp.readFile(file.absPath);
      const digest = sha256Hex(bytes);
      if (digest !== file.contentHash) {
        throw new Error(
          `git import: ${file.path} changed on disk during the scan (${file.contentHash} → ${digest}); retry`
        );
      }
      const put = await this.host.blobstore.putBase64(bytes.toString("base64"));
      if (put.digest !== file.contentHash) {
        throw new Error(
          `git import: content store digest ${put.digest} disagrees with local hash ${file.contentHash}`
        );
      }
    }

    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, { contentHash: string; mode: number }>;
    }
    const root: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const segments = file.path.split("/");
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, {
        contentHash: file.contentHash,
        mode: file.mode,
      });
    }
    const putNode = async (node: DirNode, isRoot: boolean): Promise<string> => {
      const entries: ManifestHashEntry[] = [];
      for (const [name, child] of node.dirs) {
        entries.push({ name, kind: "dir", childHash: await putNode(child, false) });
      }
      for (const [name, file] of node.files) {
        entries.push({ name, kind: "file", contentHash: file.contentHash, mode: file.mode });
      }
      const put = await this.host.blobstore.putTree(entries, isRoot ? { root: true } : undefined);
      if (isRoot) {
        if (put.stateHash !== expectStateHash) {
          throw new Error(
            `git import mirror mismatch: content store minted ${put.stateHash}, expected ${expectStateHash}`
          );
        }
        return put.stateHash;
      }
      return put.treeHash;
    };
    await putNode(root, true);
  }

  // -------------------------------------------------------------------------
  // Disk helpers.
  // -------------------------------------------------------------------------

  /** Recursive remove tolerating a missing path or a non-dir ancestor. */
  private async rmTolerant(target: string): Promise<void> {
    try {
      await fsp.rm(target, { force: true, recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }

  /** Remove the first ancestor of `relPath` that exists as a non-directory, so
   *  a file→directory transition can materialize. */
  private async clearNonDirAncestors(dir: string, relPath: string): Promise<void> {
    const parts = relPath.split("/");
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i] ?? "");
      let stat;
      try {
        stat = await fsp.lstat(cur);
      } catch {
        return; // ancestor doesn't exist yet — recursive mkdir will create it
      }
      if (!stat.isDirectory()) {
        await this.rmTolerant(cur);
        return;
      }
    }
  }

  /** Drop directories the deletion pass emptied (never `.git` or ignored dirs). */
  private async pruneEmptyDirs(dir: string): Promise<void> {
    const prune = async (abs: string, isRoot: boolean): Promise<boolean> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      let empty = true;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (VCS_IGNORED_DIRS.has(entry.name)) {
            empty = false;
            continue;
          }
          const childEmpty = await prune(path.join(abs, entry.name), false);
          if (childEmpty) {
            await this.rmTolerant(path.join(abs, entry.name));
          } else {
            empty = false;
          }
        } else {
          empty = false;
        }
      }
      return empty && !isRoot;
    };
    await prune(dir, true).catch(() => {});
  }
}
