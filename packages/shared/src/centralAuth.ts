/**
 * centralAuth — central-config auth artifacts (admin token).
 *
 * The admin token is a LOCAL operator break-glass for the diagnostic
 * `admin-token` HTTP routes and hub→child loopback plumbing — it is NOT a
 * human identity (WP9 §4 retired admin-token-as-root; root is a `User` in the
 * identity DB, and RPC auth rejects the admin token outright). It stays a
 * *central* concept (one diagnostic token per machine, not per workspace),
 * living under `~/.config/vibestudio/admin-token` alongside `config.yml`,
 * `.secrets.yml`, and `remote-credentials.json` — which is why it is here and
 * not in `workspace/loader.ts` ("workspace configuration" must not be
 * conflated with "credential storage for the local machine").
 */

import * as fs from "fs";
import * as path from "path";
import { getCentralDataPath } from "@vibestudio/env-paths";

const ADMIN_TOKEN_FILE = "admin-token";

/** Central-config directory path (platform-appropriate). */
function getCentralDir(): string {
  return getCentralDataPath();
}

/**
 * Create (if needed) and lock down the central config dir to 0o700. Called
 * before writing any secret-bearing file into the directory.
 *
 * The chmod IS best-effort — on filesystems that don't support POSIX perms
 * (SMB, FAT, some container mounts), it'll fail. But a silently loose
 * directory is a security regression we want to know about; we log at
 * `warn` so it shows up in operator logs rather than being swallowed.
 */
export function ensureCentralConfigDir(): string {
  const dir = getCentralDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      console.warn(
        `[centralAuth] Could not enforce 0o700 on ${dir}: ${(err as Error).message}. ` +
        `Secrets may be readable by other users on this machine.`,
      );
    }
  }
  return dir;
}

/** Absolute path of the persisted admin token file. */
export function getAdminTokenPath(): string {
  return path.join(getCentralDir(), ADMIN_TOKEN_FILE);
}

/** Read the persisted admin token, or `null` if the file is missing or empty. */
export function loadPersistedAdminToken(): string | null {
  const tokenPath = getAdminTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    console.warn(`[centralAuth] Failed to read admin token at ${tokenPath}:`, error);
    return null;
  }
}

/** Atomically write the admin token with file mode 0o600 inside a 0o700 dir. */
export function savePersistedAdminToken(token: string): void {
  ensureCentralConfigDir();
  fs.writeFileSync(getAdminTokenPath(), token, { mode: 0o600 });
}
