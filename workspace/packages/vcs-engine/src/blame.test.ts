/**
 * blameChain — pure offset composition along one first-parent op chain (§5.2).
 * These craft BlameOpRow chains directly (blame is pure over rows) and assert
 * the exact offset math: shift composition across insert/delete/replace hunks,
 * multi-hunk ops, merge routing for both origins, semantic stops, chmod
 * pass-through, and working-tail-first ordering.
 */
import { describe, expect, it } from "vitest";
import { blameChain, type BlameHunk, type BlameOpRow } from "./blame.js";

function op(o: Partial<BlameOpRow> & { opId: string | number }): BlameOpRow {
  return {
    kind: "replace",
    hunks: null,
    oldContentHash: "old",
    newContentHash: "new",
    synthetic: false,
    binary: false,
    ...o,
  };
}

const create = (opId: string | number): BlameOpRow => op({ opId, kind: "create" });
const hunk = (
  start: number,
  end: number,
  newText: string,
  extra: Partial<BlameHunk> = {}
): BlameHunk => ({
  start,
  end,
  newText,
  ...extra,
});

describe("blameChain offset composition", () => {
  it("attributes a replace vs an insert vs the create origin", () => {
    // A: create "l1\nl2\nl3\n"; B: l2->L2; C: insert "NEW\n" after l1.
    // current file = "l1\nNEW\nL2\nl3\n" (offsets 0..12).
    const A = create("A");
    const B = op({ opId: "B", hunks: [hunk(3, 6, "L2\n")] });
    const C = op({ opId: "C", hunks: [hunk(3, 3, "NEW\n")] });
    const out = blameChain([C, B, A], [0, 4, 8]);
    expect(out.map((r) => r.offset)).toEqual([0, 4, 8]);
    expect(out[0]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" });
    expect(out[1]!.resolution).toEqual({ kind: "op", opId: "C", hunkIndex: 0 });
    expect(out[2]!.resolution).toEqual({ kind: "op", opId: "B", hunkIndex: 0 });
  });

  it("carries offsets back through an insertion shift", () => {
    // A: create "0123456789"; Ins: "XY" at 5 -> "01234XY56789".
    // The inserted "XY" occupies post-range [5,7); offsets 3 and 7 are original.
    const A = create("A");
    const Ins = op({ opId: "Ins", hunks: [hunk(5, 5, "XY")] });
    const out = blameChain([Ins, A], [5, 6, 3, 7]);
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "Ins", hunkIndex: 0 }); // "X"
    expect(out[1]!.resolution).toEqual({ kind: "op", opId: "Ins", hunkIndex: 0 }); // "Y"
    expect(out[2]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" }); // "3"
    expect(out[3]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" }); // "5"
  });

  it("carries offsets back through a deletion shift (negative delta)", () => {
    // A: create "0123456789"; Ins: "XY" at 5 -> "01234XY56789";
    // Del: remove [0,2) -> "234XY56789".
    const A = create("A");
    const Ins = op({ opId: "Ins", hunks: [hunk(5, 5, "XY")] });
    const Del = op({ opId: "Del", hunks: [hunk(0, 2, "")] });
    const out = blameChain([Del, Ins, A], [3, 5, 0]);
    // "234XY56789": idx3="X" (Ins), idx5="5" (A create), idx0="2" (A create).
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "Ins", hunkIndex: 0 });
    expect(out[1]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" });
    expect(out[2]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" });
  });

  it("composes shifts across several later ops (insert + insert + delete)", () => {
    // A: "abcdef"; B: [2,3)->"CCC" ("abCCCdef"); C: ""->"Z" at 0 ("ZabCCCdef");
    // D: remove [0,1) ("abCCCdef").
    const A = create("A");
    const B = op({ opId: "B", hunks: [hunk(2, 3, "CCC")] });
    const C = op({ opId: "C", hunks: [hunk(0, 0, "Z")] });
    const D = op({ opId: "D", hunks: [hunk(0, 1, "")] });
    const chain = [D, C, B, A];
    expect(blameChain(chain, [3])[0]!.resolution).toEqual({ kind: "op", opId: "B", hunkIndex: 0 });
    expect(blameChain(chain, [0])[0]!.resolution).toEqual({
      kind: "stop",
      reason: "create",
      opId: "A",
    });
  });

  it("handles a multi-hunk op with per-hunk shift and containment", () => {
    // A: create "0123456789"; M: [0,1)->"AAA" and [5,6)->"B".
    // current = "AAA1234B6789": [0,3)=hunk0, [3,7)=A, [7,8)=hunk1, [8,12)=A.
    const A = create("A");
    const M = op({ opId: "M", hunks: [hunk(0, 1, "AAA"), hunk(5, 6, "B")] });
    const out = blameChain([M, A], [1, 7, 4]);
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "M", hunkIndex: 0 });
    expect(out[1]!.resolution).toEqual({ kind: "op", opId: "M", hunkIndex: 1 });
    expect(out[2]!.resolution).toEqual({ kind: "stop", reason: "create", opId: "A" });
  });

  it("resolves hunkIndex against the ORIGINAL (unsorted) hunk order", () => {
    // Hunks supplied out of start-order; the returned hunkIndex must index the
    // array as given, not the internally sorted copy.
    const A = create("A");
    const M = op({ opId: "M", hunks: [hunk(5, 6, "B"), hunk(0, 1, "AAA")] });
    const out = blameChain([M, A], [7, 1]);
    // idx7 is the "B" hunk (array index 0); idx1 is the "AAA" hunk (array index 1).
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "M", hunkIndex: 0 });
    expect(out[1]!.resolution).toEqual({ kind: "op", opId: "M", hunkIndex: 1 });
  });
});

