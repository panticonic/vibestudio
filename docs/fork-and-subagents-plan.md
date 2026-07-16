# Conversation Forking & Subagents — Design Plan

**Status: APPROVED 2026-07-03; semantic VCS contract refreshed 2026-07-14.**
Conversation/channel/runtime decisions remain here. All file-history, comparison,
integration, conflict, commit, and provenance semantics are delegated to
[provenance-aware-diff-merge-plan.md](provenance-aware-diff-merge-plan.md);
older patch-combination and content-derived ancestry assumptions have been
removed instead of retained as compatibility guidance.

The durable-clone review established four still-binding requirements: clone
operations are caller-keyed and crash-idempotent across context and entity
storage; recursive clone journals per-descendant progress; subagent runs end
only through the child `complete` tool or explicit parent cancellation; and
the existing silent-agent publication path is generalized into one
`publishPolicy` plus `say` implementation.
This plan covers two interacting extensions to the agentic messaging system:

- **Part A — Conversation forking as a first-class UX**: edit a past message (or pick any point in history) and resume the conversation from there as a fork; surface forks to all participants with notification and one-click switching.
- **Part B — Subagents**: a parent agent spawns child agents in forked file contexts (uncommitted changes intact), communicates over dedicated channels, supervises with low noise, inspects via child panels, and semantically integrates selected work without touching `main`.

Both are deliberately treated as **test cases for the platform abstractions**: where the current primitives make these features awkward, we change the primitives (no backward compatibility — this is pre-release; replaced paths get deleted).

Authoritative background specs: `docs/ws1-agent-loop-spec.md` (agent loop), `docs/ws2-channel-spec.md` (channel DO), `docs/stage0-unified-log-spec.md` (gad log + forkLog), and `docs/provenance-aware-diff-merge-plan.md` (the sole host/GAD semantic VCS boundary and integration contract). `docs/agentic-architecture.md` and `docs/pi-architecture.md` are historical; do not trust their specifics.

---

## Part 0 — Current-state review (fork UX audit)

### What already exists and is sound

The fork **mechanism** is mature; the fork **product** does not exist. Inventory:

| Capability                                      | State                  | Where                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Semantic channel+agent fork                     | ✅ implemented, tested | `workspace/packages/channel-fork/src/fork.ts`, `workspace/workers/fork/index.ts`                                                                                                                                                                                                           |
| No-copy log fork at a seq                       | ✅                     | semantic control plane `forkLog` (`workspace/packages/semantic-control-plane/src/index.ts:2760`; lineage cols `parent_log_id`/`fork_seq`/`fork_hash` declared at `:1118`, populated at `:2810`), `ChannelLog.forkFrom` (`pubsub-channel/log-store.ts:147`)                                                                |
| Agent DO clone + trajectory re-root             | ✅                     | `agent-vessel.ts` `canFork`/`postClone` (:2941/:2949), `onChannelForked` hook (:451)                                                                                                                                                                                                       |
| Channel DO clone                                | ✅                     | `channel-do.ts` `postClone` (:1548) — re-homes context, forks log, rebuilds policy state by replay                                                                                                                                                                                         |
| **File-context fork incl. uncommitted changes** | ✅ **canonical**       | `runtime.cloneContext` delegates to the semantic workspace context-fork operation. The child receives the same committed event and exact working-head value; later applications advance either context independently without flattening provenance or inventing ancestry. |
| Rollback on partial fork failure                | ✅                     | `fork.ts` → `runtime.destroyContext`                                                                                                                                                                                                                                                       |
| Policy/conversation state survives fork         | ✅ (fixed by WS2)      | `policyHost.rebuildAfterFork()`                                                                                                                                                                                                                                                            |

**Answer to the open question: yes, we support forking contexts with uncommitted changes intact.** Uncommitted work is the application chain ending at the parent's exact working head. Forking shares that immutable head value; it does not copy rows, convert applications into committed history, or infer lineage from rendered bytes.

### Gaps and design debts (what "rework" means)

1. **Zero generic UX.** The only caller of the fork machinery is the news panel's deep-dive (`workspace/panels/news/index.tsx:705`). Nothing calls the fork worker; chat panels have no fork affordance.
2. **Fork lineage is one-directional and buried.** The child records `forkedFrom`/`forkPointId` in its KV `state` (`channel-do.ts:1567-1568` via `setStateValue`), reachable only via generic `getState()` (`channel-do.ts:1582`, which dumps `SELECT * FROM state`) — and today **nothing consumes it**. The **parent has no record that it was forked** — no parent→children index, no way to enumerate a fork tree, no event anyone can subscribe to. This is the core structural gap: forks are invisible.
3. **No notification.** Other participants (human or agent) never learn a fork happened.
4. **Edit is unread-only.** `PubSubClient.editMessage` + `message.edited` (`events.ts:43`) apply only to messages not yet read (outbox editing, `useChatCore.ts:907`); the unread-only rule is enforced in the reducer at `handlers.ts:278` — the edit is dropped once `readBy` is non-empty. Editing _read_ history is semantically a fork, not an edit — the primitives are unrelated and should stay unrelated. Edit-a-past-message must be built on fork-at-seq, not on `message.edited`.
5. **`canFork` requires ≤1 subscription** (`agent-vessel.ts:2942`). Fine today; becomes a hard blocker the moment agents are multi-channel — which Part B makes the norm for any supervising agent. `postClone` must become per-channel-aware (§C3).
6. **Context forks must preserve semantic state exactly.** A fork is not a content snapshot, synthetic commit, repository-head clone, or copied batch of edit rows. The semantic authority assigns the parent's committed event and exact working head to the child context. This preserves every event, work-unit, change, application, and decision identity and makes subsequent divergence an ordinary consequence of immutable pointer advancement (§B5).
7. **Human participants are dropped on fork** (`postClone` clears `participants`). Correct behavior (a fork starts fresh), but there is no re-invitation path — that's what the fork notification + switch UX provides.
8. **No fork identity.** Forks get random channel ids and no label; a fork tree with three unnamed siblings is unusable.
9. **Review and adoption use the semantic VCS vocabulary.** A supervisor asks the child to commit its complete local chain, compares that source event with the parent's exact working head, and integrates source change identities in small steps. There is no cherry-pick-shaped patch transport, path staging identity, context-specific read API family, or second merge model (§B5).

Verdict: the plumbing is the good kind of boring — keep it. All work is (a) lineage + notification as first-class durable data, (b) UX, (c) the two robustness debts (5) and (6).

---

## Design principles

