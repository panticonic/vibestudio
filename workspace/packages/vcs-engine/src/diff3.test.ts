import { describe, it, expect } from "vitest";
import { diff3Merge, mergeHunksVsOurs } from "./diff3.js";

describe("diff3Merge", () => {
  it("returns ours when theirs is unchanged", () => {
    const result = diff3Merge("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n");
    expect(result).toEqual({ ok: true, text: "a\nB\nc\n", conflicts: 0 });
  });

  it("returns theirs when ours is unchanged", () => {
    const result = diff3Merge("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n");
    expect(result).toEqual({ ok: true, text: "a\nb\nC\n", conflicts: 0 });
  });

  it("merges non-overlapping edits from both sides", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const ours = "ONE\ntwo\nthree\nfour\nfive\n";
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("merges an insertion and a distant deletion", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nnew\nb\nc\nd\ne\n";
    const theirs = "a\nb\nc\nd\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nnew\nb\nc\nd\n");
  });

  it("takes identical changes from both sides without conflict", () => {
    const base = "a\nb\nc\n";
    const both = "a\nB!\nc\n";
    const result = diff3Merge(base, both, both);
    expect(result).toEqual({ ok: true, text: both, conflicts: 0 });
  });

  it("emits conflict markers for overlapping different edits", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nours\nc\n";
    const theirs = "a\ntheirs\nc\n";
    const result = diff3Merge(base, ours, theirs, {
      oursLabel: "main",
      theirsLabel: "ctx:1",
    });
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< main\nours\n=======\ntheirs\n>>>>>>> ctx:1\nc\n");
  });

  it("handles edits at file boundaries", () => {
    const base = "m\n";
    const ours = "start\nm\n";
    const theirs = "m\nend\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("start\nm\nend\n");
  });

  it("handles empty base (both sides add different content → conflict)", () => {
    const result = diff3Merge("", "ours\n", "theirs\n");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("<<<<<<<");
  });

  it("renders multiple absorbed theirs chunks with base gap lines intact", () => {
    // ours replaces B..D as one chunk; theirs edits B and D separately with
    // unchanged base line c between — c must survive in theirs' view.
    const base = "a\nB\nc\nD\ne\n";
    const ours = "a\nX\ne\n";
    const theirs = "a\nB2\nc\nD2\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nX\n=======\nB2\nc\nD2\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when theirs edits inside a base span replaced by ours", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nZ\ne\n";
    const theirs = "a\nb\nT\nd\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nZ\n=======\nb\nT\nd\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when ours partially overlaps the left side of theirs", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nB\nC\nd\ne\n";
    const theirs = "a\nX\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< ours\nB\nC\nd\n=======\nX\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when ours partially overlaps the right side of theirs", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nb\nX\ne\n";
    const theirs = "a\nB\nC\nd\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< ours\nb\nX\n=======\nB\nC\nd\n>>>>>>> theirs\ne\n");
  });

  it("renders multiple absorbed ours chunks with base gap lines intact (symmetric)", () => {
    const base = "a\nB\nc\nD\ne\n";
    const ours = "a\nB2\nc\nD2\ne\n";
    const theirs = "a\nX\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nB2\nc\nD2\n=======\nX\n>>>>>>> theirs\ne\n");
  });

  it("handles multiple absorbed chunks on both sides", () => {
    // The region cascades: ours' B..D replacement absorbs theirs' D..F
    // replacement, which in turn absorbs ours' F edit. Each side keeps its
    // unchanged base gap lines (e for ours, c for theirs).
    const base = "a\nB\nc\nD\ne\nF\ng\n";
    const ours = "a\nX\ne\nF1\ng\n"; // replaces B..D with X, edits F
    const theirs = "a\nB2\nc\nY\ng\n"; // edits B, replaces D..F with Y
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe(
      "a\n" +
        "<<<<<<< ours\n" +
        "X\ne\nF1\n" +
        "=======\n" +
        "B2\nc\nY\n" +
        ">>>>>>> theirs\n" +
        "g\n"
    );
  });

  it("still auto-merges multiple non-overlapping chunks from both sides", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\n";
    const ours = "a\nB!\nc\nd\ne\nF!\ng\n";
    const theirs = "a\nb\nc\nD!\ne\nf\ng\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nB!\nc\nD!\ne\nF!\ng\n");
  });

  it("preserves missing trailing newline when no input has one", () => {
    const result = diff3Merge("a\nb", "a\nB", "a\nb");
    expect(result.text).toBe("a\nB");
  });
});

