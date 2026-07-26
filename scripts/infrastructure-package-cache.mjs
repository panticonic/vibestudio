import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export const INFRASTRUCTURE_CACHE_VERSION = 1;
export const INFRASTRUCTURE_CACHE_PATH = ".cache/vibestudio-infrastructure-build.json";

const ROOT_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/infrastructure-package-cache.mjs",
  "tsconfig.json",
];
const IGNORED_INPUT_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "dist-publish",
  "node_modules",
  "test-results",
]);

function digestParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(Buffer.isBuffer(part) || part instanceof Uint8Array ? part : String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectTree(root, { ignoreBuildInfo = false } = {}) {
  const entries = [];
  if (!fs.existsSync(root)) return entries;
  const visit = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relative,
        mode: stat.mode & 0o777,
        type: "symlink",
        content: fs.readlinkSync(absolute),
      });
      return;
    }
    if (stat.isDirectory()) {
      if (relative && IGNORED_INPUT_DIRECTORIES.has(path.basename(relative))) return;
      for (const child of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
      }
      return;
    }
    if (!stat.isFile() || (ignoreBuildInfo && relative.endsWith(".tsbuildinfo"))) return;
    entries.push({
      path: relative.split(path.sep).join("/"),
      mode: stat.mode & 0o777,
      type: "file",
      content: fs.readFileSync(absolute),
    });
  };
  visit(root, "");
  return entries;
}

function treeDigest(root, options) {
  const hash = createHash("sha256");
  for (const entry of collectTree(root, options)) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(String(entry.mode));
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function outputManifest(packageDirectory) {
  const dist = path.join(packageDirectory, "dist");
  if (!fs.existsSync(dist)) return null;
  const entries = collectTree(dist).map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    hash: digestParts([entry.content]),
  }));
  return entries.length > 0 ? entries : null;
}

function cleanBuildOutputs(packageDirectory) {
  fs.rmSync(path.join(packageDirectory, "dist"), { recursive: true, force: true });
  for (const entry of collectTree(packageDirectory, { ignoreBuildInfo: false })) {
    if (entry.path.endsWith(".tsbuildinfo")) {
      fs.rmSync(path.join(packageDirectory, entry.path), { force: true });
    }
  }
}

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function discoverPackages(cwd) {
  const packagesRoot = path.join(cwd, "packages");
  const packages = new Map();
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(directory, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@vibestudio/")) continue;
    const localDependencies = new Set();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith("@vibestudio/")) localDependencies.add(name);
      }
    }
    packages.set(manifest.name, {
      name: manifest.name,
      directory,
      relativeDirectory: path.relative(cwd, directory).split(path.sep).join("/"),
      build: typeof manifest.scripts?.build === "string",
      localDependencies,
      sourceDigest: treeDigest(directory, { ignoreBuildInfo: true }),
    });
  }
  return packages;
}

function installedToolchainDigest(cwd) {
  const require = createRequire(path.join(cwd, "package.json"));
  const roots = ["typescript/package.json", "esbuild/package.json"].map((specifier) =>
    path.dirname(require.resolve(specifier))
  );
  return digestParts(roots.flatMap((root) => [path.relative(cwd, root), treeDigest(root)]));
}

function commonInputDigest(cwd, toolchainDigest) {
  const parts = [
    `cache-version:${INFRASTRUCTURE_CACHE_VERSION}`,
    `node:${process.version}`,
    `platform:${process.platform}`,
    `arch:${process.arch}`,
    `extension-host-publish:${process.env.VIBESTUDIO_EXTHOST_PUBLISH ?? ""}`,
    `toolchain:${toolchainDigest ?? installedToolchainDigest(cwd)}`,
  ];
  for (const relative of ROOT_INPUTS) {
    const absolute = path.join(cwd, relative);
    parts.push(relative, fs.existsSync(absolute) ? fs.readFileSync(absolute) : "<missing>");
  }
  return digestParts(parts);
}

