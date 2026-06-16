// vendored from @mdxeditor/editor v3.55.0 src/plugins/lists/MdastListVisitor.ts — MIT © Petyo Ivanov
import { $createListItemNode, $createListNode, $isListItemNode, ListItemNode } from '@lexical/list'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastListVisitor: MdastImportVisitor<Mdast.List> = {
  testNode: 'list',
  visitNode: function ({ mdastNode, lexicalParent, actions }) {
    const listType = mdastNode.children.some((e) => typeof e.checked === 'boolean')
      ? 'check'
      : mdastNode.ordered
        ? 'number'
        : 'bullet'
    const lexicalNode = $createListNode(listType)

    if ($isListItemNode(lexicalParent)) {
      const dedicatedParent = $createListItemNode()
      dedicatedParent.append(lexicalNode)
      ;(lexicalParent as ListItemNode).insertAfter(dedicatedParent)
    } else {
      ;(lexicalParent as unknown as ListItemNode).append(lexicalNode)
    }

    actions.visitChildren(mdastNode, lexicalNode)
  }
}
