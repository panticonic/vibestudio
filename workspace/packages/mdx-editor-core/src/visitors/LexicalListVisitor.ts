// vendored from @mdxeditor/editor v3.55.0 src/plugins/lists/LexicalListVisitor.ts — MIT © Petyo Ivanov
import { $isListNode, ListNode } from '@lexical/list'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalListVisitor: LexicalExportVisitor<ListNode, Mdast.List> = {
  testLexicalNode: $isListNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('list', {
      ordered: lexicalNode.getListType() === 'number',
      spread: false
    })
  }
}
