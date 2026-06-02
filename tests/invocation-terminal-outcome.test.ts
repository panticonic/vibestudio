import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const ROOTS = [
  "packages/harness/src",
  "workspace/packages/agentic-chat",
  "workspace/packages/agentic-core",
  "workspace/packages/agentic-do",
  "workspace/packages/agentic-protocol",
  "workspace/packages/pubsub/src",
  "workspace/workers/gad-store",
  "workspace/workers/pubsub-channel",
  "workspace/workers/test-agent",
] as const;

const TERMINAL_KIND_OUTCOMES = {
  "invocation.completed": new Set(["success"]),
  "invocation.failed": new Set(["tool_error", "infrastructure_error"]),
  "invocation.cancelled": new Set(["cancelled", "stale_dispatch"]),
  "invocation.abandoned": new Set(["abandoned"]),
} as const;

const TERMINAL_KIND_HELPERS = {
  "invocation.completed": new Set(["invocationCompletedPayload"]),
  "invocation.failed": new Set(["invocationFailedPayload"]),
  "invocation.cancelled": new Set([
    "invocationCancelledPayload",
    "invocationCancelledPayloadValue",
  ]),
  "invocation.abandoned": new Set(["invocationAbandonedPayload"]),
} as const;

type TerminalKind = keyof typeof TERMINAL_KIND_OUTCOMES;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      out.push(...tsFiles(path));
    } else if (/\.(?:ts|tsx)$/u.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) === name) return property.initializer;
  }
  return null;
}

function stringLiteralValue(expression: ts.Expression): string | null {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function terminalKindValue(object: ts.ObjectLiteralExpression): TerminalKind | null {
  const value = propertyValue(object, "kind");
  if (!value) return null;
  const kind = stringLiteralValue(value);
  return kind && kind in TERMINAL_KIND_OUTCOMES ? (kind as TerminalKind) : null;
}

function isSchemaRejectionFixture(node: ts.Node, source: string): boolean {
  return /schema rejection fixture/u.test(source.slice(node.getFullStart(), node.getEnd()));
}

function hasValidTerminalPayloadSignal(node: ts.Node, kind: TerminalKind): boolean {
  let valid = false;
  const allowedOutcomes = TERMINAL_KIND_OUTCOMES[kind];
  const allowedHelpers = TERMINAL_KIND_HELPERS[kind];

  function visit(current: ts.Node): void {
    if (valid) return;
    if (ts.isPropertyAssignment(current) && propertyNameText(current.name) === "terminalOutcome") {
      const outcome = stringLiteralValue(current.initializer);
      if (outcome && allowedOutcomes.has(outcome as never)) valid = true;
      return;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee) && allowedHelpers.has(callee.text as never)) {
        valid = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return valid;
}

describe("invocation terminal event literals", () => {
  it("carry a typed terminal outcome matching their exact event kind", () => {
    const misses: string[] = [];
    for (const root of ROOTS) {
      for (const file of tsFiles(join(process.cwd(), root))) {
        const source = readFileSync(file, "utf8");
        const sourceFile = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        function visit(node: ts.Node): void {
          if (ts.isObjectLiteralExpression(node)) {
            const kind = terminalKindValue(node);
            if (kind) {
              const payload = propertyValue(node, "payload");
              if (
                !isSchemaRejectionFixture(node, source) &&
                (!payload || !hasValidTerminalPayloadSignal(payload, kind))
              ) {
                const line = sourceFile.getLineAndCharacterOfPosition(
                  node.getStart(sourceFile)
                ).line;
                misses.push(`${relative(process.cwd(), file)}:${line + 1}`);
              }
            }
          }
          ts.forEachChild(node, visit);
        }

        visit(sourceFile);
      }
    }

    expect(misses).toEqual([]);
  });
});
