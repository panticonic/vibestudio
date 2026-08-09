// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/MdastMdxJsEsmVisitor.ts — MIT © Petyo Ivanov
import { MdxjsEsm } from 'mdast-util-mdx'
import type { ElementNode } from 'lexical'
import { $createLexicalMdxEsmNode } from '../nodes/LexicalMdxEsmNode'
import { MdastImportVisitor } from '../types'

export const MdastMdxJsEsmVisitor: MdastImportVisitor<MdxjsEsm> = {
  testNode: 'mdxjsEsm',
  visitNode({ lexicalParent, mdastNode }) {
    // Imports are still gathered as descriptor metadata by importMarkdownToLexical,
    // but the authored ESM block must also remain in the tree. Treating it only
    // as metadata silently deleted exports and unused imports on serialization.
    const parent = lexicalParent as ElementNode
    parent.append($createLexicalMdxEsmNode(mdastNode.value))
  }
}
