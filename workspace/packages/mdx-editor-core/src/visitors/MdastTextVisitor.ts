// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastTextVisitor.ts — MIT © Petyo Ivanov
import { $createTextNode } from 'lexical'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastTextVisitor: MdastImportVisitor<Mdast.Text> = {
  testNode: 'text',
  visitNode({ mdastNode, actions }) {
    const node = $createTextNode(mdastNode.value)
    node.setFormat(actions.getParentFormatting())
    const style = actions.getParentStyle()
    if (style !== '') {
      node.setStyle(style)
    }
    actions.addAndStepInto(node)
  }
}
