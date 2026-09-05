import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";

export const NATIVE_ISOLATION_RUST_VERSION = "1.95.0";

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

export function nativeIsolationSourceDigest(appRoot) {
  const sourceRoot = path.join(appRoot, "native/isolation");
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(path.join(sourceRoot, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (dir === "." && ["target", "artifacts"].includes(entry.name)) continue;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Native isolation source must be a regular file: ${relative}`);
    }
  }
  visit(".");
  for (const name of ["build-native-isolation.mjs", "native-isolation-artifacts.mjs"]) {
    files.push(`../../scripts/${name}`);
  }
  const hash = createHash("sha256");
  for (const name of files.sort()) {
    const bytes = readFileSync(path.join(sourceRoot, name));
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function nativeIsolationManifestPath(target) {
  return `${path.posix.dirname(target.artifact)}/manifest.json`;
}

export function nativeIsolationBinaryDigest(file) {
  if (!lstatSync(file).isFile())
    throw new Error(`Native isolation artifact must be a regular file: ${file}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Universal npm packages require the complete matrix from one source closure. */
export function assertNativeIsolationArtifacts(
  appRoot,
  artifactRoot = path.join(appRoot, "native/isolation/artifacts"),
  targets = NATIVE_ISOLATION_TARGETS
) {
  const sourceDigest = nativeIsolationSourceDigest(appRoot);
  const artifacts = [];
  for (const target of targets) {
    const manifestPath = nativeIsolationManifestPath(target);
    const inputRoot = path.join(artifactRoot, `native-isolation-${target.platform}-${target.arch}`);
    const inputManifest = path.join(inputRoot, "manifest.json");
    const inputBinary = path.join(inputRoot, path.basename(target.artifact));
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(inputManifest, "utf8"));
    } catch {
      throw new Error(
        `Missing native isolation release artifact: ${target.platform}-${target.arch}. Assemble the complete CI native artifact matrix before staging npm packages.`
      );
    }
    if (
      manifest.version !== 1 ||
      manifest.rustVersion !== NATIVE_ISOLATION_RUST_VERSION ||
      manifest.rustTarget !== target.rustTarget ||
      manifest.sourceDigest !== sourceDigest
    ) {
      throw new Error(
        `Native isolation artifact is from a different target or source closure: ${target.artifact}`
      );
    }
    if (manifest.binaryDigest !== nativeIsolationBinaryDigest(inputBinary)) {
      throw new Error(`Native isolation artifact checksum mismatch: ${target.artifact}`);
    }
    assertNativeIsolationBinaryTarget(inputBinary, target);
    artifacts.push(
      { source: inputBinary, artifact: target.artifact },
      { source: inputManifest, artifact: manifestPath }
    );
  }
  return artifacts;
}

/** Reject a correctly hashed binary for the wrong ABI before packaging it. */
export function assertNativeIsolationBinaryTarget(file, target) {
  const bytes = readFileSync(file);
  let matches = false;
  if (target.platform === "linux" && bytes.length >= 64) {
    matches =
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (target.arch === "x64" ? 62 : 183);
  } else if (target.platform === "darwin" && bytes.length >= 32) {
    matches =
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (target.arch === "x64" ? 0x01000007 : 0x0100000c);
  } else if (
    target.platform === "win32" &&
    bytes.length >= 64 &&
    bytes.readUInt16LE(0) === 0x5a4d
  ) {
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
