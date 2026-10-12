import { parse } from "@babel/parser";
import { builtinModules, isBuiltin } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const RUNTIME_EXTENSIONS = new Set([".mjs", ".js", ".cjs"]);
const LOADED_SOURCE_EXTENSIONS = new Set([...RUNTIME_EXTENSIONS, ".ts"]);

/**
 * Copy the local runtime-module closure of the scripts already shipped in an
 * npm package. The package's scripts tree is the declared entry-root set:
 * commands may be selected dynamically by the bundled CLI, so every shipped
 * runtime module is an entry root, not only the currently exercised command.
 * Local edges may resolve only inside the source scripts tree. Bare imports
 * are returned for checking against the generated package manifest/vendor.
 */
export function completeRuntimeScriptClosure({
  sourceRoot,
  packageRoot,
  entryRoots,
  packagedPaths = ["scripts", "dist"],
  copyRoots = ["scripts"],
  copyMissing = true,
}) {
  const sourceScripts = path.resolve(sourceRoot, "scripts");
  const packageRootPath = path.resolve(packageRoot);
  const packageScripts = path.resolve(packageRoot, "scripts");
  const pending = entryRoots
    ? entryRoots.map((entry) => path.resolve(packageRootPath, entry))
    : runtimeFilesUnder(packageScripts);
  const visited = new Set();
  const bareImports = new Set();

  while (pending.length > 0) {
    const stagedFile = pending.pop();
    const realStagedFile = fs.realpathSync(stagedFile);
    assertInside(packageRootPath, realStagedFile, `staged runtime script ${stagedFile}`);
    if (
      !isPackagedPath(packageRootPath, realStagedFile, packagedPaths) &&
      !isWithinRoots(packageRootPath, realStagedFile, copyRoots)
    ) {
      throw new Error(`Runtime script file is outside allowed artifact paths: ${realStagedFile}`);
    }
    if (visited.has(realStagedFile)) continue;
    visited.add(realStagedFile);

    const source = fs.readFileSync(realStagedFile, "utf8");
    const relative = path.relative(packageRootPath, realStagedFile);
    const extension = path.extname(realStagedFile);
    const sourceType = extension === ".cjs" ? "script" : "unambiguous";
    const ast = parse(source, {
      sourceType,
      sourceFilename: relative,
      ...(extension === ".ts" ? { plugins: ["typescript"] } : {}),
    });
    for (const edge of collectStaticModuleEdges(ast)) {
      const specifier = edge.specifier;
      if (isBuiltin(specifier) || builtinModules.includes(specifier)) continue;
      if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
        const dependency = resolveLocalModule({
          packageRoot: packageRootPath,
          sourceScripts,
          packageImporter: realStagedFile,
          specifier,
          requireLike: edge.requireLike,
          packagedPaths,
          copyRoots,
        });
        if (dependency.sourceFile && !fs.existsSync(dependency.packageFile)) {
          if (!copyMissing) {
            throw new Error(`Missing staged local runtime import ${specifier} from ${relative}`);
          }
          fs.mkdirSync(path.dirname(dependency.packageFile), { recursive: true });
          fs.copyFileSync(dependency.sourceFile, dependency.packageFile);
        }
        if (LOADED_SOURCE_EXTENSIONS.has(path.extname(dependency.packageFile))) {
          pending.push(dependency.packageFile);
        }
        continue;
      }
      if (specifier.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(specifier)) {
        throw new Error(`Unsupported package-local runtime import ${specifier} from ${relative}`);
      }
      bareImports.add(packageName(specifier));
    }
  }

  return {
    files: [...visited].map((file) => path.relative(packageRootPath, file)).sort(),
    bareImports,
  };
}

/** Reject runtime imports that the staged package cannot provide. */
export function assertRuntimeScriptDependencies({
  packageRoot,
  importedPackages,
  additionalPackages = [],
}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...additionalPackages,
  ]);
  const vendoredRoot = path.join(packageRoot, "vendor");
  for (const name of fs.existsSync(vendoredRoot)
    ? fs.readdirSync(vendoredRoot, { withFileTypes: true })
    : []) {
    if (name.isDirectory()) {
      if (name.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(path.join(vendoredRoot, name.name), {
          withFileTypes: true,
        })) {
          if (scoped.isDirectory()) declared.add(`${name.name}/${scoped.name}`);
        }
      } else declared.add(name.name);
    }
  }
  const missing = [...importedPackages].filter((name) => !declared.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(`Staged npm scripts import undeclared runtime packages: ${missing.join(", ")}`);
  }
}

