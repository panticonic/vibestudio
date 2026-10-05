import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";
import { resolveRequiredHostArtifactRoot } from "../appRoot.js";

export const DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS = 3 * 60_000;

const pendingCacheDirs = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | null = null;
const operations = new Set<Promise<void>>();
let failure: Error | undefined;

/** Admission is already quiescent at server shutdown. Cancel queued work and join owned children. */
export async function drainDependencyContentMaintenance(): Promise<void> {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = null;
  pendingCacheDirs.clear();
  await Promise.all(operations);
  if (failure) {
    const error = failure;
    failure = undefined;
    throw error;
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
      console.warn(`[externalDeps] Dependency maintenance entry is missing: ${entry}`);
      return;
    }
    const child = spawn(process.execPath, [entry, ...cacheDirs], {
      detached: false,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    const operation = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`Dependency maintenance exited with code ${code}, signal ${signal}`))
      );
    })
      .catch((error) => {
        failure ??= error instanceof Error ? error : new Error(String(error));
        console.warn(`[externalDeps] Dependency maintenance failed: ${String(error)}`);
      })
      .finally(() => operations.delete(operation));
    operations.add(operation);
    child.unref();
  }, DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);
  maintenanceTimer.unref();
}
