# RPC And Userland Services

Vibestudio has a small platform RPC layer and a userland-service pattern for
stateful protocols. This is intentional: they solve different problems and are
scoped to non-overlapping responsibilities. This doc fixes the boundary in
writing so future contributors don't route stateful protocols through the
platform layer.

## TL;DR

| System | Shape | Use for |
|---|---|---|
| `@vibestudio/rpc` | Stateless point-to-point method calls + HTTP-Response streaming | Service calls (`credentials.fetch`, `fs.read`, `blobstore.putText`), URL-bound credential proxying, model SDK fetches |
| Userland services | Workspace-declared workers and Durable Objects resolved by protocol | Stateful channels, durable conversation state, multi-participant flows, and any workspace-owned protocol |

If you're routing a single call/response, possibly with a streaming body,
between two endpoints, use rpc. If you're building anything with subscribers,
replay, multiple participants, or durable service state, declare a userland
service and resolve it by protocol.

## Why both exist

The systems evolved for different concerns and meet different invariants:

**rpc is fetch-shaped.** A call has one caller, one target, and returns
a single value or a single `Response` (with optional `ReadableStream`
body). Cancellation is one `AbortSignal`. Errors propagate to one
caller. The streaming primitive added in
`@vibestudio/rpc/types#StreamingMethodHandler` is a sink-based
HEAD→DATA*→END frame stream, mirroring HTTP chunked transfer.

**userland services can be conversation-shaped.** A call may have multiple
subscribers observing it; chat needs missed-context replay if a panel
disconnects mid-conversation; participants have presence and metadata
beyond `selfId`; method *results* can carry structured binary
attachments (an image attachment is data + mimeType + filename, not
opaque bytes); the wire protocol has aggregation hooks for
content-block streaming. `MethodCallHandle.stream:
AsyncIterable<MethodResultChunk>` is the streaming primitive — it
yields *typed structured chunks* rather than raw bytes, because chat
messages are structured.

Trying to fit those needs into rpc would either bloat rpc's surface
(participants, missed-context, attachment shapes) or force chat features
to layer them on top awkwardly. The reverse — fitting rpc's needs into
a stateful service protocol — would force every credentials fetch through
unneeded service machinery and lose the fetch-shaped semantics that make
Response-based APIs work transparently.

## Concretely shared substrate

Some bits ARE shared and should stay shared:

- **`@vibestudio/rpc` `RpcCaller` interface** — the credentials
  client takes a `RpcCaller` (anything with `call` + `stream`).
  Runtime clients and service-derived adapters can satisfy it.
- **`@vibestudio/rpc/protocol/streamCodec`** — the binary frame
  codec (HEAD/DATA/END/ERROR). Used by rpc for HTTP `/rpc/stream` and
  by `RpcClient.stream` over IPC/WS. Stateful service protocols
  can choose their own chunk shape.

## What does NOT need to change

- **Duplicate base64 helpers** should live in `@vibestudio/rpc/protocol/streamCodec`
  or local transport internals only when the dependency boundary requires it.

## When unification becomes worth considering

If any of these become true, revisit:

1. A new feature needs *both* shapes simultaneously (e.g. a tool that
   streams bytes into a chat content block).
2. We add a third subsystem with overlapping concerns (e.g. a
   GraphQL-shaped query layer).
3. The cognitive overhead of "which system?" measurably slows
   development. (Hasn't, yet.)

Until then: keep the boundary clean, route new work to the right side,
and link this doc from any commit that touches the question.

## Decision-tree quick reference

```
Are you routing point-to-point with a single caller/target?
├─ Yes
│  ├─ Need a streaming response body? → rpc.stream
│  ├─ Need a one-shot value?          → rpc.call
│  └─ Need to expose a method?        → rpc.expose / exposeStreaming
└─ No (one-to-many, or stateful conversation)
   ├─ Declare a workspace service protocol in vibestudio.yml
   ├─ Resolve it with workers.resolveService
   └─ Call the returned worker or Durable Object target
```

## Identity and authority across relays

Transport caller kinds (`panel`, `do`, `agent`, `extension`, and so on) route a
message; they are not authorization identities. Every ingress produces a
host-attested authority grant containing the principals that actually apply:
the exact host, authenticated user/device, exact code artifact, and bound
entity. Relays preserve that grant and add provenance; they do not convert it
into a trusted generic `do` or `server` identity.

Services and `@rpc` methods declare complete principal requirements. Sensitive
operations additionally use the canonical resource evaluator for capabilities,
relationships, revocation, and exact execution state. A method's declaration
therefore answers “which authenticated principal classes can satisfy this
method?” while its resource check answers “may these exact principals perform
this operation on this exact object now?”

Eval is an ergonomic execution surface, not an authorization escape hatch. An
agent's EvalDO retains the agent entity, user, context, and evaluated code
identity, so direct service calls and calls composed through eval reach the same
decision. Add direct CLI adapters only for ergonomics or streaming—not to
widen authority—and test both paths against the same resource policy.
