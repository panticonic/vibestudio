// New code (not vendored): replicates the markdown-extension + visitor + lexical-node assembly that
// upstream @mdxeditor/editor performs across plugins/core/index.ts and each enabled plugin's index.ts
// (headings, lists, quote, thematic-break, link, codeblock, frontmatter, jsx). The realm/gurx layer is
// dropped; this returns a plain config object. Cross-checked against
// node_modules/@mdxeditor/editor/dist/plugins/core/index.js (markdown-extension wiring).
import type { Klass, LexicalNode } from 'lexical'
import { ParagraphNode, TextNode } from 'lexical'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { ListItemNode, ListNode } from '@lexical/list'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'

// mdast / micromark extensions (same set + order as upstream core + plugin index files)
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { highlightMarkFromMarkdown, highlightMarkToMarkdown } from 'mdast-util-highlight-mark'
import { highlightMark } from 'micromark-extension-highlight-mark'
import { mdxJsxFromMarkdown, mdxJsxToMarkdown } from 'mdast-util-mdx-jsx'
import { mdxJsx } from 'micromark-extension-mdx-jsx'
import { mdxMd } from 'micromark-extension-mdx-md'
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter'
import { frontmatter } from 'micromark-extension-frontmatter'
import { mdxFromMarkdown, mdxToMarkdown } from 'mdast-util-mdx'
import { mdxjs } from 'micromark-extension-mdxjs'

import { comment, commentFromMarkdown } from './mdastUtilHtmlComment'

// node classes
import { GenericHTMLNode } from './nodes/GenericHTMLNode'
import { CodeBlockNode } from './nodes/CodeBlockNode'
import { FrontmatterNode } from './nodes/FrontmatterNode'
import { LexicalJsxNode } from './nodes/LexicalJsxNode'
import { LexicalMdxExpressionNode } from './nodes/LexicalMdxExpressionNode'

// import (mdast -> lexical) visitors
import { MdastRootVisitor } from './visitors/MdastRootVisitor'
import { MdastParagraphVisitor } from './visitors/MdastParagraphVisitor'
import { MdastTextVisitor } from './visitors/MdastTextVisitor'
import { MdastBreakVisitor } from './visitors/MdastBreakVisitor'
import { formattingVisitors } from './visitors/MdastFormattingVisitor'
import { MdastHTMLVisitor } from './visitors/MdastHTMLVisitor'
import { MdastHeadingVisitor } from './visitors/MdastHeadingVisitor'
import { MdastListVisitor } from './visitors/MdastListVisitor'
import { MdastListItemVisitor } from './visitors/MdastListItemVisitor'
import { MdastBlockQuoteVisitor } from './visitors/MdastBlockQuoteVisitor'
import { MdastThematicBreakVisitor } from './visitors/MdastThematicBreakVisitor'
import { MdastLinkVisitor } from './visitors/MdastLinkVisitor'
import { MdastCodeVisitor } from './visitors/MdastCodeVisitor'
import { MdastFrontmatterVisitor } from './visitors/MdastFrontmatterVisitor'
import { MdastMdxJsxElementVisitor } from './visitors/MdastMdxJsxElementVisitor'
import { MdastMdxJsEsmVisitor } from './visitors/MdastMdxJsEsmVisitor'
import { MdastMdxExpressionVisitor } from './visitors/MdastMdxExpressionVisitor'

