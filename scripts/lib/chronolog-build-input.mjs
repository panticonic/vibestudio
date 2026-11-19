import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const digest = /^[0-9a-f]{64}$/u;

/** Admit an immutable Chronolog npm package and verify its release pin when supplied. */
export function readChronologBuildInput(
  root = process.env.VIBESTUDIO_CHRONOLOG_PACKAGE_ROOT,
  expectedFingerprint = process.env.VIBESTUDIO_CHRONOLOG_PACKAGE_MANIFEST_SHA256
) {
  if (expectedFingerprint && (!root || !digest.test(expectedFingerprint))) {
    throw new Error("A pinned Chronolog package requires a root and a valid manifest SHA-256");
  }
  if (!root) return null;
  if (!path.isAbsolute(root)) throw new Error("VIBESTUDIO_CHRONOLOG_PACKAGE_ROOT must be absolute");
  const manifest = readFileSync(path.join(root, "provenance.json"));
  const fingerprint = createHash("sha256").update(manifest).digest("hex");
  if (expectedFingerprint && expectedFingerprint !== fingerprint) {
    throw new Error("Chronolog package provenance differs from the release pin");
  }
  const { format, source, dirty, sha256 } = JSON.parse(manifest);
  if (
    format !== "chronolog-peer-session-package/v1" ||
    typeof source !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source) ||
    dirty !== false ||
    !sha256 ||
    !digest.test(sha256["workspace-celld.mjs"])
  ) {
    throw new Error("The host build requires a clean Chronolog package with workspace-celld");
  }
  for (const [relative, hash] of Object.entries(sha256)) {
    if (
      !/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/u.test(relative) ||
      relative.split("/").some((segment) => segment === "." || segment === "..") ||
      !digest.test(hash)
    ) {
      throw new Error("Chronolog package has an invalid integrity entry");
    }
    const contents = readFileSync(path.join(root, relative));
    if (createHash("sha256").update(contents).digest("hex") !== hash) {
      throw new Error(`Chronolog package content differs from its manifest: ${relative}`);
    }
  }
  return {
    entry: path.join(root, "workspace-celld.mjs"),
    fingerprint,
  };
}
