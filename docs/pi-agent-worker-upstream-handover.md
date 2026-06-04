# Pi-derived agent worker upstream review handover

Date: 2026-05-16

## Purpose

This note captures a focused upstream review of the Pi-derived logic in
NatStack's chat agent Durable Object implementation. It is intended as handover
context for another agent or engineer who will turn the findings into scoped
NatStack changes.

The important distinction: this is not a review of the generic
`workspace/packages/harness` file tools alone. The target is the agent worker DO flow that
forks, embeds, and adapts Pi's chat/agent loop behavior for NatStack's channel,
Durable Object, credential, hibernation, and method-dispatch model.

## Local branch and dependency state

The review was performed in `/home/werg/natstack2` on branch
`worktree-update-deprecated-deps`.

That branch currently uses the new Pi package scope:

- `@earendil-works/pi-agent-core@0.74.0`
- `@earendil-works/pi-ai@0.74.0`

The old `@mariozechner/*` Pi package references were cleaned up in the branch.
The lockfile install, relevant harness/agentic-do tests, type-check, and build
had already passed before this review.

## Upstream source checked

Upstream repository checked locally:

```sh
git clone --filter=blob:none https://github.com/badlogic/pi-mono.git /tmp/pi-mono
```

The `earendil-works/pi-mono` and `badlogic/pi-mono` refs appeared aligned for
the relevant branches during this check.

Relevant upstream refs:

- Installed npm/tag baseline: `v0.74.0`, commit `1eee081e`, dated
  2026-05-07.
- Current upstream `main`: `87881ca6`, dated 2026-05-16, described as
  `v0.74.0-131-g87881ca6`.
- No tag was found containing `87881ca6`, so the post-`0.74.0` findings are
  currently unreleased relative to the installed npm packages.

Useful upstream commands:

```sh
git -C /tmp/pi-mono describe --tags --always HEAD
git -C /tmp/pi-mono diff --stat v0.74.0..main -- packages/agent packages/coding-agent
git -C /tmp/pi-mono diff v0.74.0..main -- packages/agent/src/agent-loop.ts packages/agent/src/agent.ts packages/agent/src/types.ts
git -C /tmp/pi-mono log --oneline v0.74.0..main -- packages/agent packages/coding-agent/src/core/agent-session.ts
```

## Local Pi-derived components

Primary local files:

- `workspace/packages/agentic-do/src/agent-worker-base.ts`
  - Owns the Durable Object lifecycle, channel subscription, replay/gap repair,
    per-channel `PiRunner` construction, credential recovery, interruption,
    fork support, and routing of channel events into Pi user messages.
- `workspace/packages/agentic-do/src/turn-dispatcher.ts`
  - Local per-channel user-message queue/steering state machine. This is a
    NatStack-specific adaptation around Pi's `Agent.prompt()`/`Agent.steer()`
    APIs.
- `workspace/packages/agentic-do/src/content-block-projector.ts`
  - Projects Pi `AgentEvent`s into NatStack channel messages and tool-call UI
    payloads.
- `workspace/packages/agentic-do/src/dispatched-call-store.ts`
  - Durable breadcrumb table for interactive tool dispatches that must survive
    hibernation/restart.
- `workspace/packages/harness/src/pi-runner.ts`
  - Thin in-process wrapper around `@earendil-works/pi-agent-core` `Agent`.
    It adapts Pi to NatStack resources, channel tools, approval gates, ask-user,
    GAD logging, persistence, and DO callbacks.
- `workspace/workers/agent-worker/ai-chat-worker.ts`
  - Default concrete chat agent worker that extends `AgentWorkerBase`.

Key local behavior to preserve:

- One `PiRunner` per subscribed channel.
- Channel history is persisted in DO SQLite `pi_messages`, not in Pi's native
  file/session store.
- Channel participant method calls are exposed to Pi as dynamic tools through
  NatStack's channel-tools extension.
- Interactive tool dispatches abort the current Pi turn and write durable
  placeholders so method results can be applied after hibernation/restart.
- User-submitted messages during active runs go through `TurnDispatcher`, which
  decides between fresh turn and Pi steering.
- Message projection is one NatStack channel message per Pi text/thinking/tool
  content block.

## Upstream changes worth knowing

### 1. Upstream added an `AgentHarness`

Post-`0.74.0`, upstream added a large new `packages/agent/src/harness/*`
subtree. The major related commits include:

- `a5b27367 feat(agent): add initial harness foundation`
- `b7ea8210 refactor(agent): run harness loop directly`
- `4f40f62b refactor(agent): harden harness session semantics`

The upstream harness owns:

