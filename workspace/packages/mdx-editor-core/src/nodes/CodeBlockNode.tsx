// vendored from @mdxeditor/editor v3.55.0 src/plugins/codeblock/CodeBlockNode.tsx — MIT © Petyo Ivanov
// SEAM CUT: decorate() no longer reads gurx cells (codeBlockEditorDescriptors$/defaultCodeBlockLanguage$).
// It renders a minimal <pre><code> fallback editor (a controlled textarea). No CodeMirror dependency.
import {
  DecoratorNode,
  DOMConversionMap,
  DOMConversionOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread
} from 'lexical'
import React, { JSX } from 'react'
import { voidEmitter } from '../utils/voidEmitter'
import type { CodeBlockEditorProps } from './codeblock-types'

export type { CodeBlockEditorDescriptor, CodeBlockEditorProps } from './codeblock-types'

export interface CreateCodeBlockNodeOptions {
  code: string
  language: string
  meta: string
}

export type SerializedCodeBlockNode = Spread<CreateCodeBlockNodeOptions & { type: 'codeblock'; version: 1 }, SerializedLexicalNode>

/**
 * A lexical node that represents a fenced code block. Use {@link $createCodeBlockNode} to construct one.
 * @group Code Block
 */
export class CodeBlockNode extends DecoratorNode<JSX.Element> {
  /** @internal */
  __code: string
  /** @internal */
  __meta: string
  /** @internal */
  __language: string
  /** @internal */
  __focusEmitter = voidEmitter()

  static getType(): string {
    return 'codeblock'
  }

  static clone(node: CodeBlockNode): CodeBlockNode {
    return new CodeBlockNode(node.__code, node.__language, node.__meta, node.__key)
  }

  constructor(code: string, language: string, meta: string, key?: NodeKey) {
    super(key)
    this.__code = code
    this.__meta = meta
    this.__language = language
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode)
    this.__code = prevNode.__code
    this.__meta = prevNode.__meta
    this.__language = prevNode.__language
    this.__focusEmitter = voidEmitter()
  }

  static importJSON(serializedNode: SerializedCodeBlockNode): CodeBlockNode {
    const { code, meta, language } = serializedNode
    return $createCodeBlockNode({
      code,
      language,
      meta
    })
  }

  static importDOM(): DOMConversionMap | null {
    return {
      pre: () => {
        return {
          conversion: $convertPreElement,
          priority: 3
        }
      }
    }
  }

  exportJSON(): SerializedCodeBlockNode {
    return {
      code: this.getCode(),
      language: this.getLanguage(),
      meta: this.getMeta(),
      type: 'codeblock',
      version: 1
    }
  }

  // View
  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  getCode(): string {
    return this.getLatest().__code
  }

  getMeta(): string {
    return this.getLatest().__meta
  }

  getLanguage(): string {
    return this.getLatest().__language
  }

  setCode = (code: string): void => {
    if (code !== this.__code) {
      this.getWritable().__code = code
    }
  }

  setMeta = (meta: string): void => {
    if (meta !== this.__meta) {
      this.getWritable().__meta = meta
    }
  }

  setLanguage = (language: string): void => {
    if (language !== this.__language) {
      this.getWritable().__language = language
    }
  }

  select = (): void => {
    this.__focusEmitter.publish()
  }

  decorate(editor: LexicalEditor): JSX.Element {
    return (
      <CodeBlockEditorContainer
        parentEditor={editor}
        code={this.getCode()}
        meta={this.getMeta()}
        language={this.getLanguage()}
        codeBlockNode={this}
        nodeKey={this.getKey()}
        focusEmitter={this.__focusEmitter}
      />
    )
  }

  isInline(): boolean {
    return false
  }
}

/** @internal */
interface CodeBlockEditorContextValue {
  setCode: (code: string) => void
  setLanguage: (language: string) => void
  setMeta: (meta: string) => void
  lexicalNode: CodeBlockNode
  parentEditor: LexicalEditor
}

