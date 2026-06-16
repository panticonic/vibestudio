import { describe, it, expect } from "vitest";
import { computeBlockDiff, resolveSuggestion } from "./blockDiff.js";

describe("computeBlockDiff", () => {
  it("marks inserted and deleted words", () => {
    const segs = computeBlockDiff("hello world", "hello there");
    expect(segs.some((s) => s.type === "equal" && s.value.includes("hello"))).toBe(true);
    expect(segs.some((s) => s.type === "delete" && s.value.includes("world"))).toBe(true);
    expect(segs.some((s) => s.type === "insert" && s.value.includes("there"))).toBe(true);
  });

  it("is all-equal for identical text", () => {
    const segs = computeBlockDiff("same", "same");
    expect(segs.every((s) => s.type === "equal")).toBe(true);
  });
});

describe("resolveSuggestion", () => {
  it("accept takes the scribe text; keep keeps the user text", () => {
    expect(resolveSuggestion("accept", "mine", "theirs")).toBe("theirs");
    expect(resolveSuggestion("keep", "mine", "theirs")).toBe("mine");
  });

  it("merge keeps both for the user to reconcile", () => {
    expect(resolveSuggestion("merge", "mine", "theirs")).toBe("mine\n\ntheirs");
  });
});
