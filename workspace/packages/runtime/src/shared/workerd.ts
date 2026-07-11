/**
 * Typed client for the workerd RPC service.
 *
 * Worker instance lifecycle is launched via `runtime.createEntity({kind:"worker"})`
 * and retired via `runtime.retireEntity({id})` — there is no `workerd.*` lifecycle
 * client anymore. What remains here is manifest-declared userland service
 * resolution (`listServices`/`resolveService`/`resolveDurableObject`/
 * `durableObjectService`).
 *
 * DO-storage primitives (cloneDO/destroyDO) are NOT here: they are server-internal
 * and reached only through `runtime.cloneContext`/`runtime.destroyContext`.
 * Source discovery stays here as `workers.listSources()` so the rich runtime
 * binding does not force callers down to raw `rpc.call` for the obvious read.
 *
 * Available to server, panel, and worker callers.
 */
import type { RpcCaller } from "@vibestudio/rpc";
import {
  createDurableObjectServiceClient,
  type DurableObjectServiceClient,
  type ResolvedDurableObjectTarget,
} from "@vibestudio/shared/userlandServiceRpc";

export {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  createDurableObjectServiceClient,
  createGadServiceClient,
  doTargetId,
  parseDoTargetId,
  resolveDurableObjectService,
} from "@vibestudio/shared/userlandServiceRpc";
export type {
  DORefParam,
  DurableObjectServiceClient,
  ResolvedDurableObjectTarget,
} from "@vibestudio/shared/userlandServiceRpc";

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

export type UserlandServiceInfo = {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
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
export type ResolvedUserlandService = {
  name: string;
  title?: string;
  description?: string;
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
  /** List manifest-declared userland services offered by worker packages. */
  listServices(): Promise<UserlandServiceInfo[]>;
  /** Resolve a manifest-declared userland service by name or protocol. */
  resolveService(query: string, objectKey?: string | null): Promise<ResolvedUserlandService>;
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
    listServices: () => callWorkers<UserlandServiceInfo[]>("listServices"),
    resolveService: (query, objectKey) =>
      callWorkers<ResolvedUserlandService>("resolveService", query, objectKey ?? null),
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
