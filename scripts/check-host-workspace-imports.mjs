import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const root = process.cwd();
const scannedRoots = ["src", "packages", "apps", "scripts"];
const workspaceRoot = path.join(root, "workspace") + path.sep;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirs = new Set(["node_modules", "dist", ".git"]);

const findings = [];

for (const dir of scannedRoots) {
  walk(path.join(root, dir));
}

if (findings.length > 0) {
  console.error("Host-side files must not import workspace packages or files:");
  for (const finding of findings) {
    console.error(`- ${path.relative(root, finding.file)}:${finding.line}: ${finding.specifier}`);
  }
  process.exit(1);
}

function walk(current) {
  if (!fs.existsSync(current)) return;
  const stat = fs.statSync(current);
  if (stat.isDirectory()) {
    if (current === path.join(root, "workspace")) return;
    const base = path.basename(current);
    if (ignoredDirs.has(base)) return;
    for (const entry of fs.readdirSync(current)) {
      walk(path.join(current, entry));
    }
    return;
  }

  if (!stat.isFile() || !sourceExtensions.has(path.extname(current))) return;
  checkFile(current);
}

function checkFile(file) {
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const specifier = getModuleSpecifier(node);
    if (specifier && violatesBoundary(file, specifier)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({ file, line: line + 1, specifier });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function getModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

function violatesBoundary(file, specifier) {
  if (specifier.startsWith("@workspace/")) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved.startsWith(workspaceRoot);
}
