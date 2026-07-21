// Public API of @workspace/mdx-editor-core
// A realm-free vendor of MDXEditor's mdast<->Lexical import/export pipeline + custom Lexical nodes.
// Vendored from @mdxeditor/editor v3.55.0 — MIT © Petyo Ivanov. See VENDORING.md.

// --- Entry points: markdown <-> lexical ---
export {
  importMarkdownToLexical,
  importMdastTreeToLexical,
  MarkdownParseError,
  UnrecognizedMarkdownConstructError
} from './importMarkdownToLexical'
export { exportLexicalTreeToMdast, exportMarkdownFromLexical } from './exportMarkdownFromLexical'

// --- Config assembly ---
export { assembleMdxConfig } from './assembleConfig'
export type { AssembleMdxConfigOptions, AssembledMdxConfig } from './assembleConfig'

// --- Format constants ---
export {
  DEFAULT_FORMAT,
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE
} from './FormatConstants'
export type { FORMAT } from './FormatConstants'

// --- Visitor / descriptor / option types ---
export type {
  Descriptors,
  DirectiveDescriptor,
  ExportLexicalTreeOptions,
  ExportMarkdownFromLexicalOptions,
  ImportPoint,
  ImportStatement,
  LexicalExportVisitor,
  LexicalVisitor,
  MarkdownParseOptions,
  MdastExtension,
  MdastExtensions,
  MdastImportVisitor,
  MdastTreeImportOptions,
  MetaData,
  SyntaxExtension,
  ToMarkdownExtension,
  ToMarkdownOptions
} from './types'

// --- JSX types + guard ---
export { isMdastJsxNode } from './jsx-types'
export type { JsxComponentDescriptor, JsxEditorProps, JsxPropertyDescriptor, MdastJsx } from './jsx-types'

// --- Code block descriptor types ---
export type { CodeBlockEditorDescriptor, CodeBlockEditorProps } from './nodes/codeblock-types'

// --- Descriptor React context (replaces gurx cells for the decorator nodes) ---
export { DescriptorProvider, useDescriptors } from './descriptor-context'
export type {
  DescriptorContextValue,
  FrontmatterEditorProps,
  FrontmatterEditorComponent
} from './descriptor-context'

// --- Utilities ---
export { voidEmitter } from './utils/voidEmitter'
export type { VoidEmitter } from './utils/voidEmitter'
export { mergeStyleAttributes } from './utils/mergeStyleAttributes'
export { noop } from './utils/fp'

// --- Node classes + $create/$is helpers ---
export {
  $createGenericHTMLNode,
  $isGenericHTMLNode,
  GenericHTMLNode,
  TYPE_NAME as GENERIC_HTML_TYPE_NAME
} from './nodes/GenericHTMLNode'
export type { KnownHTMLTagType, SerializedGenericHTMLNode } from './nodes/GenericHTMLNode'

export {
  $convertPreElement,
  $createCodeBlockNode,
  $isCodeBlockNode,
  CodeBlockNode,
  useCodeBlockEditorContext
} from './nodes/CodeBlockNode'
export type { CreateCodeBlockNodeOptions, SerializedCodeBlockNode } from './nodes/CodeBlockNode'

export { $createFrontmatterNode, $isFrontmatterNode, FrontmatterNode } from './nodes/FrontmatterNode'
export type { SerializedFrontmatterNode } from './nodes/FrontmatterNode'

export { $createLexicalJsxNode, $isLexicalJsxNode, LexicalJsxNode } from './nodes/LexicalJsxNode'
export type { SerializedLexicalJsxNode } from './nodes/LexicalJsxNode'

export {
  $createLexicalMdxExpressionNode,
  $isLexicalMdxExpressionNode,
  LexicalMdxExpressionNode
} from './nodes/LexicalMdxExpressionNode'
export type { SerializedLexicalMdxExpressionNode } from './nodes/LexicalMdxExpressionNode'

// --- mdast HTML node helpers ---
export { htmlTags, isMdastHTMLNode } from './nodes/MdastHTMLNode'
export type { MdastBlockHTMLNode, MdastHTMLNode, MdastInlineHTMLNode, MdxNodeType } from './nodes/MdastHTMLNode'

// --- Individual visitors (import: mdast -> lexical) ---
export { MdastRootVisitor } from './visitors/MdastRootVisitor'
export { MdastParagraphVisitor } from './visitors/MdastParagraphVisitor'
export { MdastTextVisitor } from './visitors/MdastTextVisitor'
export { MdastBreakVisitor } from './visitors/MdastBreakVisitor'
export { formattingVisitors, MdastInlineCodeVisitor } from './visitors/MdastFormattingVisitor'
export { MdastHTMLVisitor } from './visitors/MdastHTMLVisitor'
export { MdastHeadingVisitor } from './visitors/MdastHeadingVisitor'
export { MdastListVisitor } from './visitors/MdastListVisitor'
export { MdastListItemVisitor } from './visitors/MdastListItemVisitor'
export { MdastBlockQuoteVisitor } from './visitors/MdastBlockQuoteVisitor'
export { MdastThematicBreakVisitor } from './visitors/MdastThematicBreakVisitor'
export { MdastLinkVisitor } from './visitors/MdastLinkVisitor'
export { MdastCodeVisitor } from './visitors/MdastCodeVisitor'
export { MdastFrontmatterVisitor } from './visitors/MdastFrontmatterVisitor'
export { MdastMdxJsxElementVisitor } from './visitors/MdastMdxJsxElementVisitor'
export { MdastMdxJsEsmVisitor } from './visitors/MdastMdxJsEsmVisitor'
export { MdastMdxExpressionVisitor } from './visitors/MdastMdxExpressionVisitor'

// --- Individual visitors (export: lexical -> mdast) ---
export { LexicalRootVisitor } from './visitors/LexicalRootVisitor'
export { LexicalParagraphVisitor } from './visitors/LexicalParagraphVisitor'
export { LexicalTextVisitor, isMdastText } from './visitors/LexicalTextVisitor'
export { LexicalLinebreakVisitor } from './visitors/LexicalLinebreakVisitor'
export { LexicalGenericHTMLVisitor } from './visitors/LexicalGenericHTMLNodeVisitor'
export { LexicalHeadingVisitor } from './visitors/LexicalHeadingVisitor'
export { LexicalListVisitor } from './visitors/LexicalListVisitor'
export { LexicalListItemVisitor } from './visitors/LexicalListItemVisitor'
export { LexicalQuoteVisitor } from './visitors/LexicalQuoteVisitor'
export { LexicalThematicBreakVisitor } from './visitors/LexicalThematicBreakVisitor'
export { LexicalLinkVisitor } from './visitors/LexicalLinkVisitor'
export { CodeBlockVisitor } from './visitors/CodeBlockVisitor'
export { LexicalFrontmatterVisitor } from './visitors/LexicalFrontmatterVisitor'
export { LexicalJsxVisitor } from './visitors/LexicalJsxVisitor'
export { LexicalMdxExpressionVisitor } from './visitors/LexicalMdxExpressionVisitor'

// --- JSX tag helper ---
export { isHtmlTagName } from './visitors/jsxTagName'
