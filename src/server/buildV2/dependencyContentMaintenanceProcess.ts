import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { deduplicateDependencyContent } from "./dependencyContentStore.js";

const LOCK_STALE_MS = 30 * 60_000;

function validatedCacheDir(value: string): string {
  const cacheDir = path.resolve(value);
  const baseDir = path.resolve(getSharedDerivedDataPath(), "external-deps");
  if (path.dirname(cacheDir) !== baseDir || !/^[a-f0-9]{16}$/u.test(path.basename(cacheDir))) {
    throw new Error(`Refusing dependency maintenance path outside ${baseDir}`);
  }
  return cacheDir;
}

function acquireMaintenanceLock(cacheDir: string): (() => void) | null {
  const lockDir = path.join(path.dirname(cacheDir), ".maintenance");
  const lockPath = path.join(lockDir, `${path.basename(cacheDir)}.lock`);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      fs.closeSync(handle);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (!stat || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

async function main(): Promise<void> {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_LOW);
  } catch {
    // Priority adjustment is advisory and unavailable on some platforms.
  }
  for (const argument of process.argv.slice(2)) {
    const cacheDir = validatedCacheDir(argument);
    const release = acquireMaintenanceLock(cacheDir);
    if (!release) continue;
    try {
      if (fs.existsSync(path.join(cacheDir, ".ready"))) {
        await deduplicateDependencyContent(cacheDir);
      }
    } finally {
      release();
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
