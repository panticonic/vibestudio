import * as fs from "node:fs";
import * as path from "node:path";
import type { SystemTestWorkspaceRole } from "./systemTestInstance.js";

/**
 * A CLI profile bound to one of an instance's workspaces.
 *
 * The CLI reads its credential from `VIBESTUDIO_INSTANCE_ROOT`, so a second
 * root is the whole mechanism: commands run against it are paired to another
 * workspace of the same server, and commands run without it are untouched.
 * That is what keeps a system-workspace run scoped to the scenarios that ask
 * for one instead of moving every test off the instance's `dev` workspace.
 */
export interface SystemTestWorkspaceProfile {
  /** Value to use as VIBESTUDIO_INSTANCE_ROOT for this profile's commands. */
  root: string;
  workspaceId: string;
  workspaceName: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  privateRole?: string;
}

/** The instance's System workspace, which is where a desktop client lands. */
export function selectWorkspaceForRole(
  workspaces: readonly WorkspaceSummary[],
  role: SystemTestWorkspaceRole
): WorkspaceSummary {
  if (role === "dev") {
    throw new Error("The dev workspace is the instance's own profile; no selection is needed");
  }
  const selected = workspaces.filter((workspace) => workspace.privateRole === "system");
  if (selected.length !== 1) {
    throw new Error(
      `Expected exactly one system workspace on this instance, found ${selected.length}`
    );
  }
  return selected[0]!;
}

export function workspaceProfileRoot(instanceRoot: string, role: SystemTestWorkspaceRole): string {
  return path.join(instanceRoot, "workspace-profiles", role);
}

/** True when this profile already holds a credential for `workspaceId`. */
export function profileIsPaired(root: string, workspaceId: string): boolean {
  try {
    const credentials = JSON.parse(
      fs.readFileSync(path.join(root, "cli-credentials.json"), "utf8")
    ) as { workspaceId?: unknown };
    return credentials.workspaceId === workspaceId;
  } catch {
    return false;
  }
}
