import { describe, it, expect } from "vitest";
import { splitMdxBlocks } from "./parseBlocks.js";

describe("splitMdxBlocks", () => {
  it("splits into top-level blocks whose source slices reconstruct the doc", () => {
    const md = "# Heading\n\nFirst para.\n\nSecond para.\n";
    const blocks = splitMdxBlocks(md);
    expect(blocks.map((b) => b.text)).toEqual(["# Heading", "First para.", "Second para."]);
    for (const b of blocks) expect(md.slice(b.start, b.end)).toBe(b.text);
  });

  it("keeps a fenced code block with internal blank lines as ONE block", () => {
    const md = ["# T", "", "```js", "const a = 1;", "", "const b = 2;", "```", "", "after"].join("\n");
    const blocks = splitMdxBlocks(md);
    const code = blocks.find((b) => b.text.startsWith("```js"));
    expect(code).toBeDefined();
    // The blank line + both statements are inside the single code block.
    expect(code!.text).toContain("const a = 1;");
    expect(code!.text).toContain("const b = 2;");
    expect(blocks.some((b) => b.text === "after")).toBe(true);
    // A naive blank-line split would have produced ≥2 fragments inside the fence.
    expect(blocks.filter((b) => b.text.includes("const"))).toHaveLength(1);
  });

  it("treats YAML frontmatter as its own block", () => {
    const md = "---\ntitle: Demo\n---\n\n# Body\n";
    const blocks = splitMdxBlocks(md);
    expect(blocks[0]!.text).toContain("title: Demo");
    expect(blocks.some((b) => b.text === "# Body")).toBe(true);
  });

  it("keeps a JSX block intact", () => {
    const md = "intro\n\n<Counter count={3} />\n\noutro";
    const blocks = splitMdxBlocks(md);
    expect(blocks.some((b) => b.text.includes("<Counter"))).toBe(true);
  });
});
