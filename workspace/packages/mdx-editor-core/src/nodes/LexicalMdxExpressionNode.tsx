// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/LexicalMdxExpressionNode.tsx — MIT © Petyo Ivanov
// SEAM CUT: CSS-module imports (lexical-theme.module.css, ui.module.css) replaced with plain className strings.
import { JSX } from 'react'
import {
  $applyNodeReplacement,
  DOMConversionMap,
  DOMExportOutput,
  DecoratorNode,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread
} from 'lexical'
import { MdxFlowExpression, MdxTextExpression } from 'mdast-util-mdx'

type MdxExpressionType = MdxTextExpression['type'] | MdxFlowExpression['type']

export type SerializedLexicalMdxExpressionNode = Spread<
  {
    type: 'mdx-expression'
    mdastType: MdxExpressionType
    value: string
    version: 1
  },
  SerializedLexicalNode
>

/**
 * A lexical node that represents an MDX expression (`{...}`). Use {@link $createLexicalMdxExpressionNode} to construct one.
 * @group JSX
 */
export class LexicalMdxExpressionNode extends DecoratorNode<JSX.Element> {
  /** @internal */
  __value: string
  /** @internal */
  __mdastType: MdxExpressionType

  /**
   * Constructs a new {@link LexicalMdxExpressionNode} with the specified MDAST expression value.
   */
  constructor(value: string, mdastType: MdxExpressionType, key?: NodeKey) {
    super(key)
    this.__value = value
    this.__mdastType = mdastType
  }

  /** @internal */
  static getType(): string {
    return 'mdx-expression'
  }

  /** @internal */
  static clone(node: LexicalMdxExpressionNode): LexicalMdxExpressionNode {
    return new LexicalMdxExpressionNode(node.__value, node.__mdastType, node.__key)
  }

  getValue(): string {
    return this.__value
  }

  getMdastType(): MdxExpressionType {
    return this.__mdastType
  }

  // View
  createDOM(): HTMLElement {
    const element = document.createElement('span')
    element.classList.add('mdx-expression')
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

  static importJSON(serializedNode: SerializedLexicalMdxExpressionNode): LexicalMdxExpressionNode {
    return $createLexicalMdxExpressionNode(serializedNode.value, serializedNode.mdastType)
  }

  exportJSON(): SerializedLexicalMdxExpressionNode {
    return {
      ...super.exportJSON(),
      value: this.getValue(),
      mdastType: this.getMdastType(),
      type: 'mdx-expression',
      version: 1
    }
  }

  extractWithChild(): boolean {
    return true
  }

  isInline(): boolean {
    return this.__mdastType === 'mdxTextExpression'
  }

  decorate(editor: LexicalEditor): JSX.Element {
    return (
      <>
        {'{'}
        <span className="mdx-expression-input-sizer" data-value={this.getValue()}>
          <input
            size={1}
            onKeyDown={(e) => {
              const value = (e.target as HTMLInputElement).value
              if ((value === '' && e.key === 'Backspace') || e.key === 'Delete') {
                e.stopPropagation()
                e.nativeEvent.stopImmediatePropagation()
                e.preventDefault()
                editor.update(() => {
                  this.selectPrevious()
                  this.remove()
                })
              }
            }}
            onChange={(e) => {
              const parent = (e.target as HTMLInputElement).parentElement
              if (parent) {
                parent.dataset['value'] = e.target.value
              }
              editor.update(() => {
                this.getWritable().__value = e.target.value
              })
            }}
            type="text"
            value={this.getValue()}
          />
        </span>
        {'}'}
      </>
    )
  }
}

/**
 * Creates a {@link LexicalMdxExpressionNode}.
 * @group JSX
 */
export function $createLexicalMdxExpressionNode(value: string, type: MdxExpressionType): LexicalMdxExpressionNode {
  return $applyNodeReplacement(new LexicalMdxExpressionNode(value, type))
}

/**
 * Returns true if the given node is a {@link LexicalMdxExpressionNode}.
 * @group JSX
 */
export function $isLexicalMdxExpressionNode(node: LexicalNode | null | undefined): node is LexicalMdxExpressionNode {
  return node instanceof LexicalMdxExpressionNode
}
