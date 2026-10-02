#!/usr/bin/env node
/**
 * Build the Apple XCFramework carrying the reviewed stream-cancellation repair,
 * zip it, and compute the checksum Swift Package Manager verifies.
 *
 * iOS reaches the same defect as desktop and Android: the app's SPM reference
 * resolves upstream's `IrohLib` binary target, which is the UniFFI half of the
 * wrapper whose stream mutex is held across network waits. This runs upstream's
 * own `make_swift.sh` + `package_swift.sh` over the pinned patched tree, so it
 * needs macOS with Xcode.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedSource, preparePatchedSource, runIn, sha256 } from "./patchedSource.mjs";

/** The five slices upstream's xcframework carries: iOS device, both simulator
 * architectures, macOS, and Mac Catalyst. */
const TARGETS = [
  "aarch64-apple-ios",
  "aarch64-apple-ios-sim",
  "x86_64-apple-ios",
  "aarch64-apple-darwin",
  "aarch64-apple-ios-macabi",
];

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const version = versionIndex < 0 ? undefined : args[versionIndex + 1];
if (!args[0] || args[0].startsWith("--") || !version) {
  throw new Error("Usage: node build-ios-xcframework.mjs NEW_OUTPUT_DIRECTORY --version VERSION");
}
if (process.platform !== "darwin") {
  throw new Error("The Apple XCFramework requires macOS with Xcode");
}

const { output, source, target } = preparePatchedSource(args[0]);
const env = { CARGO_TARGET_DIR: target };
runIn("rustup", ["target", "add", ...TARGETS], source, env);
// Upstream owns the slice layout, the reproducible-path remapping, and the
// uniffi header/modulemap generation; reproducing any of it here would be a
// second definition of their release shape.
runIn("bash", ["./make_swift.sh"], source, env);
// package_swift.sh zips the framework and prints the SPM checksum, which is
// what Package.swift's binaryTarget verifies.
const checksum = runIn("bash", ["./package_swift.sh"], source, env, true)
  ?.trim()
  .split("\n")
  .at(-1);
if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
  throw new Error(`package_swift.sh did not produce a checksum: ${checksum ?? "none"}`);
}

const archive = join(output, "IrohLib.xcframework.zip");
copyFileSync(join(source, "IrohLib.xcframework.zip"), archive);
// UniFFI's Swift declarations and checksum functions must match these exact
// native slices. The archive alone cannot carry a new API to Swift consumers.
const swiftBindings = join(output, "IrohLib.swift");
copyFileSync(join(source, "IrohLib", "Sources", "IrohLib", "IrohLib.swift"), swiftBindings);
// Compile and exercise the generated Swift wrapper against the retained
// archive, in a fresh consumer that has none of the Rust build's libraries.
// Upstream's manifest selects its local binary target when this archive is
// present. Its ordinary tests and our lifecycle cases use that exact target.
const consumer = join(output, "swift-consumer");
mkdirSync(consumer);
copyFileSync(join(source, "Package.swift"), join(consumer, "Package.swift"));
cpSync(join(source, "IrohLib"), join(consumer, "IrohLib"), { recursive: true });
runIn("ditto", ["-x", "-k", archive, consumer], output);
copyFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "swift-cancellation.tests.swift"),
  join(consumer, "IrohLib", "Tests", "IrohLibTests", "CancellationTests.swift")
);
runIn("swift", ["test"], consumer);
const receipt = {
  ...pinnedSource,
  version,
  targets: TARGETS,
  archive,
  archiveSha256: sha256(readFileSync(archive)),
  // Package.swift verifies this, not the sha256 above.
  swiftPackageChecksum: checksum,
  swiftBindings,
  swiftBindingsSha256: sha256(readFileSync(swiftBindings)),
  builder: { platform: process.platform, arch: process.arch, node: process.version },
  rustc: runIn("rustc", ["--version", "--verbose"], source, {}, true),
  scope: "Apple acceptance artifact; consuming it needs a Package.swift pointing at this archive",
  validation: [
    "Fresh Swift package compiles the matching generated wrapper and XCFramework",
    "Upstream Swift tests and endpoint-readiness/dial cancellation regressions",
  ],
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
