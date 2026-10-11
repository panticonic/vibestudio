import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
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
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    for (const argument of process.argv.slice(2)) {
      const { root, key, directory: cacheDir } = dependencyCacheLocation(argument);
      let owner = owners.get(root);
      if (!owner) {
        owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
        owners.set(root, owner);
      }
      const lease = owner.acquire(root, key);
      let operationFailure: unknown;
      let hasOperationFailure = false;
      try {
        await owner.maintain(cacheDir, async () => {
          if (fs.existsSync(path.join(cacheDir, ".ready")))
            await deduplicateDependencyContent(cacheDir);
        });
      } catch (error) {
        operationFailure = error;
        hasOperationFailure = true;
      } finally {
        try {
          lease.release();
        } catch (error) {
          operationFailure = hasOperationFailure
            ? new AggregateError(
                [operationFailure, error],
                "Dependency maintenance and lease release failed"
              )
            : error;
          hasOperationFailure = true;
        }
      }
      if (hasOperationFailure) throw operationFailure;
    }
    await pruneUnreferencedDependencyContent();
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  }
  const closeFailures: unknown[] = [];
  for (const owner of owners.values()) {
    try {
      owner.close();
    } catch (error) {
      closeFailures.push(error);
    }
  }
  if (hasPrimaryFailure && closeFailures.length > 0)
    throw new AggregateError(
      [primaryFailure, ...closeFailures],
      "Dependency maintenance and coordinator cleanup failed"
    );
  if (hasPrimaryFailure) throw primaryFailure;
  if (closeFailures.length === 1) throw closeFailures[0];
  if (closeFailures.length > 1)
    throw new AggregateError(closeFailures, "Dependency maintenance coordinator cleanup failed");
}

void main().catch(async (error) => {
  const failures: unknown[] = [error];
  if (process.send) {
    try {
      await new Promise<void>((resolve, reject) => {
        process.send!(
          { type: "dependency-maintenance-failure", failure: serializeRpcFailure(error) },
          (sendError) => (sendError ? reject(sendError) : resolve())
        );
      });
    } catch (sendError) {
      failures.push(sendError);
    }
    if (process.connected) {
      try {
        process.disconnect();
      } catch (disconnectError) {
        failures.push(disconnectError);
      }
    }
  }
  const failure =
    failures.length > 1
      ? new AggregateError(
          failures,
          "Dependency maintenance failed while reporting or retiring its owner channel"
        )
      : error;
  console.error(formatRpcFailure(failure));
  process.exitCode = 1;
});
