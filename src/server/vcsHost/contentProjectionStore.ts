/**
 * ContentProjectionStore — the host's filesystem ⇄ content-store bridge (a CONTENT/
 * PROJECTION concern, not VCS semantics).
 *
 * Owns the disk-facing primitives of the blob-addressed workspace:
 *  - scan/hash a working directory into the CAS (`localState`),
 *  - editable checkout of a state onto disk (`materializeState`, driven by
 *    the DiskProjector follower),
 *  - strict enforcement of the state-mirroring invariant (`ensureStateMirrored`) and
 *    content-store listings (`listStateFiles`, `collectTreeFiles`),
 *
 * This module has no history, branch, commit, merge, or provenance API. The semantic
 * authority consumes these content/projection facts and owns all interpretation.
 *
 * The `.gad/` sidecar (`CHECKOUT.json`) is a disposable projection cache — a
 * derivation of the files observed by the last scan/materialization. Deleting it only costs a
 * rescan. Naming/path policy lives in `./paths.ts`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildWorktreeManifest,
  compareUtf16CodeUnits,
  EMPTY_STATE_HASH,
  type WorktreeManifest,
} from "@vibestudio/content-addressing";
import { semanticVcsPathAdmission } from "@vibestudio/shared/vcs/pathAdmission";
import {
  blobPath,
  collectExactTreeListing,
  ensureLayout,
  hasTreeObject,
  mirrorWorktreeTree,
  putFile,
} from "../services/blobstoreService.js";

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
    throw new Error(`content path escapes projection: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

const SIDECAR_DIR = ".gad";
const SIDECAR_FILE = "CHECKOUT.json";

interface ContentFileEntry {
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
  version: 2;
  /** State hash the worktree last agreed with after scan or materialization. */
  stateHash: string | null;
  /**
   * Wall-clock ms when this sidecar's entries were recorded — the racily-clean
   * boundary: a file whose mtime is at/after this instant (minus the timestamp
   * granularity window) may have been modified without changing (size, mtime),
   * so its cached hash must not be trusted.
   */
  scannedAtMs: number;
  files: Record<string, SidecarEntry>;
}

type UnstampedSidecarState = Omit<SidecarState, "scannedAtMs">;

function emptySidecar(): SidecarState {
  return { version: 2, stateHash: null, scannedAtMs: 0, files: {} };
}

function isSidecarEntry(value: unknown): value is SidecarEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SidecarEntry>;
  return (
    typeof entry.contentHash === "string" &&
    typeof entry.size === "number" &&
    typeof entry.mtimeMs === "number" &&
    typeof entry.mode === "number"
  );
}

function isSidecarState(value: unknown): value is SidecarState {
  if (!value || typeof value !== "object") return false;
  const sidecar = value as Partial<SidecarState>;
  return (
    sidecar.version === 2 &&
    (sidecar.stateHash === null || typeof sidecar.stateHash === "string") &&
    typeof sidecar.scannedAtMs === "number" &&
    !!sidecar.files &&
    typeof sidecar.files === "object" &&
    Object.values(sidecar.files).every(isSidecarEntry)
  );
}

/** A directory entry the scan skipped because it is not a regular file —
 *  symlinks/sockets/FIFOs are NOT part of the GAD file model and are never
 *  captured in a state. Surfaced (not silently dropped) so callers can warn. */
interface SkippedEntry {
  path: string;
  kind: "symlink" | "socket" | "fifo" | "block-device" | "char-device" | "inadmissible" | "other";
  reason?: string;
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
 * workspace/context checkouts drive {@link ContentProjectionStore.materializeInto} with
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

interface ContentProjectionStoreDeps {
  blobsDir: string;
}

interface ScannedFile {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

/**
 * Full file listing of a mirrored tree/state straight from the CONTENT STORE.
 * This deliberately follows the exact keyset-paged inventory to completion;
 * one page can never be mistaken for the snapshot. Returns null only when the
 * requested root is absent and throws on broken interior references.
 */
export async function collectTreeFiles(
  blobsDir: string,
  ref: string,
  options: { maxInventoryEntries?: number } = {}
): Promise<Array<{ path: string; contentHash: string; mode: number }> | null> {
  const listing = await collectExactTreeListing(blobsDir, ref, {
    ...(options.maxInventoryEntries === undefined
      ? {}
      : { maxEntries: options.maxInventoryEntries }),
  });
  return (
    listing?.flatMap((entry) =>
      entry.kind === "file"
        ? [{ path: entry.path, contentHash: entry.contentHash, mode: entry.mode }]
        : []
    ) ?? null
  );
}

export class ContentProjectionStore {
  constructor(private readonly deps: ContentProjectionStoreDeps) {
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
      const parsed: unknown = JSON.parse(raw);
      if (isSidecarState(parsed)) return parsed;
    } catch {
      // missing/corrupt sidecar — cache amnesia, full rescan
    }
    return emptySidecar();
  }

