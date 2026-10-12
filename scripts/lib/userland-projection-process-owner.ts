import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import { drainDependencyContentMaintenance } from "../../src/server/buildV2/dependencyContentMaintenance.js";
import { drainExternalDependencyPruning } from "../../src/server/buildV2/externalDeps.js";
import { runOwnedCleanupSteps } from "./owned-cleanup.mjs";

/**
 * Retire projection resources at a dedicated process owner's boundary.
 * Releasing a projection itself remains lightweight; these drains must not run
 * for an individual borrow in a long-lived host process.
 */
export async function retireUserlandProjectionProcess(
  releases: readonly (() => void | Promise<void>)[] = []
): Promise<void> {
  await runOwnedCleanupSteps(
    [
      ...releases,
      drainExternalDependencyPruning,
      drainDependencyContentMaintenance,
      closeDerivedCacheCoordinators,
    ],
    "Userland projection process cleanup failed"
  );
}
