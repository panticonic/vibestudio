/**
 * Diff-review deep-link target consumed by the gad-browser panel.
 *
 * The approval card's "open in gad-browser" escape hatch launches (or navigates)
 * this panel with a `diffTarget` state-arg naming a single file at two tree
 * states. gad-browser has no two-state compare view (see the module note in
 * `index.tsx`); the deepest it supports today is landing on the Files tab
 * filtered to the target path at the NEW state. These pure helpers parse the
 * untrusted state-arg and drive that focus, and are unit-tested in isolation.
 */

/** Parsed, validated deep-link target (mirror of the shell's `GadBrowserTarget`). */
export interface DiffTarget {
  repoPath: string;
  path: string;
  oldHash?: string;
  newHash?: string;
  oldState?: string;
  newState?: string | null;
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
  return target;
}

/**
 * Whether a Files-tab row is the deep-link target. Matches on the exact path,
 * or on the row's content hash equalling the target's new-state hash (the file
 * at the new state is what the reviewer is being sent to).
 */
export function rowMatchesDiffTarget(row: Record<string, unknown>, target: DiffTarget): boolean {
  if (typeof row["path"] === "string" && row["path"] === target.path) return true;
  if (
    target.newHash &&
    typeof row["content_hash"] === "string" &&
    row["content_hash"] === target.newHash
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
