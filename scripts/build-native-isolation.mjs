import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeIsolationBinaryDigest,
  nativeIsolationTarget,
  MXC_SDK_VERSION,
} from "./native-isolation-artifacts.mjs";

export function buildNativeIsolation(appRoot = process.cwd()) {
  if (process.platform === "win32") return;
  const target = nativeIsolationTarget();
  const require = createRequire(path.join(appRoot, "package.json"));
  const sdkPackage = require.resolve("@microsoft/mxc-sdk/package.json");
  const sdkRoot = path.dirname(sdkPackage);
  const sdkVersion = require("@microsoft/mxc-sdk/package.json").version;
  if (sdkVersion !== MXC_SDK_VERSION)
    throw new Error(`MXC requires @microsoft/mxc-sdk ${MXC_SDK_VERSION}, found ${sdkVersion}`);
  const outputRoot = path.join(appRoot, path.dirname(target.artifact));
  mkdirSync(outputRoot, { recursive: true });
  const files = {};
  for (const binary of target.mxcFiles) {
    const output = path.join(outputRoot, binary);
    const staging = `${output}.${randomUUID()}.tmp`;
    try {
      copyFileSync(path.join(sdkRoot, "bin", target.arch, binary), staging);
      chmodSync(staging, 0o755);
      files[binary] = nativeIsolationBinaryDigest(staging);
      // A developer instance may still be executing the previous inode. Never
      // truncate a live executable, or expose a partially copied installation.
      renameSync(staging, output);
    } finally {
      rmSync(staging, { force: true });
    }
  }
  const manifest = path.join(outputRoot, "manifest.json");
  const staging = `${manifest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      staging,
      `${JSON.stringify({ version: 1, sdk: "@microsoft/mxc-sdk", sdkVersion, binary: target.mxcBinary, binaryDigest: files[target.mxcBinary], files }, null, 2)}\n`
    );
    renameSync(staging, manifest);
  } finally {
    rmSync(staging, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildNativeIsolation();
