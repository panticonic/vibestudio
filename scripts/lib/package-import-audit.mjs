import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const { analyzeModuleImports, moduleCoordinate } = await tsImport(
  "../../packages/module-imports/src/index.ts",
  import.meta.url
);

export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const NODE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/u, "").split("/")[0])
);

export function isTestFile(file) {
  const normalized = file.split(path.sep).join("/");
  return (
    normalized.includes("/__tests__/") ||
    /(?:^|\/)test(?:s|Fixtures?)\//u.test(normalized) ||
    /\.(?:browser\.)?(?:test|spec)\.[^.]+$/u.test(normalized)
  );
}

export async function findPackageDirectories(root) {
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
        .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
        .map((entry) => visit(path.join(directory, entry.name)))
    );
  }
  await visit(root);
  return found;
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
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
        if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) await visit(target);
        else if (entry.isFile()) files.push(target);
      })
    );
  }
  await visit(directory);
  return files;
}

async function crossesPackageBoundary(file, packageDirectory) {
  let current = path.dirname(file);
  while (current !== packageDirectory && current.startsWith(`${packageDirectory}${path.sep}`)) {
    if (await isFile(path.join(current, "package.json"))) return true;
    current = path.dirname(current);
  }
  return false;
}

function exportTargets(value, targets = []) {
  if (typeof value === "string") targets.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => exportTargets(entry, targets));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => exportTargets(entry, targets));
  }
  return targets;
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
    candidates.push(
      ...SOURCE_EXTENSIONS.filter((value) => value !== ".css").map((value) => `${clean}${value}`)
    );
    candidates.push(
      ...SOURCE_EXTENSIONS.filter((value) => value !== ".css").map((value) =>
        path.join(clean, `index${value}`)
      )
    );
  }
  for (const file of candidates) if (await isFile(file)) return file;
  return null;
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
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`
  );
  return (await walkFiles(searchRoot)).filter(
    (file) =>
      SOURCE_EXTENSIONS.includes(path.extname(file)) &&
      !isTestFile(file) &&
      expression.test(path.relative(packageDirectory, file).split(path.sep).join("/"))
  );
}

function cssReferences(source) {
  return [...source.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gu)].map(([, specifier]) => ({
    specifier,
    kind: "value",
  }));
}

function typesPackageName(dependency) {
  if (!dependency.startsWith("@")) return `@types/${dependency}`;
  const [scope, name] = dependency.slice(1).split("/");
  return scope && name ? `@types/${scope}__${name}` : null;
}

function packageImportTargets(specifier, importMap, seen = new Set()) {
  if (seen.has(specifier)) return [];
  const nextSeen = new Set(seen).add(specifier);
  if (!importMap || typeof importMap !== "object") return [];
  let targets;
  let selectedKey = Object.hasOwn(importMap, specifier) ? specifier : null;
  if (!selectedKey) {
    const patterns = Object.keys(importMap)
      .filter((key) => key.includes("*"))
      .map((key) => {
        const [prefix, suffix] = key.split("*");
        return specifier.startsWith(prefix) && specifier.endsWith(suffix)
          ? { key, prefix, suffix }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.prefix.length - left.prefix.length)[0];
    selectedKey = patterns?.key ?? null;
    if (patterns) {
      const replacement = specifier.slice(
        patterns.prefix.length,
        specifier.length - patterns.suffix.length
      );
      targets = stringTargets(importMap[selectedKey]).map((target) =>
        target.replaceAll("*", replacement)
      );
    }
  }
  targets ??= selectedKey ? stringTargets(importMap[selectedKey]) : [];
  return targets.flatMap((target) =>
    target.startsWith("#") ? packageImportTargets(target, importMap, nextSeen) : [target]
  );
}

function stringTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringTargets);
  return [];
}

/**
 * Inspect the source reachable from one package's declared production entry
 * points and compare each bare import with that package's own manifest.
 * `jsxRuntime` is supplied by the owning build contract, never guessed from
 * the source extension.
 */
export async function collectPackageManifestImportFindings(
  packageDirectory,
  repositoryRoot,
  { jsxRuntime, runtimeModuleSpecifiers = [] } = {}
) {
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
  const recordDependency = (dependency, file, kind) => {
    if (!dependency || dependency === manifest.name) return;
    const existing = importedBy.get(dependency);
    if (!existing) {
      importedBy.set(dependency, {
        importer: path.relative(repositoryRoot, file),
        typeOnly: kind === "type",
      });
    } else if (kind !== "type") {
      existing.typeOnly = false;
      existing.importer = path.relative(repositoryRoot, file);
    }
  };
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (!SOURCE_EXTENSIONS.includes(path.extname(file))) continue;
    const source = await fs.readFile(file, "utf8");
    let references;
    try {
      references = file.endsWith(".css")
        ? cssReferences(source)
        : analyzeModuleImports(source, file, { jsxRuntime });
    } catch (error) {
      throw new Error(`Could not analyze production imports in ${file}`, { cause: error });
    }
    for (const { specifier, kind } of references) {
      if (runtimeModuleSpecifiers.includes(specifier)) continue;
      if (specifier.startsWith("#")) {
        const targets = packageImportTargets(specifier, manifest.imports);
        if (targets.length === 0) {
          recordDependency(specifier, file, kind);
          continue;
        }
        for (const target of targets) {
          if (target.startsWith(".")) {
            const resolved = await resolveSourcePath(path.resolve(packageDirectory, target));
            if (
              resolved &&
              resolved.startsWith(`${packageDirectory}${path.sep}`) &&
              !(await crossesPackageBoundary(resolved, packageDirectory))
            ) {
              queue.push(resolved);
            }
          } else {
            recordDependency(moduleCoordinate(target), file, kind);
          }
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        const resolved = await resolveSourcePath(path.resolve(path.dirname(file), specifier));
        if (
          resolved &&
          resolved.startsWith(`${packageDirectory}${path.sep}`) &&
          !(await crossesPackageBoundary(resolved, packageDirectory))
        ) {
          queue.push(resolved);
        }
        continue;
      }
      if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0])) {
        continue;
      }
      recordDependency(moduleCoordinate(specifier), file, kind);
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
