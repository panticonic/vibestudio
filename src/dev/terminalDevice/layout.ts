import * as path from "node:path";

/**
 * The terminal device's private filesystem and environment.
 *
 * The device owns a HOME, XDG directories and a bin directory on PATH holding
 * the real `vibestudio` command; nothing of the developer's profile is read or
 * written. This module has no CLI imports on purpose: the credential and path
 * modules bind their stores when they are evaluated, so the environment below
 * has to be installed before any of them loads.
 */
export interface TerminalDeviceLayout {
  root: string;
  home: string;
  /** `<home>/.local/bin`: the `vibestudio` command and the shims `clients link` writes. */
  bin: string;
  /** The environment every device child (and this process) runs with. */
  env: Record<string, string>;
}

/** Variables that would route the device to another instance or profile. */
const INHERITED_ROUTING = [
  "VIBESTUDIO_INSTANCE",
  "VIBESTUDIO_INSTANCE_ROOT",
  "VIBESTUDIO_PROFILE_ROOT",
  "VIBESTUDIO_WORKSPACE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

/**
 * A device profile under `root`. The device under test (`"home"`) and the
 * driver's own connection (`"driver"`) are separate profiles of the same
 * account: a CLI profile admits one process per Iroh endpoint at a time, so
 * the driver cannot share the profile its PTYs run the CLI under.
 */
export function terminalDeviceLayout(
  root: string,
  repoRoot: string,
  base: NodeJS.ProcessEnv = process.env,
  profile: "home" | "driver" = "home"
): TerminalDeviceLayout {
  const home = path.join(root, profile);
  const bin = path.join(home, ".local", "bin");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !INHERITED_ROUTING.includes(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    VIBESTUDIO_APP_ROOT: repoRoot,
    PATH: `${bin}${path.delimiter}${base["PATH"] ?? ""}`,
  });
  return { root, home, bin, env };
}

/** The `vibestudio` command: the checkout's CLI source, run from the checkout. */
export function vibestudioWrapper(repoRoot: string): string {
  const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(repoRoot, "src", "dev", "runCli.ts");
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\ncd ${quote(repoRoot)} || exit 1\nexec ${quote(process.execPath)} ${quote(tsx)} ${quote(entry)} "$@"\n`;
}
