// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/LexicalJsxVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { $isLexicalJsxNode, LexicalJsxNode } from '../nodes/LexicalJsxNode'
import { isMdastJsxNode, MdastJsx } from '../jsx-types'
import { isHtmlTagName } from './jsxTagName'
import { LexicalExportVisitor } from '../types'

export const LexicalJsxVisitor: LexicalExportVisitor<LexicalJsxNode, MdastJsx> = {
  testLexicalNode: $isLexicalJsxNode,
  visitLexicalNode({ actions, mdastParent, lexicalNode }) {
    function traverseNestedJsxNodes(node: Mdast.Nodes) {
      if ('children' in node && node.children instanceof Array) {
        node.children.forEach((child) => {
          if (isMdastJsxNode(child) && child.name && !isHtmlTagName(child.name)) {
            actions.registerReferredComponent(child.name)
          }
          traverseNestedJsxNodes(child)
        })
      }
    }

    const mdastNode = lexicalNode.getMdastNode()
    const importStatement = lexicalNode.getImportStatement()
    if (mdastNode.name) {
      actions.registerReferredComponent(mdastNode.name, importStatement)
    }
    traverseNestedJsxNodes(mdastNode)
    actions.appendToParent(mdastParent, mdastNode as unknown as Mdast.Parent['children'][number])
  },
  priority: -200
}
