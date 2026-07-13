import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SOURCE_ROOTS = ["src", "packages", "apps", "workspace", "scripts", "tests"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(file));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(file);
  }
  return out;
}

function sharedImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("@vibestudio/shared/")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith("@vibestudio/shared/")) {
      imports.push(`./${node.text.slice("@vibestudio/shared/".length)}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function exportedTarget(subpath: string, exportsMap: Record<string, string>): string | undefined {
  const exact = exportsMap[subpath];
  if (exact) return exact;
  for (const [key, target] of Object.entries(exportsMap)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const match = subpath.slice(prefix.length, subpath.length - suffix.length);
    return target.replace("*", match);
  }
  return undefined;
}

describe("@vibestudio/shared exports", () => {
  it("has no unrestricted package-wide wildcard", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "packages/shared/package.json"), "utf8")
    ) as { exports: Record<string, string> };
    expect(pkg.exports["./*"]).toBeUndefined();
  });

  it("exports every subpath imported by repository source", () => {
    const packageDir = path.join(ROOT, "packages/shared");
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    const missing: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(path.join(ROOT, root))) {
        for (const subpath of sharedImports(file)) {
          const target = exportedTarget(subpath, pkg.exports);
          if (!target || !fs.existsSync(path.resolve(packageDir, target))) {
            missing.push(`${path.relative(ROOT, file)}: ${subpath}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
