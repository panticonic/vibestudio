import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECEIPT_SCHEMA_VERSION = 1;

/**
 * Prove that electron-builder's update manifest describes exactly the files
 * that will be published beside it. The manifest is executable release input:
 * electron-updater trusts its paths and SHA-512 digests when replacing an app.
 */
export async function verifyElectronUpdaterMetadata({
  metadataPath,
  expectedVersion,
  artifactPaths,
  receiptPath,
  writeReceiptPath,
}) {
  const version = normalizeVersion(expectedVersion);
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) {
    throw new Error("at least one updater artifact is required");
  }

  if (receiptPath) {
    if (writeReceiptPath)
      throw new Error("cannot read and write an updater metadata receipt together");
    return verifyReceipt({ metadataPath, version, artifactPaths, receiptPath });
  }

  const metadataBytes = await fs.readFile(metadataPath);
  // Candidate builders already install the locked workspace dependencies.
  // Publication deliberately does not; it verifies the resulting immutable
  // receipt with Node built-ins instead of resolving dependencies again.
  const { parse } = await import("yaml");
  const metadata = parse(metadataBytes.toString("utf8"), { uniqueKeys: true });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${metadataPath}: updater metadata must be a mapping`);
  }
  if (metadata.version !== version) {
    throw new Error(
      `${metadataPath}: version ${JSON.stringify(metadata.version)} does not match ${version}`
    );
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`${metadataPath}: files must be a non-empty sequence`);
  }

  const artifacts = new Map();
  for (const artifactPath of artifactPaths) {
    const name = path.basename(artifactPath);
    if (artifacts.has(name)) throw new Error(`duplicate updater artifact name: ${name}`);
    const stat = await fs.stat(artifactPath);
    if (!stat.isFile()) throw new Error(`${artifactPath}: updater artifact must be a regular file`);
    artifacts.set(name, {
      path: artifactPath,
      size: stat.size,
      sha512: await sha512(artifactPath),
    });
  }

  const referenced = new Map();
  for (const [index, entry] of metadata.files.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${metadataPath}: files[${index}] must be a mapping`);
    }
    const name = localArtifactName(entry.url, `${metadataPath}: files[${index}].url`);
    if (referenced.has(name))
      throw new Error(`${metadataPath}: artifact ${name} is referenced twice`);
    const artifact = artifacts.get(name);
    if (!artifact)
      throw new Error(`${metadataPath}: referenced artifact is not published: ${name}`);
    assertPositiveSafeInteger(entry.size, `${metadataPath}: files[${index}].size`);
    assertSha512(entry.sha512, `${metadataPath}: files[${index}].sha512`);
    if (entry.size !== artifact.size) {
      throw new Error(
        `${metadataPath}: ${name} size ${entry.size} does not match artifact size ${artifact.size}`
      );
    }
    if (entry.sha512 !== artifact.sha512) {
      throw new Error(`${metadataPath}: ${name} SHA-512 does not match the published artifact`);
    }
    referenced.set(name, entry);
  }

  for (const name of artifacts.keys()) {
    if (!referenced.has(name))
      throw new Error(`${metadataPath}: published artifact is unreferenced: ${name}`);
  }
  if (referenced.size !== artifacts.size) {
    throw new Error(`${metadataPath}: updater metadata and published artifact sets differ`);
  }

  const primaryName = localArtifactName(metadata.path, `${metadataPath}: path`);
  const primary = referenced.get(primaryName);
  if (!primary)
    throw new Error(`${metadataPath}: primary path is not present in files: ${primaryName}`);
  assertSha512(metadata.sha512, `${metadataPath}: sha512`);
  if (metadata.sha512 !== primary.sha512) {
    throw new Error(
      `${metadataPath}: primary SHA-512 does not match files entry for ${primaryName}`
    );
  }

  const result = { version, artifacts: [...artifacts.keys()].sort(), primary: primaryName };
  if (writeReceiptPath) {
    await fs.writeFile(
      writeReceiptPath,
      `${JSON.stringify(
        {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          version,
          metadata: {
            name: path.basename(metadataPath),
            sha256: createHash("sha256").update(metadataBytes).digest("hex"),
          },
          artifacts: [...artifacts.entries()]
            .map(([name, artifact]) => ({
              name,
              size: artifact.size,
              sha512: artifact.sha512,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          primary: primaryName,
        },
        null,
        2
      )}\n`
    );
  }
  return result;
}

