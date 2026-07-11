/**
 * WorktreeStore — the host's worktree ⇄ content-store bridge (a CONTENT/
 * PROJECTION concern, not VCS semantics).
 *
 * Owns the disk-facing primitives of the blob-addressed workspace:
 *  - scan/hash a working directory into the CAS (`localState`, `snapshotDir` —
 *    the latter also records the snapshot in the gad-store DO as provenance),
 *  - editable checkout of a state onto disk (`materializeState`, driven by
 *    the DiskProjector follower),
 *  - strict enforcement of the state-mirroring invariant (`ensureStateMirrored`) and
 *    content-store listings (`listStateFiles`, `collectTreeFiles`),
 *  - the narrow gad-store DO passthroughs the above need (`resolveWorktreeRef`
 *    / `resolveWorktreeHead`, context-head fork).
 *
 * The `.gad/` sidecar (`CHECKOUT.json`) is a P1 cache — derivation "stat() of
 * every file at the last snapshot/materialize"; deleting it only costs a
 * rescan. Naming/path policy lives in `./paths.ts`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildWorktreeManifest,
  EMPTY_STATE_HASH,
  type ManifestHashEntry,
  type WorktreeManifest,
} from "@vibestudio/shared/contentTree/worktreeHash";
import {
  blobPath,
  ensureLayout,
  getTree,
  hasTreeObject,
  mirrorWorktreeTree,
  putFile,
} from "../services/blobstoreService.js";
import {
  ALWAYS_IGNORED_DIRS,
  ALWAYS_IGNORED_FILES,
  MERGE_CONFLICTS_FILE,
  SNAPSHOT_IGNORE_PATTERNS,
  VCS_MAIN_HEAD,
  vcsContextHead,
  vcsLogActor,
  type VcsActor,
} from "./paths.js";

/** Narrow call surface onto the GadWorkspaceDO (DODispatch server-side, the DO instance in tests). */
interface GadCaller {
  call<T = unknown>(method: string, input: unknown): Promise<T>;
}

interface WorktreeHeadRef {
  logId: string;
  head: string;
  stateHash: string;
  commitEventId: string | null;
  updatedAt: string;
}

/**
 * Join a state path onto a worktree dir and assert the result stays inside it —
 * a defense-in-depth backstop at the on-disk sink so no state (even a
 * pre-existing poisoned one) can ever write/delete outside `dir`.
 */
