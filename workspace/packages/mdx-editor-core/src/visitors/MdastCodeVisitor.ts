// vendored from @mdxeditor/editor v3.55.0 src/plugins/codeblock/MdastCodeVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { $createCodeBlockNode } from '../nodes/CodeBlockNode'
import { MdastImportVisitor } from '../types'

export const MdastCodeVisitor: MdastImportVisitor<Mdast.Code> = {
  testNode: (node, { codeBlockEditorDescriptors }) => {
    if (node.type === 'code') {
      const descriptor = codeBlockEditorDescriptors.find((descriptor) =>
        descriptor.match((node as Mdast.Code).lang, (node as Mdast.Code).meta)
      )
      return descriptor !== undefined
    }
    return false
  },
  visitNode({ mdastNode, actions }) {
    actions.addAndStepInto(
      $createCodeBlockNode({
        code: mdastNode.value,
        language: mdastNode.lang ?? '',
        meta: mdastNode.meta ?? ''
      })
    )
  }
}
