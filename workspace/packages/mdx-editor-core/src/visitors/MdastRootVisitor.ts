// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastRootVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastRootVisitor: MdastImportVisitor<Mdast.Root> = {
  testNode: 'root',
  visitNode({ actions, mdastNode, lexicalParent }) {
    actions.visitChildren(mdastNode, lexicalParent)
  }
}
