// vendored from @mdxeditor/editor v3.55.0 src/plugins/quote/MdastBlockQuoteVisitor.ts — MIT © Petyo Ivanov
import { $createQuoteNode } from '@lexical/rich-text'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastBlockQuoteVisitor: MdastImportVisitor<Mdast.Blockquote> = {
  testNode: 'blockquote',
  visitNode({ actions }) {
    actions.addAndStepInto($createQuoteNode())
  }
}
