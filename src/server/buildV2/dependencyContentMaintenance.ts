import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deserializeRpcFailure, formatRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";

export const DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS = 3 * 60_000;

type PendingPreparation = {
  hostArtifactRoot: string;
  stagingDir: string;
  cacheDir: string;
  resolve(): void;
  reject(error: unknown): void;
};
const pendingPreparations: PendingPreparation[] = [];
const pendingContentPrunes = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | null = null;
let activeOperation: Promise<void> | null = null;
const failures: unknown[] = [];

function recordFailure(error: unknown): void {
  failures.push(error);
  console.warn(`[externalDeps] Dependency maintenance failed: ${formatRpcFailure(error)}`);
}

/** Admission is already quiescent at shutdown. Flush queued work and join every owned child. */
export async function drainDependencyContentMaintenance(): Promise<void> {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = null;
  while (activeOperation || pendingPreparations.length > 0 || pendingContentPrunes.size > 0) {
    if (activeOperation) {
      await activeOperation;
      continue;
    }
    startPendingMaintenance();
  }
  if (failures.length > 0) {
    const errors = failures.splice(0);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Dependency maintenance operations failed", {
      cause: errors[0],
    });
  }
}

export function dependencyContentMaintenanceEntry(hostArtifactRoot: string): string {
  return getPhysicalAppPath(path.resolve(hostArtifactRoot), "dependency-content-maintenance.cjs");
}

/** Prepare one private install tree before its directory is atomically published. */
export function prepareDependencyContent(
  stagingDir: string,
  cacheDir: string,
  hostArtifactRoot: string
): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    pendingPreparations.push({
      hostArtifactRoot: path.resolve(hostArtifactRoot),
      stagingDir: path.resolve(stagingDir),
      cacheDir: path.resolve(cacheDir),
      resolve,
      reject,
    });
  });
  if (!activeOperation) queueMicrotask(startPendingMaintenance);
  return promise;
}

/** Request CAS pruning through the same owned child used for dependency maintenance. */
export function scheduleDependencyContentPrune(hostArtifactRoot: string): void {
  pendingContentPrunes.add(path.resolve(hostArtifactRoot));
  scheduleMaintenanceTimer();
}

function scheduleMaintenanceTimer(): void {
  if (maintenanceTimer || activeOperation || pendingContentPrunes.size === 0) return;
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    startPendingMaintenance();
  }, DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);
  maintenanceTimer.unref();
}

