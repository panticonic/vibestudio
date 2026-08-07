#!/usr/bin/env node
// Host/workspace boundary checker.
//
// Enforces the host/userland boundary:
//
//   - HOST code (src/, packages/, apps/, scripts/, tests/, build.mjs) must never
//     depend on or assume WORKSPACE (userland, workspace/) code beyond defined
//     interfaces. Package scope is never residency evidence.
//   - WORKSPACE code must never import host-private implementation roots
//     (`src/`, `apps/`, `scripts/`, or root `tests/`). Shared public packages
//     such as `@vibestudio/shared` are intentionally not host-private.
//
// Three finding categories are produced:
//
//   1. "import-violation" - a hard dependency: an ES `import`/`export ... from`,
//      a dynamic `import(...)`, or a CommonJS `require(...)` whose specifier
//      either sits in a `@workspace` scope (`@workspace/...`, `@workspace-apps/...`,
//      `@workspace-panels/...`, etc.) or is a relative path that resolves into
//      `workspace/`. These are always real violations.
//
//   2. "workspace-host-import" - a workspace file importing a relative path that
//      resolves into a host-private root. This is always a real violation.
//
//   3. "workspace-package-identity" - a package physically owned by workspace/
//      declaring an @vibestudio/* package name. Workspace-owned packages use
//      the @workspace* scopes; @vibestudio/* is reserved for host-supplied
//      platform packages.
//
// Cross-boundary integration tests live under `tests/workspace-integration/`;
// that neutral harness is intentionally excluded from both directions.
//
// Dependency-free apart from `typescript` (already a repo dependency).

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const DEFAULT_ROOT = process.cwd();

// Host-side roots scanned recursively, plus individual files.
const HOST_SCANNED_ROOTS = ["src", "packages", "apps", "scripts", "tests"];
const HOST_SCANNED_FILES = ["build.mjs"];
const WORKSPACE_SCANNED_ROOTS = ["workspace"];
const HOST_PRIVATE_IMPORT_ROOTS = ["src", "apps", "scripts", "tests"];
const NEUTRAL_BOUNDARY_TEST_ROOTS = new Set(["tests/workspace-integration"]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "dist-publish", ".git"]);

const SELF_FILES = new Set(["scripts/check-host-workspace-imports.mjs"]);
// ---------------------------------------------------------------------------
// Pure matching helpers (exported for unit testing).
// ---------------------------------------------------------------------------

// A `@workspace` module scope, including the hyphenated variants the repo uses
// (@workspace-apps, @workspace-panels, @workspace-about, @workspace-workers,
// @workspace-skills, @workspace-extensions, @workspace-packages). We require a
// trailing "/" because a real import/export specifier always has a subpath.
const WORKSPACE_IMPORT_SCOPE_RE = /^@workspace(-[a-z-]+)?\//;

/** True if `specifier` is an import/export/require target inside a workspace scope. */
export function isWorkspaceImportScope(specifier) {
  return WORKSPACE_IMPORT_SCOPE_RE.test(specifier);
}

/**
 * True if `specifier`, resolved relative to `absFile`, lands inside `workspaceRoot`
 * (an absolute path ending in a path separator). Used for both relative import
 * specifiers and path-like string literals.
 */
export function resolvesIntoWorkspace(absFile, specifier, workspaceRoot) {
  const resolved = path.resolve(path.dirname(absFile), specifier);
  return resolved === workspaceRoot.slice(0, -1) || resolved.startsWith(workspaceRoot);
}

export function resolvesIntoAnyRoot(absFile, specifier, roots) {
  const resolved = path.resolve(path.dirname(absFile), specifier);
  return roots.some((root) => resolved === root.slice(0, -1) || resolved.startsWith(root));
}

function moduleReferences(text, absFile) {
  const plugins = ["decorators-legacy", "importAttributes", "explicitResourceManagement"];
  if (/\.[cm]?tsx?$/u.test(absFile)) {
    plugins.push(["typescript", { dts: absFile.endsWith(".d.ts") }]);
  }
  if (/\.(?:tsx|jsx|js)$/u.test(absFile)) plugins.push("jsx");
  let ast;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      plugins,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      createImportExpressions: true,
    });
  } catch (error) {
    throw new Error(`Could not inspect imports in ${absFile}`, { cause: error });
  }
  const references = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object" || typeof value.type !== "string") return;
    let source;
    if (
      value.type === "ImportDeclaration" ||
      value.type === "ExportNamedDeclaration" ||
      value.type === "ExportAllDeclaration"
    ) {
      source = value.source;
    } else if (value.type === "ImportExpression") {
      source = value.source;
    } else if (
      value.type === "CallExpression" &&
      (value.callee?.type === "Import" ||
        (value.callee?.type === "Identifier" && value.callee.name === "require"))
    ) {
      source = value.arguments?.[0];
    }
    if (source?.type === "StringLiteral") {
      references.push({ specifier: source.value, line: source.loc?.start.line ?? 1 });
    }
    for (const [key, child] of Object.entries(value)) {
      if (!["loc", "extra", "leadingComments", "innerComments", "trailingComments"].includes(key)) {
        visit(child);
      }
    }
  };
  visit(ast.program);
  return references;
}

/**
 * Collect boundary findings from a single file's source text.
 * @returns {Array<{file:string, line:number, specifier:string, category:string}>}
 */
