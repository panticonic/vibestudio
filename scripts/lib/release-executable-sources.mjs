/**
 * The executable module inventory of a release build, stored once per module.
 *
 * Each build seals an inventory of every module it can execute, source included,
 * for static authority analysis. Builds share most of their modules (every
 * extension bundles the same dependencies), so repeating the sources in each
 * build's inventory multiplied a release's size about nine times over.
 *
 * A release therefore stores each build's inventory as references (module id,
 * content digest, package, format) and every distinct source once in a pool
 * beside the builds, named by its digest. The pool is content-addressed: a
 * source is accepted only if it hashes to the digest that names it.
 *
 * Working build stores keep the full inventory; this form is only for releases.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** The full inventory of a working store: module sources inline. */
export const EXECUTABLE_MODULES_FILE = "executable-modules.json.gz";
/** A release build's inventory: the same entries without their sources. */
export const EXECUTABLE_MODULE_REFS_FILE = "executable-module-refs.json.gz";
/** The release directory (beside the build directories) holding each source once. */
export const EXECUTABLE_SOURCES_DIR = "executable-sources";

const DIGEST = /^[0-9a-f]{64}$/u;
const READ_CONCURRENCY = 16;

function assertDigest(digest) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    throw new Error(`Invalid executable module digest: ${String(digest)}`);
  }
  return digest;
}

/** The pool file holding the source with this digest. */
export function executableSourceFile(poolDirectory, digest) {
  return path.join(poolDirectory, `${assertDigest(digest)}.gz`);
}

/** The digest of a module source, as the compiler computes it. */
export function executableSourceDigest(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Split a full inventory into references and the sources they name. */
export function compactExecutableModules(modules) {
  if (!Array.isArray(modules)) throw new Error("Invalid executable module inventory");
  const references = [];
  const sources = new Map();
  for (const module of modules) {
    const { source, ...reference } = module;
    if (typeof source !== "string") throw new Error("Executable module inventory lacks a source");
    if (reference.contentDigest !== executableSourceDigest(source)) {
      throw new Error(`Executable module source does not match its digest: ${reference.moduleId}`);
    }
    references.push(reference);
    sources.set(reference.contentDigest, source);
  }
  return { references, sources };
}

/** Add the sources to the pool; one that is already there is left alone. */
export async function writeExecutableSources(poolDirectory, sources) {
  await fsp.mkdir(poolDirectory, { recursive: true });
  const pending = [...sources];
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, async () => {
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      const [digest, source] = entry;
      const file = executableSourceFile(poolDirectory, digest);
      try {
        await fsp.access(file);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await fsp.writeFile(temporary, gzipSync(Buffer.from(source, "utf8"), { level: 9 }));
        try {
          await fsp.rename(temporary, file);
        } catch (renameError) {
          // A concurrent export of another build published the same source first.
          try {
            await fsp.access(file);
          } catch {
            throw renameError;
          }
        }
      } finally {
        await fsp.rm(temporary, { force: true });
      }
    }
  });
  await Promise.all(workers);
}

/** Read one source from the pool, proving it is the one its digest names. */
export async function readExecutableSource(poolDirectory, digest) {
  let source;
  try {
    source = gunzipSync(await fsp.readFile(executableSourceFile(poolDirectory, digest))).toString(
      "utf8"
    );
  } catch (error) {
    throw new Error(`Executable module source ${digest} is unreadable: ${error.message}`, {
      cause: error,
    });
  }
  if (executableSourceDigest(source) !== digest) {
    throw new Error(`Executable module source ${digest} does not match its digest`);
  }
  return source;
}

/** Give every reference its source, reading each distinct source once. */
export async function expandExecutableModules(references, poolDirectory) {
  if (!Array.isArray(references)) throw new Error("Invalid executable module inventory");
  const digests = [
    ...new Set(references.map((reference) => assertDigest(reference.contentDigest))),
  ];
  const sources = new Map();
  const pending = [...digests];
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, async () => {
    for (let digest = pending.pop(); digest; digest = pending.pop()) {
      sources.set(digest, await readExecutableSource(poolDirectory, digest));
    }
  });
  await Promise.all(workers);
  return references.map((reference) => ({
    ...reference,
    source: sources.get(reference.contentDigest),
  }));
}

/** Decode a stored inventory file (references or full entries). */
export function parseExecutableModulesFile(bytes) {
  const parsed = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("Invalid executable module inventory");
  return parsed;
}

/** The encoded form of a reference list. */
export function encodeExecutableModuleReferences(references) {
  return gzipSync(Buffer.from(JSON.stringify(references), "utf8"), { level: 9 });
}

/**
 * Prove a release's pool is exactly what its inventories name: every referenced
 * source present and matching its digest, and nothing else in the pool.
 */
export async function verifyExecutableSourcePool(poolDirectory, referencedDigests) {
  const expected = new Set([...referencedDigests].map(assertDigest));
  let names;
  try {
    names = await fsp.readdir(poolDirectory);
  } catch (error) {
    if (error.code === "ENOENT" && expected.size === 0) return;
    throw error;
  }
  const actual = new Set(names);
  for (const digest of expected) {
    if (!actual.has(`${digest}.gz`)) {
      throw new Error(`Release executable source pool lacks ${digest}`);
    }
  }
  for (const name of actual) {
    const digest = name.slice(0, -".gz".length);
    if (!name.endsWith(".gz") || !expected.has(digest)) {
      throw new Error(`Release executable source pool holds an unreferenced entry: ${name}`);
    }
  }
  const pending = [...expected];
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, async () => {
    for (let digest = pending.pop(); digest; digest = pending.pop()) {
      await readExecutableSource(poolDirectory, digest);
    }
  });
  await Promise.all(workers);
}
