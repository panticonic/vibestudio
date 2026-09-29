import { createRequire } from "node:module";
import { svelte2tsx } from "svelte2tsx";
import { parse } from "svelte/compiler";
import ts from "typescript";

const require = createRequire(import.meta.url);

/** Svelte owns its source grammar; the host's TypeScript 7 owns typechecking. */
export function compileSvelteTypeSource(source: string, filename: string) {
  const ast = parse(source, { modern: true });
  const isTypeScript = [ast.instance, ast.module].some(script => script?.attributes.some(attribute =>
    attribute.type === "Attribute" && attribute.name === "lang" && Array.isArray(attribute.value) &&
    attribute.value.some(value => value.type === "Text" && (value.data === "ts" || value.data === "typescript"))
  ));
  return { ...svelte2tsx(source, { filename, mode: "ts", isTsFile: isTypeScript, emitJsDoc: !isTypeScript }), isTypeScript };
}

export const svelteTypeEnvironmentFiles = [
  require.resolve("svelte2tsx/svelte-shims-v4.d.ts"),
  require.resolve("svelte2tsx/svelte-jsx-v4.d.ts"),
];

/** Concrete compiled components own their types; an ambient wildcard cannot prove a source exists. */
export function projectSvelteDeclarations(source: string, filename: string): string {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let result = source;
  for (const node of [...ast.statements].reverse()) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === "*.svelte") {
      // Preserve positions in the rest of the runtime declaration file.
      result = result.slice(0, node.pos) + result.slice(node.pos, node.end).replace(/[^\r\n]/gu, " ") + result.slice(node.end);
    }
  }
  return result;
}
