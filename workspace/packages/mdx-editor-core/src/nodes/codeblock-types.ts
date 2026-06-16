// vendored from @mdxeditor/editor v3.55.0 src/plugins/codeblock/index.ts — MIT © Petyo Ivanov
// Realm-free extraction of the code block editor descriptor / props types.
import type React from 'react'
import type { VoidEmitter } from '../utils/voidEmitter'

/**
 * The properties passed to the {@link CodeBlockEditorDescriptor.Editor} component.
 * @group Code Block
 */
export interface CodeBlockEditorProps {
  /**
   * The code to edit.
   */
  code: string
  /**
   * The language of the fenced code block.
   */
  language: string
  /**
   * The meta of the fenced code block.
   */
  meta: string
  /**
   * The key of the Lexical node - use this if you are dealing with the Lexical APIs.
   */
  nodeKey: string
  /**
   * An emitter that will execute its subscription when the editor should be focused.
   * Note: you don't need to unsubscribe, the emiter has a single subscription model.
   */
  focusEmitter: VoidEmitter
}

/**
 * Implement this interface to create a custom code block editor.
 * @group Code Block
 */
export interface CodeBlockEditorDescriptor {
  /**
   * The priority of the descriptor when descriptors are matched against a given code block. Lower number means lower priority.
   * This allows you to implement a catch-all generic editor and a more specific editor for a given language / meta.
   */
  priority: number
  /**
   * A function that returns true if the descriptor's editor should be used for the given code block.
   * @param language - The language of the code block.
   * @param meta - The meta of the code block.
   */
  match: (language: string | null | undefined, meta: string | null | undefined) => boolean
  /**
   * The React component to be used. See {@link CodeBlockEditorProps} for the props passed to the component.
   */
  Editor: React.ComponentType<CodeBlockEditorProps>
}