/** Extend an electron-builder config with the same closure used by npm staging. */
export function includeDesktopRuntimeScriptClosure(appRoot, config) {
  if (!Array.isArray(config.files) || !Array.isArray(config.asarUnpack)) {
    throw new Error("Desktop runtime script closure requires files and asarUnpack patterns");
  }
  const includePatterns = config.files.filter(
    (pattern) => typeof pattern === "string" && !pattern.startsWith("!") && isScriptPattern(pattern)
  );
  const excludePatterns = config.files
    .filter((pattern) => typeof pattern === "string" && pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1))
    .filter(isScriptPattern);
  if (includePatterns.length === 0) {
    throw new Error("Desktop package config has no declared scripts runtime roots");
  }
  const included = new Set();
  for (const pattern of includePatterns) {
    for (const relative of fs.globSync(pattern, { cwd: appRoot })) {
      const absolute = path.resolve(appRoot, relative);
      if (fs.statSync(absolute).isFile() && RUNTIME_EXTENSIONS.has(path.extname(absolute))) {
        included.add(path.relative(appRoot, absolute).split(path.sep).join("/"));
      }
    }
  }
  for (const pattern of excludePatterns) {
    for (const relative of fs.globSync(pattern, { cwd: appRoot })) {
      included.delete(
        path.relative(appRoot, path.resolve(appRoot, relative)).split(path.sep).join("/")
      );
    }
  }
  if (included.size === 0)
    throw new Error("Desktop package config selected no runtime script roots");

  const closure = completeRuntimeScriptClosure({
    sourceRoot: appRoot,
    packageRoot: appRoot,
    entryRoots: [...included],
    packagedPaths: config.files.filter(
      (pattern) => typeof pattern === "string" && !pattern.includes("node_modules")
    ),
    copyRoots: ["scripts"],
  });
  assertRuntimeScriptDependencies({ packageRoot: appRoot, importedPackages: closure.bareImports });

  const added = closure.files.filter((file) => !included.has(file));
  const files = new Set(config.files);
  const unpacked = new Set(config.asarUnpack);
  for (const file of added) {
    files.add(file);
    unpacked.add(file);
  }
  config.files = [...files];
  config.asarUnpack = [...unpacked];
  return { ...closure, added };
}

function isScriptPattern(pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized === "scripts" || normalized.startsWith("scripts/");
}