describe("mergeHunksVsOurs (origin-annotated provenance)", () => {
  it("returns no hunks when the merge equals ours", () => {
    expect(mergeHunksVsOurs("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n", "a\nB\nc\n")).toEqual([]);
  });

  it("labels a region only theirs changed as origin 'theirs'", () => {
    // ours == base for the middle line; theirs changed it -> the merged text
    // adopts it, and ours left it untouched, so the hunk is theirs-originated.
    const base = "a\nb\nc\n";
    const ours = "a\nb\nc\n";
    const theirs = "a\nB\nc\n";
    const merged = "a\nB\nc\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.origin).toBe("theirs");
    // Char offsets index OURS; the hunk covers the changed line and its newText
    // carries the incoming content.
    const h = hunks[0]!;
    expect(ours.slice(h.start, h.end)).toContain("b");
    expect(h.newText).toContain("B");
  });

  it("labels a region ours also changed as origin 'resolved'", () => {
    // Both sides changed the same line region; a merged deviation over a region
    // OURS also touched is 'resolved'.
    const base = "x\ny\nz\n";
    const ours = "x\nY-ours\nz\n";
    const theirs = "x\ny\nY-theirs\nz\n";
    const merged = "x\nY-ours\nY-theirs\nz\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.some((h) => h.newText.includes("Y-theirs"))).toBe(true);
    expect(hunks.some((h) => h.origin === "resolved" || h.origin === "theirs")).toBe(true);
  });
});

describe("mergeHunksVsOurs theirsStart/theirsEnd (cross-parent routing coordinates)", () => {
  // The blame invariant for a clean take-theirs block: the recorded THEIRS char
  // span slices back to exactly the hunk's newText, so blame can carry an
  // offset inside the hunk into the other parent's own coordinates (§5.2).
  const takeTheirs = (h: { theirsStart?: number; theirsEnd?: number }, theirs: string): string =>
    theirs.slice(h.theirsStart ?? -1, h.theirsEnd ?? -1);

  it("maps a single mid-file theirs line back to its THEIRS char span", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nb\nc\n";
    const theirs = "a\nB\nc\n";
    const merged = "a\nB\nc\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h.origin).toBe("theirs");
    expect(h.theirsStart).toBe(2);
    expect(h.theirsEnd).toBe(4);
    expect(takeTheirs(h, theirs)).toBe(h.newText);
    expect(h.theirsEnd! - h.theirsStart!).toBe(h.newText.length);
  });

  it("maps two disjoint theirs regions each to their own THEIRS span", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nb\nc\nd\ne\n";
    const theirs = "a\nB\nc\nD\ne\n";
    const merged = "a\nB\nc\nD\ne\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks).toHaveLength(2);
    for (const h of hunks) {
      expect(h.origin).toBe("theirs");
      expect(takeTheirs(h, theirs)).toBe(h.newText);
    }
    expect([hunks[0]!.theirsStart, hunks[0]!.theirsEnd]).toEqual([2, 4]);
    expect([hunks[1]!.theirsStart, hunks[1]!.theirsEnd]).toEqual([6, 8]);
  });

  it("maps a theirs INSERTION to its THEIRS span", () => {
    const base = "a\nc\n";
    const ours = "a\nc\n";
    const theirs = "a\nb\nc\n";
    const merged = "a\nb\nc\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h.origin).toBe("theirs");
    expect(takeTheirs(h, theirs)).toBe(h.newText);
    expect(h.newText).toBe("b\n");
  });

  it("keeps the theirs span exact when THEIRS lacks a trailing newline", () => {
    const base = "a\nb";
    const ours = "a\nb";
    const theirs = "a\nB";
    const merged = "a\nB";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h.origin).toBe("theirs");
    expect(takeTheirs(h, theirs)).toBe(h.newText);
    expect(h.theirsEnd).toBe(theirs.length);
  });

  it("leaves theirsStart/theirsEnd unset on a 'resolved' hunk", () => {
    // Ours changed line 2 (b->B1) and theirs changed line 3 (c->C1); a merged
    // deviation over the region OURS touched is 'resolved' and never routes to
    // theirs, so it carries no theirs coordinates. The theirs-only line does.
    const base = "a\nb\nc\n";
    const ours = "a\nB1\nc\n";
    const theirs = "a\nb\nC1\n";
    const merged = "a\nB1\nC1\n";
    const hunks = mergeHunksVsOurs(base, ours, theirs, merged);
    const resolved = hunks.filter((h) => h.origin === "resolved");
    const theirsHunks = hunks.filter((h) => h.origin === "theirs");
    for (const h of resolved) {
      expect(h.theirsStart).toBeUndefined();
      expect(h.theirsEnd).toBeUndefined();
    }
    for (const h of theirsHunks) {
      expect(takeTheirs(h, theirs)).toBe(h.newText);
    }
  });

  it("agrees with the real MergeEngine chunk alignment via diff3Merge", () => {
    // Drive the same base/ours/theirs through diff3Merge, then assert every
    // theirs hunk slices back out of THEIRS exactly — proving the recorded
    // ranges track diff3's own alignment rather than a re-derivation.
    const base = "l1\nl2\nl3\nl4\nl5\n";
    const ours = "L1\nl2\nl3\nl4\nl5\n"; // ours edits line 1
    const theirs = "l1\nl2\nT3\nl4\nT5\n"; // theirs edits lines 3 and 5
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    const hunks = mergeHunksVsOurs(base, ours, theirs, result.text);
    const theirsHunks = hunks.filter((h) => h.origin === "theirs");
    expect(theirsHunks.length).toBeGreaterThan(0);
    for (const h of theirsHunks) {
      expect(theirs.slice(h.theirsStart, h.theirsEnd)).toBe(h.newText);
    }
    // The ours-side edit (L1) is ours' own content — never a theirs hunk.
    expect(hunks.every((h) => !h.newText.includes("L1"))).toBe(true);
  });
});
