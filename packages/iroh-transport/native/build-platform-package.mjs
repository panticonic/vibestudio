#!/usr/bin/env node
/**
 * Build one publishable replacement for an upstream `@number0/iroh-<platform>`
 * package from the reviewed cancellation patch.
 *
 * Only the native artifact differs from upstream: `@number0/iroh`'s own loader
 * requires the platform package by name and returns whatever it exports, so
 * republishing the platform packages alone repairs the binding without forking
 * upstream's JavaScript, types, or API surface. Root `pnpm.overrides` aliases
 * each upstream platform name to the package this script emits.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSource, preparePatchedSource, runIn, sha256 } from "./patchedSource.mjs";

/** Upstream's napi target -> platform package identity. `platform` reproduces
 * upstream's package-name suffix and artifact name exactly; the loader derives
 * both from the running process, so they are not ours to choose. */
const TARGETS = {
  "aarch64-apple-darwin": { platform: "darwin-arm64", os: "darwin", cpu: "arm64", ext: "dylib" },
  "x86_64-unknown-linux-gnu": {
    platform: "linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    ext: "so",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    ext: "so",
  },
  "x86_64-unknown-linux-musl": {
    platform: "linux-x64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    ext: "so",
  },
  "aarch64-unknown-linux-musl": {
    platform: "linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    ext: "so",
  },
  "x86_64-pc-windows-msvc": { platform: "win32-x64-msvc", os: "win32", cpu: "x64", ext: "dll" },
  "aarch64-pc-windows-msvc": { platform: "win32-arm64-msvc", os: "win32", cpu: "arm64", ext: "dll" },
};

function usage() {
  throw new Error(
    "Usage: node build-platform-package.mjs NEW_OUTPUT_DIRECTORY --target TARGET " +
      `--version VERSION [--scope @scope]\nTargets: ${Object.keys(TARGETS).join(", ")}`
  );
}

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const outputDirectory = args[0];
const target = flag("target");
const version = flag("version");
const scope = flag("scope") ?? "@panticonic";
const descriptor = target && TARGETS[target];
if (!outputDirectory || outputDirectory.startsWith("--") || !descriptor || !version) usage();

const { output, source, target: cargoTarget } = preparePatchedSource(outputDirectory);
const env = { CARGO_TARGET_DIR: cargoTarget };
runIn(
  "cargo",
  ["build", "--locked", "--release", "--target", target, "-p", "number0_iroh"],
  source,
  env
);
const library = descriptor.ext === "dll" ? "number0_iroh.dll" : `libnumber0_iroh.${descriptor.ext}`;
const artifactName = `iroh.${descriptor.platform}.node`;
const packageDirectory = join(output, "package");
mkdirSync(packageDirectory, { recursive: true });
copyFileSync(join(cargoTarget, target, "release", library), join(packageDirectory, artifactName));

const manifest = {
  name: `${scope}/iroh-${descriptor.platform}`,
  version,
  os: [descriptor.os],
  cpu: [descriptor.cpu],
  main: artifactName,
  files: [artifactName],
  license: "MIT",
  engines: { node: ">= 10" },
  repository: { type: "git", url: pinnedSource.repository },
  ...(descriptor.libc ? { libc: [descriptor.libc] } : {}),
};
writeFileSync(
  join(packageDirectory, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
writeFileSync(
  join(packageDirectory, "README.md"),
  `# ${manifest.name}\n\n` +
    `Replacement native binding for \`@number0/iroh-${descriptor.platform}\` ` +
    `${pinnedSource.bindingVersion}, built from ${pinnedSource.repository} at ` +
    `${pinnedSource.commit} with the reviewed stream-cancellation repair applied.\n\n` +
    "Upstream holds each stream mutex across network waits, so `RecvStream.stop()` cannot " +
    "interrupt a pending read and `SendStream.reset()` cannot interrupt a flow-controlled " +
    "write. Only the native artifact differs; the JavaScript API is upstream's.\n",
  "utf8"
);

const receipt = {
  ...pinnedSource,
  package: manifest.name,
  version,
  target,
  profile: "release",
  builder: { platform: process.platform, arch: process.arch, node: process.version },
  rustc: runIn("rustc", ["--version", "--verbose"], source, {}, true),
  cargo: runIn("cargo", ["--version"], source, {}, true),
  artifact: join(packageDirectory, artifactName),
  artifactSha256: sha256(readFileSync(join(packageDirectory, artifactName))),
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
