import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { blobCasPath, linkReconstructableBlobFile } from "../storage/blobCas.js";

const HASH_CONCURRENCY = 8;
const VERIFIED_CONTENT_LIMIT = 100_000;
let contentPrune: Promise<DependencyContentPrune> | null = null;
const contentInstalls = new Map<string, Promise<string>>();
const verifiedContent = new Map<
  string,
  { dev: number; ino: number; size: number; mtimeMs: number }
>();

export interface DependencyContentDeduplication {
  files: number;
  bytes: number;
  linkedFiles: number;
  linkedBytes: number;
}

export interface DependencyContentPrune {
  files: number;
  bytes: number;
}

function contentStoreRoot(mode: number): string {
  return path.join(
    getSharedDerivedDataPath(),
    "dependency-files",
    (mode & 0o7777).toString(8).padStart(4, "0")
  );
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(storedPath);
      else if (entry.isFile()) files.push(storedPath);
    }
  }
  return files;
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function linkWithDiagnostics(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.promises.link(sourcePath, destinationPath);
  } catch (cause) {
    const [source, destinationDirectory] = await Promise.all([
      fs.promises.lstat(sourcePath).catch(() => null),
      fs.promises.lstat(path.dirname(destinationPath)).catch(() => null),
    ]);
    const errorDetails = cause as NodeJS.ErrnoException;
    const sourceLinks = source?.nlink;
    const sourceDevice = source?.dev;
    const destinationDevice = destinationDirectory?.dev;
    const sameDevice =
      sourceDevice !== undefined && destinationDevice !== undefined
        ? sourceDevice === destinationDevice
        : undefined;
    const details = [
      `code=${errorDetails.code ?? "unknown"}`,
      `errno=${typeof errorDetails.errno === "number" ? errorDetails.errno : "unknown"}`,
      `syscall=${errorDetails.syscall ?? "unknown"}`,
      `sourceLinks=${sourceLinks ?? "unavailable"}`,
      `sameDevice=${sameDevice ?? "unavailable"}`,
    ].join(" ");
    const failure = new Error(`Dependency content hardlink failed (${details})`, {
      cause,
    }) as NodeJS.ErrnoException;
    failure.name = "DependencyContentLinkError";
    if (errorDetails.code !== undefined) failure.code = errorDetails.code;
    if (errorDetails.errno !== undefined) failure.errno = errorDetails.errno;
    if (errorDetails.syscall !== undefined) failure.syscall = errorDetails.syscall;
    throw failure;
  }
}

