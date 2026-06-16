// vendored from @mdxeditor/editor v3.55.0 src/importMarkdownToLexical.ts — MIT © Petyo Ivanov
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ElementNode, LexicalNode } from 'lexical'
import * as Mdast from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { MdxjsEsm } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import type {
  Descriptors,
  ImportStatement,
  MarkdownParseOptions,
  MdastTreeImportOptions,
  MetaData
} from './types'

export type {
  Descriptors,
  ImportPoint,
  ImportStatement,
  MarkdownParseOptions,
  MdastExtension,
  MdastExtensions,
  MdastImportVisitor,
  MdastTreeImportOptions,
  MetaData,
  SyntaxExtension
} from './types'

function isParent(node: unknown): node is Mdast.Parent {
  return (node as { children?: unknown[] }).children instanceof Array
}

/**
 * An error that gets thrown when the Markdown parsing fails due to a syntax error.
 * @group Markdown Processing
 */
export class MarkdownParseError extends Error {
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'MarkdownParseError'
    this.cause = cause
  }
}

/**
 * An error that gets thrown when the Markdown parsing encounters a node that has no corresponding {@link MdastImportVisitor}.
 * @group Markdown Processing
 */
export class UnrecognizedMarkdownConstructError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnrecognizedMarkdownConstructError'
  }
}

function gatherMetadata(mdastNode: Mdast.RootContent | Mdast.Root): MetaData {
  const importsMap = new Map<string, ImportStatement>()
  if (mdastNode.type !== 'root') {
    return {
      importDeclarations: {}
    }
  }
  const importStatements = mdastNode.children
    .filter((n) => n.type === 'mdxjsEsm')
    .filter((n) => (n as MdxjsEsm).value.startsWith('import ')) as MdxjsEsm[]
  importStatements.forEach((imp) => {
    ;(imp.data?.estree?.body ?? []).forEach((declaration) => {
      if (declaration.type !== 'ImportDeclaration') {
        return
      }
      declaration.specifiers.forEach((specifier) => {
        importsMap.set(specifier.local.name, {
          source: `${declaration.source.value}`,
          defaultExport: specifier.type === 'ImportDefaultSpecifier'
        })
      })
    })
  })
  return {
    importDeclarations: Object.fromEntries(importsMap.entries())
  }
}

/** @internal */
export function importMarkdownToLexical({
  root,
  markdown,
  visitors,
  syntaxExtensions,
  mdastExtensions,
  ...descriptors
}: MarkdownParseOptions): void {
  let mdastRoot: Mdast.Root
  try {
    mdastRoot = fromMarkdown(markdown, {
      extensions: syntaxExtensions,
      mdastExtensions
    })
  } catch (e: unknown) {
    if (e instanceof Error) {
      throw new MarkdownParseError(`Error parsing markdown: ${e.message}`, e)
    } else {
      throw new MarkdownParseError(`Error parsing markdown: ${String(e)}`, e)
    }
  }

  if (mdastRoot.children.length === 0) {
    mdastRoot.children.push({ type: 'paragraph', children: [] })
  }

  // leave empty paragraph, so that the user can start typing
  if (mdastRoot.children.at(-1)?.type !== 'paragraph') {
    mdastRoot.children.push({ type: 'paragraph', children: [] })
  }

  importMdastTreeToLexical({ root, mdastRoot, visitors, ...descriptors })
}

export function importMdastTreeToLexical({ root, mdastRoot, visitors, ...descriptors }: MdastTreeImportOptions): void {
  const formattingMap = new WeakMap<Mdast.Parent, number>()
  const styleMap = new WeakMap<Mdast.Parent, string>()
  const metaData: MetaData = gatherMetadata(mdastRoot)
  const descriptorsValue = descriptors as Descriptors

  visitors = visitors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  function visitChildren(mdastNode: Mdast.Parent, lexicalParent: LexicalNode) {
    if (!isParent(mdastNode)) {
      throw new Error('Attempting to visit children of a non-parent')
    }
    mdastNode.children.forEach((child) => {
      visit(child, lexicalParent, mdastNode)
    })
  }

  function visit(
    mdastNode: Mdast.RootContent | Mdast.Root,
    lexicalParent: LexicalNode,
    mdastParent: Mdast.Parent | null,
    skipVisitors: Set<number> | null = null
  ) {
    const visitor = visitors.find((visitor, index) => {
      if (skipVisitors?.has(index)) {
        return false
      }
      if (typeof visitor.testNode === 'string') {
        return visitor.testNode === mdastNode.type
      }
      return visitor.testNode(mdastNode, descriptorsValue)
    })
    if (!visitor) {
      try {
        throw new UnrecognizedMarkdownConstructError(`Unsupported markdown syntax: ${toMarkdown(mdastNode)}`)
      } catch {
        throw new UnrecognizedMarkdownConstructError(
          `Parsing of the following markdown structure failed: ${JSON.stringify({
            type: mdastNode.type,
            name: 'name' in mdastNode ? mdastNode.name : 'N/A'
          })}`
        )
      }
    }

    visitor.visitNode({
      //@ts-expect-error root type is glitching
      mdastNode,
      lexicalParent,
      mdastParent,
      descriptors: descriptorsValue,
      metaData,
      actions: {
        visitChildren,
        nextVisitor() {
          visit(mdastNode, lexicalParent, mdastParent, (skipVisitors ?? new Set()).add(visitors.indexOf(visitor)))
        },
        addAndStepInto(lexicalNode) {
          ;(lexicalParent as ElementNode).append(lexicalNode)
          if (isParent(mdastNode)) {
            visitChildren(mdastNode, lexicalNode)
          }
        },
        addFormatting(format, node) {
          if (!node) {
            if (isParent(mdastNode)) {
              node = mdastNode
            }
          }
          if (node) {
            formattingMap.set(node, format | (formattingMap.get(mdastParent!) ?? 0))
          }
        },
        removeFormatting(format, node) {
          if (!node) {
            if (isParent(mdastNode)) {
              node = mdastNode
            }
          }
          if (node) {
            formattingMap.set(node, format ^ (formattingMap.get(mdastParent!) ?? 0))
          }
        },
        getParentFormatting() {
          return formattingMap.get(mdastParent!) ?? 0
        },
        addStyle(style, node) {
          if (!node) {
            if (isParent(mdastNode)) {
              node = mdastNode
            }
          }
          if (node) {
            styleMap.set(node, style)
          }
        },
        getParentStyle() {
          return styleMap.get(mdastParent!) ?? ''
        }
      }
    })
  }

  visit(mdastRoot, root as unknown as LexicalNode, null)
}
