// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/LexicalRootVisitor.ts — MIT © Petyo Ivanov
import { $isRootNode, RootNode } from 'lexical'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalRootVisitor: LexicalExportVisitor<RootNode, Mdast.Content> = {
  testLexicalNode: $isRootNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto('root')
  }
}
