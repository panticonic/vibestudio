/**
 * Line-level blame as pure offset composition over a first-parent op chain —
 * the query-time core of `blameLines` (design §5.2). Pure, workerd-safe (no IO,
 * no Buffer, no Node types): the gad-store DO materializes the file at a head,
 * maps the query lines to character offsets, gathers the path's op rows along
 * one first-parent chain (working tail first), and calls {@link blameChain};
 * the DO owns row-fetching, merge-parent re-gathering, and turn/session joins.
 *
 * Blame is an interval problem in offset space. Each op's hunks describe how its
 * PRE-state content becomes its POST-state: a hunk replaces the pre-range
 * `[start, end)` with `newText`, occupying the post-range
 * `[start, start + newText.length)`. Composition is only exact because U1–U3
 * make the chain total (every text mutation carries hunks; merges record
 * origin-annotated hunks), so there is no content-diff fallback here — an
 * unmarked gap is an integrity bug, not a case to paper over.
 */

/**
 * One recorded hunk as stored on an edit-op row (`hunks_json`). Covers both the
 * plain replace/write shape ({@link import("./editEngine.js").ReplaceHunk}) and
 * the origin-annotated merge shape ({@link import("./diff3.js").MergeHunk}); a
 * merge op's hunks carry `origin` (and, for `"theirs"`, the other-parent char
 * span `theirsStart`/`theirsEnd`) per hunk.
 */
export interface BlameHunk {
  start: number;
  end: number;
  newText: string;
  oldText?: string;
  origin?: "theirs" | "resolved";
  theirsStart?: number;
  theirsEnd?: number;
}

/**
 * One edit-op row along a first-parent chain, adapted from the store's
 * `gad_worktree_edit_ops` shape. `hunks` is the parsed `hunks_json` (null for
 * `create`/`delete`/`chmod`, binary content, and synthetic snapshot ops).
 * `origin` lives on the individual hunks, not the row.
 */
export interface BlameOpRow {
  opId: string | number;
  kind: string;
  hunks: BlameHunk[] | null;
  oldContentHash: string | null;
  newContentHash: string | null;
  synthetic: boolean;
  binary: boolean;
}

export type BlameResolution =
  /** The op authored the content at this offset via `hunkIndex`. */
  | { kind: "op"; opId: string | number; hunkIndex: number }
  /** A `theirs`-origin merge hunk: continue on the other parent's chain at
   *  `theirsOffset` (the mapped char offset into the other parent's content). */
  | { kind: "route-theirs"; opId: string | number; theirsOffset: number }
  /** The walk ended at a semantic origin/barrier (no producing op to attribute). */
  | {
      kind: "stop";
      reason: "create" | "binary" | "synthetic" | "older-than-log";
      opId?: string | number;
    };

export interface BlameResult {
  /** The input query offset (in the head file's coordinates), echoed back. */
  offset: number;
  resolution: BlameResolution;
}

type Located =
  | { inside: true; hunkIndex: number; offsetWithin: number; hunk: BlameHunk }
  | { inside: false; pre: number };

/**
 * Locate a post-state offset `p` within one op's hunks. Hunks are sorted by
 * pre-state `start` and each shifts later offsets by `newText.length -
 * (end - start)`; a hit inside a hunk's post-range means the op authored `p`,
 * otherwise `pre` is `p` carried back into the op's pre-state coordinates.
 */
function locate(hunks: BlameHunk[], p: number): Located {
  const order = hunks.map((h, idx) => ({ h, idx })).sort((a, b) => a.h.start - b.h.start);
  let shift = 0;
  for (const { h, idx } of order) {
    const postStart = h.start + shift;
    const postEnd = postStart + h.newText.length;
    if (p < postStart) return { inside: false, pre: p - shift };
    if (p < postEnd) return { inside: true, hunkIndex: idx, offsetWithin: p - postStart, hunk: h };
    shift += h.newText.length - (h.end - h.start);
  }
  return { inside: false, pre: p - shift };
}

function resolveOffset(ops: BlameOpRow[], query: number): BlameResolution {
  let current = query;
  for (const op of ops) {
    const hunks = op.hunks ?? [];
    const loc = locate(hunks, current);
    if (loc.inside) {
      const hunk = loc.hunk;
      if (hunk.origin === "theirs" && hunk.theirsStart != null) {
        return {
          kind: "route-theirs",
          opId: op.opId,
          theirsOffset: hunk.theirsStart + loc.offsetWithin,
        };
      }
      if (hunk.origin === "resolved") {
        // Not terminal: fold the offset back into the merge op's pre (ours)
        // coordinates and keep walking the same chain to the resolving edits.
        current = hunk.start + Math.min(loc.offsetWithin, hunk.end - hunk.start);
        continue;
      }
      // Plain replace/write hunk (or a "theirs" hunk lacking coordinates, which
      // degrades to attributing the merge op itself).
      return { kind: "op", opId: op.opId, hunkIndex: loc.hunkIndex };
    }
    // The offset is not authored here. A create/binary/synthetic op is where
    // identity genuinely begins or provably restarts — the walk stops.
    if (op.kind === "create") return { kind: "stop", reason: "create", opId: op.opId };
    if (op.binary) return { kind: "stop", reason: "binary", opId: op.opId };
    if (op.synthetic) return { kind: "stop", reason: "synthetic", opId: op.opId };
    current = loc.pre;
  }
  return { kind: "stop", reason: "older-than-log" };
}

/**
 * Compose blame for each query `offset` back along one first-parent chain of
 * `ops` (newest→oldest, working tail first). Returns one result per input
 * offset, in order. See design §5.2 steps 1-2-4; step 3 (merge routing) is
 * surfaced as `route-theirs` for the caller to continue on the other parent.
 */
export function blameChain(ops: BlameOpRow[], offsets: number[]): BlameResult[] {
  return offsets.map((offset) => ({ offset, resolution: resolveOffset(ops, offset) }));
}
