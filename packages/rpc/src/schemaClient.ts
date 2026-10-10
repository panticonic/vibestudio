import type { RpcClient, RpcCaller } from "./types.js";
import type { RpcWireCaller, RpcWireClient } from "./internal-types.js";

type WireDispatcher = {
  call(
    target: string,
    method: string,
    args: unknown[],
    options?: import("./types.js").RpcCallOptions
  ): Promise<unknown>;
  stream: RpcWireCaller["stream"];
};
type RpcOperationOwner = <T>(operation: () => Promise<T>) => Promise<T>;
const operationOwners = new WeakMap<object, RpcOperationOwner>();

/** Admit schema preparation and dispatch as one synchronous lifecycle operation. */
export function ownRpcOperation<T>(owner: object, operation: () => Promise<T>): Promise<T> {
  const own = operationOwners.get(owner);
  return own ? own(operation) : operation();
}

export function registerRpcOperationOwner<T extends object>(owner: T, own: RpcOperationOwner): T {
  operationOwners.set(owner, own);
  return owner;
}

const wireClients = new WeakMap<object, RpcWireClient>();
const wireCallers = new WeakMap<object, WireDispatcher>();

/** Register an owned infrastructure client when its transport is constructed. */
export function registerRpcWireClient<Wire extends RpcWireClient>(wire: Wire, own?: RpcOperationOwner): Wire {
  if (own) {
    registerRpcOperationOwner(wire, own);
    registerRpcOperationOwner(wire.stream, own);
  }
  wireClients.set(wire, wire);
  wireCallers.set(wire, wire);
  wireCallers.set(wire.stream, wire);
  return wire;
}

/** Internal access to the transport owned by a constructed RPC client. */
export function wireClientFor(client: RpcClient | RpcWireClient): RpcWireClient {
  const wire = wireClients.get(client);
  if (!wire) throw new Error("RPC client has no registered transport owner");
  return wire;
}
export function wireCallerFor(
  caller: Pick<RpcCaller, "call"> | Pick<RpcWireCaller, "call">
): Pick<WireDispatcher, "call"> {
  const wire = wireCallers.get(caller) ?? wireCallers.get(caller.call);
  if (!wire) throw new Error("RPC caller has no registered transport owner");
  return wire;
}

/** A streaming caller owns its dispatcher without requiring a full event client. */
export function wireStreamFor(caller: Pick<RpcCaller, "stream">): Pick<WireDispatcher, "stream"> {
  const wire = wireCallers.get(caller) ?? wireCallers.get(caller.stream);
  if (!wire) throw new Error("RPC stream has no registered transport owner");
  return wire;
}

/** Attach the receiver contract at the boundary of a wire caller. */
export function schemaRpcCaller(wire: WireDispatcher): RpcCaller {
  const caller: RpcCaller = {
    call: (target, method, args, options) => ownRpcOperation(wire, async () => {
      options?.signal?.throwIfAborted();
      return method.invoke(args, (parsedArgs) => {
        options?.signal?.throwIfAborted();
        return wire.call(target, method.name, parsedArgs, options);
      });
    }),
    stream: schemaRpcStream((target, method, args, options) => wire.stream(target, method, args, options), wire),
  };
  wireCallers.set(caller, wire);
  wireCallers.set(caller.call, wire);
  wireCallers.set(caller.stream, wire);
  return caller;
}

/** One schema facade over the existing transport client and its owned lifecycle. */
export function schemaRpcClient(wire: RpcWireClient): RpcClient {
  const client: RpcClient = {
    ...wire,
    ...schemaRpcCaller(wire),
    streamReadable: (target, method, args, options) => ownRpcOperation(wire, async () => {
      options?.signal?.throwIfAborted();
      const parsedArgs = await method.parseArgs(args);
      options?.signal?.throwIfAborted();
      return wire.streamReadable(target, method.name, parsedArgs, options);
    }),
  };
  registerRpcWireClient(wire);
  wireClients.set(client, wire);
  wireCallers.set(client, wire);
  wireCallers.set(client.stream, wire);
  return client;
}

/** Streaming schema boundary for transports that only provide response streams. */
export function schemaRpcStream(stream: RpcWireCaller["stream"], owner: object = stream): RpcCaller["stream"] {
  return (target, method, args, options) => ownRpcOperation(owner, async () => {
    options?.signal?.throwIfAborted();
    const parsedArgs = await method.parseArgs(args);
    options?.signal?.throwIfAborted();
    return stream(target, method.name, parsedArgs, options);
  });
}
