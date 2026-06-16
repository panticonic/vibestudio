// vendored from @mdxeditor/editor v3.55.0 src/exportMarkdownFromLexical.ts — MIT © Petyo Ivanov
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { $isElementNode, ElementNode as LexicalElementNode, LexicalNode } from 'lexical'
import * as Mdast from 'mdast'
import type { MdxjsEsm } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import { isMdastHTMLNode } from './nodes/MdastHTMLNode'
import { mergeStyleAttributes } from './utils/mergeStyleAttributes'
import type { ExportLexicalTreeOptions, ExportMarkdownFromLexicalOptions } from './types'

export type {
  ExportLexicalTreeOptions,
  ExportMarkdownFromLexicalOptions,
  LexicalExportVisitor,
  LexicalVisitor,
  ToMarkdownExtension,
  ToMarkdownOptions
} from './types'

function isParent(node: unknown): node is Mdast.Parent {
  return (node as { children?: unknown[] }).children instanceof Array
}

export function exportLexicalTreeToMdast({
  root,
  visitors,
  jsxComponentDescriptors,
  jsxIsAvailable,
  addImportStatements = true
}: ExportLexicalTreeOptions): Mdast.Root {
  let unistRoot: Mdast.Nodes | null = null
  const referredComponents = new Set<string>()
  const knownImportSources = new Map<string, { source: string; defaultExport: boolean }>()
  visitors = visitors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  visit(root, null)

  function registerReferredComponent(componentName: string, importStatement?: { source: string; defaultExport: boolean }) {
    referredComponents.add(componentName)
    if (importStatement) {
      knownImportSources.set(componentName, { ...importStatement })
    }
  }

  function appendToParent<T extends Mdast.Parent>(parentNode: T, node: T['children'][number]): T['children'][number] | Mdast.Root {
    if (unistRoot === null) {
      unistRoot = node as unknown as Mdast.Nodes
      return unistRoot as unknown as Mdast.Root
    }
    if (!isParent(parentNode)) {
      throw new Error('Attempting to append children to a non-parent')
    }
    const siblings = parentNode.children
    const prevSibling = siblings.at(-1)
    if (prevSibling) {
      const joinVisitor = visitors.find((visitor) => {
        return visitor.shouldJoin?.(prevSibling, node as unknown as Mdast.RootContent)
      })
      if (joinVisitor) {
        const joinedNode = joinVisitor.join!(prevSibling, node as unknown as Mdast.RootContent) as unknown as T['children'][number]
        siblings.splice(siblings.length - 1, 1, joinedNode)
        return joinedNode
      }
    }
    siblings.push(node)
    return node
  }

  function visitChildren(lexicalNode: LexicalElementNode, parentNode: Mdast.Parent): void {
    lexicalNode.getChildren().forEach((lexicalChild) => {
      visit(lexicalChild, parentNode)
    })
  }

  function visit(lexicalNode: LexicalNode, mdastParent: Mdast.Parent | null, usedVisitors: Set<number> | null = null): void {
    const visitor = visitors.find((visitor, index) => {
      if (usedVisitors?.has(index)) {
        return false
      }
      return visitor.testLexicalNode?.(lexicalNode)
    })
    if (!visitor) {
      throw new Error(`no lexical visitor found for ${lexicalNode.getType()}`, {
        cause: lexicalNode
      })
    }

    visitor.visitLexicalNode?.({
      lexicalNode,
      mdastParent: mdastParent!,
      actions: {
        addAndStepInto(type: string, props = {}, hasChildren = true) {
          const newNode = {
            type,
            ...props,
            ...(hasChildren ? { children: [] } : {})
          }
          appendToParent(mdastParent!, newNode as unknown as Mdast.Parent['children'][number])
          if ($isElementNode(lexicalNode) && hasChildren) {
            visitChildren(lexicalNode, newNode as unknown as Mdast.Parent)
          }
        },
        appendToParent,
        visitChildren,
        visit,
        registerReferredComponent,
        nextVisitor() {
          visit(lexicalNode, mdastParent, (usedVisitors ?? new Set()).add(visitors.indexOf(visitor)))
        }
      }
    })
  }

  if (unistRoot === null) {
    throw new Error('traversal ended with no root element')
  }

  const importsMap = new Map<string, string[]>()
  const defaultImportsMap = new Map<string, string>()
  for (const componentName of referredComponents) {
    const descriptor =
      jsxComponentDescriptors.find((descriptor) => descriptor.name === componentName) ??
      knownImportSources.get(componentName) ??
      jsxComponentDescriptors.find((descriptor) => descriptor.name === '*')
    if (!descriptor) {
      throw new Error(`Component ${componentName} is used but not imported`)
    }
    if (!descriptor.source) {
      continue
    }
    if (descriptor.defaultExport) {
      defaultImportsMap.set(componentName, descriptor.source)
    } else {
      const { source } = descriptor
      const existing = importsMap.get(source)
      if (existing) {
        existing.push(componentName)
      } else {
        importsMap.set(source, [componentName])
      }
    }
  }

  if (!addImportStatements) {
    for (const [path, names] of importsMap.entries()) {
      const cleaned = names.filter((n) => knownImportSources.has(n))
      if (cleaned.length > 0) {
        importsMap.set(path, cleaned)
      } else {
        importsMap.delete(path)
      }
    }
    for (const key of defaultImportsMap.keys()) {
      if (!knownImportSources.has(key)) {
        defaultImportsMap.delete(key)
      }
    }
  }

  const imports = Array.from(importsMap).map(([source, componentNames]) => {
    return {
      type: 'mdxjsEsm',
      value: `import { ${componentNames.join(', ')} } from '${source}'`
    } as MdxjsEsm
  })
  imports.push(
    ...Array.from(defaultImportsMap).map(([componentName, source]) => {
      return {
        type: 'mdxjsEsm',
        value: `import ${componentName} from '${source}'`
      } as MdxjsEsm
    })
  )

  const typedRoot = unistRoot as Mdast.Root
  const frontmatter = typedRoot.children.find((child) => child.type === 'yaml')
  if (frontmatter) {
    typedRoot.children.splice(typedRoot.children.indexOf(frontmatter) + 1, 0, ...(imports as unknown as Mdast.RootContent[]))
  } else {
    typedRoot.children.unshift(...(imports as unknown as Mdast.RootContent[]))
  }
  fixWrappingWhitespace(typedRoot, [])
  collapseNestedHtmlTags(typedRoot)
  if (!jsxIsAvailable) {
    convertUnderlineJsxToHtml(typedRoot)
  }

  return typedRoot
}

