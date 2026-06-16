// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/MdastMdxExpressionVisitor.ts — MIT © Petyo Ivanov
import { MdxFlowExpression, MdxTextExpression } from 'mdast-util-mdx'
import { ElementNode } from 'lexical'
import { $createLexicalMdxExpressionNode } from '../nodes/LexicalMdxExpressionNode'
import { MdastImportVisitor } from '../types'

export const MdastMdxExpressionVisitor: MdastImportVisitor<MdxTextExpression | MdxFlowExpression> = {
  testNode: (node) => node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression',
  visitNode({ lexicalParent, mdastNode }) {
    ;(lexicalParent as ElementNode).append($createLexicalMdxExpressionNode(mdastNode.value, mdastNode.type))
  },
  priority: -200
}
