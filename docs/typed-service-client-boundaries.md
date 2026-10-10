# Typed RPC Contracts

Public `RpcCaller.call` and `RpcCaller.stream` calls take an `RpcMethod` descriptor.
For host calls, import the descriptor from
`@vibestudio/service-schemas/mainRpc`; for receiver-owned methods, import the
receiver's neutral RPC contract. The canonical method table is the source of truth
for each public receiver contract.

```ts
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";

const result = await rpc.call("main", mainRpcMethods["blobstore.getText"], [digest]);
```

`RpcWireClient` and string-based method dispatch belong to internal transport
infrastructure. Typed service clients and domain wrappers should sit above that
transport and keep application code on receiver-owned descriptors. Do not use raw
wire method names in public examples or add string-dispatch exceptions to the
migration guard.

Wire calls return `unknown`; callers cannot select a result type with a generic
argument. Schema-backed descriptors decode arguments and results at the receiver
boundary. TypeScript receiver descriptors share the receiver's declared signature
without allowing the caller to invent one.

The CLI's `RpcClient.mainCall` binds the workspace main receiver's canonical
contracts. Account-wide hub operations use the hub contract over the hub
connection; sharing the address `main` does not make their method sets identical.
Eval's execution and retained runtime peers use the same `createRpcPeer` contract
implementation as the ordinary RPC client. `withContract` always binds the supplied
receiver descriptors.
