// vendored from @mdxeditor/editor v3.55.0 src/plugins/thematic-break/MdastThematicBreakVisitor.ts — MIT © Petyo Ivanov
import { $createHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import * as Mdast from 'mdast'
import { MdastImportVisitor } from '../types'

export const MdastThematicBreakVisitor: MdastImportVisitor<Mdast.ThematicBreak> = {
  testNode: 'thematicBreak',
  visitNode({ actions }) {
    actions.addAndStepInto($createHorizontalRuleNode())
  }
}
