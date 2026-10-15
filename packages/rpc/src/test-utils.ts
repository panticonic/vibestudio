import type { RpcCaller, RpcReadableCaller } from "./types.js";
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
  streamReadable?: import("./internal-types.js").RpcWireClient["streamReadable"];
};
type SchemaMock<Call, Stream, Readable> = RpcCaller & {
  streamReadable: RpcReadableCaller["streamReadable"] & MockProperties<NonNullable<Readable>>;
  call: RpcCaller["call"] & MockProperties<Call>;
  stream: RpcCaller["stream"] & MockProperties<NonNullable<Stream>>;
};
export function schemaRpcMock<
  Call extends MockWire["call"],
  Stream extends MockWire["stream"] = undefined,
  Readable extends MockWire["streamReadable"] = undefined,
>(wire: {
  call: Call;
  stream?: Stream;
  streamReadable?: Readable;
}): SchemaMock<Call, Stream, Readable> {
  const caller = schemaRpcCaller({
    streamReadable:
      wire.streamReadable?.bind(wire) ??
      (async () => {
        throw new Error("Unexpected readable streaming RPC");
      }),
    call: wire.call.bind(wire),
    stream:
      wire.stream?.bind(wire) ??
      (async () => {
        throw new Error("Unexpected streaming RPC");
      }),
  });
  for (const key of ["call", "stream", "streamReadable"] as const) {
    const mock = wire[key];
    if (!mock) continue;
    const descriptors = Object.getOwnPropertyDescriptors(mock);
    for (const intrinsic of ["length", "name", "prototype", "caller", "arguments"])
      delete descriptors[intrinsic];
    Object.defineProperties(caller[key], descriptors);
  }
  return caller as SchemaMock<Call, Stream, Readable>;
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
    streamReadable:
      wire.streamReadable?.bind(wire) ??
      (async () => {
        throw new Error("Unexpected readable streaming RPC");
      }),
    expose() {},
    exposeAll() {},
    exposeStreaming() {},
    emit: async () => {},
    on: () => () => {},
    peer: (target, options) => createRpcPeer(client, target, options),
    status: () => "connected",
    ready: async () => {},
    onStatusChange: () => () => {},
    onRecovery: () => () => {},
  };
  return schemaRpcClient(registerRpcWireClient(client));
}
