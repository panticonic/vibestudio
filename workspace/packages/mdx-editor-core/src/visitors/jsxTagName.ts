// vendored from @mdxeditor/editor v3.55.0 src/plugins/jsx/jsxTagName.ts — MIT © Petyo Ivanov
import { htmlTags } from '../nodes/MdastHTMLNode'

export function isHtmlTagName(name: string): boolean {
  return htmlTags.includes(name)
}
