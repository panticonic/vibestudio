#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import developmentBaseConfig from "../src/dev/developmentBaseConfig.cjs";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectUserlandPackageManagerBoundaryErrors(appRoot, userlandRoot) {
  userlandRoot = path.resolve(userlandRoot);
  const workspaceManifestPath = path.join(appRoot, "pnpm-workspace.yaml");
  const lockfilePath = path.join(appRoot, "pnpm-lock.yaml");
  const errors = [];
  const rootManifest = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const userlandManifestPaths = userlandUnitManifestPaths(userlandRoot);
  const userlandPackageNames = new Set(
    userlandManifestPaths.flatMap((manifestPath) => {
      const name = JSON.parse(fs.readFileSync(manifestPath, "utf8")).name;
      return typeof name === "string" ? [name] : [];
    })
  );

  for (const pattern of readPnpmWorkspacePatterns(workspaceManifestPath)) {
    const normalized = pattern.replace(/^!/, "").replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.startsWith("workspace/")) {
      errors.push(
        `pnpm-workspace.yaml enrolls nested userland path ${JSON.stringify(pattern)}; ` +
          'only the checkout-tooling importer "workspace" may cross the package-manager boundary'
      );
    }
  }

  for (const importer of readLockfileImporters(lockfilePath)) {
    if (importer.startsWith("workspace/")) {
      errors.push(
        `pnpm-lock.yaml contains forbidden userland importer ${JSON.stringify(importer)}`
      );
    }
  }

  for (const [selector, patchPath] of Object.entries(
    rootManifest.pnpm?.patchedDependencies ?? {}
  )) {
    if (typeof patchPath === "string" && isUserlandPath(appRoot, userlandRoot, patchPath)) {
      errors.push(
        `root package.json patch ${JSON.stringify(selector)} reaches into userland at ${JSON.stringify(patchPath)}`
      );
    }
  }

  const lockfile = parseYaml(fs.readFileSync(lockfilePath, "utf8"));
  for (const [selector, patchRecord] of Object.entries(lockfile?.patchedDependencies ?? {})) {
    const patchPath = patchRecord?.path;
    if (typeof patchPath === "string" && isUserlandPath(appRoot, userlandRoot, patchPath)) {
      errors.push(
        `pnpm-lock.yaml patch ${JSON.stringify(selector)} reaches into userland at ${JSON.stringify(patchPath)}`
      );
    }
  }

  for (const [dependencyKind, dependencies] of Object.entries({
    dependencies: rootManifest.dependencies,
    devDependencies: rootManifest.devDependencies,
    optionalDependencies: rootManifest.optionalDependencies,
    peerDependencies: rootManifest.peerDependencies,
  })) {
    for (const name of Object.keys(dependencies ?? {})) {
      if (userlandPackageNames.has(name)) {
        errors.push(`root package.json ${dependencyKind} includes userland package ${name}`);
      }
    }
  }

  for (const manifestPath of userlandManifestPaths) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      Object.hasOwn(manifest, "overrides") ||
      Object.hasOwn(manifest, "resolutions") ||
      manifest.pnpm?.overrides ||
      manifest.pnpm?.patchedDependencies
    ) {
      errors.push(
        `${path.relative(appRoot, manifestPath)} declares package-manager resolution policy; ` +
          "use vibestudio.dependencyResolution so Build V2 owns the live dependency semantics"
      );
    }
  }

  return errors;
}

function isUserlandPath(appRoot, userlandRoot, candidate) {
  const resolved = path.resolve(appRoot, candidate);
  if (resolved === userlandRoot || resolved.startsWith(`${userlandRoot}${path.sep}`)) return true;
  if (!fs.existsSync(resolved)) return false;
  const real = fs.realpathSync(resolved);
  return real === userlandRoot || real.startsWith(`${userlandRoot}${path.sep}`);
}

function userlandUnitManifestPaths(userlandRoot) {
  const manifests = [];
  for (const section of [
    "about",
    "apps",
    "extensions",
    "packages",
    "panels",
    "skills",
    "templates",
    "workers",
  ]) {
    const sectionRoot = path.join(userlandRoot, section);
    if (!fs.existsSync(sectionRoot)) continue;
    for (const entry of fs.readdirSync(sectionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const manifestPath = path.join(sectionRoot, entry.name, "package.json");
      if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
    }
  }
  return manifests;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const userlandRoot = developmentBaseConfig.requireDevelopmentBaseCheckout(defaultAppRoot);
  const errors = collectUserlandPackageManagerBoundaryErrors(defaultAppRoot, userlandRoot);
  if (errors.length > 0) {
    console.error("Userland package-manager boundary check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Userland package-manager boundary check passed.");
}

function readPnpmWorkspacePatterns(filePath) {
  const patterns = [];
  let inPackages = false;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trimEnd();
    if (!line.trim()) continue;
    if (/^packages\s*:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S[^:]*\s*:/u.test(line)) break;
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+)$/u.exec(line)?.[1]?.trim();
    if (!item) continue;
    patterns.push(
      item.replace(/^(?:"(.*)"|'(.*)')$/u, (_match, quoted, singleQuoted) => quoted ?? singleQuoted)
    );
  }
  return patterns;
}

function readLockfileImporters(filePath) {
  const importers = [];
  let inImporters = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/u.test(line)) break;
    if (!inImporters) continue;
    const importer = /^  ([^\s][^:]*):\s*$/u.exec(line)?.[1];
    if (importer)
      importers.push(
        importer.replace(
          /^(?:"(.*)"|'(.*)')$/u,
          (_match, quoted, singleQuoted) => quoted ?? singleQuoted
        )
      );
  }
  return importers;
}
