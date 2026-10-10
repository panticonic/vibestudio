import type { RpcCaller } from "./types.js";
import type { RpcWireCaller } from "./internal-types.js";
import { createRpcPeer } from "./client-core.js";
import { schemaRpcClient, registerRpcWireClient, schemaRpcCaller } from "./schemaClient.js";

type MockProperties<F> = Pick<F, keyof F>;
/** Application tests use the real contract boundary while retaining wire-spy diagnostics. */
type MockWire = {
  call: (
    target: string,
    method: string,
    args: unknown[],
    options?: import("./types.js").RpcCallOptions
  ) => Promise<unknown>;
  stream?: RpcWireCaller["stream"];
};
type SchemaMock<Call, Stream> = RpcCaller & {
  call: RpcCaller["call"] & MockProperties<Call>;
  stream: RpcCaller["stream"] & MockProperties<NonNullable<Stream>>;
};
export function schemaRpcMock<
  Call extends MockWire["call"],
  Stream extends MockWire["stream"] = undefined,
>(wire: { call: Call; stream?: Stream }): SchemaMock<Call, Stream> {
  const caller = schemaRpcCaller({
    call: wire.call.bind(wire),
    stream:
      wire.stream?.bind(wire) ??
      (async () => {
        throw new Error("Unexpected streaming RPC");
      }),
  });
  for (const key of ["call", "stream"] as const) {
    const mock = wire[key];
    if (!mock) continue;
    const descriptors = Object.getOwnPropertyDescriptors(mock);
    for (const intrinsic of ["length", "name", "prototype", "caller", "arguments"])
      delete descriptors[intrinsic];
    Object.defineProperties(caller[key], descriptors);
  }
  return caller as SchemaMock<Call, Stream>;
}

/** A full client fixture retains the same registered owner through contextual views. */
export function schemaRpcClientMock(
  wire: MockWire,
  selfId: string
): import("./types.js").RpcClient {
  const client: import("./internal-types.js").RpcWireClient = {
    selfId,
    call: wire.call.bind(wire),
    stream:
      wire.stream?.bind(wire) ??
      (async () => {
        throw new Error("Unexpected streaming RPC");
      }),
    streamReadable: async () => {
      throw new Error("Unexpected readable streaming RPC");
    },
    expose() {},
    exposeAll() {},
    exposeStreaming() {},
    emit: async () => {},
    on: () => () => {},
    peer: (target, options) => createRpcPeer(client, target, options),
    status: () => "connected",
    ready: async () => {},
    onStatusChange: () => () => {},
  };
  return schemaRpcClient(registerRpcWireClient(client));
}