- session abstraction and storage backends
- pending session writes during active turns
- explicit queue update events
- compaction and branch summary helpers
- per-turn resource/system-prompt/model/thinking snapshots
- stream option hooks and provider request hooks

Assessment: do not port wholesale. NatStack has different durability and UI
boundaries: DO SQLite, channels, method-result recovery, URL-bound credentials,
forking, and hibernation. The upstream harness is still useful as a design
reference for specific mechanics, especially turn-state snapshots and pending
write flushing.

### 2. Upstream added `prepareNextTurn`

Upstream changed `packages/agent/src/agent-loop.ts` and `types.ts` to add:

- `AgentLoopTurnUpdate`
- `PrepareNextTurnContext`
- `AgentLoopConfig.prepareNextTurn`

The hook runs after `turn_end` and before the loop decides whether to continue
with another provider request. It can replace:

- context
- model
- thinking level

Upstream `AgentHarness` uses this to flush pending session writes, rebuild turn
state from session/resources, and pass a refreshed context/model/thinking
snapshot into the next LLM request.

Local relevance:

- `AgentWorkerBase.ensureChannelContext()` refreshes roster before an incoming
  channel event.
- `PiRunner.handleAgentEvent()` dispatches local extension `turn_start` and then
  calls `refreshActiveTools()` from cached extension state.
- During a multi-turn Pi loop, channel/tool roster or config changes may not be
  fully refreshed from the channel before the next provider request unless a new
  user/channel event caused `ensureChannelContext()` first.

Recommendation: when a Pi release includes `prepareNextTurn`, port a
NatStack-specific version into `PiRunner`/`AgentWorkerBase` rather than
adopting upstream `AgentHarness`. The NatStack version should likely:

- ask `AgentWorkerBase` for a fresh roster/config snapshot for the channel
  between Pi turns
- refresh extension runtime active tools from that snapshot
- refresh model and thinking level if the DO config changed
- preserve the current `pi_messages`/DO SQLite persistence model

This should be carefully designed because our channel callbacks are async, while
some current extension-runtime callbacks are synchronous over cached data.

### 3. Upstream improved run-failure lifecycle events

In `v0.74.0`, upstream `Agent.handleRunFailure()` pushed a failure assistant
message into state and emitted only `agent_end`.

Current upstream `main` now emits the full lifecycle for thrown run/provider
failures:

- `message_start`
- `message_end`
- `turn_end`
- `agent_end`

It also has a test named "emits full lifecycle events for thrown run failures".

Local relevance:

- `ContentBlockProjector` has explicit logic for terminal error/abort cleanup
  on `agent_end`.
- `AgentWorkerBase.getOrCreateRunner()` has extra handling to surface terminal
  error agent runs as visible system messages/log lines because some thrown
  paths previously looked silent.
- Once we update past `0.74.0`, that extra handling may become partially
  redundant or may need adjustment to avoid duplicate user-facing error output.

Recommendation:

- After updating to a Pi release that includes this change, write/adjust a
  regression test for thrown `getApiKey`/provider failures in the DO worker.
- Verify that one visible error is produced, all in-flight projected blocks are
  completed, typing turns off, and `pi_messages` persists a coherent failure
  assistant message.

### 4. Upstream still appears to leave our steering sweep justified

`TurnDispatcher` documents and compensates for a Pi steering queue race:

- a user message steered near the natural end of a run can land after Pi's last
  steering poll but before the loop exits
- Pi may then emit `agent_end` without ever emitting `message_start` for that
  exact steered message
- the message remains in Pi's internal steering queue

Our dispatcher tracks steered message object identity. If `agent_end` arrives
with unabsorbed steered messages, it:

- moves those messages into the fresh-turn queue
- calls `runner.clearSteeringQueue()`
- starts another drain loop

Current upstream `agent-loop.ts` still polls steering before checking follow-up
messages and exiting. I did not see an upstream change that clearly eliminates
the race described in our local comments.

Recommendation: keep the local self-healing sweep. Do not remove it just
because upstream added the new harness. Revisit only if upstream changes the
agent-loop polling semantics or adds a stronger queue-drain guarantee.

### 5. PiRunner currently drops upstream awaited-listener semantics

This is the clearest actionable local issue.

Upstream `Agent.subscribe()` listeners are awaited. The Pi docs/changelog also
state that `agent_end` is not the idle boundary and that `prompt()`/`continue()`
settle after awaited listeners complete.

Local `PiRunner.handleAgentEvent()` currently loops over listeners like this:

```ts
for (const listener of this.listeners) {
  try {
    listener(event);
  } catch (err) {
    console.error("[PiRunner] listener threw:", err);
  }
}
```

