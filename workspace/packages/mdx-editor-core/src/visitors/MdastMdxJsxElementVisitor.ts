// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/MdastMdxJsxElementVisitor.ts — MIT © Petyo Ivanov
import { $createParagraphNode, ElementNode } from 'lexical'
import { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx'
import { $createLexicalJsxNode } from '../nodes/LexicalJsxNode'
import { MdastImportVisitor } from '../types'

export const MdastMdxJsxElementVisitor: MdastImportVisitor<MdxJsxTextElement | MdxJsxFlowElement> = {
  testNode: (node, { jsxComponentDescriptors }) => {
    if (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') {
      const descriptor =
        jsxComponentDescriptors.find((descriptor) => descriptor.name === (node as MdxJsxFlowElement).name) ??
        jsxComponentDescriptors.find((descriptor) => descriptor.name === '*')
      return descriptor !== undefined
    }
    return false
  },
  visitNode({ lexicalParent, mdastNode, descriptors: { jsxComponentDescriptors }, metaData }) {
    const descriptor =
      jsxComponentDescriptors.find((descriptor) => descriptor.name === mdastNode.name) ??
      jsxComponentDescriptors.find((descriptor) => descriptor.name === '*')
    if (descriptor?.kind === 'text' && mdastNode.type === 'mdxJsxFlowElement') {
      const patchedNode = { ...mdastNode, type: 'mdxJsxTextElement' as const } as MdxJsxTextElement
      const paragraph = $createParagraphNode()
      paragraph.append(
        $createLexicalJsxNode(patchedNode, mdastNode.name ? metaData.importDeclarations[mdastNode.name] : undefined)
      )
      ;(lexicalParent as ElementNode).append(paragraph)
    } else {
      ;(lexicalParent as ElementNode).append(
        $createLexicalJsxNode(mdastNode, mdastNode.name ? metaData.importDeclarations[mdastNode.name] : undefined)
      )
    }
  },
  priority: -200
}
