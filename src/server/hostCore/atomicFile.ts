import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const data = JSON.stringify(value, null, 2);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, filePath);
    fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort cleanup follows.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file may not exist if open failed, or may already have been renamed.
    }
    throw err;
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some platforms/filesystems do not support directory fsync.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do here.
      }
    }
  }
}
