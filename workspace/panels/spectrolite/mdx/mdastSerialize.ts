/**
 * mdast → MDX source serialization.
 *
 * Used by `LiveJsxEditor` to reconstruct the JSX source from MDXEditor's
 * mdast representation of a JSX node, including all nested content
 * (paragraphs, lists, nested JSX, etc.) — not just text children.
 *
 * Built on the unified ecosystem's `mdast-util-to-markdown` with the
 * `mdast-util-mdx-jsx` extension, which is what MDXEditor and `@mdx-js/mdx`
 * use internally for JSX serialization, so round-trip fidelity is high.
 */

import { toMarkdown } from "mdast-util-to-markdown";
import { mdxJsxToMarkdown } from "mdast-util-mdx-jsx";
import type { Root, RootContent } from "mdast";

const extensions = [mdxJsxToMarkdown()];

/** Serialize a single mdast node to its markdown / MDX source. */
export function nodeToMdxSource(node: unknown): string {
  // toMarkdown accepts a single Node, treating it as a one-node Root.
  // The mdx-jsx extension handles mdxJsxFlowElement and mdxJsxTextElement.
  try {
    const rendered = toMarkdown(node as Root, { extensions });
    return rendered.replace(/\n$/, "");
  } catch (err) {
    console.warn("[Spectrolite] nodeToMdxSource failed:", err);
    return "";
  }
}

/** Serialize a list of mdast nodes as an MDX fragment (joined by their
 *  natural separators per `toMarkdown`). */
export function nodesToMdxSource(nodes: RootContent[]): string {
  if (nodes.length === 0) return "";
  const root: Root = { type: "root", children: nodes };
  try {
    return toMarkdown(root, { extensions }).replace(/\n$/, "");
  } catch (err) {
    console.warn("[Spectrolite] nodesToMdxSource failed:", err);
    return "";
  }
}
