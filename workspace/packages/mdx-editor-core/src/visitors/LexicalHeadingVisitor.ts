// vendored from @mdxeditor/editor v3.55.0 src/plugins/headings/LexicalHeadingVisitor.ts — MIT © Petyo Ivanov
import { $isHeadingNode, HeadingNode } from '@lexical/rich-text'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalHeadingVisitor: LexicalExportVisitor<HeadingNode, Mdast.Heading> = {
  testLexicalNode: $isHeadingNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    const depth = parseInt(lexicalNode.getTag()[1] ?? '1', 10)
    actions.addAndStepInto('heading', { depth })
  }
}
