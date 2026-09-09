#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSource, preparePatchedSource, runIn, sha256 } from "./patchedSource.mjs";

const args = process.argv.slice(2);
const profile = args[1] ?? "dev";
if (!args[0] || args.length > 2 || !["dev", "release"].includes(profile)) {
  throw new Error("Usage: node build-and-verify.mjs NEW_OUTPUT_DIRECTORY [dev|release]");
}
const { output, source, target } = preparePatchedSource(args[0]);
const env = { CARGO_TARGET_DIR: target };
// Use upstream's Cargo package/build layout. No generated API or loader changes
// are necessary: the repair is entirely within the existing native methods.
runIn("cargo", ["build", "--locked", "--profile", profile, "-p", "number0_iroh"], source, env);
runIn("cargo", ["check", "--locked", "-p", "iroh-ffi"], source, env);
const library =
  process.platform === "win32"
    ? "number0_iroh.dll"
    : process.platform === "darwin"
      ? "libnumber0_iroh.dylib"
      : "libnumber0_iroh.so";
const artifact = join(output, "iroh.node");
copyFileSync(join(target, profile === "dev" ? "debug" : "release", library), artifact);
// This is an explicit test-only loader selection, never application configuration.
runIn(
  process.execPath,
  ["--test", "test/endpoint.mjs", "test/stream-cancellation.mjs"],
  join(source, "iroh-js"),
  { NAPI_RS_NATIVE_LIBRARY_PATH: artifact }
);
const receipt = {
  ...pinnedSource,
  profile,
  platform: process.platform,
  arch: process.arch,
  rustc: runIn("rustc", ["--version", "--verbose"], source, {}, true),
  cargo: runIn("cargo", ["--version"], source, {}, true),
  node: process.version,
  artifact,
  artifactSha256: sha256(readFileSync(artifact)),
  validation: ["upstream endpoint tests", "native stream cancellation tests", "UniFFI cargo check"],
  scope: "Local acceptance artifact; not a published or installed binding release",
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
