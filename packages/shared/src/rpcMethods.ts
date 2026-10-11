import type { RpcMethod } from "@vibestudio/rpc";
import {
  callTypedServiceMethod,
  parseServiceMethodArgs,
  type MethodFn,
  type ServiceMethodSchemas,
} from "./typedServiceClient.js";

export type RpcMethods<M extends ServiceMethodSchemas> = {
  readonly [K in keyof M]: RpcMethod<
    Parameters<MethodFn<M[K]>>,
    Awaited<ReturnType<MethodFn<M[K]>>>
  >;
};

function freezeRpcMethodTable<M extends object>(methods: M): Readonly<M> {
  for (const method of Object.values(methods)) Object.freeze(method);
  return Object.freeze(methods);
}

/** Derive transport method descriptors from the same schemas as the receiver. */
export function createRpcMethods<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
  namespace = service
): RpcMethods<M> {
  return createLazyRpcMethods(
    service,
    Object.keys(methods) as (keyof M & string)[],
    async () => methods,
    namespace
  );
}

/** Defer schema loading while retaining the complete static receiver contract. */
export function createLazyRpcMethods<M extends ServiceMethodSchemas>(
  service: string,
  names: readonly (keyof NoInfer<M> & string)[],
  load: () => Promise<M>,
  namespace = service
): RpcMethods<M> {
  let loaded: Promise<M> | undefined;
  const methods = () => (loaded ??= load());
  const descriptors = Object.fromEntries(
    names.map((method) => [
      method,
      {
        name: namespace ? `${namespace}.${method}` : method,
        async invoke(args: unknown[], dispatch: (args: unknown[]) => Promise<unknown>) {
          return callTypedServiceMethod(
            service,
            await methods(),
            (_service, _method, parsedArgs) => dispatch(parsedArgs),
            method,
            args
          );
        },
        async parseArgs(args: unknown[]) {
          const definition = (await methods())[method];
          if (!definition) throw new Error(`Service "${service}" has no method "${method}"`);
          return parseServiceMethodArgs(service, method, definition, args);
        },
      },
    ])
  ) as RpcMethods<M>;
  return freezeRpcMethodTable(descriptors);
}

/** Decorated TypeScript receivers own their method signatures directly. Export
 * their descriptors from the receiver package so clients share that contract
 * without importing the receiver's runtime implementation. */
export function createReceiverRpcMethods<
  T extends { [K in keyof T]: (...args: never[]) => unknown },
>(
  names: readonly (keyof NoInfer<T> & string)[],
  namespace = ""
): { readonly [K in keyof T]: RpcMethod<Parameters<T[K]>, Awaited<ReturnType<T[K]>>> } {
  const methods = Object.fromEntries(
    names.map((method) => [
      method,
      {
        name: namespace ? `${namespace}.${method}` : method,
        async invoke(args: unknown[], dispatch: (args: unknown[]) => Promise<unknown>) {
          return dispatch(args);
        },
        async parseArgs(args: unknown[]) {
          return args;
        },
      },
    ])
  ) as { readonly [K in keyof T]: RpcMethod<Parameters<T[K]>, Awaited<ReturnType<T[K]>>> };
  return freezeRpcMethodTable(methods);
}

export type RpcMethodMap = Record<string, RpcMethod<unknown[], unknown>>;
export type RpcMethodArgs<M> = M extends RpcMethod<infer A, unknown> ? A : never;
export type RpcMethodResult<M> = M extends RpcMethod<unknown[], infer R> ? R : never;

/** Bind a receiver descriptor table to one address while retaining method/tuple correlation. */
export function createRpcMethodCaller<M extends RpcMethodMap>(
  rpc: Pick<import("@vibestudio/rpc").RpcCaller, "call">,
  targetId: string,
  methods: M
): <K extends keyof M & string>(
  method: K,
  args: RpcMethodArgs<M[K]>,
  options?: import("@vibestudio/rpc").RpcCallOptions
) => Promise<RpcMethodResult<M[K]>> {
  return (method, args, options) =>
    rpc.call(targetId, methods[method]!, args, options) as Promise<
      RpcMethodResult<M[typeof method]>
    >;
}

/** Route an owned extension contract through the extension host's invocation method. */
export function createExtensionRpcMethods<M extends RpcMethodMap>(
  extensionId: string,
  methods: M
): Readonly<M> {
  const wrapped = Object.fromEntries(
    Object.entries(methods).map(([key, method]) => [
      key,
      {
        name: "extensions.invoke",
        invoke(args: unknown[], dispatch: (args: unknown[]) => Promise<unknown>) {
          return method.invoke(args, (parsed) => dispatch([extensionId, method.name, parsed]));
        },
        async parseArgs(args: unknown[]) {
          return [extensionId, method.name, await method.parseArgs(args)];
        },
      },
    ])
  ) as M;
  return freezeRpcMethodTable(wrapped);
}
