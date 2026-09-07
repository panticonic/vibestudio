#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(join(here, "source.json"), "utf8"));
const args = process.argv.slice(2);
const output = args[0] && resolve(args[0]);
const profile = args[1] ?? "dev";
if (!output || args.length > 2 || !["dev", "release"].includes(profile)) {
  throw new Error("Usage: node build-and-verify.mjs NEW_OUTPUT_DIRECTORY [dev|release]");
}
if (existsSync(output)) throw new Error(`Output directory already exists: ${output}`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const patch = join(here, input.patch);
if (sha256(readFileSync(patch)) !== input.patchSha256)
  throw new Error("Source patch digest mismatch");
mkdirSync(output, { recursive: true });
const source = join(output, "source");
const target = join(output, "target");
const env = { ...process.env, CARGO_TARGET_DIR: target };
function run(command, commandArgs, cwd = output, extraEnv = {}, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
  return result.stdout?.trim();
}
run("git", ["init", source]);
run("git", ["remote", "add", "origin", input.repository], source);
run("git", ["fetch", "--depth", "1", "origin", input.commit], source);
run("git", ["checkout", "--detach", "FETCH_HEAD"], source);
if (run("git", ["rev-parse", "HEAD"], source, {}, true) !== input.commit)
  throw new Error("Source commit mismatch");
const lock = join(source, "Cargo.lock");
if (sha256(readFileSync(lock)) !== input.baseCargoLockSha256)
  throw new Error("Upstream lock digest mismatch");
run("git", ["apply", "--check", patch], source);
run("git", ["apply", patch], source);
if (sha256(readFileSync(lock)) !== input.patchedCargoLockSha256)
  throw new Error("Patched lock digest mismatch");
// Use upstream's Cargo package/build layout. No generated API or loader changes
// are necessary: the repair is entirely within the existing native methods.
run("cargo", ["build", "--locked", "--profile", profile, "-p", "number0_iroh"], source);
run("cargo", ["check", "--locked", "-p", "iroh-ffi"], source);
const library =
  process.platform === "win32"
    ? "number0_iroh.dll"
    : process.platform === "darwin"
      ? "libnumber0_iroh.dylib"
      : "libnumber0_iroh.so";
const artifact = join(output, "iroh.node");
copyFileSync(join(target, profile === "dev" ? "debug" : "release", library), artifact);
// This is an explicit test-only loader selection, never application configuration.
run(
  process.execPath,
  ["--test", "test/endpoint.mjs", "test/stream-cancellation.mjs"],
  join(source, "iroh-js"),
  { NAPI_RS_NATIVE_LIBRARY_PATH: artifact }
);
const receipt = {
  ...input,
  profile,
  platform: process.platform,
  arch: process.arch,
  rustc: run("rustc", ["--version", "--verbose"], source, {}, true),
  cargo: run("cargo", ["--version"], source, {}, true),
  node: process.version,
  artifact,
  artifactSha256: sha256(readFileSync(artifact)),
  validation: ["upstream endpoint tests", "native stream cancellation tests", "UniFFI cargo check"],
  scope: "Local acceptance artifact; not a published or installed binding release",
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
