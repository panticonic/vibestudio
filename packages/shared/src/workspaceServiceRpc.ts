export interface RpcCallerLike {
  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptionsLike
  ): Promise<T>;
}

export interface RpcCallOptionsLike {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DORefParam {
  source: string;
  className: string;
  objectKey: string;
}

export type ResolvedWorkspaceService = {
  origin: "workspace";
  name?: string;
  title?: string;
  description?: string;
  protocols?: string[];
  source: string;
} & (
  | { kind: "durable-object"; className: string; objectKey: string; targetId: string }
  | { kind: "worker"; routePath: string; routeBasePath: string }
);

export interface ResolvedDurableObjectTarget {
  kind: "durable-object";
  source: string;
  className: string;
  objectKey: string;
  targetId: string;
}

export interface DurableObjectServiceClient {
  resolve(options?: RpcCallOptionsLike): Promise<ResolvedDurableObjectTarget>;
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  callWithOptions<T = unknown>(
    method: string,
    args: unknown[],
    options: RpcCallOptionsLike
  ): Promise<T>;
}

export const GAD_WORKSPACE_SERVICE_PROTOCOL = "vibestudio.gad.workspace.v1";

/** Shared wire contract implemented by the manifest-declared workspace source provider. */
export const VCS_SERVICE_PROTOCOL = "vibestudio.vcs.v1";

export function doTargetId(ref: DORefParam): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

export function parseDoTargetId(targetId: string): DORefParam | null {
  if (!targetId.startsWith("do:")) return null;
  const body = targetId.slice(3);
  const slashIdx = body.indexOf("/");
  const colonAfterSlash = slashIdx >= 0 ? body.indexOf(":", slashIdx) : -1;
  if (colonAfterSlash === -1) return null;
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) return null;
  return {
    source,
    className: rest.slice(0, nextColon),
    objectKey: rest.slice(nextColon + 1),
  };
}

export async function resolveDurableObjectService(
  rpc: RpcCallerLike,
  query: string,
  objectKey?: string | null,
  options?: RpcCallOptionsLike
): Promise<ResolvedDurableObjectTarget> {
  const service = await rpc.call<ResolvedWorkspaceService>(
    "main",
    "workers.resolveService",
    [query, objectKey ?? null],
    options
  );
  if (service.kind !== "durable-object") {
    throw new Error(`Service '${query}' does not expose a Durable Object RPC target`);
  }
  return service;
}

export function createDurableObjectServiceClient(
  rpc: RpcCallerLike,
  query: string,
  objectKey?: string | null
): DurableObjectServiceClient {
  let resolvedTarget: ResolvedDurableObjectTarget | null = null;
  let resolvedPromise: Promise<ResolvedDurableObjectTarget> | null = null;
  const resolve = (options?: RpcCallOptionsLike) => {
    if (resolvedTarget) return Promise.resolve(resolvedTarget);
    if (options) {
      // A caller-owned signal must never own the shared resolution flight: its
      // cancellation would otherwise reject unrelated concurrent callers.
      return resolveDurableObjectService(rpc, query, objectKey, options).then((target) => {
        resolvedTarget = target;
        return target;
      });
    }
    resolvedPromise ??= resolveDurableObjectService(rpc, query, objectKey)
      .then((target) => {
        resolvedTarget = target;
        return target;
      })
      .catch((error: unknown) => {
        resolvedPromise = null;
        throw error;
      });
    return resolvedPromise;
  };
  return {
    resolve,
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      const service = await resolve();
      return rpc.call<T>(service.targetId, method, args);
    },
    async callWithOptions<T = unknown>(
      method: string,
      args: unknown[],
      options: RpcCallOptionsLike
    ): Promise<T> {
      const service = await resolve(options);
      return rpc.call<T>(service.targetId, method, args, options);
    },
  };
}

export function createGadServiceClient(rpc: RpcCallerLike): DurableObjectServiceClient {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL);
}
