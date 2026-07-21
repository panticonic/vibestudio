// New code (not vendored): a realm-free React context replacing the gurx cells
// (jsxComponentDescriptors$, codeBlockEditorDescriptors$, defaultCodeBlockLanguage$) that the
// decorator nodes (CodeBlockNode, LexicalJsxNode) read from in upstream @mdxeditor/editor.
import React from 'react'
import type { JsxComponentDescriptor } from './jsx-types'

/**
 * Props handed to a custom frontmatter editor (see {@link DescriptorContextValue.frontmatterEditor}).
 * The {@link FrontmatterNode} owns the Lexical wiring and delegates presentation here.
 */
export interface FrontmatterEditorProps {
  /** The inner YAML of the frontmatter block (no `---` fences). */
  yaml: string
  /** Emit replacement inner YAML for the block. */
  onChange: (yaml: string) => void
}

/** A component that renders the frontmatter editing surface. */
export type FrontmatterEditorComponent = React.ComponentType<FrontmatterEditorProps>

/**
 * The values carried by {@link DescriptorContext}. Provide these via {@link DescriptorProvider}
 * so the decorator nodes ({@link CodeBlockNode}, {@link LexicalJsxNode}) can resolve their editors.
 */
export interface DescriptorContextValue {
  /** The JSX component descriptors used to render `LexicalJsxNode` editors. */
  jsxComponentDescriptors: JsxComponentDescriptor[]
  /** Optional map of code block language id -> display label. */
  codeBlockLanguages?: Record<string, string>
  /** Optional default language used when a code block has no explicit language. */
  defaultCodeBlockLanguage?: string
  /**
   * Optional custom editor for the YAML frontmatter block. When omitted, the
   * {@link FrontmatterNode} falls back to a bare textarea.
   */
  frontmatterEditor?: FrontmatterEditorComponent
}

const defaultValue: DescriptorContextValue = {
  jsxComponentDescriptors: [],
  codeBlockLanguages: {},
  defaultCodeBlockLanguage: ''
}

const DescriptorContext = React.createContext<DescriptorContextValue>(defaultValue)

/**
 * Provides descriptor values to the decorator nodes rendered inside a Lexical editor.
 */
export function DescriptorProvider({
  value,
  children
}: {
  value: DescriptorContextValue
  children: React.ReactNode
}): React.ReactElement {
  return <DescriptorContext.Provider value={value}>{children}</DescriptorContext.Provider>
}

/**
 * Reads the descriptor values from the nearest {@link DescriptorProvider}.
 */
export function useDescriptors(): DescriptorContextValue {
  return React.useContext(DescriptorContext)
}
