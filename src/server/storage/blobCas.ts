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

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/;

export function centralBlobCasDir(centralDataPath: string): string {
  return path.join(centralDataPath, "cas");
}

export function validateBlobDigest(digest: string): void {
  if (!SHA256_DIGEST_RE.test(digest)) throw new Error("Invalid sha256 digest");
}

export function ensureBlobCasLayout(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "sha256"), { recursive: true });
}

export function blobCasPath(rootDir: string, digest: string): string {
  validateBlobDigest(digest);
  return path.join(rootDir, "sha256", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function promoteTempSync(tmpPath: string, finalPath: string): void {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    fs.linkSync(tmpPath, finalPath);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup. The content-addressed final path is already
      // complete; a stale temp file is swept when the owning service starts.
    }
  }
}

export function putBlobBytesSync(
  rootDir: string,
  bytes: Buffer
): { digest: string; size: number; filePath: string } {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = blobCasPath(rootDir, digest);
  if (fs.existsSync(filePath)) return { digest, size: bytes.byteLength, filePath };

  ensureBlobCasLayout(rootDir);
  const tmpPath = path.join(rootDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, bytes, { flag: "wx" });
  promoteTempSync(tmpPath, filePath);
  return { digest, size: bytes.byteLength, filePath };
}

export async function putBlobBytes(
  rootDir: string,
  bytes: Buffer
): Promise<{ digest: string; size: number }> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = blobCasPath(rootDir, digest);
  try {
    await fsp.access(filePath);
    return { digest, size: bytes.byteLength };
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }

  ensureBlobCasLayout(rootDir);
  const tmpPath = path.join(rootDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmpPath, bytes, { flag: "wx" });
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsp.link(tmpPath, filePath);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    return { digest, size: bytes.byteLength };
  } finally {
    await fsp.unlink(tmpPath).catch((error) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

/** Register an already-hashed immutable file without copying its bytes. */
export function linkBlobFileSync(rootDir: string, digest: string, sourcePath: string): string {
  const filePath = blobCasPath(rootDir, digest);
  if (fs.existsSync(filePath)) return filePath;
  ensureBlobCasLayout(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.linkSync(sourcePath, filePath);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  return filePath;
}
