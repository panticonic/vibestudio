// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastHTMLNode.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx'

export interface MdastBlockHTMLNode extends MdxJsxFlowElement {
  name: (typeof htmlTags)[number]
}

export interface MdastInlineHTMLNode extends MdxJsxTextElement {
  name: (typeof htmlTags)[number]
}

export type MdastHTMLNode = MdastBlockHTMLNode | MdastInlineHTMLNode

const MDX_NODE_TYPES = ['mdxJsxTextElement', 'mdxJsxFlowElement'] as const

export type MdxNodeType = MdastHTMLNode['type']

export function isMdastHTMLNode(node: Mdast.Nodes): node is MdastHTMLNode {
  return (
    (MDX_NODE_TYPES as readonly string[]).includes(node.type) &&
    htmlTags.includes((node as MdxJsxFlowElement | MdxJsxTextElement).name ?? '')
  )
}

export const htmlTags: string[] = [
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  // 'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr'
]
