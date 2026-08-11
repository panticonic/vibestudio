import * as fs from "fs";
import type { DetectedBrowser } from "../types.js";
import { BROWSER_PATHS, getBrowserDataDirs, packagingLabel } from "./paths.js";
import { detectFirefoxProfiles } from "./firefox.js";
import { detectChromiumProfiles, detectChromiumVersion } from "./chromium.js";
import { detectSafari } from "./safari.js";

/**
 * Detect all installed browsers on the current system.
 *
 * Scans platform-specific paths for every known browser, enumerates profiles,
 * and returns a list of DetectedBrowser objects. Detection errors are non-fatal:
 * a browser that can't be read is excluded from results.
 */
export function detectBrowsers(): DetectedBrowser[] {
  const browsers: DetectedBrowser[] = [];

  for (const entry of BROWSER_PATHS) {
    try {
      // Safari is special
      if (entry.name === "safari") {
        const result = detectSafari();
        if (result.profiles.length > 0) {
          browsers.push({
            name: "safari",
            family: "safari",
            displayName: "Safari",
            dataDir: result.profiles[0]!.path,
            profiles: result.profiles,
            tccBlocked: result.tccBlocked || undefined,
          });
        }
        continue;
      }

      // One browser can be installed several ways at once (native + Flatpak +
      // Snap). Each root with profiles is its own source, so a stale native
      // install cannot hide the packaging the user actually runs.
      const found: Array<DetectedBrowser & { root: { path: string; label?: string } }> = [];
      for (const root of getBrowserDataDirs(entry)) {
        const dataDir = root.path;
        if (!fs.existsSync(dataDir)) continue;

        const profiles =
          entry.family === "firefox"
            ? detectFirefoxProfiles(dataDir)
            : detectChromiumProfiles(dataDir);
        if (profiles.length === 0) continue;
        const version = entry.family === "chromium" ? detectChromiumVersion(dataDir) : undefined;

        found.push({
          name: entry.name,
          family: entry.family,
          displayName: entry.displayName,
          version,
          dataDir,
          profiles,
          root,
        });
      }

      // Only disambiguate when it is actually ambiguous: a lone Flatpak install
      // is just "Google Chrome" to the person using it.
      if (found.length > 1) {
        for (const browser of found) {
          const label = packagingLabel(browser.root);
          if (label) browser.displayName = `${browser.displayName} (${label})`;
        }
      }
      browsers.push(...found.map(({ root: _root, ...browser }) => browser));
    } catch {
      // Non-fatal: skip this browser
    }
  }

  return browsers;
}
