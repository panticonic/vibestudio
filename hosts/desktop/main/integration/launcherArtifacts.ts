import * as path from "node:path";
import { clientIntentLink, type LaunchEntry } from "@vibestudio/client-host-core";

/**
 * The OS artifacts that launch a client (docs/client-hosts-and-clients-plan.md §4.7.5):
 * a `.desktop` file on Linux, a Start-menu `.lnk` with its own AppUserModelID on
 * Windows, a launcher `.app` in `~/Applications` on macOS. Each opens
 * `vibestudio://c/<id>/open` (or an intent of the client) through this app.
 * Nothing here knows a client by name; the filesystem and the Windows shortcut
 * call are injected so every platform is exercised without its OS.
 */

export type LauncherPlatform = "linux" | "win32" | "darwin";

export interface LauncherFs {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string, mode?: number): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
}

export interface LauncherEnvironment {
  platform: LauncherPlatform;
  /** The command that starts this app: the packaged executable, or the electron binary and app path. */
  command: readonly string[];
  homeDir: string;
  /** Windows: the per-user roaming app-data directory. */
  appDataDir: string;
  iconPath: string;
  /** macOS: an `.icns` for the launcher bundle, when the app ships one. */
  icnsPath?: string;
  fs: LauncherFs;
  /** Windows: `shell.writeShortcutLink`. */
  writeShortcutLink?(
    file: string,
    operation: "create",
    options: {
      target: string;
      args: string;
      description: string;
      icon: string;
      iconIndex: number;
      appUserModelId: string;
    }
  ): boolean;
}

/** What a launcher presents: the client and the entries its menu offers. */
export interface LauncherSpec {
  clientId: string;
  title: string;
  entries: readonly LaunchEntry[];
}

/** A launcher this host wrote, as recorded in host state so it can be removed. */
export interface InstalledLauncher {
  clientId: string;
  platform: LauncherPlatform;
  /** What the launcher presented when it was written; a change rewrites it. */
  fingerprint: string;
  paths: string[];
}

/** The Windows AppUserModelID of a client: its launcher's shortcut and its windows share it. */
export function launcherAppUserModelId(clientId: string): string {
  return `app.vibestudio.Vibestudio.${clientId}`;
}

