import * as path from "path";
import * as os from "os";
import type { BrowserName, BrowserFamily } from "../types.js";

/**
 * Candidate data roots for one browser on one platform.
 *
 * A browser can be installed more than once on the same machine — natively and
 * as a Flatpak or Snap — and the sandboxed packagings redirect the whole config
 * tree, so their profiles live somewhere the native path never reaches. Each
 * root that exists is detected as its own source; a stale native install must
 * not shadow the Flatpak the user is actually running.
 */
export interface BrowserRoot {
  path: string;
  /**
   * How this install is packaged, shown only when more than one install of the
   * same browser is present. Two Flatpaks of Chromium exist in the wild
   * (`org.chromium.Chromium` and ungoogled), so "Flatpak" alone is ambiguous.
   */
  label?: string;
}

export type BrowserRoots = string | Array<string | BrowserRoot>;

export interface BrowserPathEntry {
  name: BrowserName;
  family: BrowserFamily;
  displayName: string;
  linux?: BrowserRoots;
  darwin?: BrowserRoots;
  win32?: BrowserRoots;
}

const home = os.homedir();

function linuxConfig(subdir: string): string {
  return path.join(process.env["XDG_CONFIG_HOME"] || path.join(home, ".config"), subdir);
}

/** Flatpak redirects XDG_CONFIG_HOME to `~/.var/app/<appId>/config`. */
function flatpakConfig(appId: string, subdir: string): string {
  return path.join(home, ".var", "app", appId, "config", subdir);
}

/** Flatpak apps that write outside XDG dirs get a redirected home instead. */
function flatpakHome(appId: string, ...relative: string[]): string {
  return path.join(home, ".var", "app", appId, ...relative);
}

/** Snap confines writes to `~/snap/<snap>/common`. */
function snapCommon(snap: string, ...relative: string[]): string {
  return path.join(home, "snap", snap, "common", ...relative);
}

function darwinAppSupport(subdir: string): string {
  return path.join(home, "Library", "Application Support", subdir);
}

