# Agent inspection

Agent diagnosis has two complementary sources of truth:

- GAD inspectors report durable trajectory, invocation, roster, and channel
  facts.
- Agent inspection reports a small activation-local/SQLite snapshot from the
  agent vessel itself.

Neither source fabricates the other. In particular, agent inspection never
hydrates a folded loop from GAD: a diagnostic read must not wait on the
subsystem whose stall it is trying to explain.

## Recommended read order

Start with the durable view:

```ts
const health = await gad.inspectAgentHealth({ channelId });
const turn = await gad.inspectTurnState({ channelId });
```

Then inspect the agent vessel when local execution state matters:

```ts
const channel = await workers.resolveService("vibestudio.channel.v1", channelId);
const debug = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "getDebugState",
]);
```

The channel calls the agent's dedicated read-only inspection RPC directly.
This path is separate from ordinary participant `onMethodCall` routing, is
bounded to five seconds, and does not require a live roster row. The host relay
requires an already-active entity, so a retired or missing agent fails without
being resolved, reactivated, or recreated.

Non-host callers receive the normal approval prompt because debug data can
contain settings and pending work. The standard inspection methods are:

- `getDebugState`
- `getAgentSettings`
- `inspectMethodSuspensions`

No arbitrary agent method can be reached through `inspectAgent`.

## `getDebugState`

The payload contains only facts already present in the activation or its local
SQLite:

- `participantId`
- `loops[channelId]`
- `outbox`
- `subagentProgressOutbox`

An already-folded loop has:

```ts
{
  loaded: true,
  turnStatus,
  lastSeq,
  pendingInvocations,
  pendingApprovals,
  pendingCredentialWaits,
  settings,
}
```

If the loop is not resident in this activation, the honest result is:

```ts
{
  loaded: false,
  note: "No folded loop is loaded in this activation; inspect GAD for durable trajectory state."
}
```

`loaded: false` does not mean the channel has no trajectory or pending work. It
means exactly that the vessel has no activation-local folded view. Use GAD for
the durable answer; do not force hydration merely to make the debug payload
look complete.

## Suspension inspection

`inspectMethodSuspensions` returns the agent's local effect outbox. Join its
invocation and transport coordinates with `gad.inspectInvocationState(...)`
when durable terminality or provenance matters. Missing local state and missing
durable state remain distinct facts.

## Current-channel convenience

A live participant can still expose the same standard reads through
`chat.callMethod(...)`:

```ts
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
```

That form is an ordinary channel-scoped participant invocation and therefore
requires the target to be joined. Prefer the channel's `inspectAgent` facade
for out-of-band diagnosis, especially when the live method path is itself in
question.

## Failure interpretation

- Entity resolution failure: the agent is retired, missing, or no longer an
  active runtime entity.
- Five-second RPC deadline: the diagnostic transport or vessel activation is
  unhealthy. The snapshot implementation itself performs no external I/O.
- `loaded: false`: the activation has no folded loop; consult GAD.
- Local outbox row with a durable terminal: reconcile the local projection.
- Durable nonterminal with no local row: inspect delivery/recovery rather than
  inventing local state.
