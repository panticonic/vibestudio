import { describe, expect, it } from "vitest";
import { diffDependencies, parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses title and string dependency references", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "title: Demo",
        "dependencies:",
        "  react: npm:^19",
        "  ignored: 3",
        "---",
        "",
        "# Body",
      ].join("\n")
    );
    expect(parsed.title).toBe("Demo");
    expect(parsed.dependencies).toEqual({ react: "npm:^19" });
  });

  it("returns an empty authored surface for malformed YAML", () => {
    expect(parseFrontmatter("---\ntitle: [bad\n---\n\nBody")).toMatchObject({
      title: null,
      dependencies: {},
    });
  });
});

describe("diffDependencies", () => {
  it("separates added, changed, and removed references", () => {
    expect(
      diffDependencies(
        { keep: "1", change: "1", remove: "1" },
        { keep: "1", change: "2", add: "1" }
      )
    ).toEqual({ added: { add: "1" }, changed: { change: "2" }, removed: ["remove"] });
  });
});
