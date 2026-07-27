import { describe, expect, it } from "vitest";
import { buildCollectionDebugPrompt, pruneNotes, withMemberNote } from "./collection";

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

describe("buildCollectionDebugPrompt", () => {
  const members = [
    { id: "p1", title: "Gmail", source: "https://mail.google.com/", note: "slow to load" },
    { id: "p2", title: "Trello", source: "https://trello.com/b/x" },
  ];

  it("lists every member when unscoped", () => {
    const prompt = buildCollectionDebugPrompt({ title: "Window 1", members });
    expect(prompt).toContain("Window 1");
    expect(prompt).toContain("panelId: p1");
    expect(prompt).toContain("panelId: p2");
    expect(prompt).toContain("user note: slow to load");
  });

  it("narrows to a single member when focused", () => {
    const prompt = buildCollectionDebugPrompt({ title: "Window 1", members, focusId: "p2" });
    expect(prompt).toContain("panelId: p2");
    expect(prompt).not.toContain("panelId: p1");
    expect(prompt).toContain("debugging one panel");
  });

  it("includes collection notes and origin when present", () => {
    const prompt = buildCollectionDebugPrompt({
      title: "Research",
      note: "figuring out\nwhy tabs pile up",
      origin: "Firefox · Window 2",
      members,
    });
    expect(prompt).toContain("Collection origin: Firefox · Window 2");
    expect(prompt).toContain("> figuring out");
    expect(prompt).toContain("> why tabs pile up");
  });

  it("says so when the collection is empty", () => {
    const prompt = buildCollectionDebugPrompt({ title: "Empty", members: [] });
    expect(prompt).toContain("the collection is currently empty");
  });
});
