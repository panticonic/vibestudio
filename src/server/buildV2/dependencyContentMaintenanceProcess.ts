import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import { dependencyCacheLocation } from "./dependencyCachePaths.js";
import {
  deduplicateDependencyContent,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";

async function main(): Promise<void> {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_LOW);
  } catch {
    // Priority adjustment is advisory and unavailable on some platforms.
  }
  const owners = new Map<string, DerivedCacheCoordinator>();
  try {
    for (const argument of process.argv.slice(2)) {
      const { root, key, directory: cacheDir } = dependencyCacheLocation(argument);
      let owner = owners.get(root);
      if (!owner) {
        owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
        owners.set(root, owner);
      }
      const lease = owner.acquire(root, key);
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
    for (const owner of owners.values()) owner.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
