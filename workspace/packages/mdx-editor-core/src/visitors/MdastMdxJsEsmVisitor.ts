// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/MdastMdxJsEsmVisitor.ts — MIT © Petyo Ivanov
import { MdxjsEsm } from 'mdast-util-mdx'
import { MdastImportVisitor } from '../types'

export const MdastMdxJsEsmVisitor: MdastImportVisitor<MdxjsEsm> = {
  testNode: 'mdxjsEsm',
  visitNode() {
    // Imports are processed on the metadata level. The actual lexical nodes are not needed.
  }
}
