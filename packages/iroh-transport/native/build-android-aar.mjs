#!/usr/bin/env node
/**
 * Build a replacement `computer.iroh:iroh-android` AAR carrying the reviewed
 * stream-cancellation repair, and install it into the local Maven repository.
 *
 * Mobile reaches the same defect as desktop: `packages/mobile-iroh` drives the
 * same `createIrohClientPipe`, and its native side is the UniFFI build of the
 * same Rust wrapper, which the patch repairs alongside the Node one. This is
 * upstream's own `cargo make kotlin-android` sequence over the pinned patched
 * tree, followed by a Maven-local publish under a distinct version.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSource, preparePatchedSource, runIn } from "./patchedSource.mjs";

/** Android ABI -> the Rust target cargo-ndk compiles it with. */
const ABIS = {
  "armeabi-v7a": "armv7-linux-androideabi",
  "arm64-v8a": "aarch64-linux-android",
  x86: "i686-linux-android",
  x86_64: "x86_64-linux-android",
};
const CARGO_NDK_VERSION = "3.5.4";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const version = flag("version");
if (!args[0] || args[0].startsWith("--") || !version) {
  throw new Error("Usage: node build-android-aar.mjs NEW_OUTPUT_DIRECTORY --version VERSION");
}

const ndkHome =
  process.env.ANDROID_NDK_HOME ??
  (() => {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error("Set ANDROID_NDK_HOME, or ANDROID_HOME with an installed NDK");
    const root = join(sdk, "ndk");
    // Any installed NDK builds these ABIs, so take the highest rather than
    // pinning a revision the developer may not have.
    const latest = (existsSync(root) ? readdirSync(root).sort() : []).at(-1);
    if (!latest) throw new Error(`No NDK installed under ${root}`);
    return join(root, latest);
  })();

const { output, source, target } = preparePatchedSource(args[0]);
const env = { CARGO_TARGET_DIR: target, ANDROID_NDK_HOME: ndkHome };

// Toolchain, not repair input: the Android targets and cargo-ndk are how this
// host compiles the patch, and neither changes what is compiled. A distro Rust
// has no rustup to add targets with; let cargo report the missing target rather
// than fail here on the tool that would have installed it.
try {
  runIn("rustup", ["target", "add", ...Object.values(ABIS)], source, env);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  console.warn("[android] no rustup; expecting the Android targets to be installed already");
}

// cargo-ndk is a build tool, not a dependency of the repair.
try {
  runIn("cargo", ["ndk", "--version"], source, env, true);
} catch {
  runIn("cargo", ["install", "--version", CARGO_NDK_VERSION, "cargo-ndk", "--locked"], source, env);
}

// The host library is only needed so uniffi-bindgen can read its metadata.
runIn("cargo", ["build", "--locked", "--lib"], source, env);
runIn(
  "cargo",
  [
    "ndk",
    "-o",
    "./kotlin/android/src/main/jniLibs",
    "--manifest-path",
    "./Cargo.toml",
    ...Object.keys(ABIS).flatMap((abi) => ["-t", abi]),
    "build",
    "--locked",
    "--release",
  ],
  source,
  env
);
runIn(
  "cargo",
  [
    "run",
    "--bin",
    "uniffi-bindgen",
    "generate",
    "--language",
    "kotlin",
    "--out-dir",
    "kotlin/lib/src/main/kotlin/",
    "--config",
    "uniffi.toml",
    "--library",
    join(target, "debug", "libiroh_ffi.so"),
  ],
  source,
  env
);

// Upstream hard-codes the published coordinates, so a fork version is a source
// edit rather than a Gradle property. Both modules move together: the AAR
// depends on `:lib` by project reference but publishes its resolved version.
for (const module of ["lib", "android"]) {
  const buildFile = join(source, "kotlin", module, "build.gradle.kts");
  const artifact = module === "lib" ? "iroh" : "iroh-android";
  const contents = readFileSync(buildFile, "utf8");
  const coordinates = `coordinates("computer.iroh", "${artifact}", "${pinnedSource.bindingVersion}")`;
  if (!contents.includes(coordinates)) throw new Error(`Unexpected coordinates in ${buildFile}`);
  writeFileSync(
    buildFile,
    contents
      .replace(coordinates, `coordinates("computer.iroh", "${artifact}", "${version}")`)
      // Maven Central signing needs release keys this local publish has none of.
      .replace("    signAllPublications()\n", ""),
    "utf8"
  );
}

const gradle = join(source, "kotlin");
runIn("./gradlew", ["--no-daemon", ":lib:publishToMavenLocal"], gradle, env);
runIn("./gradlew", ["--no-daemon", ":android:publishToMavenLocal"], gradle, env);

const receipt = {
  ...pinnedSource,
  version,
  abis: ABIS,
  rustTargets: Object.values(ABIS),
  ndkHome,
  coordinates: [`computer.iroh:iroh:${version}`, `computer.iroh:iroh-android:${version}`],
  installedTo: join(process.env.HOME ?? "~", ".m2/repository/computer/iroh"),
  scope: "Local Maven acceptance artifact; not a published Maven release",
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
