/**
 * Typed client for the workerd RPC service.
 *
 * Worker instance lifecycle and workspace service resolution.
 * The ergonomic methods here delegate to the canonical runtime entity service,
 * so panels, workers, Durable Objects, and eval all use the same lifecycle.
 *
 * DO-storage primitives (cloneDO/destroyDO) are NOT here: they are server-internal
 * and reached only through `runtime.cloneContext`/`runtime.destroyContext`.
 * Source discovery stays here as `workers.listSources()` so the rich runtime
 * binding does not force callers down to raw `rpc.call` for the obvious read.
 *
 * Available to server, panel, and worker callers.
 */
import type { RpcCaller } from "@vibestudio/rpc";
import type {
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import {
  createDurableObjectServiceClient,
  type DurableObjectServiceClient,
  type ResolvedDurableObjectTarget,
} from "@vibestudio/shared/workspaceServiceRpc";

export {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  createDurableObjectServiceClient,
  createGadServiceClient,
  doTargetId,
  parseDoTargetId,
  resolveDurableObjectService,
} from "@vibestudio/shared/workspaceServiceRpc";
export type {
  DORefParam,
  DurableObjectServiceClient,
  ResolvedDurableObjectTarget,
} from "@vibestudio/shared/workspaceServiceRpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WorkerSourceInfo {
  name: string;
  source: string;
  title?: string;
  /** Manifest entry point relative to `source`; do not guess `index.ts`. */
  entry?: string;
  /** Durable Object classes declared by this source; empty for a regular worker. */
  classes: Array<{ className: string; [key: string]: unknown }>;
  agent?: {
    displayName?: string;
    description?: string;
    icon?: string;
    defaultConfig?: unknown;
  };
}

export type WorkerCreateOptions = Omit<
  Extract<RuntimeEntityCreateSpec, { kind: "worker" }>,
  "kind" | "source"
>;

export type WorkerEntityHandle = RuntimeEntityHandle & { kind: "worker" };

/** Any runtime entity reference accepted by the shared retirement path. */
export type RuntimeEntityReference =
  | string
  | Pick<RuntimeEntityHandle, "id">
  | Pick<ResolvedDurableObjectTarget, "targetId">;

export interface WorkerEntityInfo {
  id: string;
  kind: "worker";
  source: string;
  /** Caller-selected instance key; match this or `id` against create(). */
  key: string;
  contextId: string;
  title?: string;
  createdAt: number;
}

export type WorkspaceServiceInfo = {
  origin: "product" | "workspace";
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
  /** Live, caller-context documentation entry for workspace-owned services. */
  docsId?: string;
} & (
  | {
      kind: "durable-object";
      className: string;
      defaultObjectKey: string | null;
    }
  | {
      kind: "worker";
      routePath: string;
    }
);
export type ResolvedWorkspaceService = {
  origin: "product" | "workspace";
  name: string;
  title?: string;
  description?: string;
  /**
   * The protocol that matched resolveService(). Absent when resolution used
   * the service name instead of a declared protocol.
   */
  protocol?: string;
  protocols: string[];
  source: string;
} & (
  | {
      kind: "durable-object";
      className: string;
      objectKey: string;
      targetId: string;
    }
  | {
      kind: "worker";
      routePath: string;
      routeBasePath: string;
    }
);
// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WorkerdClient {
  /** List every launchable worker source and its real manifest entry point. */
  listSources(): Promise<WorkerSourceInfo[]>;
  /**
   * Launch a regular worker in the caller's context through the canonical lifecycle.
   * options.key is an immutable instance identity, including its selected code
   * version and context. Use a fresh key for a replacement or after editing
   * disposable code. Dispose short-lived handles in finally; long-lived instances
   * need an explicit owner and retirement lifecycle.
   */
  create(source: string, options?: WorkerCreateOptions): Promise<WorkerEntityHandle>;
  /** List live regular-worker instances. */
  list(): Promise<WorkerEntityInfo[]>;
  /** Retire a regular worker or disposable resolved Durable Object. */
  destroy(entity: RuntimeEntityReference): Promise<void>;
  /** List product-owned and workspace-authored services available here. */
  listServices(): Promise<WorkspaceServiceInfo[]>;
  /** Resolve a workspace service by name or protocol. */
  resolveService(query: string, objectKey?: string | null): Promise<ResolvedWorkspaceService>;
  /** Resolve a concrete Durable Object target and grant this caller relay access. */
  resolveDurableObject(
    source: string,
    className: string,
    objectKey: string
  ): Promise<ResolvedDurableObjectTarget>;
  /** Resolve a Durable Object-backed service and call it through unified RPC. */
  durableObjectService(query: string, objectKey?: string | null): DurableObjectServiceClient;
}
export function createWorkerdClient(rpc: RpcCaller): WorkerdClient {
  const callWorkers = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workers.${method}`, args);

  return {
    listSources: () => callWorkers<WorkerSourceInfo[]>("listSources"),
    create: (source, options = {}) =>
      rpc.call<WorkerEntityHandle>("main", "runtime.createEntity", [
        { kind: "worker", source, ...options },
      ]),
    list: () => rpc.call<WorkerEntityInfo[]>("main", "runtime.listEntities", [{ kind: "worker" }]),
    destroy: (entity) =>
      rpc.call<void>("main", "runtime.retireEntity", [
        {
          id: typeof entity === "string" ? entity : "id" in entity ? entity.id : entity.targetId,
        },
      ]),
    listServices: () => callWorkers<WorkspaceServiceInfo[]>("listServices"),
    resolveService: (query, objectKey) =>
      callWorkers<ResolvedWorkspaceService>("resolveService", query, objectKey ?? null),
    resolveDurableObject: (source, className, objectKey) =>
      callWorkers<ResolvedDurableObjectTarget>(
        "resolveDurableObject",
        source,
        className,
        objectKey
      ),
    durableObjectService: (query, objectKey) =>
      createDurableObjectServiceClient(rpc, query, objectKey),
  };
}
