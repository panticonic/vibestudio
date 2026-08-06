/**
 * Line-level diff counting — a small, pure, dependency-free helper used by the
 * protected-publication approval gate (provenance-aware-diff-merge-plan §9) to compute real insertion /
 * deletion counts for a changed text file from its two content-addressed blobs.
 *
 * It is a standard Longest-Common-Subsequence (Myers-family) line diff: the LCS
 * length L of the two line arrays gives `insertions = newLines - L` and
 * `deletions = oldLines - L` (every line not on the common subsequence is either
 * added or removed). This module exposes both the rolling-memory count used by
 * the host and a more tightly bounded row model shared by native and DOM review
 * surfaces over the same two trusted blobs.
 *
 * Bounded by construction: the LCS table is O(n*m), so a hard cell cap
 * (`MAX_LCS_CELLS`) makes `countLineDiff` return `null` for pathologically
 * line-dense inputs instead of doing unbounded work inside the approval critical
 * section. The gate treats a `null` (or an over-size / binary file) as
 * "not line-countable" and omits the whole entry's line totals — totals are
 * always either accurate or absent, never partial.
 */

/**
 * Split into lines WITHOUT a trailing empty element for a final newline, so a
 * file and the same file with a trailing newline don't diff as an extra blank
 * line. A genuinely empty file yields a single empty line (matching the UI
 * viewer's `splitLines`, so host counts and client rendering agree).
 */
export function splitLines(text: string): string[] {
  if (text === "") return [""];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line count of a blob under the same splitting rule the diff uses. */
export function countLines(text: string): number {
  return splitLines(text).length;
}

/**
 * Guard against unbounded LCS work: `n * m` cells at ~4 bytes each. 40M cells is
 * ~160 MiB of transient Int32 rows in the worst case AND bounds compute time; a
 * change big enough to exceed it is better summarised as "too large to count"
 * (the gate omits the entry's line totals) than allowed to stall the prompt.
 */
export const MAX_LCS_CELLS = 40_000_000;

export type DiffRowType = "context" | "added" | "removed";

export interface DiffRow {
  type: DiffRowType;
  /** 1-based line number in the old blob (absent for added rows). */
  oldLineNo?: number;
  /** 1-based line number in the new blob (absent for removed rows). */
  newLineNo?: number;
  text: string;
}

export interface LineDiffResult {
  rows: DiffRow[];
  insertions: number;
  deletions: number;
}

/** Tighter UI bounds than host-side count-only work, which uses rolling memory. */
export const MAX_RENDERED_DIFF_LINES = 20_000;
export const MAX_RENDERED_DIFF_CELLS = 4_000_000;

export class DiffTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffTooLargeError";
  }
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
 * Insertions/deletions between two blobs via LCS length (rolling one-row
 * Int32Array, O(min) space). Returns `null` when the input is too line-dense to
 * diff within the cell cap — the caller then omits line totals for the entry.
 */
export function countLineDiff(
  oldText: string,
  newText: string
): { insertions: number; deletions: number } | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) return null;

  // lcs[j] holds, as we sweep i from the bottom up, the LCS length of
  // a[i+1..] vs b[j..]; `curr` becomes a[i..] vs b[j..].
  let prev = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const curr = new Int32Array(m + 1);
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = ai === b[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!);
    }
    prev = curr;
  }
  const lcs = prev[0]!;
  return { insertions: m - lcs, deletions: n - lcs };
}

/**
 * Full ordered rows for review surfaces. This uses the same LCS definition as
 * `countLineDiff`, under stricter presentation bounds so expanding one file can
 * never allocate an unbounded matrix on a client.
 */
export function diffLines(oldText: string, newText: string): LineDiffResult {
  const a = oldText === "" ? [] : splitLines(oldText);
  const b = newText === "" ? [] : splitLines(newText);
  const n = a.length;
  const m = b.length;
  assertRenderableLineDiff(n, m);

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
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: "removed", oldLineNo: i + 1, text: a[i]! });
      deletions += 1;
      i += 1;
    } else {
      rows.push({ type: "added", newLineNo: j + 1, text: b[j]! });
      insertions += 1;
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "removed", oldLineNo: i + 1, text: a[i]! });
    deletions += 1;
    i += 1;
  }
  while (j < m) {
    rows.push({ type: "added", newLineNo: j + 1, text: b[j]! });
    insertions += 1;
    j += 1;
  }
  return { rows, insertions, deletions };
}

/** Full rows for a newly added file. */
export function allAdded(newText: string): LineDiffResult {
  const lines = splitLines(newText);
  assertRenderableLineDiff(0, lines.length);
  return {
    rows: lines.map((text, index) => ({ type: "added", newLineNo: index + 1, text })),
    insertions: newText === "" ? 0 : lines.length,
    deletions: 0,
  };
}

/** Full rows for a removed file. */
export function allRemoved(oldText: string): LineDiffResult {
  const lines = splitLines(oldText);
  assertRenderableLineDiff(lines.length, 0);
  return {
    rows: lines.map((text, index) => ({ type: "removed", oldLineNo: index + 1, text })),
    insertions: 0,
    deletions: oldText === "" ? 0 : lines.length,
  };
}
