import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseBabel, type ParserPlugin } from "@babel/parser";
import { init, parse } from "es-module-lexer";

await init;

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
  const imports = new Set<string>();
  let references: ReturnType<typeof parse>[0];
  try {
    [references] = parse(text);
  } catch (error) {
    return sharedImportsFromAst(file, text, error);
  }
  for (const reference of references) {
    if (reference.n?.startsWith("@vibestudio/shared/")) {
      imports.add(`./${reference.n.slice("@vibestudio/shared/".length)}`);
    }
  }
  return [...imports];
}

function sharedImportsFromAst(file: string, text: string, lexerError: unknown): string[] {
  const extension = path.extname(file);
  const plugins: ParserPlugin[] = [
    "decorators-legacy",
    "importAttributes",
    "explicitResourceManagement",
  ];
  if ([".ts", ".tsx", ".mts"].includes(extension)) plugins.push("typescript");
  if (extension === ".tsx" || extension === ".js") plugins.push("jsx");
  let ast: ReturnType<typeof parseBabel>;
  try {
    ast = parseBabel(text, { sourceType: "unambiguous", errorRecovery: true, plugins });
  } catch (error) {
    throw new Error(`Could not inspect imports in ${path.relative(ROOT, file)}`, {
      cause: new AggregateError([lexerError, error]),
    });
  }
  const imports = new Set<string>();
  const visit = (value: unknown, parent?: Record<string, unknown>, parentKey?: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, parent, parentKey);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const parentType = parent?.["type"];
    const moduleReference =
      ((parentType === "ImportDeclaration" ||
        parentType === "ExportNamedDeclaration" ||
        parentType === "ExportAllDeclaration") &&
        parentKey === "source") ||
      (parentType === "TSImportType" && parentKey === "argument") ||
      (parentType === "ImportExpression" && parentKey === "source") ||
      (parentType === "CallExpression" &&
        parentKey === "arguments" &&
        ((parent?.["callee"] as { type?: string } | undefined)?.type === "Import" ||
          ((parent?.["callee"] as { type?: string; name?: string } | undefined)?.type ===
            "Identifier" &&
            (parent?.["callee"] as { name?: string } | undefined)?.name === "require")));
    if (
      moduleReference &&
      record["type"] === "StringLiteral" &&
      typeof record["value"] === "string" &&
      record["value"].startsWith("@vibestudio/shared/")
    ) {
      imports.add(`./${record["value"].slice("@vibestudio/shared/".length)}`);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "loc" && key !== "start" && key !== "end") visit(child, record, key);
    }
  };
  visit(ast.program);
  return [...imports];
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