const CodeBlockEditorContext = React.createContext<CodeBlockEditorContextValue | null>(null)

const CodeBlockEditorContextProvider: React.FC<{
  parentEditor: LexicalEditor
  lexicalNode: CodeBlockNode
  children: React.ReactNode
}> = ({ parentEditor, lexicalNode, children }) => {
  const contextValue = React.useMemo<CodeBlockEditorContextValue>(() => {
    return {
      lexicalNode,
      parentEditor,
      setCode: (code: string) => {
        parentEditor.update(() => {
          lexicalNode.setCode(code)
        })
      },
      setLanguage: (language: string) => {
        parentEditor.update(() => {
          lexicalNode.setLanguage(language)
        })
      },
      setMeta: (meta: string) => {
        parentEditor.update(() => {
          lexicalNode.setMeta(meta)
        })
      }
    }
  }, [lexicalNode, parentEditor])
  return <CodeBlockEditorContext.Provider value={contextValue}>{children}</CodeBlockEditorContext.Provider>
}

/**
 * Access the {@link CodeBlockNode} editing context from within a custom code block editor.
 * @group Code Block
 */
export function useCodeBlockEditorContext(): CodeBlockEditorContextValue {
  const context = React.useContext(CodeBlockEditorContext)
  if (!context) {
    throw new Error('useCodeBlockEditor must be used within a CodeBlockEditor')
  }
  return context
}

/**
 * A minimal fallback code block editor: a controlled textarea wrapped in `<pre><code>`.
 * SEAM CUT: replaces the CodeMirror-backed descriptor editors from upstream.
 */
const FallbackCodeBlockEditor: React.FC<CodeBlockEditorProps & { codeBlockNode: CodeBlockNode; parentEditor: LexicalEditor }> = (
  props
) => {
  const { setCode } = useCodeBlockEditorContext()
  return (
    <pre className="mdx-code-block" data-language={props.language || undefined}>
      <code>
        <textarea
          className="mdx-code-block-textarea"
          defaultValue={props.code}
          spellCheck={false}
          onChange={(e) => {
            setCode(e.target.value)
          }}
        />
      </code>
    </pre>
  )
}

const CodeBlockEditorContainer: React.FC<
  CodeBlockEditorProps & { codeBlockNode: CodeBlockNode; parentEditor: LexicalEditor }
> = (props) => {
  const { codeBlockNode, parentEditor, ...restProps } = props
  return (
    <CodeBlockEditorContextProvider parentEditor={parentEditor} lexicalNode={codeBlockNode}>
      <FallbackCodeBlockEditor {...restProps} codeBlockNode={codeBlockNode} parentEditor={parentEditor} />
    </CodeBlockEditorContextProvider>
  )
}

/**
 * Creates a {@link CodeBlockNode}.
 * @group Code Block
 */
export function $createCodeBlockNode(options: Partial<CreateCodeBlockNodeOptions>): CodeBlockNode {
  const { code = '', language = '', meta = '' } = options
  return new CodeBlockNode(code, language, meta)
}

/**
 * Returns true if the given node is a {@link CodeBlockNode}.
 * @group Code Block
 */
export function $isCodeBlockNode(node: LexicalNode | null | undefined): node is CodeBlockNode {
  return node instanceof CodeBlockNode
}

function $convertPreElement(element: HTMLElement): DOMConversionOutput {
  const preElement = element as HTMLPreElement
  const code = preElement.textContent ?? ''
  const classAttribute = element.getAttribute('class') ?? ''
  const dataLanguageAttribute = element.getAttribute('data-language') ?? ''
  const languageMatch = /language-(\w+)/.exec(classAttribute)
  const language = languageMatch ? (languageMatch[1] ?? '') : dataLanguageAttribute
  const meta = preElement.getAttribute('data-meta') ?? ''
  return {
    node: $createCodeBlockNode({ code, language, meta })
  }
}

export { $convertPreElement }
