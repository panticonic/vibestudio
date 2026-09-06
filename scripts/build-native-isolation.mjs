import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  NATIVE_ISOLATION_RUST_VERSION,
  nativeIsolationTarget,
  nativeIsolationSourceDigest,
  nativeCleanupManifestPath,
  nativeIsolationBinaryDigest,
} from "./native-isolation-artifacts.mjs";

const MXC_SDK_VERSION = "0.8.0";

function stageMxcExecutor(appRoot, target) {
  const require = createRequire(path.join(appRoot, "package.json"));
  const sdkPackage = require.resolve("@microsoft/mxc-sdk/package.json");
  const sdkRoot = path.dirname(sdkPackage);
  const sdkVersion = require("@microsoft/mxc-sdk/package.json").version;
  if (sdkVersion !== MXC_SDK_VERSION) {
    throw new Error(`MXC requires @microsoft/mxc-sdk ${MXC_SDK_VERSION}, found ${sdkVersion}`);
  }
  const outputRoot = path.join(appRoot, path.dirname(target.artifact));
  mkdirSync(outputRoot, { recursive: true });
  const files = {};
  for (const binary of target.mxcFiles) {
    const source = path.join(sdkRoot, "bin", target.arch, binary);
    const output = path.join(outputRoot, binary);
    copyFileSync(source, output);
    if (process.platform !== "win32") execFileSync("chmod", ["755", output]);
    files[binary] = nativeIsolationBinaryDigest(output);
  }
  const output = path.join(appRoot, target.artifact);
  writeFileSync(
    path.join(path.dirname(output), "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sdk: "@microsoft/mxc-sdk",
        sdkVersion,
        binary: target.mxcBinary,
        binaryDigest: nativeIsolationBinaryDigest(output),
        files,
      },
      null,
      2
    ) + "\n"
  );
}

/** Build the MXC executor and the separate installed storage cleanup helper. */
export function buildNativeIsolation(appRoot = process.cwd()) {
  const target = nativeIsolationTarget();
  stageMxcExecutor(appRoot, target);
  const rustVersion = execFileSync("rustc", ["--version"], { encoding: "utf8" })
    .trim()
    .split(" ")[1];
  if (rustVersion !== NATIVE_ISOLATION_RUST_VERSION) {
    throw new Error(
      `Native isolation requires Rust ${NATIVE_ISOLATION_RUST_VERSION}, found ${rustVersion}`
    );
  }
  const executable =
    process.platform === "win32" ? "vibestudio-isolation.exe" : "vibestudio-isolation";
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--target",
      target.rustTarget,
      "--target-dir",
      path.join(appRoot, "native/isolation/target"),
      "--manifest-path",
      path.join(appRoot, "native/isolation/Cargo.toml"),
    ],
    {
      cwd: appRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        // This helper must run on a clean Windows installation without the
        // Visual C++ redistributable. Encoded flags override ambient RUSTFLAGS.
        CARGO_ENCODED_RUSTFLAGS:
          target.platform === "win32" ? "-C\u001ftarget-feature=+crt-static" : "",
        ...(target.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "14.0" } : {}),
      },
    }
  );
  const output = path.join(appRoot, target.cleanupArtifact);
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(
    path.join(appRoot, "native/isolation/target", target.rustTarget, "release", executable),
    output
  );
  writeFileSync(
    path.join(appRoot, nativeCleanupManifestPath(target)),
    JSON.stringify(
      {
        version: 1,
        rustVersion,
        rustTarget: target.rustTarget,
        sourceDigest: nativeIsolationSourceDigest(appRoot),
        binaryDigest: nativeIsolationBinaryDigest(output),
      },
      null,
      2
    ) + "\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeIsolation();
}
