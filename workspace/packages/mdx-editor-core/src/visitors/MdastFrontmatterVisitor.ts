// vendored from @mdxeditor/editor v3.55.0 src/plugins/frontmatter/MdastFrontmatterVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { $createFrontmatterNode } from '../nodes/FrontmatterNode'
import { MdastImportVisitor } from '../types'

export const MdastFrontmatterVisitor: MdastImportVisitor<Mdast.Yaml> = {
  testNode: 'yaml',
  visitNode({ mdastNode, actions }) {
    actions.addAndStepInto($createFrontmatterNode(mdastNode.value))
  }
}
