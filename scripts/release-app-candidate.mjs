#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createReadStream } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertFullSourceCommit, assertReleaseVersion } from "./check-release-version.mjs";
import { AFTER_PACK_COMPLETION_FORMAT } from "./lib/after-pack-completion.mjs";

export const RELEASE_APP_CANDIDATE_FORMAT = "vibestudio-macos-release-candidate/1";

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function createReleaseAppProvenance({
  archivePath,
  receiptPath,
  packagePath,
  releaseTag,
  sourceSha,
  signingMode,
}) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assertReleaseVersion(releaseTag, pkg.version);
  assertFullSourceCommit(sourceSha);
  if (signingMode !== "developer-id" && signingMode !== "ad-hoc") {
    throw new Error(`Unknown macOS signing mode: ${signingMode}`);
  }
  const afterPack = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (
    afterPack?.format !== AFTER_PACK_COMPLETION_FORMAT ||
    afterPack.platform !== "darwin" ||
    afterPack.arch !== 3 ||
    afterPack.appOutDir !== "mac-arm64"
  ) {
    throw new Error("macOS application candidate has an invalid afterPack completion receipt");
  }
  return {
    format: RELEASE_APP_CANDIDATE_FORMAT,
    releaseTag,
    sourceSha,
    packageVersion: pkg.version,
    signingMode,
    appArchiveSha256: await sha256File(archivePath),
    afterPack,
  };
}

export async function verifyReleaseAppProvenance({
  archivePath,
  provenancePath,
  packagePath,
  releaseTag,
  sourceSha,
}) {
  const actual = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assertReleaseVersion(releaseTag, pkg.version);
  assertFullSourceCommit(sourceSha);
  const appArchiveSha256 = await sha256File(archivePath);
  const receipt = actual.afterPack;
  if (
    actual.format !== RELEASE_APP_CANDIDATE_FORMAT ||
    actual.releaseTag !== releaseTag ||
    actual.sourceSha !== sourceSha ||
    actual.packageVersion !== pkg.version ||
    !["developer-id", "ad-hoc"].includes(actual.signingMode) ||
    actual.appArchiveSha256 !== appArchiveSha256 ||
    receipt?.format !== AFTER_PACK_COMPLETION_FORMAT ||
    receipt.platform !== "darwin" ||
    receipt.arch !== 3 ||
    receipt.appOutDir !== "mac-arm64"
  ) {
    throw new Error("macOS application candidate provenance does not match the requested release");
  }
  return actual;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [mode, archivePath, provenancePath, releaseTag, sourceSha] = process.argv.slice(2);
    if (mode === "create") {
      const releaseDir = process.env.RELEASE_DIR ?? "release";
      const packagePath = process.env.PACKAGE_JSON ?? "package.json";
      const signingMode = fs.readFileSync(`${releaseDir}/macos-signing.txt`, "utf8").trim();
      const receipts = fs
        .readdirSync(releaseDir)
        .filter((name) => /^\.vibestudio-after-pack-darwin-\d+\.json$/u.test(name));
      if (receipts.length !== 1) {
        throw new Error(`Expected one Darwin afterPack receipt, found ${receipts.length}`);
      }
      const provenance = await createReleaseAppProvenance({
        archivePath,
        receiptPath: `${releaseDir}/${receipts[0]}`,
        packagePath,
        releaseTag,
        sourceSha,
        signingMode,
      });
      fs.writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`, { mode: 0o600 });
    } else if (mode === "verify") {
      await verifyReleaseAppProvenance({
        archivePath,
        provenancePath,
        packagePath: process.env.PACKAGE_JSON ?? "package.json",
        releaseTag,
        sourceSha,
      });
    } else {
      throw new Error("Usage: release-app-candidate.mjs create|verify ARCHIVE PROVENANCE TAG SOURCE_SHA");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
