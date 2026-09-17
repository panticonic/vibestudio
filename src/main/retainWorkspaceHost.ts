import { app } from "electron";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { getAppRoot, getPhysicalAppPath, getServerProcessEntryPath } from "./paths.js";

/** Copy and verify the complete installed launch set before the package manager
 * or in-app updater may replace it. A failed preflight aborts installation. */
export async function retainInstalledWorkspaceHost(): Promise<void> {
  const executable = fs.realpathSync(app.getPath("exe"));
  const artifactRoot =
    process.platform === "darwin"
      ? path.resolve(path.dirname(executable), "../..")
      : path.dirname(executable);
  await promisify(execFile)(
    executable,
    [
      getPhysicalAppPath("scripts/historical-host-snapshot.mjs"),
      "--artifact-root",
      artifactRoot,
      "--app-root",
      getAppRoot(),
      "--server-entry",
      getServerProcessEntryPath(),
      "--central-data",
      getCentralDataPath(),
      "--executable",
      executable,
      "--app-version",
      app.getVersion(),
      "--runtime-mode",
      "electron-node",
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }
  );
}
