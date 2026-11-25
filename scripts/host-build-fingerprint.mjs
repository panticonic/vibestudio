import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { readChronologBuildInput } from "./lib/chronolog-build-input.mjs";
import { hostInstalledDependencyHash } from "./lib/host-installed-dependencies.mjs";
import { updateHashFromFile } from "./lib/file-digest.mjs";

export const HOST_BUILD_FINGERPRINT_PATH = "dist/host-build-fingerprint.json";
export const DESKTOP_HOST_BUILD_FINGERPRINT_PATH = "dist/desktop-host-build-fingerprint.json";

const INPUT_ROOTS = [
  "build-resources",
  "hosts",
  "packages",
  "services",
  "skills/vibestudio-agent",
  "src",
];

const INPUT_FILES = [
  ".gitignore",
  ".nvmrc",
  "native/node/distribution.json",
  "scripts/node-runtime-artifacts.mjs",
  "build.mjs",
  "electron-builder.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/build-artifact-contracts.mjs",
  "scripts/build-native-isolation.mjs",
  "scripts/server-runtime-artifacts.mjs",
  "native/isolation/targets.json",
  "scripts/native-isolation-artifacts.mjs",
  "native/celld/targets.json",
  "scripts/native-celld-artifacts.mjs",
  "scripts/clean-host-build-output.mjs",
  "scripts/runtime-app-build.mjs",
  "scripts/lib/runtime-app.mjs",
  "scripts/lib/chronolog-build-input.mjs",
  "scripts/collectWorkers.mjs",
  "scripts/ensure-host-build.mjs",
  "scripts/generate-connect-grammar.mjs",
  "scripts/host-build-fingerprint.mjs",
  "scripts/host-build-generations.mjs",
  "scripts/infrastructure-package-cache.mjs",
  "scripts/build-artifact-groups.mjs",
  "scripts/lib/sql-js-runtime-asset.mjs",
  "scripts/lib/ownership-reaper-assets.mjs",
  "scripts/lib/mac-app-executable.mjs",
  "scripts/lib/file-digest.mjs",
  "scripts/lib/installed-package-graph.mjs",
  "scripts/lib/installed-package-graph.d.mts",
  "scripts/lib/host-installed-dependencies.mjs",
  "scripts/lib/join-child-process.mjs",
  "scripts/lib/owned-concurrency.mjs",
  "scripts/lib/owned-cleanup.mjs",
  "scripts/prepare-workspace-release.mjs",
  "scripts/prepare-workspace-templates.ts",
  "scripts/prebuild-release-userland.mjs",
  "scripts/lib/compiler-inputs.mjs",
  "tsconfig.json",
  "tsconfig.workers.json",
];

function ignoreScope(directory, relativeRoot) {
  const ignorePath = path.join(directory, ".gitignore");
  if (!fs.existsSync(ignorePath)) return null;
  return {
    relativeRoot,
    matcher: ignore().add(fs.readFileSync(ignorePath, "utf8")),
  };
}

function ignoredBy(scopes, relativePath, isDirectory) {
  for (const scope of scopes) {
    const scopedPath = path.posix.relative(scope.relativeRoot || ".", relativePath);
    if (!scopedPath || scopedPath.startsWith("../")) continue;
    if (scope.matcher.ignores(isDirectory ? `${scopedPath}/` : scopedPath)) return true;
  }
  return false;
}

function collectTree(cwd, relativeRoot, inheritedScopes, files) {
  const directory = path.resolve(cwd, relativeRoot);
  if (!fs.existsSync(directory)) return;

  const localScope = ignoreScope(directory, relativeRoot);
  const scopes = localScope ? [...inheritedScopes, localScope] : inheritedScopes;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const isDirectory = entry.isDirectory();
    if (isDirectory && ["node_modules", "dist", ".git", ".cache"].includes(entry.name)) continue;
    if (ignoredBy(scopes, relativePath, isDirectory)) continue;
    if (isDirectory) {
      collectTree(cwd, relativePath, scopes, files);
    } else {
      files.add(relativePath);
    }
  }
}

function collectFiles(cwd) {
  const rootScope = ignoreScope(cwd, "");
  const scopes = rootScope ? [rootScope] : [];
  const files = new Set();
  for (const relativeRoot of INPUT_ROOTS) collectTree(cwd, relativeRoot, scopes, files);
  for (const relativePath of INPUT_FILES) {
    if (fs.existsSync(path.resolve(cwd, relativePath))) files.add(relativePath);
  }
  return [...files]
    .filter((filePath) => !filePath.endsWith(".tsbuildinfo"))
    .sort((left, right) => left.localeCompare(right));
}

function localSourceTreeHash(root) {
  const files = new Set();
  collectTree(root, "", [], files);
  const hash = createHash("sha256");
  for (const relative of [...files].sort()) {
    if (
      relative
        .split("/")
        .some((part) => ["node_modules", "dist", ".git", ".cache"].includes(part)) ||
      relative.endsWith(".tsbuildinfo")
    )
      continue;
    const absolute = path.resolve(root, relative);
    hash.update(relative + "\0");
    if (fs.lstatSync(absolute).isSymbolicLink()) hash.update(`link:${fs.readlinkSync(absolute)}`);
    else updateHashFromFile(hash, absolute);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computeHostBuildFingerprint({
  cwd = process.cwd(),
  mode = process.env.NODE_ENV === "development" ? "development" : "production",
} = {}) {
  const files = collectFiles(cwd);

  const hash = createHash("sha256");
  hash.update(
    `host-inputs/2\0mode\0${mode}\0node\0${process.version}\0platform\0${process.platform}\0arch\0${process.arch}\0`
  );
  const installed = hostInstalledDependencyHash(cwd, {
    packageDirectories: files
      .filter((file) => path.basename(file) === "package.json")
      .map((file) => path.dirname(path.resolve(cwd, file))),
    tree: localSourceTreeHash,
  });
  hash.update(`installed\0${installed}\0`);
  const chronolog = readChronologBuildInput();
  if (chronolog) hash.update(`chronolog\0${chronolog.fingerprint}\0`);
  for (const relativePath of files) {
    const filePath = path.resolve(cwd, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(filePath)}`);
    } else {
      updateHashFromFile(hash, filePath);
    }
    hash.update("\0");
  }
  return {
    version: 1,
    mode,
    fingerprint: hash.digest("hex"),
    inputCount: files.length,
  };
}

/** Shared mutable outputs invalidate every complete-build receipt before replacement. */
export function invalidateHostBuildFingerprints(cwd = process.cwd()) {
  for (const marker of [HOST_BUILD_FINGERPRINT_PATH, DESKTOP_HOST_BUILD_FINGERPRINT_PATH]) {
    fs.rmSync(path.resolve(cwd, marker), { force: true });
  }
}

export function readHostBuildFingerprint(
  cwd = process.cwd(),
  fingerprintPath = HOST_BUILD_FINGERPRINT_PATH
) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, fingerprintPath), "utf8"));
  } catch {
    return null;
  }
}

export function sameHostBuildFingerprint(left, right) {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.mode === right.mode &&
    left.fingerprint === right.fingerprint
  );
}

export function writeHostBuildFingerprint(
  fingerprint,
  cwd = process.cwd(),
  fingerprintPath = HOST_BUILD_FINGERPRINT_PATH
) {
  const destination = path.resolve(cwd, fingerprintPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(fingerprint, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
}
