import { describe, expect, it } from "vitest";
import { countLineDiff, countLines, splitLines, MAX_LCS_CELLS } from "./lineDiff.js";

describe("splitLines / countLines", () => {
  it("treats an empty file as a single empty line", () => {
    expect(splitLines("")).toEqual([""]);
    expect(countLines("")).toBe(1);
  });

  it("ignores a single trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });

  it("keeps interior blank lines and a doubled trailing newline", () => {
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
});

describe("countLineDiff", () => {
  it("counts a single changed line as 1 insertion + 1 deletion", () => {
    expect(countLineDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual({ insertions: 1, deletions: 1 });
  });

  it("counts a pure addition", () => {
    expect(countLineDiff("a\nc\n", "a\nb\nc\n")).toEqual({ insertions: 1, deletions: 0 });
  });

  it("counts a pure deletion", () => {
    expect(countLineDiff("a\nb\nc\n", "a\nc\n")).toEqual({ insertions: 0, deletions: 1 });
  });

  it("counts identical content as no change", () => {
    expect(countLineDiff("a\nb\n", "a\nb\n")).toEqual({ insertions: 0, deletions: 0 });
  });

  it("counts a full rewrite (no common lines) as all-removed + all-added", () => {
    expect(countLineDiff("a\nb\n", "x\ny\nz\n")).toEqual({ insertions: 3, deletions: 2 });
  });

  it("uses the longest common subsequence, not naive positional equality", () => {
    // LCS of [a,b,c,d] and [a,x,c,d] is [a,c,d] (len 3) → +1 (x), -1 (b).
    expect(countLineDiff("a\nb\nc\nd\n", "a\nx\nc\nd\n")).toEqual({ insertions: 1, deletions: 1 });
  });

  it("returns null when the input is too line-dense to diff within the cap", () => {
    // Just over sqrt(MAX_LCS_CELLS) lines on each side → n*m exceeds the cap.
    const lines = Math.floor(Math.sqrt(MAX_LCS_CELLS)) + 10;
    const a = "x\n".repeat(lines);
    const b = "y\n".repeat(lines);
    expect(countLineDiff(a, b)).toBeNull();
  });
});
