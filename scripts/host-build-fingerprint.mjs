import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const HOST_BUILD_FINGERPRINT_PATH = "dist/host-build-fingerprint.json";

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

function collectFiles(cwd) {
  try {
    return execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...INPUT_ROOTS,
        ...INPUT_FILES,
      ],
      { cwd, encoding: "utf8" }
    )
      .split("\0")
      .filter((filePath) => filePath && !filePath.endsWith(".tsbuildinfo"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new Error(`Host builds require a Git source checkout at ${cwd}`, { cause: error });
  }
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
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        hash.update(`link:${fs.readlinkSync(filePath)}`);
      } else {
        hash.update(fs.readFileSync(filePath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // `git ls-files --cached` retains tracked deletions. Hash an explicit
      // tombstone so a stable deletion has a stable fingerprint and a file
      // removed during the build still changes the completed snapshot.
      hash.update("missing");
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

export function sameHostBuildFingerprint(left, right) {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.mode === right.mode &&
    left.fingerprint === right.fingerprint
  );
}

export function writeHostBuildFingerprint(fingerprint, cwd = process.cwd()) {
  const destination = path.resolve(cwd, HOST_BUILD_FINGERPRINT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(fingerprint, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
}
