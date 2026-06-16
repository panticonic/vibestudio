// vendored from @mdxeditor/editor v3.55.0 src/plugins/lists/LexicalListItemVisitor.ts — MIT © Petyo Ivanov
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $isDecoratorNode, $isElementNode, $isLineBreakNode, $isTextNode } from 'lexical'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalListItemVisitor: LexicalExportVisitor<ListItemNode, Mdast.ListItem> = {
  testLexicalNode: $isListItemNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    const children = lexicalNode.getChildren()
    const firstChild = children[0]

    if (children.length === 1 && $isListNode(firstChild)) {
      // nested list
      const prevListItemNode = (mdastParent.children as Mdast.ListItem[]).at(-1)
      if (!prevListItemNode) {
        actions.visitChildren(firstChild as unknown as ListItemNode, mdastParent)
      } else {
        actions.visitChildren(lexicalNode, prevListItemNode)
      }
    } else {
      const parentList = lexicalNode.getParent() as ListNode
      const listItem = actions.appendToParent(mdastParent, {
        type: 'listItem',
        checked: parentList.getListType() === 'check' ? Boolean(lexicalNode.getChecked()) : undefined,
        spread: false,
        children: []
      } as Mdast.ListItem) as Mdast.ListItem

      let surroundingParagraph: Mdast.Paragraph | null = null
      for (const child of lexicalNode.getChildren()) {
        const isInline =
          $isTextNode(child) ||
          $isLineBreakNode(child) ||
          (child.isInline() && ($isElementNode(child) || $isDecoratorNode(child)))
        if (isInline) {
          surroundingParagraph ??= actions.appendToParent(listItem, {
            type: 'paragraph',
            children: []
          } as Mdast.Paragraph) as Mdast.Paragraph
          actions.visit(child, surroundingParagraph)
        } else {
          surroundingParagraph = null
          actions.visit(child, listItem)
        }
      }
    }
  }
}
