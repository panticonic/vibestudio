// vendored from @mdxeditor/editor v3.55.0 src/plugins/thematic-break/LexicalThematicBreakVisitor.ts — MIT © Petyo Ivanov
import { $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import * as Mdast from 'mdast'
import { LexicalExportVisitor } from '../types'

export const LexicalThematicBreakVisitor: LexicalExportVisitor<HorizontalRuleNode, Mdast.ThematicBreak> = {
  testLexicalNode: $isHorizontalRuleNode,
  visitLexicalNode({ actions }) {
    actions.addAndStepInto('thematicBreak')
  }
}
