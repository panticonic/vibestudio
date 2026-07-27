import * as fs from "fs";
import * as path from "path";
import type { BrowserFamily } from "../types.js";

/**
 * Whether a browser profile is currently running.
 *
 * Open tabs are a live concept, but every profile a browser has ever used keeps
 * a session store on disk — including profiles abandoned years ago. Reading all
 * of them merges long-closed windows into "open tabs". The profile lock is the
 * browser's own liveness signal, so we use that rather than guessing from file
 * timestamps:
 *
 * - Firefox writes a `lock` symlink (POSIX) / `parent.lock` (Windows) into the
 *   profile directory at startup and removes it on exit. `.parentlock` is left
 *   behind after a clean exit, so it is deliberately not used here.
 * - Chromium writes `SingletonLock` into the user-data directory, which covers
 *   every profile inside it — so it answers "is this browser running", not "is
 *   this specific profile open". That is still strictly better than treating an
 *   abandoned profile as live.
 *
 * A crashed browser can leave a stale lock behind; that fails toward showing
 * tabs rather than hiding them, which is the safer direction for a migration UI.
 */
export function isProfileRunning(family: BrowserFamily, profilePath: string): boolean {
  const candidates =
    family === "firefox"
      ? [path.join(profilePath, "lock"), path.join(profilePath, "parent.lock")]
      : family === "chromium"
        ? [
            path.join(profilePath, "SingletonLock"),
            path.join(path.dirname(profilePath), "SingletonLock"),
          ]
        : [];
  return candidates.some(exists);
}

/** `existsSync` follows symlinks, and Firefox's `lock` target is a socket address. */
function exists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether starting this profile would reopen its saved windows, rather than
 * landing on a home page with the session merely recoverable from a menu.
 *
 * Firefox stores the choice as `browser.startup.page` in `prefs.js`: 3 is
 * "open previous windows and tabs". Chromium stores `session.restore_on_startup`
 * in its `Preferences` JSON, where 1 is "continue where you left off".
 * When the preference cannot be read we answer false, so the UI says "saved"
 * rather than promising a restore that may not happen.
 */
export function restoresSessionOnLaunch(family: BrowserFamily, profilePath: string): boolean {
  if (family === "firefox") {
    const prefs = read(path.join(profilePath, "prefs.js"));
    if (!prefs) return false;
    return /user_pref\(\s*"browser\.startup\.page"\s*,\s*3\s*\)/.test(prefs);
  }
  if (family === "chromium") {
    const raw = read(path.join(profilePath, "Preferences"));
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as { session?: { restore_on_startup?: unknown } };
      return parsed.session?.restore_on_startup === 1;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * How a profile's stored windows relate to what the user would actually see.
 *
 * - `open`: the browser has this profile running right now.
 * - `restores`: not running, but launching the browser reopens these windows —
 *   it is the profile that starts by default and session restore is enabled.
 * - `saved`: a stored session that will not come back on its own, because
 *   another profile launches by default or restore is switched off.
 */
export type ProfileSessionState = "open" | "restores" | "saved";

export function profileSessionState(
  family: BrowserFamily,
  profile: { path: string; isDefault: boolean }
): ProfileSessionState {
  if (isProfileRunning(family, profile.path)) return "open";
  if (profile.isDefault && restoresSessionOnLaunch(family, profile.path)) return "restores";
  return "saved";
}

function read(candidate: string): string | null {
  try {
    return fs.readFileSync(candidate, "utf-8");
  } catch {
    return null;
  }
}
