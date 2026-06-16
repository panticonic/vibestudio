// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/LexicalLinebreakVisitor.ts — MIT © Petyo Ivanov
import { $isLineBreakNode, LineBreakNode } from 'lexical'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalLinebreakVisitor: LexicalExportVisitor<LineBreakNode, Mdast.Text> = {
  testLexicalNode: $isLineBreakNode,
  visitLexicalNode: ({ mdastParent, actions }) => {
    actions.appendToParent(mdastParent, { type: 'text', value: '\n' } as Mdast.Text)
  }
}