async function verifyReceipt({ metadataPath, version, artifactPaths, receiptPath }) {
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${receiptPath}: updater metadata receipt must be an object`);
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`${receiptPath}: unsupported updater metadata receipt schema`);
  }
  if (receipt.version !== version) {
    throw new Error(`${receiptPath}: receipt version does not match ${version}`);
  }
  if (
    !receipt.metadata ||
    receipt.metadata.name !== path.basename(metadataPath) ||
    typeof receipt.metadata.sha256 !== "string"
  ) {
    throw new Error(`${receiptPath}: receipt names different updater metadata`);
  }
  const metadataSha256 = createHash("sha256")
    .update(await fs.readFile(metadataPath))
    .digest("hex");
  if (receipt.metadata.sha256 !== metadataSha256) {
    throw new Error(`${receiptPath}: updater metadata bytes differ from the verified candidate`);
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    throw new Error(`${receiptPath}: receipt has no artifacts`);
  }
  const expected = new Map();
  for (const entry of receipt.artifacts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${receiptPath}: invalid artifact receipt`);
    }
    const name = localArtifactName(entry.name, `${receiptPath}: artifact name`);
    if (expected.has(name)) throw new Error(`${receiptPath}: duplicate artifact receipt: ${name}`);
    assertPositiveSafeInteger(entry.size, `${receiptPath}: ${name} size`);
    assertSha512(entry.sha512, `${receiptPath}: ${name} sha512`);
    expected.set(name, entry);
  }
  if (!expected.has(receipt.primary)) throw new Error(`${receiptPath}: invalid primary artifact`);
  const actualNames = new Set();
  for (const artifactPath of artifactPaths) {
    const name = path.basename(artifactPath);
    if (actualNames.has(name)) throw new Error(`duplicate updater artifact name: ${name}`);
    actualNames.add(name);
    const entry = expected.get(name);
    if (!entry) throw new Error(`${receiptPath}: unverified published artifact: ${name}`);
    const stat = await fs.stat(artifactPath);
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error(`${receiptPath}: published artifact size differs: ${name}`);
    }
    if ((await sha512(artifactPath)) !== entry.sha512) {
      throw new Error(`${receiptPath}: published artifact SHA-512 differs: ${name}`);
    }
  }
  for (const name of expected.keys()) {
    if (!actualNames.has(name))
      throw new Error(`${receiptPath}: verified artifact is not published: ${name}`);
  }
  return { version, artifacts: [...actualNames].sort(), primary: receipt.primary };
}

function normalizeVersion(input) {
  if (typeof input !== "string" || input.length === 0)
    throw new Error("expected version is required");
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`invalid expected version: ${input}`);
  }
  return version;
}

function localArtifactName(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  if (value !== path.basename(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a local artifact filename`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
}

function assertSha512(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} must be a canonical base64 SHA-512 digest`);
  }
}

function sha512(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("base64")));
  });
}

async function main(argv) {
  const positional = [];
  let receiptPath;
  let writeReceiptPath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--receipt" || argv[index] === "--write-receipt") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argv[index]} requires a path`);
      if (argv[index] === "--receipt") receiptPath = value;
      else writeReceiptPath = value;
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  const [metadataPath, expectedVersion, ...artifactPaths] = positional;
  if (!metadataPath || !expectedVersion || artifactPaths.length === 0) {
    throw new Error(
      "usage: verify-electron-updater-metadata.mjs [--receipt path | --write-receipt path] <metadata.yml> <version-or-tag> <artifact>..."
    );
  }
  const result = await verifyElectronUpdaterMetadata({
    metadataPath,
    expectedVersion,
    artifactPaths,
    receiptPath,
    writeReceiptPath,
  });
  process.stdout.write(
    `verified updater metadata ${metadataPath}: ${result.version}, ${result.artifacts.join(", ")}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
