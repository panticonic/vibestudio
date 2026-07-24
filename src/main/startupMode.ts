/**
 * StartupMode — discriminated union for the desktop shell's startup target.
 *
 * Remote topology is now WebRTC (paired by QR via the remoteCred flow, not a
 * startup mode), so startup resolves only local-vs-pending; the shell always
 * spawns its own loopback server. Includes `resolveStartupMode()`.
 */

import * as path from "path";
import * as fs from "fs";
import { createDevLogger } from "@vibestudio/dev-log";
import { isDev } from "./utils.js";
import { getAppRoot, getCentralConfigDirectory } from "./paths.js";
import { resolveWorkspaceName } from "@vibestudio/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@vibestudio/workspace/startup";
import { EPHEMERAL_DEV_WORKSPACE_NAME } from "@vibestudio/workspace-contracts/ephemeral";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import { DEV_WEBRTC_REMOTE_ARG } from "./startupInvocation.js";

const log = createDevLogger("StartupMode");
export const CHOOSE_CONNECTION_ARG = "--choose-connection";
export const WORKSPACE_CREATE_IF_MISSING_ARG = "--workspace-create-if-missing";
/**
 * Marks a local launch as a disposable dev workspace: the workspace dir is deleted on exit
 * (see the will-quit cleanup). Paired with `--workspace <name>` so the same workspace is kept
 * across relaunches within a session rather than minting a new one each time.
 */
export const EPHEMERAL_WORKSPACE_ARG = "--ephemeral-workspace";
export { EPHEMERAL_DEV_WORKSPACE_NAME };

export type StartupMode =
  | {
      kind: "pending";
    }
  | {
      kind: "local";
      /**
       * Whether this launch explicitly selected the local workspace or merely
       * resolved it as the fallback for an automatic "resume where I left off"
       * launch. Only the latter may be replaced by a saved remote connection.
       */
      connectionIntent: "local" | "resume-saved-remote";
      wsDir: string;
      workspaceName: string;
      workspaceId: string;
      isEphemeral: boolean;
      /**
       * A new development session replaces any prior hub-owned `dev`
       * lifecycle; an internal Electron relaunch resumes the lifecycle it
       * already created. Non-ephemeral workspaces carry null.
       */
      ephemeralLifecycle: "replace" | "resume" | null;
    };

export type LocalStartupMode = Extract<StartupMode, { kind: "local" }>;
/**
 * A startup mode that establishes a server session. Remote topology is now
 * WebRTC (paired by QR via the remoteCred flow, not a startup mode), so the only
 * connected startup mode is local — the shell always spawns its own loopback
 * server. (`§8c` deleted the `kind: "remote"` arm + its env/stored-credential
 * resolution.)
 */
export type ConnectedStartupMode = LocalStartupMode;

export function shouldRequestSingleInstanceLock(
  mode: StartupMode,
  opts: { isHeadlessHost: boolean; isDevelopment: boolean }
): boolean {
  if (opts.isHeadlessHost) return false;
  if (opts.isDevelopment && mode.kind === "local") return false;
  return true;
}

/**
 * Get the user data directory for the pre-session bootstrap shell.
 * This keeps chooser state separate from workspace state because no workspace
 * has been selected yet.
 */
