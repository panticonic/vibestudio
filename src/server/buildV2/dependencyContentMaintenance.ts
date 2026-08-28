import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";

export const DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS = 3 * 60_000;

const pendingCacheDirs = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | null = null;

export function dependencyContentMaintenanceEntry(appRoot: string): string {
  return getPhysicalAppPath(appRoot, "dist/dependency-content-maintenance.cjs");
}

/**
 * Batch physical dependency sharing behind a grace period, then detach it from
 * the workspace server. Cache density must never compete with first-use work.
 */
export function scheduleDependencyContentMaintenance(cacheDir: string, appRoot: string): void {
  pendingCacheDirs.add(path.resolve(cacheDir));
  if (maintenanceTimer) return;
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    const cacheDirs = [...pendingCacheDirs];
    pendingCacheDirs.clear();
    if (cacheDirs.length === 0) return;

    const entry = dependencyContentMaintenanceEntry(appRoot);
    if (!fs.existsSync(entry)) {
      console.warn(`[externalDeps] Dependency maintenance entry is missing: ${entry}`);
      return;
    }
    const child = spawn(process.execPath, [entry, ...cacheDirs], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    child.once("error", (error) => {
      console.warn(
        `[externalDeps] Failed to start dependency maintenance: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    child.unref();
  }, DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);
  maintenanceTimer.unref();
}
