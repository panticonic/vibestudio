import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export type AtomicWriteFs = Pick<
  typeof fs,
  | "chmodSync"
  | "closeSync"
  | "fsyncSync"
  | "mkdirSync"
  | "openSync"
  | "renameSync"
  | "rmSync"
  | "writeFileSync"
>;

/**
 * Durably replace one file without ever truncating the previous good value.
 * The temp file lives in the target directory so rename is atomic on the same
 * filesystem. Both file contents and the containing-directory rename are
 * synced before success is reported.
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: { mode?: number; fs?: AtomicWriteFs } = {}
): void {
  const fsImpl = options.fs ?? fs;
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(filePath);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fileFd: number | null = null;
  let dirFd: number | null = null;
  try {
    fileFd = fsImpl.openSync(tempPath, "wx", mode);
    fsImpl.writeFileSync(fileFd, data);
    fsImpl.fsyncSync(fileFd);
    fsImpl.closeSync(fileFd);
    fileFd = null;
    fsImpl.renameSync(tempPath, filePath);
    fsImpl.chmodSync(filePath, mode);
    if (process.platform !== "win32") {
      dirFd = fsImpl.openSync(dir, "r");
      fsImpl.fsyncSync(dirFd);
      fsImpl.closeSync(dirFd);
      dirFd = null;
    }
  } catch (error) {
    if (fileFd !== null) {
      try {
        fsImpl.closeSync(fileFd);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (dirFd !== null) {
      try {
        fsImpl.closeSync(dirFd);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}
