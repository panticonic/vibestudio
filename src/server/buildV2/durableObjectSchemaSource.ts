import * as crypto from "crypto";
import * as path from "node:path";
import * as ts from "typescript/unstable/ast";
import { usingTypeScriptProject } from "@vibestudio/typecheck";

export interface SchemaMigrationSourceModule {
  moduleId: string;
  format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
  source: string;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (
    !ts.isPropertyAssignment(node) &&
    !ts.isShorthandPropertyAssignment(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return null;
  }
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
  if (ts.isStringLiteralLikeNode(value)) return value.text;
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
  usingTypeScriptProject(
    modules.map((module) => ({
      fileName: path.resolve(module.moduleId),
      content: module.source,
    })),
    (project) => {
      for (const module of modules) {
        const sourceFile = project.program.getSourceFile(path.resolve(module.moduleId));
        if (!sourceFile) throw new Error(`TypeScript did not parse ${module.moduleId}`);
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
          node.forEachChild(visitMigration);
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
          node.forEachChild(visitClass);
        };
        visitClass(sourceFile);
      }
    }
  );
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
