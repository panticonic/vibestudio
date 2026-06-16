// vendored from @mdxeditor/editor v3.55.0 src/plugins/lists/MdastListItemVisitor.ts — MIT © Petyo Ivanov
import { $createListItemNode, ListNode } from '@lexical/list'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastListItemVisitor: MdastImportVisitor<Mdast.ListItem> = {
  testNode: 'listItem',
  visitNode({ mdastNode, actions, lexicalParent }) {
    const isChecked = (lexicalParent as ListNode).getListType() === 'check' ? (mdastNode.checked ?? false) : undefined
    actions.addAndStepInto($createListItemNode(isChecked))
  }
}
