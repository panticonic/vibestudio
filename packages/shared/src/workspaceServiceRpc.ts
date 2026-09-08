import type { RpcCallOptions } from "@vibestudio/rpc";
import { mergeRpcOptions } from "@vibestudio/rpc/internal";

export interface RpcCallerLike {
  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptionsLike
  ): Promise<T>;
}

export type RpcCallOptionsLike = Pick<RpcCallOptions, "signal" | "timeoutMs" | "destination">;

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

/** JSON arrays turn `undefined` into `null`, which changes an omitted optional
 * RPC argument into an explicit (and usually invalid) value. Preserve the
 * JavaScript call contract by removing only omitted trailing arguments before
 * crossing the wire; interior positions remain exact. */
export function omitTrailingUndefined(args: unknown[]): unknown[] {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length -= 1;
  return length === args.length ? args : args.slice(0, length);
}

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
  const args = [query, objectKey ?? null];
  const service = options
    ? await rpc.call<ResolvedWorkspaceService>("main", "workers.resolveService", args, options)
    : await rpc.call<ResolvedWorkspaceService>("main", "workers.resolveService", args);
  if (service.kind !== "durable-object") {
    throw new Error(`Service '${query}' does not expose a Durable Object RPC target`);
  }
  return service;
}

export function createDurableObjectServiceClient(
  rpc: RpcCallerLike,
  query: string,
  objectKey?: string | null,
  defaultOptions?: Pick<RpcCallOptionsLike, "destination">
): DurableObjectServiceClient {
  const resolvedTargets = new Map<string, ResolvedDurableObjectTarget>();
  const resolvedPromises = new Map<string, Promise<ResolvedDurableObjectTarget>>();
  const optionsFor = (options?: RpcCallOptionsLike): RpcCallOptionsLike | undefined => {
    if (!defaultOptions) return options;
    if (!options) return defaultOptions;
    return mergeRpcOptions(defaultOptions, options);
  };
  const destinationKey = (options?: RpcCallOptionsLike): string =>
    JSON.stringify(options?.destination ?? null);
  const resolve = (options?: RpcCallOptionsLike) => {
    const combined = optionsFor(options);
    const key = destinationKey(combined);
    const resolvedTarget = resolvedTargets.get(key);
    if (resolvedTarget) return Promise.resolve(resolvedTarget);
    if (combined?.signal || combined?.timeoutMs !== undefined) {
      // A caller-owned signal must never own the shared resolution flight: its
      // cancellation would otherwise reject unrelated concurrent callers.
      return resolveDurableObjectService(rpc, query, objectKey, combined).then((target) => {
        resolvedTargets.set(key, target);
        return target;
      });
    }
    const resolvedPromise = resolvedPromises.get(key);
    if (resolvedPromise) return resolvedPromise;
    const pending = resolveDurableObjectService(rpc, query, objectKey, combined)
      .then((target) => {
        resolvedTargets.set(key, target);
        return target;
      })
      .finally(() => {
        if (resolvedPromises.get(key) === pending) resolvedPromises.delete(key);
      });
    resolvedPromises.set(key, pending);
    return pending;
  };
  return {
    resolve,
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      const service = await resolve();
      const options = optionsFor();
      return options
        ? rpc.call<T>(service.targetId, method, omitTrailingUndefined(args), options)
        : rpc.call<T>(service.targetId, method, omitTrailingUndefined(args));
    },
    async callWithOptions<T = unknown>(
      method: string,
      args: unknown[],
      options: RpcCallOptionsLike
    ): Promise<T> {
      const combined = optionsFor(options)!;
      const service = await resolve(combined);
      return rpc.call<T>(service.targetId, method, omitTrailingUndefined(args), combined);
    },
  };
}

export function createGadServiceClient(rpc: RpcCallerLike): DurableObjectServiceClient {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL);
}
