import { parse, type ParserPlugin } from "@babel/parser";

export type ModuleImportSyntax = "import" | "export" | "dynamic-import" | "require";
export type ModuleImportKind = "value" | "type";

export interface ModuleImportReference {
  specifier: string;
  syntax: ModuleImportSyntax;
  kind: ModuleImportKind;
  named: string[];
  hasDefault: boolean;
  hasNamespace: boolean;
  offset: number;
  line: number;
  column: number;
}

type AstNode = {
  type: string;
  start?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

type NamedNode = AstNode & { name: string };
type StringNode = AstNode & { value: string };

const PARSER_PLUGINS: ParserPlugin[] = [
  "typescript",
  "jsx",
  "decorators-legacy",
  "importAttributes",
  "explicitResourceManagement",
];

const BARE_NODE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isStringNode(value: unknown): value is StringNode {
  return (
    isAstNode(value) &&
    (value.type === "StringLiteral" || value.type === "Literal") &&
    typeof value["value"] === "string"
  );
}

function importedName(value: unknown): string | null {
  if (!isAstNode(value)) return null;
  if (value.type === "Identifier" && typeof value["name"] === "string") {
    return (value as NamedNode).name;
  }
  return isStringNode(value) ? value.value : null;
}

function reference(
  sourceNode: StringNode,
  syntax: ModuleImportSyntax,
  shape: Pick<ModuleImportReference, "kind" | "named" | "hasDefault" | "hasNamespace">
): ModuleImportReference {
  return {
    specifier: sourceNode.value,
    syntax,
    ...shape,
    offset: sourceNode.start ?? 0,
    line: sourceNode.loc?.start.line ?? 1,
    column: (sourceNode.loc?.start.column ?? 0) + 1,
  };
}

function isTypeOnly(kind: unknown): boolean {
  return kind === "type" || kind === "typeof";
}

function analyzeStaticDeclaration(node: AstNode): ModuleImportReference | null {
  const source = node["source"];
  if (!isStringNode(source)) return null;

  if (node.type === "ExportAllDeclaration") {
    return reference(source, "export", {
      kind: isTypeOnly(node["exportKind"]) ? "type" : "value",
      named: [],
      hasDefault: false,
      // This field means a namespace binding (`import * as ns`), not a
      // wildcard re-export.
      hasNamespace: false,
    });
  }

  const specifiers = Array.isArray(node["specifiers"]) ? node["specifiers"].filter(isAstNode) : [];
  const declarationKind =
    node.type === "ImportDeclaration" ? node["importKind"] : node["exportKind"];
  if (isTypeOnly(declarationKind)) {
    return reference(source, node.type === "ImportDeclaration" ? "import" : "export", {
      kind: "type",
      named: [],
      hasDefault: false,
      hasNamespace: false,
    });
  }

  const named: string[] = [];
  let hasDefault = false;
  let hasNamespace = false;
  for (const specifier of specifiers) {
    if (isTypeOnly(specifier["importKind"]) || isTypeOnly(specifier["exportKind"])) {
      continue;
    }
    if (specifier.type === "ImportDefaultSpecifier") {
      hasDefault = true;
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      hasNamespace = true;
    } else if (specifier.type === "ImportSpecifier") {
      const name = importedName(specifier["imported"]);
      if (name) named.push(name);
    } else if (specifier.type === "ExportSpecifier") {
      const name = importedName(specifier["local"]);
      if (name) named.push(name);
    }
  }

  const sideEffectImport = node.type === "ImportDeclaration" && specifiers.length === 0;
  return reference(source, node.type === "ImportDeclaration" ? "import" : "export", {
    kind: sideEffectImport || hasDefault || hasNamespace || named.length > 0 ? "value" : "type",
    named,
    hasDefault,
    hasNamespace,
  });
}

function analyzeExpression(node: AstNode): ModuleImportReference | null {
  if (node.type === "ImportExpression" && isStringNode(node["source"])) {
    return reference(node["source"], "dynamic-import", {
      kind: "value",
      named: [],
      hasDefault: false,
      hasNamespace: true,
    });
  }
  if (node.type === "TSImportType" && isStringNode(node["argument"])) {
    return reference(node["argument"], "dynamic-import", {
      kind: "type",
      named: [],
      hasDefault: false,
      hasNamespace: true,
    });
  }
  if (node.type === "TSImportEqualsDeclaration") {
    const moduleReference = node["moduleReference"];
    const expression =
      isAstNode(moduleReference) && moduleReference.type === "TSExternalModuleReference"
        ? moduleReference["expression"]
        : null;
    if (isStringNode(expression)) {
      return reference(expression, "require", {
        kind: isTypeOnly(node["importKind"]) ? "type" : "value",
        named: [],
        hasDefault: true,
        hasNamespace: false,
      });
    }
  }
  if (node.type !== "CallExpression") return null;

  const callee = node["callee"];
  const syntax: ModuleImportSyntax | null =
    isAstNode(callee) && callee.type === "Import"
      ? "dynamic-import"
      : isAstNode(callee) && callee.type === "Identifier" && callee["name"] === "require"
        ? "require"
        : null;
  const args = Array.isArray(node["arguments"]) ? node["arguments"] : [];
  const source = args[0];
  if (!syntax || !isStringNode(source)) return null;
  return reference(source, syntax, {
    kind: "value",
    named: [],
    hasDefault: false,
    hasNamespace: true,
  });
}

function visitAst(value: unknown, visit: (node: AstNode) => void, seen: Set<object>): void {
  if (Array.isArray(value)) {
    for (const child of value) visitAst(child, visit, seen);
    return;
  }
  if (!isAstNode(value) || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "loc" ||
      key === "extra" ||
      key === "leadingComments" ||
      key === "innerComments" ||
      key === "trailingComments"
    ) {
      continue;
    }
    visitAst(child, visit, seen);
  }
}

/**
 * Parse JavaScript, TypeScript, JSX, and TSX module references without
 * evaluating source. All expression boundaries come from Babel's grammar;
 * import-looking text in strings, comments, templates, and regexes is never
 * interpreted as code.
 */
export function analyzeModuleImports(source: string): ModuleImportReference[] {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: PARSER_PLUGINS,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
  });
  const references: ModuleImportReference[] = [];
  visitAst(
    ast.program,
    (node) => {
      const found =
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration"
          ? analyzeStaticDeclaration(node)
          : analyzeExpression(node);
      if (found) references.push(found);
    },
    new Set()
  );
  return references.sort((left, right) => left.offset - right.offset);
}

export function moduleCoordinate(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("cloudflare:") ||
    BARE_NODE_BUILTINS.has(specifier)
  ) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] || null;
}

export function definitelyTypedCoordinate(coordinate: string): string {
  if (!coordinate.startsWith("@")) return `@types/${coordinate}`;
  const [scope, name] = coordinate.slice(1).split("/");
  return `@types/${scope}__${name}`;
}
