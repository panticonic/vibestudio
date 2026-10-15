import type { RpcClient, RpcCaller, RpcReadableCaller } from "./types.js";
import type { RpcWireCaller, RpcWireClient } from "./internal-types.js";
import { assertRpcMethodDescriptor } from "./methodDescriptor.js";
import { throwIfAborted } from "./abort.js";

type WireDispatcher = {
  call(
    target: string,
    method: string,
    args: unknown[],
    options?: import("./types.js").RpcCallOptions
  ): Promise<unknown>;
  stream: RpcWireCaller["stream"];
};
type ReadableWire = Pick<RpcWireClient, "streamReadable">;
type UnaryWire = Pick<WireDispatcher, "call">;
type WireProjection = (WireDispatcher & ReadableWire) | ReadableWire | UnaryWire;
function isFullWire(wire: WireProjection): wire is WireDispatcher & ReadableWire {
  return "call" in wire && "stream" in wire && "streamReadable" in wire;
}
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

const schemaClients = new WeakMap<RpcWireClient, RpcClient>();
const wireClients = new WeakMap<object, RpcWireClient>();
const wireCallers = new WeakMap<object, WireProjection>();

/** Register an owned infrastructure client when its transport is constructed. */
export function registerRpcWireClient<Wire extends RpcWireClient>(
  wire: Wire,
  own?: RpcOperationOwner
): Wire {
  if (own) {
    registerRpcOperationOwner(wire, own);
    registerRpcOperationOwner(wire.stream, own);
    registerRpcOperationOwner(wire.streamReadable, own);
  }
  wireClients.set(wire, wire);
  wireCallers.set(wire, wire);
  wireCallers.set(wire.stream, wire);
  wireCallers.set(wire.streamReadable, wire);
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
  if (!wire || !("call" in wire)) throw new Error("RPC caller has no registered transport owner");
  return wire;
}

/** A streaming caller owns its dispatcher without requiring a full event client. */
export function wireStreamFor(caller: Pick<RpcCaller, "stream">): Pick<WireDispatcher, "stream"> {
  const wire = wireCallers.get(caller) ?? wireCallers.get(caller.stream);
  if (!wire || !isFullWire(wire)) throw new Error("RPC stream has no registered transport owner");
  return wire;
}

/** Attach the receiver contract at the boundary of a wire caller. */
export function schemaRpcCaller(wire: WireDispatcher & ReadableWire): RpcCaller;
export function schemaRpcCaller(wire: UnaryWire): Pick<RpcCaller, "call">;
export function schemaRpcCaller(wire: ReadableWire): RpcReadableCaller;
export function schemaRpcCaller(wire: WireProjection): Partial<RpcCaller> {
  const caller: Partial<RpcCaller> = {};
  if ("call" in wire) {
    caller.call = (target, method, args, options) =>
      ownRpcOperation(wire, async () => {
        throwIfAborted(options?.signal);
        assertRpcMethodDescriptor(method, "call");
        return method.invoke(args, (parsedArgs) => {
          throwIfAborted(options?.signal);
          return wire.call(target, method.name, parsedArgs, options);
        });
      });
  }
  if (isFullWire(wire)) {
    caller.stream = schemaRpcStream(
      (target, method, args, options) => wire.stream(target, method, args, options),
      wire
    );
  }
  if ("streamReadable" in wire) {
    caller.streamReadable = (target, method, args, options) =>
      ownRpcOperation(wire, async () => {
        throwIfAborted(options?.signal);
        assertRpcMethodDescriptor(method, "streamReadable");
        const parsedArgs = await method.parseArgs(args);
        throwIfAborted(options?.signal);
        return wire.streamReadable(target, method.name, parsedArgs, options);
      });
  }
  wireCallers.set(caller, wire);
  for (const method of Object.values(caller)) wireCallers.set(method, wire);
  return caller;
}

/** One schema facade over the existing transport client and its owned lifecycle. */
export function schemaRpcClient(wire: RpcWireClient): RpcClient {
  const existing = schemaClients.get(wire);
  if (existing) return existing;
  const client: RpcClient = {
    ...wire,
    ...schemaRpcCaller(wire),
    createView: (options) => schemaRpcClient(wire.createView(options)),
  };
  registerRpcWireClient(wire);
  schemaClients.set(wire, client);
  wireClients.set(client, wire);
  wireCallers.set(client, wire);
  wireCallers.set(client.stream, wire);
  wireCallers.set(client.streamReadable, wire);
  return client;
}

/** Streaming schema boundary for transports that only provide response streams. */
export function schemaRpcStream(
  stream: RpcWireCaller["stream"],
  owner: object = stream
): RpcCaller["stream"] {
  return (target, method, args, options) =>
    ownRpcOperation(owner, async () => {
      throwIfAborted(options?.signal);
      assertRpcMethodDescriptor(method, "stream");
      const parsedArgs = await method.parseArgs(args);
      throwIfAborted(options?.signal);
      return stream(target, method.name, parsedArgs, options);
    });
}
