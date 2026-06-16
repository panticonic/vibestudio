// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/LexicalJsxNode.tsx — MIT © Petyo Ivanov
// SEAM CUT: decorate() reads JSX descriptors from DescriptorContext (useDescriptors) instead of the
// gurx cell jsxComponentDescriptors$, and renders descriptor.Editor with the {mdastNode, descriptor}
// JsxEditorProps contract directly (no NestedEditorsContext provider).
import type { EditorConfig, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical'
import { DecoratorNode } from 'lexical'
import React, { JSX } from 'react'
import { voidEmitter } from '../utils/voidEmitter'
import { useDescriptors } from '../descriptor-context'
import type { MdastJsx } from '../jsx-types'
import type { ImportStatement } from '../types'

export type SerializedLexicalJsxNode = Spread<
  {
    mdastNode: MdastJsx
    importStatement: ImportStatement | undefined
    type: 'jsx'
    version: 1
  },
  SerializedLexicalNode
>

/**
 * A lexical node that represents a JSX element. Use {@link $createLexicalJsxNode} to construct one.
 * @group JSX
 */
export class LexicalJsxNode extends DecoratorNode<JSX.Element> {
  /** @internal */
  __mdastNode: MdastJsx
  /** @internal */
  __focusEmitter: ReturnType<typeof voidEmitter> = voidEmitter()
  /** @internal */
  __importStatement?: ImportStatement

  static getType(): string {
    return 'jsx'
  }

  static clone(node: LexicalJsxNode): LexicalJsxNode {
    return new LexicalJsxNode(structuredClone(node.__mdastNode), structuredClone(node.__importStatement), node.__key)
  }

  static importJSON(serializedNode: SerializedLexicalJsxNode): LexicalJsxNode {
    return $createLexicalJsxNode(serializedNode.mdastNode, serializedNode.importStatement)
  }

  constructor(mdastNode: MdastJsx, importStatement?: ImportStatement, key?: NodeKey) {
    super(key)
    this.__mdastNode = mdastNode
    this.__importStatement = importStatement
  }

  getMdastNode(): MdastJsx {
    return this.__mdastNode
  }

  getImportStatement(): ImportStatement | undefined {
    return this.__importStatement
  }

  exportJSON(): SerializedLexicalJsxNode {
    return {
      mdastNode: this.getMdastNode(),
      importStatement: this.getImportStatement(),
      type: 'jsx',
      version: 1
    }
  }

  createDOM(): HTMLElement {
    return document.createElement(this.__mdastNode.type === 'mdxJsxTextElement' ? 'span' : 'div')
  }

  updateDOM(): false {
    return false
  }

  setMdastNode(mdastNode: MdastJsx): void {
    this.getWritable().__mdastNode = mdastNode
  }

  select = (): void => {
    this.__focusEmitter.publish()
  }

  decorate(_parentEditor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <JsxEditorContainer mdastNode={this.getMdastNode()} />
  }

  isInline(): boolean {
    return this.__mdastNode.type === 'mdxJsxTextElement'
  }

  isKeyboardSelectable(): boolean {
    return true
  }
}

const JsxEditorContainer: React.FC<{ mdastNode: MdastJsx }> = (props) => {
  const { mdastNode } = props
  const { jsxComponentDescriptors } = useDescriptors()
  const descriptor =
    jsxComponentDescriptors.find((descriptor) => descriptor.name === mdastNode.name) ??
    jsxComponentDescriptors.find((descriptor) => descriptor.name === '*')
  if (!descriptor) {
    throw new Error(`No JSX descriptor found for ${mdastNode.name ?? '(fragment)'}`)
  }
  const Editor = descriptor.Editor
  return <Editor descriptor={descriptor} mdastNode={mdastNode} />
}

/**
 * Creates a {@link LexicalJsxNode}.
 * @group JSX
 */
export function $createLexicalJsxNode(mdastNode: MdastJsx, importStatement?: ImportStatement): LexicalJsxNode {
  return new LexicalJsxNode(mdastNode, importStatement)
}

/**
 * Returns true if the given node is a {@link LexicalJsxNode}.
 * @group JSX
 */
export function $isLexicalJsxNode(node: LexicalNode | null | undefined): node is LexicalJsxNode {
  return node instanceof LexicalJsxNode
}
