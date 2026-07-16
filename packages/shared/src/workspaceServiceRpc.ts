export interface RpcCallerLike {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
}

export interface DORefParam {
  source: string;
  className: string;
  objectKey: string;
}

export type ResolvedWorkspaceService = {
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
  resolve(): Promise<ResolvedDurableObjectTarget>;
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
}

export const GAD_WORKSPACE_SERVICE_PROTOCOL = "vibestudio.gad.workspace.v1";

/** The product-sealed semantic VCS protocol implemented by the control plane. */
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
  objectKey?: string | null
): Promise<ResolvedDurableObjectTarget> {
  const service = await rpc.call<ResolvedWorkspaceService>("main", "workers.resolveService", [
    query,
    objectKey ?? null,
  ]);
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
  let resolvedPromise: Promise<ResolvedDurableObjectTarget> | null = null;
  const resolve = () => {
    resolvedPromise ??= resolveDurableObjectService(rpc, query, objectKey).catch(
      (error: unknown) => {
        resolvedPromise = null;
        throw error;
      }
    );
    return resolvedPromise;
  };
  return {
    resolve,
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      const service = await resolve();
      return rpc.call<T>(service.targetId, method, args);
    },
  };
}

export function createGadServiceClient(rpc: RpcCallerLike): DurableObjectServiceClient {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL);
}
