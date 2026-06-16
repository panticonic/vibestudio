// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/LexicalGenericHTMLNodeVisitor.ts — MIT © Petyo Ivanov
import { GenericHTMLNode, $isGenericHTMLNode } from '../nodes/GenericHTMLNode'
import { MdxJsxTextElement } from 'mdast-util-mdx-jsx'
import { LexicalExportVisitor } from '../types'

export const LexicalGenericHTMLVisitor: LexicalExportVisitor<GenericHTMLNode, MdxJsxTextElement> = {
  testLexicalNode: $isGenericHTMLNode,
  visitLexicalNode({ actions, lexicalNode }) {
    actions.addAndStepInto('mdxJsxTextElement', {
      name: lexicalNode.getTag(),
      type: lexicalNode.getNodeType(),
      attributes: lexicalNode.getAttributes()
    })
  },
  priority: -100
}
