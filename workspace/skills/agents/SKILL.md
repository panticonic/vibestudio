---
name: agents
description: Add or remove an agent worker to/from a chat channel with addAgentToChannel — the general helper that mints a correct per-channel instance (no shared/standing keys, no improvising).
---

# Adding an agent to a channel

An agent is a workspace worker — a Durable Object class (e.g. `workers/explorer-agent` /
`ExplorerAgentWorker`). To put one in a channel you create an _instance_ and _subscribe_ it.
Use the general helper — don't hand-roll it:

```ts
import { addAgentToChannel } from "@workspace-skills/agents";

const result = await addAgentToChannel({
  source: "workers/explorer-agent",
  className: "ExplorerAgentWorker",
  handle: "explorer",
  name: "Explorer",
  channelId: chat.channelId, // defaults contextId to the current runtime context
  config: {
    /* model, respondPolicy, … per-agent behavior */
  },
});
// → { ok, channelId, contextId, targetId, participantId, key: "explorer-<channelId>" }
```

Remove it again with `removeAgentFromChannel({ source, className, handle, channelId })`.

## Why a helper (and the one rule it enforces)

The instance is keyed **per channel** (`${handle}-${channelId}`), so every channel gets its
own agent DO. That is the load-bearing invariant:

- **Never reuse a shared / "standing" key** (e.g. `explorer-standing`) for an ad-hoc add.
  One DO across multiple channels folds their turn state together and **corrupts the channel
  log** — it can adopt another channel's in-flight turn → duplicate envelope ids → GAD
  `id-collision`. `*-standing` keys are ONLY for scheduled instances under `vibestudio.yml
recurring:`.
- **Don't improvise with `resolveDurableObject` + a guessed key.** That only _resolves_ a
  target for the key you pass — pass a key you found lying around and you subscribe the
  wrong (often shared) instance. `addAgentToChannel` mints the right key for you.

## What it does (so you can trust it)

1. `runtime.createEntity` with `key = ${handle}-${channelId}` — per-agent behavior rides
   `stateArgs.agentConfig`.
2. `subscribeChannel` on the new target — one finite durable relationship update.

Agent membership is persistent data, not a live response stream. An idle agent
and its channel may hibernate independently; committed channel work is delivered
through the channel-owned durable mailbox by finite idempotent recipient calls.
Each mailbox row carries the same event-sequence snapshot used to select its
recipient: relationship/application configuration, channel conversation
configuration and fold state, and reply identity. Agent admission must use that
snapshot; fetching newer channel policy, roster, config, or sender state inside
the claim window is a correctness and latency defect.
Presence and typing are disposable UI signals, while invocation lifecycle and
other outcome-changing facts are canonical log events. Delivery/read receipts
are monotone replayable projections; never append them as messages or create
mailbox work for them. A disposable signal may refresh connected external UI,
but must never target durable entity relationships. This split keeps UI
freshness without turning connectivity or acknowledgement into agent work.

It's idempotent per channel: re-adding the same handle to the same channel reuses the same
instance.

## Per-agent setup wrappers

An agent that needs extra setup (credentials, onboarding, custom config) wraps this helper
rather than reimplementing it — e.g. `setupGmailAgent({ channelId })` verifies the Google
credential, then calls `addAgentToChannel(...)`. Keep the channel-membership mechanics here;
keep the agent-specific prerequisites in the wrapper.