function collapseNestedHtmlTags(node: Mdast.Nodes): void {
  if ('children' in node && node.children.length > 0) {
    if (isMdastHTMLNode(node) && node.children.length === 1) {
      const onlyChild = node.children[0]
      if (onlyChild && onlyChild.type === 'mdxJsxTextElement' && onlyChild.name === 'span') {
        onlyChild.attributes.forEach((attribute) => {
          if (attribute.type === 'mdxJsxAttribute') {
            const parentAttribute = node.attributes.find((attr) => attr.type === 'mdxJsxAttribute' && attr.name === attribute.name)
            if (parentAttribute && parentAttribute.type === 'mdxJsxAttribute') {
              if (attribute.name === 'className') {
                const mergedClassesSet = new Set([
                  ...String(parentAttribute.value).split(' '),
                  ...String(attribute.value).split(' ')
                ])
                parentAttribute.value = Array.from(mergedClassesSet).join(' ')
              } else if (attribute.name === 'style') {
                parentAttribute.value = mergeStyleAttributes(String(parentAttribute.value), String(attribute.value))
              }
            } else {
              node.attributes.push(attribute)
            }
          }
        })
        node.children = onlyChild.children
      }
    }
    node.children.forEach((child) => {
      collapseNestedHtmlTags(child)
    })
  }
}

function convertUnderlineJsxToHtml(node: Mdast.Nodes): void {
  if (Object.hasOwn(node, 'children')) {
    const nodeAsParent = node as Mdast.Parent
    const newChildren: Mdast.RootContent[] = []
    nodeAsParent.children.forEach((child) => {
      if (child.type === 'mdxJsxTextElement' && child.name === 'u') {
        newChildren.push(
          ...([{ type: 'html', value: '<u>' }, ...child.children, { type: 'html', value: '</u>' }] as Mdast.RootContent[])
        )
      } else {
        newChildren.push(child)
        convertUnderlineJsxToHtml(child)
      }
    })
    nodeAsParent.children = newChildren
  }
}

const TRAILING_WHITESPACE_REGEXP = /\s+$/
const LEADING_WHITESPACE_REGEXP = /^\s+/

function fixWrappingWhitespace(node: Mdast.Nodes, parentChain: Mdast.Parent[]): void {
  if (node.type === 'strong' || node.type === 'emphasis') {
    const lastChild = node.children.at(-1)
    if (lastChild?.type === 'text') {
      const trailingWhitespace = TRAILING_WHITESPACE_REGEXP.exec(lastChild.value)
      if (trailingWhitespace) {
        lastChild.value = lastChild.value.replace(TRAILING_WHITESPACE_REGEXP, '')
        const parent = parentChain.at(-1)
        if (parent) {
          parent.children.splice(parent.children.indexOf(node as unknown as Mdast.RootContent) + 1, 0, {
            type: 'text',
            value: trailingWhitespace[0]
          })
          fixWrappingWhitespace(parent as Mdast.Nodes, parentChain.slice(0, -1))
        }
      }
    }
    const firstChild = node.children.at(0)
    if (firstChild?.type === 'text') {
      const leadingWhitespace = LEADING_WHITESPACE_REGEXP.exec(firstChild.value)
      if (leadingWhitespace) {
        firstChild.value = firstChild.value.replace(LEADING_WHITESPACE_REGEXP, '')
        const parent = parentChain.at(-1)
        if (parent) {
          parent.children.splice(parent.children.indexOf(node as unknown as Mdast.RootContent), 0, {
            type: 'text',
            value: leadingWhitespace[0]
          })
          fixWrappingWhitespace(parent as Mdast.Nodes, parentChain.slice(0, -1))
        }
      }
    }
  }
  if ('children' in node && node.children.length > 0) {
    const nodeAsParent = node as Mdast.Parent
    nodeAsParent.children.forEach((child) => {
      fixWrappingWhitespace(child, [...parentChain, nodeAsParent])
    })
  }
}

export function exportMarkdownFromLexical({
  root,
  toMarkdownOptions,
  toMarkdownExtensions,
  visitors,
  jsxComponentDescriptors,
  jsxIsAvailable
}: ExportMarkdownFromLexicalOptions): string {
  return (
    toMarkdown(exportLexicalTreeToMdast({ root, visitors, jsxComponentDescriptors, jsxIsAvailable }), {
      extensions: toMarkdownExtensions,
      ...toMarkdownOptions
    }) + '\n'
  )
}
