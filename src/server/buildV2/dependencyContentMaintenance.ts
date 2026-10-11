import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deserializeRpcFailure, formatRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";
import { resolveRequiredHostArtifactRoot } from "../appRoot.js";

export const DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS = 3 * 60_000;

const pendingCacheDirs = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | null = null;
const operations = new Set<Promise<void>>();
const failures: unknown[] = [];

function recordFailure(error: unknown): void {
  failures.push(error);
  console.warn(`[externalDeps] Dependency maintenance failed: ${formatRpcFailure(error)}`);
}

/** Admission is already quiescent at server shutdown. Cancel queued work and join owned children. */
export async function drainDependencyContentMaintenance(): Promise<void> {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = null;
  pendingCacheDirs.clear();
  await Promise.all(operations);
  if (failures.length > 0) {
    const errors = failures.splice(0);
    throw new AggregateError(errors, "Dependency maintenance operations failed");
  }
}

export function dependencyContentMaintenanceEntry(): string {
  return getPhysicalAppPath(
    resolveRequiredHostArtifactRoot(),
    "dependency-content-maintenance.cjs"
  );
}

/**
 * Defer physical dependency sharing during startup. The server retains ownership
 * of each admitted child and joins it before releasing shared cache coordinators.
 */
export function scheduleDependencyContentMaintenance(cacheDir: string): void {
  pendingCacheDirs.add(path.resolve(cacheDir));
  if (maintenanceTimer) return;
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    const cacheDirs = [...pendingCacheDirs];
    pendingCacheDirs.clear();
    if (cacheDirs.length === 0) return;

    const entry = dependencyContentMaintenanceEntry();
    if (!fs.existsSync(entry)) {
      recordFailure(new Error(`Dependency maintenance entry is missing: ${entry}`));
      return;
    }
    const child = fork(entry, cacheDirs, {
      execPath: process.execPath,
      execArgv: [],
      detached: false,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    const operation = new Promise<void>((resolve, reject) => {
      let childFailure: unknown;
      let hasChildFailure = false;
      let spawnFailure: unknown;
      let hasSpawnFailure = false;
      child.once("message", (message: unknown) => {
        if (
          !message ||
          typeof message !== "object" ||
          (message as { type?: unknown }).type !== "dependency-maintenance-failure"
        ) {
          childFailure = new Error("Dependency maintenance child sent an invalid failure message");
          hasChildFailure = true;
          return;
        }
        try {
          childFailure = deserializeRpcFailure((message as { failure?: RpcFailure }).failure);
        } catch (error) {
          childFailure = error;
        }
        hasChildFailure = true;
      });
      child.once("error", (error) => {
        spawnFailure = error;
        hasSpawnFailure = true;
      });
      child.once("close", (code, signal) => {
        const errors: unknown[] = [];
        if (hasChildFailure) errors.push(childFailure);
        if (hasSpawnFailure) errors.push(spawnFailure);
        if (signal !== null)
          errors.push(new Error(`Dependency maintenance terminated by signal ${signal}`));
        if (code !== 0 && !hasChildFailure && !hasSpawnFailure && signal === null)
          errors.push(new Error(`Dependency maintenance exited with code ${code}`));
        if (errors.length > 1)
          reject(new AggregateError(errors, "Dependency maintenance child failed"));
        else if (errors.length === 1) reject(errors[0]);
        else resolve();
      });
    })
      .catch((error) => {
        recordFailure(error);
      })
      .finally(() => operations.delete(operation));
    operations.add(operation);
    child.unref();
  }, DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);
  maintenanceTimer.unref();
}
