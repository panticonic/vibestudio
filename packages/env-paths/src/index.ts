import * as path from "path";
import * as os from "os";

let _userDataPath: string | null = null;
const INSTANCE_ROOT_ENV = "VIBESTUDIO_INSTANCE_ROOT";

/** Explicitly set the user-data directory (for headless/test use). */
export function setUserDataPath(p: string): void {
  _userDataPath = p;
}

/**
 * Get the per-workspace user-data directory.
 * After app.setPath('userData', workspaceDir), this returns the workspace dir.
 * Resolution order:
 *   1. Explicitly set via setUserDataPath()
 *   2. Lazy require("electron").app.getPath("userData")
 *   3. Platform-conventional fallback (XDG / Library / AppData)
 */
export function getUserDataPath(): string {
  if (_userDataPath) return _userDataPath;
  try {
    // Lazy require — only succeeds inside Electron
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    return platformDefault();
  }
}

/**
 * Get the mutable state root for this Vibestudio instance.
 *
 * Developer/test supervisors set VIBESTUDIO_INSTANCE_ROOT so independent hubs
 * never share leases, identities, workspaces, databases, or runtime caches.
 * Ordinary installed launches retain the platform profile root as their one
 * persistent instance.
 */
export function getCentralDataPath(): string {
  const instanceRoot = process.env[INSTANCE_ROOT_ENV]?.trim();
  return instanceRoot ? path.resolve(instanceRoot) : getProfileDataPath();
}

/**
 * Get the user profile root shared by independent Vibestudio instances.
 *
 * Only user-owned configuration and provider credentials belong here.
 * Runtime state must use getCentralDataPath() instead.
 */
export function getProfileDataPath(): string {
  return platformDefault();
}

/** Get the directory containing all managed workspaces. */
export function getWorkspacesDir(): string {
  return path.join(getCentralDataPath(), "workspaces");
}

/** Get the directory for a specific managed workspace by name. */
export function getWorkspaceDir(name: string): string {
  return path.join(getWorkspacesDir(), name);
}

/** Platform-conventional config directory for Vibestudio. */
function platformDefault(): string {
  const home = os.homedir();
  try {
    switch (process.platform) {
      case "win32": {
        const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
        return path.join(appData, "vibestudio");
      }
      case "darwin":
        return path.join(home, "Library", "Application Support", "vibestudio");
      default: {
        const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
        return path.join(xdgConfig, "vibestudio");
      }
    }
  } catch {
    return path.join(os.tmpdir(), "vibestudio");
  }
}
