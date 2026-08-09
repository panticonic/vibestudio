import type * as Mdast from 'mdast'
import type { MdxjsEsm } from 'mdast-util-mdx'
import {
  $isLexicalMdxEsmNode,
  type LexicalMdxEsmNode
} from '../nodes/LexicalMdxEsmNode'
import type { LexicalExportVisitor } from '../types'

export const LexicalMdxEsmVisitor: LexicalExportVisitor<LexicalMdxEsmNode, MdxjsEsm> = {
  testLexicalNode: $isLexicalMdxEsmNode,
  visitLexicalNode({ actions, mdastParent, lexicalNode }) {
    actions.appendToParent(mdastParent, {
      type: 'mdxjsEsm',
      value: lexicalNode.getValue()
    } as unknown as Mdast.Parent['children'][number])
  }
}