1. **The log is the source of truth — including for forks.** Fork lineage is recorded as durable envelopes on the _parent_ channel log, so notification, roster folding, replay, and audit all come for free. No side registries.
2. **Editing read history = forking.** The unread-outbox edit path stays as-is (it is a different feature: fixing a message the agent hasn't seen). Read-history edit creates a fork rooted just before the edited message and seeds the edited text as the fork's first new message.
3. **A subagent run is a durable invocation on the parent's trajectory.** The parent's LLM sees spawn → progress (`say`) → final report exactly like an async tool call (`invocation.started/output/completed|failed|cancelled|abandoned`). The parent↔child _channel_ is the transport and the inspection surface, not a second bookkeeping system.
4. **Child integration never touches `main`.** Child→parent adoption compares a child committed event with the parent's exact working head and integrates stable change identities into local applications. A later explicit `vcs.commit` and protected `vcs.push` remain separate choices.
5. **No backward compatibility.** Replaced surfaces are deleted in the same change (e.g. the news panel's bespoke fork call migrates to the generic service; the ≤1-subscription `canFork` gate is removed, not special-cased).
6. **Fix the primitive, don't design around it.** Where a feature reveals a limitation in a platform abstraction (lossy context fork, single-subscription channel fork, non-recursive clone), the plan changes the abstraction rather than adding feature-level workarounds. These features are the test case for the abstractions; a workaround would defeat the purpose.

---

## Part A — Conversation forking & edit-resume

### A1. Fork lineage model

**New durable event kinds** in `@workspace/agentic-protocol` (`events.ts`, `schemas.ts`):

```ts
// Appended to the PARENT channel log by the fork service after a successful fork:
"channel.forked" {
  forkId: string;              // = forked channel id
  forkedChannelId: string;
  forkedContextId: string;
  forkPointId: number;         // parent seq the fork is rooted at
  label: string;               // auto: "fork @ <short excerpt of fork-point message>"; renameable
  reason: "edit" | "branch" | "deep-dive" | string;
  actor: ParticipantRef;       // who forked
  seededMessageId?: string;    // for edit-forks: the replacement message in the child
}
"channel.fork_renamed" { forkId, label }
"channel.fork_archived" { forkId }        // hide from roster; context GC decoupled
```

- `reduceChannelView` (`reducer-channel.ts:134`) folds these into `ChannelViewState.forks: ForkProjection[]` — the fork roster is a pure projection of the parent log, exactly like the trajectory `branch.*` projections it mirrors (precedent confirmed: `reducer-trajectory.ts:27`/`:138` fold `branch.*` into `branches`). `ChannelViewState` (`reducer-channel.ts:90`) has **no** `forks` field today and none of the three event kinds exist in `events.ts` — all net-new; downstream exhaustive switches over event kinds must add them. **Semantics:** because `channel.forked` is appended to the channel that was forked _from_, a channel's `forks` projection enumerates its **direct children**, not its siblings — sibling lists and full-tree views walk `getProvenance` up and read each ancestor node's own `forks` (§A4).
- The **child** side already records `forkedFrom`/`forkPointId`; promote this to a typed **`getProvenance()`** RPC on the channel DO (net-new — today the DO exposes only `getPolicyState`/`getContextId`/`getConfig`/`getParticipants`/`getState`, and lineage is read solely by peeking `getState()`) — a discriminated union covering _every_ way a channel comes to exist, not just forks: `{ kind: "root" }` | `{ kind: "fork", forkedFrom, forkPointId, rootChannelId }` | `{ kind: "task", parentChannelId, parentContextId, runId }` (task channels are _fresh_ channels, §B1 — their provenance is recorded at creation, not inherited from a log fork). Panels landing anywhere can render breadcrumbs and walk _up_.
- Fork trees deeper than one level fall out naturally: each fork's parent log carries its own `channel.forked` events. The roster UI shows the sibling set for the current channel plus a parent breadcrumb; a full-tree view can walk lineage lazily.
- Semantic control-plane `forkLog` already persists `parent_log_id`/`fork_seq`/`fork_hash` (`:1118`, populated at `:2810`); expose it as `getLogLineage(logId)` (net-new) for tooling/debugging so the durable substrate and the channel-level events can be cross-checked.

Because `channel.forked` is a durable envelope on the parent channel, **every subscriber — panels and agents — gets fork notifications through the pipe they already have.** No new delivery mechanism.

### A2. Triggering UX (chat panel)

Message-level affordances in `MessageCard`/`MessageList` (hover/long-press menu):

- **"Fork from here"** — on _any_ message. Fork point = that message's seq (the fork includes it).
- **"Edit & fork"** — on the user's _own_ messages that are already read (unread ones keep the existing in-place outbox edit; the menu shows whichever applies, so the user just sees "Edit"). Opens the composer pre-filled with the original text; on send: fork point = seq **before** the edited message, then the edited text is sent as the fork's first message.
- **"Edit & fork" on _agent_ messages** — DECIDED (§G3): also supported, as a steering tool ("no — here's what you should have said, continue from that"). Fork point = seq before the agent message; the replacement is published in the fork **attributed to the user, marked `replaces: <original messageId/seq>`** — the log never pretends the agent authored it. Agents' trajectories in the fork see the replacement as an authoritative user-provided substitute for their prior turn (the trajectory re-root drops the original turn; the replacement arrives as a normal inbound message carrying the `replaces` marker, so the reducer can render it in-place as an edited agent turn while keeping authorship truthful in the durable log).

Plus a channel-level **"New fork"** in the ChatHeader menu (fork at current head — "let me try something without polluting this thread").

Agent-facing: the same operation is exposed as a channel method so agents can fork conversations programmatically.

### A3. Fork execution flow

**Fork is a durable operation owned by the parent channel DO** — not a stateless worker saga. Today's fork worker is a stateless fetch handler whose rollback only runs inside a caught exception; a crash mid-flow can leak an unadvertised live clone. Since the parent channel already owns fork _lineage_, it also owns the fork _operation_: `PubSubChannel.fork(opts)` (new RPC), which

1. **journals** a `fork_ops` row (forkId, opts incl. seed, phase) in the parent channel's SQLite _before_ acting — `opts` include `{ forkPointPubsubId, seed?, label?, reason }`, with `forkPointPubsubId = editedMsgSeq - 1` for "Edit & fork";
2. drives the phases **idempotently** — `cloneContext` → clone `postClone`s → **seed append to the child log** → **`channel.forked` append to the parent log** (with `reason`, label, `seededMessageId`) → mark done — recording each phase in the journal;
3. **reconciles on alarm/wake** (the channel DO already runs an alarm, `channel-do.ts:1442` — the reconciler multiplexes onto it): an op found mid-phase resumes from its journal or, if unresumable, rolls back via `destroyContext`. The appends are idempotent by construction (deterministic envelopeIds `fork-seed:{forkId}` / `fork-event:{forkId}`). **The clone is NOT idempotent today, and this is a hard prerequisite (§E1):** `cloneContext` mints a fresh `randomUUID()` target id (`runtimeService.ts:512`) and takes no key, so a crash between the clone returning and the journal recording its id orphans a live, unadvertised clone the reconciler can never find. `cloneContext` must therefore take a **caller-supplied deterministic target id / idempotency key** (e.g. `fork:{forkId}`) so a resumed clone returns the same child rather than minting a second one. With that in place, no crash window can leave either an advertised-but-empty fork or an unadvertised live clone.

**Two new capabilities this move requires.** (a) The channel DO must gain **host-call access** — today it has _no_ `callMain` and never invokes runtime services; owning the fork op means it drives host `runtime.cloneContext`/`runtime.destroyContext` (a userland→host call, directionally fine per the boundary rule, but a new coupling that puts the transactional journal _across_ the DO↔host RPC boundary — the reason the idempotency requirement above is load-bearing). (b) When the parent has live subagents, this same op drives the **recursive** clone (§D); §A3's single-context phase list does not by itself cover crash-reconcile of a _partially completed_ recursive clone — that contract is pinned in §D/§E1.

The stateless fork worker (`workspace/workers/fork`) is **deleted** (no back-compat); `@workspace/channel-fork`'s orchestration moves into the channel DO, and the `forkConversation(rpc, opts)` client helper calls the parent channel method.

The **seed** carries the replacement message: author (the forking user), content blocks, and the optional `replaces: { messageId, seq }` marker (§A2). It lands via a new **service-authored append** on the forked channel — `appendSeed`, caller-asserted to the owning fork op (the same DO-trust plane as `postClone`: `@rpc({ callers: ["worker", "server"] })`, `channel-do.ts:1547`) — writing a normal _primary_ user-authored message envelope with an explicit `onBehalfOf` actor and audit fields, **without requiring a participant-roster entry** (the clone's participants table is emptied post-fork by design, `channel-do.ts:1571`; and the ordinary `publish` guard is a _caller-identity_ check — `caller.callerId === participantId`, `channel-do.ts:788`/`:385`, not roster membership — and is untouched). **Security note (elevated to an §E3 acceptance check):** service-authored appends have precedent (`appendDurable` with `senderId: "system"`, `channel-do.ts:1048`/`:1375`), but those are _system_-attributed; `appendSeed` is the first path that forges a **human-attributed** primary message with no roster entry, so an escape would let something post _as the user_. It MUST be hard-scoped to the owning fork-op caller and unreachable by userland agents — an explicit adversarial test in §E3. This is NOT the `forceInitialPrompt` mechanism — that sends `tier: "secondary"` system-originated support prompts (`useChatCore.ts:838`) and cannot carry `replaces`; it stays reserved for its existing new-chat use.

The panel then navigates to the fork (A4) and subscribes — pure navigation, nothing pending; a panel crash at any point leaves a fork that is either complete and advertised or fully rolled back. Agents in the fork receive the seed on their post-clone replay/wake and respond per their normal respond policies — the conversation _resumes from the edit_ with full prior context, which is the entire point. Plain "Fork from here" and "New fork" are the same call without `seed`.

### A4. Fork roster & switching

- **ChatHeader** gains a fork switcher next to the participant roster: current branch name, dropdown listing sibling forks + parent breadcrumb (from `getProvenance`). Each entry: label, fork-point excerpt, relative time, actor, unread indicator. **Sourcing correction:** `ChannelViewState.forks` of the _current_ channel projects _its own_ children (forks rooted at it), NOT its siblings — `channel.forked` events live on the **parent** log (§A1). So the sibling list is read from the **parent** channel's `forks` projection (`getProvenance().forkedFrom` → parent channel → its `ChannelViewState.forks`), a durable roster read/subscription on the parent. `subscribeLineage` is signal-only (`fork.head_changed` live badges) and does **not** carry the roster; every roster comes from a channel's own `forks` projection.
- **Switching = navigating the panel**: primary action updates `panel.stateArgs` (`channelName`, `contextId`) and reconnects — same panel, new channel + context (cross-context navigation exists via `buildPanelLink`, `panelLinks.ts:48`; `contextId` is the first-class cross-context trigger at `:61`, `channelName` rides in the chat panel's `stateArgs`, `panels/chat/types.ts:14`). Secondary action "Open in new panel" → `openPanel("panels/chat", { stateArgs: { channelName, contextId } })` as a child panel for side-by-side comparison (the news panel already issues this exact shape, `panels/news/index.tsx:748`).
- **Live unread/changed badges via lineage signals** — no polling. The fork tree has a natural hub: the **root channel** (every fork knows its root via `getProvenance().rootChannelId`). Each channel in the tree reports its durable head advances to the root (debounced, through the `forkedFrom` chain), and the root fans out ephemeral `fork.head_changed { channelId, headSeq }` signals to **lineage subscribers** — a signal-only subscription any panel in the tree holds alongside its main channel connection (`subscribeLineage`). The panel keeps per-fork read cursors in stateArgs; `channel.forked` events badge _new fork created_, `fork.head_changed` badges _fork has new messages since your cursor_ — both live, across the whole tree, from one extra lightweight subscription. **Implementation note:** the ephemeral-signal transport already exists (`sendSignal` / `broadcast({ kind: "signal" })`, `channel-do.ts:921`, delivered with no log append), but there is **no signal-only subscription** today — `subscribe` (`channel-do.ts:463`) always delivers durable replay + live — so `subscribeLineage` is a new subscription _mode_, not a reuse. It is also O(depth) fan-out up the `forkedFrom` chain with the root as a single hub; fine at current scale, and §H already requires badges to reconcile from durable state on open so a missed signal cannot wedge the UI.
- **Fork-tree view**: alongside the dropdown, a full lineage tree view (walking `getProvenance` breadcrumbs up and `ChannelViewState.forks` down per node, lazily) rendered as a panel overlay from the switcher's "Show tree" action, with the same live badges.

### A5. Notifications

Two layers, both driven by the durable `channel.forked` event:

- **In-panel**: subscribers of the parent channel fold the event into the view → the fork switcher badges and a lightweight inline system row in the message list ("⑂ Alice forked this conversation from message N — Switch").
- **Shell toast** for participants whose panel isn't focused: `runtime.notifications.show({ type: "info", title: "Conversation forked", actions: [{ label: "Switch" }] })`, action → panel navigation as in A4. Wired in the chat panel (it owns the channel subscription), not in the host.

Agents receive the same envelope; default respond policies ignore it (it is not a message). Agents that _want_ to react to forks can, via `onChannelEvent`.

### A6. Robustness rework

1. **Per-channel fork for multi-subscription vessels** (prerequisite for Part B coexistence, §C3): replace the `subscriptions.count() <= 1` gate (verbatim at `agent-vessel.ts:2942`). `postClone(parentChannelId, …)` becomes "fork _this_ subscription": re-root the trajectory for the forked channel, rename that subscription, and **drop all other subscriptions in the clone** (the clone is a new entity; it must not ghost-join the parent's other channels). `canFork` then only vets per-channel invariants (e.g. no open method calls it cannot reconcile — existing `reconcilePendingCalls` logic, `calls.ts:886`, already run by `postClone` at `channel-do.ts:1577`).
2. **Migrate the news panel** deep-dive to the generic `forkConversation` helper + `channel.forked` lineage; delete its bespoke wiring.
3. **Typed lineage surfaces**: `getProvenance()` on the channel DO; `getLogLineage()` on the semantic control plane; delete ad-hoc `getState()` peeking.

---

## Part B — Subagents

### B1. Model: subagent run = invocation + task channel

When a parent agent spawns a subagent:

1. **Create the child context** via the pinned `createSubagentContext({ parentContextId, ownerEntityId, targetKey })` (§E1) — one op that mints the child context (deterministically from `targetKey`), forks the parent's file state into it (uncommitted changes intact, via `forkContext`; provenance recorded §B5), **and records the `lifecycle` edge** in the context-relationship registry (§B7). This is the single pinned entry point for creating a subagent context; the vessel does not assemble it from primitives, so WS-3 and WS-5 cannot diverge on where the lifecycle edge is written.
2. **Create a task channel** `task-{uuid}` bound to the child context.
3. **Create the child agent entity** in the child context and subscribe it to the task channel. The parent→child ownership edge already exists but is **server-derived, not a caller argument**: `createEntity` (`runtimeService.ts:214`) sets `parentId: caller.runtime.id` from the _verified caller_ (`:359`) — the create spec has no `parent` field, so there is no `runtime.createEntity({ parent })` API (an earlier draft's `:56` citation pointed at the internal `prepareWorker` hook). The edge lands correctly _iff the spawning parent agent's runtime is the caller_. Note this is an **entity→entity** edge; the **context→context** relationship the subagent lifecycle needs is the net-new registry in §B7.
4. **Subscribe the parent** to the task channel with a supervisor wake policy (§B3).
5. Record the whole run on the **parent trajectory as a durable invocation**, using the existing terminal vocabulary exactly (no semantic overload): the spawn tool emits `invocation.started`; child `say` messages and its end-of-turn report surface as `invocation.output`; success closes with `invocation.completed` (which is success-only by schema — `terminalOutcome: "success"`), a failed run closes with `invocation.failed`, and a parent-aborted run closes with `invocation.cancelled`. Integration status rides in the terminal payload's subagent block. **The terminal transition has an explicit trigger, not a heuristic:** the child emits it by calling a child-side `complete({ report, outcome })` local tool (§B2) — until then the run stays OPEN. A subagent is a normal agent that goes idle between turns, so _turn closure does not complete the run_ (that would close it after the first turn) and an idle child is not "done" (that would leave it open forever); only `complete` or an explicit parent abort/close is terminal. The supervisor's turn-final wake (§B3) therefore treats each turn report as `invocation.output` (progress) and only `complete` as done. The parent's LLM context therefore contains the subagent run in the shape it already understands — an async tool call with streamed progress and standard error folding (`isError` behaves correctly for free). **Verified airtight:** `invocation.completed` is success-only at both the TS type (`events.ts:291`) and Zod (`schemas.ts:221`, `terminalOutcome: z.literal("success")`) levels; `invocationTerminalKindForOutcome` / `validateInvocationTerminalOutcomeForKind` (`constants.ts:177`) enforce the outcome→kind pairing; terminal invocations fold to a `tool-result` with `isError: false` on completed and `true` on failed/cancelled/abandoned (`fold.ts:368`/`:379`). An ephemeral `invocation.progress` kind (`events.ts:46`) the executor already emits is available for live-inspector deltas alongside `invocation.output`.

The task channel is not redundant with the invocation: it is the durable transcript of the child (inspectable, §B6), the medium for mid-run steering (parent — or the human — can post follow-up instructions into it), and the substrate that makes a subagent just _an agent on a channel_, with zero special cases in the vessel.

### B2. Spawn modes

Exposed to agents as one local tool, `spawn_subagent`, with two modes:

- **`mode: "fresh"`** — a new agent (configurable worker source, default the standard chat agent; model/thinking/approval config in `stateArgs.agentConfig`). Task prompt is seeded as the first message on the task channel. Cheap, isolated LLM context.
- **`mode: "fork"`** — preserve the parent's LLM context: the child's trajectory log is created via semantic control-plane `forkLog` from the **parent agent's trajectory** at the current seq (exactly the mechanism `postClone` already uses for channel forks, `agent-vessel.ts:2949`), so the child starts knowing everything the parent knows. New vessel init path: `initFromTrajectoryFork({ parentLogId, seq, taskChannelId, contextId })` — a sibling of `postClone` that re-roots identity + trajectory _without_ cloning DO storage (outbox/fold caches start empty, as in postClone).

Tool surface (agent-loop `local_tool` → effect → runtime calls; parameters abridged):

```ts
spawn_subagent({ mode, task, source?, config?, label? })
  → { runId, taskChannelId, contextId }        // runId = invocationId
send_to_subagent({ runId, message })            // posts into the task channel
read_subagent({ runId, afterSeq? })             // §B3; task-channel envelopes since cursor (backs "manual" wake)
inspect_subagent({ runId, query })              // §B5; authorized semantic compare/inspect
integrate_subagent({ runId, selection })        // §B5; all or named source changes
close_subagent({ runId, discard?: boolean })    // unsubscribe, destroy entity+context (unless kept for inspection)

// CHILD-side tool, in the SUBAGENT's own roster (not the parent's) — the explicit terminal trigger:
complete({ report, outcome?: "success" | "failed" })  // closes the run: publishes `report` as the final
                                                       // output and emits the TERMINAL invocation event on
                                                       // the PARENT trajectory (success→completed, failed→failed).
```

Depth/fan-out guarded by config (`maxSubagentDepth`, `maxConcurrentSubagents` — net-new on `AgentLoopConfig`, `state.ts:39`, which has none of them today), enforced at spawn time; the existing `agentHopLimit` machinery (`addressing.ts:118`, `DEFAULT_AGENT_HOP_LIMIT = 4` at `:45`) already prevents chat loops on the task channel. The whole spawn/steer/read/inspect/merge/pick/close tool surface above is confirmed absent today (all net-new) **except** `say` (§B4), which already exists in a narrower form and must be generalized rather than re-added. `initFromTrajectoryFork` is likewise net-new (confirmed absent).

### B3. Channel topology & supervisor wake policy

The parent is now genuinely multi-channel (its home channel + one per live subagent). Subscriptions already support this (`subscription-manager.ts`, per-channel `contextId`/`config`). What's missing is **wake discipline** — today every envelope wakes the driver for a respond decision.

Add a per-subscription **`wakePolicy`** to the subscription config (`SubscriptionConfig` already carries per-channel `context_id` + `config`, `subscription-manager.ts:24` — the right home). **Mechanism correction:** the respond/wake decision does not resolve "in `@workspace/agent-loop` policies" as the field's home suggests — it resolves in the **vessel**, via `resolveShouldRespond` (`agentic-protocol/addressing.ts:102`, called from `agent-vessel.ts:1704`; today every inbound `message.completed` runs it then wakes the driver, `agent-vessel.ts:1403-1420`). `RespondPolicy` is _typed_ in agent-loop (`state.ts:12`) but _applied_ in the vessel, so `wakePolicy` resolution lands in WS-5 (vessel) even though its config field is declared in agent-loop (WS-4). The policy values, resolved alongside `RespondPolicy`:

- `"every-envelope"` (default; current behavior — home channel)
- `"turn-final"` — buffer envelopes; wake the driver only on `turn.closed`, `say`-flagged messages (§B4), `invocation.*` addressed to us, or mentions. Buffered context is folded into the parent's next turn as the invocation's `invocation.output` payload, **summarized to the child's report, not the full transcript** — the full transcript stays in the task channel for inspection.
- `"manual"` — never auto-wake; the parent reads the channel only when its own turn logic asks, via a `read_subagent` local tool (returns the task channel's envelopes since the parent's cursor).

Supervisor default: `"turn-final"`. This is the "multi-channel infrastructure, augmented" piece: the augmentation is precisely subscription-level wake policies plus routing child reports into the parent trajectory as invocation output.

### B4. Subagent chattiness: publish policy + `say` tool

Today every model call's text becomes a `message.completed` envelope on the channel (`effects.ts:362`; the only existing publish gate is `shouldPublishModelOutcome`, `effects.ts:460`, keyed on per-turn metadata — not a config-level policy). For subagents, add to `AgentLoopConfig`:

- **`publishPolicy: "all" | "turn-final" | "say-only"`** — under `"turn-final"`, intermediate model text within a turn is retained in the trajectory (`message.completed` trajectory events, streamed as ephemeral deltas so live inspectors still see progress) but **only the end-of-turn message is published as a durable channel envelope**. Under `"say-only"`, **no** model message is published at all — the agent speaks _only_ through the explicit `say` tool (plus turn-boundary markers). `"say-only"` exists as its own mode because `"turn-final"` does **not** subsume `silentPolicy()`: turn-final still publishes the end-of-turn message (a behavior change for a silent agent, and noise after a `say`). The silent agent migrates onto `"say-only"` (behavior preserved exactly); subagents default to `"turn-final"`.
- **`say` local tool** — explicit mid-turn publication: emits a durable channel message flagged `saliency: "say"`, which also passes the supervisor's `"turn-final"` wake filter. This is the subagent's "progress worth reporting" valve.

**Reconcile with what already exists — do not add a parallel path.** A `say` tool and a publish-suppression policy are _already implemented_ for the silent agent: `createSayTool` (`silent-agent-worker/index.ts:51` — a worker-level `AgentTool` that calls `channelClient.send` directly, with no `saliency` flag) plus `silentPolicy()` (`agent-loop/src/policies/index.ts:343`), which suppresses all publication except turn open/close. That is the `"say-only"` publish mode (above) + `say`, in a narrower, config-unaware form — **not** `"turn-final"` (which additionally publishes the end-of-turn message; a reviewer correctly flagged that turn-final does not subsume `silentPolicy`). Per this repo's "fix the primitive / no back-compat / audit dead code" policy, WS-4 must **generalize `silentPolicy` into the config-level `publishPolicy` (as the `"say-only"` mode), fold `saliency: "say"` into a single core `say` local tool, and migrate the silent agent onto them — deleting the bespoke `createSayTool` and `silentPolicy`** — not ship a second mechanism beside them.

Subagent default config: `publishPolicy: "turn-final"` + `say` in the tool roster. This is a pure agent-loop/fold change (new effect gating in `derivePendingEffects` + the generalized tool), and it is generally useful beyond subagents (e.g. quieter agents in crowded human channels — which is exactly what the silent agent is).

### B5. Context fork and semantic integration

The VCS contract in this section is a specialization of
[provenance-aware-diff-merge-plan.md](provenance-aware-diff-merge-plan.md).
That document owns the data model and public method shapes; this plan defines
how conversation forks and subagent runs use them.

**Fork shares exact immutable values.** The semantic authority's context-fork
operation initializes the child with the parent's committed event and exact
working-head value. This is O(1) pointer sharing over immutable data:

- committed workspace events remain committed workspace events;
- inherited working applications remain visible as inherited working
  applications, with their work-unit, change, decision, and causal edges intact;
- neither side gains a synthetic commit, repository head, copied edit row, or
  content-derived ancestry edge;
- the first later mutation CAS-advances only its owning context pointer, so
  parent and child diverge naturally;
- destroying either context removes only its mutable pointer and authority
  edge. Reachable immutable semantic facts remain available through any
  surviving event or application root.

The context relationship registry records why the context exists
(`lineage` for conversation forks, `lifecycle` for subagent ownership), but
that registry is authorization and lifecycle metadata. It is not a second VCS
ancestry graph.

**Review begins with exact comparison.** Integration requires a committed
source event, so the child first commits its complete local application chain
without pushing. `inspect_subagent` compares that event with the parent's exact
working head and pages source changes and their dispositions. Read-only
follow-ups use the ordinary `vcs.inspect`, `vcs.neighbors`, `vcs.history`, and
`vcs.blame` walks over returned typed roots. Authority derives from the
lifecycle or lineage relationship; no caller receives another context's mutable
pointer as ambient authority.

**Adoption is integration, not merge or cherry-pick.** The take-everything
action repeatedly asks `vcs.integrate` to adopt actionable source changes from
the same committed event. Review may instead choose named source change IDs.
Each call:

1. revalidates the exact source event, expected target working head, and caller
   reachability;
2. plans applicability and typed conflicts without touching the checkout;
3. records one adopted, reconciled, or declined decision as an ordinary local
   work unit/application;
4. returns the new working head or a typed conflict without creating invalid
   checkout content;
5. preserves cross-file, move/copy, repository-lifecycle, causality, and
   dependency relations because the request names semantic changes rather
   than reconstructed patches.

A parent may keep compatible integrated work while declining or deferring
conflicting changes. Reconciliation records exact target-state evidence and a
rationale; an ordinary `vcs.edit`, `vcs.move`, or `vcs.copy` may first create
that truthful target state. `vcs.commit` then commits the complete local
application chain. No provisional
conflict tree, generated marker text, sidecar lifecycle, abort
protocol, auto-checkpoint, or commit-gating ritual exists.

**Main remains a separate protected effect.** Child adoption changes only the
parent context's working head. Publishing later is the normal explicit
`vcs.commit` → `vcs.push` path, with host approval and protected-event CAS.
Subagent tools never target `main` implicitly.

**Tool and UX mapping.**

- `inspect_subagent({ runId, query })` returns bounded comparison or inspector
  projections for the authorized child source.
- `integrate_subagent({ runId, selection })` maps take-everything, named changes,
  reconciliation, or explicit decline to one or more `vcs.integrate` calls.
- The SubagentRunCard and fork tree open the shared semantic diff/review UI.
  File rows are presentation; actions retain the underlying change IDs.
- The result is reported as `integrated`, `conflicted`, or `discarded`.
  A conflicted result means non-conflicting selections may already be present
  and conflict records remain inspectable; it never means the checkout
  contains invalid files.

Required verification: fork a context with uncommitted applications, prove the
child and parent initially name the same committed event and working head,
mutate each side, commit the child locally, compare the child event, integrate
one cross-file change at a time, resolve one typed conflict with truthful
evidence, commit the parent's complete chain, and prove that `main` did not
advance.

### B6. Inspection UX

- The parent's chat panel renders subagent runs from the trajectory invocation events: a **SubagentRunCard** (label, status, live `say` feed, integration state) in the message list where the spawn happened.
- **"Open"** → `openPanel("panels/chat", { stateArgs: { channelName: taskChannelId, contextId: childContextId } })` — a child panel on the task channel. It is a _normal chat panel_: the human can read the full transcript and post steering messages directly to the subagent. No special read-only mode needed (the subagent's respond policy already scopes who it listens to; default: parent + humans).
- The task channel roster shows parent + child; the panel header renders the task channel's `getProvenance()` (`kind: "task"` — parent channel, parent context, runId) as a breadcrumb back to the parent conversation.
- **"Review changes"** on the SubagentRunCard opens the shared semantic diff-review UI fed by `vcs.compare` (§B5). File and event rows retain their stable change identities, so the user can integrate everything incrementally, choose named changes, reconcile or decline a change, and inspect typed conflicts without reducing intent to paths or patches. The same review action appears on every authorized entry in the fork switcher/tree.

### B7. Lifecycle & GC

- **A real context-relationship registry is built as part of this plan** — today's `parentId` is launch-parent metadata on _entities_ only (`entitySpec.ts:120`, set server-side from the verified caller); `destroyContext` (`runtimeService.ts:570`) selects entities by `contextId` (`:575`) and traverses nothing — and a repo-wide search confirms **no context→context edge or registry exists at all today**. New: the runtime persists a typed edge on every context created by `cloneContext`/subagent spawn (alongside the context, not derived from entity records), with **two edge kinds that must not be conflated**:
  - **`lifecycle`** — "this context exists to serve that one": subagent contexts, and the internal children produced by a recursive clone. Recursive destroy cascades along these; recursive clone walks these.
  - **`lineage`** — "this context descends from that one": conversation forks. Access/authorization + provenance only — **never** cascaded: a fork is a first-class peer whose GC is decoupled (`channel.fork_archived` hides it; destruction is explicit), so destroying a conversation never silently destroys its forks.

  `listOwnedContexts(contextId, kind?)` exposes the edges; `destroyContext({ recursive: true })` does post-order teardown of the **lifecycle** subtree only (and is the default for contexts with lifecycle children); semantic state inspection accepts either edge kind as an authority path. One registry, three consumers, edge-kind-aware. **Clone/destroy default asymmetry — RESOLVED (keep default-cascade):** `cloneContext` _errors_ on lifecycle children (explicit `recursive: true` required) while `destroyContext` _default-cascades_ the lifecycle subtree. This is intentional, not an oversight: clone-partial is genuinely ambiguous (a half-cloned world that looks whole), so it must be explicit; but a `lifecycle` child _exists only to serve its owner_ (the edge's own definition), so tearing it down with the owner is the semantically correct default — and it is what parent-death/reaper teardown already rely on. `lineage` children (forks) are **never** cascaded regardless. The only invariant to enforce: the cascade follows `lifecycle` edges exclusively and never crosses a `lineage` edge.

- Terminal states: success (report delivered) → parent decides integrate / discard; failed / cancelled similarly (§B1 terminal-event mapping). `close_subagent` unsubscribes both sides, destroys the entity, and destroys the context. Runs are kept for inspection until the parent explicitly closes them.
- Parent death: destroying the parent's context with `recursive: true` (the default for contexts with lifecycle children) tears down the whole subagent tree via the registry's lifecycle edges — conversation forks (lineage edges) are untouched; children that survive an explicit non-recursive teardown are surfaced in the panel via their invocations' non-terminal state until an explicit lifecycle action closes them.

---

## Part C — Shared infrastructure changes (the abstraction test-case)

Per layer, everything the two features force — this is the list that matters:

| Layer                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                             | Motivated by   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `agentic-protocol`          | `channel.forked` / `fork_renamed` / `fork_archived` events + `ForkProjection` in channel reducer; `saliency: "say"` message flag; subagent invocation payload shapes                                                                                                                                                                                                                                                                               | A1, B1, B4     |
| `agent-loop`                | `publishPolicy` gating in effects derivation (**generalizes + deletes existing `silentPolicy()`**); `say` tool (**generalizes + deletes existing `createSayTool`**); `wakePolicy` field (resolution lands in the vessel, not here); `maxSubagentDepth`/`maxConcurrentSubagents` in config                                                                                                                                                          | B3, B4         |
| `agentic-do` (vessel)       | **C3: per-channel fork** — `canFork`/`postClone` reworked to fork one subscription and drop the rest (delete the ≤1-subscription gate); `initFromTrajectoryFork` init path; `spawn_subagent`/`send_to_subagent`/`inspect_subagent`/`integrate_subagent`/`close_subagent` tools; `wakePolicy` resolution + supervisor buffering for `wakePolicy: "turn-final"`                                                                                      | A6, B2, B3, B5 |
| `pubsub-channel`            | `getProvenance()` typed RPC (root/fork/task union); **durable `fork_ops` journal + `fork()` RPC + alarm reconciler** (the fork operation moves into the parent channel DO, which **gains `callMain`** to drive host clone/destroy across the DO↔host boundary); `appendSeed` service-authored append (hard-scoped to the fork op — forges human-attributed messages); `subscribeLineage` new signal-only mode; service-authored fork-event appends | A1, A3         |
| `channel-fork`              | Orchestration moves into the channel DO; package keeps the `forkConversation` client helper; **the stateless fork worker (`workspace/workers/fork`) is deleted**; delete news-panel bespoke path                                                                                                                                                                                                                                                   | A3, A6         |
| Semantic control plane      | O(1) context fork by sharing the committed event and exact working head; authorization reachability through context relationships; bound `compare`/`integrate`/decision/inspector traversal over the one semantic workspace graph                                                                                                                                                                                                                 | B5, A1         |
| Host `vcs` service          | Thin authorization and dispatch for canonical semantic methods; checkout projection, content storage, builds, and protected-main CAS remain host effects without merge or conflict interpretation                                                                                                                                                                                                                                                  | B5             |
| `runtime` / host            | `cloneContext({ recursive, targetKey })` — compositional clone over the context ownership tree with parent/subscription/provenance rewiring + **`targetKey` idempotency** for the fork-op reconciler (today mints `randomUUID()`, `runtimeService.ts:512`); context-relationship registry (net-new — no context→context edge exists today); `destroyContext({ recursive })`                                                                        | B1, B6, D      |
| `agentic-chat` / chat panel | Message fork/edit affordances; fork switcher + badges + inline fork rows; SubagentRunCard; navigation-based switching; toast wiring                                                                                                                                                                                                                                                                                                                | A2, A4, A5, B6 |

Dead-code audit after landing (per repo policy): the unread-edit path stays (still used by outbox), but any fork-adjacent scaffolding it replaced — news-panel fork wiring, `getState()`-based lineage peeking, the `canFork` subscription-count gate — is deleted.

---

## Part D — Interaction between A and B

**Forking a conversation whose parent agent has live subagents.** The fork clones the parent context (channel + parent agent), but subagents live in _their own_ contexts — a single-context `cloneContext` won't include them, so a naive fork leaves the clone with dangling task-channel subscriptions and open invocations.

The systemic fix is to make **cloning compositional over the context ownership tree**, rather than teaching forks to amputate. Note this tree does not exist yet — today's `parentId` is per-entity launch metadata only (`entitySpec.ts:120`) and nothing links contexts to contexts; §B7 introduces the context-relationship registry (typed `lifecycle`/`lineage` edges + `listOwnedContexts`), and `cloneContext` gains `recursive: true` on top of its **lifecycle** edges (full pinned contract in §E1 — including the rule that `include` scopes the root context only while descendant contexts clone in full):

- Clone the parent context, then each child context in the ownership tree, **rewiring as it goes**: cloned children are parented to the cloned parent; task-channel subscriptions in the cloned parent point at the cloned task channels; each cloned context shares its source context's committed event and exact immutable working-head value at clone time, while lifecycle/lineage authority edges point into the cloned tree. Integration inside the cloned tree is therefore exactly as well-defined as in the original, with no shared mutable pointer or shared-child ambiguity.
- In-flight method calls / open invocations across the boundary are reconciled by the same `reconcilePendingCalls` machinery `postClone` already runs (`calls.ts:886`) — each cloned pair re-establishes its own pending state; calls that cannot be re-homed settle as `aborted-by-fork`. **Note:** `aborted-by-fork` is a **new settle reason** — today the only settle reasons are `cancelled` (`calls.ts:786`) and `abandoned` (`graceful`/`disconnect`/`replaced`, `:797`); it must be added, not assumed to exist.
- Cost is proportional to live subagents, which is bounded by `maxConcurrentSubagents`; fork remains no-copy at the log layer either way.

**DECIDED (§G1): recursive clone ships with everything else** — `cloneContext({ recursive })` is part of the single delivery, so forking a conversation with live subagents works from day one and no block/detach mode ever exists. Detach is explicitly rejected: a clone that silently aborts half its trajectory's live work is the kind of around-the-caveat behavior this plan is meant to eliminate.

**Durability of the recursive clone (open contract — pin in §E1).** §A3's journaled fork op enumerates _single-context_ phases (clone → postClones → appendSeed → channel.forked). A recursive clone must journal and reconcile a _partially completed multi-context_ clone — a crash after cloning 3 of 5 descendant contexts must resume to the same tree, not spawn a second partial one. Combined with §A3's idempotency requirement, this means **every** cloned context (not just the root) needs a deterministic, forkId-derived target id, and the fork-op journal must record per-descendant progress. This is the single largest piece of new durability work in the plan and §A3's phase list does not cover it on its own.

Conversely, **subagent lineage in inspection panels** is free: a task channel's `getProvenance()` (`kind: "task"`) points at the parent conversation and run, so inspection panels always show where they came from.

---

## Part E — Execution: one big bang, maximum parallelization

This plan is implemented as **one delivery, maximally parallel**. There are no phases, no per-stage green requirements, and no partial scope: the orchestrating agent launches all workstreams simultaneously, lets the tree be broken while they land, and runs a single integration + verification pass at the end. Only the final pass must be green.

### E1. Pinned cross-workstream contracts

So that no workstream blocks on another, the shared shapes are pinned **here** and every workstream codes against them verbatim; the integration pass reconciles any drift. Contracts already specified in-body include `channel.forked` / `fork_renamed` / `fork_archived` payloads (§A1) and the subagent tool surface (§B2). VCS method and data contracts are imported from the canonical provenance-aware plan rather than duplicated here. Additionally pinned:

```ts
// agentic-protocol
type ForkProjection = { forkId: string; forkedChannelId: string; forkedContextId: string;
  forkPointId: number; label: string; reason: string; actor: ParticipantRef;
  createdAtSeq: number; archived: boolean }
// ChannelViewState gains: forks: ForkProjection[]
// Chat message payloads gain: saliency?: "say"; replaces?: { messageId: string; seq: number }

// pubsub-channel DO
getProvenance():
  | { kind: "root" }
  | { kind: "fork"; forkedFrom: string; forkPointId: number; rootChannelId: string }
  | { kind: "task"; parentChannelId: string; parentContextId: string; runId: string }
// task provenance is recorded at task-channel creation (§B1); fork provenance at postClone
subscribeLineage(participantId)   // signal-only subscription at the tree root — NEW subscription MODE:
                                  // subscribe (channel-do.ts:463) always delivers durable replay+live today;
                                  // the ephemeral signal transport exists (sendSignal, channel-do.ts:921).
// signal kind (ephemeral, root → lineage subscribers):
"fork.head_changed" { channelId: string; headSeq: number }
// child channels report durable head advances to their root via the forkedFrom chain (debounced)

// semantic workspace state machine — exact types and schemas are canonical in
// provenance-aware-diff-merge-plan.md and @vibestudio/service-schemas.
forkContext({ sourceContextId, targetContextId })
// Initializes the child with the source's committed event and exact working
// head. It creates no workspace event, work unit, application,
// repository head, copied edit row, or content-derived ancestry edge.
// Mutable context pointers then advance independently.
// runtime service — context relationship registry (new; consumed by recursive clone,
// recursive destroy, and §B5b inspection authorization). Two edge kinds (§B7):
//   "lifecycle" (subagent contexts; cascaded, cloned) | "lineage" (conversation forks; access/provenance only)
listOwnedContexts({ contextId, kind?: "lifecycle" | "lineage" }):
  { contexts: Array<{ contextId: string; kind: "lifecycle" | "lineage"; ownerEntityId: string | null }> }
// WRITE side (NET-NEW — no edge writer exists today; listOwnedContexts is read-only). Idempotent upsert:
recordContextEdge({ contextId, ownerContextId, kind: "lifecycle" | "lineage", ownerEntityId?: string })
//   written by cloneContext (kind:"lineage", on the fork) and by createSubagentContext (kind:"lifecycle").
//   Pinning the WRITE api + the create op is what stops WS-3 (registry) and WS-5 (spawn) diverging on
//   where lifecycle edges come from.
// createSubagentContext — the pinned subagent analogue of cloneContext; WS-5 calls THIS, it does NOT
// hand-roll context creation from primitives:
createSubagentContext({ parentContextId, ownerEntityId, targetKey }): { contextId }
//   mint child contextId deterministically from targetKey (idempotent, §A3) → forkContext(parent→child)
//   → ensureContextFolder → recordContextEdge(kind:"lifecycle", ownerContextId=parentContextId).
//   Uses the existing createContext (runtimeService.ts:389, accepts a caller-supplied contextId) + forkContext.
destroyContext({ contextId, recursive?: boolean })   // recursive: post-order teardown of the LIFECYCLE subtree only

cloneContext({ sourceContextId, include?, recursive?: boolean, targetKey?: string }): {
  contextId: string
  entities: ClonedEntity[]                            // as today
  // recursive: every descendant context cloned, with a full rewiring map —
  contexts: Array<{ sourceContextId: string; newContextId: string; ownerNewContextId: string | null }>
  rewired: Array<{ sourceEntityId: string; newEntityId: string; sourceChannelId?: string; newChannelId?: string }>
}
// targetKey (NET-NEW, load-bearing for §A3): a caller-supplied idempotency key. Today cloneContext
// mints a fresh randomUUID() (runtimeService.ts:512) with no key, so the journaled fork op cannot
// resume a crashed clone without orphaning it. With targetKey the child contextId is derived
// deterministically (targetKey = `fork:{forkId}`), so a re-invocation returns the SAME child
// (contexts + entities) instead of minting a second — required for the §E3 crash test.
// NOT SUFFICIENT AT CONTEXT LEVEL ALONE: today each cloned ENTITY also gets a random newKey
// (`${src.key}~clone~{rand}`, runtimeService.ts:519) and storage is cloned into it (:527). Under
// targetKey, entity newKeys MUST derive deterministically (e.g. `${src.key}~fork~{forkId}`) AND
// cloneDurableStorage MUST be overwrite/skip-if-exists (upsert-safe), else a retry duplicates the
// DO/worker entities + storage. activateEntity already accepts a caller-supplied spec.key (:246), so
// deterministic entity keys are feasible. In a
// RECURSIVE clone, each descendant's target id derives from targetKey + the descendant's source id,
// and the fork-op journal records per-descendant progress (Part D).
// recursive semantics (Part D): descendants = the LIFECYCLE subtree from the registry (lineage
// edges — conversation forks — are never followed). `include` applies to the ROOT context only
// (the conversation-fork use: root channel + kept agents); descendant contexts always clone IN
// FULL — a subagent world is a cohesive unit, and a root-scoped include must not silently drop
// its task channels/agents. Cloned children re-parented to the cloned owner (lifecycle edges
// recreated in the clone tree); task-channel subscriptions + forkProvenance + parent entity links
// rewritten via the rewiring map; pending calls re-homed per cloned pair (unhomeable → settled
// aborted-by-fork). Non-recursive clone of a context with lifecycle children → error.

// fork operation — durable, journaled, owned by the PARENT channel DO (§A3); fork worker deleted
PubSubChannel.fork({ forkPointPubsubId, seed?: { author: ParticipantRef; blocks: Block[];
                     replaces?: { messageId: string; seq: number } }, label?, reason })
// RESOLVED (were the UNSPECIFIED `exclude?`/`replace?`): REMOVED. Entity scoping (which agents/channels the
//   fork carries) is already handled by the wrapped cloneContext's root-scoped `include`, and no stated
//   feature needs per-fork agent swapping. Add an explicit named param later if one ever does.
// fork_ops journal row first; phases idempotent (clone keyed via cloneContext targetKey=`fork:{forkId}`
// — NOT free today, see cloneContext above; appends by deterministic envelopeIds
// fork-seed:{forkId} / fork-event:{forkId}); alarm-driven reconciler (channel-do.ts:1442) resumes or
// rolls back. The channel DO gains host-call access (callMain) to drive runtime.cloneContext/destroyContext.
// order: clone → postClones → appendSeed on child → channel.forked on parent → done
appendSeed(forkOpRef, envelope)   // service-authored PRIMARY append on the forked channel: caller-asserted
                                  // to the owning fork op (postClone trust plane: @rpc callers worker/server),
                                  // explicit onBehalfOf actor + audit fields, no roster entry required.
                                  // SECURITY: first HUMAN-attributed forged append — hard-scope to the fork op (§E3).

// semantic VCS use by the vessel (§B5)
// Authority is derived from the run's lifecycle/lineage relationship; the
// caller never supplies a foreign mutable context pointer as authority.
const child = vcs.status({ contextId: childContextId })
const sourceEventId = child.clean
  ? child.committed.eventId
  : vcs.commit({ commandId, contextId: childContextId,
                 expectedWorkingHead: child.workingHead }).event.eventId
const parent = vcs.status({ contextId: parentContextId })
vcs.compare({ target: parent.workingHead, sourceEventId })
vcs.integrate({ commandId, contextId: parentContextId,
                expectedWorkingHead: parent.workingHead, sourceEventId,
                decision: { kind: "adopted", sourceChangeIds } })
// Repeat small decisions against each returned working head, then commit the
// complete parent application chain. Push remains a separate user choice.
inspect_subagent({ runId, query })
integrate_subagent({ runId, selection })
// agent-loop config additions (AgentLoopConfig at state.ts:39 has none of these today)
AgentLoopConfig += { publishPolicy: "all" | "turn-final" | "say-only"; maxSubagentDepth: number; maxConcurrentSubagents: number }
//   "say-only" == today's silentPolicy() (agent-loop/policies/index.ts:343): publish nothing but explicit
//   `say` + turn boundaries. NOTE "turn-final" does NOT subsume silentPolicy (it still publishes the
//   end-of-turn message) — the silent agent migrates onto "say-only", NOT "turn-final". The `say` tool
//   GENERALIZES the existing createSayTool (silent-agent-worker/index.ts:51). Migrate + DELETE both
//   bespoke pieces; do not add parallel paths (§B4).
SubscriptionConfig += { wakePolicy: "every-envelope" | "turn-final" | "manual" }
//   wakePolicy is RESOLVED in the vessel (agentic-protocol/addressing.ts:102), not agent-loop/policies (§B3).

// subagent invocation payloads (parent trajectory) — existing terminal kinds used as-is:
// success → invocation.completed (schema is success-only); failure → invocation.failed;
// parent abort/explicit close → invocation.cancelled.
invocation.started   += { subagent: { runId, mode: "fresh" | "fork", taskChannelId, contextId, label } }
invocation.output    += { subagent: { kind: "say" | "turn-report", messageSeq } }
// terminal payloads (completed/failed/cancelled) all carry:
                     += { subagent: { integration?: "integrated" | "conflicted" | "discarded" } }

// subagent tool pins — TWO distinct read-side tools, do not conflate:
read_subagent({ runId, afterSeq? })      // agent-loop (WS-4): task-CHANNEL envelopes since cursor ("manual" wake)
inspect_subagent({ runId, query })       // vessel (WS-5): authorized semantic comparison/inspection (§B5)
integrate_subagent({ runId, selection }) // vessel (WS-5): accounts for source changes (§B5)
// CHILD-side terminal trigger (subagent roster, NET-NEW) — emits the terminal invocation on the PARENT
// trajectory. Turn closure is NOT terminal (else the first turn ends the run); idle is NOT terminal
// (else it never ends). Only this or an explicit parent abort/close (cancelled) closes a run:
complete({ report, outcome?: "success" | "failed" })

// vessel init path (NET-NEW, WS-5): sibling of postClone that re-roots identity+trajectory via forkLog
// from the parent agent's trajectory, WITHOUT cloning DO storage (outbox/fold caches start empty):
initFromTrajectoryFork({ parentLogId, seq, taskChannelId, contextId })
```

### E2. Parallel workstreams (all launched at once; worktree-isolate any that collide)

| WS                              | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Primary code                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **WS-1 semantic VCS use**       | O(1) context pointer fork, authorized cross-context state reachability, semantic compare/integrate/inspect flow, and complete-chain commit behavior. Implement against the canonical provenance-aware VCS contract; do not recreate merge, pick, head, or patch abstractions locally.                                                                                                                                                                                                                                                                                                                                                                                               | `workspace/packages/semantic-control-plane/src/`, `workspace/packages/agentic-do/`                                  |
| **WS-2 host VCS boundary**      | Keep service dispatch thin; map context relationships to readable event/application roots; materialize returned exact heads and perform protected push effects without interpreting decisions or conflicts. Update every CLI/panel/skill caller to the canonical method family.                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/service-schemas/src/vcs.ts`, `src/server/services/vcsService.ts`, `src/server/vcsHost/` |
| **WS-3 runtime**                | Context-relationship registry (typed `lifecycle`/`lineage` edges, `listOwnedContexts` — no context→context edge exists today); `destroyContext({ recursive })` post-order teardown of the lifecycle subtree (today `:575` selects by `contextId`, traverses nothing); `cloneContext({ recursive, targetKey })` per the §E1 contract: **new `targetKey` idempotency** (deterministic child ids so the fork-op reconciler can resume without orphaning), lifecycle-subtree walk, root-only `include`, full descendant clone, rewiring map, cloned-child re-parenting, pending-call re-homing (new `aborted-by-fork` settle reason), error on non-recursive-with-lifecycle-children | `src/server/services/runtimeService.ts`, `packages/shared/src/runtime/`                           |
| **WS-4 agent-loop**             | `publishPolicy` gating in effects derivation (**generalize + delete existing `silentPolicy():343`**); `say` (**generalize + delete existing `createSayTool`**, `silent-agent-worker/index.ts:51`) + `read_subagent` tools; `wakePolicy` field/config (its **resolution** lands in the vessel/WS-5, not here); depth/fan-out limits (`agentHopLimit:118` already guards chat loops)                                                                                                                                                                                                                                                                                               | `workspace/packages/agent-loop/`, `workspace/workers/silent-agent-worker/`                        |
| **WS-5 vessel**                 | Per-channel fork (`canFork`/`postClone` rework, ≤1-subscription gate deleted); `initFromTrajectoryFork`; `spawn_subagent`/`send_to_subagent`/`inspect_subagent`/`integrate_subagent`/`close_subagent`; supervisor turn-final buffering (log-derived, replay-safe); explicit lifecycle/GC                                                                                                                                                                                                                                                                                                                                                                                         | `workspace/packages/agentic-do/`                                                                  |
| **WS-6 channel + fork service** | `getProvenance` (root/fork/task); lineage-signal hub (`subscribeLineage` — **new signal-only subscription mode** on top of the existing `sendSignal:921` transport, head-advance reporting to root, `fork.head_changed` fan-out); durable `fork_ops` journal + `fork()` RPC + alarm reconciler (reuse `alarm():1442`) in the parent channel DO (**gains `callMain`** to drive host `cloneContext`/`destroyContext`); `appendSeed` service-authored append (**hard-scoped to the fork op — first human-attributed forged append**); **delete `workspace/workers/fork`**; `forkConversation` client helper; news-panel migration (`news/index.tsx:713`)                            | `workspace/workers/pubsub-channel/`, `workspace/packages/channel-fork/`, `workspace/panels/news/` |
| **WS-7 protocol**               | New event kinds + schemas + channel/trajectory reducer folds (`forks`, `saliency`, `replaces`, subagent invocation payloads) per E1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `workspace/packages/agentic-protocol/`                                                            |
| **WS-8 chat UI**                | Fork/edit affordances (incl. agent-message edit-fork with `replaces` rendering); ChatHeader switcher + fork-tree view with live lineage badges (`subscribeLineage` + `fork.head_changed`); inline fork rows + shell toasts with Switch action; navigation switching + open-in-child-panel; SubagentRunCard + semantic review UI with change-level integration actions on run cards and fork entries                                                                                                                                                                                                                                                                             | `workspace/packages/agentic-chat/`, `workspace/panels/chat/`                                      |
| **WS-9 tests**                  | Author the full verification suite (E3) against the pinned contracts, in parallel with everything else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | test suites across the above                                                                      |

### E3. Single integration + verification pass (the only green requirement)

1. Reconcile contract drift across workstreams; full typecheck/build.
2. Verification suite — all must pass:
   - Edit-&-fork on a live multi-agent conversation: fork created by the parent channel's **durable fork op** with the seed appended server-side (primary user-authored, `replaces` marker intact), `channel.forked` on parent, second participant badged + toasted, switches by navigation; agents resume from the edit. Crash injection at **every phase boundary** of the fork op: the alarm reconciler either completes the fork (advertised + seeded) or rolls it back — never an advertised-empty fork, never an unadvertised live clone. **This test presupposes the `cloneContext` `targetKey` idempotency (§E1): without it, a crash between the clone returning and the journal write orphans a live clone and the test cannot pass.**
   - **`appendSeed` abuse containment:** the seed append is reachable ONLY by the owning fork op — a userland agent (or any non-fork caller) attempting `appendSeed`, or attempting to forge a human-attributed primary envelope with an arbitrary `onBehalfOf`, is rejected (first path that forges human-attributed messages; §A3).
   - Agent-message edit-fork: replacement lands user-authored with `replaces`, renders in-place, agents continue from it.
   - Fork with uncommitted applications: child and parent initially name the same committed event and exact working head; the applications remain inspectable with unchanged causal and work-unit identities; later mutation advances only the owning context pointer.
   - Two-channel agent forks one channel cleanly (other subscriptions dropped in the clone).
   - Quiet agent (`publishPolicy: "turn-final"`) publishes only end-of-turn + `say`; trajectory retains intermediate text; live inspector sees ephemeral deltas. **The pre-existing silent agent is migrated onto this same `publishPolicy`/`say` path; the bespoke `silentPolicy()` / `createSayTool` are deleted (dead-code audit — no parallel mechanism).**
   - Parent spawns fresh + forked subagents; supervisor wakes only on turn-final/say; steers mid-run via `send_to_subagent`; human inspects + posts via child panel; `close_subagent` tears down entity + context.
   - Semantic integration: the child commits locally, then the parent compares that event and adopts compatible changes in small local steps without advancing `main`. Typed conflicts leave the checkout valid; reconciliation records truthful evidence, and `commit` commits the complete parent application chain.
   - Authorized inspection: `inspect_subagent` can page semantic diff, history, blame, provenance, and conflict evidence reachable through the run's lifecycle/lineage relationship. An unrelated context cannot use an opaque event, application, or change ID as ambient authority.
   - Fork with live subagents: recursive clone walks lifecycle edges only, clones descendant contexts **in full** despite a root-scoped `include`, rewires lifecycle edges, task-channel subscriptions, provenance, and pending calls; both trees operate independently afterward. **Crash mid-recursive-clone (after N of M descendants) reconciles to a single complete tree, not a partial-plus-duplicate — exercising per-descendant `targetKey` idempotency and per-descendant journal progress (Part D).**
   - Edge-kind separation: destroying a conversation's context (recursive) tears down its subagents but leaves its conversation forks fully alive and reachable; a fork can outlive its source, and retained event/application reachability determines what remains inspectable and integrable.
   - Fork switcher, tree view, and **live** badges: a message appended in a sibling fork badges the switcher via `fork.head_changed` without any panel poll; **a dropped signal still reconciles from durable state on roster/tree open (§H)**; repeated cross-context panel navigation keeps stateArgs/storage isolation intact.
3. Breaking-changes register (Part F) fully applied — every listed caller updated, every replaced surface deleted.
4. Dead-code audit (repo policy): no orphaned fork/edit or legacy merge/pick/head scaffolding remains.

---

## Part F — Breaking changes register

Pre-release, no compatibility kept — but per policy, every tightened/removed surface listed explicitly:

1. **`canFork` semantics change**: no longer fails on >1 subscription; becomes per-channel preflight. Callers relying on the old gate (fork.ts preflight) are updated in the same change.
2. **`postClone` (vessel) signature/behavior**: forks a named subscription and **drops all other subscriptions in the clone** (previously: implicitly single-subscription).
3. **The fork worker is deleted**; forking becomes a durable, journaled `fork()` RPC on the parent channel DO that _also appends_ `channel.forked` to the parent log — forks become visible to all parent subscribers, and any consumer assuming forks are silent or worker-driven (none known beyond news) changes behavior. **The channel DO gains host-call (`callMain`) access it never had, to drive `runtime.cloneContext`/`destroyContext`; `cloneContext` gains a `targetKey` idempotency parameter (§E1) that its current callers do not pass.**
4. **News panel deep-dive**: bespoke fork wiring deleted; re-implemented on `forkConversation` + lineage events.
5. **Channel reducer output**: `ChannelViewState` gains `forks`; downstream exhaustive switches over event kinds must handle the three new kinds.
6. **`AgentLoopConfig`**: new fields (`publishPolicy`, `wakePolicy` per subscription, subagent limits); fold/effects derivation changes — fold-cache entries invalidate (cache, safe).
7. **Only semantic VCS verbs remain**: subagent callers use `status`/`compare`/`integrate`/`inspect`/`commit`; no patch-transport or repository-local ancestry API family exists. Tool results and UI labels use `integrated | conflicted | discarded`. The canonical provenance-aware plan is the sole VCS contract.
8. **`forkContext` semantics are exact-pointer sharing**: the child receives the parent's committed event and immutable working-head value. It does not become a flattened clean pin, a synthetic lineage descendant, or a copy of mutable edit rows. Consumers that assumed a clone is clean now see inherited working applications truthfully and with unchanged provenance.
9. **Context relationships become first-class runtime state**: contexts record typed edges (`lifecycle` for subagents — cascaded and cloned; `lineage` for forks — access/provenance only, never cascaded); `cloneContext` gains `recursive` over lifecycle edges (non-recursive clone of a context with lifecycle children becomes an explicit error rather than a silent partial clone) and returns a rewiring map; `destroyContext` gains `recursive` post-order lifecycle teardown — previously teardown never traversed descendant contexts.
10. **Trajectory event vocabulary**: subagent runs introduce invocation payloads with new shapes; `message.completed` trajectory events may now exist with **no** corresponding channel envelope (under `publishPolicy: "turn-final"`) — anything assuming 1:1 trajectory↔channel message correspondence breaks. **Blast radius is smaller than it reads: trajectory and channel are already separate reducers (`reducer-trajectory.ts` vs `reducer-channel.ts`), and `channel-chat-merge.ts` consumes only `ChannelViewState`, so `turn-final` just yields fewer projected channel messages (intended). The real audit target is transcript/export paths, not the live chat projection.**
11. **Unread-outbox `editMessage`** is _not_ extended to read messages — the UI relabels affordances ("Edit" = in-place while unread, "Edit & fork" once read). No API removal, but UX semantics change.
12. **Cross-context semantic inspection becomes possible through explicit authority**: context relationships contribute readable event/application reachability. Ordinary inspectors accept exact semantic identities and revalidate their graph closure server-side; no foreign mutable context selector, path-based pick surface, or raw ID possession grants access.

13. **`say` + publish-suppression are unified, not added** (§B4): the pre-existing silent-agent `createSayTool` (`silent-agent-worker/index.ts:51`) and `silentPolicy()` (`agent-loop/policies/index.ts:343`) are **deleted** and replaced by the config-level `publishPolicy` + a single core `say` local tool (now carrying `saliency: "say"`); the silent agent migrates onto them. Any code referencing the old worker-level tool/policy changes.

14. **`appendSeed` — a new privileged, human-attributed append**: the first path that writes a _primary, human-attributed_ envelope with no participant-roster entry, on the `postClone` DO-trust plane (`@rpc callers worker/server`). Existing service-authored appends are `senderId:"system"` (system-attributed); this is not that. Must be hard-scoped to the owning fork op and unreachable by userland agents (§E3 adversarial test).

---

## Part G — Decisions (RESOLVED 2026-07-03)

1. **Fork × live subagents** → **recursive tree clone, no restricted mode**: `cloneContext({ recursive })` ships in the same delivery as everything else; forking with live subagents works from day one. No block/detach mode is ever built.
2. **Subagent adoption** → **semantic integration from a child event into the parent's exact working head**: the child commits its complete local chain without pushing, and the parent may integrate compatible changes through ordinary local applications. Conflicts are data, not provisional files. Parent commit remains a later complete-chain action; there is no auto-checkpoint or merge gate.
3. **Fork/edit affordance scope** → **agent messages included**: "Edit & fork" also replaces agent turns, published in the fork as user-authored with a `replaces` marker (authorship stays truthful in the log; UI may render in-place).
4. **Fork switcher placement** → **ChatHeader dropdown** as the primary surface, with the full fork-tree overlay behind its "Show tree" action — both ship together, both with live lineage badges.

## Part H — Implementation notes (hard requirements for the implementing agents)

- **Exact semantic context fork** (WS-1) shares the source context's committed event and exact working-head value with the child and creates no semantic event. There is no fallback snapshot, copied-edit, repository-head, or content-ancestry design. The anchor test proves pointer equality at fork, truthful inherited applications, and independent advancement after divergence.
- **Recursive context-tree clone** (WS-3) must re-home pending calls across every cloned pair via the same reconciliation `postClone` runs; calls that cannot be re-homed settle as `aborted-by-fork` (a **new** settle reason) — never silently dropped. It must also be **crash-idempotent per descendant**: `cloneContext` takes a `targetKey` so every context in the tree gets a deterministic, forkId-derived id and the fork-op journal records per-descendant progress — otherwise a mid-clone crash orphans live clones.
- **Per-channel fork** (WS-5) rewrites the most battle-tested path (`postClone`); the existing fork suite plus new multi-subscription cases must both pass — behavior for the single-subscription case is unchanged by construction.
- **Supervisor buffering** (`wakePolicy: "turn-final"`) must not lose envelopes across DO hibernation — buffered state derives from the channel log (replay-safe by construction), never from in-memory queues.
- **Lineage signals** (`fork.head_changed`) are ephemeral and advisory — badges must also reconcile from durable state on roster/tree open, so a missed signal can never wedge the UI.
- **Panel navigation across contexts** (fork switching) exercises `buildPanelLink` cross-context; repeated navigation must keep stateArgs and storage isolation intact (covered in E3).
- **`cloneContext` idempotency is a hard prerequisite, not an optimization** (WS-3): it mints `randomUUID()` today (`runtimeService.ts:512`). The `targetKey` parameter is required for the journaled fork op to resume a crashed clone without orphaning it — the §E3 crash-injection acceptance test cannot pass without it.
- **No local VCS dialect** (WS-1/WS-2/WS-5): import canonical semantic schemas and delegate to `compare`/`integrate`/inspectors. Do not recreate merge gates, patch application, source/target heads, path picks, conflict-marker lifecycle, or convenience authority in the vessel or host.
- **No parallel `say`/publish path** (WS-4): the existing `silentPolicy()` (`agent-loop/policies/index.ts:343`) and `createSayTool` (`silent-agent-worker/index.ts:51`) must be _generalized into_ `publishPolicy`/`say` and **deleted**, not left beside the new mechanism (repo dead-code policy).
- **`appendSeed` is a trust-plane surface** (WS-6): it forges human-attributed primary messages with no roster entry — hard-scope it to the owning fork op and add the adversarial §E3 test; an escape lets something post _as the user_.
- **Channel DO gains `callMain`** (WS-6): owning the fork op means the channel DO drives host `runtime.cloneContext`/`destroyContext` across the DO↔host boundary; the journal must treat that RPC as a crashable step (the reason `cloneContext` idempotency is load-bearing).
- **Clone/destroy default asymmetry is intentional** (WS-3, §B7): `cloneContext` errors on lifecycle children, `destroyContext` default-cascades them — resolved as correct (a lifecycle child exists only to serve its owner; forks are lineage edges and never cascade). Enforce only that the cascade follows `lifecycle` edges exclusively and never crosses a `lineage` edge.
