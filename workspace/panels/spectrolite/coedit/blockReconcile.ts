/**
 * Block reconciliation — the co-edit classifier.
 *
 * When the scribe (or any actor) advances the vault's semantic working state, the
 * editor must apply the newly integrated document to live Lexical state
 * **narrowly**, never via a whole-doc reset. This module decides, per top-level
 * block, what to do —
 * implementing decisions 3, 4, and section C of the plan:
 *
 *  1. **Collision check first, fail-safe.** A change that touches a block the
 *     user is *live* in (dirty or has the caret) is NEVER auto-applied. Because
 *     blocks carry exact source ranges, "the incoming change's range overlaps a
 *     live block" is precisely "a live block falls inside the changed run" — no
 *     reliance on fuzzy signature identity. Any such run → a {@link Collision}
 *     (the SuggestionCard path), leaving the user's text + caret intact.
 *  2. **Contained** (one block ↔ one block) → a surgical single-node replace.
 *  3. **Structural** (a block split/merge, insertion, or deletion) → a
 *     **bounded** replace of the minimal contiguous run of blocks — never the
 *     whole document.
 *
 * Pure over an abstract block list (the editor's block registry supplies the
 * blocks with stable ids + exact ranges from mdast positions), so it is fully
 * unit-testable without a live editor.
 */

export interface Block {
  /** Stable identity within the *current* document (e.g. the Lexical nodeKey).
   *  Incoming blocks use a synthetic id; alignment is by signature, not id. */
  id: string;
  /** Content signature used to align current↔incoming (e.g. the block's
   *  normalized source text, or a hash of it). Two blocks are "the same" iff
   *  their signatures match. */
  signature: string;
  /** Canonical source text of this block. */
  text: string;
  /** Char offset of the block's start in the canonical document. */
  start: number;
  /** Char offset of the block's end (exclusive) in the canonical document. */
  end: number;
}

/** Auto-apply: replace exactly one live node's content (no structural change). */
export interface ContainedOp {
  kind: "contained";
  oldId: string;
  oldIndex: number;
  newText: string;
}

/** Auto-apply: replace a contiguous run of blocks [fromIndex, toIndex] with
 *  `newTexts`. `oldIds` empty + `newTexts` non-empty = pure insertion before
 *  `fromIndex`; `newTexts` empty = pure deletion.
 *
 *  `oldIds` are the stable ids (Lexical node keys) to remove and `beforeId` is
 *  the id of the block the new content should be inserted before (`null` =
 *  append at end). Node-key anchors (not indices) keep editor surgery robust
 *  when multiple ops apply in sequence. */
export interface StructuralOp {
  kind: "structural";
  fromIndex: number;
  toIndex: number;
  oldIds: string[];
  newTexts: string[];
  beforeId: string | null;
}

export type ReconcileOp = ContainedOp | StructuralOp;

/** A change that overlaps a live block → surface a SuggestionCard, do not apply. */
export interface Collision {
  fromIndex: number;
  toIndex: number;
  oldIds: string[];
  oldTexts: string[];
  /** The agent's proposed replacement block(s) for this run. */
  newTexts: string[];
  /** Which of the run's current blocks are live (dirty / active-caret). */
  liveIds: string[];
}

export interface Reconciliation {
  /** Non-colliding changes safe to apply live (in document order). */
  ops: ReconcileOp[];
  /** Overlapping-with-live-edit changes → SuggestionCard (in document order). */
  collisions: Collision[];
  changed: boolean;
}

type AlignOp =
  | { t: "match"; ci: number; ii: number }
  | { t: "del"; ci: number }
  | { t: "ins"; ii: number };

/** LCS over block signatures → an in-order alignment (match / delete / insert). */
function alignBySignature(current: Block[], incoming: Block[]): AlignOp[] {
  const n = current.length;
  const m = incoming.length;
  // dp[i][j] = LCS length of current[i:] and incoming[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        current[i]!.signature === incoming[j]!.signature
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (current[i]!.signature === incoming[j]!.signature) {
      ops.push({ t: "match", ci: i, ii: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: "del", ci: i });
      i++;
    } else {
      ops.push({ t: "ins", ii: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", ci: i++ });
  while (j < m) ops.push({ t: "ins", ii: j++ });
  return ops;
}

interface ChangeRun {
  /** Where this run sits in `current` (insertion anchor when no current blocks). */
  anchor: number;
  ci: number[];
  ii: number[];
}

/** Group the alignment into maximal change runs bounded by matched blocks. */
function changeRuns(ops: AlignOp[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let consumed = 0; // current blocks consumed by matches/deletes so far
  let cur: ChangeRun | null = null;
  for (const op of ops) {
    if (op.t === "match") {
      if (cur) {
        runs.push(cur);
        cur = null;
      }
      consumed = op.ci + 1;
      continue;
    }
    if (!cur) cur = { anchor: op.t === "del" ? op.ci : consumed, ci: [], ii: [] };
    if (op.t === "del") {
      cur.ci.push(op.ci);
      consumed = op.ci + 1;
    } else {
      cur.ii.push(op.ii);
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/**
 * Reconcile the incoming canonical block list against the current editor blocks.
 * `liveBlockIds` are the ids of blocks the user is actively editing (dirty) or
 * has the caret in — those route to the SuggestionCard on any change.
 */
export function reconcileBlocks(
  current: Block[],
  incoming: Block[],
  liveBlockIds: ReadonlySet<string>
): Reconciliation {
  const runs = changeRuns(alignBySignature(current, incoming));
  const ops: ReconcileOp[] = [];
  const collisions: Collision[] = [];

  for (const run of runs) {
    const oldIds = run.ci.map((i) => current[i]!.id);
    const oldTexts = run.ci.map((i) => current[i]!.text);
    const newTexts = run.ii.map((i) => incoming[i]!.text);
    const liveIds = oldIds.filter((id) => liveBlockIds.has(id));

    // Fail-safe: the run's range overlaps a live block → never auto-apply.
    if (liveIds.length > 0) {
      const fromIndex = run.ci[0] ?? run.anchor;
      const toIndex = run.ci.length ? run.ci[run.ci.length - 1]! : run.anchor - 1;
      collisions.push({ fromIndex, toIndex, oldIds, oldTexts, newTexts, liveIds });
      continue;
    }

    if (run.ci.length === 1 && run.ii.length === 1) {
      // Contained: one block changed in place → surgical single-node replace.
      ops.push({
        kind: "contained",
        oldId: current[run.ci[0]!]!.id,
        oldIndex: run.ci[0]!,
        newText: incoming[run.ii[0]!]!.text,
      });
    } else {
      // Structural: split/merge/insert/delete → bounded block-range replace.
      const fromIndex = run.ci[0] ?? run.anchor;
      const toIndex = run.ci.length ? run.ci[run.ci.length - 1]! : run.anchor - 1;
      // The block immediately after the run anchors insertion (stable node key).
      const afterIndex = run.ci.length ? run.ci[run.ci.length - 1]! + 1 : run.anchor;
      const beforeId = current[afterIndex]?.id ?? null;
      ops.push({ kind: "structural", fromIndex, toIndex, oldIds, newTexts, beforeId });
    }
  }

  return { ops, collisions, changed: ops.length > 0 || collisions.length > 0 };
}
