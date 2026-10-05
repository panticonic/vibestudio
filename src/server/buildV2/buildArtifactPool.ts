import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { blobCasPath } from "../storage/blobCas.js";

export interface ArtifactPoolCollection {
  files: number;
  bytes: number;
  reclaimableFiles: number;
  reclaimableBytes: number;
  removedFiles: number;
  removedBytes: number;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * A build owns its file, not a reference to the pool pathname. Taking the
 * hardlink is the atomic ownership transfer: a concurrent collector can only
 * remove the pool's name, never the build's inode. On a miss publish from the
 * completed build file, so there is no unowned insertion/materialization gap.
 */
export async function writePooledArtifact(
  pool: string | null,
  target: string,
  bytes: Buffer
): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pooled = pool ? blobCasPath(pool, digest) : null;
  if (pooled && process.platform !== "win32") {
    try {
      await fs.promises.link(pooled, target);
      // Verify our owned link, not a pool name that can disappear concurrently.
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
      if (hash.digest("hex") !== digest) {
        throw new Error(`Build artifact pool integrity mismatch: ${pooled}`);
      }
      return;
    } catch (error) {
      if (!["ENOENT", "EXDEV", "EPERM", "EACCES", "EMLINK"].includes(code(error) ?? "")) {
        throw error;
      }
      // Cross-filesystem/unsupported links cannot share physical allocation.
      if (code(error) !== "ENOENT") {
        await fs.promises.writeFile(target, bytes, { flag: "wx" });
        return;
      }
    }
  }
  const file = await fs.promises.open(target, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  if (!pooled || process.platform === "win32") return;
  await fs.promises.mkdir(path.dirname(pooled), { recursive: true });
  try {
    await fs.promises.link(target, pooled);
  } catch (error) {
    if (!["EEXIST", "EXDEV", "EPERM", "EACCES", "EMLINK"].includes(code(error) ?? "")) throw error;
    // Another build published the same content. Both own complete files;
    // neither waits for or depends on that publisher's pool reference.
  }
}

/** Pool-only links have no build owner. No age or lease expiry establishes this. */
export async function collectArtifactPool(
  pool: string,
  options: { dryRun?: boolean } = {}
): Promise<ArtifactPoolCollection> {
  const result: ArtifactPoolCollection = {
    files: 0,
    bytes: 0,
    reclaimableFiles: 0,
    reclaimableBytes: 0,
    removedFiles: 0,
    removedBytes: 0,
  };
  const sha = path.join(pool, "sha256");
  const pending = [sha];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const stored = path.join(directory, entry.name);
      const relative = path.relative(sha, stored).split(path.sep);
      if (entry.isDirectory() && relative.length <= 2 && /^[a-f0-9]{2}$/u.test(entry.name)) {
        pending.push(stored);
        continue;
      }
      if (!entry.isFile() || relative.length !== 3 || !/^[a-f0-9]{60}$/u.test(entry.name)) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(stored);
      } catch (error) {
        if (code(error) === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      const bytes = stat.blocks * 512 || stat.size;
      result.files++;
      result.bytes += bytes;
      if (stat.nlink !== 1) continue;
      result.reclaimableFiles++;
      result.reclaimableBytes += bytes;
      if (options.dryRun) continue;
      // link/unlink are atomic. Even if another publisher takes this inode
      // after the stat, unlinking only this name preserves its owned target.
      try {
        await fs.promises.unlink(stored);
        result.removedFiles++;
        result.removedBytes += bytes;
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
    }
  }
  return result;
}
