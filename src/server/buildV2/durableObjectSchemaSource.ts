import * as crypto from "crypto";
import ts from "typescript";

export interface SchemaMigrationSourceModule {
  moduleId: string;
  format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
  source: string;
}

function scriptKind(format: SchemaMigrationSourceModule["format"]): ts.ScriptKind {
  if (format === "tsx") return ts.ScriptKind.TSX;
  if (format === "jsx") return ts.ScriptKind.JSX;
  if (format === "js" || format === "mjs" || format === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function literalProperty(node: ts.ObjectLiteralExpression, name: string): string | number | null {
  const property = node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate) === name
  );
  if (!property) return null;
  const value = property.initializer;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  return null;
}

/**
 * Hash one exact pre-bundle migration-definition source span.
 *
 * Literal version/name fields are deliberate: publication immutability must
 * remain reviewable in repository source. Indirect or duplicate definitions
 * fail closed instead of widening the digest to an unrelated module.
 */
export function migrationDefinitionSourceDigest(
  modules: readonly SchemaMigrationSourceModule[],
  input: { className: string; version: number; name: string }
): string {
  const matches: Array<{ moduleId: string; text: string }> = [];
  for (const module of modules) {
    const sourceFile = ts.createSourceFile(
      module.moduleId,
      module.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(module.format)
    );
    const visitMigration = (node: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(node) &&
        literalProperty(node, "version") === input.version &&
        literalProperty(node, "name") === input.name &&
        node.properties.some((property) => propertyName(property) === "validateSource") &&
        node.properties.some((property) => propertyName(property) === "migrate")
      ) {
        matches.push({
          moduleId: module.moduleId,
          text: module.source.slice(node.getStart(sourceFile), node.getEnd()),
        });
      }
      ts.forEachChild(node, visitMigration);
    };
    const visitClass = (node: ts.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
        node.name?.text === input.className
      ) {
        const method = node.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            ((ts.isIdentifier(member.name) && member.name.text === "schemaMigrations") ||
              (ts.isStringLiteral(member.name) && member.name.text === "schemaMigrations"))
        );
        if (method) visitMigration(method);
      }
      ts.forEachChild(node, visitClass);
    };
    visitClass(sourceFile);
  }
  if (matches.length !== 1) {
    const reason =
      matches.length === 0 ? "no literal definition was found" : "definitions are ambiguous";
    throw new Error(
      `${input.className} migration v${input.version} (${input.name}) has no exact source digest: ${reason}. ` +
        `Declare it inline in ${input.className}.schemaMigrations() with literal version/name, validateSource, and migrate fields.`
    );
  }
  return crypto.createHash("sha256").update(matches[0]!.text, "utf8").digest("hex");
}
