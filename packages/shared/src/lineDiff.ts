/**
 * Line-level diff counting — a small, pure, dependency-free helper used by the
 * protected-publication approval gate (provenance-aware-diff-merge-plan §9) to compute real insertion /
 * deletion counts for a changed text file from its two content-addressed blobs.
 *
 * It is a standard Longest-Common-Subsequence (Myers-family) line diff: the LCS
 * length L of the two line arrays gives `insertions = newLines - L` and
 * `deletions = oldLines - L` (every line not on the common subsequence is either
 * added or removed). Only the counts are produced here — the reviewable
 * row-level rendering lives client-side in `@workspace/ui`'s viewer over the
 * same two trusted blobs.
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