async function ensureContentLink(
  storeRoot: string,
  digest: string,
  sourcePath: string,
  expectedSize: number
): Promise<string> {
  const target = blobCasPath(storeRoot, digest);
  const verified = verifiedContent.get(target);
  if (verified) {
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (
      stat &&
      stat.dev === verified.dev &&
      stat.ino === verified.ino &&
      stat.size === verified.size &&
      stat.mtimeMs === verified.mtimeMs
    ) {
      return target;
    }
    verifiedContent.delete(target);
  }

  const existing = contentInstalls.get(target);
  if (existing) return existing;
  const pending = linkReconstructableBlobFile(storeRoot, digest, sourcePath, expectedSize)
    .then(async (storedPath) => {
      const stat = await fs.promises.lstat(storedPath);
      if (verifiedContent.size >= VERIFIED_CONTENT_LIMIT) {
        verifiedContent.delete(verifiedContent.keys().next().value!);
      }
      verifiedContent.set(storedPath, {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return storedPath;
    })
    .finally(() => contentInstalls.delete(target));
  contentInstalls.set(target, pending);
  return pending;
}

async function replaceWithContentLink(
  filePath: string
): Promise<{ bytes: number; linked: boolean }> {
  const sourceStat = await fs.promises.lstat(filePath);
  const digest = await sha256File(filePath);
  const storeRoot = contentStoreRoot(sourceStat.mode);
  let storedPath = await ensureContentLink(storeRoot, digest, filePath, sourceStat.size);
  const storedStat = await fs.promises.lstat(storedPath);
  if (sameInode(sourceStat, storedStat)) return { bytes: sourceStat.size, linked: false };

  const replacement = path.join(
    path.dirname(filePath),
    `.dependency-link-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    try {
      await linkWithDiagnostics(blobCasPath(storeRoot, digest), replacement);
    } catch (error) {
      // An unreferenced-object sweep may remove the pool name after the CAS
      // lookup but before this link. Re-publish from our still-valid source;
      // no consumer ever depends on the pool pathname itself.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      verifiedContent.delete(storedPath);
      storedPath = await ensureContentLink(storeRoot, digest, filePath, sourceStat.size);
      await linkWithDiagnostics(storedPath, replacement);
    }
    await fs.promises.rename(replacement, filePath);
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  }
  try {
    await fs.promises.rm(replacement, { force: true });
  } catch (cleanupFailure) {
    if (hasPrimaryFailure) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Dependency content publication and temporary-link cleanup failed",
        { cause: primaryFailure }
      );
    }
    throw cleanupFailure;
  }
  if (hasPrimaryFailure) throw primaryFailure;
  return { bytes: sourceStat.size, linked: true };
}

/**
 * Replace immutable dependency payloads with hardlinks into one profile-wide
 * content store. The dependency directory must still be unpublished: callers
 * may read it only after this operation and the subsequent atomic promotion.
 *
 * Trusted installers finish mutations before publishing the cache. Workspace
 * consumers receive read-only MXC resource grants; file attributes do not carry
 * that authority. Preserve original modes in the store namespace so sharing
 * cannot change executable or permission bits. Symlinks are topology, not
 * payload, and deliberately remain in the closure.
 */
export async function deduplicateDependencyContent(
  unpublishedCacheDir: string
): Promise<DependencyContentDeduplication> {
  const files = await regularFiles(unpublishedCacheDir);
  let cursor = 0;
  const result: DependencyContentDeduplication = {
    files: 0,
    bytes: 0,
    linkedFiles: 0,
    linkedBytes: 0,
  };

  const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, async () => {
    for (;;) {
      const filePath = files[cursor++];
      if (!filePath) return;
      const linked = await replaceWithContentLink(filePath);
      result.files += 1;
      result.bytes += linked.bytes;
      if (linked.linked) {
        result.linkedFiles += 1;
        result.linkedBytes += linked.bytes;
      }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Dependency content deduplication workers failed", {
      cause: failures[0],
    });
  }
  return result;
}

async function pruneShaTree(root: string): Promise<DependencyContentPrune> {
  const result = { files: 0, bytes: 0 };
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(storedPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.lstat(storedPath).catch(() => null);
      if (!stat || stat.nlink !== 1) continue;
      await fs.promises.rm(storedPath, { force: true });
      result.files += 1;
      result.bytes += (stat.blocks ?? 0) * 512 || stat.size;
    }
  }
  // Keep SHA fanout directories: a publisher can be about to link a new object.
  return result;
}

/** Remove content objects that no published dependency environment references. */
export function pruneUnreferencedDependencyContent(): Promise<DependencyContentPrune> {
  if (contentPrune) return contentPrune;
  contentPrune = (async () => {
    const root = path.join(getSharedDerivedDataPath(), "dependency-files");
    let modes: fs.Dirent[];
    try {
      modes = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 };
      throw error;
    }
    const total = { files: 0, bytes: 0 };
    for (const mode of modes) {
      if (!mode.isDirectory() || !/^[0-7]{4}$/u.test(mode.name)) continue;
      const pruned = await pruneShaTree(path.join(root, mode.name, "sha256"));
      total.files += pruned.files;
      total.bytes += pruned.bytes;
    }
    return total;
  })().finally(() => {
    contentPrune = null;
  });
  return contentPrune;
}
