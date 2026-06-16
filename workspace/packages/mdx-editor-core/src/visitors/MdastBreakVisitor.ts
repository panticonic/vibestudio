// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastBreakVisitor.ts — MIT © Petyo Ivanov
import { $createLineBreakNode, ElementNode } from 'lexical'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastBreakVisitor: MdastImportVisitor<Mdast.Break> = {
  testNode: 'break',
  visitNode: function ({ lexicalParent }) {
    ;(lexicalParent as ElementNode).append($createLineBreakNode())
  }
}
