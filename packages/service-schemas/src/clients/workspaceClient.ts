/**
 * Typed workspace client — derives its RPC call surface from the shared
 * `workspaceMethods` schema table (`workspace.ts`), the
 * single source of truth for the workspace service's wire contract. Only the
 * non-RPC conveniences (`switchTo` alias, `units.watch()` event subscription)
 * are hand-written here.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { eventsMethods } from "../events.js";
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
type EventsTypedClient = TypedServiceClient<typeof eventsMethods>;

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
  /** Alias for the wire method `workspace.select` (switch + relaunch). */
  switchTo(name: string): Promise<void>;
  units: WorkspaceUnitsClient;
  /** Ergonomic project discovery; distinct from `workspace.list()` (workspace catalog). */
  projects: WorkspaceProjectsClient;
};

type WorkspaceRpc = RpcCaller & {
  on?: (event: string, listener: (event: { payload: unknown }) => void) => () => void;
};

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
    switchTo: (name) => typed.select(name),
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

const SUBSCRIBE_MAX_ATTEMPTS = 4;

/**
 * Subscribe to one topic, retrying with exponential backoff. On a
 * connectionless DO/worker a failed `events.subscribe` means no server→DO push
 * for that topic — the watch would be silently deaf. Retry, and if every
 * attempt fails (or the watch closed mid-retry), surface it via a warning
 * rather than swallowing the rejection.
 */
async function subscribeWithRetry(
  events: EventsTypedClient,
  topic: string,
  isClosed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  for (let attempt = 0; attempt < SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (isClosed()) return;
    try {
      await events.subscribe(topic);
      return;
    } catch (err) {
      if (attempt === SUBSCRIBE_MAX_ATTEMPTS - 1) {
        console.warn(
          `[workspace.watch] events.subscribe("${topic}") failed after ` +
            `${SUBSCRIBE_MAX_ATTEMPTS} attempts; this watch will not receive ` +
            `"${topic}" pushes:`,
          err
        );
        return;
      }
      await sleep(100 * Math.pow(2, attempt));
    }
  }
}

function createUnitsWatch(
  rpc: WorkspaceRpc,
  listUnits: () => Promise<WorkspaceUnitStatus[]>
): AsyncIterable<WorkspaceUnitStatus[]> {
  const events = createTypedServiceClient("events", eventsMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  ) as EventsTypedClient;
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let refreshInFlight = false;
      let refreshQueued = false;
      let lastRefreshError: string | null = null;
      let pendingResolve: ((result: IteratorResult<WorkspaceUnitStatus[]>) => void) | null = null;
      const queue: WorkspaceUnitStatus[][] = [];
      const pushSnapshot = () => {
        if (closed) return;
        if (refreshInFlight) {
          refreshQueued = true;
          return;
        }
        refreshInFlight = true;
        void listUnits()
          .then((snapshot) => {
            if (closed) return;
            lastRefreshError = null;
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
            // but a recurring failure shouldn't be invisible. Log each
            // continuous failure once: console records are themselves unit-log
            // events, so logging every refresh can create an event feedback
            // loop while a capability or service is unavailable.
            const message = err instanceof Error ? err.message : String(err);
            if (message !== lastRefreshError) {
              lastRefreshError = message;
              console.warn("[workspace.watch] snapshot refresh failed:", err);
            }
          })
          .finally(() => {
            refreshInFlight = false;
            if (!closed && refreshQueued) {
              refreshQueued = false;
              pushSnapshot();
            }
          });
      };
      // Topics this watch reflects. We MUST `events.subscribe` each (not just
      // register an `rpc.on` listener): a connectionless DO/worker only receives
      // server→DO pushes for topics it explicitly subscribed. The matching
      // `rpc.on` channel is `event:<topic>`.
      const topics = [
        "extensions:status",
        "extensions:health",
        "extensions:error",
        "apps:available",
        "apps:status",
        "apps:lifecycle",
      ];
      const unsubscribers = topics
        .map((topic) => rpc.on?.(`event:${topic}`, pushSnapshot))
        .filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
      // Subscribing is what makes this watch live on a connectionless DO/worker
      // (only explicitly-subscribed topics get server→DO pushes). A swallowed
      // subscribe rejection would leave `watch()` permanently deaf to that topic
      // while the initial snapshot masks the failure — so retry with backoff and
      // surface a final rejection instead of silently dropping it.
      for (const topic of topics) {
        void subscribeWithRetry(events, topic, () => closed);
      }

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
          for (const topic of topics) {
            void events.unsubscribe(topic).catch(() => {});
          }
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