export function getPendingUserDataDir(): string {
  const dir = path.join(getCentralConfigDirectory(), "bootstrap-state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the startup mode from environment and CLI args.
 *
 * Resolves local-vs-pending only. Remote is paired live via WebRTC (remoteCred /
 * QR), never a startup env URL or stored-remote relaunch (§8c).
 */
export function resolveStartupMode(
  centralData: CentralDataManager,
  opts?: { interactiveDesktop?: boolean }
): StartupMode {
  // Startup resolves local-vs-pending: resume the last/default local workspace
  // unless the user explicitly asked to choose a connection (which surfaces the
  // chooser to open a local workspace or pair a remote server via WebRTC QR).
  if (opts?.interactiveDesktop === true && hasConnectDeepLinkArg()) {
    log.info("[Workspace] Waiting for WebRTC pairing link opened at launch");
    return { kind: "pending" };
  }

  if (process.argv.includes(EPHEMERAL_WORKSPACE_ARG)) {
    const requested = resolveWorkspaceName();
    if (requested && requested !== EPHEMERAL_DEV_WORKSPACE_NAME) {
      throw new Error(
        `Ephemeral development launches use the canonical workspace "${EPHEMERAL_DEV_WORKSPACE_NAME}"`
      );
    }
    return resolveEphemeralDevStartupMode("resume");
  }

  if (hasExplicitWorkspaceSelection()) {
    return resolveLocalStartupMode(centralData, undefined, "local");
  }

  if (process.argv.includes(CHOOSE_CONNECTION_ARG) && opts?.interactiveDesktop === true) {
    log.info("[Workspace] Waiting for user to choose a server or local workspace");
    return { kind: "pending" };
  }

  if (opts?.interactiveDesktop === true && isDev()) {
    return resolveEphemeralDevStartupMode();
  }

  // Pre-session startup has no authenticated user. Use the catalog's machine
  // MRU as the local fallback; only an ordinary interactive launch may resume
  // a saved remote connection. Headless hosts always own a local workspace.
  return resolveLocalStartupMode(
    centralData,
    undefined,
    opts?.interactiveDesktop === true ? "resume-saved-remote" : "local"
  );
}

function hasExplicitWorkspaceSelection(): boolean {
  return resolveWorkspaceName() !== null;
}

function hasConnectDeepLinkArg(): boolean {
  return process.argv.some((arg) => arg.startsWith("vibestudio://connect"));
}

function shouldCreateExplicitWorkspaceIfMissing(): boolean {
  return process.argv.includes(WORKSPACE_CREATE_IF_MISSING_ARG);
}

export function stripStartupSelectionArgs(rawArgs: readonly string[]): string[] {
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--workspace" && i + 1 < rawArgs.length) {
      i++;
      continue;
    }
    if (arg?.startsWith("--workspace=")) continue;
    if (arg === CHOOSE_CONNECTION_ARG) continue;
    if (arg === WORKSPACE_CREATE_IF_MISSING_ARG) continue;
    if (arg === DEV_WEBRTC_REMOTE_ARG) continue;
    if (arg === EPHEMERAL_WORKSPACE_ARG) continue;
    if (arg?.startsWith("vibestudio://connect")) continue;
    if (arg?.startsWith("vibestudio://panel")) continue;
    if (arg !== undefined) filteredArgs.push(arg);
  }
  return filteredArgs;
}

export function workspaceRelaunchArgs(name: string, rawArgs = process.argv.slice(1)): string[] {
  // Workspace switching only selects an existing workspace. Creation is an
  // explicit workflow and must never be triggered by a typo in a select call.
  return [...stripStartupSelectionArgs(rawArgs), "--workspace", name];
}

export function chooseConnectionRelaunchArgs(rawArgs = process.argv.slice(1)): string[] {
  return [...stripStartupSelectionArgs(rawArgs), CHOOSE_CONNECTION_ARG];
}

/** Relaunch into the one hub-owned disposable development workspace. */
export function ephemeralWorkspaceRelaunchArgs(rawArgs = process.argv.slice(1)): string[] {
  return [
    ...stripStartupSelectionArgs(rawArgs),
    "--workspace",
    EPHEMERAL_DEV_WORKSPACE_NAME,
    EPHEMERAL_WORKSPACE_ARG,
  ];
}

/**
 * Select the hub-owned disposable development workspace without creating or
 * registering a competing desktop-owned checkout. The logical directory is
 * reserved for desktop state and durable reach identity; the hub owns the
 * random source/state checkout used by the workspace child.
 */
export function resolveEphemeralDevStartupMode(
  ephemeralLifecycle: "replace" | "resume" = "replace"
): LocalStartupMode {
  const wsDir = path.join(getCentralConfigDirectory(), "workspaces", EPHEMERAL_DEV_WORKSPACE_NAME);
  log.info(`[Workspace] Selected hub-owned ephemeral workspace "${EPHEMERAL_DEV_WORKSPACE_NAME}"`);
  return {
    kind: "local",
    connectionIntent: "local",
    wsDir,
    workspaceName: EPHEMERAL_DEV_WORKSPACE_NAME,
    // Provisional until the hub returns its opaque registry id. Main replaces
    // this immediately after the server session is established.
    workspaceId: EPHEMERAL_DEV_WORKSPACE_NAME,
    isEphemeral: true,
    ephemeralLifecycle,
  };
}

export function resolveLocalStartupMode(
  centralData: CentralDataManager,
  preferredName?: string,
  connectionIntent: LocalStartupMode["connectionIntent"] = "local"
): LocalStartupMode {
  // Local mode: resolve workspace from disk
  const wsName = resolveWorkspaceName() ?? preferredName;
  const appRoot = getAppRoot();
  const startup = resolveLocalWorkspaceStartup({
    appRoot,
    centralData,
    name: wsName ?? undefined,
    ...(wsName ? { init: shouldCreateExplicitWorkspaceIfMissing() } : {}),
  });
  log.info(
    `[Workspace] Loaded: ${startup.resolved.wsDir} (id: ${startup.resolved.workspace.config.id})`
  );
  const isEphemeral = startup.isEphemeral;
  return {
    kind: "local",
    connectionIntent,
    wsDir: startup.resolved.wsDir,
    workspaceName: startup.resolved.name,
    workspaceId: startup.resolved.workspace.config.id,
    isEphemeral,
    ephemeralLifecycle: null,
  };
}
