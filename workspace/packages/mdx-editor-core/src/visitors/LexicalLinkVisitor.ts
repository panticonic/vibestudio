// vendored from @mdxeditor/editor v3.55.0 src/plugins/link/LexicalLinkVisitor.ts — MIT © Petyo Ivanov
import { $isLinkNode, LinkNode } from '@lexical/link'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalLinkVisitor: LexicalExportVisitor<LinkNode, Mdast.Link> = {
  testLexicalNode: $isLinkNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('link', { url: lexicalNode.getURL(), title: lexicalNode.getTitle() })
  }
}
