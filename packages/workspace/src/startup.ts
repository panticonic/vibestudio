import { randomBytes } from "node:crypto";
import {
  createAndRegisterWorkspace,
  recoverStagedWorkspaceDeletions,
  resolveOrCreateWorkspace,
  resolveWorkspaceTemplateDir,
  type ResolvedWorkspace,
} from "./loader.js";
import type { CentralDataManager } from "@vibestudio/shared/centralData";

export interface ResolveLocalWorkspaceStartupOpts {
  appRoot: string;
  centralData?: CentralDataManager | null;
  wsDir?: string;
  name?: string;
  init?: boolean;
  isDev?: boolean;
  requireExplicitSelection?: boolean;
}

export interface LocalWorkspaceStartup {
  resolved: ResolvedWorkspace;
  isEphemeral: boolean;
}

/**
 * Shared local-workspace startup resolution for desktop and standalone server.
 *
 * Resolution order:
 * 1. Explicit workspace directory
 * 2. Explicit workspace name
 * 3. Ephemeral dev workspace when `isDev`
 * 4. Last-opened workspace from central data
 * 5. Default workspace
 *
 * IPC/server callers can set `requireExplicitSelection` to reject implicit
 * selection when they do not own central workspace state.
 */
export function resolveLocalWorkspaceStartup(
  opts: ResolveLocalWorkspaceStartupOpts
): LocalWorkspaceStartup {
  const centralData = opts.centralData ?? null;
  if (centralData) {
    recoverStagedWorkspaceDeletions(centralData);
  }

  if (opts.wsDir) {
    if (centralData) {
      throw new Error(
        "Explicit workspace directories are reserved for hub-managed child runtimes; select a registered workspace by name"
      );
    }
    const resolved = resolveOrCreateWorkspace({
      wsDir: opts.wsDir,
      appRoot: opts.appRoot,
      init: opts.init,
    });
    return {
      resolved,
      isEphemeral: false,
    };
  }

  if (opts.name) {
    const resolved = centralData
      ? resolveRegisteredWorkspace(opts.name, Boolean(opts.init), opts.appRoot, centralData)
      : resolveOrCreateWorkspace({
          name: opts.name,
          appRoot: opts.appRoot,
          init: opts.init,
        });
    return { resolved, isEphemeral: false };
  }

  if (opts.isDev) {
    const devName = `dev-${randomBytes(4).toString("hex")}`;
    const resolved = centralData
      ? resolveRegisteredWorkspace(devName, true, opts.appRoot, centralData)
      : resolveOrCreateWorkspace({
          name: devName,
          appRoot: opts.appRoot,
          init: true,
        });
    return { resolved, isEphemeral: true };
  }

  if (centralData) {
    const last = centralData.getLastOpenedWorkspace();
    if (last) {
      const resolved = resolveRegisteredWorkspace(last.name, false, opts.appRoot, centralData);
      return { resolved, isEphemeral: false };
    }

    const resolved = resolveRegisteredWorkspace("default", true, opts.appRoot, centralData);
    return { resolved, isEphemeral: false };
  }

  if (opts.requireExplicitSelection) {
    throw new Error("No workspace specified (set VIBESTUDIO_WORKSPACE_DIR or pass --workspace)");
  }

  return {
    resolved: resolveOrCreateWorkspace({
      name: "default",
      appRoot: opts.appRoot,
      init: true,
    }),
    isEphemeral: false,
  };
}

function resolveRegisteredWorkspace(
  name: string,
  createIfMissing: boolean,
  appRoot: string,
  centralData: CentralDataManager
): ResolvedWorkspace {
  const registered = centralData.getWorkspaceEntry(name);
  if (registered) {
    const resolved = resolveOrCreateWorkspace({ name, appRoot, init: false });
    centralData.touchWorkspace(name);
    return resolved;
  }
  if (!createIfMissing) {
    throw new Error(`Workspace "${name}" is not registered`);
  }

  const templateDir = resolveWorkspaceTemplateDir(appRoot);
  createAndRegisterWorkspace(name, centralData, templateDir ? { templateDir } : undefined);
  const resolved = resolveOrCreateWorkspace({ name, appRoot, init: false });
  return { ...resolved, created: true };
}