function safeWorktreeJoin(dir: string, relPath: string): string {
  const abs = path.join(dir, ...relPath.split("/"));
  const base = path.resolve(dir);
  const resolved = path.resolve(abs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`vcs path escapes worktree: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

const SIDECAR_DIR = ".gad";
const SIDECAR_FILE = "CHECKOUT.json";

interface VcsFileEntry {
  path: string;
  contentHash: string;
  size: number;
  mode: number;
}

interface SidecarEntry {
  contentHash: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

interface SidecarState {
  version: 1;
  /** State hash the worktree last agreed with (after snapshot or materialize). */
  stateHash: string | null;
  files: Record<string, SidecarEntry>;
}

interface SnapshotResult {
  stateHash: string;
  eventId: string;
  headHash: string;
  fileCount: number;
  /** True when the scan found no difference and no ingest was performed. */
  unchanged: boolean;
}

interface SnapshotOptions {
  head?: string;
  /** Repo log id the head lives on (per-repo VCS). Required — every snapshot
   *  targets a specific repo's log. */
  logId: string;
  actor?: VcsActor;
  summary?: string;
  metadata?: Record<string, unknown>;
  /** Force ingest even when the scan matches the sidecar's stateHash. */
  force?: boolean;
  /** Extra transition parents (merge-resolution commits). */
  parentStateHashes?: string[];
  /** Event IDs corresponding to parentStateHashes. */
  parentEventIds?: string[];
  /** Transition kind override (merge-resolution commits). */
  eventKind?: "state.snapshot_ingested" | "state.merge_applied";
}

interface MaterializeOptions {
  /** Delete files not present in the target state (default: only files the
   *  sidecar says we previously wrote — untracked files are preserved). */
  clean?: boolean;
}

interface MaterializeResult {
  stateHash: string;
  written: number;
  deleted: number;
  unchanged: number;
}

/** A target file to materialize, in the listStateFiles shape. */
interface TargetFile {
  path: string;
  content_hash: string;
  mode: number;
}

/**
 * The editable-checkout materialize primitive's behavior knobs (full
 * workspace/context checkouts drive {@link WorktreeStore.materializeInto} with
 * these). Build-source checkouts do NOT come through here — they are
 * content-store `materializeTree` projections (see blobstoreService).
 */
interface MaterializeIntoOptions {
  /** Track presence in a `.gad/CHECKOUT.json` sidecar, enabling cross-call
   *  incremental reuse and stale-file deletion. */
  sidecar?: boolean;
  /** Delete sidecar-tracked files absent from the target (requires `sidecar`). */
  deleteStale?: boolean;
  /** Also delete untracked files not in the target (full clean checkout). */
  clean?: boolean;
  /** State hash to record in the sidecar (requires `sidecar`). The sidecar's
   *  `stateHash` is the worktree's last-agreed state. */
  stateHash?: string;
}

interface MaterializeIntoResult {
  written: number;
  deleted: number;
  unchanged: number;
}

interface WorktreeStoreDeps {
  blobsDir: string;
  gad: GadCaller;
}

interface ScannedFile {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
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
    // No workspace policy file; platform exclusions still apply.
  }
  const userMatcher = userPatterns.length > 0 ? ignore().add(userPatterns) : null;
  return (relPath, isDir) => {
    const subject = isDir ? `${relPath}/` : relPath;
    return platformMatcher.ignores(subject) || (userMatcher?.ignores(subject) ?? false);
  };
}

/**
 * Recursive file listing of a mirrored tree/state straight from the CONTENT
 * STORE — no gad-DO involvement and no result cap (unlike `listTree`, whose
 * `limit` would silently truncate a big workspace into a wrong composition).
 * Returns null when the root object is absent; throws on a missing INTERIOR
 * node (an incomplete mirror must fail loudly, never list partially).
 */
export async function collectTreeFiles(
  blobsDir: string,
  ref: string
): Promise<Array<{ path: string; contentHash: string; mode: number }> | null> {
  const root = await getTree(blobsDir, ref);
  if (root === null) return null;
  const out: Array<{ path: string; contentHash: string; mode: number }> = [];
  const walk = async (entries: ManifestHashEntry[], prefix: string): Promise<void> => {
    for (const entry of entries) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({ path: entryPath, contentHash: entry.contentHash, mode: entry.mode });
      } else {
        const child = await getTree(blobsDir, entry.childHash);
        if (child === null) {
          throw new Error(`collectTreeFiles: missing interior tree object ${entry.childHash}`);
        }
        await walk(child, entryPath);
      }
    }
  };
  await walk(root, "");
  return out;
}

export class WorktreeStore {
  constructor(private readonly deps: WorktreeStoreDeps) {
    ensureLayout(deps.blobsDir);
  }

  // -------------------------------------------------------------------------
  // Sidecar (P1 cache)
  // -------------------------------------------------------------------------

  private sidecarPath(dir: string): string {
    return path.join(dir, SIDECAR_DIR, SIDECAR_FILE);
  }

  private async readSidecar(dir: string): Promise<SidecarState> {
    try {
      const raw = await fsp.readFile(this.sidecarPath(dir), "utf8");
      const parsed = JSON.parse(raw) as SidecarState;
      if (parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
        return parsed;
      }
    } catch {
      // missing/corrupt sidecar — cache amnesia, full rescan
    }
    return { version: 1, stateHash: null, files: {} };
  }

  private async writeSidecar(dir: string, state: SidecarState): Promise<void> {
    const sidecarPath = this.sidecarPath(dir);
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    const tmp = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fsp.rename(tmp, sidecarPath);
  }

  // -------------------------------------------------------------------------
  // Scan + snapshot (commit)
  // -------------------------------------------------------------------------

  private async scanDir(dir: string): Promise<ScannedFile[]> {
    const ignores = await loadIgnoreMatcher(dir);
    const out: ScannedFile[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childAbs = path.join(abs, entry.name);
          if (entry.isDirectory()) {
            if (ALWAYS_IGNORED_DIRS.has(entry.name)) return;
            if (ignores(childRel, true)) return;
            await walk(childAbs, childRel);
          } else if (entry.isFile()) {
            if (ALWAYS_IGNORED_FILES.has(entry.name)) return;
            // Root-only: the merge-conflict summary is written at the worktree
            // root, so ignore it there without shadowing a user's own nested
            // file of the same name (e.g. docs/MERGE_CONFLICTS.md).
            if (childRel === MERGE_CONFLICTS_FILE) return;
            if (ignores(childRel, false)) return;
            const stat = await fsp.stat(childAbs);
            out.push({
              path: childRel,
              absPath: childAbs,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              mode: stat.mode & 0o111 ? 33261 : 33188,
            });
          }
          // symlinks / sockets / etc. are not part of the GAD file model
        })
      );
    };
    await walk(dir, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Hash every scanned file, using the sidecar's (size, mtime) fast path to
   * skip rehashing unchanged files. Returns the full file list for ingest
   * plus the refreshed sidecar entries.
   */
  private async hashFiles(
    scanned: ScannedFile[],
    sidecar: SidecarState
  ): Promise<{ files: VcsFileEntry[]; entries: Record<string, SidecarEntry> }> {
    const files: VcsFileEntry[] = [];
    const entries: Record<string, SidecarEntry> = {};
    for (const file of scanned) {
      const cached = sidecar.files[file.path];
      let contentHash: string;
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
        contentHash = cached.contentHash;
      } else {
        contentHash = (await putFile(this.deps.blobsDir, file.absPath)).digest;
      }
      files.push({ path: file.path, contentHash, size: file.size, mode: file.mode });
      entries[file.path] = {
        contentHash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
      };
    }
    return { files, entries };
  }

  /**
   * Scan + hash a working directory entirely locally (blobs enter the CAS,
   * nothing touches the DO). The returned state/subtree hashes are
   * byte-identical to what `ingestWorktreeState` would compute — the shared
   * implementation lives in @vibestudio/shared/contentTree/worktreeHash (kept
   * byte-identical to the gad-store DO's copy via golden-vector tests).
   * This is the bootstrap path: builds can be content-addressed before the
   * gad store is reachable.
   */
  async localState(
    dir: string,
    opts: {
      /** Refresh the `.gad/CHECKOUT.json` sidecar with the scan's (size, mtime,
       *  hash) entries — the scan cache for the DO-free main commit path, which
       *  never goes through `snapshotDir`'s sidecar write. */
      updateSidecar?: boolean;
    } = {}
  ): Promise<{
    stateHash: string;
    files: VcsFileEntry[];
    manifest: WorktreeManifest;
  }> {
    const sidecar = await this.readSidecar(dir);
    const scanned = await this.scanDir(dir);
    const { files, entries } = await this.hashFiles(scanned, sidecar);
    const manifest = buildWorktreeManifest(files);
    // Eager half of the mirroring invariant: the scan holds the full file list
    // in memory, so the content store gets the tree before the hash is handed
    // out. Cheap when already mirrored (one stat on the state node).
    await mirrorWorktreeTree(this.deps.blobsDir, files, { expectStateHash: manifest.stateHash });
    if (opts.updateSidecar) {
      await this.writeSidecar(dir, { version: 1, stateHash: manifest.stateHash, files: entries });
    }
    return { stateHash: manifest.stateHash, files, manifest };
  }

  /**
   * Snapshot a working directory as a `state.snapshot_ingested` transition
   * on a repo's log (the vcs commit). No-ops (without appending) when
   * the scan reproduces the sidecar's last agreed state hash. `opts.logId`
   * is required — every snapshot targets a specific repo log.
   */
  async snapshotDir(dir: string, opts: SnapshotOptions): Promise<SnapshotResult> {
    const head = opts.head ?? VCS_MAIN_HEAD;
    const logId = opts.logId;
    // A missing working dir is treated as a no-op against the head's current
    // state. We must NOT scan-and-ingest an "empty" tree — that would wipe the
    // head. Note the deliberate limitation: "dir absent" is ambiguous between a
    // sparse context that simply never materialized this repo (the common case —
    // must NOT delete) and a genuinely removed repo subtree. We cannot tell them
    // apart from disk alone, and erring toward deletion would wipe every
    // unmaterialized repo on every scan, so a whole-repo deletion is its own
    // explicit, approval-gated action (`vcs.deleteRepo` → WorkspaceVcs.deleteRepo,
    // which archives the repo's history and drops it from main) — never inferred
    // from an `rm -rf` of this disposable on-disk projection.
    try {
      await fsp.access(dir);
    } catch {
      const refStateHash0 = await this.resolveWorktreeRef(head, logId);
      return {
        stateHash: refStateHash0 ?? EMPTY_STATE_HASH,
        eventId: "",
        headHash: "",
        fileCount: 0,
        unchanged: true,
      };
    }
    const sidecar = await this.readSidecar(dir);
    const scanned = await this.scanDir(dir);
    const { files, entries } = await this.hashFiles(scanned, sidecar);
    const manifest = buildWorktreeManifest(files);
    // Eager half of the mirroring invariant: mirror the scanned tree into the
    // content store BEFORE any hash is handed out (covers the unchanged
    // fast path, the staged-candidate path, and the ingest below — the DO
    // recomputes the identical hash). Cheap when already mirrored.
    await mirrorWorktreeTree(this.deps.blobsDir, files, { expectStateHash: manifest.stateHash });

    // No-change path: the scan reproduces the ref's current state exactly —
    // skip the ingest so scan-on-demand entry points (build, launch_panel)
    // don't append junk snapshot events. Compared against the DURABLE ref
    // state, not the sidecar, so it survives sidecar amnesia (P3). The local
    // manifest hash is byte-identical to the DO state hash, avoiding a full
    // state-file table fetch on every unchanged HTML/build request.
    const refStateHash = await this.resolveWorktreeRef(head, logId);
    if (!opts.force) {
      if (refStateHash && refStateHash === manifest.stateHash) {
        await this.writeSidecar(dir, { version: 1, stateHash: refStateHash, files: entries });
        return {
          stateHash: refStateHash,
          eventId: "",
          headHash: "",
          fileCount: files.length,
          unchanged: true,
        };
      }
    }

    const result = await this.deps.gad.call<{
      stateHash: string;
      eventId: string;
      headHash: string;
    }>("ingestWorktreeState", {
      logId,
      head,
      logKind: "vcs",
      actor: vcsLogActor(opts.actor ?? { id: "user", kind: "user" }),
      files: files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        size: file.size,
        mode: file.mode,
      })),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      ...(opts.parentStateHashes ? { parentStateHashes: opts.parentStateHashes } : {}),
      ...(opts.parentEventIds ? { parentEventIds: opts.parentEventIds } : {}),
      ...(opts.eventKind ? { eventKind: opts.eventKind } : {}),
    });
    if (result.stateHash !== manifest.stateHash) {
      // The mirrored tree (local manifest) and the hash the DO handed out must
      // be the same object — a disagreement means the shared worktree-hash
      // implementations diverged, and the mirroring invariant would be broken.
      throw new Error(
        `snapshot ingest hash mismatch: DO returned ${result.stateHash}, local manifest is ${manifest.stateHash}`
      );
    }

    await this.writeSidecar(dir, { version: 1, stateHash: result.stateHash, files: entries });
    return { ...result, fileCount: files.length, unchanged: false };
  }

  // -------------------------------------------------------------------------
  // Materialize (checkout)
  // -------------------------------------------------------------------------

  /**
   * THE editable-checkout materialize primitive — "write `target` into `dir`,
   * tracking what's present". Every EDITABLE checkout path funnels through
   * here (workspace root, context-repo subtree, merge dirs):
   * `{ sidecar: true, deleteStale: true }` (+ `clean` for a pristine
   * tree). Tracks a `.gad/CHECKOUT.json`
   * sidecar for incremental reuse and stale-file deletion; always COPIES
   * (never hardlinks) so editors can't corrupt the shared CAS inode.
   * Immutable per-state build-source checkouts do NOT come through here —
   * the build system projects unit subtrees with the content store's
   * `materializeTree` (hardlinked).
   *
   * Invariants:
   *  - Deletions run FIRST, before any write, so no rm ever traverses a
   *    half-transitioned file→dir / dir→file path and no fresh write is clobbered.
   *  - Stale deletion only happens with a sidecar (`deleteStale`).
   *  - `clean` additionally removes untracked files (requires a scan).
   */
  private async materializeInto(
    target: TargetFile[],
    dir: string,
    opts: MaterializeIntoOptions = {}
  ): Promise<MaterializeIntoResult> {
    const useSidecar = opts.sidecar ?? false;
    const targetPaths = new Set(target.map((file) => file.path));

    await fsp.mkdir(dir, { recursive: true });
    const sidecar = useSidecar
      ? await this.readSidecar(dir)
      : { version: 1 as const, stateHash: null, files: {} as Record<string, SidecarEntry> };
    const entries: Record<string, SidecarEntry> = {};
    let written = 0;
    let unchanged = 0;
    let deleted = 0;

    // Deletions FIRST — before any writes. A path can transition type between
    // states (file→dir: old file `foo` becomes the parent of target
    // `foo/bar.ts`; dir→file: old `foo/bar.ts` becomes file `foo`). Deleting
    // stale paths up front, while the on-disk tree still reflects the previous
    // state, means no rm ever traverses a half-transitioned path, and the write
    // loop's freshly-written subtree can't be clobbered by a later deletion of
    // a now-directory path. Only with a sidecar (we track what we wrote).
    if (opts.deleteStale) {
      for (const relPath of Object.keys(sidecar.files)) {
        if (!targetPaths.has(relPath)) {
          await this.rmTolerant(safeWorktreeJoin(dir, relPath));
          deleted += 1;
        }
      }
    }

    for (const file of target) {
      const relPath = file.path;
      const absPath = safeWorktreeJoin(dir, relPath);
      const executable = file.mode === 33261;
      const source = blobPath(this.deps.blobsDir, file.content_hash);

      if (useSidecar) {
        // Sidecar reuse: trust an on-disk file whose tracked (hash, mode) match
        // and whose (size, mtime) still match what we recorded.
        const prev = sidecar.files[relPath];
        let reusable = false;
        if (prev && prev.contentHash === file.content_hash && prev.mode === file.mode) {
          try {
            const stat = await fsp.stat(absPath);
            reusable = stat.size === prev.size && stat.mtimeMs === prev.mtimeMs;
          } catch {
            reusable = false;
          }
        }
        if (reusable && prev) {
          entries[relPath] = prev;
          unchanged += 1;
          continue;
        }
      }

      // An ancestor path component may currently exist on disk as a
      // non-directory (a now-stale file at a path that must become a directory,
      // whether sidecar-tracked or untracked/external) — remove it so the
      // recursive mkdir below can create the directory chain.
      await this.clearNonDirAncestors(dir, relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await this.writeMaterializedFile(source, absPath, { executable });
      written += 1;

      if (useSidecar) {
        const stat = await fsp.stat(absPath);
        entries[relPath] = {
          contentHash: file.content_hash,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: file.mode,
        };
      }
    }

    if (opts.clean) {
      // Remove untracked files too (full clean checkout).
      const scanned = await this.scanDir(dir);
      for (const file of scanned) {
        if (!targetPaths.has(file.path)) {
          await fsp.rm(file.absPath, { force: true, recursive: true });
          deleted += 1;
        }
      }
    }

    if (useSidecar) {
      await this.pruneEmptyDirs(dir);
      await this.writeSidecar(dir, {
        version: 1,
        stateHash: opts.stateHash ?? sidecar.stateHash,
        files: entries,
      });
    }
    return { written, deleted, unchanged };
  }

  /**
   * Full editable checkout of a state into a directory (workspace root,
   * context-repo subtree, merge dirs). Thin preset over
   * {@link materializeInto}: sidecar-tracked + stale-file deletion, copies (not
   * links). See that method for the invariants.
   */
  async materializeState(
    stateHash: string,
    dir: string,
    opts: MaterializeOptions = {}
  ): Promise<MaterializeResult> {
    const target = await this.listStateFiles(stateHash);
    const { written, deleted, unchanged } = await this.materializeInto(target, dir, {
      sidecar: true,
      deleteStale: true,
      stateHash,
      ...(opts.clean ? { clean: true } : {}),
    });
    return { stateHash, written, deleted, unchanged };
  }

  /**
   * Full file listing of a state, in the {@link TargetFile} shape — CONTENT
   * STORE ONLY (the tree authority): `ensureStateMirrored` verifies the
   * canonical tree exists, then the listing is read from the CAS tree objects.
   * This keeps every listing consumer (materialize, decompose, indexes)
   * working for states the gad DO has not (yet) recorded — composed views
   * minted server-side and fresh scan states the async provenance follower
   * is still draining.
   */
  async listStateFiles(stateHash: string): Promise<TargetFile[]> {
    await this.ensureStateMirrored(stateHash);
    const files = await collectTreeFiles(this.deps.blobsDir, stateHash);
    if (files === null) {
      throw new Error(`listStateFiles: state ${stateHash} is not resolvable in the content store`);
    }
    return files.map((file) => ({
      path: file.path,
      content_hash: file.contentHash,
      mode: file.mode,
    }));
  }

  /**
   * Verify the content store holds the full canonical tree for a worktree
   * state. Every current state producer mirrors before publishing the hash;
   * absence is an invariant violation and is never repaired from a second
   * authority. The `state:` node is written last, so its presence implies the
   * complete tree.
   */
  async ensureStateMirrored(stateHash: string): Promise<void> {
    if (await hasTreeObject(this.deps.blobsDir, stateHash)) return;
    if (stateHash === EMPTY_STATE_HASH) {
      // The empty state needs no DO round trip (and the DO may not have it).
      await mirrorWorktreeTree(this.deps.blobsDir, []);
      return;
    }
    throw new Error(
      `state ${stateHash} is missing its canonical content-store tree; the producing operation did not satisfy the mirroring invariant`
    );
  }

  /** Recursive remove that tolerates a missing path or an ancestor that is not
   *  a directory (ENOENT/ENOTDIR) — both mean "already gone" for our purposes. */
  private async rmTolerant(target: string): Promise<void> {
    try {
      await fsp.rm(target, { force: true, recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }

  /** Remove the first ancestor directory component of `relPath` that exists on
   *  disk as a non-directory, so a file→directory transition can materialize. */
  private async clearNonDirAncestors(dir: string, relPath: string): Promise<void> {
    const parts = relPath.split("/");
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i] ?? "");
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(cur);
      } catch {
        return; // ancestor doesn't exist yet — recursive mkdir will create it
      }
      if (!stat.isDirectory()) {
        await fsp.rm(cur, { force: true, recursive: true });
        return; // deeper components lived under this now-removed entry
      }
    }
  }

  /** Copy (never hardlink — editable worktrees must not share the CAS inode)
   *  a blob to `absPath` via tmp+rename. */
  private async writeMaterializedFile(
    source: string,
    absPath: string,
    opts: { executable: boolean }
  ): Promise<void> {
    const tmp = path.join(
      path.dirname(absPath),
      `.${path.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    await fsp.rm(tmp, { force: true });
    await fsp.copyFile(source, tmp);
    await fsp.chmod(tmp, opts.executable ? 0o755 : 0o644);
    // The target may exist as a directory (dir→file transition) — rename onto a
    // directory fails (EISDIR/ENOTEMPTY), so clear it first. (rename atomically
    // replaces a pre-existing regular file, so no rm needed in that case.)
    await fsp.rm(absPath, { force: true, recursive: true }).catch(() => {});
    await fsp.rename(tmp, absPath);
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    const walk = async (abs: string, depth: number): Promise<boolean> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      let empty = true;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth === 0 && ALWAYS_IGNORED_DIRS.has(entry.name)) {
            empty = false;
            continue;
          }
          const childEmpty = await walk(path.join(abs, entry.name), depth + 1);
          if (childEmpty) {
            await fsp.rmdir(path.join(abs, entry.name)).catch(() => {});
          } else {
            empty = false;
          }
        } else {
          empty = false;
        }
      }
      return empty;
    };
    await walk(dir, 0).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Refs / log passthroughs
  // -------------------------------------------------------------------------

  async resolveWorktreeRef(head: string, logId: string): Promise<string | null> {
    const resolved = await this.resolveWorktreeHead(head, logId);
    return resolved?.stateHash ?? null;
  }

  async resolveWorktreeHead(head: string, logId: string): Promise<WorktreeHeadRef | null> {
    const resolved = await this.deps.gad.call<WorktreeHeadRef | null>("resolveWorktreeHead", {
      logId,
      head,
    });
    return resolved ?? null;
  }

  /** Fork a repo's main head into a context head on that repo's log (no-copy
   *  forkLog). Per-repo VCS: contexts edit a repo via `ctx:{id}` on
   *  `vcs:repo:<path>`. */
  async forkContext(
    contextId: string,
    logId: string
  ): Promise<{ head: string; stateHash: string | null }> {
    const head = vcsContextHead(contextId);
    const existing = await this.deps.gad.call<unknown>("getLogHead", {
      logId,
      head,
    });
    if (!existing) {
      await this.deps.gad.call("forkLog", {
        fromLogId: logId,
        fromHead: VCS_MAIN_HEAD,
        toLogId: logId,
        toHead: head,
      });
    }
    return { head, stateHash: await this.resolveWorktreeRef(head, logId) };
  }
}
