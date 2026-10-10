# @vibestudio/rpc

`@vibestudio/rpc` is Vibestudio's unified RPC SDK. It provides one client surface for in-process, WebSocket, HTTP, Electron IPC, worker, app, shell, extension, and server call paths.

```ts
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import { z } from "zod";
import { createRpcClient } from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";

const rpc = createRpcClient({
  selfId: "panel:abc",
  callerKind: "panel",
  transport: wsClientTransport({
    selfId: "panel:abc",
    getWsUrl: () => "ws://127.0.0.1:3000/rpc",
    adapter,
  }),
});

rpc.expose("notes.create", async (req) => {
  const [title] = req.args as [string];
  return { title, owner: req.caller.callerId };
});

const notesMethods = createRpcMethods("notes", {
  create: {
    args: z.tuple([z.string()]),
    returns: z.object({ title: z.string(), owner: z.string() }),
  },
});
const note = await rpc.call("main", notesMethods.create, ["hello"]);
const response = await rpc.stream("main", mainRpcMethods["credentials.proxyFetch"], [
  { url: "https://example.com" },
]);
const unsubscribe = rpc.on("notes.changed", (event) => {
  console.log(event.caller.callerId, event.payload);
});

await rpc.peer("panel:other").emit("notes.changed", { id: "n1" });
```

## Core Concepts

- `createRpcClient(config)` is the only high-level RPC API.
- `RpcEnvelope` carries target, delivery caller, and provenance for every message.
- `req.caller` is the gateway-verified immediate caller in exposed handlers.
- `req.origin` is the first caller in the provenance chain.
- `rpc.call(target, method, args)` performs JSON request/response calls.
- `rpc.stream(target, method, args)` returns a `Response` with a real `ReadableStream` body.
- `rpc.expose(method, handler)` registers handlers with full request context.
- `rpc.exposeStreaming(method, handler)` registers streaming handlers.
- `rpc.on(event, handler)` receives `RpcEventContext` with caller, origin, event, and payload.
- `rpc.peer(id)` returns target-scoped typed call, emit, and event helpers.

## Transports

Transport implementations live under `@vibestudio/rpc/transports/*`:

- `wsClientTransport` for authenticated WebSocket clients with reconnect/recovery.
- `httpClientTransport` for HTTP RPC calls.
- `electronIpcTransport` for Electron IPC boundaries.
- `inProcessTransport` / `createInProcessNetwork` for tests and local composition.
- `composeTransports` for routing across multiple transports.

Protocol helpers live under `@vibestudio/rpc/protocol/*`.

Public calls take receiver-owned `RpcMethod` descriptors. Schemas validate arguments and results, and TypeScript derives both types from the same contract. Dynamic selectors validate against the canonical receiver and return `unknown`; there is no caller-selected result generic. Raw wire clients live in the internal entry point for transport infrastructure.

Failures cross unary, streaming, upload, and shutdown boundaries as one structured graph, preserving aggregate members, causes, shared references, codes, data, and diagnostics. Use `formatRpcFailure(error)` at display boundaries to show the underlying failures.

Internal host bridge frames and phone setup stream events use `serializeRpcFailure` and `deserializeRpcFailure` too. Cancellation waits for the host operation to settle; a cleanup failure remains visible alongside the caller's cancellation reason. Standard CDP error messages use `formatRpcFailure` at their text-only protocol boundary.
