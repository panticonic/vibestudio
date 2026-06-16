// vendored from @mdxeditor/editor v3.55.0 src/importMarkdownToLexical.ts + src/exportMarkdownFromLexical.ts — MIT © Petyo Ivanov
// The visitor interfaces and the import/export option types. These live alongside the
// import/export entry files in upstream; collected here so the realm-free entry files can share them.
import type { ElementNode, LexicalNode, RootNode as LexicalRootNode } from 'lexical'
import type * as Mdast from 'mdast'
import type { Options as FromMarkdownOptions } from 'mdast-util-from-markdown'
import type { Options as ToMarkdownOptions } from 'mdast-util-to-markdown'
import type { ParseOptions } from 'micromark-util-types'
import type { FORMAT } from './FormatConstants'
import type { CodeBlockEditorDescriptor } from './nodes/codeblock-types'
import type { JsxComponentDescriptor } from './jsx-types'

/**
 * A descriptor for a markdown directive. Directives are not vendored in this package, but the
 * shape is retained so the {@link Descriptors} contract matches upstream. Replace with a richer
 * type if directive support is added.
 * @group Markdown Processing
 */
export interface DirectiveDescriptor {
  name: string
  testNode: (node: unknown) => boolean
  [key: string]: unknown
}

/**
 * A statement that imports a JSX component into the document.
 * @group Markdown Processing
 */
export interface ImportStatement {
  source: string
  defaultExport: boolean
}

/**
 * Metadata that is provided to the import visitors.
 * @group Markdown Processing
 */
export interface MetaData {
  importDeclarations: Record<string, ImportStatement>
}

/**
 * The registered descriptors for composite nodes (jsx, directives, code blocks).
 * @group Markdown Processing
 */
export interface Descriptors {
  jsxComponentDescriptors: JsxComponentDescriptor[]
  directiveDescriptors: DirectiveDescriptor[]
  codeBlockEditorDescriptors: CodeBlockEditorDescriptor[]
}

/** @internal */
export type MdastExtensions = FromMarkdownOptions['mdastExtensions']

/**
 * Implement this interface to convert certain mdast nodes into lexical nodes.
 * @typeParam UN - The type of the mdast node that is being visited.
 * @group Markdown Processing
 */
export interface MdastImportVisitor<UN extends Mdast.Nodes> {
  /**
   * The test function that determines if this visitor should be used for the given node.
   * As a convenience, you can also pass a string here, which will be compared to the node's type.
   * @param descriptors - the registered descriptors for composite nodes (jsx, directives, code blocks).
   */
  testNode: ((mdastNode: Mdast.Nodes, descriptors: Descriptors) => boolean) | string
  visitNode(params: {
    /**
     * The node that is currently being visited.
     */
    mdastNode: UN
    /**
     * The MDAST parent of the node that is currently being visited.
     */
    mdastParent: Mdast.Parent | null
    /**
     * The parent lexical node to which the results of the processing should be added.
     */
    lexicalParent: LexicalNode
    /**
     * The descriptors for composite nodes (jsx, directives, code blocks).
     */
    descriptors: Descriptors
    /**
     * metaData: context data provided from the import visitor.
     */
    metaData: MetaData
    /**
     * A set of convenience utilities that can be used to add nodes to the lexical tree.
     */
    actions: {
      /**
       * Iterate the children of the node with the lexical node as the parent.
       */
      visitChildren(node: Mdast.Parent, lexicalParent: LexicalNode): void

      /**
       * Add the given node to the lexical tree, and iterate the current mdast node's children with the newly created lexical node as a parent.
       */
      addAndStepInto(lexicalNode: LexicalNode): void

      /**
       * Adds formatting as a context for the current node and its children.
       * This is necessary due to mdast treating formatting as a node, while lexical considering it an attribute of a node.
       */
      addFormatting(format: FORMAT, node?: Mdast.Parent | null): void

      /**
       * Removes formatting as a context for the current node and its children.
       * This is necessary due to mdast treating formatting as a node, while lexical considering it an attribute of a node.
       */
      removeFormatting(format: FORMAT, node?: Mdast.Parent | null): void
      /**
       * Access the current formatting context.
       */
      getParentFormatting(): number
      /**
       * Adds styling as a context for the current node and its children.
       * This is necessary due to mdast treating styling as a node, while lexical considering it an attribute of a node.
       */
      addStyle(style: string, node?: Mdast.Parent | null): void
      /**
       * Access the current style context.
       */
      getParentStyle(): string
      /**
       * Go to next visitor in the visitors chain for potential processing from a different visitor with a lower priority
       */
      nextVisitor(): void
    }
  }): void
  /**
   * Default 0, optional, sets the priority of the visitor. The higher the number, the earlier it will be called.
   */
  priority?: number
}

/**
 * A target into which the imported lexical nodes are appended.
 * @group Markdown Processing
 */
export interface ImportPoint {
  append(node: LexicalNode): void
  getType(): string
}

/**
 * The options of the tree import utility. Not meant to be used directly.
 * @internal
 */
