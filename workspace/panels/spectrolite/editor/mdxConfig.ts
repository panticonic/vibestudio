/**
 * Spectrolite's MDX↔Lexical configuration over the vendored
 * `@workspace/mdx-editor-core` pipeline.
 *
 * Two non-obvious requirements of the vendored import path (otherwise it throws
 * `UnrecognizedMarkdownConstructError`):
 *  - a `codeBlockEditorDescriptors` entry whose `match()` is true for every
 *    fenced code block (a catch-all), and
 *  - a JSX descriptor matching each element name, or a `"*"` wildcard, so
 *    arbitrary inline components import.
 * `buildMdxConfig` guarantees both.
 */

import {
  assembleMdxConfig,
  type AssembledMdxConfig,
  type JsxComponentDescriptor,
  type CodeBlockEditorDescriptor,
} from "@workspace/mdx-editor-core";
import type React from "react";

const nullEditor: React.ComponentType<never> = () => null;

export interface MdxConfigOptions {
  /** Known JSX component descriptors (e.g. WikiLink, Eval), each with its Editor. */
  jsxComponentDescriptors?: JsxComponentDescriptor[];
  /** The Editor to render for fenced code blocks. */
  codeBlockEditor?: CodeBlockEditorDescriptor["Editor"];
  /** The Editor for JSX without a specific descriptor (the `"*"` wildcard). */
  jsxFallbackEditor?: JsxComponentDescriptor["Editor"];
}

export interface BuiltMdxConfig {
  assembled: AssembledMdxConfig;
  jsxComponentDescriptors: JsxComponentDescriptor[];
  codeBlockEditorDescriptors: CodeBlockEditorDescriptor[];
}

export function buildMdxConfig(opts: MdxConfigOptions = {}): BuiltMdxConfig {
  const provided = opts.jsxComponentDescriptors ?? [];
  const hasWildcard = provided.some((d) => d.name === "*");
  const jsxComponentDescriptors: JsxComponentDescriptor[] = hasWildcard
    ? provided
    : [
        ...provided,
        {
          name: "*",
          kind: "flow",
          props: [],
          hasChildren: true,
          Editor: opts.jsxFallbackEditor ?? (nullEditor as JsxComponentDescriptor["Editor"]),
        },
      ];
  const assembled = assembleMdxConfig({ jsxComponentDescriptors });
  const codeBlockEditorDescriptors: CodeBlockEditorDescriptor[] = [
    {
      priority: -10,
      match: () => true,
      Editor: opts.codeBlockEditor ?? (nullEditor as CodeBlockEditorDescriptor["Editor"]),
    },
  ];
  return { assembled, jsxComponentDescriptors, codeBlockEditorDescriptors };
}
