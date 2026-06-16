// vendored from @mdxeditor/editor v3.55.0 src/plugins/frontmatter/LexicalFrontmatterVisitor.ts — MIT © Petyo Ivanov
import * as Mdast from 'mdast'
import { $isFrontmatterNode, FrontmatterNode } from '../nodes/FrontmatterNode'
import { LexicalExportVisitor } from '../types'

export const LexicalFrontmatterVisitor: LexicalExportVisitor<FrontmatterNode, Mdast.Yaml> = {
  testLexicalNode: $isFrontmatterNode,
  visitLexicalNode: ({ actions, lexicalNode }) => {
    actions.addAndStepInto('yaml', { value: lexicalNode.getYaml() })
  }
}
