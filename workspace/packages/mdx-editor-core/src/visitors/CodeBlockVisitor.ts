// vendored from @mdxeditor/editor v3.55.0 src/plugins/codeblock/CodeBlockVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { $isCodeBlockNode, CodeBlockNode } from '../nodes/CodeBlockNode'
import { LexicalExportVisitor } from '../types'

export const CodeBlockVisitor: LexicalExportVisitor<CodeBlockNode, Mdast.Code> = {
  testLexicalNode: $isCodeBlockNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('code', {
      value: lexicalNode.getCode(),
      lang: lexicalNode.getLanguage(),
      meta: lexicalNode.getMeta()
    })
  }
}
