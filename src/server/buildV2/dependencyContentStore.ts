import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { blobCasPath, linkBlobFile } from "../storage/blobCas.js";

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

async function ensureContentLink(
  storeRoot: string,
  digest: string,
  sourcePath: string
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
  const pending = linkBlobFile(storeRoot, digest, sourcePath)
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
  const initialStat = await fs.promises.lstat(filePath);
  const immutableMode = initialStat.mode & 0o555;
  if ((initialStat.mode & 0o7777) !== immutableMode) {
    await fs.promises.chmod(filePath, immutableMode);
  }
  const sourceStat = await fs.promises.lstat(filePath);
  const digest = await sha256File(filePath);
  const storeRoot = contentStoreRoot(sourceStat.mode);
  let storedPath = await ensureContentLink(storeRoot, digest, filePath);
  const storedStat = await fs.promises.lstat(storedPath);
  if (sameInode(sourceStat, storedStat)) return { bytes: sourceStat.size, linked: false };

  const replacement = path.join(
    path.dirname(filePath),
    `.dependency-link-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  try {
    try {
      await fs.promises.link(blobCasPath(storeRoot, digest), replacement);
    } catch (error) {
      // An unreferenced-object sweep may remove the pool name after the CAS
      // lookup but before this link. Re-publish from our still-valid source;
      // no consumer ever depends on the pool pathname itself.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      verifiedContent.delete(storedPath);
      storedPath = await ensureContentLink(storeRoot, digest, filePath);
      await fs.promises.link(storedPath, replacement);
    }
    await fs.promises.rename(replacement, filePath);
  } finally {
    await fs.promises.rm(replacement, { force: true }).catch(() => undefined);
  }
  return { bytes: sourceStat.size, linked: true };
}

/**
 * Replace immutable dependency payloads with hardlinks into one profile-wide
 * content store. The dependency directory must still be unpublished: callers
 * may read it only after this operation and the subsequent atomic promotion.
 *
 * Files are made read-only before publication. This is the immutability fence
 * that makes shared inodes safe: a consumer cannot accidentally mutate every
 * closure through one writable hardlink. File mode remains part of the store
 * namespace, so equal executable and data bytes never share an inode.
 * Symlinks are topology, not payload, and deliberately remain in the closure.
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

  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, async () => {
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
    })
  );
  return result;
}

async function pruneShaTree(root: string): Promise<DependencyContentPrune> {
  const result = { files: 0, bytes: 0 };
  const pending = [root];
  const directories: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    directories.push(directory);
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
  for (const directory of directories.reverse()) {
    if (directory !== root) await fs.promises.rmdir(directory).catch(() => undefined);
  }
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
