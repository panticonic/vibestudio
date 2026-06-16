// vendored from @mdxeditor/editor v3.55.0 src/plugins/headings/MdastHeadingVisitor.ts — MIT © Petyo Ivanov
import { $createHeadingNode, HeadingTagType } from '@lexical/rich-text'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastHeadingVisitor: MdastImportVisitor<Mdast.Heading> = {
  testNode: 'heading',
  visitNode: function ({ mdastNode, actions }) {
    actions.addAndStepInto($createHeadingNode(`h${mdastNode.depth}` as HeadingTagType))
  }
}
