/**
 * Commit-edit builder — turn the editor's locally-dirty blocks into the exact
 * `replace` hunks for `vcs.applyEdits` (plan section A + decision 2).
 *
 * Each dirty block carries its byte range in the *base* canonical document (the
 * content at `baseStateHash`, tracked by the block registry from mdast
 * positions) and its current serialized text. The happy path emits one surgical
 * `replace` hunk per dirty block. We then **verify** by replaying those hunks
 * against the base: if the result is byte-identical to the editor's current
 * canonical serialization, the surgical hunks are provably correct and we send
 * them. If not — a block's serialization couldn't be reconciled to canonical
 * bytes (formatting / wikilink / frontmatter normalization drift, or a
 * structural local edit the range map can't express) — we fall back to a single
 * whole-document replace hunk.
 *
 * `usedFallback` feeds the **fallback-rate metric** (the rewrite's success bar):
 * a stable, round-trip-idempotent serializer keeps this ~0; a high rate means
 * merge noise is back and the build should fail.
 */

export interface ReplaceHunk {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

export interface ReplaceEditOp {
  kind: "replace";
  path: string;
  hunks: ReplaceHunk[];
}

export interface DirtyBlockEdit {
  /** The block's start offset in the base canonical document. */
  baseStart: number;
  /** The block's end offset (exclusive) in the base canonical document. */
  baseEnd: number;
  /** The block's current serialized source. */
  newText: string;
}

export interface CommitEditsInput {
  path: string;
  /** Canonical document content at `baseStateHash`. */
  baseText: string;
  /** Full serialization of the editor's current state (all blocks). */
  currentCanonical: string;
  /** Dirty blocks with their base ranges + current text. */
  dirtyBlocks: DirtyBlockEdit[];
}

export interface CommitEditsResult {
  /** Empty when there is nothing to commit. */
  edits: ReplaceEditOp[];
  usedFallback: boolean;
  changed: boolean;
}

/** Apply exact-range replacement hunks (right-to-left so offsets stay valid).
 *  Mirrors the server's applyReplaceHunks; throws on out-of-range/overlap. */
export function applyReplaceHunks(content: string, hunks: ReplaceHunk[]): string {
  const sorted = [...hunks].sort((a, b) => b.start - a.start);
  let prevStart = content.length + 1;
  let out = content;
  for (const h of sorted) {
    if (h.start < 0 || h.end > content.length || h.start > h.end) {
      throw new Error(`hunk out of range [${h.start},${h.end}] (len ${content.length})`);
    }
    if (h.end > prevStart) throw new Error(`overlapping hunks at ${h.start}`);
    prevStart = h.start;
    out = out.slice(0, h.start) + h.newText + out.slice(h.end);
  }
  return out;
}

/**
 * Build the `replace` edit ops for a commit. Returns `changed: false` (no edits)
 * when the current canonical already equals the base.
 */
export function buildCommitEdits(input: CommitEditsInput): CommitEditsResult {
  const { path, baseText, currentCanonical, dirtyBlocks } = input;
  if (currentCanonical === baseText) {
    return { edits: [], usedFallback: false, changed: false };
  }

  const surgical = dirtyBlocks
    .filter((block) => baseText.slice(block.baseStart, block.baseEnd) !== block.newText)
    .map<ReplaceHunk>((block) => ({
      start: block.baseStart,
      end: block.baseEnd,
      oldText: baseText.slice(block.baseStart, block.baseEnd),
      newText: block.newText,
    }));

  if (surgical.length > 0) {
    try {
      if (applyReplaceHunks(baseText, surgical) === currentCanonical) {
        return { edits: [{ kind: "replace", path, hunks: surgical }], usedFallback: false, changed: true };
      }
    } catch {
      // Out-of-range / overlap → not reconcilable surgically; fall back.
    }
  }

  // Whole-doc fallback: one replace hunk over the entire base.
  return {
    edits: [
      {
        kind: "replace",
        path,
        hunks: [{ start: 0, end: baseText.length, oldText: baseText, newText: currentCanonical }],
      },
    ],
    usedFallback: true,
    changed: true,
  };
}
