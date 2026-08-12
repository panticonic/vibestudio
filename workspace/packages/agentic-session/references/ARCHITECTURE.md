# Architecture

## Layer Diagram

```
@workspace/agentic-core          ← shared business logic, no React
  - typed agentic event → ChannelViewState reducer
  - ChannelViewState → ChatMessage / InvocationCard / ApprovalCard / InlineUiCard selectors
  - connection primitives and the panel import-loader factory
  - types: ChatMessage, ChatParticipantMetadata, ConnectionConfig, etc.

@workspace/agentic-chat          ← thin React adapter
  useChatCore() owns the PubSubClient lifecycle
  - useChannelMessages() subscribes with replay and live events
  - adds React-only concerns: input state, pending images,
    document.title, inline UI/action-bar compilation, tool approval UI
  useAgenticChat() composes useChatCore + feature hooks

@workspace/agentic-session       ← thin headless convenience
  HeadlessSession = PubSub connection (via ConnectionManager) + the same typed reducer/selector path
  - finite, owner-routed delivery into the resident operation; no channel response stream
  - full-auto channel config (approval level 2)
  - durable channel-title observation for reports
  - convenience: createWithAgent() connects the headless client, then subscribes the agent
  - Uses the same agent worker prompt and tool surface as panel sessions;
    UI tools naturally drop out because no panel is advertising them.
  - The agent's `eval` runs server-side in its own per-channel EvalDO, so it
    works with no panel and needs no session-side sandbox.
```

## What Lives Where

**agentic-core** (no React, no tool-ui, no browser APIs):

- `ConnectionManager` — PubSub connection lifecycle
- `useChannelMessages` / `HeadlessSession` — reduce typed PubSub channel events
  into the same channel view model
- `TypedEmitter` — lightweight typed event emitter
- `chatMessagesFromChannelView` — single selector that projects messages,
  invocation cards, inline UI, and related transcript models
- Headless-safe types: `ChatMessage`, `ChatParticipantMetadata`, `ConnectionConfig`, `ToolProviderDeps`, etc.
- `createPanelImportLoader(rpc)` — build-backed dynamic import loader for panel-authored UI/eval

**agentic-session** (no React, no browser APIs):

- `HeadlessSession` — headless PubSub client + typed channel reducer
- `getRecommendedChannelConfig()` — full-auto approval channel config
- `subscribeHeadlessAgent()` — subscribe a DO agent to a channel with full-auto approval

**agentic-chat** (React adapter):

- `useChatCore()` — owns the PubSub client, subscribes to the typed channel log, returns React state
- `useAgenticChat()` — composes useChatCore + feedback/tools/debug/inlineUi hooks
- UI-only types: `ChatContextValue`, `ChatInputContextValue`, `InlineUiComponentEntry`
- UI-only hooks: `useChatFeedback`, `useChatTools`, `useChatDebug`, `useInlineUi`

## Composing browser-owned surfaces

Every `AgenticChat` host explicitly selects its browser-owned capabilities for
the participant's lifetime. Conventional chat hosts use
`FULL_AGENTIC_CHAT_FEATURES`; smaller products and games select only what they
present:

```tsx
<AgenticChat
  features={["feedback"]}
  renderInvocation={({ payload }, defaultContent) =>
    payload.name === "game_action" ? <GameMove payload={payload} /> : defaultContent
  }
/>
```

The selection is a capability boundary, not a CSS visibility switch. Omitting
`feedback` removes `feedback_form`, `feedback_custom`, `confirm`, and
`ui_prompt` from the joined participant as well as the stock feedback area.
Omitting `inline-ui` removes `inline_ui`, skips component compilation, and
hides historical inline-UI cards from the stock transcript. Omitting
`action-bar` similarly removes `load_action_bar` and its stock presentation.
Omitting `client-eval` removes `client_eval`. Pass `features={[]}` for none of
these browser-owned capabilities. Remount the
participant to change the selection because channel methods are fixed at join.
Supply `importLoader={createPanelImportLoader(rpc)}` only when authored UI or
client evaluation needs build-backed dynamic package loading.

`renderInvocation` can replace, wrap, or return `null` for each invocation; its
second argument is the complete default renderer. `renderMessage` and
`renderInlineGroup` remain the wider escape hatches. For a wholly different
conversation model, consume `useChatCore()` directly. Headless game flows can
instead use `HeadlessSession` and expose no conversation UI at all.

## Transcript Event Flow

```
Producer
  ↓ send()/publish()
PubSub channel log
  ↓ durable recipient mailbox + finite delivery to the owning DO
ConnectionManager
  ↓ owner-registered event callback (replay arrives in the finite join ACK)
Typed Agentic Event Reducer
  ↓ ChannelViewState
chatMessagesFromChannelView / actionBarPayloadFromChannelView
  ↓
React adapter (useChatCore/useAgenticChat)
  ↓
React components re-render
```

For a headless session, the owning Durable Object supplies the resident receiver
registrar. EvalDO injects that registrar into its active execution RPC object;
importing a registry in guest/userland code is not equivalent because it belongs
to a different module graph. The registration exists only for the active
operation. Missing receivers leave mailbox work retryable, while a new
relationship revision retires the obsolete lane and reconstructs state from the
join replay.

Resident mailbox sequence is ordered but intentionally not globally contiguous:
self-authored and unaddressed channel events do not become recipient work. A
resident client therefore never interprets a global log-sequence gap as loss or
issues replay repair from inside the delivery callback. Completeness comes from
the channel's durable per-participant lane. When the owner is EvalDO, each
finite callback re-enters the exact active eval execution context and eval
terminalization revokes the receiver and drains callbacks already in flight.

The transcript source is the PubSub channel log. Initial prompts, user messages,
agent responses, invocation updates, approvals, inline UI, and action bars all
enter the UI through typed channel events and the same reducer/selector path.
Do not add hidden transcript side channels or merge legacy method history into
React state.

The semantic control plane stores private branchable provenance separately from transmitted channel
history. When a trajectory event is published to a channel, GAD records a
`trajectory_channel_publications` row so tools can join:

```
trajectory_events.event_id
  → trajectory_channel_publications.envelope_id
  → channel_envelopes.envelope_id
```

Use that join for audits, side-task forks, and “what did the user actually see?”
queries. Keep roster/debug streams separate unless they are rendered in the
transcript UX.

## Teardown Contract

HeadlessSession provides two teardown paths:

- **`dispose(): void`** — synchronous best-effort: unregisters the resident receiver and disconnects. Use when the surrounding context is being torn down hard.
- **`close(): Promise<void>`** — awaitable: disposes locally, then completes shared-context unsubscribe before entity retirement. An isolated session destroys its owned context tree as one lifecycle unit. Use for ordinary headless consumers.
- **`close({ waitForRemoteCleanup: false })`** — detach mode for harnesses: disposes local state immediately and starts the same ordered remote cleanup without awaiting it. Use this instead of wrapping session cleanup in a timeout.
- **`Symbol.asyncDispose`** — supports `await using session = ...` syntax (calls `close()`).

## Eval, scope, and db ownership

The session does **not** own the agent's REPL scope or `db`. The agent's `eval`
tool dispatches to the server-side `eval` service, which runs the code in a
per-owner, per-channel `EvalDO`. That DO holds the persistent REPL `scope` (and a
synchronous in-DO SQLite `db`) in its own storage and survives across turns
regardless of whether any panel or headless session is connected.

Because of this, HeadlessSession registers no `eval` method and creates no scope
manager — there is nothing scope-related for it to persist on teardown.