/** Windows command-line quoting of arguments joined into one string. */
export function commandLine(args: readonly string[]): string {
  return args.map((arg) => (/[\s"]/u.test(arg) ? `"${arg.replace(/"/gu, '\\"')}"` : arg)).join(" ");
}

/**
 * The Windows identity of a client's window: its own taskbar group and pinning
 * target, matching the AppUserModelID of the Start-menu shortcut.
 */
export function windowAppDetails(
  client: { clientId: string; title: string },
  command: readonly string[],
  iconPath: string
) {
  return {
    appId: launcherAppUserModelId(client.clientId),
    appIconPath: iconPath,
    relaunchCommand: commandLine([...command, clientIntentLink(client.clientId, "open")]),
    relaunchDisplayName: client.title,
  };
}

export function launcherFingerprint(spec: LauncherSpec): string {
  return JSON.stringify([spec.title, spec.entries.map((entry) => [entry.label, entry.link])]);
}

function safeName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\u0000-\u001f/\\:*?"<>|]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : "Vibestudio client";
}

/** One argument of a desktop entry `Exec` line (Desktop Entry spec, "The Exec key"). */
function desktopExecArg(arg: string): string {
  const escaped = arg.replace(/[\\"`$]/gu, "\\$&").replace(/%/gu, "%%");
  return /[\s"'\\><~|&;$*?#()`%]/u.test(arg) ? `"${escaped}"` : escaped;
}

function desktopExec(command: readonly string[], link: string): string {
  return [...command, link].map(desktopExecArg).join(" ");
}

/** A desktop entry value: newlines would start another key. */
function desktopValue(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

export function renderDesktopEntry(spec: LauncherSpec, env: LauncherEnvironment): string {
  const open = clientIntentLink(spec.clientId, "open");
  const actions = spec.entries.filter((entry) => entry.link !== open);
  const ids = actions.map((_, index) => `a${index}`);
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${desktopValue(spec.title)}`,
    `Exec=${desktopExec(env.command, open)}`,
    `Icon=${env.iconPath}`,
    "Terminal=false",
    "Categories=Network;",
    ...(ids.length > 0 ? [`Actions=${ids.join(";")};`] : []),
  ];
  actions.forEach((entry, index) => {
    lines.push(
      "",
      `[Desktop Action ${ids[index]}]`,
      `Name=${desktopValue(entry.label)}`,
      `Exec=${desktopExec(env.command, entry.link)}`
    );
  });
  return `${lines.join("\n")}\n`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function renderInfoPlist(spec: LauncherSpec, withIcon: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${xmlEscape(launcherAppUserModelId(spec.clientId))}</string>
  <key>CFBundleName</key><string>${xmlEscape(spec.title)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEscape(spec.title)}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  ${withIcon ? "<key>CFBundleIconFile</key><string>icon</string>" : ""}
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

/** Write the OS artifact that launches a client; resolves with what to record. */
export async function installLauncher(
  spec: LauncherSpec,
  env: LauncherEnvironment
): Promise<InstalledLauncher> {
  const fingerprint = launcherFingerprint(spec);
  const record = (paths: string[]): InstalledLauncher => ({
    clientId: spec.clientId,
    platform: env.platform,
    fingerprint,
    paths,
  });
  const open = clientIntentLink(spec.clientId, "open");
  switch (env.platform) {
    case "linux": {
      const dir = path.join(env.homeDir, ".local", "share", "applications");
      const file = path.join(dir, `${launcherAppUserModelId(spec.clientId)}.desktop`);
      await env.fs.mkdir(dir);
      await env.fs.writeFile(file, renderDesktopEntry(spec, env), 0o755);
      return record([file]);
    }
    case "win32": {
      const dir = path.join(
        env.appDataDir,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Vibestudio"
      );
      const file = path.join(dir, `${safeName(spec.title)}.lnk`);
      const [target, ...prefix] = env.command;
      if (!target) throw new Error("The app has no command to launch");
      if (!env.writeShortcutLink) throw new Error("This host cannot write a Start-menu shortcut");
      await env.fs.mkdir(dir);
      const written = env.writeShortcutLink(file, "create", {
        target,
        args: commandLine([...prefix, open]),
        description: spec.title,
        icon: env.iconPath,
        iconIndex: 0,
        appUserModelId: launcherAppUserModelId(spec.clientId),
      });
      if (!written) throw new Error(`Windows refused to write the shortcut ${file}`);
      return record([file]);
    }
    case "darwin": {
      const bundle = path.join(env.homeDir, "Applications", `${safeName(spec.title)}.app`);
      const macos = path.join(bundle, "Contents", "MacOS");
      const resources = path.join(bundle, "Contents", "Resources");
      // A bundle is replaced whole, so a rename or a changed icon leaves nothing behind.
      await env.fs.rm(bundle);
      await env.fs.mkdir(macos);
      await env.fs.mkdir(resources);
      await env.fs.writeFile(
        path.join(bundle, "Contents", "Info.plist"),
        renderInfoPlist(spec, env.icnsPath !== undefined)
      );
      await env.fs.writeFile(
        path.join(macos, "launcher"),
        `#!/bin/sh\nexec /usr/bin/open ${shellQuote(open)}\n`,
        0o755
      );
      if (env.icnsPath) await env.fs.copyFile(env.icnsPath, path.join(resources, "icon.icns"));
      return record([bundle]);
    }
  }
}

/** Remove everything a recorded launcher wrote. */
export async function removeLauncher(launcher: InstalledLauncher, fs: LauncherFs): Promise<void> {
  for (const target of launcher.paths) await fs.rm(target);
}
