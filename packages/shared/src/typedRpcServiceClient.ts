import type { RpcCallOptions, RpcCaller } from "@vibestudio/rpc";
import { createRpcMethods, createLazyRpcMethods, type RpcMethods } from "./rpcMethods.js";
import {
  createServiceClientSurface,
  type ServiceMethodSchemas,
  type TypedServiceClient,
} from "./typedServiceClient.js";

/** Bind a canonical receiver contract to its RPC address. Wire dispatch stays
 * behind the validated client; callers cannot substitute arguments or results. */
export function createTypedRpcServiceClient<M extends ServiceMethodSchemas>(
  rpc: Pick<RpcCaller, "call">,
  address: { targetId: string; namespace?: string },
  methods: M,
  options?: RpcCallOptions
): TypedServiceClient<M> {
  const service = address.namespace ?? address.targetId;
  const descriptors = createRpcMethods(
    service,
    methods as ServiceMethodSchemas,
    address.namespace ?? ""
  );
  return createServiceClientSurface<M>(service, Object.keys(methods), (method, args) =>
    rpc.call(address.targetId, descriptors[method]!, args, options)
  );
}

/** Load canonical contracts on demand without ambient package registration. */
export function createLazyTypedRpcServiceClient<M extends ServiceMethodSchemas>(
  rpc: Pick<RpcCaller, "call">,
  address: { targetId: string; namespace?: string },
  names: readonly (keyof M & string)[],
  load: () => Promise<M>,
  options?: RpcCallOptions
): TypedServiceClient<M> {
  const service = address.namespace ?? address.targetId;
  const descriptors = createLazyRpcMethods(
    service,
    names,
    load,
    address.namespace ?? ""
  ) as RpcMethods<ServiceMethodSchemas>;
  return createServiceClientSurface<M>(service, names, (method, args) =>
    rpc.call(address.targetId, descriptors[method]!, args, options)
  );
}
