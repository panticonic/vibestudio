---
name: agents
description: Add or remove a worker-backed agent from a chat channel with the per-channel addAgentToChannel and removeAgentFromChannel helpers.
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

## Per-channel identity

The instance is keyed **per channel** (`${handle}-${channelId}`), so every channel gets its
own agent DO. That is the load-bearing invariant:

- Never reuse a scheduled or shared instance key for an ad-hoc channel. Sharing
  one agent DO across channels mixes turn state and can corrupt channel logs.
- Do not replace the helper with `resolveDurableObject` and a guessed key. That
  resolves the supplied identity; it does not mint a safe channel-local one.

The helper creates the channel-keyed runtime entity and subscribes it with the
supplied agent configuration. Re-adding the same handle to the same channel is
idempotent. Membership is durable; presence and typing are disposable UI state.

## Per-agent setup wrappers

An agent that needs credentials, onboarding, or custom configuration should
wrap this helper. Keep prerequisites in the wrapper and channel membership here.
