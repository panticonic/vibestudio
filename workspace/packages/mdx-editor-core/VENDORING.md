# Vendoring notes

This package vendors the **mdast ↔ Lexical import/export pipeline** and the **custom Lexical node
classes** from [`@mdxeditor/editor`](https://github.com/mdx-editor/editor) **v3.55.0** (matching the
version installed in this repo's `node_modules`).

- **License:** MIT © 2023 Petyo Ivanov (see `LICENSE`, copied verbatim from the upstream package).
- **Source of truth:** `https://github.com/mdx-editor/editor` at tag `v3.55.0`, cross-checked against
  the installed `node_modules/@mdxeditor/editor/dist/` (which mirrors `src/` 1:1).

## What was vendored (upstream → local)

| upstream `src/...` | local `src/...` |
| --- | --- |
| `importMarkdownToLexical.ts` | `importMarkdownToLexical.ts` |
| `exportMarkdownFromLexical.ts` | `exportMarkdownFromLexical.ts` |
| `FormatConstants.ts` | `FormatConstants.ts` |
| `mdastUtilHtmlComment.ts` | `mdastUtilHtmlComment.ts` |
| `utils/mergeStyleAttributes.ts` | `utils/mergeStyleAttributes.ts` |
| `utils/voidEmitter.ts` | `utils/voidEmitter.ts` |
| `utils/fp.ts` (only `noop`) | `utils/fp.ts` |
| visitor interfaces from `importMarkdownToLexical.ts` + `exportMarkdownFromLexical.ts` | `types.ts` |
| descriptor/editor types + `isMdastJsxNode` from `plugins/jsx/index.ts` | `jsx-types.ts` |
| `CodeBlockEditorDescriptor`/`CodeBlockEditorProps` from `plugins/codeblock/index.ts` | `nodes/codeblock-types.ts` |
| `plugins/core/MdastHTMLNode.ts` | `nodes/MdastHTMLNode.ts` |
| `plugins/core/GenericHTMLNode.tsx` | `nodes/GenericHTMLNode.ts` |
| `plugins/codeblock/CodeBlockNode.tsx` | `nodes/CodeBlockNode.tsx` (decorate() rewritten — see seams) |
| `plugins/frontmatter/FrontmatterNode.tsx` | `nodes/FrontmatterNode.tsx` (decorate() rewritten — see seams) |
| `plugins/jsx/LexicalJsxNode.tsx` | `nodes/LexicalJsxNode.tsx` (decorate() rewritten — see seams) |
| `plugins/jsx/LexicalMdxExpressionNode.tsx` | `nodes/LexicalMdxExpressionNode.tsx` (CSS-module imports removed) |
| `plugins/core/MdastRootVisitor.ts` | `visitors/MdastRootVisitor.ts` |
| `plugins/core/MdastParagraphVisitor.ts` | `visitors/MdastParagraphVisitor.ts` |
| `plugins/core/MdastTextVisitor.ts` | `visitors/MdastTextVisitor.ts` |
| `plugins/core/MdastFormattingVisitor.ts` (incl. inline-code visitor) | `visitors/MdastFormattingVisitor.ts` |
| `plugins/core/MdastBreakVisitor.ts` | `visitors/MdastBreakVisitor.ts` |
| `plugins/core/MdastHTMLVisitor.ts` | `visitors/MdastHTMLVisitor.ts` |
| `plugins/core/LexicalGenericHTMLNodeVisitor.ts` | `visitors/LexicalGenericHTMLNodeVisitor.ts` |
| `plugins/core/LexicalRootVisitor.ts` | `visitors/LexicalRootVisitor.ts` |
| `plugins/core/LexicalParagraphVisitor.ts` | `visitors/LexicalParagraphVisitor.ts` |
| `plugins/core/LexicalTextVisitor.ts` | `visitors/LexicalTextVisitor.ts` |
| `plugins/core/LexicalLinebreakVisitor.ts` | `visitors/LexicalLinebreakVisitor.ts` |
| `plugins/headings/MdastHeadingVisitor.ts` | `visitors/MdastHeadingVisitor.ts` |
| `plugins/headings/LexicalHeadingVisitor.ts` | `visitors/LexicalHeadingVisitor.ts` |
| `plugins/lists/MdastListVisitor.ts` | `visitors/MdastListVisitor.ts` |
| `plugins/lists/MdastListItemVisitor.ts` | `visitors/MdastListItemVisitor.ts` |
| `plugins/lists/LexicalListVisitor.ts` | `visitors/LexicalListVisitor.ts` |
| `plugins/lists/LexicalListItemVisitor.ts` | `visitors/LexicalListItemVisitor.ts` |
| `plugins/quote/MdastBlockQuoteVisitor.ts` | `visitors/MdastBlockQuoteVisitor.ts` |
| `plugins/quote/LexicalQuoteVisitor.ts` | `visitors/LexicalQuoteVisitor.ts` |
| `plugins/thematic-break/MdastThematicBreakVisitor.ts` | `visitors/MdastThematicBreakVisitor.ts` |
| `plugins/thematic-break/LexicalThematicBreakVisitor.ts` | `visitors/LexicalThematicBreakVisitor.ts` |
| `plugins/link/MdastLinkVisitor.ts` | `visitors/MdastLinkVisitor.ts` |
| `plugins/link/LexicalLinkVisitor.ts` | `visitors/LexicalLinkVisitor.ts` |
| `plugins/codeblock/MdastCodeVisitor.ts` | `visitors/MdastCodeVisitor.ts` |
| `plugins/codeblock/CodeBlockVisitor.ts` | `visitors/CodeBlockVisitor.ts` |
| `plugins/frontmatter/MdastFrontmatterVisitor.ts` | `visitors/MdastFrontmatterVisitor.ts` |
| `plugins/frontmatter/LexicalFrontmatterVisitor.ts` | `visitors/LexicalFrontmatterVisitor.ts` |
| `plugins/jsx/MdastMdxJsxElementVisitor.ts` | `visitors/MdastMdxJsxElementVisitor.ts` |
| `plugins/jsx/MdastMdxJsEsmVisitor.ts` | `visitors/MdastMdxJsEsmVisitor.ts` |
| `plugins/jsx/MdastMdxExpressionVisitor.ts` | `visitors/MdastMdxExpressionVisitor.ts` |
| `plugins/jsx/LexicalJsxVisitor.ts` | `visitors/LexicalJsxVisitor.ts` |
| `plugins/jsx/LexicalMdxExpressionVisitor.ts` | `visitors/LexicalMdxExpressionVisitor.ts` |
| `plugins/jsx/jsxTagName.ts` | `visitors/jsxTagName.ts` |

## New (non-vendored) code

- `assembleConfig.ts` — replicates the per-plugin markdown-extension + visitor + node composition
  that upstream performs through its realm/plugin system. Cross-checked against
  `dist/plugins/core/index.js` for the exact extension wiring.
- `descriptor-context.tsx` — a React context (`DescriptorProvider` / `useDescriptors`) that replaces
  the gurx cells the decorator nodes read from.
- `index.ts` — the public barrel.

## Seams cut (gurx / realm / toolbar / UI)

- All `plugins/*/index.ts`, `plugins/core/index.ts`, `RealmWithPlugins`, `MDXEditor.tsx`, and every
  toolbar / dialog / codemirror / sandpack / diff-source / search / markdown-shortcut /
  nested-editor / PropertyPopover file were **not** vendored.
- `table`, `image`, and `directive` plugins were **not** vendored.
- `CodeBlockNode.decorate()` no longer reads gurx cells; it renders a minimal `<pre><code>` fallback
  editor (a controlled textarea). No CodeMirror dependency.
- `LexicalJsxNode.decorate()` reads JSX descriptors from `DescriptorContext` (`useDescriptors`)
  instead of the gurx `jsxComponentDescriptors$` cell, and renders `descriptor.Editor` with the
  `{ mdastNode, descriptor }` `JsxEditorProps` contract (no `NestedEditorsContext`).
- `FrontmatterNode.decorate()` renders a minimal fallback editor instead of the upstream
  `FrontmatterEditor`.
- `LexicalMdxExpressionNode` CSS-module imports were replaced with plain className strings.

## Dependency note

`mdast-util-highlight-mark` / `micromark-extension-highlight-mark` are included because upstream's
core extension assembly wires highlight (`==mark==`) support, and the vendored highlight visitor
relies on them. They are present/hoisted in the repo's `node_modules`.
