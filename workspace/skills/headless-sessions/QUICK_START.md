# Quick Start

## 1. One-liner: HeadlessSession with Agent

The simplest way to spawn an agent and drive it from code:

```typescript
import { HeadlessSession } from "@workspace/agentic-session";

const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: gatewayUrl, token, clientId: "my-harness" },
  rpcCall: (t, m, a) => rpcClient.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  contextId: myContextId,
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
- Registers the default `set_title` method on the client
- Uses the worker's normal NatStack prompt and tool surface — UI tools like
  inline_ui, load_action_bar, and feedback_form simply aren't advertised, so the agent naturally
  falls back to plain message replies

The agent's `eval` (with its persistent `scope`/`db`) needs no setup here: it
runs server-side in the agent's own per-channel `EvalDO`, so it works even though
no panel is connected. You do not register an eval method or wire a sandbox for
the agent to evaluate code.

## 2. Two-step: Create then Connect

For more control over channel/subscription setup:

```typescript
import { HeadlessSession, subscribeHeadlessAgent } from "@workspace/agentic-session";

// Create session
const session = HeadlessSession.create({
  config: { serverUrl: gatewayUrl, token, clientId: "my-harness" },
});

// Subscribe agent separately
const sub = await subscribeHeadlessAgent({
  rpcCall: (t, m, a) => rpcClient.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey: "my-specific-do",
  channelId: "my-channel",
  contextId: myContextId,
});

// Connect (registers the default set_title method)
await session.connect("my-channel", { contextId: myContextId });
```

## 3. ConnectionManager Directly (no headless defaults)

For maximum control — no agent subscription, no `set_title`, no wait helpers:

```typescript
import { ConnectionManager } from "@workspace/agentic-core";

const manager = new ConnectionManager({
  config: { serverUrl: gatewayUrl, token, clientId: "raw-client" },
  callbacks: { onEvent: (event) => console.log("event", event.type) },
});

const client = await manager.connect({
  channelId: "existing-channel",
  methods: { /* your custom methods */ },
  contextId: myContextId,
});

await client.send("Hello from a raw connection");
manager.disconnect();
```

## 4. Messaging Only (no custom methods)

When you only need to drive the conversation:

```typescript
const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: gatewayUrl, token, clientId: "messaging-only" },
  rpcCall: (t, m, a) => rpcClient.call(t, m, a),
  source: "workers/agent-worker",
  className: "AiChatWorker",
  contextId: myContextId,
});
```

The headless client always advertises `set_title`. The agent still has its full
worker tool surface — including server-side `eval` — because those tools come
from the agent worker, not from the session's registered methods.

## 5. Worker/DO Context

From inside a Durable Object or worker:

```typescript
const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: gatewayUrl, token, clientId: `worker-${objectKey}` },
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
