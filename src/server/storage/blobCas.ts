/**
 * Host-side SHA-256 blob CAS primitive.
 *
 * Callers choose the CAS root (and therefore its ownership/GC namespace).
 * Workspace blobstore RPC and central build artifacts intentionally use
 * separate roots while sharing addressing, atomic insertion, and hardlink
 * materialization semantics.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/;
const installChains = new Map<string, Promise<unknown>>();

export function centralBlobCasDir(centralDataPath: string): string {
  return path.join(centralDataPath, "cas");
}

export function validateBlobDigest(digest: string): void {
  if (!SHA256_DIGEST_RE.test(digest)) throw new Error("Invalid sha256 digest");
}

export function blobCasPath(rootDir: string, digest: string): string {
  validateBlobDigest(digest);
  return path.join(rootDir, "sha256", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function existingDirectoryChainSync(dirPath: string): string[] {
  const missing: string[] = [];
  for (let cursor = path.resolve(dirPath); ; cursor = path.dirname(cursor)) {
    try {
      if (!fs.statSync(cursor).isDirectory()) {
        throw new Error(`CAS directory path is not a directory: ${cursor}`);
      }
      return missing;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      missing.push(cursor);
      if (path.dirname(cursor) === cursor) throw error;
    }
  }
}

async function existingDirectoryChain(dirPath: string): Promise<string[]> {
  const missing: string[] = [];
  for (let cursor = path.resolve(dirPath); ; cursor = path.dirname(cursor)) {
    try {
      if (!(await fsp.stat(cursor)).isDirectory()) {
        throw new Error(`CAS directory path is not a directory: ${cursor}`);
      }
      return missing;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      missing.push(cursor);
      if (path.dirname(cursor) === cursor) throw error;
    }
  }
}

function syncDirectorySync(dirPath: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function syncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsp.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function directorySyncOrder(mutatedDir: string, missingDirs: readonly string[]): string[] {
  const ordered = [path.resolve(mutatedDir), ...missingDirs.map((dir) => path.dirname(dir))];
  return [...new Set(ordered)];
}

function ensureDurableDirectorySync(dirPath: string): void {
  const missing = existingDirectoryChainSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true });
  const leaf = missing[0];
  if (!leaf) return;
  for (const dir of directorySyncOrder(leaf, missing)) syncDirectorySync(dir);
}

async function ensureDurableDirectory(dirPath: string): Promise<void> {
  const missing = await existingDirectoryChain(dirPath);
  await fsp.mkdir(dirPath, { recursive: true });
  const leaf = missing[0];
  if (!leaf) return;
  for (const dir of directorySyncOrder(leaf, missing)) await syncDirectory(dir);
}

export function ensureBlobCasLayout(rootDir: string): void {
  ensureDurableDirectorySync(path.join(rootDir, "tmp"));
  ensureDurableDirectorySync(path.join(rootDir, "sha256"));
}

async function ensureBlobCasLayoutAsync(rootDir: string): Promise<void> {
  await Promise.all([
    ensureDurableDirectory(path.join(rootDir, "tmp")),
    ensureDurableDirectory(path.join(rootDir, "sha256")),
  ]);
}

function assertRegularFile(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile()) throw new Error(`CAS object is not a regular file: ${filePath}`);
}

function assertRegularFileSize(stat: fs.Stats, filePath: string, expectedSize: number): void {
  assertRegularFile(stat, filePath);
  if (stat.size !== expectedSize) {
    throw new Error(
      `CAS object size mismatch at ${filePath}: expected ${expectedSize}, observed ${stat.size}`
    );
  }
}

function sha256FileSync(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
      if (read === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertBlobDigest(filePath: string, expected: string, observed: string): void {
  if (observed !== expected) {
    throw new Error(`CAS object digest mismatch at ${filePath}: observed ${observed}`);
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

function existingBlobSync(
  filePath: string,
  digest: string,
  expectedSize: number,
  trustedSource?: fs.Stats
): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    assertRegularFileSize(stat, filePath, expectedSize);
    if (!trustedSource || !sameInode(stat, trustedSource)) {
      assertBlobDigest(filePath, digest, sha256FileSync(filePath));
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function existingBlob(
  filePath: string,
  digest: string,
  expectedSize: number,
  trustedSource?: fs.Stats
): Promise<boolean> {
  try {
    const stat = await fsp.lstat(filePath);
    assertRegularFileSize(stat, filePath, expectedSize);
    if (!trustedSource || !sameInode(stat, trustedSource)) {
      assertBlobDigest(filePath, digest, await sha256File(filePath));
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function syncFileSync(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function syncDirectoryChainSync(rootDir: string, leafDir: string): void {
  const root = path.resolve(rootDir);
  for (let cursor = path.resolve(leafDir); ; cursor = path.dirname(cursor)) {
    syncDirectorySync(cursor);
    if (cursor === root) {
      syncDirectorySync(path.dirname(root));
      return;
    }
    if (path.dirname(cursor) === cursor) {
      throw new Error(`CAS object path is outside its root: ${leafDir}`);
    }
  }
}

async function syncDirectoryChain(rootDir: string, leafDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  for (let cursor = path.resolve(leafDir); ; cursor = path.dirname(cursor)) {
    await syncDirectory(cursor);
    if (cursor === root) {
      await syncDirectory(path.dirname(root));
      return;
    }
    if (path.dirname(cursor) === cursor) {
      throw new Error(`CAS object path is outside its root: ${leafDir}`);
    }
  }
}

function installHardlinkSync(
  rootDir: string,
  digest: string,
  sourcePath: string,
  finalPath: string
): void {
  const sourceStat = fs.lstatSync(sourcePath);
  assertRegularFile(sourceStat, sourcePath);
  // Durability order is the invariant: flush the immutable inode, publish its
  // hardlink, then flush the target namespace and every directory created for it.
  syncFileSync(sourcePath);
  const finalDir = path.dirname(finalPath);
  const missing = existingDirectoryChainSync(finalDir);
  fs.mkdirSync(finalDir, { recursive: true });
  let raced = false;
  try {
    fs.linkSync(sourcePath, finalPath);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    raced = true;
  }
  if (!existingBlobSync(finalPath, digest, sourceStat.size, sourceStat)) {
    throw new Error(`CAS object disappeared during installation: ${finalPath}`);
  }
  if (raced) syncFileSync(finalPath);
  if (raced) syncDirectoryChainSync(rootDir, finalDir);
  else for (const dir of directorySyncOrder(finalDir, missing)) syncDirectorySync(dir);
}

async function installHardlink(
  rootDir: string,
  digest: string,
  sourcePath: string,
  finalPath: string
): Promise<void> {
  const sourceStat = await fsp.lstat(sourcePath);
  assertRegularFile(sourceStat, sourcePath);
  // Durability order is the invariant: flush the immutable inode, publish its
  // hardlink, then flush the target namespace and every directory created for it.
  await syncFile(sourcePath);
  const finalDir = path.dirname(finalPath);
  const missing = await existingDirectoryChain(finalDir);
  await fsp.mkdir(finalDir, { recursive: true });
  let raced = false;
  try {
    await fsp.link(sourcePath, finalPath);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    raced = true;
  }
  if (!(await existingBlob(finalPath, digest, sourceStat.size, sourceStat))) {
    throw new Error(`CAS object disappeared during installation: ${finalPath}`);
  }
  if (raced) await syncFile(finalPath);
  if (raced) await syncDirectoryChain(rootDir, finalDir);
  else for (const dir of directorySyncOrder(finalDir, missing)) await syncDirectory(dir);
}

export function putBlobBytesSync(
  rootDir: string,
  bytes: Buffer
): { digest: string; size: number; filePath: string } {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = blobCasPath(rootDir, digest);
  if (existingBlobSync(filePath, digest, bytes.byteLength)) {
    return { digest, size: bytes.byteLength, filePath };
  }

  ensureBlobCasLayout(rootDir);
  const tmpPath = path.join(rootDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, bytes, { flag: "wx", mode: 0o600 });
    installHardlinkSync(rootDir, digest, tmpPath, filePath);
    return { digest, size: bytes.byteLength, filePath };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Temp links have no authority; cleanup is best effort.
    }
  }
}

export async function putBlobBytes(
  rootDir: string,
  bytes: Buffer
): Promise<{ digest: string; size: number }> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = blobCasPath(rootDir, digest);
  return serializeByKey(installChains, filePath, async () => {
    if (await existingBlob(filePath, digest, bytes.byteLength)) {
      return { digest, size: bytes.byteLength };
    }

    await ensureBlobCasLayoutAsync(rootDir);
    const tmpPath = path.join(rootDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(tmpPath, bytes, { flag: "wx", mode: 0o600 });
      await installHardlink(rootDir, digest, tmpPath, filePath);
      return { digest, size: bytes.byteLength };
    } finally {
      await fsp.unlink(tmpPath).catch(() => {
        // Temp links have no authority; cleanup is best effort.
      });
    }
  });
}

/** Register an already-hashed immutable file without copying its bytes. */
export function linkBlobFileSync(rootDir: string, digest: string, sourcePath: string): string {
  const filePath = blobCasPath(rootDir, digest);
  const sourceStat = fs.lstatSync(sourcePath);
  assertRegularFile(sourceStat, sourcePath);
  if (existingBlobSync(filePath, digest, sourceStat.size, sourceStat)) return filePath;
  installHardlinkSync(rootDir, digest, sourcePath, filePath);
  return filePath;
}

/** Register an already-hashed immutable file and durably publish its CAS entry. */
export async function linkBlobFile(
  rootDir: string,
  digest: string,
  sourcePath: string
): Promise<string> {
  const filePath = blobCasPath(rootDir, digest);
  return serializeByKey(installChains, filePath, async () => {
    const sourceStat = await fsp.lstat(sourcePath);
    assertRegularFile(sourceStat, sourcePath);
    if (await existingBlob(filePath, digest, sourceStat.size, sourceStat)) return filePath;
    await installHardlink(rootDir, digest, sourcePath, filePath);
    return filePath;
  });
}

/** Verify that a CAS pathname exists and its bytes match its address. */
export async function verifyBlob(rootDir: string, digest: string): Promise<boolean> {
  const filePath = blobCasPath(rootDir, digest);
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile()) throw new Error(`CAS object is not a regular file: ${filePath}`);
    assertBlobDigest(filePath, digest, await sha256File(filePath));
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}
