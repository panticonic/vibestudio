import * as fs from "node:fs";
import * as path from "node:path";
import { formatRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import { dependencyCacheLocation } from "./dependencyCachePaths.js";
import { resolveRequiredHostArtifactRoot } from "../appRoot.js";
import {
  deduplicateDependencyContent,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";

type Preparation = { stagingDir: string; cacheDir: string };
type MaintenanceJob = { hostArtifactRoot: string; preparations: Preparation[]; prune: boolean };
type JobResult = { ok: true } | { ok: false; failure: ReturnType<typeof serializeRpcFailure> };

function parseJob(raw: string | undefined): MaintenanceJob {
  if (raw === undefined) throw new Error("Dependency maintenance job is missing");
  const value = JSON.parse(raw) as Partial<MaintenanceJob>;
  if (
    !value ||
    typeof value.hostArtifactRoot !== "string" ||
    path.resolve(value.hostArtifactRoot) !== resolveRequiredHostArtifactRoot() ||
    !Array.isArray(value.preparations) ||
    typeof value.prune !== "boolean" ||
    (value.preparations.length === 0 && !value.prune)
  ) {
    throw new Error("Dependency maintenance job is invalid");
  }
  for (const preparation of value.preparations) {
    if (
      !preparation ||
      typeof preparation.stagingDir !== "string" ||
      typeof preparation.cacheDir !== "string"
    ) {
      throw new Error("Dependency preparation descriptor is invalid");
    }
  }
  return value as MaintenanceJob;
}

async function prepareDependencyTree(
  preparation: Preparation,
  owners: Map<string, DerivedCacheCoordinator>
): Promise<void> {
  const cache = dependencyCacheLocation(preparation.cacheDir);
  const cacheDir = path.resolve(preparation.cacheDir);
  const stagingDir = path.resolve(preparation.stagingDir);
  const escapedKey = cache.key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    cacheDir !== path.join(cache.root, cache.key) ||
    path.dirname(stagingDir) !== cache.root ||
    !new RegExp(`^${escapedKey}\\.tmp\\.[a-f0-9]{32}$`, "u").test(path.basename(stagingDir))
  ) {
    throw new Error("Refusing dependency preparation outside its exact private staging directory");
  }
  const stagingStat = await fs.promises.lstat(stagingDir);
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    throw new Error("Dependency preparation staging path is not a private directory");
  }
  const receiptStat = await fs.promises.lstat(path.join(stagingDir, ".ready"));
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error("Dependency preparation staging directory has no regular receipt");
  }
  const nodeModulesStat = await fs.promises.lstat(path.join(stagingDir, "node_modules"));
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new Error("Dependency preparation staging directory has no node_modules tree");
  }

  let owner = owners.get(cache.root);
  if (!owner) {
    owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(cache.root));
    owners.set(cache.root, owner);
  }
  const lease = owner.acquire(cache.root, cache.key);
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    const prepared = await owner.maintain(stagingDir, () =>
      deduplicateDependencyContent(stagingDir)
    );
    if (prepared === null) {
      throw new Error("Dependency staging directory is already owned by another preparation");
    }
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  }
  try {
    lease.release();
  } catch (error) {
    if (hasPrimaryFailure) {
      throw new AggregateError(
        [primaryFailure, error],
        "Dependency preparation and lease release failed",
        {
          cause: primaryFailure,
        }
      );
    }
    throw error;
  }
  if (hasPrimaryFailure) throw primaryFailure;
}

async function main(): Promise<void> {
  const job = parseJob(process.argv[2]);
  const owners = new Map<string, DerivedCacheCoordinator>();
  const results: JobResult[] = [];
  const maintenanceFailures: unknown[] = [];
  const closeFailures: unknown[] = [];
  try {
    for (const preparation of job.preparations) {
      try {
        await prepareDependencyTree(preparation, owners);
        results.push({ ok: true });
      } catch (error) {
        maintenanceFailures.push(error);
        console.error(formatRpcFailure(error));
        results.push({ ok: false, failure: serializeRpcFailure(error) });
      }
    }
    if (job.prune) {
      try {
        await pruneUnreferencedDependencyContent();
        results.push({ ok: true });
      } catch (error) {
        maintenanceFailures.push(error);
        console.error(formatRpcFailure(error));
        results.push({ ok: false, failure: serializeRpcFailure(error) });
      }
    }
  } finally {
    for (const owner of owners.values()) {
      try {
        owner.close();
      } catch (error) {
        closeFailures.push(error);
      }
    }
  }

  if (closeFailures.length > 0) {
    const failures = [...maintenanceFailures, ...closeFailures];
    throw new AggregateError(failures, "Dependency maintenance and coordinator cleanup failed", {
      cause: maintenanceFailures[0] ?? closeFailures[0],
    });
  }

  const failed = results.some((result) => !result.ok);
  if (process.send) {
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "dependency-maintenance-results", results }, (error) =>
        error ? reject(error) : resolve()
      );
    });
    if (process.connected) process.disconnect();
  }
  if (failed) process.exitCode = 1;
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
