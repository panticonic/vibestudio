// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/LexicalTextVisitor.ts — MIT © Petyo Ivanov
import { $isTextNode, TextNode } from 'lexical'
import * as Mdast from 'mdast'
import { MdxJsxTextElement } from 'mdast-util-mdx-jsx'
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
import { LexicalExportVisitor } from '../types'

export function isMdastText(mdastNode: Mdast.Nodes): mdastNode is Mdast.Text {
  return mdastNode.type === 'text'
}

const JOINABLE_TAGS = ['u', 'span', 'sub', 'sup']

export const LexicalTextVisitor: LexicalExportVisitor<TextNode, Mdast.Text> = {
  shouldJoin: (prevNode, currentNode) => {
    // currentNode is declared as Mdast.Text by the interface generic, but at runtime the tree walk
    // can hand us any sibling node type, so widen for the structural checks below.
    const currentNodeWide = currentNode as Mdast.RootContent
    if (['text', 'emphasis', 'strong', 'highlight'].includes(prevNode.type)) {
      return prevNode.type === currentNodeWide.type
    }

    if (
      prevNode.type === 'mdxJsxTextElement' &&
      currentNodeWide.type === 'mdxJsxTextElement' &&
      JOINABLE_TAGS.includes((currentNodeWide as MdxJsxTextElement).name ?? '')
    ) {
      const currentMdxNode = currentNodeWide as MdxJsxTextElement
      return (
        (prevNode as MdxJsxTextElement).name === currentMdxNode.name &&
        JSON.stringify((prevNode as MdxJsxTextElement).attributes) === JSON.stringify(currentMdxNode.attributes)
      )
    }

    return false
  },

  join<T extends Mdast.RootContent>(prevNode: T, currentNode: T): T {
    if (isMdastText(prevNode) && isMdastText(currentNode)) {
      return {
        type: 'text',
        value: prevNode.value + currentNode.value
      } as unknown as T
    } else {
      return {
        ...prevNode,
        children: [...(prevNode as unknown as Mdast.Parent).children, ...(currentNode as unknown as Mdast.Parent).children]
      } as unknown as T
    }
  },

  testLexicalNode: $isTextNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    const previousSibling = lexicalNode.getPreviousSibling()
    const prevFormat = $isTextNode(previousSibling) ? previousSibling.getFormat() : 0
    const textContent = lexicalNode.getTextContent()
    const format = lexicalNode.getFormat()
    const style = lexicalNode.getStyle()

    let localParentNode = mdastParent

    if (style) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'span',
        children: [],
        attributes: [{ type: 'mdxJsxAttribute', name: 'style', value: style }]
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_UNDERLINE) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'u',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_SUPERSCRIPT) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'sup',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_SUBSCRIPT) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'sub',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_ITALIC) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'emphasis',
        children: []
      } as Mdast.Emphasis) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_BOLD) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'strong',
        children: []
      } as Mdast.Strong) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_STRIKETHROUGH) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'delete',
        children: []
      } as Mdast.Delete) as unknown as Mdast.Parent
    }

    if (prevFormat & format & IS_HIGHLIGHT) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'highlight',
        children: []
      } as unknown as Mdast.Parent['children'][number]) as unknown as Mdast.Parent
    }

    if (format & IS_UNDERLINE && !(prevFormat & IS_UNDERLINE)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'u',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (format & IS_SUPERSCRIPT && !(prevFormat & IS_SUPERSCRIPT)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'sup',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (format & IS_SUBSCRIPT && !(prevFormat & IS_SUBSCRIPT)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'sub',
        children: [],
        attributes: []
      } as MdxJsxTextElement) as unknown as Mdast.Parent
    }

    if (format & IS_ITALIC && !(prevFormat & IS_ITALIC)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'emphasis',
        children: []
      } as Mdast.Emphasis) as unknown as Mdast.Parent
    }

    if (format & IS_BOLD && !(prevFormat & IS_BOLD)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'strong',
        children: []
      } as Mdast.Strong) as unknown as Mdast.Parent
    }

    if (format & IS_STRIKETHROUGH && !(prevFormat & IS_STRIKETHROUGH)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'delete',
        children: []
      } as Mdast.Delete) as unknown as Mdast.Parent
    }

    if (format & IS_HIGHLIGHT && !(prevFormat & IS_HIGHLIGHT)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'highlight',
        children: []
      } as unknown as Mdast.Parent['children'][number]) as unknown as Mdast.Parent
    }

    if (format & IS_CODE) {
      actions.appendToParent(localParentNode, {
        type: 'inlineCode',
        value: textContent
      } as Mdast.InlineCode)
      return
    }

    actions.appendToParent(localParentNode, {
      type: 'text',
      value: textContent
    } as Mdast.Text)
  }
}
