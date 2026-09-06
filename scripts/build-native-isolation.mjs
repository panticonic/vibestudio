import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_ISOLATION_RUST_VERSION,
  nativeIsolationTarget,
  nativeIsolationSourceDigest,
  nativeIsolationManifestPath,
  nativeIsolationBinaryDigest,
} from "./native-isolation-artifacts.mjs";

/** Build installed storage cleanup and Windows admission with a locked closure. */
export function buildNativeIsolation(appRoot = process.cwd()) {
  const target = nativeIsolationTarget();
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
  const output = path.join(appRoot, target.artifact);
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(
    path.join(appRoot, "native/isolation/target", target.rustTarget, "release", executable),
    output
  );
  writeFileSync(
    path.join(appRoot, nativeIsolationManifestPath(target)),
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