function packageInputDigest(name, packages, commonDigest) {
  const closure = new Set();
  const visit = (candidate) => {
    if (closure.has(candidate)) return;
    const pkg = packages.get(candidate);
    if (!pkg) return;
    closure.add(candidate);
    for (const dependency of pkg.localDependencies) visit(dependency);
  };
  visit(name);
  return digestParts([
    commonDigest,
    ...[...closure]
      .sort()
      .flatMap((dependency) => [dependency, packages.get(dependency).sourceDigest]),
  ]);
}

function executionSelection(dirty, packages) {
  const dirtyNames = new Set(dirty.map((pkg) => pkg.name));
  const selected = new Set(dirtyNames);
  const visited = new Set();
  const visitDependencies = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = packages.get(name);
    if (!pkg) return;
    for (const dependencyName of pkg.localDependencies) {
      const dependency = packages.get(dependencyName);
      if (!dependency) continue;
      if (!dependency.build || dirtyNames.has(dependencyName)) selected.add(dependencyName);
      visitDependencies(dependencyName);
    }
  };
  for (const pkg of dirty) visitDependencies(pkg.name);
  return [...selected].sort();
}

function readCache(cwd) {
  try {
    const cache = readJson(path.join(cwd, INFRASTRUCTURE_CACHE_PATH));
    return cache.version === INFRASTRUCTURE_CACHE_VERSION && cache.packages ? cache : null;
  } catch {
    return null;
  }
}

export function inspectInfrastructurePackageBuilds({ cwd = process.cwd(), toolchainDigest } = {}) {
  const packages = discoverPackages(cwd);
  const buildPackages = [...packages.values()].filter((pkg) => pkg.build);
  const commonDigest = commonInputDigest(cwd, toolchainDigest);
  const cache = readCache(cwd);
  const states = buildPackages
    .map((pkg) => {
      const inputDigest = packageInputDigest(pkg.name, packages, commonDigest);
      const manifest = outputManifest(pkg.directory);
      const cached = cache?.packages?.[pkg.name];
      let reason = null;
      if (!cached) reason = "uncached";
      else if (cached.inputDigest !== inputDigest) reason = "inputs changed";
      else if (!manifest) reason = "outputs missing";
      else if (!sameManifest(cached.outputs, manifest)) reason = "outputs changed";
      return { ...pkg, inputDigest, outputs: manifest, reason };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    cwd,
    states,
    dirty: states.filter((state) => state.reason !== null),
    packages,
  };
}

export function writeInfrastructurePackageCache(plan) {
  const packages = {};
  for (const state of plan.states) {
    const outputs = outputManifest(state.directory);
    if (!outputs) {
      throw new Error(`${state.name} produced no files under ${state.relativeDirectory}/dist`);
    }
    packages[state.name] = { inputDigest: state.inputDigest, outputs };
  }
  const destination = path.join(plan.cwd, INFRASTRUCTURE_CACHE_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ version: INFRASTRUCTURE_CACHE_VERSION, packages }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(temporary, destination);
}

export function buildInfrastructurePackages({
  cwd = process.cwd(),
  run = execFileSync,
  log = console.log,
  toolchainDigest,
} = {}) {
  const plan = inspectInfrastructurePackageBuilds({ cwd, toolchainDigest });
  if (plan.dirty.length === 0) {
    log(`[build] Reusing ${plan.states.length} verified infrastructure package builds.`);
    return { built: [], reused: plan.states.map((state) => state.name) };
  }

  for (const state of plan.dirty) {
    cleanBuildOutputs(state.directory);
  }
  log(
    `[build] Building ${plan.dirty.length} infrastructure package(s): ${plan.dirty
      .map((state) => `${state.name} (${state.reason})`)
      .join(", ")}`
  );
  const selectedPackages = executionSelection(plan.dirty, plan.packages);
  const args = selectedPackages.flatMap((name) => ["--filter", name]);
  run("pnpm", [...args, "build"], { cwd, stdio: "inherit" });
  writeInfrastructurePackageCache(plan);
  return {
    built: plan.dirty.map((state) => state.name),
    reused: plan.states.filter((state) => state.reason === null).map((state) => state.name),
  };
}
