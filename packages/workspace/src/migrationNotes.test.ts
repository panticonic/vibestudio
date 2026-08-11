import { describe, expect, it } from "vitest";
import {
  migrationFacetsForRepoPaths,
  parseMigrationNote,
  summarizeMigrationNote,
} from "./migrationNotes.js";

const note = `---
degraded-ok: false
verify: |
  pnpm type-check
---

# Current contract

Ensure the workspace uses the current service shape.
`;

describe("migration notes", () => {
  it("parses the small contract without assigning a note identity", () => {
    const parsed = parseMigrationNote("migrations/system/service-shape.md", note);
    expect(parsed).toMatchObject({
      facet: "system",
      degradedOk: false,
      verify: "pnpm type-check",
      body: expect.stringContaining("Current contract"),
    });
    expect(summarizeMigrationNote(parsed)).toEqual({
      path: "migrations/system/service-shape.md",
      title: "Current contract",
      degradedOk: false,
    });
  });

  it("rejects authority-like metadata outside the convention", () => {
    expect(() =>
      parseMigrationNote(
        "migrations/news/state.md",
        note.replace("verify: |", "severity: routine\nverify: |")
      )
    ).toThrow("unknown frontmatter field: severity");
  });

  it("derives facets only from migration repository paths", () => {
    expect(
      migrationFacetsForRepoPaths([
        "panels/news",
        "migrations/news",
        "migrations/system",
        "migrations/news",
      ])
    ).toEqual(["news", "system"]);
  });
});
