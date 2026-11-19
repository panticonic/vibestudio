import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { docComment } from "./json-schema-declarations.mjs";

function unwrap(node) {
  return node.type === "ExportNamedDeclaration" ? node.declaration : node;
}

function sourceFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parse(text, { sourceType: "module", plugins: ["typescript"] });
  return { file, text, statements: parsed.program.body.map(unwrap).filter(Boolean) };
}

function resolveTypeFile(from, reference) {
  if (!reference.startsWith(".")) {
    throw new Error(`Authored service type imports must be relative: ${reference} in ${from.file}`);
  }
  const file = path.resolve(path.dirname(from.file), reference);
  return file.replace(/\.js$/u, ".ts");
}

function render(node, from) {
  return from.text.slice(node.start, node.end).replace(/import\(["'][^"']+["']\)\./gu, "");
}

function serviceDeclaration(file, name) {
  const source = sourceFile(file);
  const declaration = source.statements
    .filter((node) => node.type === "TSModuleDeclaration" && node.id.value === "natlang:services")
    .flatMap((node) => node.body.body.map(unwrap))
    .filter((node) => node?.type === "VariableDeclaration")
    .flatMap((node) => node.declarations)
    .find((node) => node.id.type === "Identifier" && node.id.name === name);
  const type = declaration?.id.typeAnnotation?.typeAnnotation;
  if (type?.type !== "TSTypeLiteral") {
    throw new Error(`Declare ${name} as an object of service methods in ${file}`);
  }
  return { source, members: type.members };
}

/** Use the owning template's authored types while retaining the central method allowlist. */
export function renderAuthoredService(entry, file) {
  const { source, members } = serviceDeclaration(file, entry.name);
  const types = new Map();
  const imported = new Map([[file, source]]);
  const visited = new Set();
  function load(from, reference) {
    const resolved = resolveTypeFile(from, reference);
    if (!imported.has(resolved)) imported.set(resolved, sourceFile(resolved));
    return imported.get(resolved);
  }
  function includeType(from, name) {
    const key = from.file + ":" + name;
    if (visited.has(key)) return;
    visited.add(key);
    const declaration = from.statements.find(
      (node) =>
        (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") &&
        node.id.name === name
    );
    if (declaration) {
      collect(declaration, from);
      const text = render(declaration, from);
      if (types.has(name) && types.get(name) !== text)
        throw new Error(`Conflicting type ${name} in service ${entry.name}`);
      types.set(name, text);
      return;
    }
    for (const node of from.statements) {
      if (node.type !== "ImportDeclaration") continue;
      const match = node.specifiers.find(
        (specifier) => specifier.type === "ImportSpecifier" && specifier.local.name === name
      );
      if (!match) continue;
      const original = match.imported.name ?? match.imported.value;
      includeType(load(from, node.source.value), original);
      if (name !== original) types.set(name, `type ${name} = ${original};`);
      return;
    }
  }
  function collect(node, from) {
    if (node.type === "TSTypeReference" && node.typeName.type === "Identifier")
      includeType(from, node.typeName.name);
    if (
      node.type === "TSImportType" &&
      node.qualifier?.type === "Identifier" &&
      node.argument.type === "StringLiteral"
    ) {
      includeType(load(from, node.argument.value), node.qualifier.name);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string")
          collect(child, from);
      }
    }
  }
  const methods = entry.methods.map(({ name, params, description }) => {
    const method = members.find(
      (member) =>
        member.type === "TSMethodSignature" && !member.computed && member.key.name === name
    );
    if (
      !method ||
      JSON.stringify(method.parameters.map((param) => param.name)) !== JSON.stringify(params)
    )
      throw new Error(
        `Service ${entry.name}.${name} does not match its authored signature in ${file}`
      );
    collect(method, source);
    return `${docComment(description ?? entry.summary)}\nexport function ${render(method, source).replace(/;?$/u, ";")}`;
  });
  if (members.length !== methods.length)
    throw new Error(`Register every declared method of ${entry.name} in the service catalog`);
  return [docComment(entry.summary), ...types.values(), ...methods].join("\n\n");
}
