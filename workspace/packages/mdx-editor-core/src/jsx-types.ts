// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/index.ts — MIT © Petyo Ivanov
// Realm-free extraction of the JSX descriptor/editor types and the `isMdastJsxNode` guard.
import type * as Mdast from 'mdast'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx'
import type React from 'react'

/**
 * A union of the two mdast JSX node kinds (inline / block).
 * @group JSX
 */
export type MdastJsx = MdxJsxTextElement | MdxJsxFlowElement

/**
 * Defines the structure of a JSX component property.
 * @group JSX
 */
export interface JsxPropertyDescriptor {
  /**
   * The name of the property
   */
  name: string
  /**
   * The type of the property
   */
  type: 'string' | 'number' | 'expression'
  /**
   * Whether the property is required
   */
  required?: boolean
}

/**
 * The properties passed to a custom JSX Editor component.
 * @group JSX
 */
export interface JsxEditorProps {
  /** The MDAST node to edit */
  mdastNode: MdxJsxFlowElement | MdxJsxTextElement
  /** The descriptor that activated the editor */
  descriptor: JsxComponentDescriptor
}

/**
 * Defines the structure of a JSX component that can be used within the markdown document.
 * @group JSX
 */
export interface JsxComponentDescriptor {
  /**
   * The tag name. For example: 'div', 'span', 'MyComponent'. Use '*' for any tag.
   * Note: For fragments, use null.
   *
   */
  name: string | null
  /**
   * Whether the component is a flow or text component (inline or block)
   */
  kind: 'flow' | 'text'
  /**
   * The module path from which the component can be imported
   * Omit to skip injecting an import statement
   */
  source?: string
  /**
   * Whether the component is the default export of the module
   */
  defaultExport?: boolean
  /**
   * The properties that can be applied to the component
   */
  props: JsxPropertyDescriptor[]
  /**
   * Whether or not the component has children
   */
  hasChildren?: boolean

  /**
   * The editor to use for editing the component
   */
  Editor: React.ComponentType<JsxEditorProps>
}

/**
 * Returns true if the given mdast node is a JSX node (flow or text).
 * @group JSX
 */
export function isMdastJsxNode(node: Mdast.Nodes): node is MdastJsx {
  return node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement'
}
