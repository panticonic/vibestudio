import * as fs from "node:fs";
import * as path from "node:path";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, OwnedScope } from "@vibestudio/shared/ownership";
import { BrowserDataError } from "../errors.js";

/** Exact owned resource; callers cannot retire an arbitrary path by prefix. */
export interface TempCopy {
  path: string;
  release(): Promise<void>;
}

async function copyToTemp(source: string, database: boolean): Promise<TempCopy> {
  if (!fs.existsSync(source))
    throw new BrowserDataError("PROFILE_NOT_FOUND", `File not found: ${source}`);
  const ownership = await Ownership.open({
    profileDir: getProfileDataPath(),
    lifetime: "leased",
    meta: { role: "browser-import-copy" },
  });
  try {
    const directory = await ownership.scratch("vibestudio-browser-import-");
    const destination = path.join(directory, path.basename(source));
    fs.copyFileSync(source, destination);
    if (database)
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, destination + suffix);
      }
    return { path: destination, release: () => ownership.release() };
  } catch (error) {
    try {
      await ownership.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Browser copy and retirement failed", {
        cause: error,
      });
    }
    const cause = error as NodeJS.ErrnoException;
    if (["EBUSY", "EACCES", "EPERM"].includes(cause.code ?? "")) {
      throw new BrowserDataError(
        database ? "DB_LOCKED" : "TCC_ACCESS_DENIED",
        `Cannot copy browser file: ${source}`,
        cause.code
      );
    }
    throw error;
  }
}

/** SQLite WAL/SHM recovery runs against an isolated owned copy, never the live profile. */
export function copyDatabaseToTemp(source: string): Promise<TempCopy> {
  return copyToTemp(source, true);
}
export function copyFileToTemp(source: string): Promise<TempCopy> {
  return copyToTemp(source, false);
}

/** Join both cleanups even if closing SQLite fails; preserve every failure. */
export async function releaseTempDatabase(
  database: { close(): void },
  copy: TempCopy
): Promise<void> {
  const cleanup = new OwnedScope();
  cleanup.defer(() => copy.release());
  cleanup.defer(() => database.close());
  await cleanup.close();
}
