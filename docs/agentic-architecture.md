# Agentic Architecture: Channels, Workers, and In-Process Pi

## Overview

Vibez1's agentic system is a 2-layer server-side architecture. Pi
(`@mariozechner/pi-coding-agent`) runs **in-process** inside each agent
worker DO — there is no harness child process layer.

```
Panel (browser)          Channel DO (workerd)     Worker DO (workerd, embeds Pi)
     │                        │                        │
     │── user message ───────►│── onChannelEvent ──────►│
     │                        │                        │── runner.runTurn(content) ──┐
     │                        │                        │                              │
     │                        │                        │  Pi AgentSession streams     │
     │                        │                        │  events in-process           │
     │                        │                        │                              │
     │                        │◄── persisted trajectory events ◄─────────────┘
     │◄── channel log event ──│   (message.started/delta/completed,
     │                        │    invocation.*, turn.*)
     │                        │                        │
     │── method-result ──────►│── persisted event ─────►│── resolve continuation Promise
     │                        │                        │
```

- **Channel DO** — workspace-owned userland service. Forkable
  history, `this.sql`-backed message storage, participant roster, ephemeral and
  persisted message routing. Enforces participant handle uniqueness so the
  channel-tools extension can use bare method names without collision.
- **Worker DO** — `workspace/packages/agentic-do/src/agent-worker-base.ts`.
  Owns one `PiRunner` per channel; Pi's `AgentSession` runs in-process.
  `PiRunner` converts Pi lifecycle events into canonical
  `agentic.trajectory.v1` events, appends them to GAD, and publishes selected
  events to the channel log for transcript consumers.

## Key design principle: trajectory events are the transcript source

Pi owns live provider/session execution inside a turn. Durable transcript state
is represented as `agentic.trajectory.v1` events:

- `message.started`, `message.delta`, `message.completed`, `message.failed`
- `invocation.started`, `invocation.output`, `invocation.completed`, etc.
- `turn.opened`, `turn.waiting`, `turn.closed`

The chat UI consumes persisted channel envelopes with
`payloadKind: "agentic.trajectory.v1/event"` and reduces them through
`@workspace/agentic-protocol` into the rendered transcript. Signal messages are
still used for transient extension/status UI, but not as the authoritative chat
transcript.

### Channel event flow

1. User/panel messages are published as durable `message.completed` events.
2. `AgentWorkerBase.shouldProcess()` accepts client-originated
   `message.completed` events and turns them into `PiRunner` input.
3. `PiRunner` listens to Pi `message_start`, `message_update`, `message_end`,
   tool, and turn lifecycle events.
4. `PiRunner.appendTrajectoryEvents()` writes canonical trajectory events to
   GAD and asks GAD to publish selected events to the channel.
5. `useChannelMessages()` subscribes to replay + live channel events and
   reduces them into `ChatMessage[]`.

## DO Base Classes

**DurableObjectBase** — generic DO foundation (~150 lines).
Location: `workspace/packages/runtime/src/worker/durable-base.ts`

**AgentWorkerBase** — Pi-native agent base extending DurableObjectBase.
Location: `workspace/packages/agentic-do/src/agent-worker-base.ts`

### Customization hooks (Pi-native)

| Hook                          | Default                                                                  | Purpose                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `getDefaultModel()`           | subclass override required; `AiChatWorker` uses `"openai-codex:gpt-5.5"` | Default model id in `provider:model` format; subscription config can override per channel |
| `getDefaultThinkingLevel()`   | `"medium"`                                                               | Default Pi thinking level; state/config can override per channel                          |
| `getApprovalLevel(channelId)` | `2` (full auto)                                                          | 0 = ask all, 1 = auto safe tools, 2 = full auto                                           |
| `shouldProcess(event)`        | Panel messages only                                                      | Filter incoming channel events                                                            |
| `buildTurnInput(event)`       | Extract content                                                          | Transform to TurnInput                                                                    |
| `getParticipantInfo()`        | Generic agent                                                            | Channel identity + advertised methods                                                     |

The final prompt is composed from the Vibez1 base prompt,
`workspace/meta/AGENTS.md`, the generated skill index, and optional
subscription prompt config. Workspace skills live under `workspace/skills/`
and are discovered through the `workspace.*` RPC service.

### Durable Object SQL Tables

| Table             | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `state`           | Key-value store (approval level per channel, fork metadata)           |
| `subscriptions`   | Channel subscriptions + participant ID                                |
| `pi_sessions`     | Per-channel Pi session JSONL file path (for restart resume)           |
| `delivery_cursor` | Last-processed channel event id (dedup + gap detection)               |
| `pending_calls`   | Promise continuations for tool callMethod and UI feedback_form awaits |

That's it. Pi tracks turn state, message state, and session branching itself
inside `AgentSession`. The previous architecture's `harnesses`, `active_turns`,
`in_flight_turns`, `queued_turns`, `checkpoints`, and `turn_map` tables are
gone.

## Where State Lives

Workspace and framework state lives in Durable Objects:

