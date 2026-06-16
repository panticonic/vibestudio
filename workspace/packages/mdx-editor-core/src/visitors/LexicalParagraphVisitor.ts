// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/LexicalParagraphVisitor.ts — MIT © Petyo Ivanov
import { $isParagraphNode, ParagraphNode } from 'lexical'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalParagraphVisitor: LexicalExportVisitor<ParagraphNode, Mdast.Paragraph> = {
  testLexicalNode: $isParagraphNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto('paragraph')
  }
}
