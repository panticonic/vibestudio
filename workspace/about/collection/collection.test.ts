import { describe, expect, it } from "vitest";
import { pruneNotes, withMemberNote } from "./collection";

describe("withMemberNote", () => {
  it("adds and updates a note", () => {
    expect(withMemberNote(undefined, "p1", "look here")).toEqual({ p1: "look here" });
    expect(withMemberNote({ p1: "old" }, "p1", "new")).toEqual({ p1: "new" });
  });
  it("drops a note cleared to whitespace", () => {
    expect(withMemberNote({ p1: "old", p2: "keep" }, "p1", "   ")).toEqual({ p2: "keep" });
  });
  it("does not mutate the input", () => {
    const notes = { p1: "old" };
    withMemberNote(notes, "p2", "added");
    expect(notes).toEqual({ p1: "old" });
  });
});

describe("pruneNotes", () => {
  it("keeps only notes for current members", () => {
    expect(pruneNotes({ p1: "a", p2: "b" }, ["p2"])).toEqual({ p2: "b" });
  });
  it("handles no notes", () => {
    expect(pruneNotes(undefined, ["p1"])).toEqual({});
  });
});