describe("blameChain merge routing", () => {
  it("routes a theirs-origin hit into the other parent's coordinates", () => {
    // Merge op inserts theirs content at ours-offset 10; the block lives at
    // theirs chars [40,47). A hit at offset 13 (3 into the block) maps to 43.
    const A = create("A");
    const MG = op({
      opId: "MG",
      kind: "replace",
      hunks: [hunk(10, 10, "THEIRS\n", { origin: "theirs", theirsStart: 40, theirsEnd: 47 })],
    });
    const out = blameChain([MG, A], [10, 13, 16]);
    expect(out[0]!.resolution).toEqual({ kind: "route-theirs", opId: "MG", theirsOffset: 40 });
    expect(out[1]!.resolution).toEqual({ kind: "route-theirs", opId: "MG", theirsOffset: 43 });
    expect(out[2]!.resolution).toEqual({ kind: "route-theirs", opId: "MG", theirsOffset: 46 });
  });

  it("continues down the SAME chain past a resolved-origin merge hunk", () => {
    // MG resolved a region ours also edited (op B); the offset is NOT terminal
    // at MG — it folds back into ours coordinates and blames the ours edit B.
    const A = create("A");
    const B = op({ opId: "B", hunks: [hunk(0, 2, "OURS\n")] });
    const MG = op({ opId: "MG", hunks: [hunk(0, 5, "MERGED\n", { origin: "resolved" })] });
    const out = blameChain([MG, B, A], [3]);
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "B", hunkIndex: 0 });
  });

  it("a theirs route then a second blame on the other parent finds the true author", () => {
    // Simulates the DO's two-hop: route-theirs on the ours chain, then blame the
    // returned offset on the other parent's own chain.
    const A = create("A");
    const MG = op({
      opId: "MG",
      hunks: [hunk(10, 10, "THEIRS\n", { origin: "theirs", theirsStart: 40, theirsEnd: 47 })],
    });
    const first = blameChain([MG, A], [13])[0]!.resolution;
    expect(first.kind).toBe("route-theirs");
    const theirsOffset = (first as { theirsOffset: number }).theirsOffset;
    // Other parent chain: op TT authored the theirs block at chars [40,47).
    const TA = create("TA");
    const TT = op({ opId: "TT", hunks: [hunk(40, 47, "THEIRS\n")] });
    const second = blameChain([TT, TA], [theirsOffset])[0]!.resolution;
    expect(second).toEqual({ kind: "op", opId: "TT", hunkIndex: 0 });
  });

  it("degrades a theirs hunk missing coordinates to attributing the merge op", () => {
    const A = create("A");
    const MG = op({ opId: "MG", hunks: [hunk(0, 0, "X\n", { origin: "theirs" })] });
    const out = blameChain([MG, A], [0]);
    expect(out[0]!.resolution).toEqual({ kind: "op", opId: "MG", hunkIndex: 0 });
  });
});

describe("blameChain semantic stops", () => {
  it("stops at a synthetic op (snapshot provenance) as degraded", () => {
    const S = op({ opId: "S", kind: "replace", synthetic: true, hunks: null });
    const B = op({ opId: "B", hunks: [hunk(0, 1, "Z")] });
    const out = blameChain([B, S], [5]);
    expect(out[0]!.resolution).toEqual({ kind: "stop", reason: "synthetic", opId: "S" });
  });

  it("stops at a binary op", () => {
    const Bin = op({ opId: "Bin", kind: "write", binary: true, hunks: null });
    const X = op({ opId: "X", hunks: [hunk(0, 1, "Z")] });
    const out = blameChain([X, Bin], [5]);
    expect(out[0]!.resolution).toEqual({ kind: "stop", reason: "binary", opId: "Bin" });
  });

  it("stops with older-than-log when the chain has no origin and no match", () => {
    const B = op({ opId: "B", hunks: [hunk(0, 1, "Z")] });
    const res = blameChain([B], [5])[0]!.resolution;
    expect(res).toEqual({ kind: "stop", reason: "older-than-log" });
    expect((res as { opId?: unknown }).opId).toBeUndefined();
  });

  it("returns older-than-log for an empty chain", () => {
    expect(blameChain([], [0])).toEqual([
      { offset: 0, resolution: { kind: "stop", reason: "older-than-log" } },
    ]);
  });
});

describe("blameChain pass-through and ordering", () => {
  it("chmod passes content through to the authoring op", () => {
    const A = create("A");
    const B = op({ opId: "B", hunks: [hunk(0, 1, "Q")] });
    const Chmod = op({ opId: "Chmod", kind: "chmod", hunks: null });
    expect(blameChain([Chmod, B, A], [0])[0]!.resolution).toEqual({
      kind: "op",
      opId: "B",
      hunkIndex: 0,
    });
  });

  it("chmod passes through to a create stop", () => {
    const A = create("A");
    const Chmod = op({ opId: "Chmod", kind: "chmod", hunks: null });
    expect(blameChain([Chmod, A], [5])[0]!.resolution).toEqual({
      kind: "stop",
      reason: "create",
      opId: "A",
    });
  });

  it("working tail (newest) wins over an older committed op for the same region", () => {
    const A = create("A");
    const Committed = op({ opId: "C", hunks: [hunk(0, 5, "OLD\n")] });
    const Working = op({ opId: "W", hunks: [hunk(0, 5, "NEWWORK\n")] });
    // Offset 2 lands inside both ops' post-regions; the newest (working) wins.
    expect(blameChain([Working, Committed, A], [2])[0]!.resolution).toEqual({
      kind: "op",
      opId: "W",
      hunkIndex: 0,
    });
  });
});
