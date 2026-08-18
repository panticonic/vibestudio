import { parentPort } from "node:worker_threads";
import { transformSync, types as babelTypes, type PluginObj } from "@babel/core";
// This Babel plugin does not publish TypeScript declarations; Babel's PluginItem
// contract is enforced at the transform call below.
// @ts-expect-error missing upstream declarations
import transformModulesCommonJs from "@babel/plugin-transform-modules-commonjs";

type Request = { id: number; source: string };

const controlledDynamicImportPlugin: PluginObj = {
  name: "vibestudio-controlled-dynamic-import",
  visitor: {
    CallExpression(callPath) {
      if (callPath.node.callee.type !== "Import") return;
      callPath.replaceWith(
        babelTypes.callExpression(babelTypes.identifier("__vibestudioImport"), [
          ...callPath.node.arguments,
        ])
      );
    },
  },
};

export function lowerLibraryModule(source: string): string {
  const code = transformSync(source, {
    babelrc: false,
    configFile: false,
    sourceType: "module",
    plugins: [controlledDynamicImportPlugin, [transformModulesCommonJs, { strictMode: true }]],
    compact: false,
    comments: true,
    ast: false,
    code: true,
  })?.code;
  if (!code) throw new Error("library module lowering produced no output");
  return code;
}

const port = parentPort;
if (port) {
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (request: Request) => {
    queue = queue.then(() => {
      try {
        port.postMessage({ id: request.id, result: lowerLibraryModule(request.source) });
      } catch (error) {
        port.postMessage({
          id: request.id,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { name: "Error", message: String(error) },
        });
      }
    });
  });
}
