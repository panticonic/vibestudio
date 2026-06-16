// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastParagraphVisitor.ts — MIT © Petyo Ivanov
import { $createParagraphNode, ElementNode } from 'lexical'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

const lexicalTypesThatShouldSkipParagraphs = ['listitem', 'admonition']

export const MdastParagraphVisitor: MdastImportVisitor<Mdast.Paragraph> = {
  testNode: 'paragraph',
  visitNode: function ({ mdastNode, lexicalParent, actions }) {
    if (lexicalTypesThatShouldSkipParagraphs.includes((lexicalParent as ElementNode).getType())) {
      actions.visitChildren(mdastNode, lexicalParent)
    } else {
      actions.addAndStepInto($createParagraphNode())
    }
  }
}
