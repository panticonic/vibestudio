#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSource, sha256 } from "./patchedSource.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node check-node-package-set.mjs ARTIFACT_DIRECTORY");
const platforms = [
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
  "win32-arm64-msvc",
];
let reference;
for (const platform of platforms) {
  const root = join(directory, `iroh-${platform}`);
  const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
  for (const key of ["commit", "patchSha256", "baseCargoLockSha256", "patchedCargoLockSha256"]) {
    if (receipt[key] !== pinnedSource[key])
      throw new Error(`${platform}: source receipt differs at ${key}`);
  }
  for (const [file, key] of [
    ["index.js", "javascriptSha256"],
    ["index.d.ts", "declarationsSha256"],
  ]) {
    if (sha256(readFileSync(join(root, "root-package/iroh-js", file))) !== receipt[key]) {
      throw new Error(`${platform}: generated ${file} does not match its receipt`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(root, "root-package/package.json"), "utf8"));
  const scope = manifest.name.split("/")[0];
  const expectedDependencies = Object.fromEntries(
    platforms.map((item) => [`${scope}/iroh-${item}`, receipt.version])
  );
  if (
    manifest.name !== receipt.rootPackage ||
    manifest.version !== receipt.version ||
    JSON.stringify(Object.entries(manifest.optionalDependencies).sort()) !==
      JSON.stringify(Object.entries(expectedDependencies).sort())
  ) {
    throw new Error(
      `${platform}: root package does not select the complete matching native package set`
    );
  }
  const platformManifest = JSON.parse(readFileSync(join(root, "package/package.json"), "utf8"));
  if (
    platformManifest.name !== `${scope}/iroh-${platform}` ||
    platformManifest.version !== manifest.version ||
    sha256(readFileSync(join(root, "package", platformManifest.main))) !== receipt.artifactSha256
  ) {
    throw new Error(`${platform}: native package does not match its root API and receipt`);
  }
  const contract = JSON.stringify([
    receipt.rootPackage,
    receipt.version,
    receipt.javascriptSha256,
    receipt.declarationsSha256,
  ]);
  reference ??= contract;
  if (contract !== reference)
    throw new Error(`${platform}: generated Node API differs across native targets`);
}
console.log(
  `Matching generated Node API and native package receipts verified for ${platforms.length} targets`
);
