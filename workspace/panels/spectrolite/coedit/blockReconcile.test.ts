import { describe, it, expect } from "vitest";
import { reconcileBlocks, type Block } from "./blockReconcile.js";

/** Current-doc blocks: ids c0,c1,…; signature = text; contiguous ranges. */
function current(...texts: string[]): Block[] {
  let pos = 0;
  return texts.map((text, idx) => {
    const start = pos;
    const end = pos + text.length;
    pos = end + 1;
    return { id: `c${idx}`, signature: text, text, start, end };
  });
}
/** Incoming canonical blocks: synthetic ids i0,i1,…. */
function incoming(...texts: string[]): Block[] {
  let pos = 0;
  return texts.map((text, idx) => {
    const start = pos;
    const end = pos + text.length;
    pos = end + 1;
    return { id: `i${idx}`, signature: text, text, start, end };
  });
}
const NONE = new Set<string>();

describe("reconcileBlocks", () => {
  it("no change → nothing to do", () => {
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A", "B", "C"), NONE);
    expect(r.changed).toBe(false);
    expect(r.ops).toEqual([]);
    expect(r.collisions).toEqual([]);
  });

  it("contained: a single non-live block change → surgical replace", () => {
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A", "B2", "C"), NONE);
    expect(r.collisions).toEqual([]);
    expect(r.ops).toEqual([{ kind: "contained", oldId: "c1", oldIndex: 1, newText: "B2" }]);
  });

  it("structural split (1 → 2 blocks) → bounded range replace", () => {
    const r = reconcileBlocks(current("A", "BC"), incoming("A", "B", "C"), NONE);
    expect(r.collisions).toEqual([]);
    expect(r.ops).toEqual([
      {
        kind: "structural",
        fromIndex: 1,
        toIndex: 1,
        oldIds: ["c1"],
        newTexts: ["B", "C"],
        beforeId: null,
      },
    ]);
  });

  it("insertion of a new block (not adjacent to a live edit) → auto-apply", () => {
    const r = reconcileBlocks(current("A", "C"), incoming("A", "B", "C"), NONE);
    expect(r.collisions).toEqual([]);
    // Pure insert before index 1 (before "C"): empty oldIds, toIndex = fromIndex - 1.
    expect(r.ops).toEqual([
      { kind: "structural", fromIndex: 1, toIndex: 0, oldIds: [], newTexts: ["B"], beforeId: "c1" },
    ]);
  });

  it("deletion of a block → bounded range replace with no new text", () => {
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A", "C"), NONE);
    expect(r.collisions).toEqual([]);
    expect(r.ops).toEqual([
      {
        kind: "structural",
        fromIndex: 1,
        toIndex: 1,
        oldIds: ["c1"],
        newTexts: [],
        beforeId: "c2",
      },
    ]);
  });

  it("collision: agent edits a block the user is live in → SuggestionCard, no auto-apply", () => {
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A", "B2", "C"), new Set(["c1"]));
    expect(r.ops).toEqual([]);
    expect(r.collisions).toEqual([
      {
        fromIndex: 1,
        toIndex: 1,
        oldIds: ["c1"],
        oldTexts: ["B"],
        newTexts: ["B2"],
        liveIds: ["c1"],
      },
    ]);
  });

  it("collision fail-safe: a STRUCTURAL agent edit overlapping a live block is never silently applied", () => {
    // Agent merges B+C into "BC"; the user is live in B → must surface, not apply.
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A", "BC"), new Set(["c1"]));
    expect(r.ops).toEqual([]);
    expect(r.collisions).toEqual([
      {
        fromIndex: 1,
        toIndex: 2,
        oldIds: ["c1", "c2"],
        oldTexts: ["B", "C"],
        newTexts: ["BC"],
        liveIds: ["c1"],
      },
    ]);
  });

  it("mixed: a live block collides while a disjoint block auto-applies", () => {
    // A is live (collision); C is not (auto-apply). Both changed by the agent.
    const r = reconcileBlocks(current("A", "B", "C"), incoming("A2", "B", "C2"), new Set(["c0"]));
    expect(r.ops).toEqual([{ kind: "contained", oldId: "c2", oldIndex: 2, newText: "C2" }]);
    expect(r.collisions).toEqual([
      {
        fromIndex: 0,
        toIndex: 0,
        oldIds: ["c0"],
        oldTexts: ["A"],
        newTexts: ["A2"],
        liveIds: ["c0"],
      },
    ]);
  });

  it("an insertion adjacent to (but not overlapping) a live block still auto-applies", () => {
    // User live in A; agent inserts B between A and C — disjoint from A's range.
    const r = reconcileBlocks(current("A", "C"), incoming("A", "B", "C"), new Set(["c0"]));
    expect(r.collisions).toEqual([]);
    expect(r.ops).toEqual([
      { kind: "structural", fromIndex: 1, toIndex: 0, oldIds: [], newTexts: ["B"], beforeId: "c1" },
    ]);
  });

  it("multiple disjoint non-live edits all auto-apply", () => {
    const r = reconcileBlocks(current("A", "B", "C", "D"), incoming("A2", "B", "C2", "D"), NONE);
    expect(r.collisions).toEqual([]);
    expect(r.ops).toEqual([
      { kind: "contained", oldId: "c0", oldIndex: 0, newText: "A2" },
      { kind: "contained", oldId: "c2", oldIndex: 2, newText: "C2" },
    ]);
  });
});