- Agent and channel workers own their own `this.sql` schema.
- `EvalDO` runs sandbox eval server-side and stores per-owner REPL scope (one per caller, behind the `eval` service).
- `WorkspaceDO` stores panel tree state and panel search FTS (replaced the former `PanelStoreDO`).
- `BrowserDataDO` stores imported browser data and history FTS.
- `WebhookStoreDO` stores webhook ingress subscriptions.

See `docs/architecture/storage.md` for object key conventions and internal DO
registration details.

## Hermetic sandbox

The worker constructs `DefaultResourceLoader` with explicit opt-outs — there
is no auto-discovery, extensions are wired inline by `PiRunner`:

```typescript
new DefaultResourceLoader({
  cwd: contextFolderPath,
  agentDir: piAgentDir,            // Vibez1-managed sandbox dir
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalSkillPaths: [/* workspace skill paths resolved via workspace RPC */],
  extensionFactories: [
    vibez1ApprovalGateFactory(...),
    vibez1ChannelToolsFactory(...),
    vibez1AskUserFactory(...),
  ],
})
```

The workspace prompt (`workspace/meta/AGENTS.md`) and skill index are read via
the `workspace.*` RPC service and composed by `PiRunner` — not via Pi's
skill/extension auto-discovery.

API keys are bridged via `AuthStorage.setRuntimeApiKey(provider, key)` —
priority #1 in Pi's auth resolution chain, ahead of any file-based auth.

## Vibez1 Pi extensions

Three extension factories supplied inline by the worker (closure-bound, not
Pi-package-portable). Live in `workspace/packages/harness/src/extensions/`:

- **`approval-gate.ts`** — `pi.on("tool_call", ...)` reads the approval level
  via a closure-bound getter. The worker can mutate the approval level
  mid-conversation; the extension picks it up on the next tool call.
- **`channel-tools.ts`** — Registers each channel participant's advertised
  methods as a Pi tool with the participant's bare method name. Tool names
  are deduped via the channel's enforced handle uniqueness. Reconciles on
  `session_start` and `turn_start`.
- **`ask-user.ts`** — Single `ask_user` tool that routes to a feedback_form
  on the channel via the worker callback.

The `Vibez1ExtensionUIContext` class
(`workspace/packages/harness/src/vibez1-extension-context.ts`) implements Pi's
`ExtensionUIContext`. Each UI primitive (`select`, `confirm`, `input`,
`notify`, `setStatus`, etc.) routes through worker-supplied callbacks that
turn the request into a channel `feedback_form`, ephemeral notify, or
metadata-update event.

## Continuation plumbing

Tool callMethod and UI feedback_form awaits use a `pending_calls` SQL table
plus an in-memory `pendingResolvers` Map. When the worker dispatches a call
via `channel.callMethod(callerId, targetId, callId, method, args)`, it stores
a continuation and awaits a Promise. When the channel persists and broadcasts
the corresponding `method-result` event, the worker observes that same channel
event and resolves (or rejects) the Promise.

This is the bridge between Pi's synchronous-await tool API and the channel's
asynchronous fire-and-forget call/result protocol.

## Workspace layout

Skills and the agent system prompt live under `workspace/` and are
read via the `workspace.*` RPC service:

```
workspace/
├── meta/
│   ├── AGENTS.md        # Workspace system prompt content
│   └── vibez1.yml     # Init panels and workspace config
└── skills/              # Workspace skills (sandbox, workspace-dev, onboarding, etc.)
    └── ...
```

Extensions are Vibez1-only and live in `workspace/packages/harness/src/extensions/`
as TypeScript modules supplied inline (closure-bound to the worker). There
is no workspace-level extensions directory — chat behavior is intrinsically
Vibez1-bound.

## Package map

| Package                      | Location                              | Contents                                                                                    |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Workspace agent runtime      | `workspace/packages/harness/`         | `PiRunner`, `Vibez1ExtensionUIContext`, three extension factories, channel boundary types |
| Channel client package       | workspace package                     | Panel-side channel client and protocol types                                                |
| `@workspace/runtime`         | `workspace/packages/runtime/`         | DurableObjectBase, HttpRpcBridge                                                            |
| `@workspace/agentic-do`      | `workspace/packages/agentic-do/`      | AgentWorkerBase, ChannelClient, ContinuationStore, SubscriptionManager                      |
| `@workspace/agentic-core`    | `workspace/packages/agentic-core/`    | Derived UI types, channel-view to chat projection, ConnectionManager                        |
| `@workspace/agentic-chat`    | `workspace/packages/agentic-chat/`    | useChannelMessages, useChatCore, useAgenticChat                                             |
| `@workspace/agentic-session` | `workspace/packages/agentic-session/` | HeadlessSession (Pi-native programmatic interface)                                          |
| Workers                      | `workspace/workers/`                  | AiChatWorker, TestAgentWorker (both extend AgentWorkerBase)                                 |

## Further reading

- **Pi-architecture deep dive**: `docs/pi-architecture.md`
- **Pi SDK reference**: `node_modules/@mariozechner/pi-coding-agent/README.md`
- **Worker authoring**: `workspace/workers/README.md`
- **workspace-dev skill**: `workspace/skills/workspace-dev/WORKERS.md`
