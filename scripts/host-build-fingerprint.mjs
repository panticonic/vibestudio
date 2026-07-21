import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const HOST_BUILD_FINGERPRINT_PATH = "dist/host-build-fingerprint.json";

const INPUT_ROOTS = [
  "apps",
  "build-resources",
  "packages",
  "skills/vibestudio-agent",
  "src",
  "workspace/apps",
  "workspace/packages",
  "workspace/panels",
  "workspace/workers",
];

const INPUT_FILES = [
  "build.mjs",
  "electron-builder.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/build-artifact-contracts.mjs",
  "scripts/build-workerd-programs.mjs",
  "scripts/collectWorkers.mjs",
  "scripts/generate-connect-grammar.mjs",
  "tsconfig.json",
  "tsconfig.workers.json",
  "workspace/package.json",
  "workspace/pnpm-lock.yaml",
  "workspace/tsconfig.json",
];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);

function collectFiles(rootPath, files) {
  if (!fs.existsSync(rootPath)) {
    return;
  }
  const stat = fs.lstatSync(rootPath);
  if (stat.isSymbolicLink() || stat.isFile()) {
    files.push(rootPath);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    collectFiles(path.join(rootPath, entry.name), files);
  }
}

export function computeHostBuildFingerprint({
  cwd = process.cwd(),
  mode = process.env.NODE_ENV === "development" ? "development" : "production",
} = {}) {
  const files = [];
  for (const input of [...INPUT_ROOTS, ...INPUT_FILES]) {
    collectFiles(path.resolve(cwd, input), files);
  }
  files.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  hash.update(`mode\0${mode}\0`);
  for (const filePath of files) {
    const relativePath = path.relative(cwd, filePath).split(path.sep).join("/");
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

export function readHostBuildFingerprint(cwd = process.cwd()) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, HOST_BUILD_FINGERPRINT_PATH), "utf8"));
  } catch {
    return null;
  }
}

export function writeHostBuildFingerprint(fingerprint, cwd = process.cwd()) {
  const destination = path.resolve(cwd, HOST_BUILD_FINGERPRINT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(fingerprint, null, 2)}\n`, {
    mode: 0o600,
  });
}
