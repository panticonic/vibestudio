/**
 * Typed workspace client — derives its RPC call surface from the shared
 * `workspaceMethods` schema table (`workspace.ts`), the
 * single source of truth for the workspace service's wire contract. Only the
 * project discovery convenience is hand-written here.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "../workspace.js";
import type { WorkspaceTreeNode } from "../workspace.js";

export type { InitPanelEntry, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
export type {
  WorkspaceEntry,
  WorkspaceRecurringJobStatus,
} from "../workspace.js";

type WorkspaceTypedClient = TypedServiceClient<typeof workspaceMethods>;

export type WorkspaceProjectsClient = {
  /** List project-root unit paths (for example `projects/my-app`). */
  list(): Promise<string[]>;
  /** Resolve a path to its owning project, or null when it is not under projects/. */
  findForPath(path: string): ReturnType<WorkspaceTypedClient["findUnitForPath"]>;
};

export type WorkspaceClient = WorkspaceTypedClient & {
  /** Ergonomic project discovery; distinct from `workspace.list()` (workspace catalog). */
  projects: WorkspaceProjectsClient;
};

type WorkspaceRpc = RpcCaller;

export function createWorkspaceClient(rpc: WorkspaceRpc): WorkspaceClient {
  const typed = createTypedServiceClient("workspace", workspaceMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  const listProjects = async (): Promise<string[]> => {
    const tree = await typed.sourceTree();
    return collectProjectUnitPaths(tree.children);
  };
  return {
    ...typed,
    projects: {
      list: listProjects,
      findForPath: async (path) => {
        const resolved = await typed.findUnitForPath(path);
        return resolved?.unitPath.startsWith("projects/") ? resolved : null;
      },
    },
  };
}

function collectProjectUnitPaths(nodes: readonly WorkspaceTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (node: WorkspaceTreeNode): void => {
    if (node.isUnit && node.path.startsWith("projects/")) paths.push(node.path);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return [...new Set(paths)].sort();
}
