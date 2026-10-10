import { createRpcMethods, type RpcMethodMap } from "@vibestudio/shared/rpcMethods";
import { mainRpcMethods } from "../mainRpc.js";
import { mergeRpcOptions } from "@vibestudio/rpc/internal";
import { gadWireMethods } from "../workspaceSource.js";
import {
  omitTrailingUndefined,
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  type RpcCallerLike,
  type RpcCallOptionsLike,
  type ResolvedDurableObjectTarget,
  type DurableObjectServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
export async function resolveDurableObjectService(
  rpc: RpcCallerLike,
  query: string,
  objectKey?: string | null,
  options?: RpcCallOptionsLike
): Promise<ResolvedDurableObjectTarget> {
  const args: [string, string | null] = [query, objectKey ?? null];
  const service = options
    ? await rpc.call("main", mainRpcMethods["workers.resolveService"], args, options)
    : await rpc.call("main", mainRpcMethods["workers.resolveService"], args);
  if (service.kind !== "durable-object") {
    throw new Error(`Service '${query}' does not expose a Durable Object RPC target`);
  }
  return service;
}

export function createDurableObjectServiceClient<M extends RpcMethodMap>(
  rpc: RpcCallerLike,
  query: string,
  descriptors: M,
  objectKey?: string | null,
  defaultOptions?: Pick<RpcCallOptionsLike, "destination">
): DurableObjectServiceClient<M> {
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
    async call(method: keyof M & string, ...args: unknown[]) {
      const service = await resolve();
      return rpc.call(
        service.targetId,
        descriptors[method]! as import("@vibestudio/rpc").RpcMethod<unknown[], unknown>,
        omitTrailingUndefined(args),
        optionsFor()
      );
    },
    async callWithOptions(method: keyof M & string, args: unknown[], options: RpcCallOptionsLike) {
      const combined = optionsFor(options)!;
      const service = await resolve(combined);
      return rpc.call(
        service.targetId,
        descriptors[method]! as import("@vibestudio/rpc").RpcMethod<unknown[], unknown>,
        omitTrailingUndefined(args),
        combined
      );
    },
  } as DurableObjectServiceClient<M>;
}

export const gadRpcMethods = createRpcMethods("gad", gadWireMethods, "");
export function createGadServiceClient(
  rpc: RpcCallerLike
): DurableObjectServiceClient<typeof gadRpcMethods> {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL, gadRpcMethods);
}