function startPendingMaintenance(): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = null;
  if (activeOperation || (pendingPreparations.length === 0 && pendingContentPrunes.size === 0))
    return;
  const hostArtifactRoot =
    pendingPreparations[0]?.hostArtifactRoot ?? pendingContentPrunes.values().next().value;
  if (!hostArtifactRoot) return;
  const preparations = pendingPreparations.filter(
    (preparation) => preparation.hostArtifactRoot === hostArtifactRoot
  );
  for (const preparation of preparations) {
    const index = pendingPreparations.indexOf(preparation);
    pendingPreparations.splice(index, 1);
  }
  const prune = pendingContentPrunes.delete(hostArtifactRoot);

  let entry: string;
  try {
    entry = dependencyContentMaintenanceEntry(hostArtifactRoot);
  } catch (error) {
    if (prune) recordFailure(error);
    scheduleMaintenanceTimer();
    for (const preparation of preparations) preparation.reject(error);
    return;
  }
  if (!fs.existsSync(entry)) {
    const error = new Error(`Dependency maintenance entry is missing: ${entry}`);
    if (prune) recordFailure(error);
    for (const preparation of preparations) preparation.reject(error);
    scheduleMaintenanceTimer();
    return;
  }

  let child: ReturnType<typeof fork>;
  try {
    child = fork(
      entry,
      [
        JSON.stringify({
          hostArtifactRoot,
          preparations: preparations.map(({ stagingDir, cacheDir }) => ({ stagingDir, cacheDir })),
          prune,
        }),
      ],
      {
        execPath: process.execPath,
        execArgv: [],
        detached: false,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      }
    );
  } catch (error) {
    if (prune) recordFailure(error);
    for (const preparation of preparations) preparation.reject(error);
    scheduleMaintenanceTimer();
    return;
  }

  const operation = new Promise<void>((resolve) => {
    let childFailure: unknown;
    let hasChildFailure = false;
    let spawnFailure: unknown;
    let hasSpawnFailure = false;
    let results: unknown[] | null = null;
    child.once("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        childFailure = new Error("Dependency maintenance child sent an invalid result message");
        hasChildFailure = true;
        return;
      }
      const candidate = message as { type?: unknown; results?: unknown; failure?: RpcFailure };
      if (candidate.type === "dependency-maintenance-results" && Array.isArray(candidate.results)) {
        results = candidate.results;
        return;
      }
      if (candidate.type === "dependency-maintenance-failure") {
        try {
          childFailure = deserializeRpcFailure(candidate.failure);
        } catch (error) {
          childFailure = error;
        }
        hasChildFailure = true;
        return;
      }
      childFailure = new Error("Dependency maintenance child sent an invalid result message");
      hasChildFailure = true;
    });
    child.once("error", (error) => {
      spawnFailure = error;
      hasSpawnFailure = true;
    });
    child.once("close", (code, signal) => {
      const exitErrors: unknown[] = [];
      if (hasChildFailure) exitErrors.push(childFailure);
      if (hasSpawnFailure) exitErrors.push(spawnFailure);
      if (signal !== null)
        exitErrors.push(new Error(`Dependency maintenance terminated by signal ${signal}`));
      if (code !== 0 && !hasChildFailure && !hasSpawnFailure && signal === null)
        exitErrors.push(new Error(`Dependency maintenance exited with code ${code}`));
      const processFailure =
        exitErrors.length > 1
          ? new AggregateError(exitErrors, "Dependency maintenance child failed", {
              cause: exitErrors[0],
            })
          : exitErrors[0];
      const reportedJobFailure = Boolean(
        results?.some(
          (result) =>
            !result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true
        )
      );
      const validResults =
        results &&
        results.length === preparations.length + Number(prune) &&
        !hasChildFailure &&
        !hasSpawnFailure &&
        signal === null &&
        (code === 0 || (code === 1 && reportedJobFailure));
      if (preparations.length > 0) {
        if (!validResults) {
          const error =
            processFailure ?? new Error("Dependency maintenance child omitted preparation results");
          for (const [index, preparation] of preparations.entries()) {
            const result = results?.[index] as { ok?: unknown; failure?: RpcFailure } | null;
            if (!result?.failure) {
              preparation.reject(error);
              continue;
            }
            try {
              const preparationFailure = deserializeRpcFailure(result.failure);
              preparation.reject(
                processFailure
                  ? new AggregateError(
                      [preparationFailure, processFailure],
                      "Dependency preparation and child termination failed",
                      { cause: preparationFailure }
                    )
                  : preparationFailure
              );
            } catch (failureDecodeError) {
              preparation.reject(
                new AggregateError(
                  [failureDecodeError, error],
                  "Dependency preparation result and child termination failed",
                  { cause: failureDecodeError }
                )
              );
            }
          }
        } else {
          preparations.forEach((preparation, index) => {
            const result = results![index] as { ok?: unknown; failure?: RpcFailure } | null;
            if (result && result.ok === true) preparation.resolve();
            else {
              try {
                preparation.reject(
                  result?.failure
                    ? deserializeRpcFailure(result.failure)
                    : (processFailure ?? new Error("Dependency preparation failed without a cause"))
                );
              } catch (error) {
                preparation.reject(error);
              }
            }
          });
        }
      }
      const pruneFailures: unknown[] = [];
      const completedResults = results;
      if (validResults && prune && completedResults) {
        for (let index = preparations.length; index < completedResults.length; index += 1) {
          const result = completedResults[index] as { ok?: unknown; failure?: RpcFailure } | null;
          if (result?.ok === true) continue;
          try {
            pruneFailures.push(
              result?.failure
                ? deserializeRpcFailure(result.failure)
                : new Error("Dependency maintenance failed without a cause")
            );
          } catch (error) {
            pruneFailures.push(error);
          }
        }
      }
      for (const error of pruneFailures) recordFailure(error);
      if (processFailure && !validResults) {
        if (prune || preparations.length === 0) recordFailure(processFailure);
        if (!results) for (const preparation of preparations) preparation.reject(processFailure);
      }
      if (prune && !validResults && !processFailure)
        recordFailure(new Error("Dependency maintenance child omitted prune results"));
      resolve();
    });
  }).finally(() => {
    if (activeOperation === operation) activeOperation = null;
    if (pendingPreparations.length > 0) queueMicrotask(startPendingMaintenance);
    else scheduleMaintenanceTimer();
  });
  activeOperation = operation;
}
