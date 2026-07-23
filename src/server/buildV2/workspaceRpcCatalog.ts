/**
 * Build-local RPC documentation for workspace workers.
 *
 * This is deliberately derived from the exact materialized source state being
 * built. It is not a product census and is never authority input: the receiver's
 * live `@rpc` declaration remains the enforcement boundary. The sealed catalog
 * only lets caller-relative service discovery describe the provider bytes that
 * resolution will activate.
 */
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

export interface WorkspaceRpcMethodDoc {
  className: string;
  name: string;
  signature: string;
  description?: string;
  effect:
    | { kind: "runtime-intrinsic" }
    | { kind: "semantic"; capability: string }
    | { kind: "workspace-service" };
  access?: {
    principals?: string[];
    tier?: "open" | "gated" | "critical";
    sensitivity?: "read" | "write" | "admin" | "destructive";
    codeOnly?: boolean;
  };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIPPED_FILE = /(?:^|\.|-)(?:test|spec)\.[cm]?tsx?$/u;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !SKIPPED_FILE.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

function rpcDecorator(method: ts.MethodDeclaration): ts.CallExpression | null {
  const decorators = ts.canHaveDecorators(method) ? ts.getDecorators(method) : undefined;
  for (const decorator of decorators ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const callee = decorator.expression.expression;
    if (
      (ts.isIdentifier(callee) && callee.text === "rpc") ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "rpc")
    ) {
      return decorator.expression;
    }
  }
  return null;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) || !node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function literalString(expression: ts.Expression): string | null {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function accessOf(call: ts.CallExpression): WorkspaceRpcMethodDoc["access"] {
  const object = call.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const access: NonNullable<WorkspaceRpcMethodDoc["access"]> = {};
  for (const property of object.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) continue;
    if (name === "principals" && ts.isArrayLiteralExpression(property.initializer)) {
      const values = property.initializer.elements
        .map((element) => literalString(element as ts.Expression))
        .filter((value): value is string => value !== null);
      if (values.length === property.initializer.elements.length) access.principals = values;
    } else if (name === "tier") {
      const value = literalString(property.initializer);
      if (value === "open" || value === "gated" || value === "critical") access.tier = value;
    } else if (name === "sensitivity") {
      const value = literalString(property.initializer);
      if (value === "read" || value === "write" || value === "admin" || value === "destructive") {
        access.sensitivity = value;
      }
    } else if (name === "codeOnly") {
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) access.codeOnly = true;
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) access.codeOnly = false;
    }
  }
  return Object.keys(access).length > 0 ? access : undefined;
}

function effectOf(call: ts.CallExpression, label: string): WorkspaceRpcMethodDoc["effect"] {
  const object = call.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${label} must declare a literal RPC effect`);
  }
  const property = object.properties.find((candidate) => propertyName(candidate) === "effect");
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    !ts.isObjectLiteralExpression(property.initializer)
  ) {
    throw new Error(`${label} must declare a literal RPC effect`);
  }
  const kindProperty = property.initializer.properties.find(
    (candidate) => propertyName(candidate) === "kind"
  );
  const kind =
    kindProperty && ts.isPropertyAssignment(kindProperty)
      ? literalString(kindProperty.initializer)
      : null;
  if (kind === "runtime-intrinsic" || kind === "workspace-service") return { kind };
  if (kind === "semantic") {
    const capabilityProperty = property.initializer.properties.find(
      (candidate) => propertyName(candidate) === "capability"
    );
    const capability =
      capabilityProperty && ts.isPropertyAssignment(capabilityProperty)
        ? literalString(capabilityProperty.initializer)
        : null;
    if (capability && !capability.startsWith("rpc:")) return { kind, capability };
  }
  throw new Error(`${label} has an invalid literal RPC effect`);
}

function methodName(method: ts.MethodDeclaration): string | null {
  if (ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)) return method.name.text;
  return null;
}

function methodDescription(method: ts.MethodDeclaration): string | undefined {
  for (const doc of ts.getJSDocCommentsAndTags(method)) {
    if (!ts.isJSDoc(doc)) continue;
    if (typeof doc.comment === "string" && doc.comment.trim()) return doc.comment.trim();
    if (Array.isArray(doc.comment)) {
      const rendered = doc.comment
        .map((part: ts.JSDocComment) => part.text)
        .join("")
        .trim();
      if (rendered) return rendered;
    }
  }
  return undefined;
}

function signatureOf(method: ts.MethodDeclaration, source: ts.SourceFile): string {
  const typeParameters = method.typeParameters?.map((p) => p.getText(source)).join(", ");
  const params = method.parameters.map((p) => p.getText(source)).join(", ");
  const returns = method.type?.getText(source) ?? "unknown";
  return `${methodName(method) ?? "<computed>"}${typeParameters ? `<${typeParameters}>` : ""}(${params}): ${returns}`;
}

/** Extract `@rpc` public method docs from one exact materialized worker package. */
export function collectWorkspaceRpcCatalog(workerSourcePath: string): WorkspaceRpcMethodDoc[] {
  const methods: WorkspaceRpcMethodDoc[] = [];
  for (const file of sourceFiles(workerSourcePath)) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const decorator = rpcDecorator(member);
          const name = methodName(member);
          if (!decorator || !name) continue;
          const description = methodDescription(member);
          const access = accessOf(decorator);
          const effect = effectOf(decorator, `${path.relative(workerSourcePath, file)}:${name}`);
          methods.push({
            className: node.name.text,
            name,
            signature: signatureOf(member, source),
            effect,
            ...(description ? { description } : {}),
            ...(access ? { access } : {}),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return methods.sort(
    (a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)
  );
}
