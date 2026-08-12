---
name: agents
description: Add or remove a worker-backed agent from a chat channel.
---

# Adding an agent to a channel

An agent is a workspace worker DO (e.g. `workers/explorer-agent` /
`ExplorerAgentWorker`). Use the general helper to create an instance and
subscribe it:

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

Remove with `removeAgentFromChannel({ source, className, handle, channelId })`.

## Per-channel identity

Instances are keyed per channel (`${handle}-${channelId}`), so every channel
gets its own agent DO. This is load-bearing:

- Never reuse a scheduled or shared instance key for an ad-hoc channel — sharing
  one DO across channels mixes turn state and corrupts logs.
- Never replace the helper with `resolveDurableObject` and a guessed key — that
  resolves a supplied identity rather than minting a safe channel-local one.

Re-adding the same handle to the same channel is idempotent. Membership is
durable; presence and typing are disposable UI state.

## Per-agent setup wrappers

Agents needing credentials, onboarding, or custom config should wrap this
helper. Keep prerequisites in the wrapper; channel membership stays here.
