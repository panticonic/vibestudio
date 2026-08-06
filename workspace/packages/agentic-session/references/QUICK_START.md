# Quick Start

## 1. One-liner: HeadlessSession with Agent

The simplest way to spawn an agent and drive it from code:

```typescript
import { HeadlessSession } from "@workspace/agentic-session";
import { contextId, rpc } from "@workspace/runtime";

const session = await HeadlessSession.createWithAgent({
  config: { clientId: rpc.selfId, rpc },
  rpcCall: (t, m, a) => rpc.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  contextId,
});

// Send a message and wait for the agent's response
await session.send("Calculate the first 10 fibonacci numbers using eval");
const response = await session.waitForAgentMessage();
console.log(response.content);

// Clean up
await session.close();
```

This automatically:
- Creates a unique channel and subscribes the DO agent
- Configures full-auto approval (no human in the loop)
- Projects the durable channel title into the session report
- Uses the worker's normal Vibestudio prompt and tool surface — UI tools like
  inline_ui, load_action_bar, and feedback_form simply aren't advertised, so the agent naturally
  falls back to plain message replies

For server-side eval, worker, and Durable Object callers, `clientId` is the
PubSub participant id and must be the caller's runtime identity (`rpc.selfId`).
Do not use an arbitrary harness label such as `"my-harness"`; PubSub rejects a
connectionless caller that tries to subscribe as a different participant.

The agent's `eval` (with its persistent `scope`/`db`) needs no setup here: it
runs server-side in the agent's own per-channel `EvalDO`, so it works even though
no panel is connected. You do not register an eval method or wire a sandbox for
the agent to evaluate code.

## 2. Two-step: Create then Connect

For more control over channel/subscription setup:

```typescript
import { HeadlessSession, subscribeHeadlessAgent } from "@workspace/agentic-session";
import { contextId, rpc } from "@workspace/runtime";

// Create session
const session = HeadlessSession.create({
  config: { clientId: rpc.selfId, rpc },
});

// Subscribe agent separately
const sub = await subscribeHeadlessAgent({
  rpcCall: (t, m, a) => rpc.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey: "my-specific-do",
  channelId: "my-channel",
  contextId,
});

// Connect (observes the durable channel title)
await session.connect("my-channel", { contextId });
```

## 3. ConnectionManager Directly

For maximum control — no agent subscription or wait helpers:

```typescript
import { ConnectionManager } from "@workspace/agentic-core";
import { contextId, rpc } from "@workspace/runtime";

const manager = new ConnectionManager({
  config: { clientId: rpc.selfId, rpc },
  callbacks: { onEvent: (event) => console.log("event", event.type) },
});

const client = await manager.connect({
  channelId: "existing-channel",
  methods: { /* your custom methods */ },
  contextId,
});

await client.send("Hello from a raw connection");
manager.disconnect();
```

## 4. Messaging Only (no custom methods)

When you only need to drive the conversation:

```typescript
const session = await HeadlessSession.createWithAgent({
  config: { clientId: rpc.selfId, rpc },
  rpcCall: (t, m, a) => rpc.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  contextId,
});
```

`set_title` is part of the agent worker's tool surface and writes the durable
channel title. The headless session observes that title for reports; it does not
advertise a consumer-owned title method. Server-side `eval` likewise comes from
the agent worker rather than the session's registered methods.

## 5. Worker/DO Context

From inside a Durable Object or worker:

```typescript
const session = await HeadlessSession.createWithAgent({
  config: { clientId: rpc.selfId, rpc },
  rpcCall: (t, m, a) => rpc.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  contextId,
});
```

## SandboxConfig Factories (optional)

A `SandboxConfig` is only needed if you want the session's local chat-sandbox
helpers; it is **not** required for the agent's `eval`, which runs server-side in
the agent's `EvalDO`.

| Factory | Context |
|---------|---------|
| `createPanelSandboxConfig(rpc)` | Panel (browser) |

It provides an `rpc` bridge and routes `loadImport` through `build.getBuild` /
`build.getBuildNpm` RPC calls. Non-panel contexts (worker/DO/Node) need no
SandboxConfig — the agent's `eval` runs server-side in its `EvalDO`.
