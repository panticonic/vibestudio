---
name: agents
description: Add or remove an agent worker to/from a chat channel with addAgentToChannel — the general helper that mints a correct per-channel instance (no shared/standing keys, no improvising).
---

# Adding an agent to a channel

An agent is a workspace worker — a Durable Object class (e.g. `workers/explorer-agent` /
`ExplorerAgentWorker`). To put one in a channel you create an *instance* and *subscribe* it.
Use the general helper — don't hand-roll it:

```ts
import { addAgentToChannel } from "@workspace-skills/agents";

const result = await addAgentToChannel({
  source: "workers/explorer-agent",
  className: "ExplorerAgentWorker",
  handle: "explorer",
  name: "Explorer",
  channelId: chat.channelId,          // defaults contextId to the current runtime context
  config: { /* model, respondPolicy, … per-agent behavior */ },
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
  `id-collision`. `*-standing` keys are ONLY for scheduled instances under `vibez1.yml
  recurring:`.
- **Don't improvise with `resolveDurableObject` + a guessed key.** That only *resolves* a
  target for the key you pass — pass a key you found lying around and you subscribe the
  wrong (often shared) instance. `addAgentToChannel` mints the right key for you.

## What it does (so you can trust it)

1. `runtime.createEntity` with `key = ${handle}-${channelId}` — per-agent behavior rides
   `stateArgs.agentConfig`.
2. `subscribeChannel` on the new target — presentation-only subscription config.

It's idempotent per channel: re-adding the same handle to the same channel reuses the same
instance.

## Per-agent setup wrappers

An agent that needs extra setup (credentials, onboarding, custom config) wraps this helper
rather than reimplementing it — e.g. `setupGmailAgent({ channelId })` verifies the Google
credential, then calls `addAgentToChannel(...)`. Keep the channel-membership mechanics here;
keep the agent-specific prerequisites in the wrapper.
