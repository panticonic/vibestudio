import { accessSync, constants, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { compileMxcLaunch } from "@vibestudio/process-adapter/mxc";
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
const SAFE_CONFINEMENT_KEYS = [
  "TMP",
  "TEMP",
  "TMPDIR",
  "VIBESTUDIO_LINKED_SCRATCH",
  "CLAUDE_CONFIG_DIR",
] as const;

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
    USERPROFILE: home,
    APPDATA: xdgConfig,
    LOCALAPPDATA: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
  };
  if (process.platform === "win32" && ambient["SystemRoot"]) {
    env["SystemRoot"] = ambient["SystemRoot"];
  }
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
  /** Pinned installed MXC binary, supplied by the trusted launcher. */
  launcher: string;
  /** Explicit CLI/runtime resources; never the host filesystem root. */
  readPaths: string[];
  launchEnv: Record<string, string>;
  platform?: NodeJS.Platform;
}

/** Resolve a command from the trusted owner's PATH before constructing policy. */
export function resolveClaudeRuntimeCommand(name: string, pathValue = process.env["PATH"]): string {
  const candidates = path.isAbsolute(name)
    ? [name]
    : (pathValue ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          process.platform === "win32"
            ? [name, `${name}.exe`, `${name}.cmd`].map((file) => path.resolve(directory, file))
            : [path.resolve(directory, name)]
        );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Resolution runs in the owner; no guest-controlled executable search.
    }
  }
  throw new Error(`Linked Claude runtime command is not installed: ${name}`);
}

/**
 * Linked Claude is a network-capable provider with an explicitly provisioned
 * agent identity. MXC protects managed context from writes and limits filesystem
 * reads to its installed runtime and admitted context. Its provider/Iroh network
 * is intentionally available; this is not the network-denied workspace-command
 * contract and does not claim HTTP mediation. No host-root filesystem grant is
 * made (particularly important for Windows ACL-based confinement).
 */
export function confineClaudeReadOnly(input: ClaudeReadOnlyLaunchInput): ClaudeReadOnlyLaunch {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`Linked Claude MXC execution is unsupported on ${platform}`);
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(input.argv[0] ?? "")) {
    throw new Error(
      "Linked Claude requires its native Windows executable; command-script shims cannot be launched by MXC"
    );
  }
  if (!input.argv.length) throw new Error("Claude launch has no executable");
  const profileDir = paths.resolve(input.profileDir);
  const contextDirectory = paths.resolve(input.contextDirectory);
  const readPaths = [...new Set([...input.readPaths, contextDirectory])];
  for (const resource of [input.launcher, input.argv[0]!, profileDir, ...readPaths]) {
    if (
      !paths.isAbsolute(resource) ||
      resource.includes("\0") ||
      resource === paths.parse(resource).root
    ) {
      throw new Error("Linked Claude resources must be absolute paths below the host root");
    }
  }
  const contains = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return (
      !relative ||
      (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
    );
  };
  if (
    readPaths.some((resource) => contains(resource, profileDir) || contains(profileDir, resource))
  ) {
    throw new Error("Linked Claude writable profile and readonly resources must be disjoint");
  }
  if (!readPaths.some((resource) => contains(resource, input.argv[0]!))) {
    throw new Error("Claude executable must belong to the admitted runtime");
  }
  const scratchDirectory = paths.join(profileDir, "scratch");
  const claudeConfigDirectory = paths.join(profileDir, "claude-config");
  const temporaryDirectory = paths.join(profileDir, "tmp");
  for (const directory of [scratchDirectory, claudeConfigDirectory, temporaryDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const env = {
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    VIBESTUDIO_LINKED_SCRATCH: scratchDirectory,
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
  };
  const environment = claudeContainedSpawnEnvironment({
    profileDir,
    launchEnv: input.launchEnv,
    confinementEnv: env,
  });
  const launch = compileMxcLaunch({
    network: "allow",
    platform,
    launcher: input.launcher,
    containerId: `vibestudio-claude-${randomUUID()}`,
    argv: input.argv,
    cwd: contextDirectory,
    guestEnvironment: environment,
    readPaths,
    writePaths: [profileDir],
  });
  return {
    command: launch.command,
    args: launch.args,
    env: launch.environment,
    scratchDirectory,
    claudeConfigDirectory,
  };
}

export function linkedScratchDirectory(profileDir: string): string {
  return path.join(path.resolve(profileDir), "scratch");
}
