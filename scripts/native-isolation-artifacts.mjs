import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";

export const MXC_SDK_VERSION = "0.8.0";
export const NATIVE_ISOLATION_TARGETS = Object.freeze(
  JSON.parse(readFileSync(new URL("../native/isolation/targets.json", import.meta.url), "utf8"))
);
export function nativeIsolationTarget(platform = process.platform, arch = process.arch) {
  const target = NATIVE_ISOLATION_TARGETS.find(
    (entry) => entry.platform === platform && entry.arch === arch
  );
  if (!target) throw new Error(`Unsupported native isolation target: ${platform}-${arch}`);
  return target;
}
export function nativeIsolationManifestPath(target) {
  return `${path.posix.dirname(target.artifact)}/manifest.json`;
}
export function nativeIsolationBinaryDigest(file) {
  if (!lstatSync(file).isFile())
    throw new Error(`Native isolation artifact must be a regular file: ${file}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
export function assertNativeIsolationArtifacts(
  appRoot,
  artifactRoot = path.join(appRoot, "native/isolation/artifacts"),
  targets = NATIVE_ISOLATION_TARGETS
) {
  const artifacts = [];
  for (const target of targets) {
    const inputRoot = path.join(artifactRoot, `native-isolation-${target.platform}-${target.arch}`);
    const manifestPath = path.join(inputRoot, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error(
        `Missing MXC release artifact: ${target.platform}-${target.arch}. Assemble the complete CI matrix.`
      );
    }
    if (
      manifest.version !== 1 ||
      manifest.sdk !== "@microsoft/mxc-sdk" ||
      manifest.sdkVersion !== MXC_SDK_VERSION ||
      manifest.binary !== target.mxcBinary ||
      !manifest.files
    )
      throw new Error(
        `MXC isolation artifact is from a different target or SDK version: ${target.artifact}`
      );
    for (const binary of target.mxcFiles) {
      const source = path.join(inputRoot, binary);
      if (manifest.files[binary] !== nativeIsolationBinaryDigest(source))
        throw new Error(
          `MXC payload checksum mismatch: ${target.platform}-${target.arch}/${binary}`
        );
      assertNativeIsolationBinaryTarget(source, target);
      artifacts.push({ source, artifact: `${path.posix.dirname(target.artifact)}/${binary}` });
    }
    if (manifest.binaryDigest !== manifest.files[target.mxcBinary])
      throw new Error(`MXC executor checksum receipt mismatch: ${target.platform}-${target.arch}`);
    artifacts.push({ source: manifestPath, artifact: nativeIsolationManifestPath(target) });
  }
  return artifacts;
}
export function assertNativeIsolationBinaryTarget(file, target) {
  const bytes = readFileSync(file);
  let matches = false;
  if (target.platform === "linux" && bytes.length >= 64)
    matches =
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (target.arch === "x64" ? 62 : 183);
  else if (target.platform === "darwin" && bytes.length >= 32)
    matches =
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (target.arch === "x64" ? 0x01000007 : 0x0100000c);
  else if (target.platform === "win32" && bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const offset = bytes.readUInt32LE(0x3c);
    matches =
      offset <= bytes.length - 26 &&
      bytes.readUInt32LE(offset) === 0x00004550 &&
      bytes.readUInt16LE(offset + 4) === 0x8664 &&
      bytes.readUInt16LE(offset + 24) === 0x20b;
  }
  if (!matches)
    throw new Error(
      `Native isolation binary does not match ${target.platform}-${target.arch}: ${file}`
    );
}
