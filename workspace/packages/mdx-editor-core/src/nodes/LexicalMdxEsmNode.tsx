import { useEffect, useState, type JSX } from 'react'
import {
  $applyNodeReplacement,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'

export type SerializedLexicalMdxEsmNode = Spread<
  {
    type: 'mdx-esm'
    value: string
    version: 1
  },
  SerializedLexicalNode
>

/** Lossless, directly editable representation of a top-level MDX ESM block. */
export class LexicalMdxEsmNode extends DecoratorNode<JSX.Element> {
  __value: string

  static getType(): string {
    return 'mdx-esm'
  }

  static clone(node: LexicalMdxEsmNode): LexicalMdxEsmNode {
    return new LexicalMdxEsmNode(node.__value, node.__key)
  }

  static importJSON(serializedNode: SerializedLexicalMdxEsmNode): LexicalMdxEsmNode {
    return $createLexicalMdxEsmNode(serializedNode.value)
  }

  constructor(value: string, key?: NodeKey) {
    super(key)
    this.__value = value
  }

  getValue(): string {
    return this.__value
  }

  setValue(value: string): void {
    this.getWritable().__value = value
  }

  exportJSON(): SerializedLexicalMdxEsmNode {
    return { ...super.exportJSON(), type: 'mdx-esm', value: this.getValue(), version: 1 }
  }

  createDOM(): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  isInline(): false {
    return false
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  decorate(editor: LexicalEditor): JSX.Element {
    return <MdxEsmEditor node={this} editor={editor} />
  }
}

function MdxEsmEditor({ node, editor }: { node: LexicalMdxEsmNode; editor: LexicalEditor }) {
  const source = node.getValue()
  const [draft, setDraft] = useState(source)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(source)
  }, [editing, source])

  return (
    <details className="mdx-esm-block" open={editing}>
      <summary
        onClick={(event) => {
          event.preventDefault()
          setEditing((value) => !value)
        }}
      >
        MDX module source
      </summary>
      {editing ? (
        <>
          <textarea
            aria-label="MDX module source"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="mdx-esm-actions">
            <button type="button" onClick={() => { setDraft(source); setEditing(false) }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                editor.update(() => node.setValue(draft))
                setEditing(false)
              }}
            >
              Apply source
            </button>
          </div>
        </>
      ) : null}
    </details>
  )
}

export function $createLexicalMdxEsmNode(value: string): LexicalMdxEsmNode {
  return $applyNodeReplacement(new LexicalMdxEsmNode(value))
}

export function $isLexicalMdxEsmNode(
  node: LexicalNode | null | undefined
): node is LexicalMdxEsmNode {
  return node instanceof LexicalMdxEsmNode
}