This means:

- async listener failures are not caught by the `try/catch`
- `PiRunner` does not preserve Pi's awaited event back-pressure
- `ContentBlockProjector.handleEvent()` returns a promise chain specifically so
  channel sends/updates/completes land in order, but that promise is ignored by
  `PiRunner`
- `Agent.prompt()` can settle before channel projection has fully landed

Local evidence:

- `ContentBlockProjector` explicitly says its returned promise allows
  pi-agent-core's awaited subscribe to provide end-to-end back-pressure.
- `PiRunner.subscribe()` is typed as `(event: AgentEvent) => void`, not
  `Promise<void> | void`.
- `PiRunner`'s own `agent.subscribe((event, _signal) => this.handleAgentEvent(event))`
  returns the `handleAgentEvent` promise to Pi, but inside `handleAgentEvent`
  it does not await downstream listeners.

Recommendation: port the awaited-listener behavior into `PiRunner` first.

Suggested shape:

- Change the listener type to `(event: AgentEvent) => Promise<void> | void`.
- In `handleAgentEvent`, `await listener(event)` for each listener, preserving
  registration order.
- Catch async errors and log them.
- Consider whether listener failures should only log or should propagate to Pi.
  The current local behavior logs and continues, so a conservative first port
  should keep logging/continuing while still awaiting each listener.
- Update tests in `workspace/packages/harness/src/pi-runner.test.ts` to assert an async
  subscriber is awaited before `runTurnMessage()` resolves.
- Update `TurnDispatcherRunner.subscribe` in
  `workspace/packages/agentic-do/src/turn-dispatcher.ts` only if needed. That
  dispatcher intentionally uses synchronous state transitions, so its listener
  can remain sync. The `PiRunner.subscribe` surface can accept both sync and
  async listeners without forcing every consumer to be async.

This change is small, local, and directly aligned with upstream semantics.

## Suggested integration plan

1. Fix `PiRunner` event forwarding/back-pressure.
   - This is independent of unreleased upstream APIs.
   - It should make the current `ContentBlockProjector` contract true.

2. Add focused tests.
   - `PiRunner` awaits async subscribers.
   - Projector operations complete before `runTurnMessage()` settles.
   - Async subscriber rejection is logged and does not crash the worker unless
     we intentionally choose stricter propagation.

3. Keep `TurnDispatcher` sweep as-is.
   - Existing tests already cover stranded steering and partial absorption.
   - Add an upstream-reference comment update if desired, but do not remove the
     logic.

4. Watch for a Pi release after `0.74.0`.
   - Current upstream `main` is ahead of npm.
   - Once released, update `@earendil-works/pi-agent-core` and
     `@earendil-works/pi-ai`, then run targeted DO/harness tests.

5. After updating, reassess failure handling.
   - Upstream's full lifecycle failure events may let us simplify some local
     terminal-error special cases.
   - Avoid changing behavior without tests around credential-required,
     provider-thrown, user-aborted, and dispatched-method-aborted turns.

6. Design a NatStack `prepareNextTurn` equivalent.
   - Use upstream as a pattern, not a direct import.
   - It should refresh channel-derived tool roster/config/model state between
     Pi turns while preserving NatStack DO persistence and recovery semantics.

## Risks and open questions

- Awaiting projector/channel operations may increase turn completion latency.
  That is probably correct because it matches Pi semantics, but tests should
  ensure it does not deadlock if the channel DO is slow or unavailable.
- It is not yet clear whether downstream listener failures should be swallowed,
  converted to visible channel errors, or allowed to fail the Pi run. Current
  NatStack behavior logs and continues; changing that would be a product
  decision.
- `prepareNextTurn` may require a new async boundary between `PiRunner` and
  `AgentWorkerBase`. The existing channel-tools extension uses synchronous
  cached roster reads, so a naive direct async channel call inside the extension
  would not fit the current shape.
- Upstream `AgentHarness` has its own session abstraction and compaction model.
  Porting it directly could conflict with NatStack's channel transcript and DO
  fork semantics.

## Verification commands used locally

These commands were already run during dependency branch validation before this
handover note:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/mobile exec jest --runInBand
pnpm vitest run workspace/packages/harness/src/pi-runner.test.ts workspace/packages/agentic-do/src/content-block-projector.test.ts workspace/packages/agentic-do/src/turn-dispatcher.test.ts workspace/packages/agentic-do/src/agent-worker-base.integration.test.ts
pnpm run type-check
pnpm build
```

This handover note itself did not implement code changes beyond creating this
document.
