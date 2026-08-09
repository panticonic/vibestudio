import { accessSync, constants, mkdirSync } from "node:fs";
import * as path from "node:path";

export interface ClaudeReadOnlyLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  scratchDirectory: string;
  claudeConfigDirectory: string;
}

const SAFE_AMBIENT_KEYS = ["PATH", "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ"] as const;
const SAFE_PATH_COORDINATES = ["SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
const SAFE_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const SAFE_LAUNCH_KEYS = [
  "VIBESTUDIO_CONTEXT_ID",
  "VIBESTUDIO_CHANNEL_ID",
  "VIBESTUDIO_ENTITY_ID",
  "VIBESTUDIO_VESSEL_REF",
  "VIBESTUDIO_LAUNCH_PROFILE",
  "VIBESTUDIO_SUBAGENT_RUN_ID",
  "VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID",
  "VIBESTUDIO_SUBAGENT_CONTRACT",
  "CLAUDE_CONFIG_DIR",
] as const;
const SAFE_CONFINEMENT_KEYS = ["TMPDIR", "VIBESTUDIO_LINKED_SCRATCH", "CLAUDE_CONFIG_DIR"] as const;

function credentialFreeProxy(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Construct the complete environment visible to Claude. Ambient variables are
 * denied by default; only runtime coordinates are copied. Provider login lives
 * in the isolated Claude config, never in an inherited API-key variable.
 */
export function claudeContainedSpawnEnvironment(input: {
  profileDir: string;
  launchEnv: Record<string, string>;
  confinementEnv: Record<string, string>;
  ambient?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const ambient = input.ambient ?? process.env;
  const profileDir = path.resolve(input.profileDir);
  const home = path.join(profileDir, "home");
  const xdgConfig = path.join(home, ".config");
  const xdgCache = path.join(home, ".cache");
  const xdgData = path.join(home, ".local", "share");
  const xdgState = path.join(home, ".local", "state");
  for (const directory of [home, xdgConfig, xdgCache, xdgData, xdgState]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
  };
  for (const key of SAFE_LAUNCH_KEYS) {
    const value = input.launchEnv[key];
    if (value) env[key] = value;
  }
  for (const key of SAFE_CONFINEMENT_KEYS) {
    const value = input.confinementEnv[key];
    if (value) env[key] = value;
  }
  for (const key of SAFE_AMBIENT_KEYS) {
    const value = ambient[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(ambient)) {
    if (key.startsWith("LC_") && value) env[key] = value;
  }
  for (const key of SAFE_PATH_COORDINATES) {
    const value = ambient[key];
    if (value && path.isAbsolute(value)) env[key] = value;
  }
  for (const key of SAFE_PROXY_KEYS) {
    const value = ambient[key];
    if (!value) continue;
    if (key.toLowerCase() === "no_proxy") env[key] = value;
    else {
      const safe = credentialFreeProxy(value);
      if (safe) env[key] = safe;
    }
  }
  return env;
}

export interface ClaudeReadOnlyLaunchInput {
  argv: string[];
  profileDir: string;
  contextDirectory: string;
  /** Test seams. Production intentionally supports only Linux/bubblewrap. */
  platform?: NodeJS.Platform;
  pathValue?: string;
}

function executableOnPath(name: string, pathValue: string | undefined): string | null {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next exact PATH entry.
    }
  }
  return null;
}

/**
 * Build the only supported linked-Claude process launch.
 *
 * The host tree is mounted read-only, including the materialized context. A
 * disposable profile directory and /tmp are the only writable mounts. The
 * profile contains isolated writable Claude state prepared by the launch
 * materializer, so token refresh and session hooks never need to write directly
 * into the host's ~/.claude while managed source remains immutable. This is an
 * OS boundary, not a prompt convention: native Edit/Write/Bash calls receive
 * EROFS for managed projection paths. Server-side semantic reads still work,
 * and scratch is explicit through VIBESTUDIO_LINKED_SCRATCH.
 *
 * We deliberately fail on platforms without the one audited backend instead of
 * silently launching an uncontained session or approximating containment with
 * chmod (which the same process could undo).
 */
export function confineClaudeReadOnly(input: ClaudeReadOnlyLaunchInput): ClaudeReadOnlyLaunch {
  const argv = input.argv.filter((value): value is string => typeof value === "string");
  if (argv.length === 0) throw new Error("Claude launch has no executable");
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error(
      `Linked Claude requires an OS-enforced read-only launch; no backend is supported on ${platform}`
    );
  }
  const bwrap = executableOnPath("bwrap", input.pathValue ?? process.env["PATH"]);
  if (!bwrap) {
    throw new Error(
      "Linked Claude requires bubblewrap (bwrap) so managed context projections are read-only"
    );
  }

  const profileDir = path.resolve(input.profileDir);
  const contextDirectory = path.resolve(input.contextDirectory);
  const scratchDirectory = path.join(profileDir, "scratch");
  const claudeConfigDirectory = path.join(profileDir, "claude-config");
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(claudeConfigDirectory, { recursive: true, mode: 0o700 });

  return {
    command: bwrap,
    args: [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      profileDir,
      profileDir,
      "--ro-bind",
      contextDirectory,
      contextDirectory,
      "--chdir",
      contextDirectory,
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "VIBESTUDIO_LINKED_SCRATCH",
      scratchDirectory,
      "--setenv",
      "CLAUDE_CONFIG_DIR",
      claudeConfigDirectory,
      "--",
      ...argv,
    ],
    env: {
      TMPDIR: "/tmp",
      VIBESTUDIO_LINKED_SCRATCH: scratchDirectory,
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
    },
    scratchDirectory,
    claudeConfigDirectory,
  };
}

export function linkedScratchDirectory(profileDir: string): string {
  return path.join(path.resolve(profileDir), "scratch");
}
