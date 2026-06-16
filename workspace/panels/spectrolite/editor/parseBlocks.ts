/**
 * mdast-based top-level block splitter.
 *
 * The co-edit classifier reconciles incoming canonical text against the editor's
 * blocks; both must agree on what a "block" is. A block = a top-level mdast node,
 * and `node.position` (byte offsets, threaded by `mdast-util-from-markdown`)
 * gives its EXACT source range — so a fenced code block with internal blank
 * lines, or YAML frontmatter, stays a single block (unlike a naive blank-line
 * split). The block's source slice IS its canonical text — no re-serialization.
 *
 * Uses the same micromark/mdast extensions the vendored import path uses, so the
 * segmentation matches the editor's mdast model exactly.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { assembleMdxConfig } from "@workspace/mdx-editor-core";
import type { Block } from "../coedit/blockReconcile.js";

type ParseExtensions = {
  syntax: Parameters<typeof fromMarkdown>[1] extends infer O
    ? O extends { extensions?: infer E }
      ? E
      : never
    : never;
  mdast: Parameters<typeof fromMarkdown>[1] extends infer O
    ? O extends { mdastExtensions?: infer E }
      ? E
      : never
    : never;
};

let cached: ParseExtensions | null = null;
function extensions(): ParseExtensions {
  if (!cached) {
    const config = assembleMdxConfig();
    cached = {
      syntax: config.syntaxExtensions as ParseExtensions["syntax"],
      mdast: config.mdastExtensions as ParseExtensions["mdast"],
    };
  }
  return cached;
}

/**
 * Split markdown into top-level blocks with exact source ranges. `idPrefix`
 * lets callers tag incoming-vs-current blocks distinctly (alignment is by
 * signature, not id, so the prefix only aids debugging).
 */
export function splitMdxBlocks(markdown: string, idPrefix = "inc"): Block[] {
  const { syntax, mdast } = extensions();
  const tree = fromMarkdown(markdown, { extensions: syntax, mdastExtensions: mdast });
  const blocks: Block[] = [];
  tree.children.forEach((node, index) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return;
    const text = markdown.slice(start, end);
    blocks.push({ id: `${idPrefix}:${index}`, signature: text, text, start, end });
  });
  return blocks;
}