function winLocal(subdir: string): string {
  return path.join(process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local"), subdir);
}

function winRoaming(subdir: string): string {
  return path.join(process.env["APPDATA"] || path.join(home, "AppData", "Roaming"), subdir);
}

export const BROWSER_PATHS: BrowserPathEntry[] = [
  // Firefox family
  {
    name: "firefox",
    family: "firefox",
    displayName: "Firefox",
    linux: [
      path.join(home, ".mozilla", "firefox"),
      flatpakHome("org.mozilla.firefox", ".mozilla", "firefox"),
      snapCommon("firefox", ".mozilla", "firefox"),
    ],
    darwin: darwinAppSupport("Firefox/Profiles"),
    win32: winRoaming("Mozilla/Firefox/Profiles"),
  },
  {
    name: "zen",
    family: "firefox",
    displayName: "Zen Browser",
    linux: [path.join(home, ".zen"), flatpakHome("app.zen_browser.zen", ".zen")],
    darwin: darwinAppSupport("Zen/Profiles"),
    win32: winRoaming("Zen/Profiles"),
  },

  // Chromium family
  {
    name: "chrome",
    family: "chromium",
    displayName: "Google Chrome",
    linux: [linuxConfig("google-chrome"), flatpakConfig("com.google.Chrome", "google-chrome")],
    darwin: darwinAppSupport("Google/Chrome"),
    win32: winLocal("Google/Chrome/User Data"),
  },
  {
    name: "chrome-beta",
    family: "chromium",
    displayName: "Google Chrome Beta",
    linux: linuxConfig("google-chrome-beta"),
    darwin: darwinAppSupport("Google/Chrome Beta"),
    win32: winLocal("Google/Chrome Beta/User Data"),
  },
  {
    name: "chrome-dev",
    family: "chromium",
    displayName: "Google Chrome Dev",
    linux: linuxConfig("google-chrome-unstable"),
    darwin: darwinAppSupport("Google/Chrome Dev"),
    win32: winLocal("Google/Chrome Dev/User Data"),
  },
  {
    name: "chrome-canary",
    family: "chromium",
    displayName: "Google Chrome Canary",
    darwin: darwinAppSupport("Google/Chrome Canary"),
    win32: winLocal("Google/Chrome SxS/User Data"),
  },
  {
    name: "chromium",
    family: "chromium",
    displayName: "Chromium",
    linux: [
      linuxConfig("chromium"),
      { path: flatpakConfig("org.chromium.Chromium", "chromium"), label: "Flatpak" },
      {
        path: flatpakConfig("io.github.ungoogled_software.ungoogled_chromium", "chromium"),
        label: "ungoogled, Flatpak",
      },
      { path: snapCommon("chromium", "chromium"), label: "Snap" },
    ],
    darwin: darwinAppSupport("Chromium"),
    win32: winLocal("Chromium/User Data"),
  },
  {
    name: "edge",
    family: "chromium",
    displayName: "Microsoft Edge",
    linux: [linuxConfig("microsoft-edge"), flatpakConfig("com.microsoft.Edge", "microsoft-edge")],
    darwin: darwinAppSupport("Microsoft Edge"),
    win32: winLocal("Microsoft/Edge/User Data"),
  },
  {
    name: "edge-beta",
    family: "chromium",
    displayName: "Microsoft Edge Beta",
    linux: linuxConfig("microsoft-edge-beta"),
    darwin: darwinAppSupport("Microsoft Edge Beta"),
    win32: winLocal("Microsoft/Edge Beta/User Data"),
  },
  {
    name: "edge-dev",
    family: "chromium",
    displayName: "Microsoft Edge Dev",
    linux: linuxConfig("microsoft-edge-dev"),
    darwin: darwinAppSupport("Microsoft Edge Dev"),
    win32: winLocal("Microsoft/Edge Dev/User Data"),
  },
  {
    name: "brave",
    family: "chromium",
    displayName: "Brave",
    linux: [
      linuxConfig("BraveSoftware/Brave-Browser"),
      flatpakConfig("com.brave.Browser", "BraveSoftware/Brave-Browser"),
    ],
    darwin: darwinAppSupport("BraveSoftware/Brave-Browser"),
    win32: winLocal("BraveSoftware/Brave-Browser/User Data"),
  },
  {
    name: "vivaldi",
    family: "chromium",
    displayName: "Vivaldi",
    linux: linuxConfig("vivaldi"),
    darwin: darwinAppSupport("Vivaldi"),
    win32: winLocal("Vivaldi/User Data"),
  },
  {
    name: "opera",
    family: "chromium",
    displayName: "Opera",
    linux: linuxConfig("opera"),
    darwin: darwinAppSupport("com.operasoftware.Opera"),
    win32: winRoaming("Opera Software/Opera Stable"),
  },
  {
    name: "opera-gx",
    family: "chromium",
    displayName: "Opera GX",
    linux: linuxConfig("opera-gx"),
    darwin: darwinAppSupport("com.operasoftware.OperaGX"),
    win32: winRoaming("Opera Software/Opera GX Stable"),
  },
  {
    name: "arc",
    family: "chromium",
    displayName: "Arc",
    darwin: darwinAppSupport("Arc/User Data"),
  },

  // Safari
  {
    name: "safari",
    family: "safari",
    displayName: "Safari",
    darwin: path.join(home, "Library", "Safari"),
  },
];

/**
 * Every candidate data root for a browser on the current platform, in priority
 * order. Callers check existence: a listed root is a place to look, not a claim
 * that the browser is installed.
 */
export function getBrowserDataDirs(entry: BrowserPathEntry): BrowserRoot[] {
  const roots = entry[process.platform as "linux" | "darwin" | "win32"];
  if (!roots) return [];
  const list = typeof roots === "string" ? [roots] : roots;
  return list.map((root) => (typeof root === "string" ? { path: root } : root));
}

/**
 * How a data root was installed. An explicit label from the path table wins;
 * otherwise it is inferred from the sandbox directory layout.
 */
export function packagingLabel(root: BrowserRoot): string | undefined {
  if (root.label) return root.label;
  if (root.path.includes(`${path.sep}.var${path.sep}app${path.sep}`)) return "Flatpak";
  if (root.path.includes(`${path.sep}snap${path.sep}`)) return "Snap";
  return undefined;
}
