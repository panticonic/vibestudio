#!/usr/bin/env node
// Host/workspace boundary checker.
//
// Enforces the host/userland boundary:
//
//   - HOST code (src/, packages/, apps/, scripts/, tests/, build.mjs) must never
//     depend on or assume WORKSPACE (userland, workspace/) code beyond defined
//     interfaces.
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
//   2. "workspace-reference" - a soft/latent reference: any *string literal* in
//      host source that (a) begins with a `@workspace` scope or (b) is a
//      path-like literal that resolves into `workspace/`. This catches
//      hard-coded workspace paths and dynamically-built module ids that the AST
//      import analysis cannot see. It is inherently noisy (caller ids, event
//      names, build constants, log strings all match), so it is governed
//      entirely by the allowlist and reported as a distinct category.
//
//   3. "workspace-host-import" - a workspace file importing a relative path that
//      resolves into a host-private root. This is always a real violation.
//
// Cross-boundary integration tests live under `tests/workspace-integration/`;
// that neutral harness is intentionally excluded from both directions.
//
// Soft workspace-reference findings are checked against
// scripts/host-boundary-allowlist.json. Hard import findings are never
// allowlistable.
//
// Flags:
//   (none)              check mode; exit 1 if any non-allowlisted finding.
//   --update-allowlist  regenerate the allowlist to cover current soft findings
//                       (preserving existing reasons); always exit 0.
//
// Dependency-free apart from `typescript` (already a repo dependency).

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = process.cwd();

// Host-side roots scanned recursively, plus individual files.
const HOST_SCANNED_ROOTS = ["src", "packages", "apps", "scripts", "tests"];
const HOST_SCANNED_FILES = ["build.mjs"];
const WORKSPACE_SCANNED_ROOTS = ["workspace"];
const HOST_PRIVATE_IMPORT_ROOTS = ["src", "apps", "scripts", "tests"];
const NEUTRAL_BOUNDARY_TEST_ROOTS = new Set(["tests/workspace-integration"]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "dist-publish", ".git"]);

// The checker and its data file describe the boundary; scanning them just
// produces self-referential noise, so exclude them explicitly.
const SELF_FILES = new Set([
  "scripts/check-host-workspace-imports.mjs",
  "scripts/host-boundary-allowlist.json",
]);

const ALLOWLIST_PATH = "scripts/host-boundary-allowlist.json";

// ---------------------------------------------------------------------------
// Pure matching helpers (exported for unit testing).
// ---------------------------------------------------------------------------

// A `@workspace` module scope, including the hyphenated variants the repo uses
// (@workspace-apps, @workspace-panels, @workspace-about, @workspace-workers,
// @workspace-skills, @workspace-extensions, @workspace-packages). We require a
// trailing "/" because a real import/export specifier always has a subpath.
const WORKSPACE_IMPORT_SCOPE_RE = /^@workspace(-[a-z-]+)?\//;

// For loose string literals we also accept a bare scope with no subpath
// ("@workspace", "@workspace-apps") - e.g. caller ids - hence "/" | "-" | end.
const WORKSPACE_SCOPE_LITERAL_RE = /^@workspace([/-]|$)/;

/** True if `specifier` is an import/export/require target inside a workspace scope. */
export function isWorkspaceImportScope(specifier) {
  return WORKSPACE_IMPORT_SCOPE_RE.test(specifier);
}

/** True if a raw string literal begins with a workspace scope. */
export function startsWithWorkspaceScope(specifier) {
  return WORKSPACE_SCOPE_LITERAL_RE.test(specifier);
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

/**
 * Cheap heuristic: is a string literal "path-like" enough to be worth resolving
 * as a potential workspace reference? We require a "/" separator and reject
 * obvious non-paths - URLs ("://"), scoped package ids ("@...", handled by the
 * scope rule), and prose (whitespace). This keeps log messages and free text
 * from being resolved into spurious references.
 */
export function looksPathLike(specifier) {
  if (!specifier.includes("/")) return false;
  if (specifier.startsWith("@")) return false;
  if (specifier.includes("://")) return false;
  if (/\s/.test(specifier)) return false;
  return true;
}

/**
 * Does this file count as a test context? Used to skip the noisy
 * workspace-reference (string-literal) category entirely, since fixtures and
 * assertions routinely embed `@workspace...` strings.
 */
export function isTestContext(relFile) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relFile) ||
    /(^|\/)(tests|__tests__|__fixtures__|fixtures)\//.test(relFile)
  );
}