export function collectFindings({
  text,
  absFile,
  root = DEFAULT_ROOT,
  workspacePackageNames = new Set(),
  resolveImport,
}) {
  const workspaceRoot = path.join(root, "workspace") + path.sep;
  const relFile = path.relative(root, absFile).split(path.sep).join("/");
  const findings = [];
  for (const { specifier, line } of moduleReferences(text, absFile)) {
    const crossesWorkspaceBoundary =
      isWorkspaceImportScope(specifier) ||
      [...workspacePackageNames].some(
        (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`)
      ) ||
      Boolean(resolveImport?.(specifier, absFile)) ||
      (specifier.startsWith(".") && resolvesIntoWorkspace(absFile, specifier, workspaceRoot));
    if (crossesWorkspaceBoundary) {
      findings.push({
        file: relFile,
        line,
        specifier,
        category: "import-violation",
      });
    }
  }
  return findings;
}

export function collectWorkspaceFindings({ text, absFile, root = DEFAULT_ROOT }) {
  const relFile = path.relative(root, absFile).split(path.sep).join("/");
  const hostPrivateRoots = HOST_PRIVATE_IMPORT_ROOTS.map((dir) => path.join(root, dir) + path.sep);
  const findings = [];
  for (const { specifier, line } of moduleReferences(text, absFile)) {
    if (specifier.startsWith(".") && resolvesIntoAnyRoot(absFile, specifier, hostPrivateRoots)) {
      findings.push({
        file: relFile,
        line,
        specifier,
        category: "workspace-host-import",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Filesystem walk.
// ---------------------------------------------------------------------------

function shouldSkipDir(root, current) {
  const rel = path.relative(root, current).split(path.sep).join("/");
  return NEUTRAL_BOUNDARY_TEST_ROOTS.has(rel) || IGNORED_DIRS.has(path.basename(current));
}

function* walkSourceFiles(root, scannedRoots, scannedFiles = []) {
  const stack = [];
  for (const dir of scannedRoots) stack.push(path.join(root, dir));
  const singles = scannedFiles.map((f) => path.join(root, f));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      if (shouldSkipDir(root, current)) continue;
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      continue;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(current))) yield current;
  }

  for (const file of singles) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) yield file;
  }
}

export function scanRepository(root = DEFAULT_ROOT) {
  const findings = [];
  const workspacePackageNames = new Set();
  const workspacePackageRoots = [];
  const workspaceDirectory = path.join(root, "workspace");
  for (const manifest of walkPackageManifests(workspaceDirectory)) {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      workspacePackageNames.add(parsed.name);
      if (parsed.name.startsWith("@vibestudio/")) {
        findings.push({
          file: path.relative(root, manifest).split(path.sep).join("/"),
          line: 1,
          specifier: parsed.name,
          category: "workspace-package-identity",
        });
      }
      if (path.dirname(manifest) !== workspaceDirectory) {
        workspacePackageRoots.push(`${fs.realpathSync(path.dirname(manifest))}${path.sep}`);
      }
    }
  }
  const resolveImport = (specifier, absFile) => {
    if (specifier.startsWith(".") || specifier.startsWith("node:")) return false;
    try {
      const resolved = createRequire(pathToFileURL(absFile)).resolve(specifier);
      const real = fs.realpathSync(resolved);
      return workspacePackageRoots.some(
        (packageRoot) => real === packageRoot.slice(0, -1) || real.startsWith(packageRoot)
      );
    } catch {
      return false;
    }
  };
  for (const absFile of walkSourceFiles(root, HOST_SCANNED_ROOTS, HOST_SCANNED_FILES)) {
    const relFile = path.relative(root, absFile).split(path.sep).join("/");
    if (SELF_FILES.has(relFile)) continue;
    const text = fs.readFileSync(absFile, "utf8");
    findings.push(
      ...collectFindings({
        text,
        absFile,
        root,
        workspacePackageNames,
        resolveImport,
      })
    );
  }
  for (const manifest of [
    path.join(root, "package.json"),
    ...walkPackageManifests(path.join(root, "packages")),
    ...walkPackageManifests(path.join(root, "apps")),
  ]) {
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const packageName of Object.keys(parsed[section] ?? {})) {
        if (!workspacePackageNames.has(packageName)) continue;
        findings.push({
          file: path.relative(root, manifest).split(path.sep).join("/"),
          line: 1,
          specifier: packageName,
          category: "import-violation",
        });
      }
    }
  }
  for (const absFile of walkSourceFiles(root, WORKSPACE_SCANNED_ROOTS)) {
    const relFile = path.relative(root, absFile).split(path.sep).join("/");
    if (SELF_FILES.has(relFile)) continue;
    const text = fs.readFileSync(absFile, "utf8");
    findings.push(...collectWorkspaceFindings({ text, absFile, root }));
  }
  // Stable ordering: file, then line.
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.category.localeCompare(b.category)
  );
  return findings;
}

function* walkPackageManifests(directory) {
  if (!fs.existsSync(directory)) return;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (shouldSkipDir(DEFAULT_ROOT, current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name === "package.json") yield absolute;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function countByCategory(items) {
  const counts = {};
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

function check(root) {
  const findings = scanRepository(root);
  if (findings.length === 0) {
    console.log("Host/workspace boundary OK (zero exemptions, zero violations).");
    return 0;
  }

  const categories = [
    "import-violation",
    "workspace-reference",
    "workspace-host-import",
    "workspace-package-identity",
  ];
  console.error("Host/workspace boundary violations:\n");
  for (const category of categories) {
    const group = findings.filter((f) => f.category === category);
    if (group.length === 0) continue;
    console.error(`  ${category} (${group.length}):`);
    for (const f of group) console.error(`    ${f.file}:${f.line}: ${f.specifier}`);
    console.error("");
  }
  const counts = countByCategory(findings);
  console.error(
    `Summary: ${findings.length} violation(s) - import-violation: ${counts["import-violation"] ?? 0}, workspace-host-import: ${counts["workspace-host-import"] ?? 0}, workspace-package-identity: ${counts["workspace-package-identity"] ?? 0}.`
  );
  return 1;
}

function main() {
  return check(DEFAULT_ROOT);
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exit(main());
}
