// vendored from @mdxeditor/editor v3.55.0 src/plugins/quote/LexicalQuoteVisitor.ts — MIT © Petyo Ivanov
import { $isQuoteNode, QuoteNode } from '@lexical/rich-text'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalQuoteVisitor: LexicalExportVisitor<QuoteNode, Mdast.Blockquote> = {
  testLexicalNode: $isQuoteNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto('blockquote')
  }
}
