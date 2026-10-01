import path from "node:path";
import fs from "node:fs";
import * as ts from "typescript/unstable/ast";
import { TypeScriptSyntaxService } from "@vibestudio/typecheck";

/** Project the public source contract, never the differently shaped wire API.
 * These declarations describe types; they do not pretend to be JSON validators. */
export function runtimeClientCatalog({ root, files, interfaceName, namespace, moduleName }) {
  const syntax = new TypeScriptSyntaxService(path.join(root, ".runtime-doc-syntax"), ["ts"]);
  try {
    const declarations = new Map();
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const parsed = syntax.analyze(text, ([source]) =>
        source.statements.flatMap((node) => {
          if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) return [];
          const references = new Set();
          const visit = (child) => {
            if (ts.isTypeReferenceNode(child)) references.add(child.typeName.getText());
            child.forEachChild(visit);
          };
          visit(node);
          return [
            {
              name: node.name.text,
              text: node.getText(),
              references: [...references],
              methods: ts.isInterfaceDeclaration(node)
                ? node.members
                    .filter((member) => member.kind === ts.SyntaxKind.MethodSignature)
                    .map((method) => ({
                      name: method.name.getText(),
                      signature: method.getText().replace(/;$/, ""),
                      argumentNames: method.parameters.map((p) => p.name.getText()),
                      references: (() => {
                        const names = new Set();
                        const visit = (n) => {
                          if (ts.isTypeReferenceNode(n)) names.add(n.typeName.getText());
                          n.forEachChild(visit);
                        };
                        visit(method);
                        return [...names];
                      })(),
                    }))
                : [],
            },
          ];
        })
      );
      for (const declaration of parsed) {
        if (declarations.has(declaration.name))
          throw new Error(`Ambiguous runtime type ${declaration.name}`);
        declarations.set(declaration.name, declaration);
      }
    }
    const contract = declarations.get(interfaceName);
    if (!contract?.methods.length)
      throw new Error(`Missing public runtime interface ${interfaceName}`);
    return Object.fromEntries(
      contract.methods.map((method) => {
        const seen = new Set([interfaceName]);
        const definitions = [];
        const pending = [...method.references];
        while (pending.length) {
          const name = pending.shift();
          if (seen.has(name)) continue;
          seen.add(name);
          const declaration = declarations.get(name);
          if (!declaration) continue; // platform types and types exported by dependencies
          definitions.push(declaration.text);
          pending.push(...declaration.references);
        }
        return [
          method.name,
          {
            signature: `${namespace}.${method.signature}`,
            argumentNames: method.argumentNames,
            description:
              `Public source contract from ${moduleName}. Referenced dependency types retain their source names and imports.\n` +
              (definitions.length ? `\n\`\`\`ts\n${definitions.join("\n\n")}\n\`\`\`` : ""),
          },
        ];
      })
    );
  } finally {
    syntax.dispose();
  }
}
