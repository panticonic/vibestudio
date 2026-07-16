/**
 * Diff-review deep-link target consumed by the gad-browser panel.
 *
 * The approval card's "open in gad-browser" escape hatch launches (or navigates)
 * this panel with a `diffTarget` state-arg naming a file at two tree states. The
 * panel renders a real two-state compare view (the shared `@workspace/ui`
 * `DiffViewer`) for the target, with the whole changed-file set of the entry
 * available for stepping, and still offers the Files-tab focus filter as the
 * fallback when content can't be fetched. These pure helpers parse the untrusted
 * state-arg, build the compare entry, resolve states → branches, and drive the
 * focus filter; they are unit-tested in isolation.
 */
import type { DiffChangedFile, DiffFileKind, DiffReviewEntry } from "@workspace/ui";

/**
 * One changed file of the diff-review entry, carried alongside the focused file
 * so the compare view can step across every file the reviewer was sent for.
 * Mirror of `@workspace/ui`'s `DiffChangedFile`.
 */
export type DiffTargetFile = DiffChangedFile;

/** Parsed, validated deep-link target (mirror of the shell's `GadBrowserTarget`). */
export interface DiffTarget {
  repoPath: string;
  path: string;
  oldHash?: string;
  newHash?: string;
  oldState?: string;
  newState?: string | null;
  /** Host-flagged binary/oversized focused file — rendered diffstat-only. */
  binary?: boolean;
  tooLarge?: boolean;
  /**
   * Every changed file of the source entry (includes the focused `path`). When
   * present the compare view renders the whole set so the reviewer can step
   * between files; absent → the compare view shows just the focused file.
   */
  files?: DiffTargetFile[];
}

const FILE_KINDS: ReadonlySet<string> = new Set<DiffFileKind>(["added", "removed", "changed"]);

/** Validate one raw `files[]` entry into a `DiffTargetFile`, or `null`. */
function parseTargetFile(value: unknown): DiffTargetFile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  const kind = record["kind"];
  if (typeof path !== "string") return null;
  if (typeof kind !== "string" || !FILE_KINDS.has(kind)) return null;
  const file: DiffTargetFile = { path, kind: kind as DiffFileKind };
  if (typeof record["oldHash"] === "string") file.oldHash = record["oldHash"];
  if (typeof record["newHash"] === "string") file.newHash = record["newHash"];
  if (record["binary"] === true) file.binary = true;
  if (record["tooLarge"] === true) file.tooLarge = true;
  return file;
}

/**
 * Validate the raw `diffTarget` state-arg. Returns `null` for anything missing
 * the two required string fields (`repoPath`, `path`) so a malformed launch
 * simply renders the browser as usual, never throwing.
 */
export function parseDiffTarget(value: unknown): DiffTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const repoPath = record["repoPath"];
  const path = record["path"];
  if (typeof repoPath !== "string" || typeof path !== "string") return null;
  const target: DiffTarget = { repoPath, path };
  const oldHash = record["oldHash"];
  const newHash = record["newHash"];
  const oldState = record["oldState"];
  const newState = record["newState"];
  if (typeof oldHash === "string") target.oldHash = oldHash;
  if (typeof newHash === "string") target.newHash = newHash;
  if (typeof oldState === "string") target.oldState = oldState;
  if (newState === null) target.newState = null;
  else if (typeof newState === "string") target.newState = newState;
  if (record["binary"] === true) target.binary = true;
  if (record["tooLarge"] === true) target.tooLarge = true;
  const files = record["files"];
  if (Array.isArray(files)) {
    const parsed = files
      .map(parseTargetFile)
      .filter((file): file is DiffTargetFile => file !== null);
    if (parsed.length > 0) target.files = parsed;
  }
  return target;
}

/** Derive the change kind of the focused file from its two content hashes. */
export function focusedFileKind(target: DiffTarget): DiffFileKind {
  if (target.oldHash && target.newHash) return "changed";
  if (target.newHash && !target.oldHash) return "added";
  return "removed";
}

/** The focused file (the `path` the reviewer was sent to) as a changed-file. */
function focusedFile(target: DiffTarget): DiffTargetFile {
  const file: DiffTargetFile = { path: target.path, kind: focusedFileKind(target) };
  if (target.oldHash) file.oldHash = target.oldHash;
  if (target.newHash) file.newHash = target.newHash;
  if (target.binary) file.binary = true;
  if (target.tooLarge) file.tooLarge = true;
  return file;
}

/**
 * Build the `DiffReviewEntry` the shared `DiffViewer` consumes for a target.
 * Uses the full `files[]` set when present (so every changed file is available
 * for stepping), otherwise a single-file entry for the focused `path`. Line
 * totals are omitted — the viewer computes exact per-file counts from the two
 * blobs it fetches lazily by content hash.
 */
export function buildCompareEntry(target: DiffTarget): DiffReviewEntry {
  const changedFiles: DiffTargetFile[] =
    target.files && target.files.length > 0 ? target.files : [focusedFile(target)];
  return {
    repoPath: target.repoPath,
    oldState: target.oldState ?? "",
    newState: target.newState ?? null,
    diffStat: { filesChanged: changedFiles.length },
    changedFiles,
  };
}

/**
 * Whether a canonical VCS file-list entry is the deep-link target. Matches on
 * the exact path, or on the entry's semantic content identity.
 */
export function rowMatchesDiffTarget(row: Record<string, unknown>, target: DiffTarget): boolean {
  if (typeof row["path"] === "string" && row["path"] === target.path) return true;
  if (
    target.newHash &&
    typeof row["contentHash"] === "string" &&
    row["contentHash"] === target.newHash
  ) {
    return true;
  }
  return false;
}

/** Short, human-friendly form of a state/content hash for banner display. */
export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  const bare = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  return bare.length > 12 ? `${bare.slice(0, 12)}…` : bare;
}

/** One-line description of the target for the focus banner. */
export function describeDiffTarget(target: DiffTarget): string {
  const state = target.newState === null ? "removed" : shortHash(target.newState);
  return `${target.repoPath} · ${target.path} @ ${state}`;
}