export interface MdastTreeImportOptions extends Descriptors {
  root: ImportPoint
  visitors: MdastImportVisitor<Mdast.RootContent>[]
  mdastRoot: Mdast.Root
}

/** @internal */
export interface MarkdownParseOptions extends Omit<MdastTreeImportOptions, 'mdastRoot'> {
  markdown: string
  syntaxExtensions: NonNullable<ParseOptions['extensions']>
  mdastExtensions: MdastExtensions
}

/**
 * An extension for the `fromMarkdown` utility tree construction.
 * @internal
 */
export type MdastExtension = NonNullable<MdastExtensions>[number]

/**
 * An extension for the `fromMarkdown` utility markdown parse.
 * @internal
 */
export type SyntaxExtension = MarkdownParseOptions['syntaxExtensions'][number]

/**
 * An extension for the `toMarkdown` utility.
 * @internal
 */
export type ToMarkdownExtension = NonNullable<ToMarkdownOptions['extensions']>[number]

/**
 * Implement this interface in order to process lexical node(s) into mdast node(s).
 * This is part of the process that converts the editor contents to markdown.
 * @group Markdown Processing
 */
export interface LexicalExportVisitor<LN extends LexicalNode, UN extends Mdast.Nodes> {
  /**
   * Return true if the given node is of the type that this visitor can process.
   * You can safely use the node type guard functions (as in $isParagraphNode, $isLinkNode, etc.) here.
   */
  testLexicalNode?(lexicalNode: LexicalNode): lexicalNode is LN

  /**
   * Process the given node and manipulate the mdast tree accordingly.
   */
  visitLexicalNode?(params: {
    /**
     * The lexical node that is being visited.
     */
    lexicalNode: LN
    /**
     * The mdast parent node that the result of the lexical node conversion should be appended to.
     */
    mdastParent: Mdast.Parent
    /**
     * A set of actions that can be used to manipulate the mdast tree.
     * These are "convenience" utilities that avoid the repetitive boilerplate of creating mdast nodes.
     */
    actions: {
      /**
       * Iterate over the immediate children of a lexical node with the given mdast node as a parent.
       */
      visitChildren(node: LN, mdastParent: Mdast.Parent): void
      /**
       * Create a new mdast node with the given type, and props.
       * Iterate over the immediate children of the current lexical node with the new mdast node as a parent.
       * @param hasChildren - true by default. Pass false to skip iterating over the lexical node children.
       */
      addAndStepInto(type: string, props?: Record<string, unknown>, hasChildren?: boolean): void
      /**
       * Append a new mdast node to a parent node.
       * @param parentNode - the mdast parent node to append the new node to.
       * @param node - the mdast node to append.
       */
      appendToParent<T extends Mdast.Parent>(parentNode: T, node: T['children'][number]): T['children'][number] | Mdast.Root
      /**
       * Used when processing JSX nodes so that later, the correct import statement can be added to the document.
       * @param componentName - the name of the component that has to be imported.
       * @see {@link JsxComponentDescriptor}
       */
      registerReferredComponent(componentName: string, importStatement?: ImportStatement): void
      /**
       * visits the specified lexical node
       */
      visit(node: LexicalNode, parent: Mdast.Parent): void
      /**
       * Go to next visitor in the visitors chain for potential processing from a different visitor with a lower priority
       */
      nextVisitor(): void
    }
  }): void

  /**
   * Return true if the current node should be joined with the previous node.
   * This is necessary due to some inconsistencies between the lexical tree and the mdast tree when it comes to formatting.
   */
  shouldJoin?(prevNode: Mdast.RootContent, currentNode: UN): boolean

  /**
   * Join the current node with the previous node, returning the resulting new node
   * For this to be called by the tree walk, shouldJoin must return true.
   */
  join?<T extends Mdast.RootContent>(prevNode: T, currentNode: T): T

  /**
   * Default 0, optional, sets the priority of the visitor. The higher the number, the earlier it will be called.
   */
  priority?: number
}

/**
 * A generic visitor that can be used to process any lexical node.
 * @group Markdown Processing
 */
export type LexicalVisitor = LexicalExportVisitor<LexicalNode, Mdast.RootContent>

/**
 * @internal
 */
export interface ExportLexicalTreeOptions {
  root: LexicalRootNode
  visitors: LexicalVisitor[]
  jsxComponentDescriptors: JsxComponentDescriptor[]
  jsxIsAvailable: boolean
  addImportStatements?: boolean
}

/**
 * @internal
 */
export interface ExportMarkdownFromLexicalOptions extends ExportLexicalTreeOptions {
  visitors: LexicalVisitor[]
  /**
   * the markdown extensions to use
   */
  toMarkdownExtensions: ToMarkdownExtension[]
  /**
   * The options to pass to `toMarkdown`
   */
  toMarkdownOptions: ToMarkdownOptions
}

export type { ToMarkdownOptions }

/**
 * A lexical node element (helper alias used by the tree import).
 * @internal
 */
export type { ElementNode }