  private async writeSidecar(dir: string, state: UnstampedSidecarState): Promise<void> {
    const sidecarPath = this.sidecarPath(dir);
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    const tmp = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    // Stamp the recording instant — the racily-clean boundary for the NEXT
    // scan's (size, mtime) fast path (see hashFiles).
    const stamped: SidecarState = { ...state, scannedAtMs: Date.now() };
    await fsp.writeFile(tmp, `${JSON.stringify(stamped, null, 2)}\n`);
    await fsp.rename(tmp, sidecarPath);
  }

  // -------------------------------------------------------------------------
  // Scan + content-addressed mirror
  // -------------------------------------------------------------------------

  private async scanDir(dir: string): Promise<{ files: ScannedFile[]; skipped: SkippedEntry[] }> {
    const out: ScannedFile[] = [];
    const skipped: SkippedEntry[] = [];
    const skippedKind = (entry: fs.Dirent): SkippedEntry["kind"] => {
      if (entry.isSymbolicLink()) return "symlink";
      if (entry.isSocket()) return "socket";
      if (entry.isFIFO()) return "fifo";
      if (entry.isBlockDevice()) return "block-device";
      if (entry.isCharacterDevice()) return "char-device";
      return "other";
    };
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childAbs = path.join(abs, entry.name);
          const admission = semanticVcsPathAdmission(childRel);
          if (!admission.admissible) {
            // Platform metadata is deliberately outside the semantic tree.
            // Every other rejection is source data loss and must be visible to
            // the caller instead of making the initial snapshot incomplete.
            if (admission.reason !== "platform-reserved") {
              skipped.push({ path: childRel, kind: "inadmissible", reason: admission.message });
            }
            return;
          }
          if (entry.isDirectory()) {
            await walk(childAbs, childRel);
          } else if (entry.isFile()) {
            const stat = await fsp.stat(childAbs);
            out.push({
              path: childRel,
              absPath: childAbs,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              mode: stat.mode & 0o111 ? 33261 : 33188,
            });
          } else {
            // Symlinks / sockets / devices are not part of the GAD file model —
            // reported (never silently dropped) so callers can explain that
            // the entry cannot be represented in the shared content model.
            skipped.push({ path: childRel, kind: skippedKind(entry) });
          }
        })
      );
    };
    await walk(dir, "");
    out.sort((a, b) => compareUtf16CodeUnits(a.path, b.path));
    skipped.sort((a, b) => compareUtf16CodeUnits(a.path, b.path));
    return { files: out, skipped };
  }

  /**
   * The racily-clean window (git's classic problem): a file rewritten with
   * identical length inside the filesystem timestamp granularity of the
   * sidecar write is indistinguishable from unchanged by (size, mtime) alone.
   * Any cached entry whose mtime falls within this window of the sidecar's
   * `scannedAtMs` is rehashed instead of trusted.
   */
  private static readonly RACY_MTIME_WINDOW_MS = 10;

  /**
   * Hash every scanned file, using the sidecar's (size, mtime) fast path to
   * skip rehashing unchanged files — EXCEPT racily-clean entries (mtime at or
   * after `scannedAtMs − window`), which are always rehashed: a same-size
   * rewrite within the timestamp granularity of the previous scan would
   * otherwise reuse a stale hash and silently drop the change. Returns the
   * full file list for ingest plus the refreshed sidecar entries.
   */
  private async hashFiles(
    scanned: ScannedFile[],
    sidecar: SidecarState
  ): Promise<{ files: ContentFileEntry[]; entries: Record<string, SidecarEntry> }> {
    const files: ContentFileEntry[] = [];
    const entries: Record<string, SidecarEntry> = {};
    const trustedBefore = sidecar.scannedAtMs - ContentProjectionStore.RACY_MTIME_WINDOW_MS;
    for (const file of scanned) {
      const cached = sidecar.files[file.path];
      let contentHash: string;
      if (
        cached &&
        cached.size === file.size &&
        cached.mtimeMs === file.mtimeMs &&
        file.mtimeMs < trustedBefore
      ) {
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
   * The shared implementation lives in
   * @vibestudio/content-addressing.
   * This is the bootstrap path: builds can be content-addressed before the
   * gad store is reachable.
   */
  async localState(
    dir: string,
    opts: {
      /** Refresh the `.gad/CHECKOUT.json` projection cache with the scan's
       *  (size, mtime, hash) entries. */
      updateSidecar?: boolean;
      /** Hash every byte instead of consulting the disposable projection cache. */
      exact?: boolean;
    } = {}
  ): Promise<{
    stateHash: string;
    previousStateHash: string | null;
    files: ContentFileEntry[];
    manifest: WorktreeManifest;
    skipped: SkippedEntry[];
  }> {
    const sidecar = await this.readSidecar(dir);
    const { files: scanned, skipped } = await this.scanDir(dir);
    const { files, entries } = await this.hashFiles(scanned, opts.exact ? emptySidecar() : sidecar);
    const manifest = buildWorktreeManifest(files);
    // Eager half of the mirroring invariant: the scan holds the full file list
    // in memory, so the content store gets the tree before the hash is handed
    // out. Cheap when already mirrored (one stat on the state node).
    await mirrorWorktreeTree(this.deps.blobsDir, files, { expectStateHash: manifest.stateHash });
    if (opts.updateSidecar) {
      await this.writeSidecar(dir, { version: 2, stateHash: manifest.stateHash, files: entries });
    }
    return {
      stateHash: manifest.stateHash,
      previousStateHash: sidecar.stateHash,
      files,
      manifest,
      skipped,
    };
  }

  // -------------------------------------------------------------------------
  // Materialize (checkout)
  // -------------------------------------------------------------------------

  /**
   * THE editable-checkout materialize primitive — "write `target` into `dir`,
   * tracking what's present". Every EDITABLE checkout path funnels through
   * here (workspace root and context-repository subtrees):
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
    const sidecar = useSidecar ? await this.readSidecar(dir) : emptySidecar();
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

      if (useSidecar && !opts.clean) {
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
      const { files: scanned, skipped } = await this.scanDir(dir);
      for (const file of scanned) {
        if (!targetPaths.has(file.path)) {
          await fsp.rm(file.absPath, { force: true, recursive: true });
          deleted += 1;
        }
      }
      for (const entry of skipped) {
        await fsp.rm(safeWorktreeJoin(dir, entry.path), { force: true, recursive: true });
        deleted += 1;
      }
    }

    if (useSidecar) {
      await this.pruneEmptyDirs(dir);
      await this.writeSidecar(dir, {
        version: 2,
        stateHash: opts.stateHash ?? sidecar.stateHash,
        files: entries,
      });
    }
    return { written, deleted, unchanged };
  }

  /**
   * Full editable checkout of a state into a directory (workspace root,
   * context-repository subtree). Thin preset over
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
   * working for exact content projections independently of semantic history.
   */
  async listStateFiles(
    stateHash: string,
    options: { maxInventoryEntries?: number } = {}
  ): Promise<TargetFile[]> {
    await this.ensureStateMirrored(stateHash);
    const files = await collectTreeFiles(this.deps.blobsDir, stateHash, options);
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
    if (!/^state:[0-9a-f]{64}$/.test(stateHash)) {
      throw new Error(`worktree content coordinate is not a canonical state hash: ${stateHash}`);
    }
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
          if (depth === 0 && !semanticVcsPathAdmission(entry.name).admissible) {
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
}
