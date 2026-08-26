import { resolveOrCreateWorkspace, type ResolvedWorkspace } from "./loader.js";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

export interface ResolveLocalWorkspaceStartupOpts {
  appRoot: string;
  wsDir?: string;
  name?: string;
  init?: boolean;
  requireExplicitSelection?: boolean;
  /** Authoritative hub identity for a child workspace created on this disk. */
  workspaceId?: string;
  /** Explicit exact root for a newly created child; existing workspaces ignore it. */
  rootTemplate?: WorkspaceTemplatePin;
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
 * 3. Default workspace for the legacy unselected local entry
 *
 * IPC/server callers can set `requireExplicitSelection` to reject implicit
 * selection when they do not own central workspace state.
 */
export function resolveLocalWorkspaceStartup(
  opts: ResolveLocalWorkspaceStartupOpts
): LocalWorkspaceStartup {
  if (opts.wsDir) {
    const resolved = resolveOrCreateWorkspace({
      wsDir: opts.wsDir,
      appRoot: opts.appRoot,
      init: opts.init,
      workspaceId: opts.workspaceId,
      ...(opts.rootTemplate ? { rootTemplate: opts.rootTemplate } : {}),
    });
    return {
      resolved,
      isEphemeral: false,
    };
  }

  if (opts.name) {
    const resolved = resolveOrCreateWorkspace({
      name: opts.name,
      appRoot: opts.appRoot,
      init: opts.init,
      workspaceId: opts.workspaceId,
      ...(opts.rootTemplate ? { rootTemplate: opts.rootTemplate } : {}),
    });
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
      workspaceId: opts.workspaceId,
      ...(opts.rootTemplate ? { rootTemplate: opts.rootTemplate } : {}),
    }),
    isEphemeral: false,
  };
}
