// vendored from @mdxeditor/editor v3.55.0 src/plugins/frontmatter/FrontmatterNode.tsx — MIT © Petyo Ivanov
// SEAM CUT: decorate() delegates to a host that resolves a consumer-provided frontmatter editor
// from the descriptor context (falling back to a bare textarea), instead of the upstream
// FrontmatterEditor (which depends on react-hook-form / gurx / CSS modules).
import { $getNodeByKey, DecoratorNode, EditorConfig, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical'
import React, { JSX } from 'react'
import { useDescriptors } from '../descriptor-context'

export type SerializedFrontmatterNode = Spread<
  {
    yaml: string
    version: 1
  },
  SerializedLexicalNode
>

/**
 * A lexical node that represents the YAML frontmatter block. Use {@link $createFrontmatterNode} to construct one.
 * @group Frontmatter
 */
export class FrontmatterNode extends DecoratorNode<JSX.Element> {
  /** @internal */
  __yaml: string

  static getType(): string {
    return 'frontmatter'
  }

  static clone(node: FrontmatterNode): FrontmatterNode {
    return new FrontmatterNode(node.__yaml, node.__key)
  }

  constructor(code: string, key?: NodeKey) {
    super(key)
    this.__yaml = code
  }

  static importJSON(serializedNode: SerializedFrontmatterNode): FrontmatterNode {
    const { yaml } = serializedNode
    const node = $createFrontmatterNode(yaml)
    return node
  }

  exportJSON(): SerializedFrontmatterNode {
    return {
      yaml: this.getYaml(),
      type: 'frontmatter',
      version: 1
    }
  }

  // View
  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  getYaml(): string {
    return this.getLatest().__yaml
  }

  setYaml(yaml: string): void {
    if (yaml !== this.__yaml) {
      this.getWritable().__yaml = yaml
    }
  }

  decorate(editor: LexicalEditor): JSX.Element {
    return <FrontmatterEditorHost editor={editor} nodeKey={this.getKey()} yaml={this.getYaml()} />
  }

  isKeyboardSelectable(): boolean {
    return false
  }
}

/**
 * Bridges the Lexical node to a presentation component: resolves a
 * consumer-provided editor from the descriptor context (or the fallback
 * textarea), and wires its `onChange` back to node mutations. The mutation
 * resolves the node by key inside `editor.update`, so it stays correct across
 * Lexical's node cloning.
 */
const FrontmatterEditorHost: React.FC<{ editor: LexicalEditor; nodeKey: NodeKey; yaml: string }> = ({
  editor,
  nodeKey,
  yaml
}) => {
  const { frontmatterEditor: Injected } = useDescriptors()
  const onChange = React.useCallback(
    (next: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isFrontmatterNode(node)) node.setYaml(next)
      })
    },
    [editor, nodeKey]
  )
  const Editor = Injected ?? FallbackFrontmatterEditor
  return <Editor yaml={yaml} onChange={onChange} />
}

/**
 * A minimal fallback frontmatter editor: an uncontrolled textarea.
 * SEAM CUT: replaces the upstream FrontmatterEditor.
 */
const FallbackFrontmatterEditor: React.FC<{
  yaml: string
  onChange: (yaml: string) => void
}> = ({ yaml, onChange }) => {
  return (
    <div className="mdx-frontmatter">
      <textarea
        className="mdx-frontmatter-textarea"
        defaultValue={yaml}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </div>
  )
}

/**
 * Creates a {@link FrontmatterNode}.
 * @group Frontmatter
 */
export function $createFrontmatterNode(yaml: string): FrontmatterNode {
  return new FrontmatterNode(yaml)
}

/**
 * Returns true if the given node is a {@link FrontmatterNode}.
 * @group Frontmatter
 */
export function $isFrontmatterNode(node: LexicalNode | null | undefined): node is FrontmatterNode {
  return node instanceof FrontmatterNode
}
