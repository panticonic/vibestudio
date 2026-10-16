/**
 * The packaged `.desktop` entry this app's windows belong to on Linux.
 *
 * Electron derives the app id from the desktop name. GNOME 50 and
 * `xdg-desktop-portal` 1.21 and later refuse portal sessions (global shortcuts,
 * badges) for an app id that does not resolve to an installed `.desktop` file,
 * and Electron's fallback (a slug of the app name) resolves to none. The
 * packager names the entry after `linux.executableName`
 * (`electron-builder.yml`), so that is the name set here, before `ready`.
 */
export const LINUX_DESKTOP_NAME = "vibestudio.desktop";