function runtimeFilesUnder(root) {
  if (!fs.existsSync(root)) throw new Error(`Staged npm scripts directory is missing: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function resolveLocalModule({
  packageRoot,
  sourceScripts,
  packageImporter,
  specifier,
  requireLike,
  packagedPaths,
  copyRoots,
}) {
  const normalized = specifier.replace(/[?#].*$/u, "");
  const packageBase = path.resolve(path.dirname(packageImporter), normalized);
  assertInside(packageRoot, packageBase, `local import ${specifier} from ${packageImporter}`);

  const candidates = [packageBase];
  if (requireLike && !path.extname(packageBase)) {
    for (const extension of [".js", ".json", ".node"]) {
      candidates.push(`${packageBase}${extension}`);
    }
    candidates.push(
      ...["index.js", "index.json", "index.node"].map((name) => path.join(packageBase, name))
    );
  }
  let packageFile = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  let sourceFile;
  if (!packageFile) {
    const packageRelative = path.relative(packageRoot, candidates[0]);
    const sourceCandidate = path.resolve(path.dirname(packageImporter), normalized);
    const sourceRelative = path.relative(packageRoot, sourceCandidate);
    if (sourceRelative !== packageRelative) {
      throw new Error(`Invalid local runtime import ${specifier} from ${packageImporter}`);
    }
    sourceFile = path.resolve(path.dirname(sourceScripts), packageRelative);
    assertInside(sourceScripts, sourceFile, `missing local runtime import ${specifier}`);
    const sourceCandidates = [sourceFile];
    if (requireLike && !path.extname(sourceFile)) {
      for (const extension of [".js", ".json", ".node"]) {
        sourceCandidates.push(`${sourceFile}${extension}`);
      }
      sourceCandidates.push(
        ...["index.js", "index.json", "index.node"].map((name) => path.join(sourceFile, name))
      );
    }
    sourceFile = sourceCandidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!sourceFile) {
      throw new Error(`Missing local runtime import ${specifier} from ${packageImporter}`);
    }
    const realSource = fs.realpathSync(sourceFile);
    assertInside(sourceScripts, realSource, `resolved local import ${specifier}`);
    packageFile = path.resolve(packageRoot, path.relative(path.dirname(sourceScripts), realSource));
    assertInside(packageRoot, packageFile, `staged local import ${specifier}`);
  } else {
    const realPackageFile = fs.realpathSync(packageFile);
    assertInside(packageRoot, realPackageFile, `resolved staged local import ${specifier}`);
    if (
      !isPackagedPath(packageRoot, realPackageFile, packagedPaths) &&
      !isWithinRoots(packageRoot, realPackageFile, copyRoots)
    ) {
      throw new Error(`Runtime script import is outside allowed artifact paths: ${specifier}`);
    }
    packageFile = realPackageFile;
  }
  return { sourceFile, packageFile };
}

function collectStaticModuleEdges(ast) {
  const edges = [];
  const tsImportBindings = new Set();
  const collectTsImportBindings = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) collectTsImportBindings(child);
      return;
    }
    if (value.type === "ImportDeclaration" && value.source?.value === "tsx/esm/api") {
      for (const specifier of value.specifiers ?? []) {
        if (
          specifier.type === "ImportSpecifier" &&
          (specifier.imported?.name ?? specifier.imported?.value) === "tsImport"
        ) {
          tsImportBindings.add(specifier.local?.name);
        }
      }
    }
    if (
      value.type === "VariableDeclarator" &&
      value.id?.type === "ObjectPattern" &&
      isTsxApiImport(value.init)
    ) {
      for (const property of value.id.properties ?? []) {
        if (
          property.type === "ObjectProperty" &&
          (property.key?.name ?? property.key?.value) === "tsImport" &&
          property.value?.type === "Identifier"
        ) {
          tsImportBindings.add(property.value.name);
        }
      }
    }
    for (const child of Object.values(value)) collectTsImportBindings(child);
  };
  collectTsImportBindings(ast);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value.type === "string") {
      const declarationIsTypeOnly =
        (value.type === "ImportDeclaration" &&
          (value.importKind === "type" ||
            (value.specifiers?.length > 0 &&
              value.specifiers.every((specifier) => specifier.importKind === "type")))) ||
        ((value.type === "ExportNamedDeclaration" || value.type === "ExportAllDeclaration") &&
          (value.exportKind === "type" ||
            (value.specifiers?.length > 0 &&
              value.specifiers.every((specifier) => specifier.exportKind === "type"))));
      if (
        !declarationIsTypeOnly &&
        (value.type === "ImportDeclaration" ||
          value.type === "ExportNamedDeclaration" ||
          value.type === "ExportAllDeclaration") &&
        typeof value.source?.value === "string"
      ) {
        edges.push({ specifier: value.source.value, requireLike: false });
      }
      if (value.type === "ImportExpression" && typeof value.source?.value === "string") {
        edges.push({ specifier: value.source.value, requireLike: false });
      }
      if (
        value.type === "TSImportEqualsDeclaration" &&
        value.importKind !== "type" &&
        value.moduleReference?.type === "TSExternalModuleReference" &&
        value.moduleReference.expression?.type === "StringLiteral"
      ) {
        edges.push({ specifier: value.moduleReference.expression.value, requireLike: true });
      }
      if (value.type === "CallExpression") {
        const [argument] = value.arguments ?? [];
        const literal = argument?.type === "StringLiteral" ? argument.value : undefined;
        if (value.callee?.type === "Import" && typeof literal === "string") {
          edges.push({ specifier: literal, requireLike: false });
        } else if (
          value.callee?.type === "Identifier" &&
          tsImportBindings.has(value.callee.name) &&
          typeof literal === "string"
        ) {
          edges.push({ specifier: literal, requireLike: false });
        } else if (
          value.callee?.type === "Identifier" &&
          value.callee.name === "require" &&
          typeof literal === "string"
        ) {
          edges.push({ specifier: literal, requireLike: true });
        } else if (
          value.callee?.type === "MemberExpression" &&
          value.callee.object?.type === "Identifier" &&
          value.callee.object.name === "require" &&
          value.callee.property?.type === "Identifier" &&
          value.callee.property.name === "resolve" &&
          typeof literal === "string"
        ) {
          edges.push({ specifier: literal, requireLike: true });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "leadingComments" ||
        key === "innerComments" ||
        key === "trailingComments"
      )
        continue;
      visit(child);
    }
  };
  visit(ast);
  return edges;
}

function isTsxApiImport(value) {
  return (
    (value?.type === "ImportExpression" && value.source?.value === "tsx/esm/api") ||
    (value?.type === "AwaitExpression" &&
      value.argument?.type === "CallExpression" &&
      value.argument.callee?.type === "Import" &&
      value.argument.arguments?.[0]?.type === "StringLiteral" &&
      value.argument.arguments[0].value === "tsx/esm/api")
  );
}

function packageName(specifier) {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0];
}

function assertInside(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${description} escapes its allowed root: ${candidate}`);
  }
}

function isWithinRoots(root, candidate, roots) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  return roots.some((entry) => {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
}

function isPackagedPath(root, candidate, patterns) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  let included = false;
  for (const rawPattern of patterns) {
    if (typeof rawPattern !== "string") continue;
    const excluded = rawPattern.startsWith("!");
    const pattern = (excluded ? rawPattern.slice(1) : rawPattern)
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "");
    let matches = relative === pattern;
    const recursivePrefix = pattern.endsWith("/**/*")
      ? pattern.slice(0, -5).replace(/\/$/u, "")
      : null;
    if (
      recursivePrefix &&
      (relative === recursivePrefix || relative.startsWith(`${recursivePrefix}/`))
    ) {
      matches = true;
    } else if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("{")) {
      const declaredPath = path.resolve(root, pattern);
      try {
        if (fs.statSync(declaredPath).isDirectory()) {
          matches ||= relative.startsWith(`${pattern}/`);
        }
      } catch {
        // A missing exact artifact path is not permission to read a source file.
      }
    } else if (!matches) {
      matches = fs
        .globSync(pattern, { cwd: root })
        .some((match) => match.replaceAll("\\", "/") === relative);
    }
    if (matches) included = !excluded;
  }
  return included;
}
