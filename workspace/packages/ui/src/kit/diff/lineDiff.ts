/**
 * Client-side line diff — a standard Longest-Common-Subsequence (Myers-family)
 * line diff over two blobs, producing unified-diff rows. Pure and dependency-
 * free: this is presentation over two host-trusted blobs, so it never needs to
 * agree with the host's file-level diff beyond the paths the payload already
 * named.
 */

export type DiffRowType = "context" | "added" | "removed";

export interface DiffRow {
  type: DiffRowType;
  /** 1-based line number in the OLD blob (absent for added rows). */
  oldLineNo?: number;
  /** 1-based line number in the NEW blob (absent for removed rows). */
  newLineNo?: number;
  text: string;
}

export interface LineDiffResult {
  rows: DiffRow[];
  insertions: number;
  deletions: number;
}

export const MAX_RENDERED_DIFF_LINES = 20_000;
export const MAX_RENDERED_DIFF_CELLS = 4_000_000;

export class DiffTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffTooLargeError";
  }
}

/**
 * Split into lines WITHOUT a trailing empty element for a final newline, so a
 * file and the same file with a trailing newline don't diff as an extra blank
 * line. A genuinely empty file yields a single empty line.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [""];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function assertRenderableLineDiff(oldLines: number, newLines: number): void {
  const totalLines = oldLines + newLines;
  if (totalLines > MAX_RENDERED_DIFF_LINES) {
    throw new DiffTooLargeError(
      `Diff is too large to render inline (${totalLines} lines; limit ${MAX_RENDERED_DIFF_LINES}).`
    );
  }
  const cells = oldLines * newLines;
  if (cells > MAX_RENDERED_DIFF_CELLS) {
    throw new DiffTooLargeError(
      `Diff is too large to render inline (${cells} comparison cells; limit ${MAX_RENDERED_DIFF_CELLS}).`
    );
  }
}

/**
 * LCS length matrix over two line arrays, then backtrack into ordered rows.
 * O(n*m) time/space — fine for the per-file blobs a reviewer expands one at a
 * time (oversized files are host-flagged `tooLarge` and never reach here).
 */
export function diffLines(oldText: string, newText: string): LineDiffResult {
  // An empty side has no real lines: unlike the single-blob helpers, a modified
  // diff must not emit a phantom blank removed/added row (or count it) for the
  // empty side — only the non-empty side's content diffs.
  const a = oldText === "" ? [] : splitLines(oldText);
  const b = newText === "" ? [] : splitLines(newText);
  const n = a.length;
  const m = b.length;
  assertRenderableLineDiff(n, m);

  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let insertions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "context", oldLineNo: i + 1, newLineNo: j + 1, text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: "removed", oldLineNo: i + 1, text: a[i]! });
      deletions++;
      i++;
    } else {
      rows.push({ type: "added", newLineNo: j + 1, text: b[j]! });
      insertions++;
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "removed", oldLineNo: i + 1, text: a[i]! });
    deletions++;
    i++;
  }
  while (j < m) {
    rows.push({ type: "added", newLineNo: j + 1, text: b[j]! });
    insertions++;
    j++;
  }

  return { rows, insertions, deletions };
}

/** All-added rows for a newly created file (one fetched blob). */
export function allAdded(newText: string): LineDiffResult {
  const b = splitLines(newText);
  assertRenderableLineDiff(0, b.length);
  const rows: DiffRow[] = b.map((text, idx) => ({ type: "added", newLineNo: idx + 1, text }));
  // A genuinely empty file still renders its blank row, but counts as +0.
  return { rows, insertions: newText === "" ? 0 : b.length, deletions: 0 };
}

/** All-removed rows for a deleted file (one fetched blob). */
export function allRemoved(oldText: string): LineDiffResult {
  const a = splitLines(oldText);
  assertRenderableLineDiff(a.length, 0);
  const rows: DiffRow[] = a.map((text, idx) => ({ type: "removed", oldLineNo: idx + 1, text }));
  // A genuinely empty file still renders its blank row, but counts as -0.
  return { rows, insertions: 0, deletions: oldText === "" ? 0 : a.length };
}
