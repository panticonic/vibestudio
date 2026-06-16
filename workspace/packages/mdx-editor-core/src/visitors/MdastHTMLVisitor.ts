// vendored from @mdxeditor/editor v3.55.0 src/plugins/core/MdastHTMLVisitor.ts — MIT © Petyo Ivanov
import { $createGenericHTMLNode, KnownHTMLTagType } from '../nodes/GenericHTMLNode'
import { MdastHTMLNode, isMdastHTMLNode } from '../nodes/MdastHTMLNode'
import { MdastImportVisitor } from '../types'

export const MdastHTMLVisitor: MdastImportVisitor<MdastHTMLNode> = {
  testNode: isMdastHTMLNode,
  visitNode: function ({ mdastNode, actions, lexicalParent }) {
    const firstAttribute = mdastNode.attributes[0]
    if (
      mdastNode.name === 'span' &&
      mdastNode.attributes.length === 1 &&
      firstAttribute &&
      firstAttribute.type === 'mdxJsxAttribute' &&
      firstAttribute.name === 'style'
    ) {
      actions.addStyle(String(firstAttribute.value), mdastNode)
      actions.visitChildren(mdastNode, lexicalParent)
    } else {
      actions.addAndStepInto(
        $createGenericHTMLNode(mdastNode.name as KnownHTMLTagType, mdastNode.type, mdastNode.attributes)
      )
    }
  },
  priority: -100
}
