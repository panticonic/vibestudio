import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

export const HOST_BUILD_FINGERPRINT_PATH = "dist/host-build-fingerprint.json";
export const DESKTOP_HOST_BUILD_FINGERPRINT_PATH = "dist/desktop-host-build-fingerprint.json";

const INPUT_ROOTS = ["apps", "build-resources", "packages", "skills/vibestudio-agent", "src"];

const INPUT_FILES = [
  ".gitignore",
  "build.mjs",
  "electron-builder.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/build-artifact-contracts.mjs",
  "scripts/clean-host-build-output.mjs",
  "scripts/build-workerd-programs.mjs",
  "scripts/collectWorkers.mjs",
  "scripts/ensure-host-build.mjs",
  "scripts/generate-connect-grammar.mjs",
  "scripts/host-build-fingerprint.mjs",
  "scripts/infrastructure-package-cache.mjs",
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

export function computeHostBuildFingerprint({
  cwd = process.cwd(),
  mode = process.env.NODE_ENV === "development" ? "development" : "production",
} = {}) {
  const files = collectFiles(cwd);

  const hash = createHash("sha256");
  hash.update(`mode\0${mode}\0`);
  for (const relativePath of files) {
    const filePath = path.resolve(cwd, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(filePath)}`);
    } else {
      hash.update(fs.readFileSync(filePath));
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
