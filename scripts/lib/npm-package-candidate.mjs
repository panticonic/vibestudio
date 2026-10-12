import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { spawnResultFailure } from "./spawn-result-failure.mjs";

export async function packNpmPackageCandidate({ packageRoot, outputDirectory, sourceSha }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha ?? "")) {
    throw new Error("npm candidate source SHA must be a full Git commit SHA");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`npm candidate output directory is not empty: ${outputDirectory}`);
  }

  const packageManifest = readJson(path.join(packageRoot, "package.json"));
  const packedResult = spawnSync("npm", ["pack", "--json", "--pack-destination", outputDirectory], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packFailure = spawnResultFailure(packedResult, "npm pack");
  if (packFailure) {
    const detail = packedResult.stderr?.trim() || packedResult.stdout?.trim();
    throw new Error(`npm pack failed${detail ? `: ${detail}` : ""}`, { cause: packFailure });
  }
  let packed;
  try {
    const results = JSON.parse(packedResult.stdout);
    if (!Array.isArray(results) || results.length !== 1) {
      throw new Error("npm pack must produce exactly one archive");
    }
    [packed] = results;
  } catch (error) {
    throw new Error("npm pack returned an invalid candidate record", { cause: error });
  }
  if (
    packed.name !== packageManifest.name ||
    packed.version !== packageManifest.version ||
    typeof packed.filename !== "string" ||
    path.basename(packed.filename) !== packed.filename ||
    !packed.filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack output does not match the staged package identity");
  }

  const tarballPath = path.join(outputDirectory, packed.filename);
  const receipt = await createNpmPackageCandidateReceipt({
    tarballPath,
    sourceSha,
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
  });
  const receiptPath = path.join(outputDirectory, "candidate-receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { receipt, receiptPath, tarballPath };
}

export async function readVerifiedNpmPackageCandidate(receiptPath, expected) {
  const receipt = readJson(receiptPath);
  if (
    receipt.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceSha ?? "") ||
    receipt.sourceSha !== expected.sourceSha ||
    receipt.packageName !== expected.packageName ||
    receipt.packageVersion !== expected.packageVersion ||
    typeof receipt.tarball !== "string" ||
    path.basename(receipt.tarball) !== receipt.tarball ||
    !receipt.tarball.endsWith(".tgz") ||
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength <= 0 ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256 ?? "")
  ) {
    throw new Error("npm candidate receipt does not match this source and package identity");
  }
  const tarballPath = path.join(path.dirname(path.resolve(receiptPath)), receipt.tarball);
  const actual = await createNpmPackageCandidateReceipt({
    tarballPath,
    sourceSha: receipt.sourceSha,
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
  });
  if (actual.byteLength !== receipt.byteLength || actual.sha256 !== receipt.sha256) {
    throw new Error("npm candidate archive does not match its receipt integrity values");
  }
  return { receipt, receiptPath: path.resolve(receiptPath), tarballPath };
}

export function validateNpmPackageManifest(manifest, expected, description) {
  if (manifest.name !== expected.name) {
    throw new Error(`${description} name is ${manifest.name}; expected ${expected.name}`);
  }
  if (manifest.version !== expected.version) {
    throw new Error(`${description} version is ${manifest.version}; expected ${expected.version}`);
  }
  if (manifest.private) throw new Error(`${description} must not be private`);
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${description} must declare publishConfig.access = public`);
  }
}

async function createNpmPackageCandidateReceipt({
  tarballPath,
  sourceSha,
  packageName,
  packageVersion,
}) {
  const stat = fs.lstatSync(tarballPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("npm candidate archive must be a nonempty regular file");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(tarballPath)) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  if (byteLength !== stat.size) throw new Error("npm candidate archive changed while hashing");
  return {
    schemaVersion: 1,
    sourceSha,
    packageName,
    packageVersion,
    tarball: path.basename(tarballPath),
    byteLength,
    sha256: hash.digest("hex"),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
