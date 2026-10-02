#!/usr/bin/env node
/**
 * Build a matching root API and native platform package from the reviewed
 * source. Regenerating the loader and declarations is part of the same build;
 * a platform-only artifact cannot publish the new native dial API.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSource, preparePatchedSource, runIn, sha256 } from "./patchedSource.mjs";
import { buildNodePackages } from "./nodeBindings.mjs";

/** Upstream's napi target -> platform package identity. `platform` reproduces
 * upstream's package-name suffix and artifact name exactly; the loader derives
 * both from the running process, so they are not ours to choose. */
const TARGETS = {
  "aarch64-apple-darwin": { platform: "darwin-arm64", os: "darwin", cpu: "arm64" },
  "x86_64-unknown-linux-gnu": {
    platform: "linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  "x86_64-pc-windows-msvc": { platform: "win32-x64-msvc", os: "win32", cpu: "x64" },
  "aarch64-pc-windows-msvc": {
    platform: "win32-arm64-msvc",
    os: "win32",
    cpu: "arm64",
  },
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
const bindings = buildNodePackages({
  output,
  source,
  cargoTarget,
  target,
  descriptor,
  targets: TARGETS,
  version,
  scope,
});
const { manifest, packageDirectory, artifactName } = bindings;
writeFileSync(
  join(packageDirectory, "README.md"),
  `# ${manifest.name}\n\n` +
    `Replacement native binding for \`@number0/iroh-${descriptor.platform}\` ` +
    `${pinnedSource.bindingVersion}, built from ${pinnedSource.repository} at ` +
    `${pinnedSource.commit} with the reviewed stream-cancellation repair applied.\n\n` +
    "Upstream holds each stream mutex across network waits, so `RecvStream.stop()` cannot " +
    "interrupt a pending read and `SendStream.reset()` cannot interrupt a flow-controlled " +
    "write. The matching root package regenerates JavaScript and declarations " +
    "from this native build, including request-owned dial cancellation.\n",
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
  rootPackage: bindings.rootPackage,
  rootTarball: bindings.rootTarball,
  platformTarball: bindings.platformTarball,
  javascriptSha256: bindings.javascriptSha256,
  declarationsSha256: bindings.declarationsSha256,
  validation: bindings.validation,
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
