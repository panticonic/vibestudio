import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import {
  deduplicateDependencyContent,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";

function validatedCacheDir(value: string): string {
  const cacheDir = path.resolve(value);
  const baseDir = path.resolve(getSharedDerivedDataPath(), "external-deps");
  if (path.dirname(cacheDir) !== baseDir || !/^[a-f0-9]{16}$/u.test(path.basename(cacheDir))) {
    throw new Error(`Refusing dependency maintenance path outside ${baseDir}`);
  }
  return cacheDir;
}

async function main(): Promise<void> {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_LOW);
  } catch {
    // Priority adjustment is advisory and unavailable on some platforms.
  }
  const root = path.join(getSharedDerivedDataPath(), "external-deps");
  const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  try {
    for (const argument of process.argv.slice(2)) {
      const cacheDir = validatedCacheDir(argument);
      const lease = owner.acquire(root, path.basename(cacheDir));
      try {
        await owner.maintain(cacheDir, async () => {
          if (fs.existsSync(path.join(cacheDir, ".ready")))
            await deduplicateDependencyContent(cacheDir);
        });
      } finally {
        lease.release();
      }
    }
    await pruneUnreferencedDependencyContent();
  } finally {
    owner.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
