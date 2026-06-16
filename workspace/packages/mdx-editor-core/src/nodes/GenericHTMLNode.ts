// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/GenericHTMLNode.tsx — MIT © Petyo Ivanov
import {
  $applyNodeReplacement,
  DOMConversionMap,
  DOMExportOutput,
  ElementNode,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread
} from 'lexical'
import { MdxJsxAttribute, MdxJsxExpressionAttribute } from 'mdast-util-mdx-jsx'
import { MdxNodeType, htmlTags } from './MdastHTMLNode'

/**
 * A known HTML tag (e.g. 'div', 'span').
 * @group HTML
 */
export type KnownHTMLTagType = (typeof htmlTags)[number]

/**
 * The attribute shape carried by a {@link GenericHTMLNode}. mdast jsx nodes may carry either named
 * attributes or expression attributes, so both are accepted (upstream narrows to MdxJsxAttribute[]).
 */
export type GenericHTMLNodeAttribute = MdxJsxAttribute | MdxJsxExpressionAttribute

export const TYPE_NAME = 'generic-html' as const

export type SerializedGenericHTMLNode = Spread<
  {
    tag: KnownHTMLTagType
    type: 'generic-html'
    mdxType: MdxNodeType
    attributes: GenericHTMLNodeAttribute[]
    version: 1
  },
  SerializedElementNode
>

/**
 * A lexical node that represents a generic HTML element. Use {@link $createGenericHTMLNode} to construct one.
 * @group HTML
 */
export class GenericHTMLNode extends ElementNode {
  /** @internal */
  __tag: KnownHTMLTagType
  /** @internal */
  __nodeType: MdxNodeType
  /** @internal */
  __attributes: GenericHTMLNodeAttribute[]

  /**
   * Constructs a new {@link GenericHTMLNode} with the specified MDAST HTML node as the object to edit.
   */
  constructor(tag: KnownHTMLTagType, type: MdxNodeType, attributes: GenericHTMLNodeAttribute[], key?: NodeKey) {
    super(key)
    this.__tag = tag
    this.__nodeType = type
    this.__attributes = attributes
  }

  /** @internal */
  static getType(): string {
    return TYPE_NAME
  }

  /** @internal */
  static clone(node: GenericHTMLNode): GenericHTMLNode {
    return new GenericHTMLNode(node.__tag, node.__nodeType, node.__attributes, node.__key)
  }

  getTag(): KnownHTMLTagType {
    return this.__tag
  }

  getNodeType(): MdxNodeType {
    return this.__nodeType
  }

  getAttributes(): GenericHTMLNodeAttribute[] {
    return this.__attributes
  }

  updateAttributes(attributes: GenericHTMLNodeAttribute[]): void {
    const self = this.getWritable()
    self.__attributes = attributes
  }

  getStyle(): string {
    const styleAttr = this.__attributes.find(
      (attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === 'style'
    )
    return (styleAttr && styleAttr.type === 'mdxJsxAttribute' ? (styleAttr.value as string | undefined) : undefined) ?? ''
  }

  // View
  createDOM(): HTMLElement {
    const tag = this.__tag
    const element = document.createElement(tag)
    this.__attributes.forEach((attribute) => {
      if (attribute.type === 'mdxJsxAttribute' && typeof attribute.value === 'string') {
        element.setAttribute(attribute.name, attribute.value)
      }
    })
    return element
  }

  updateDOM(): false {
    return false
  }

  static importDOM(): DOMConversionMap | null {
    return {}
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const { element } = super.exportDOM(editor)
    return {
      element
    }
  }

  static importJSON(serializedNode: SerializedGenericHTMLNode): GenericHTMLNode {
    const node = $createGenericHTMLNode(serializedNode.tag, serializedNode.mdxType, serializedNode.attributes)
    node.setFormat(serializedNode.format)
    node.setIndent(serializedNode.indent)
    node.setDirection(serializedNode.direction)
    return node
  }

  exportJSON(): SerializedGenericHTMLNode {
    return {
      ...super.exportJSON(),
      tag: this.getTag(),
      attributes: this.__attributes,
      mdxType: this.__nodeType,
      type: TYPE_NAME,
      version: 1
    }
  }

  extractWithChild(): boolean {
    return true
  }

  isInline(): boolean {
    return this.__nodeType === 'mdxJsxTextElement'
  }
}

/**
 * Creates a {@link GenericHTMLNode}.
 * @group HTML
 */
export function $createGenericHTMLNode(
  tag: KnownHTMLTagType,
  type: MdxNodeType,
  attributes: GenericHTMLNodeAttribute[]
): GenericHTMLNode {
  return $applyNodeReplacement(new GenericHTMLNode(tag, type, attributes))
}

/**
 * Returns true if the given node is a {@link GenericHTMLNode}.
 * @group HTML
 */
export function $isGenericHTMLNode(node: LexicalNode | null | undefined): node is GenericHTMLNode {
  return node instanceof GenericHTMLNode
}