// export (lexical -> mdast) visitors
import { LexicalRootVisitor } from './visitors/LexicalRootVisitor'
import { LexicalParagraphVisitor } from './visitors/LexicalParagraphVisitor'
import { LexicalTextVisitor } from './visitors/LexicalTextVisitor'
import { LexicalLinebreakVisitor } from './visitors/LexicalLinebreakVisitor'
import { LexicalGenericHTMLVisitor } from './visitors/LexicalGenericHTMLNodeVisitor'
import { LexicalHeadingVisitor } from './visitors/LexicalHeadingVisitor'
import { LexicalListVisitor } from './visitors/LexicalListVisitor'
import { LexicalListItemVisitor } from './visitors/LexicalListItemVisitor'
import { LexicalQuoteVisitor } from './visitors/LexicalQuoteVisitor'
import { LexicalThematicBreakVisitor } from './visitors/LexicalThematicBreakVisitor'
import { LexicalLinkVisitor } from './visitors/LexicalLinkVisitor'
import { CodeBlockVisitor } from './visitors/CodeBlockVisitor'
import { LexicalFrontmatterVisitor } from './visitors/LexicalFrontmatterVisitor'
import { LexicalJsxVisitor } from './visitors/LexicalJsxVisitor'
import { LexicalMdxExpressionVisitor } from './visitors/LexicalMdxExpressionVisitor'

import type { JsxComponentDescriptor } from './jsx-types'
import type {
  LexicalVisitor,
  MdastExtension,
  MdastImportVisitor,
  SyntaxExtension,
  ToMarkdownExtension
} from './types'
import type * as Mdast from 'mdast'

/**
 * The options for {@link assembleMdxConfig}.
 */
export interface AssembleMdxConfigOptions {
  /**
   * JSX component descriptors. A null-named "fragment" descriptor is prepended automatically
   * unless `allowFragment` is false (matching upstream behavior). If you do not pass any
   * descriptors, only the fragment descriptor will be registered.
   */
  jsxComponentDescriptors?: JsxComponentDescriptor[]
  /**
   * Whether to prepend the implicit fragment descriptor (name: null). Defaults to true.
   */
  allowFragment?: boolean
}

/**
 * The assembled markdown processing configuration: the visitor lists, the lexical node classes to
 * register, and the micromark / mdast-util extension lists for parsing and serialization.
 */
export interface AssembledMdxConfig {
  /** mdast -> lexical visitors (import). */
  importVisitors: MdastImportVisitor<Mdast.Nodes>[]
  /** lexical -> mdast visitors (export). */
  exportVisitors: LexicalVisitor[]
  /** The Lexical node classes to register on the editor. */
  lexicalNodes: Klass<LexicalNode>[]
  /** `mdastExtensions` for `fromMarkdown`. */
  mdastExtensions: MdastExtension[]
  /** `extensions` (syntax) for `fromMarkdown`. */
  syntaxExtensions: SyntaxExtension[]
  /** `extensions` for `toMarkdown`. */
  toMarkdownExtensions: ToMarkdownExtension[]
  /** The resolved JSX component descriptors (including the implicit fragment descriptor). */
  jsxComponentDescriptors: JsxComponentDescriptor[]
}

/**
 * Assembles the realm-free markdown<->Lexical processing configuration, replicating the upstream
 * MDXEditor plugin composition for the enabled features (core, headings, lists, quote,
 * thematic-break, link, codeblock, frontmatter, jsx).
 */
