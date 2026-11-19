import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertNativeIsolationBinaryTarget } from "./native-isolation-artifacts.mjs";

/**
 * The celld runtime payload: one binary per platform-arch, named by
 * `native/celld/targets.json` and verified by digest. A target whose digest is
 * null has no published build yet and is refused for staging.
 */
export const NATIVE_CELLD_MANIFEST = Object.freeze(
  JSON.parse(readFileSync(new URL("../native/celld/targets.json", import.meta.url), "utf8"))
);

/** The manifest of the application root being packaged (not necessarily this checkout's). */
export function readNativeCelldManifest(appRoot) {
  return JSON.parse(readFileSync(path.join(appRoot, "native/celld/targets.json"), "utf8"));
}

export function nativeCelldTarget(
  platform = process.platform,
  arch = process.arch,
  manifest = NATIVE_CELLD_MANIFEST
) {
  const target = manifest.targets.find(
    (entry) => entry.platform === platform && entry.arch === arch
  );
  if (!target) throw new Error(`Unsupported celld runtime target: ${platform}-${arch}`);
  return target;
}

/** Where the staged binary lives under an application root. */
export function nativeCelldArtifact(target) {
  return `native/celld/${target.platform}-${target.arch}/${target.binary}`;
}

export function nativeCelldDigest(file) {
  if (!lstatSync(file).isFile())
    throw new Error(`celld runtime artifact must be a regular file: ${file}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The binary is the exact one the manifest names, built for the target. */
export function assertNativeCelldBinary(file, target) {
  if (target.sha256 === null)
    throw new Error(`No celld build is published for ${target.platform}-${target.arch}`);
  assertNativeIsolationBinaryTarget(file, target);
  const digest = nativeCelldDigest(file);
  if (digest !== target.sha256)
    throw new Error(
      `celld runtime digest mismatch for ${target.platform}-${target.arch}: expected ${target.sha256}, got ${digest}`
    );
}

/** Publish a verified binary under the application root without overwriting an inode a live host executes. */
export function stageNativeCelld(from, appRoot, target = nativeCelldTarget(), { artifactInput = false } = {}) {
  assertNativeCelldBinary(from, target);
  const destination = artifactInput
    ? path.join(appRoot, "native/celld/artifacts", `${target.platform}-${target.arch}`, target.binary)
    : path.join(appRoot, nativeCelldArtifact(target));
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    copyFileSync(from, temporary);
    if (!target.binary.endsWith(".exe")) chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

/** Accept a CI artifact only at the source revision and digest pinned by the application. */
export function stageNativeCelldCiArtifact(directory, appRoot, manifest, target) {
  const receipt = JSON.parse(readFileSync(path.join(directory, "target.json"), "utf8"));
  if (receipt.commit !== manifest.fork.commit || receipt.platform !== target.platform ||
      receipt.arch !== target.arch || receipt.binary !== target.binary || receipt.sha256 !== target.sha256) {
    throw new Error(`celld CI artifact does not match the pinned ${target.platform}-${target.arch} build`);
  }
  const binary = path.join(directory, target.binary);
  const artifact = stageNativeCelld(binary, appRoot, target, { artifactInput: true });
  const staged = stageNativeCelld(artifact, appRoot, target);
  for (const notice of ["LICENSE", "NOTICE"]) {
    copyFileSync(path.join(directory, notice), path.join(path.dirname(staged), notice));
  }
  return staged;
}
