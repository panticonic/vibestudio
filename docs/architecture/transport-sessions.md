# Transport Sessions And Recovery

Vibestudio has two identity layers on every RPC transport:

- `callerId` is durable application identity. Examples: `shell`, a panel ID, a
  worker ID. A caller ID may have zero, one, or many live connections.
- `connectionId` is ephemeral transport identity. It names one authenticated
  socket/session instance and must never be persisted.

Code that stores state across process restarts may store `callerId`, panel IDs,
tokens, and parent/owner relationships. It must not store `connectionId`.

## Hub Control And Workspace Reach

A paired device has one durable identity but two distinct WebRTC reaches:

- The **control reach** terminates at the server hub. Pairing invite rooms and
  durable device control rooms live here. The client keeps this reach stable
  while it switches workspaces.
- The **workspace reach** terminates directly at one workspace child. Children
  own only device and user rooms for workspace RPC; they do not redeem pairing
  invites or host a second control plane.

Redeeming an invite atomically turns that same hub-owned invite room into the
new device's durable control room in the identity database. The authentication
result returns the new device credential and a one-time
`PairingContext { workspaceId }`. That context is the exact target selected by
the invite issuer; it is routing input, not authorship, authorization, or an
ambient active-workspace hint.

The client then calls `hubControl.routeWorkspace({ workspaceId })` over the
control connection. The response contains the selected child's
`workspaceReach` and no replacement control reach. A later workspace switch
uses the same operation and replaces only the saved workspace reach. Never
infer the target from a display name, the most recently opened child, or
the child that happened to be reachable during pairing.

There is no proposed device credential, child pairing activation journal,
`controlReach` route field, or transport capability between these steps. The
device credential authenticates identity; the two reaches say where its
control and workspace sessions terminate.

## Event Delivery

The event service has two independent delivery paths.

`emit(event, payload)` is watched broadcast. It only reaches live
`events.watch([...], watchId)` responses whose topic set contains the event. The
response body is the membership resource; cancelling it removes exactly that
watch. Reopening the same `watchId` atomically replaces its prior topic set.
Event records carry a monotonic sequence so the client can drain an old response
and start its replacement without losing or duplicating a broadcast. Snapshot
providers run only after the replacement has been registered.

`emitToCaller(callerId, event, payload)` is direct caller delivery. It bypasses
the subscription table and sends to every live session for that durable caller.
Use this when all live shells/panels/workers for a caller should observe the
same message.

`emitToConnection(callerId, connectionId, event, payload)` is direct session
delivery. It bypasses the subscription table and sends to exactly one live
transport instance. Use this for request-scoped handoffs where a sibling
connection should not receive the message.

There is no overloaded direct-delivery API. Callers must choose caller-wide or
connection-specific delivery explicitly.

## Session Registration

`RpcServer` registers exactly one direct event session for each authenticated
`callerId` + `connectionId`. Direct messages use the ordinary `ws:rpc` event
envelope, so they are received by the transport's normal RPC event listener.
Replacing or closing the transport releases that exact session; a late close
from the replaced socket cannot unregister its successor.

Connectionless response streams can own watches, but they are not transport
sessions and are never entered into the direct-address indexes.

Event watches are separate from direct delivery. Ending a watch response removes
only that response's watched topics; it does not remove direct-address
reachability for an authenticated WebSocket session.

## Recovery

Recovery has two different semantics:

- `resubscribe` is state recovery. Response-owning clients reopen their current
  desired watch after the transport reports a recovered session.
- `cold-recover` is an edge-triggered server-restart repair event. Late handlers
  must not run retroactively, because no new restart happened for them.

Handlers should be idempotent. A watch replacement keeps its stable logical ID,
opens the new response before retiring the old one, drains the old response to
its terminal, and deduplicates broadcast records by sequence.

## Ownership

Panel ownership is durable only at caller level:

```text
panelId -> ownerCallerId
```

A handoff that requires one concrete session must use its authenticated
`connectionId` and fail when that session is gone. It must not silently widen to
caller-wide delivery. Caller-wide fanout is a separate, explicit product choice.
Persisted ownership records retain only `ownerCallerId`; ephemeral connection
selection is discovered and validated at runtime.

## Invariants

- Never persist `connectionId`.
- Keep the hub control reach stable and replace only workspace reach on route.
- Route by exact `workspaceId`; never infer the pairing target from reach.
- Never assume one `callerId` means one live connection.
- Use `emitToCaller` for caller-wide direct delivery.
- Use `emitToConnection` for one transport instance.
- Treat `resubscribe` as stateful and `cold-recover` as edge-triggered.
- Keep response-owned watches and direct-address reachability independent.
- Fence incompatible peers with RPC contract version 2; transport byte
  compatibility does not imply event/service-contract compatibility.
- Give ordinary streams a body-idle deadline. Long-lived streams must opt out
  explicitly with `bodyIdleTimeoutMs: null`.
