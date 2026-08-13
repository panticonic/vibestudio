#!/usr/bin/env node

/**
 * Verify the production import graph reachable from every workspace package
 * entry/export against that package's manifest. The repository uses a hoisted
 * linker, so resolution success alone cannot reveal undeclared dependencies.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { builtinModules } from "node:module";
import { parseSync } from "@babel/core";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoots = ["packages", "apps"].map((part) =>
  path.join(repositoryRoot, part)
);
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"];
const ignoredDirectories = new Set([".git", ".turbo", "build", "coverage", "dist", "node_modules"]);
const nodeBuiltins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0])
);

function isTestFile(file) {
  const normalized = file.split(path.sep).join("/");
  return (
    normalized.includes("/__tests__/") ||
    /(?:^|\/)test(?:s|Fixtures?)\//.test(normalized) ||
    /\.(?:browser\.)?(?:test|spec)\.[^.]+$/.test(normalized)
  );
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function packageDirectories(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      found.push(directory);
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
        .map((entry) => visit(path.join(directory, entry.name)))
    );
  }
  await visit(root);
  return found;
}

function exportTargets(value, targets = []) {
  if (typeof value === "string") targets.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => exportTargets(entry, targets));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => exportTargets(entry, targets));
  }
  return targets;
}

async function walkFiles(directory) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(current, entry.name);
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(target);
        else if (entry.isFile()) files.push(target);
      })
    );
  }
  await visit(directory);
  return files;
}

async function expandEntryTarget(packageDirectory, target) {
  if (typeof target !== "string" || !target.startsWith("./")) return [];
  if (!target.includes("*")) {
    const resolved = await resolveSourcePath(path.join(packageDirectory, target));
    return resolved ? [resolved] : [];
  }
  const relativePattern = target.slice(2);
  const firstWildcard = relativePattern.indexOf("*");
  const searchRoot = path.join(
    packageDirectory,
    path.dirname(relativePattern.slice(0, firstWildcard))
  );
  const expression = new RegExp(
    `^${relativePattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
  );
  return (await walkFiles(searchRoot)).filter(
    (file) =>
      sourceExtensions.includes(path.extname(file)) &&
      !isTestFile(file) &&
      expression.test(path.relative(packageDirectory, file).split(path.sep).join("/"))
  );
}

async function resolveSourcePath(candidate) {
  const clean = candidate.split("?")[0].split("#")[0];
  if (await isFile(clean)) return clean;
  const extension = path.extname(clean);
  const candidates = [];
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = clean.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, clean);
  } else if (!extension) {
    candidates.push(...sourceExtensions.map((suffix) => `${clean}${suffix}`));
    candidates.push(...sourceExtensions.map((suffix) => path.join(clean, `index${suffix}`)));
  }
  for (const file of candidates) if (await isFile(file)) return file;
  return null;
}

function moduleSpecifiers(file, source) {
  if (!sourceExtensions.includes(path.extname(file))) return [];
  if (file.endsWith(".css")) {
    return [...source.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)].map((match) => ({
      specifier: match[1],
      typeOnly: false,
    }));
  }
  const parsed = parseSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: {
      sourceType: "unambiguous",
      plugins: [
        ["typescript", { dts: file.endsWith(".d.ts") }],
        "jsx",
        "decorators-legacy",
        "importAttributes",
      ],
    },
  });
  if (!parsed) return [];
  const found = [];
  let usesJsxRuntime = false;
  const addLiteral = (node, typeOnly = false) => {
    if (node?.type === "StringLiteral") found.push({ specifier: node.value, typeOnly });
  };
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      usesJsxRuntime = true;
    } else if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (node.specifiers?.length > 0 &&
          node.specifiers.every((specifier) =>
            [specifier.importKind, specifier.exportKind].includes("type")
          ));
      addLiteral(node.source, typeOnly);
    } else if (node.type === "ImportExpression") {
      addLiteral(node.source);
    } else if (
      node.type === "CallExpression" &&
      (node.callee?.type === "Import" ||
        (node.callee?.type === "Identifier" && node.callee.name === "require"))
    ) {
      addLiteral(node.arguments?.[0]);
    } else if (node.type === "TSImportType") {
      addLiteral(node.argument, true);
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        ["loc", "start", "end", "leadingComments", "innerComments", "trailingComments"].includes(
          key
        )
      ) {
        continue;
      }
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(parsed);
  if (usesJsxRuntime) found.push({ specifier: "react/jsx-runtime", typeOnly: false });
  return found;
}

function dependencyName(specifier) {
  // Workerd module bindings use bare `.wasm` specifiers. They are supplied by
  // the runtime rather than installed from a package registry.
  if (specifier.endsWith(".wasm")) return null;
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    /^[a-z][a-z+.-]*:/i.test(specifier)
  ) {
    return null;
  }
  if (nodeBuiltins.has(specifier.split("/")[0])) return null;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function typesPackageName(dependency) {
  if (!dependency.startsWith("@")) return `@types/${dependency}`;
  const [scope, name] = dependency.slice(1).split("/");
  return scope && name ? `@types/${scope}__${name}` : null;
}

async function checkPackage(packageDirectory) {
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!manifest.name) return [];

  const targets = new Set(exportTargets(manifest.exports));
  for (const field of ["main", "module", "types"]) {
    if (typeof manifest[field] === "string") targets.add(manifest[field]);
  }
  if (typeof manifest.bin === "string") targets.add(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === "object") {
    Object.values(manifest.bin).forEach((target) => targets.add(target));
  }
  if (typeof manifest.vibestudio?.entry === "string") targets.add(`./${manifest.vibestudio.entry}`);
  if (targets.size === 0) return [];

  const queue = [];
  for (const target of targets) queue.push(...(await expandEntryTarget(packageDirectory, target)));
  const visited = new Set();
  const importedBy = new Map();
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = await fs.readFile(file, "utf8");
    for (const { specifier, typeOnly } of moduleSpecifiers(file, source)) {
      if (specifier.startsWith(".")) {
        const resolved = await resolveSourcePath(path.resolve(path.dirname(file), specifier));
        if (resolved && resolved.startsWith(`${packageDirectory}${path.sep}`)) queue.push(resolved);
        continue;
      }
      const dependency = dependencyName(specifier);
      if (dependency && dependency !== manifest.name) {
        const existing = importedBy.get(dependency);
        if (!existing) {
          importedBy.set(dependency, { importer: path.relative(repositoryRoot, file), typeOnly });
        } else if (!typeOnly) {
          existing.typeOnly = false;
          existing.importer = path.relative(repositoryRoot, file);
        }
      }
    }
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const development = new Set(Object.keys(manifest.devDependencies ?? {}));
  return [...importedBy]
    .filter(
      ([dependency, usage]) =>
        !declared.has(dependency) &&
        !(
          usage.typeOnly &&
          (development.has(dependency) || development.has(typesPackageName(dependency)))
        )
    )
    .map(([dependency, usage]) => ({
      packageName: manifest.name,
      manifest: path.relative(repositoryRoot, manifestPath),
      dependency,
      importer: usage.importer,
      typeOnly: usage.typeOnly,
    }));
}

const directories = (
  await Promise.all(workspaceRoots.map((root) => packageDirectories(root)))
).flat();
const failures = (await Promise.all(directories.map(checkPackage))).flat();

if (failures.length > 0) {
  console.error("Undeclared production package imports:\n");
  for (const failure of failures.sort((a, b) =>
    `${a.manifest}:${a.dependency}`.localeCompare(`${b.manifest}:${b.dependency}`)
  )) {
    console.error(
      `- ${failure.packageName} imports ${failure.dependency}${failure.typeOnly ? " as a type" : ""} ` +
        `in ${failure.importer} ` +
        `but does not declare it (${failure.manifest})`
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Package dependency declarations match ${directories.length} workspace import graphs.`
  );
}
