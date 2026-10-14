import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { valid as validSemver } from "semver";
import { create as createTarArchive, list as listTarArchive } from "tar";

export async function packNpmPackageCandidate({
  packageRoot,
  outputDirectory,
  sourceSha,
  createArchive = createPackageArchive,
}) {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha ?? "")) {
    throw new Error("npm candidate source SHA must be a full Git commit SHA");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`npm candidate output directory is not empty: ${outputDirectory}`);
  }

  const packageManifest = readJson(path.join(packageRoot, "package.json"));
  const archiveEntries = npmArchiveEntries(packageManifest, packageRoot);
  const archiveName = npmArchiveName(packageManifest);
  const tarballPath = path.join(outputDirectory, archiveName);
  const receiptPath = path.join(outputDirectory, "candidate-receipt.json");
  try {
    await createArchive({ packageRoot, tarballPath, archiveEntries });
    const receipt = await createNpmPackageCandidateReceipt({
      tarballPath,
      sourceSha,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
    });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { receipt, receiptPath, tarballPath };
  } catch (error) {
    const cleanupFailures = [];
    for (const ownedPath of [receiptPath, tarballPath]) {
      try {
        fs.rmSync(ownedPath, { force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "npm archive creation and cleanup failed",
        {
          cause: error,
        }
      );
    }
    throw error;
  }
}

async function createPackageArchive({ packageRoot, tarballPath, archiveEntries }) {
  const statCache = new Map();
  for (const relative of archiveEntries) {
    const absolute = path.resolve(packageRoot, relative);
    const stat = fs.lstatSync(absolute);
    // npm's registry rejects tar hard-link records. The prepared template CAS
    // deliberately deduplicates equal blobs with filesystem hard links, but an
    // npm archive is a transport boundary and must carry every path as a regular
    // file. Supplying the already-owned stat with nlink normalized preserves the
    // bytes while preventing tar from converting repeated inodes into links.
    if (stat.isFile()) stat.nlink = 1;
    statCache.set(absolute, stat);
    statCache.set(absolute.replaceAll("\\", "/"), stat);
  }
  await createTarArchive(
    {
      cwd: packageRoot,
      file: tarballPath,
      // The server package embeds its prepared offline runtime. Maximum gzip
      // compression keeps the single registry upload below slow-link failure
      // windows without changing the installed bytes.
      gzip: { level: 9, mtime: 0 },
      mtime: new Date("1985-10-26T08:15:00.000Z"),
      noDirRecurse: true,
      portable: true,
      prefix: "package/",
      statCache,
      strict: true,
    },
    archiveEntries
  );
}

function npmArchiveEntries(manifest, packageRoot) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("npm candidate manifest must declare its packaged file roots");
  }
  const roots = [];
  for (const entry of manifest.files) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      path.isAbsolute(entry) ||
      entry.includes("\\") ||
      entry
        .split("/")
        .some((component) => component === "" || component === "." || component === "..")
    ) {
      throw new Error(`npm candidate manifest contains an unsafe file root: ${String(entry)}`);
    }
    const resolved = path.resolve(packageRoot, entry);
    if (!fs.existsSync(resolved)) {
      throw new Error(`npm candidate manifest file root does not exist: ${entry}`);
    }
    roots.push(entry);
  }
  return enumerateArchiveFiles(packageRoot, ["package.json", ...new Set(roots)]);
}

function enumerateArchiveFiles(packageRoot, roots) {
  const files = new Set();
  const visit = (relative) => {
    const absolute = path.join(packageRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`npm candidate staged tree contains a symbolic link: ${relative}`);
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`npm candidate staged tree contains a non-file entry: ${relative}`);
    }
    files.add(relative.split(path.sep).join("/"));
  };
  for (const root of roots.sort()) visit(root);
  return [...files];
}

function npmArchiveName(manifest) {
  if (
    typeof manifest.name !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(manifest.name) ||
    typeof manifest.version !== "string" ||
    validSemver(manifest.version) === null
  ) {
    throw new Error("npm candidate manifest has an invalid package identity");
  }
  return `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${manifest.version}.tgz`;
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
    validateArchive: false,
  });
  if (actual.byteLength !== receipt.byteLength || actual.sha256 !== receipt.sha256) {
    throw new Error("npm candidate archive does not match its receipt integrity values");
  }
  await assertRegistryArchiveEntries(tarballPath);
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
  validateArchive = true,
}) {
  const stat = fs.lstatSync(tarballPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("npm candidate archive must be a nonempty regular file");
  }
  if (validateArchive) await assertRegistryArchiveEntries(tarballPath);
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

async function assertRegistryArchiveEntries(tarballPath) {
  const hardLinks = [];
  await listTarArchive({
    file: tarballPath,
    strict: true,
    onReadEntry(entry) {
      if (entry.type === "Link") hardLinks.push(entry.path);
    },
  });
  if (hardLinks.length > 0) {
    throw new Error(
      `npm candidate archive contains registry-forbidden hard links: ${hardLinks.slice(0, 3).join(", ")}`
    );
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
