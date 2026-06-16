// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastFormattingVisitor.ts — MIT © Petyo Ivanov
import {
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE
} from '../FormatConstants'
import { $createTextNode } from 'lexical'
import * as Mdast from 'mdast'
import { MdxJsxTextElement } from 'mdast-util-mdx-jsx'
import { MdastImportVisitor } from '../types'
import { FORMAT } from '../FormatConstants'

function buildFormattingVisitors(
  tag: string,
  format: FORMAT
): [MdastImportVisitor<MdxJsxTextElement>, MdastImportVisitor<Mdast.Html>, MdastImportVisitor<Mdast.Html>] {
  return [
    {
      testNode: (node) => node.type === 'mdxJsxTextElement' && (node as MdxJsxTextElement).name === tag,
      visitNode({ actions, mdastNode, lexicalParent }) {
        actions.addFormatting(format)
        actions.visitChildren(mdastNode as MdxJsxTextElement, lexicalParent)
      }
    },
    {
      testNode: (node) => node.type === 'html' && (node as Mdast.Html).value === `<${tag}>`,
      visitNode({ actions, mdastParent }) {
        actions.addFormatting(format, mdastParent)
      }
    },
    {
      testNode: (node) => node.type === 'html' && (node as Mdast.Html).value === `</${tag}>`,
      visitNode({ actions, mdastParent }) {
        actions.removeFormatting(format, mdastParent)
      }
    }
  ]
}

const StrikeThroughVisitor: MdastImportVisitor<Mdast.Delete> = {
  testNode: 'delete',
  visitNode({ mdastNode, actions, lexicalParent }) {
    actions.addFormatting(IS_STRIKETHROUGH)
    actions.visitChildren(mdastNode, lexicalParent)
  }
}

const HighlightVisitor: MdastImportVisitor<Mdast.Nodes> = {
  testNode: 'highlight',
  visitNode({ mdastNode, actions, lexicalParent }) {
    actions.addFormatting(IS_HIGHLIGHT)
    actions.visitChildren(mdastNode as Mdast.Parent, lexicalParent)
  }
}

/**
 * Handles `inlineCode` mdast nodes (the upstream `MdCodeVisitor`).
 * @group Markdown Processing
 */
export const MdastInlineCodeVisitor: MdastImportVisitor<Mdast.InlineCode> = {
  testNode: 'inlineCode',
  visitNode({ mdastNode, actions }) {
    actions.addAndStepInto($createTextNode(mdastNode.value).setFormat(actions.getParentFormatting() | IS_CODE))
  }
}

const MdEmphasisVisitor: MdastImportVisitor<Mdast.Emphasis> = {
  testNode: 'emphasis',
  visitNode({ mdastNode, actions, lexicalParent }) {
    actions.addFormatting(IS_ITALIC)
    actions.visitChildren(mdastNode, lexicalParent)
  }
}

const MdStrongVisitor: MdastImportVisitor<Mdast.Strong> = {
  testNode: 'strong',
  visitNode({ mdastNode, actions, lexicalParent }) {
    actions.addFormatting(IS_BOLD)
    actions.visitChildren(mdastNode, lexicalParent)
  }
}

export const formattingVisitors: MdastImportVisitor<Mdast.Nodes>[] = [
  // emphasis
  MdEmphasisVisitor as MdastImportVisitor<Mdast.Nodes>,
  // strong
  MdStrongVisitor as MdastImportVisitor<Mdast.Nodes>,
  // underline
  ...(buildFormattingVisitors('u', IS_UNDERLINE) as MdastImportVisitor<Mdast.Nodes>[]),
  // code
  ...(buildFormattingVisitors('code', IS_CODE) as MdastImportVisitor<Mdast.Nodes>[]),
  MdastInlineCodeVisitor as MdastImportVisitor<Mdast.Nodes>,
  // strikethrough
  StrikeThroughVisitor as MdastImportVisitor<Mdast.Nodes>,
  // highlight
  HighlightVisitor,
  // superscript
  ...(buildFormattingVisitors('sup', IS_SUPERSCRIPT) as MdastImportVisitor<Mdast.Nodes>[]),
  // subscript
  ...(buildFormattingVisitors('sub', IS_SUBSCRIPT) as MdastImportVisitor<Mdast.Nodes>[])
]
