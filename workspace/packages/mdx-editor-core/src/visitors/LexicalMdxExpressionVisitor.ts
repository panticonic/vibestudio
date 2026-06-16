// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/LexicalMdxExpressionVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { MdxFlowExpression, MdxTextExpression } from 'mdast-util-mdx'
import { $isLexicalMdxExpressionNode, LexicalMdxExpressionNode } from '../nodes/LexicalMdxExpressionNode'
import { LexicalExportVisitor } from '../types'

export const LexicalMdxExpressionVisitor: LexicalExportVisitor<LexicalMdxExpressionNode, MdxTextExpression | MdxFlowExpression> = {
  testLexicalNode: $isLexicalMdxExpressionNode,
  visitLexicalNode({ actions, mdastParent, lexicalNode }) {
    const mdastNode = {
      type: lexicalNode.getMdastType(),
      value: lexicalNode.getValue()
    } as MdxTextExpression | MdxFlowExpression
    actions.appendToParent(mdastParent, mdastNode as unknown as Mdast.Parent['children'][number])
  }
}