export function assembleMdxConfig(opts: AssembleMdxConfigOptions = {}): AssembledMdxConfig {
  // `allowFragment` is accepted for parity with upstream's plugin option. Upstream prepends a
  // fragment descriptor (name: null) backed by a GenericJsxEditor; we do not vendor that editor, so
  // callers that want fragment rendering must supply their own fragment descriptor. The flag is
  // therefore advisory here and the caller-provided descriptors are passed through unchanged.
  void (opts.allowFragment ?? true)
  const jsxComponentDescriptors: JsxComponentDescriptor[] = [...(opts.jsxComponentDescriptors ?? [])]

  const importVisitors: MdastImportVisitor<Mdast.Nodes>[] = [
    // core
    MdastRootVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastParagraphVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastTextVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastBreakVisitor as MdastImportVisitor<Mdast.Nodes>,
    ...formattingVisitors,
    MdastHTMLVisitor as MdastImportVisitor<Mdast.Nodes>,
    // headings
    MdastHeadingVisitor as MdastImportVisitor<Mdast.Nodes>,
    // lists
    MdastListVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastListItemVisitor as MdastImportVisitor<Mdast.Nodes>,
    // quote
    MdastBlockQuoteVisitor as MdastImportVisitor<Mdast.Nodes>,
    // thematic break
    MdastThematicBreakVisitor as MdastImportVisitor<Mdast.Nodes>,
    // link
    MdastLinkVisitor as MdastImportVisitor<Mdast.Nodes>,
    // codeblock
    MdastCodeVisitor as MdastImportVisitor<Mdast.Nodes>,
    // frontmatter
    MdastFrontmatterVisitor as MdastImportVisitor<Mdast.Nodes>,
    // jsx
    MdastMdxJsxElementVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastMdxJsEsmVisitor as MdastImportVisitor<Mdast.Nodes>,
    MdastMdxExpressionVisitor as MdastImportVisitor<Mdast.Nodes>
  ]

  const exportVisitors: LexicalVisitor[] = [
    // core
    LexicalRootVisitor as LexicalVisitor,
    LexicalParagraphVisitor as LexicalVisitor,
    LexicalTextVisitor as LexicalVisitor,
    LexicalLinebreakVisitor as LexicalVisitor,
    LexicalGenericHTMLVisitor as LexicalVisitor,
    // headings
    LexicalHeadingVisitor as LexicalVisitor,
    // lists
    LexicalListVisitor as LexicalVisitor,
    LexicalListItemVisitor as LexicalVisitor,
    // quote
    LexicalQuoteVisitor as LexicalVisitor,
    // thematic break
    LexicalThematicBreakVisitor as LexicalVisitor,
    // link
    LexicalLinkVisitor as LexicalVisitor,
    // codeblock
    CodeBlockVisitor as LexicalVisitor,
    // frontmatter
    LexicalFrontmatterVisitor as LexicalVisitor,
    // jsx
    LexicalJsxVisitor as LexicalVisitor,
    LexicalMdxExpressionVisitor as LexicalVisitor
  ]

  const lexicalNodes: Klass<LexicalNode>[] = [
    // core
    ParagraphNode,
    TextNode,
    GenericHTMLNode,
    // headings
    HeadingNode,
    // quote
    QuoteNode,
    // lists
    ListNode,
    ListItemNode,
    // link
    LinkNode,
    AutoLinkNode,
    // thematic break
    HorizontalRuleNode,
    // codeblock
    CodeBlockNode,
    // frontmatter
    FrontmatterNode,
    // jsx
    LexicalJsxNode,
    LexicalMdxExpressionNode
  ]

  // fromMarkdown mdast extensions (core + lists + frontmatter + jsx)
  const mdastExtensions: MdastExtension[] = [
    // core
    gfmStrikethroughFromMarkdown(),
    highlightMarkFromMarkdown,
    mdxJsxFromMarkdown(),
    commentFromMarkdown({ ast: true }),
    // lists
    gfmTaskListItemFromMarkdown(),
    // frontmatter
    frontmatterFromMarkdown('yaml'),
    // jsx
    mdxFromMarkdown()
  ] as MdastExtension[]

  // fromMarkdown syntax (micromark) extensions
  const syntaxExtensions: SyntaxExtension[] = [
    // core
    gfmStrikethrough(),
    highlightMark(),
    mdxJsx(),
    mdxMd(),
    comment,
    // lists
    gfmTaskListItem(),
    // frontmatter
    frontmatter(),
    // jsx
    mdxjs()
  ] as SyntaxExtension[]

  // toMarkdown extensions
  const toMarkdownExtensions: ToMarkdownExtension[] = [
    // core
    mdxJsxToMarkdown(),
    gfmStrikethroughToMarkdown(),
    highlightMarkToMarkdown,
    // lists
    gfmTaskListItemToMarkdown(),
    // frontmatter
    frontmatterToMarkdown('yaml'),
    // jsx
    mdxToMarkdown()
  ] as ToMarkdownExtension[]

  return {
    importVisitors,
    exportVisitors,
    lexicalNodes,
    mdastExtensions,
    syntaxExtensions,
    toMarkdownExtensions,
    jsxComponentDescriptors
  }
}
