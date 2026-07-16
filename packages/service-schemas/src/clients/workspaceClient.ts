/**
 * Typed workspace client — derives its RPC call surface from the shared
 * `workspaceMethods` schema table (`workspace.ts`), the
 * single source of truth for the workspace service's wire contract. Only the
 * non-RPC conveniences (`units.watch()` event subscription)
 * are hand-written here.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import type { EventName } from "@vibestudio/shared/events";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { EventsClient } from "./eventsClient.js";
import { workspaceMethods, type WorkspaceUnitStatus } from "../workspace.js";
import type { WorkspaceTreeNode } from "../workspace.js";

export type { InitPanelEntry, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
export type {
  WorkspaceEntry,
  WorkspaceAppVersionRecord,
  WorkspaceAppVersions,
  WorkspaceUnitStatus,
  WorkspaceUnitLogRecord,
  WorkspaceUnitBuildEvent,
  WorkspaceUnitDiagnostics,
  WorkspaceRecurringJobStatus,
} from "../workspace.js";

type WorkspaceTypedClient = TypedServiceClient<typeof workspaceMethods>;

export type WorkspaceUnitsClient = WorkspaceTypedClient["units"] & {
  /** Current unit status rows; ergonomic alias for `list()`. */
  status(): Promise<WorkspaceUnitStatus[]>;
  /**
   * Live unit-status snapshots: emits a fresh `units.list()` result on every
   * unit-related event (status, health, lifecycle, logs). Best-effort — fetch
   * errors are swallowed; call `list()` directly to observe them.
   */
  watch(): AsyncIterable<WorkspaceUnitStatus[]>;
};

export type WorkspaceProjectsClient = {
  /** List project-root unit paths (for example `projects/my-app`). */
  list(): Promise<string[]>;
  /** Resolve a path to its owning project, or null when it is not under projects/. */
  findForPath(path: string): ReturnType<WorkspaceTypedClient["findUnitForPath"]>;
};

export type WorkspaceClient = Omit<WorkspaceTypedClient, "units"> & {
  units: WorkspaceUnitsClient;
  /** Ergonomic project discovery; distinct from `workspace.list()` (workspace catalog). */
  projects: WorkspaceProjectsClient;
};

type WorkspaceRpc = RpcCaller;

export function createWorkspaceClient(rpc: WorkspaceRpc): WorkspaceClient {
  const typed = createTypedServiceClient("workspace", workspaceMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  const listUnits = () => typed.units.list();
  const listProjects = async (): Promise<string[]> => {
    const tree = await typed.sourceTree();
    return collectProjectUnitPaths(tree.children);
  };
  return {
    ...typed,
    units: {
      ...typed.units,
      status: listUnits,
      watch: () => createUnitsWatch(rpc, listUnits),
    },
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

function createUnitsWatch(
  rpc: WorkspaceRpc,
  listUnits: () => Promise<WorkspaceUnitStatus[]>
): AsyncIterable<WorkspaceUnitStatus[]> {
  const events = new EventsClient(rpc);
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let pendingResolve: ((result: IteratorResult<WorkspaceUnitStatus[]>) => void) | null = null;
      const queue: WorkspaceUnitStatus[][] = [];
      const pushSnapshot = () => {
        void listUnits()
          .then((snapshot) => {
            if (closed) return;
            const resolve = pendingResolve;
            if (resolve) {
              pendingResolve = null;
              resolve({ done: false, value: snapshot });
              return;
            }
            queue.push(snapshot);
          })
          .catch((err) => {
            // Watch is best-effort (callers can still call list() for errors),
            // but a recurring failure shouldn't be invisible — log it so a
            // permanently-deaf watch is diagnosable instead of silent.
            console.warn("[workspace.watch] snapshot refresh failed:", err);
          });
      };
      const topics = [
        "extensions:status",
        "extensions:health",
        "extensions:error",
        "apps:available",
        "apps:status",
        "apps:lifecycle",
        "workspace:unit-log",
      ] satisfies EventName[];
      const unsubscribers = topics.map((topic) => events.on(topic, pushSnapshot));
      void events.subscribeAll(topics).catch((err) => {
        if (!closed) console.warn("[workspace.watch] event watch failed:", err);
      });

      pushSnapshot();
      return {
        next(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
          if (queue.length > 0) {
            return Promise.resolve({ done: false, value: queue.shift()! });
          }
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
          closed = true;
          for (const unsubscribe of unsubscribers) unsubscribe();
          void events.unsubscribeAll().catch(() => {});
          if (pendingResolve) {
            pendingResolve({ done: true, value: undefined });
            pendingResolve = null;
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}
