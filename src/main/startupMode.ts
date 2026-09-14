/**
 * StartupMode — discriminated union for the desktop shell's startup target.
 *
 * Remote topology is Iroh (paired by QR via the remoteCred flow, not a
 * startup mode), so startup resolves only local-vs-pending; the shell always
 * spawns its own loopback server. Includes `resolveStartupMode()`.
 */

import * as path from "path";
import * as fs from "fs";
import { createDevLogger } from "@vibestudio/dev-log";
import { getAppRoot, getCentralConfigDirectory } from "./paths.js";
import { resolveWorkspaceName } from "@vibestudio/workspace/loader";
import { readWorkspaceCreationTemplate } from "@vibestudio/workspace/templateRelease";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import { DEV_IROH_REMOTE_ARG } from "./startupInvocation.js";

const log = createDevLogger("StartupMode");
export const CHOOSE_CONNECTION_ARG = "--choose-connection";
export const WORKSPACE_CREATE_IF_MISSING_ARG = "--workspace-create-if-missing";
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
      /** Null until authentication selects the user's Personal workspace. */
      wsDir: string | null;
      workspaceName: string | null;
      workspaceId: string | null;
    };

export type LocalStartupMode = Extract<StartupMode, { kind: "local" }>;
/**
 * A startup mode that establishes a server session. Remote topology is now
 * Iroh (paired by QR via the remoteCred flow, not a startup mode), so the only
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
 * Chromium state cannot live inside a workspace directory until the workspace
 * child has admitted and created that directory. Keep the first shell session
 * in profile bootstrap state; later launches use the admitted workspace state.
 */
export function localShellUserDataDir(
  mode: LocalStartupMode,
  options: { pendingCreation: boolean; headless: boolean }
): string {
  if (!mode.workspaceName)
    return path.join(getPendingUserDataDir(), options.headless ? "headless" : "desktop");
  if (options.pendingCreation) {
    return path.join(
      getPendingUserDataDir(),
      "workspace-creation",
      mode.workspaceId!,
      options.headless ? "headless" : "desktop"
    );
  }
  return path.join(mode.wsDir!, options.headless ? "state-headless-host" : "state");
}

/**
 * Resolve the startup mode from environment and CLI args.
 *
 * Resolves local-vs-pending only. Remote is paired live via Iroh (remoteCred /
 * QR), never a startup env URL or stored-remote relaunch (§8c).
 */
export function resolveStartupMode(
  centralData: CentralDataManager,
  opts?: { interactiveDesktop?: boolean }
): StartupMode {
  // Startup resolves local-vs-pending: resume the last/default local workspace
  // unless the user explicitly asked to choose a connection (which surfaces the
  // chooser to open a local workspace or pair a remote server via Iroh QR).
  if (opts?.interactiveDesktop === true && hasConnectDeepLinkArg()) {
    log.info("[Workspace] Waiting for Iroh pairing link opened at launch");
    return { kind: "pending" };
  }

  if (hasExplicitWorkspaceSelection()) {
    return resolveLocalStartupMode(centralData, undefined, "local");
  }

  if (process.argv.includes(CHOOSE_CONNECTION_ARG) && opts?.interactiveDesktop === true) {
    log.info("[Workspace] Waiting for user to choose a server or local workspace");
    return { kind: "pending" };
  }

  // Authenticate before selecting the user's private workspace. A machine-wide
  // MRU cannot choose an account's Personal workspace or create one on its behalf.
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
  return process.argv.some(
    (arg) => arg.startsWith("vibestudio://connect") || arg.startsWith("https://vibestudio.app/p#")
  );
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
    if (arg === DEV_IROH_REMOTE_ARG) continue;
    if (arg?.startsWith("vibestudio://connect") || arg?.startsWith("https://vibestudio.app/p#"))
      continue;
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

export function resolveLocalStartupMode(
  centralData: CentralDataManager,
  preferredName?: string,
  connectionIntent: LocalStartupMode["connectionIntent"] = "local",
  createIfMissing = false
): LocalStartupMode {
  const explicitlyNamed = resolveWorkspaceName() ?? preferredName;
  if (!explicitlyNamed)
    return {
      kind: "local",
      connectionIntent,
      wsDir: null,
      workspaceName: null,
      workspaceId: null,
    };
  const name = explicitlyNamed;
  let entry = centralData.getWorkspaceEntry(name);
  if (!entry) {
    const mayCreate =
      explicitlyNamed === null ||
      explicitlyNamed === undefined ||
      createIfMissing ||
      shouldCreateExplicitWorkspaceIfMissing();
    if (!mayCreate) throw new Error(`Workspace "${name}" is not registered`);
    entry = centralData.addWorkspaceCreation(
      name,
      readWorkspaceCreationTemplate(getAppRoot(), process.env, { allowInitialOverride: true })
    );
    log.info(`[Workspace] Recorded pending creation for "${name}" (${entry.workspaceId})`);
  } else {
    centralData.touchWorkspace(name);
    log.info(`[Workspace] Selected "${name}" (${entry.workspaceId})`);
  }
  return {
    kind: "local",
    connectionIntent,
    wsDir: getWorkspaceDir(name),
    workspaceName: name,
    workspaceId: entry.workspaceId,
  };
}