/**
 * Extract the module specifier from a node if it is an import/export
 * declaration, a dynamic `import(...)`, or a `require(...)` call. Returns
 * `{ specifier, literalNode }` or null.
 */
export function getImportSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return { specifier: node.moduleSpecifier.text, literalNode: node.moduleSpecifier };
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (isDynamicImport || isRequire) {
      return { specifier: node.arguments[0].text, literalNode: node.arguments[0] };
    }
  }
  return null;
}

/**
 * Collect boundary findings from a single file's source text.
 * @returns {Array<{file:string, line:number, specifier:string, category:string}>}
 */
export function collectFindings({ text, absFile, root = DEFAULT_ROOT }) {
  const workspaceRoot = path.join(root, "workspace") + path.sep;
  const relFile = path.relative(root, absFile).split(path.sep).join("/");
  const testContext = isTestContext(relFile);
  const sourceFile = ts.createSourceFile(
    absFile,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const findings = [];
  // Literal nodes already consumed as import specifiers, so we don't
  // double-report them under the workspace-reference category.
  const consumed = new Set();

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    const imported = getImportSpecifier(node);
    if (imported) {
      consumed.add(imported.literalNode);
      const { specifier } = imported;
      if (
        isWorkspaceImportScope(specifier) ||
        (specifier.startsWith(".") && resolvesIntoWorkspace(absFile, specifier, workspaceRoot))
      ) {
        findings.push({
          file: relFile,
          line: lineOf(node),
          specifier,
          category: "import-violation",
        });
      }
    } else if (
      !testContext &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !consumed.has(node)
    ) {
      // workspace-reference category: string literals only, and never in test
      // contexts (too noisy). Rule (a) scope prefix or (b) path-like resolving
      // into workspace/.
      const literal = node.text;
      const isRef =
        startsWithWorkspaceScope(literal) ||
        (looksPathLike(literal) && resolvesIntoWorkspace(absFile, literal, workspaceRoot));
      if (isRef) {
        findings.push({
          file: relFile,
          line: lineOf(node),
          specifier: literal,
          category: "workspace-reference",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function collectWorkspaceFindings({ text, absFile, root = DEFAULT_ROOT }) {
  const relFile = path.relative(root, absFile).split(path.sep).join("/");
  const hostPrivateRoots = HOST_PRIVATE_IMPORT_ROOTS.map(
    (dir) => path.join(root, dir) + path.sep
  );
  const sourceFile = ts.createSourceFile(
    absFile,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const findings = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    const imported = getImportSpecifier(node);
    if (imported) {
      const { specifier } = imported;
      if (
        specifier.startsWith(".") &&
        resolvesIntoAnyRoot(absFile, specifier, hostPrivateRoots)
      ) {
        findings.push({
          file: relFile,
          line: lineOf(node),
          specifier,
          category: "workspace-host-import",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// Allowlist handling.
// ---------------------------------------------------------------------------

/**
 * A finding matches an allowlist entry when the file matches and, if present,
 * the specifier and category match. An entry with no `specifier` covers the
 * whole file (optionally scoped to a category).
 */
export function matchesAllowlistEntry(finding, entry) {
  if (entry.file !== finding.file) return false;
  if (entry.specifier != null && entry.specifier !== finding.specifier) return false;
  if (entry.category != null && entry.category !== finding.category) return false;
  return true;
}

export function isAllowlisted(finding, allowlist) {
  if (finding.category === "import-violation" || finding.category === "workspace-host-import") {
    return false;
  }
  return allowlist.some((entry) => matchesAllowlistEntry(finding, entry));
}

/** Reason assigned to a freshly-seeded finding (see task description). */
export function defaultReason(finding) {
  return "workspace-reference baseline 2026-07: pre-existing host reference to workspace path/scope";
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
  for (const absFile of walkSourceFiles(root, HOST_SCANNED_ROOTS, HOST_SCANNED_FILES)) {
    const relFile = path.relative(root, absFile).split(path.sep).join("/");
    if (SELF_FILES.has(relFile)) continue;
    const text = fs.readFileSync(absFile, "utf8");
    findings.push(...collectFindings({ text, absFile, root }));
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

function loadAllowlist(root) {
  const file = path.join(root, ALLOWLIST_PATH);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function dedupeKey(f) {
  return `${f.file}\0${f.category}\0${f.specifier}`;
}

function updateAllowlist(root) {
  const findings = scanRepository(root);
  const existing = loadAllowlist(root);
  const seen = new Set();
  const entries = [];
  for (const finding of findings) {
    if (finding.category !== "workspace-reference") continue;
    const key = dedupeKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    // Preserve a human-edited reason if an existing entry already covers this finding.
    const prior = existing.find(
      (e) => matchesAllowlistEntry(finding, e) && e.specifier != null && e.category != null
    );
    entries.push({
      file: finding.file,
      specifier: finding.specifier,
      category: finding.category,
      reason: prior?.reason ?? defaultReason(finding),
    });
  }
  entries.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.category.localeCompare(b.category) ||
      a.specifier.localeCompare(b.specifier)
  );
  const out = {
    $comment:
      "Host/workspace boundary allowlist for soft workspace-reference findings only. Hard import findings from scripts/check-host-workspace-imports.mjs are never allowlistable. Regenerate soft references with `node scripts/check-host-workspace-imports.mjs --update-allowlist`. An entry with no `specifier` covers the whole file; `category` is optional.",
    entries,
  };
  const target = path.join(root, ALLOWLIST_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  const byCategory = countByCategory(entries);
  console.log(`Wrote ${entries.length} allowlist entries to ${ALLOWLIST_PATH}`);
  console.log(`  workspace-reference: ${byCategory["workspace-reference"] ?? 0}`);
}

function countByCategory(items) {
  const counts = {};
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

function check(root) {
  const findings = scanRepository(root);
  const allowlist = loadAllowlist(root);
  const violations = findings.filter((f) => !isAllowlisted(f, allowlist));
  const allowedCount = findings.length - violations.length;

  if (violations.length === 0) {
    console.log(
      `Host/workspace boundary OK (${findings.length} finding(s); ${allowedCount} soft reference(s) covered; hard import violations: 0).`
    );
    return 0;
  }

  const categories = ["import-violation", "workspace-reference", "workspace-host-import"];
  console.error("Host/workspace boundary violations (not allowlisted):\n");
  for (const category of categories) {
    const group = violations.filter((f) => f.category === category);
    if (group.length === 0) continue;
    console.error(`  ${category} (${group.length}):`);
    for (const f of group) console.error(`    ${f.file}:${f.line}: ${f.specifier}`);
    console.error("");
  }
  const counts = countByCategory(violations);
  console.error(
    `Summary: ${violations.length} violation(s) - import-violation: ${counts["import-violation"] ?? 0}, workspace-reference: ${counts["workspace-reference"] ?? 0}, workspace-host-import: ${counts["workspace-host-import"] ?? 0}. (${allowedCount} soft reference(s) covered.)`
  );
  console.error(
    `\nSoft workspace-reference findings can be added to ${ALLOWLIST_PATH} (or regenerated with --update-allowlist). Hard import findings must be removed.`
  );
  return 1;
}

function main(argv) {
  const root = DEFAULT_ROOT;
  if (argv.includes("--update-allowlist")) {
    updateAllowlist(root);
    return 0;
  }
  return check(root);
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
