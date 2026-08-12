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
  replay: true, // only when eligible existing history should be admitted
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
durable; presence and typing are disposable UI state. The helper delegates to
the canonical `launchAgentIntoChannel` lifecycle. Panel products that can
request workspace review pass their approval adapter as `waitForReview`; the
helper then waits and retries the same idempotent launch.

## Multi-agent product topology

Use `respondPolicy: "mentioned-strict"` for agents that should act only on
addressed work. Give ordinary unmentioned player text one explicit default
recipient—usually a command interpreter—instead of broadcasting it. A direct
mention may bypass the interpreter when the product intends expert access.

A command interpreter translates natural language into narrow addressed
requests. It must reread authoritative application state before resolving
references such as “the first plan” or “Engineering's proposal,” and ask a
clarifying question rather than inventing an identifier. Do not give it mutation
authority merely because it coordinates the conversation. State-changing
methods validate the authenticated caller and leave legality, costs, and
invariants to deterministic code.

Treat agent-to-agent progression as an addressed durable effect. When a state
transition requires a follow-up message, persist the transition and pending
directive together, publish with a deterministic idempotency key, and clear the
directive only after publication succeeds. Redrive it after hibernation or
reload. A successful mutation followed by an unrecorded best-effort send is not
a complete workflow.

## Per-agent setup wrappers

Agents needing credentials, onboarding, or custom config should wrap this
helper. Keep prerequisites in the wrapper; channel membership stays here.
