# Conversation Forking & Subagents — Design Plan

**Status: APPROVED 2026-07-03 — all §G decisions resolved with the user. This plan is implemented as ONE BIG-BANG delivery: a single orchestrating agent implements the ENTIRE plan in one go, fanning out fleets of parallel subagents per Part E's workstreams — all launched at once, with intermediate breakage expected and accepted. There are no milestones, no gates, no optional or deferred items — everything in this document ships together, and the only green requirement is the single final integration + verification pass in §E3.**

**Reviewed 2026-07-03 (post-approval, against the tree at branch `fabling`) — corrected and augmented in place: stale line citations refreshed to actual lines, the current-state audit reconciled against the code, and the review's design findings folded into the sections where they land. The big-bang bet rests on §E1's pinned contracts decoupling the workstreams; the review found four items that are *design decisions, not mechanical drift*, so the "integration pass reconciles drift" clause cannot absorb them — they are pinned here and must be settled before fan-out:**

1. **`cloneContext` idempotency (§A3 / §D / §E1).** The journaled fork op assumes "the clone is keyed by forkId," but `cloneContext` mints a fresh `randomUUID()` target id (`runtimeService.ts:512`) and takes no key. Without a caller-supplied deterministic target id / idempotency key, the §E3 crash-injection acceptance test ("crash at every phase boundary → never an unadvertised live clone") **cannot pass** — a crash between the clone returning and the journal recording its id orphans a live clone the reconciler cannot find.
2. **Recursive-clone durability (§D / §E1).** §A3's journal phases are single-context; §D makes the clone recursive over N subagent contexts. The reconcile story for a *partially completed recursive* clone (crash after cloning 3 of 5 children) is unspecified, and requirement 1's idempotency multiplies across every cloned context/subscription/pending-call.
3. **Source-side merge gating (§B5 / §G2).** "Commit-gated on both sides" is stated as the existing contract, but `vcsMerge` gates only the **target** (`gad-store:6953`); source-side dirty-checking for a `ctx:` source is **new work**.
4. **`say` / `publishPolicy` already partly exist (§B4).** A `say` tool (`silent-agent-worker/index.ts:51`) and a `silentPolicy()` that suppresses all publication except turn open/close (`agent-loop/src/policies/index.ts:343`) exist today. Per this repo's own "fix the primitive / no parallel mechanism" ethos, WS-4 must **generalize** these into the config-level `publishPolicy` + `say`, migrating/deleting the worker-level tool — not add a second path.

**Second review round (2026-07-03) — additional findings, all integrated below:** (5) **subagent runs had no completion trigger** — added a child-side `complete` tool; turn-closure and idle are both explicitly *non*-terminal (§B1/§B2), else a run completes after turn 1 or never closes; (6) idempotency (§A3) must cover cloned **entity keys + storage**, not just the contextId (entity keys are random today, `runtimeService.ts:519`/`:527`) (§E1 cloneContext); (7) the context-relationship registry needs a pinned **write** API + a pinned `createSubagentContext` op, else WS-3/WS-5 diverge on lifecycle-edge provenance (§E1/§B1); (8) `publishPolicy` needs a **`"say-only"`** mode — `"turn-final"` does not subsume `silentPolicy` (§B4). Also resolved: `exclude?`/`replace?` removed from `fork()`; destroy's default-cascade on lifecycle children confirmed correct (§B7); the fork switcher reads siblings from the **parent** channel's `forks` projection, not its own (§A4).

**Lower-severity corrections and every verified line reference are inline below.**

This plan covers two interacting extensions to the agentic messaging system:

- **Part A — Conversation forking as a first-class UX**: edit a past message (or pick any point in history) and resume the conversation from there as a fork; surface forks to all participants with notification and one-click switching.
- **Part B — Subagents**: a parent agent spawns child agents in forked file contexts (uncommitted changes intact), communicates over dedicated channels, supervises with low noise, inspects via child panels, and merges file changes back without touching `main`.

Both are deliberately treated as **test cases for the platform abstractions**: where the current primitives make these features awkward, we change the primitives (no backward compatibility — this is pre-release; replaced paths get deleted).

Authoritative background specs: `docs/ws1-agent-loop-spec.md` (agent loop), `docs/ws2-channel-spec.md` (channel DO), `docs/stage0-unified-log-spec.md` (gad log + forkLog), `docs/narrow-host-vcs-plan.md` (host/gad VCS split — **all phases P1–P5 IMPLEMENTED per that doc's own status line, committed in `02fb07e7`/`808facb8`; in particular the diff-review UI this plan reuses (P3.5, `packages/ui/src/kit/diff/DiffViewer.tsx`, wired at `apps/shell/overlay/ApprovalCardSurface.tsx`) already exists — an earlier draft's "P3+ pending" here was stale**). `docs/agentic-architecture.md` and `docs/pi-architecture.md` are historical; do not trust their specifics.

---

## Part 0 — Current-state review (fork UX audit)

### What already exists and is sound

The fork **mechanism** is mature; the fork **product** does not exist. Inventory:

| Capability | State | Where |
|---|---|---|
| Semantic channel+agent fork | ✅ implemented, tested | `workspace/packages/channel-fork/src/fork.ts`, `workspace/workers/fork/index.ts` |
| No-copy log fork at a seq | ✅ | gad-store `forkLog` (`workspace/workers/gad-store/index.ts:2760`; lineage cols `parent_log_id`/`fork_seq`/`fork_hash` declared at `:1118`, populated at `:2810`), `ChannelLog.forkFrom` (`pubsub-channel/log-store.ts:147`) |
| Agent DO clone + trajectory re-root | ✅ | `agent-vessel.ts` `canFork`/`postClone` (:2941/:2949), `onChannelForked` hook (:451) |
| Channel DO clone | ✅ | `channel-do.ts` `postClone` (:1548) — re-homes context, forks log, rebuilds policy state by replay |
| **File-context fork incl. uncommitted changes** | ✅ **confirmed** | `runtime.cloneContext` (`runtimeService.ts:481`) → `WorkspaceVcs.forkContext` (`src/server/vcsHost/workspaceVcs.ts:1593` — a 2-line host wrapper `resolveContextView` ⊕ `pinContext`; the real VCS semantics live in the **gad-store DO** behind `vcsResolveContextView`/`vcsPinContext`, so the lineage-true rework in §B5 is a **gad-store** change, not a host one): snapshots the composed working view (committed ctx head ⊕ uncommitted edit-ops) and pins it as the child's base |
| Rollback on partial fork failure | ✅ | `fork.ts` → `runtime.destroyContext` |
| Policy/conversation state survives fork | ✅ (fixed by WS2) | `policyHost.rebuildAfterFork()` |

**Answer to the open question: yes, we support forking contexts with uncommitted changes intact.** Uncommitted work is edit-op rows in the gad-store DO; `resolveContextView` composes them into a working state hash mirrored in CAS, and `forkContext` pins that snapshot as the child's base.

### Gaps and design debts (what "rework" means)

1. **Zero generic UX.** The only caller of the fork machinery is the news panel's deep-dive (`workspace/panels/news/index.tsx:705`). Nothing calls the fork worker; chat panels have no fork affordance.
2. **Fork lineage is one-directional and buried.** The child records `forkedFrom`/`forkPointId` in its KV `state` (`channel-do.ts:1567-1568` via `setStateValue`), reachable only via generic `getState()` (`channel-do.ts:1582`, which dumps `SELECT * FROM state`) — and today **nothing consumes it**. The **parent has no record that it was forked** — no parent→children index, no way to enumerate a fork tree, no event anyone can subscribe to. This is the core structural gap: forks are invisible.
3. **No notification.** Other participants (human or agent) never learn a fork happened.
4. **Edit is unread-only.** `PubSubClient.editMessage` + `message.edited` (`events.ts:43`) apply only to messages not yet read (outbox editing, `useChatCore.ts:907`); the unread-only rule is enforced in the reducer at `handlers.ts:278` — the edit is dropped once `readBy` is non-empty. Editing *read* history is semantically a fork, not an edit — the primitives are unrelated and should stay unrelated. Edit-a-past-message must be built on fork-at-seq, not on `message.edited`.
5. **`canFork` requires ≤1 subscription** (`agent-vessel.ts:2942`). Fine today; becomes a hard blocker the moment agents are multi-channel — which Part B makes the norm for any supervising agent. `postClone` must become per-channel-aware (§C3).
6. **VCS lineage is flattened on fork — a defect to fix, not a caveat to accept.** `forkContext` (`workspaceVcs.ts:1593`) snapshots the parent's *working view* (`resolveContextView`) and pins it as the child's clean base (`pinContext`): the child loses commit lineage (`getMergeBase`, gad-store `:5901`, a BFS over the recorded `gad_state_transitions`/`gad_transition_parents` graph — the snapshot pin records no transition edge, so it finds no shared ancestor), and — worse semantically — the parent's *uncommitted* edits get **baked into the child's base as if committed** (`forkContext` copies no `gad_worktree_edit_ops` rows, so the child has **zero** working-edit rows and `vcsContextStatus` reports it clean), so the child cannot see, discard, or selectively commit them. Harmless for the news deep-dive; wrong for edit-forks and fatal for subagent merge-back. §B5 replaces this with a true lineage fork. (Note: `forkLog`'s per-**log** lineage mechanics — used today by `forkRepo` — are the model §B5 applies to context heads; they are distinct from this snapshot-pin `forkContext`, which is why the rework is net-new engine work rather than a call-site swap.)
7. **Human participants are dropped on fork** (`postClone` clears `participants`). Correct behavior (a fork starts fresh), but there is no re-invitation path — that's what the fork notification + switch UX provides.
8. **No fork identity.** Forks get random channel ids and no label; a fork tree with three unnamed siblings is unusable.
9. **No cherry-picking and no cross-context inspection.** A caller can only read/diff/merge against its own context (or `main`); there is no way to inspect another context's contents or take selected commits/edits from it. Notably, `vcs.revert` (gad-store `revertWorking:4957`, host `workspaceVcs.ts:2677`, dispatch `vcsService.ts:394`) already inverse-applies a single change's patch by event id — cherry-pick is its forward dual (the schema even names the duality: `vcs.ts:665`, "forward-applying its inverse patch"), so the engine gap is small (§B5b). Also missing today, and all net-new: `vcs.pick`, `vcs.contextDiff`, and any `context: { contextId }` scope on the read surfaces (`packages/service-schemas/src/vcs.ts` scopes reads by `repoPath` only).

Verdict: the plumbing is the good kind of boring — keep it. All work is (a) lineage + notification as first-class durable data, (b) UX, (c) the two robustness debts (5) and (6).

---

## Design principles

1. **The log is the source of truth — including for forks.** Fork lineage is recorded as durable envelopes on the *parent* channel log, so notification, roster folding, replay, and audit all come for free. No side registries.
2. **Editing read history = forking.** The unread-outbox edit path stays as-is (it is a different feature: fixing a message the agent hasn't seen). Read-history edit creates a fork rooted just before the edited message and seeds the edited text as the fork's first new message.
3. **A subagent run is a durable invocation on the parent's trajectory.** The parent's LLM sees spawn → progress (`say`) → final report exactly like an async tool call (`invocation.started/output/completed|failed|cancelled|abandoned`). The parent↔child *channel* is the transport and the inspection surface, not a second bookkeeping system.
4. **Merge-back never touches `main`.** Child→parent context merge is a gad-DO branch-to-branch merge over `ctx:*` heads (the engine already supports arbitrary `sourceHead`); the protected `updateMains` path stays reserved for pushes. This aligns with narrow-host P3 (gad owns merge orchestration).
5. **No backward compatibility.** Replaced surfaces are deleted in the same change (e.g. the news panel's bespoke fork call migrates to the generic service; the ≤1-subscription `canFork` gate is removed, not special-cased).
6. **Fix the primitive, don't design around it.** Where a feature reveals a limitation in a platform abstraction (flattened fork lineage, main-pinned merge surface, single-subscription fork, non-recursive clone), the plan changes the abstraction rather than adding feature-level workarounds. These features are the test case for the abstractions; a workaround would defeat the purpose.

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

- `reduceChannelView` (`reducer-channel.ts:134`) folds these into `ChannelViewState.forks: ForkProjection[]` — the fork roster is a pure projection of the parent log, exactly like the trajectory `branch.*` projections it mirrors (precedent confirmed: `reducer-trajectory.ts:27`/`:138` fold `branch.*` into `branches`). `ChannelViewState` (`reducer-channel.ts:90`) has **no** `forks` field today and none of the three event kinds exist in `events.ts` — all net-new; downstream exhaustive switches over event kinds must add them. **Semantics:** because `channel.forked` is appended to the channel that was forked *from*, a channel's `forks` projection enumerates its **direct children**, not its siblings — sibling lists and full-tree views walk `getProvenance` up and read each ancestor node's own `forks` (§A4).
- The **child** side already records `forkedFrom`/`forkPointId`; promote this to a typed **`getProvenance()`** RPC on the channel DO (net-new — today the DO exposes only `getPolicyState`/`getContextId`/`getConfig`/`getParticipants`/`getState`, and lineage is read solely by peeking `getState()`) — a discriminated union covering *every* way a channel comes to exist, not just forks: `{ kind: "root" }` | `{ kind: "fork", forkedFrom, forkPointId, rootChannelId }` | `{ kind: "task", parentChannelId, parentContextId, runId }` (task channels are *fresh* channels, §B1 — their provenance is recorded at creation, not inherited from a log fork). Panels landing anywhere can render breadcrumbs and walk *up*.
- Fork trees deeper than one level fall out naturally: each fork's parent log carries its own `channel.forked` events. The roster UI shows the sibling set for the current channel plus a parent breadcrumb; a full-tree view can walk lineage lazily.
- gad-store `forkLog` already persists `parent_log_id`/`fork_seq`/`fork_hash` (`:1118`, populated at `:2810`); expose it as `getLogLineage(logId)` (net-new) for tooling/debugging so the durable substrate and the channel-level events can be cross-checked.

Because `channel.forked` is a durable envelope on the parent channel, **every subscriber — panels and agents — gets fork notifications through the pipe they already have.** No new delivery mechanism.

### A2. Triggering UX (chat panel)

Message-level affordances in `MessageCard`/`MessageList` (hover/long-press menu):

- **"Fork from here"** — on *any* message. Fork point = that message's seq (the fork includes it).
- **"Edit & fork"** — on the user's *own* messages that are already read (unread ones keep the existing in-place outbox edit; the menu shows whichever applies, so the user just sees "Edit"). Opens the composer pre-filled with the original text; on send: fork point = seq **before** the edited message, then the edited text is sent as the fork's first message.
- **"Edit & fork" on *agent* messages** — DECIDED (§G3): also supported, as a steering tool ("no — here's what you should have said, continue from that"). Fork point = seq before the agent message; the replacement is published in the fork **attributed to the user, marked `replaces: <original messageId/seq>`** — the log never pretends the agent authored it. Agents' trajectories in the fork see the replacement as an authoritative user-provided substitute for their prior turn (the trajectory re-root drops the original turn; the replacement arrives as a normal inbound message carrying the `replaces` marker, so the reducer can render it in-place as an edited agent turn while keeping authorship truthful in the durable log).

Plus a channel-level **"New fork"** in the ChatHeader menu (fork at current head — "let me try something without polluting this thread").

Agent-facing: the same operation is exposed as a channel method so agents can fork conversations programmatically.

### A3. Fork execution flow

**Fork is a durable operation owned by the parent channel DO** — not a stateless worker saga. Today's fork worker is a stateless fetch handler whose rollback only runs inside a caught exception; a crash mid-flow can leak an unadvertised live clone. Since the parent channel already owns fork *lineage*, it also owns the fork *operation*: `PubSubChannel.fork(opts)` (new RPC), which

1. **journals** a `fork_ops` row (forkId, opts incl. seed, phase) in the parent channel's SQLite *before* acting — `opts` include `{ forkPointPubsubId, seed?, label?, reason }`, with `forkPointPubsubId = editedMsgSeq - 1` for "Edit & fork";
2. drives the phases **idempotently** — `cloneContext` → clone `postClone`s → **seed append to the child log** → **`channel.forked` append to the parent log** (with `reason`, label, `seededMessageId`) → mark done — recording each phase in the journal;
3. **reconciles on alarm/wake** (the channel DO already runs an alarm, `channel-do.ts:1442` — the reconciler multiplexes onto it): an op found mid-phase resumes from its journal or, if unresumable, rolls back via `destroyContext`. The appends are idempotent by construction (deterministic envelopeIds `fork-seed:{forkId}` / `fork-event:{forkId}`). **The clone is NOT idempotent today, and this is a hard prerequisite (§E1):** `cloneContext` mints a fresh `randomUUID()` target id (`runtimeService.ts:512`) and takes no key, so a crash between the clone returning and the journal recording its id orphans a live, unadvertised clone the reconciler can never find. `cloneContext` must therefore take a **caller-supplied deterministic target id / idempotency key** (e.g. `fork:{forkId}`) so a resumed clone returns the same child rather than minting a second one. With that in place, no crash window can leave either an advertised-but-empty fork or an unadvertised live clone.

**Two new capabilities this move requires.** (a) The channel DO must gain **host-call access** — today it has *no* `callMain` and never invokes runtime services; owning the fork op means it drives host `runtime.cloneContext`/`runtime.destroyContext` (a userland→host call, directionally fine per the boundary rule, but a new coupling that puts the transactional journal *across* the DO↔host RPC boundary — the reason the idempotency requirement above is load-bearing). (b) When the parent has live subagents, this same op drives the **recursive** clone (§D); §A3's single-context phase list does not by itself cover crash-reconcile of a *partially completed* recursive clone — that contract is pinned in §D/§E1.

The stateless fork worker (`workspace/workers/fork`) is **deleted** (no back-compat); `@workspace/channel-fork`'s orchestration moves into the channel DO, and the `forkConversation(rpc, opts)` client helper calls the parent channel method.

The **seed** carries the replacement message: author (the forking user), content blocks, and the optional `replaces: { messageId, seq }` marker (§A2). It lands via a new **service-authored append** on the forked channel — `appendSeed`, caller-asserted to the owning fork op (the same DO-trust plane as `postClone`: `@rpc({ callers: ["worker", "server"] })`, `channel-do.ts:1547`) — writing a normal *primary* user-authored message envelope with an explicit `onBehalfOf` actor and audit fields, **without requiring a participant-roster entry** (the clone's participants table is emptied post-fork by design, `channel-do.ts:1571`; and the ordinary `publish` guard is a *caller-identity* check — `caller.callerId === participantId`, `channel-do.ts:788`/`:385`, not roster membership — and is untouched). **Security note (elevated to an §E3 acceptance check):** service-authored appends have precedent (`appendDurable` with `senderId: "system"`, `channel-do.ts:1048`/`:1375`), but those are *system*-attributed; `appendSeed` is the first path that forges a **human-attributed** primary message with no roster entry, so an escape would let something post *as the user*. It MUST be hard-scoped to the owning fork-op caller and unreachable by userland agents — an explicit adversarial test in §E3. This is NOT the `forceInitialPrompt` mechanism — that sends `tier: "secondary"` system-originated support prompts (`useChatCore.ts:838`) and cannot carry `replaces`; it stays reserved for its existing new-chat use.

The panel then navigates to the fork (A4) and subscribes — pure navigation, nothing pending; a panel crash at any point leaves a fork that is either complete and advertised or fully rolled back. Agents in the fork receive the seed on their post-clone replay/wake and respond per their normal respond policies — the conversation *resumes from the edit* with full prior context, which is the entire point. Plain "Fork from here" and "New fork" are the same call without `seed`.

### A4. Fork roster & switching

- **ChatHeader** gains a fork switcher next to the participant roster: current branch name, dropdown listing sibling forks + parent breadcrumb (from `getProvenance`). Each entry: label, fork-point excerpt, relative time, actor, unread indicator. **Sourcing correction:** `ChannelViewState.forks` of the *current* channel projects *its own* children (forks rooted at it), NOT its siblings — `channel.forked` events live on the **parent** log (§A1). So the sibling list is read from the **parent** channel's `forks` projection (`getProvenance().forkedFrom` → parent channel → its `ChannelViewState.forks`), a durable roster read/subscription on the parent. `subscribeLineage` is signal-only (`fork.head_changed` live badges) and does **not** carry the roster; every roster comes from a channel's own `forks` projection.
- **Switching = navigating the panel**: primary action updates `panel.stateArgs` (`channelName`, `contextId`) and reconnects — same panel, new channel + context (cross-context navigation exists via `buildPanelLink`, `panelLinks.ts:48`; `contextId` is the first-class cross-context trigger at `:61`, `channelName` rides in the chat panel's `stateArgs`, `panels/chat/types.ts:14`). Secondary action "Open in new panel" → `openPanel("panels/chat", { stateArgs: { channelName, contextId } })` as a child panel for side-by-side comparison (the news panel already issues this exact shape, `panels/news/index.tsx:748`).
- **Live unread/changed badges via lineage signals** — no polling. The fork tree has a natural hub: the **root channel** (every fork knows its root via `getProvenance().rootChannelId`). Each channel in the tree reports its durable head advances to the root (debounced, through the `forkedFrom` chain), and the root fans out ephemeral `fork.head_changed { channelId, headSeq }` signals to **lineage subscribers** — a signal-only subscription any panel in the tree holds alongside its main channel connection (`subscribeLineage`). The panel keeps per-fork read cursors in stateArgs; `channel.forked` events badge *new fork created*, `fork.head_changed` badges *fork has new messages since your cursor* — both live, across the whole tree, from one extra lightweight subscription. **Implementation note:** the ephemeral-signal transport already exists (`sendSignal` / `broadcast({ kind: "signal" })`, `channel-do.ts:921`, delivered with no log append), but there is **no signal-only subscription** today — `subscribe` (`channel-do.ts:463`) always delivers durable replay + live — so `subscribeLineage` is a new subscription *mode*, not a reuse. It is also O(depth) fan-out up the `forkedFrom` chain with the root as a single hub; fine at current scale, and §H already requires badges to reconcile from durable state on open so a missed signal cannot wedge the UI.
- **Fork-tree view**: alongside the dropdown, a full lineage tree view (walking `getProvenance` breadcrumbs up and `ChannelViewState.forks` down per node, lazily) rendered as a panel overlay from the switcher's "Show tree" action, with the same live badges.

### A5. Notifications

Two layers, both driven by the durable `channel.forked` event:

- **In-panel**: subscribers of the parent channel fold the event into the view → the fork switcher badges and a lightweight inline system row in the message list ("⑂ Alice forked this conversation from message N — Switch").
- **Shell toast** for participants whose panel isn't focused: `runtime.notifications.show({ type: "info", title: "Conversation forked", actions: [{ label: "Switch" }] })`, action → panel navigation as in A4. Wired in the chat panel (it owns the channel subscription), not in the host.

Agents receive the same envelope; default respond policies ignore it (it is not a message). Agents that *want* to react to forks can, via `onChannelEvent`.

### A6. Robustness rework

1. **Per-channel fork for multi-subscription vessels** (prerequisite for Part B coexistence, §C3): replace the `subscriptions.count() <= 1` gate (verbatim at `agent-vessel.ts:2942`). `postClone(parentChannelId, …)` becomes "fork *this* subscription": re-root the trajectory for the forked channel, rename that subscription, and **drop all other subscriptions in the clone** (the clone is a new entity; it must not ghost-join the parent's other channels). `canFork` then only vets per-channel invariants (e.g. no open method calls it cannot reconcile — existing `reconcilePendingCalls` logic, `calls.ts:886`, already run by `postClone` at `channel-do.ts:1577`).
2. **Migrate the news panel** deep-dive to the generic `forkConversation` helper + `channel.forked` lineage; delete its bespoke wiring.
3. **Typed lineage surfaces**: `getProvenance()` on the channel DO; `getLogLineage()` on gad-store; delete ad-hoc `getState()` peeking.

---

## Part B — Subagents

### B1. Model: subagent run = invocation + task channel

When a parent agent spawns a subagent:

1. **Create the child context** via the pinned `createSubagentContext({ parentContextId, ownerEntityId, targetKey })` (§E1) — one op that mints the child context (deterministically from `targetKey`), forks the parent's file state into it (uncommitted changes intact, via `forkContext`; provenance recorded §B5), **and records the `lifecycle` edge** in the context-relationship registry (§B7). This is the single pinned entry point for creating a subagent context; the vessel does not assemble it from primitives, so WS-3 and WS-5 cannot diverge on where the lifecycle edge is written.
2. **Create a task channel** `task-{uuid}` bound to the child context.
3. **Create the child agent entity** in the child context and subscribe it to the task channel. The parent→child ownership edge already exists but is **server-derived, not a caller argument**: `createEntity` (`runtimeService.ts:214`) sets `parentId: caller.runtime.id` from the *verified caller* (`:359`) — the create spec has no `parent` field, so there is no `runtime.createEntity({ parent })` API (an earlier draft's `:56` citation pointed at the internal `prepareWorker` hook). The edge lands correctly *iff the spawning parent agent's runtime is the caller*. Note this is an **entity→entity** edge; the **context→context** relationship the subagent lifecycle needs is the net-new registry in §B7.
4. **Subscribe the parent** to the task channel with a supervisor wake policy (§B3).
5. Record the whole run on the **parent trajectory as a durable invocation**, using the existing terminal vocabulary exactly (no semantic overload): the spawn tool emits `invocation.started`; child `say` messages and its end-of-turn report surface as `invocation.output`; success closes with `invocation.completed` (which is success-only by schema — `terminalOutcome: "success"`), a failed run closes with `invocation.failed`, and a parent-aborted run closes with `invocation.cancelled`. Merge status rides in the terminal payload's subagent block. **The terminal transition has an explicit trigger, not a heuristic:** the child emits it by calling a child-side `complete({ report, outcome })` local tool (§B2) — until then the run stays OPEN. A subagent is a normal agent that goes idle between turns, so *turn closure does not complete the run* (that would close it after the first turn) and an idle child is not "done" (that would leave it open forever); only `complete` or an explicit parent abort/close is terminal. The supervisor's turn-final wake (§B3) therefore treats each turn report as `invocation.output` (progress) and only `complete` as done. The parent's LLM context therefore contains the subagent run in the shape it already understands — an async tool call with streamed progress and standard error folding (`isError` behaves correctly for free). **Verified airtight:** `invocation.completed` is success-only at both the TS type (`events.ts:291`) and Zod (`schemas.ts:221`, `terminalOutcome: z.literal("success")`) levels; `invocationTerminalKindForOutcome` / `validateInvocationTerminalOutcomeForKind` (`constants.ts:177`) enforce the outcome→kind pairing; terminal invocations fold to a `tool-result` with `isError: false` on completed and `true` on failed/cancelled/abandoned (`fold.ts:368`/`:379`). An ephemeral `invocation.progress` kind (`events.ts:46`) the executor already emits is available for live-inspector deltas alongside `invocation.output`.

The task channel is not redundant with the invocation: it is the durable transcript of the child (inspectable, §B6), the medium for mid-run steering (parent — or the human — can post follow-up instructions into it), and the substrate that makes a subagent just *an agent on a channel*, with zero special cases in the vessel.

### B2. Spawn modes

Exposed to agents as one local tool, `spawn_subagent`, with two modes:

- **`mode: "fresh"`** — a new agent (configurable worker source, default the standard chat agent; model/thinking/approval config in `stateArgs.agentConfig`). Task prompt is seeded as the first message on the task channel. Cheap, isolated LLM context.
- **`mode: "fork"`** — preserve the parent's LLM context: the child's trajectory log is created via gad-store `forkLog` from the **parent agent's trajectory** at the current seq (exactly the mechanism `postClone` already uses for channel forks, `agent-vessel.ts:2949`), so the child starts knowing everything the parent knows. New vessel init path: `initFromTrajectoryFork({ parentLogId, seq, taskChannelId, contextId })` — a sibling of `postClone` that re-roots identity + trajectory *without* cloning DO storage (outbox/fold caches start empty, as in postClone).

Tool surface (agent-loop `local_tool` → effect → runtime calls; parameters abridged):

```ts
spawn_subagent({ mode, task, source?, config?, label? })
  → { runId, taskChannelId, contextId }        // runId = invocationId
send_to_subagent({ runId, message })            // posts into the task channel
read_subagent({ runId, afterSeq? })             // §B3; task-channel envelopes since cursor (backs "manual" wake)
inspect_subagent({ runId, query })              // §B5b; child-context VCS inspection (status/diff/log/read)
merge_subagent({ runId })                       // §B5; take everything — commit-gated on both sides
pick_from_subagent({ runId, picks })            // §B5b; selective cherry-pick (commits or working paths)
close_subagent({ runId, discard?: boolean })    // unsubscribe, destroy entity+context (unless kept for inspection)

// CHILD-side tool, in the SUBAGENT's own roster (not the parent's) — the explicit terminal trigger:
complete({ report, outcome?: "success" | "failed" })  // closes the run: publishes `report` as the final
                                                       // output and emits the TERMINAL invocation event on
                                                       // the PARENT trajectory (success→completed, failed→failed).
```

Depth/fan-out guarded by config (`maxSubagentDepth`, `maxConcurrentSubagents` — net-new on `AgentLoopConfig`, `state.ts:39`, which has none of them today), enforced at spawn time; the existing `agentHopLimit` machinery (`addressing.ts:118`, `DEFAULT_AGENT_HOP_LIMIT = 4` at `:45`) already prevents chat loops on the task channel. The whole spawn/steer/read/inspect/merge/pick/close tool surface above is confirmed absent today (all net-new) **except** `say` (§B4), which already exists in a narrower form and must be generalized rather than re-added. `initFromTrajectoryFork` is likewise net-new (confirmed absent).

### B3. Channel topology & supervisor wake policy

The parent is now genuinely multi-channel (its home channel + one per live subagent). Subscriptions already support this (`subscription-manager.ts`, per-channel `contextId`/`config`). What's missing is **wake discipline** — today every envelope wakes the driver for a respond decision.

Add a per-subscription **`wakePolicy`** to the subscription config (`SubscriptionConfig` already carries per-channel `context_id` + `config`, `subscription-manager.ts:24` — the right home). **Mechanism correction:** the respond/wake decision does not resolve "in `@workspace/agent-loop` policies" as the field's home suggests — it resolves in the **vessel**, via `resolveShouldRespond` (`agentic-protocol/addressing.ts:102`, called from `agent-vessel.ts:1704`; today every inbound `message.completed` runs it then wakes the driver, `agent-vessel.ts:1403-1420`). `RespondPolicy` is *typed* in agent-loop (`state.ts:12`) but *applied* in the vessel, so `wakePolicy` resolution lands in WS-5 (vessel) even though its config field is declared in agent-loop (WS-4). The policy values, resolved alongside `RespondPolicy`:

- `"every-envelope"` (default; current behavior — home channel)
- `"turn-final"` — buffer envelopes; wake the driver only on `turn.closed`, `say`-flagged messages (§B4), `invocation.*` addressed to us, or mentions. Buffered context is folded into the parent's next turn as the invocation's `invocation.output` payload, **summarized to the child's report, not the full transcript** — the full transcript stays in the task channel for inspection.
- `"manual"` — never auto-wake; the parent reads the channel only when its own turn logic asks, via a `read_subagent` local tool (returns the task channel's envelopes since the parent's cursor).

Supervisor default: `"turn-final"`. This is the "multi-channel infrastructure, augmented" piece: the augmentation is precisely subscription-level wake policies plus routing child reports into the parent trajectory as invocation output.

### B4. Subagent chattiness: publish policy + `say` tool

Today every model call's text becomes a `message.completed` envelope on the channel (`effects.ts:362`; the only existing publish gate is `shouldPublishModelOutcome`, `effects.ts:460`, keyed on per-turn metadata — not a config-level policy). For subagents, add to `AgentLoopConfig`:

- **`publishPolicy: "all" | "turn-final" | "say-only"`** — under `"turn-final"`, intermediate model text within a turn is retained in the trajectory (`message.completed` trajectory events, streamed as ephemeral deltas so live inspectors still see progress) but **only the end-of-turn message is published as a durable channel envelope**. Under `"say-only"`, **no** model message is published at all — the agent speaks *only* through the explicit `say` tool (plus turn-boundary markers). `"say-only"` exists as its own mode because `"turn-final"` does **not** subsume `silentPolicy()`: turn-final still publishes the end-of-turn message (a behavior change for a silent agent, and noise after a `say`). The silent agent migrates onto `"say-only"` (behavior preserved exactly); subagents default to `"turn-final"`.
- **`say` local tool** — explicit mid-turn publication: emits a durable channel message flagged `saliency: "say"`, which also passes the supervisor's `"turn-final"` wake filter. This is the subagent's "progress worth reporting" valve.

**Reconcile with what already exists — do not add a parallel path.** A `say` tool and a publish-suppression policy are *already implemented* for the silent agent: `createSayTool` (`silent-agent-worker/index.ts:51` — a worker-level `AgentTool` that calls `channelClient.send` directly, with no `saliency` flag) plus `silentPolicy()` (`agent-loop/src/policies/index.ts:343`), which suppresses all publication except turn open/close. That is the `"say-only"` publish mode (above) + `say`, in a narrower, config-unaware form — **not** `"turn-final"` (which additionally publishes the end-of-turn message; a reviewer correctly flagged that turn-final does not subsume `silentPolicy`). Per this repo's "fix the primitive / no back-compat / audit dead code" policy, WS-4 must **generalize `silentPolicy` into the config-level `publishPolicy` (as the `"say-only"` mode), fold `saliency: "say"` into a single core `say` local tool, and migrate the silent agent onto them — deleting the bespoke `createSayTool` and `silentPolicy`** — not ship a second mechanism beside them.

Subagent default config: `publishPolicy: "turn-final"` + `say` in the tool roster. This is a pure agent-loop/fold change (new effect gating in `derivePendingEffects` + the generalized tool), and it is generally useful beyond subagents (e.g. quieter agents in crowded human channels — which is exactly what the silent agent is).

### B5. VCS: lineage-true context fork + generalized merge

**Fork — rework `forkContext` into a first-class lineage operation.** Today's snapshot-and-pin flattens history and bakes the parent's uncommitted edits into the child's base (§0.6). Instead of patching around that (e.g. bolting synthetic transitions onto `getMergeBase`), fix the primitive. **Locus:** the host `forkContext` (`workspaceVcs.ts:1593`) is a thin 2-line wrapper; the real work lands as a **new gad-store DO method** (call it `vcsForkContext`, pinned in §E1) alongside `vcsPinContext`/`vcsResolveContextView`, with the host wrapper rewritten to call it. New semantics, per repo touched by the parent:

1. **Pin the child to the parent's *pinned base view*** (not its working view) — the child sees the same upstream world the parent does.
2. **Fork the ctx head as a lineage descendant**: create `ctx:<child>` pointing at the parent's committed ctx-head state, recorded as a fork edge in the commit graph — the same lineage mechanics `forkLog` already implements for repo forks (`parent_log_id`/`fork_seq`/`fork_hash`, gad-store `:2733`), applied to context heads. Child commits now genuinely descend from parent history.
3. **Copy the working edit-op rows** to the child's head. Uncommitted work is replayable edit-ops keyed by `(logId, head)` — copying them means the child sees the parent's uncommitted changes **as uncommitted changes**: same content as today, but with truthful status. The child can inspect, discard, or selectively commit them; `vcs.contextStatus` reports them honestly instead of hiding them in the base.

Consequences:
- **Merge base falls out naturally**: parent and child share the committed ctx-head state as a real common ancestor in the transition graph — `getMergeBase` just works, no provenance side-table, no synthetic transitions.
- If both sides eventually commit the inherited edits, content-addressing converges the states; if they diverge, diff3 sees the inherited edits as same-change-on-both-sides and merges cleanly.
- Untouched repos need nothing: the child's pinned base covers them, and lazy head creation on first edit already works.
- The child also records `forkProvenance: { parentContextId, forkPoint }` on its pin for UX breadcrumbs (fork switcher, §A4/§B6) — metadata only, not load-bearing for merge.
- **Required integration test** (part of the final verification suite): fork with uncommitted edits; child status shows them uncommitted; commit divergently on both sides; `getMergeBase` returns the shared committed ancestor; merge succeeds.

**Merge — generalize the surface (§G2).** The DO engine already merges arbitrary `sourceHead` into a `ctx:*` target (`vcsMerge`, `gad-store`). `main` as a target is INTERNAL-ONLY (there is no public `vcs.mergeGroup`, and public `vcs.merge` rejects a `main` target): a main-target merge is DO-published through the same single-writer `updateMains(operation:"merge")` push path, attributed by a host-minted `vcsMerge`/`merge` on-behalf-of token (`WorkspaceVcs.callMainTargetMerge`), with the host as follower/token-minter — it is not a public caller surface and is not part of subagent merge-back. The substance is unchanged and holds: subagent merge-back uses a `ctx:*` target and therefore *never* touches `updateMains`. The caller-facing limitation is that public `vcs.merge` hard-pins source = `main`; there is no existing public host escape hatch that already accepts arbitrary `sourceHead`s. Replace it (no compatibility kept):

```ts
vcs.merge({ source: "main" | { contextId: string }, repoPaths? })
// target = caller's context, resolved server-side as today
```

- `source: "main"` preserves today's pull-main behavior; `source: { contextId }` merges another context's committed ctx-head states in, per touched repo: `vcsMerge({ logId, targetHead: ctx:<caller>, sourceHead: ctx:<source>, actor })`. Merge base = `getMergeBase` (`gad-store:5901`, BFS over `gad_state_transitions`/`gad_transition_parents`) over the lineage graph, which the lineage-true fork keeps connected.
- Branch-to-branch by construction; **`main` and `updateMains` are never involved.** The parent pushes the merged result through the existing gated push path whenever it chooses. This sits squarely inside narrow-host P3's direction (gad owns merge orchestration).
- **Conflicts** reuse the existing pending-merge machinery unchanged — `setPendingMerge`/`getPendingMerge`/`clearPendingMerge` (`gad-store:5953`+), the provisional conflict-marked tree via `vcsMerge`'s pending path (`:6867`), resolve via `vcs.edit` + `vcs.commit`, back out via `vcsAbortMerge` (`:7255`); the result surfaces on the parent's invocation as `conflicted`.

**Merge-back is commit-gated on both sides (§G2, final)** — but **only the target side is gated today**: `vcsMerge` rejects a dirty *target* (`gad-store:6953`, "uncommitted edits on `<targetHead>`") and a pending merge on the target (`:6945`), while there is **no source-side dirty check** for a `ctx:` source. So "committed on both sides" is *not* an inherited contract — the source-side half is **new work** (add it to `vcsMerge`, or pre-check in the vessel/host before calling; pinned in §E1). With both sides gated:

- `merge_subagent` fails with a precise, actionable error naming which side is dirty and which repos are affected ("parent context has uncommitted changes in `<repos>` — commit before merging"). The parent agent commits deliberately (a normal `vcs.commit` on its private ctx head — never pushed) and retries; same for the child.
- No auto-checkpoint magic and no dirty-target merging: merge history stays deliberate and predictable. Ctx-head commits are cheap and private, so the cost of the explicit step is one tool call.

### B5b. Cross-context inspection & cherry-pick (`vcs.pick`)

Whole-branch merge is often too coarse: a supervisor wants to look at what a subagent (or an abandoned conversation fork) produced and take *parts* of it. The system has no cherry-pick today — but it has the exact dual: `vcs.revert` already targets a single change by state hash/event id and **inverse-applies its patch onto the caller's head**. Cherry-pick is the forward application of the same machinery.

**Cross-context inspection.** The read surfaces (`readFile`, `listFiles`, `diff`, `log`, `status`, `contextStatus`, `pendingMerge`) gain a `context: { contextId }` scope: resolve against *that* context's heads/working states instead of the caller's. Authorization walks the **context-relationship registry** (new, §B7 — typed edges, accepting **either** kind: `lifecycle` for subagents, `lineage` for forks). **Correction:** the `context.boundary` gate (`contextBoundary.ts:64`) today gates *control-plane* actions (launch/retire/drive a panel/worker/DO in a foreign existing context, `:10-15`), **not reads** — the read surfaces currently take no `context` scope at all (`packages/service-schemas/src/vcs.ts` scopes by `repoPath` only). So read-scoped cross-context inspection is a **net-new enforcement surface** added *at* that gate, not a reuse of existing read gating. Rule: a caller may inspect contexts it owns or forked; the shell/user may inspect anything of theirs. New convenience projection `vcs.contextDiff({ contextId, against?: "fork-base" | "main" })` (net-new) — the full working-state diff of another context against its fork point (default) or main; this is the "review the subagent's work" surface and feeds the **existing** diff-review UI (`DiffViewer.tsx`, narrow-host P3.5 — landed) unchanged.

**Cherry-pick.** One surface, two pick kinds — both land on the caller's context, both record provenance:

```ts
vcs.pick({
  source: "main" | { contextId: string },
  picks: Array<
    | { kind: "commit"; repoPath: string; eventId: string }   // a committed change from the source's log
    | { kind: "paths"; paths: string[] }                       // the source's WORKING content at these paths
  >,
})
```

- **`kind: "commit"`** — the forward dual of `vcs.revert`: 3-way apply of the source commit's patch (base = the commit's parent state, theirs = its output state, ours = the caller's committed head), advancing the caller's head with a commit that records `pickedFrom: { logId, eventId }`. Commit-gated like merge (§G2): the caller's head must be clean. Conflicts materialize markers through the existing pending-merge machinery; `vcs.commit` seals the resolution (recording the pick provenance), `vcsAbortMerge` backs out. Multiple picks apply sequentially and stop at the first conflict.
- **`kind: "paths"`** — the `git checkout <branch> -- <paths>` analogue: copy the source's current working content at the given paths into the caller's context as **uncommitted working edits** (provenance-tagged edit-ops). Not commit-gated — it *produces* working edits, deliberately committed later like any others. Because sources are working states, this picks from a subagent's or fork's **uncommitted** work too — no commit required on the source side for path picks; commit picks (necessarily) reference committed events.

**Subagent + fork integration.** The parent's tool roster (§B2) gains `inspect_subagent({ runId, … })` (proxying the inspection surfaces for the child context) and `pick_from_subagent({ runId, picks })`; both work identically against any owned context, so cherry-picking a fix out of an abandoned conversation fork is the same operation. `merge_subagent` remains the take-everything path; `pick_from_subagent` is the selective one.

### B6. Inspection UX

- The parent's chat panel renders subagent runs from the trajectory invocation events: a **SubagentRunCard** (label, status, live `say` feed, merge state) in the message list where the spawn happened.
- **"Open"** → `openPanel("panels/chat", { stateArgs: { channelName: taskChannelId, contextId: childContextId } })` — a child panel on the task channel. It is a *normal chat panel*: the human can read the full transcript and post steering messages directly to the subagent. No special read-only mode needed (the subagent's respond policy already scopes who it listens to; default: parent + humans).
- The task channel roster shows parent + child; the panel header renders the task channel's `getProvenance()` (`kind: "task"` — parent channel, parent context, runId) as a breadcrumb back to the parent conversation.
- **"Review changes"** on the SubagentRunCard opens the existing diff-review UI fed by `vcs.contextDiff` (§B5b), with per-file and per-commit **pick** actions (path picks land as uncommitted edits in the parent context; commit picks apply through `vcs.pick`) alongside the take-everything **merge** action. The same "Review & pick" action appears on every entry in the fork switcher/tree — salvaging a fix from an abandoned conversation fork is the identical flow.

### B7. Lifecycle & GC

- **A real context-relationship registry is built as part of this plan** — today's `parentId` is launch-parent metadata on *entities* only (`entitySpec.ts:120`, set server-side from the verified caller); `destroyContext` (`runtimeService.ts:570`) selects entities by `contextId` (`:575`) and traverses nothing — and a repo-wide search confirms **no context→context edge or registry exists at all today**. New: the runtime persists a typed edge on every context created by `cloneContext`/subagent spawn (alongside the context, not derived from entity records), with **two edge kinds that must not be conflated**:
  - **`lifecycle`** — "this context exists to serve that one": subagent contexts, and the internal children produced by a recursive clone. Recursive destroy cascades along these; recursive clone walks these.
  - **`lineage`** — "this context descends from that one": conversation forks. Access/authorization + provenance only — **never** cascaded: a fork is a first-class peer whose GC is decoupled (`channel.fork_archived` hides it; destruction is explicit), so destroying a conversation never silently destroys its forks.

  `listOwnedContexts(contextId, kind?)` exposes the edges; `destroyContext({ recursive: true })` does post-order teardown of the **lifecycle** subtree only (and is the default for contexts with lifecycle children); §B5b inspection authorization accepts **either** edge kind. One registry, three consumers, edge-kind-aware. **Clone/destroy default asymmetry — RESOLVED (keep default-cascade):** `cloneContext` *errors* on lifecycle children (explicit `recursive: true` required) while `destroyContext` *default-cascades* the lifecycle subtree. This is intentional, not an oversight: clone-partial is genuinely ambiguous (a half-cloned world that looks whole), so it must be explicit; but a `lifecycle` child *exists only to serve its owner* (the edge's own definition), so tearing it down with the owner is the semantically correct default — and it is what parent-death/reaper teardown already rely on. `lineage` children (forks) are **never** cascaded regardless. The only invariant to enforce: the cascade follows `lifecycle` edges exclusively and never crosses a `lineage` edge.
- Terminal states: success (report delivered) → parent decides merge / discard; failed / cancelled similarly (§B1 terminal-event mapping). `close_subagent` unsubscribes both sides, destroys the entity, and destroys the context. Runs are kept for inspection until the parent explicitly closes them.
- Parent death: destroying the parent's context with `recursive: true` (the default for contexts with lifecycle children) tears down the whole subagent tree via the registry's lifecycle edges — conversation forks (lineage edges) are untouched; children that survive an explicit non-recursive teardown are surfaced in the panel via their invocations' non-terminal state until an explicit lifecycle action closes them.

---

## Part C — Shared infrastructure changes (the abstraction test-case)

Per layer, everything the two features force — this is the list that matters:

| Layer | Change | Motivated by |
|---|---|---|
| `agentic-protocol` | `channel.forked` / `fork_renamed` / `fork_archived` events + `ForkProjection` in channel reducer; `saliency: "say"` message flag; subagent invocation payload shapes | A1, B1, B4 |
| `agent-loop` | `publishPolicy` gating in effects derivation (**generalizes + deletes existing `silentPolicy()`**); `say` tool (**generalizes + deletes existing `createSayTool`**); `wakePolicy` field (resolution lands in the vessel, not here); `maxSubagentDepth`/`maxConcurrentSubagents` in config | B3, B4 |
| `agentic-do` (vessel) | **C3: per-channel fork** — `canFork`/`postClone` reworked to fork one subscription and drop the rest (delete the ≤1-subscription gate at `agent-vessel.ts:2942`); `initFromTrajectoryFork` init path; `spawn_subagent`/`send_to_subagent`/`merge_subagent`/`close_subagent` tools; `wakePolicy` **resolution** (`addressing.ts:102`) + supervisor buffering for `wakePolicy: "turn-final"` | A6, B2, B3 |
| `pubsub-channel` | `getProvenance()` typed RPC (root/fork/task union); **durable `fork_ops` journal + `fork()` RPC + alarm reconciler** (the fork operation moves into the parent channel DO, which **gains `callMain`** to drive host clone/destroy across the DO↔host boundary); `appendSeed` service-authored append (hard-scoped to the fork op — forges human-attributed messages); `subscribeLineage` new signal-only mode; service-authored fork-event appends | A1, A3 |
| `channel-fork` | Orchestration moves into the channel DO; package keeps the `forkConversation` client helper; **the stateless fork worker (`workspace/workers/fork`) is deleted**; delete news-panel bespoke path | A3, A6 |
| `gad-store` | **Lineage-true fork as a new `vcsForkContext` DO method**: ctx-head fork edges (forkLog mechanics applied to context heads), edit-op copy to child head, `forkProvenance` metadata; **source-side commit-gate in `vcsMerge`** (target-only today); `getLogLineage()`; `vcsPick` (forward dual of revert's patch application + provenance-tagged edit-op injection for path picks) | B5, B5b, A1 |
| Host `vcs` service | Generalized `vcs.merge({ source })` (main **or** another context; old main-pinned signature at `vcsService.ts:446` deleted; **new source-side commit-gate**); `context: { contextId }` scope on read surfaces + `vcs.contextDiff` (**new read gating AT `context.boundary`**, which gates control-plane only today); `vcs.pick` (commit + path cherry-pick) | B5, B5b |
| `runtime` / host | `cloneContext({ recursive, targetKey })` — compositional clone over the context ownership tree with parent/subscription/provenance rewiring + **`targetKey` idempotency** for the fork-op reconciler (today mints `randomUUID()`, `runtimeService.ts:512`); context-relationship registry (net-new — no context→context edge exists today); `destroyContext({ recursive })` | B1, B6, D |
| `agentic-chat` / chat panel | Message fork/edit affordances; fork switcher + badges + inline fork rows; SubagentRunCard; navigation-based switching; toast wiring | A2, A4, A5, B6 |

Dead-code audit after landing (per repo policy): the unread-edit path stays (still used by outbox), but any fork-adjacent scaffolding it replaced — news-panel fork wiring, `getState()`-based lineage peeking, the `canFork` subscription-count gate — is deleted.

---

## Part D — Interaction between A and B

**Forking a conversation whose parent agent has live subagents.** The fork clones the parent context (channel + parent agent), but subagents live in *their own* contexts — a single-context `cloneContext` won't include them, so a naive fork leaves the clone with dangling task-channel subscriptions and open invocations.

The systemic fix is to make **cloning compositional over the context ownership tree**, rather than teaching forks to amputate. Note this tree does not exist yet — today's `parentId` is per-entity launch metadata only (`entitySpec.ts:120`) and nothing links contexts to contexts; §B7 introduces the context-relationship registry (typed `lifecycle`/`lineage` edges + `listOwnedContexts`), and `cloneContext` gains `recursive: true` on top of its **lifecycle** edges (full pinned contract in §E1 — including the rule that `include` scopes the root context only while descendant contexts clone in full):

- Clone the parent context, then each child context in the ownership tree, **rewiring as it goes**: cloned children are parented to the cloned parent; task-channel subscriptions in the cloned parent point at the cloned task channels; `forkProvenance` of each cloned child context points at the cloned parent context — so merge-back inside the cloned tree is exactly as well-defined as in the original (no shared-child ambiguity: each tree has its own children).
- In-flight method calls / open invocations across the boundary are reconciled by the same `reconcilePendingCalls` machinery `postClone` already runs (`calls.ts:886`) — each cloned pair re-establishes its own pending state; calls that cannot be re-homed settle as `aborted-by-fork`. **Note:** `aborted-by-fork` is a **new settle reason** — today the only settle reasons are `cancelled` (`calls.ts:786`) and `abandoned` (`graceful`/`disconnect`/`replaced`, `:797`); it must be added, not assumed to exist.
- Cost is proportional to live subagents, which is bounded by `maxConcurrentSubagents`; fork remains no-copy at the log layer either way.

**DECIDED (§G1): recursive clone ships with everything else** — `cloneContext({ recursive })` is part of the single delivery, so forking a conversation with live subagents works from day one and no block/detach mode ever exists. Detach is explicitly rejected: a clone that silently aborts half its trajectory's live work is the kind of around-the-caveat behavior this plan is meant to eliminate.

**Durability of the recursive clone (open contract — pin in §E1).** §A3's journaled fork op enumerates *single-context* phases (clone → postClones → appendSeed → channel.forked). A recursive clone must journal and reconcile a *partially completed multi-context* clone — a crash after cloning 3 of 5 descendant contexts must resume to the same tree, not spawn a second partial one. Combined with §A3's idempotency requirement, this means **every** cloned context (not just the root) needs a deterministic, forkId-derived target id, and the fork-op journal must record per-descendant progress. This is the single largest piece of new durability work in the plan and §A3's phase list does not cover it on its own.

Conversely, **subagent lineage in inspection panels** is free: a task channel's `getProvenance()` (`kind: "task"`) points at the parent conversation and run, so inspection panels always show where they came from.

---

## Part E — Execution: one big bang, maximum parallelization

This plan is implemented as **one delivery, maximally parallel**. There are no phases, no per-stage green requirements, and no partial scope: the orchestrating agent launches all workstreams simultaneously, lets the tree be broken while they land, and runs a single integration + verification pass at the end. Only the final pass must be green.

### E1. Pinned cross-workstream contracts

So that no workstream blocks on another, the shared shapes are pinned **here** and every workstream codes against them verbatim; the integration pass reconciles any drift. Contracts already specified in-body: `channel.forked` / `fork_renamed` / `fork_archived` payloads (§A1), the subagent tool surface (§B2), `vcs.merge({ source })` (§B5). Additionally pinned:

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

// gad-store DO
getLogLineage(input: { logId: string }): { parentLogId: string | null; forkSeq: number | null; forkHash: string | null }
// NET-NEW DO method — the actual LOCUS of the lineage-true fork (§B5); host forkContext
// (workspaceVcs.ts:1593) becomes a thin wrapper over it:
vcsForkContext(input: { sourceContextId: string; targetContextId: string }): void
//   per touched repo: pin child to the parent's PINNED base (not its working view); fork the ctx head
//   as a lineage descendant via forkLog mechanics on ctx heads (parent_log_id/fork_seq/fork_hash);
//   copy working edit-op rows to the child head (uncommitted stays uncommitted); record
//   forkProvenance {parentContextId, forkPoint}. getMergeBase (gad-store:5901) then connects for free.

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

// vcs service (cherry-pick + cross-context inspection, §B5b)
vcs.merge({ source: "main" | { contextId }, repoPaths? })   // (from §B5) target = caller's context.
//   COMMIT-GATED BOTH SIDES — but only the TARGET check exists today (gad-store:6953); the SOURCE-side
//   dirty check for a ctx: source is NET-NEW (add to vcsMerge, or pre-check in host/vessel).
vcs.pick({ source: "main" | { contextId }, picks: Array<
  { kind: "commit"; repoPath: string; eventId: string } | { kind: "paths"; paths: string[] } > })
vcs.contextDiff({ contextId, against?: "fork-base" | "main" })
// read surfaces (readFile/listFiles/diff/log/status/contextStatus/pendingMerge) gain
// context?: { contextId } — authorized via the runtime ownership tree. NOTE: context.boundary
// (contextBoundary.ts:64) gates CONTROL-PLANE actions today, NOT reads — this read gating is net-new AT that gate.

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
                     += { subagent: { merge?: "merged" | "conflicted" | "discarded" } }

// subagent tool pins — TWO distinct read-side tools, do not conflate:
read_subagent({ runId, afterSeq? })      // agent-loop (WS-4): task-CHANNEL envelopes since cursor ("manual" wake)
inspect_subagent({ runId, query })       // vessel (WS-5): child-CONTEXT VCS inspection (status/diff/log/read, §B5b)
// CHILD-side terminal trigger (subagent roster, NET-NEW) — emits the terminal invocation on the PARENT
// trajectory. Turn closure is NOT terminal (else the first turn ends the run); idle is NOT terminal
// (else it never ends). Only this or an explicit parent abort/close (cancelled) closes a run:
complete({ report, outcome?: "success" | "failed" })

// vessel init path (NET-NEW, WS-5): sibling of postClone that re-roots identity+trajectory via forkLog
// from the parent agent's trajectory, WITHOUT cloning DO storage (outbox/fold caches start empty):
initFromTrajectoryFork({ parentLogId, seq, taskChannelId, contextId })
```

### E2. Parallel workstreams (all launched at once; worktree-isolate any that collide)

| WS | Scope | Primary code |
|---|---|---|
| **WS-1 gad substrate** | Lineage-true fork as a **new `vcsForkContext` DO method** (ctx-head fork edges via forkLog mechanics + edit-op copy + `forkProvenance`; host `forkContext:1593` becomes a wrapper); **source-side commit-gate in `vcsMerge`** (target-only at `:6953` today); `getLogLineage`; `vcsPick` engine (commit-patch forward-apply, dual of `revertWorking:4957` + path-level working-content injection) | `workspace/workers/gad-store/` |
| **WS-2 host VCS** | Generalized `vcs.merge({ source })` (old main-pinned `mergeHeads(_, VCS_MAIN_HEAD)` at `vcsService.ts:446` deleted), **all callers updated** (CLI `vcsCommands`, panels, skills); precise dirty-side error surfaces for **both-sides** commit-gated merge-back; **net-new read-time cross-context authorization AT the `context.boundary` gate** (control-plane-only today); `context: { contextId }` scope on read surfaces + `vcs.contextDiff` + `vcs.pick` dispatch | `packages/service-schemas/src/vcs.ts`, `src/server/services/vcsService.ts`, `src/server/vcsHost/` |
| **WS-3 runtime** | Context-relationship registry (typed `lifecycle`/`lineage` edges, `listOwnedContexts` — no context→context edge exists today); `destroyContext({ recursive })` post-order teardown of the lifecycle subtree (today `:575` selects by `contextId`, traverses nothing); `cloneContext({ recursive, targetKey })` per the §E1 contract: **new `targetKey` idempotency** (deterministic child ids so the fork-op reconciler can resume without orphaning), lifecycle-subtree walk, root-only `include`, full descendant clone, rewiring map, cloned-child re-parenting, pending-call re-homing (new `aborted-by-fork` settle reason), error on non-recursive-with-lifecycle-children | `src/server/services/runtimeService.ts`, `packages/shared/src/runtime/` |
| **WS-4 agent-loop** | `publishPolicy` gating in effects derivation (**generalize + delete existing `silentPolicy():343`**); `say` (**generalize + delete existing `createSayTool`**, `silent-agent-worker/index.ts:51`) + `read_subagent` tools; `wakePolicy` field/config (its **resolution** lands in the vessel/WS-5, not here); depth/fan-out limits (`agentHopLimit:118` already guards chat loops) | `workspace/packages/agent-loop/`, `workspace/workers/silent-agent-worker/` |
| **WS-5 vessel** | Per-channel fork (`canFork`/`postClone` rework, ≤1-subscription gate deleted); `initFromTrajectoryFork`; `spawn_subagent`/`send_to_subagent`/`inspect_subagent`/`merge_subagent`/`pick_from_subagent`/`close_subagent`; supervisor turn-final buffering (log-derived, replay-safe); explicit lifecycle/GC | `workspace/packages/agentic-do/` |
| **WS-6 channel + fork service** | `getProvenance` (root/fork/task); lineage-signal hub (`subscribeLineage` — **new signal-only subscription mode** on top of the existing `sendSignal:921` transport, head-advance reporting to root, `fork.head_changed` fan-out); durable `fork_ops` journal + `fork()` RPC + alarm reconciler (reuse `alarm():1442`) in the parent channel DO (**gains `callMain`** to drive host `cloneContext`/`destroyContext`); `appendSeed` service-authored append (**hard-scoped to the fork op — first human-attributed forged append**); **delete `workspace/workers/fork`**; `forkConversation` client helper; news-panel migration (`news/index.tsx:713`) | `workspace/workers/pubsub-channel/`, `workspace/packages/channel-fork/`, `workspace/panels/news/` |
| **WS-7 protocol** | New event kinds + schemas + channel/trajectory reducer folds (`forks`, `saliency`, `replaces`, subagent invocation payloads) per E1 | `workspace/packages/agentic-protocol/` |
| **WS-8 chat UI** | Fork/edit affordances (incl. agent-message edit-fork with `replaces` rendering); ChatHeader switcher + fork-tree view with live lineage badges (`subscribeLineage` + `fork.head_changed`); inline fork rows + shell toasts with Switch action; navigation switching + open-in-child-panel; SubagentRunCard + inspection child panel; "Review & pick" diff-review integration (`vcs.contextDiff` + per-file/per-commit pick actions) on run cards and fork entries | `workspace/packages/agentic-chat/`, `workspace/panels/chat/` |
| **WS-9 tests** | Author the full verification suite (E3) against the pinned contracts, in parallel with everything else | test suites across the above |

### E3. Single integration + verification pass (the only green requirement)

1. Reconcile contract drift across workstreams; full typecheck/build.
2. Verification suite — all must pass:
   - Edit-&-fork on a live multi-agent conversation: fork created by the parent channel's **durable fork op** with the seed appended server-side (primary user-authored, `replaces` marker intact), `channel.forked` on parent, second participant badged + toasted, switches by navigation; agents resume from the edit. Crash injection at **every phase boundary** of the fork op: the alarm reconciler either completes the fork (advertised + seeded) or rolls it back — never an advertised-empty fork, never an unadvertised live clone. **This test presupposes the `cloneContext` `targetKey` idempotency (§E1): without it, a crash between the clone returning and the journal write orphans a live clone and the test cannot pass.**
   - **`appendSeed` abuse containment:** the seed append is reachable ONLY by the owning fork op — a userland agent (or any non-fork caller) attempting `appendSeed`, or attempting to forge a human-attributed primary envelope with an arbitrary `onBehalfOf`, is rejected (first path that forges human-attributed messages; §A3).
   - Agent-message edit-fork: replacement lands user-authored with `replaces`, renders in-place, agents continue from it.
   - Fork with uncommitted edits: child status shows them uncommitted; divergent commits both sides; `getMergeBase` finds the shared ancestor; merge succeeds.
   - Two-channel agent forks one channel cleanly (other subscriptions dropped in the clone).
   - Quiet agent (`publishPolicy: "turn-final"`) publishes only end-of-turn + `say`; trajectory retains intermediate text; live inspector sees ephemeral deltas. **The pre-existing silent agent is migrated onto this same `publishPolicy`/`say` path; the bespoke `silentPolicy()` / `createSayTool` are deleted (dead-code audit — no parallel mechanism).**
   - Parent spawns fresh + forked subagents; supervisor wakes only on turn-final/say; steers mid-run via `send_to_subagent`; human inspects + posts via child panel; `close_subagent` tears down entity + context.
   - Merge-back: a committed child merges into a committed parent branch-to-branch with **zero `main` ref movement**; a dirty parent or child gets a precise, actionable error, commits, retries, and merges; the conflicted case resolves through the existing pending-merge machinery (`vcs.edit` + `vcs.commit`, or `vcsAbortMerge`).
   - Cherry-pick: parent inspects a subagent's context (`inspect_subagent` / `vcs.contextDiff`); a commit pick applies one child commit onto the clean parent head with `pickedFrom` provenance (conflicting pick → pending-merge → resolve → seal); a path pick lands the child's **uncommitted** working content as uncommitted parent edits; the same flow works against a conversation fork via the switcher's "Review & pick"; unauthorized cross-context inspection (non-owned context) is rejected by the boundary gate.
   - Fork with live subagents: recursive clone walks lifecycle edges only, clones descendant contexts **in full** despite a root-scoped `include`, rewires lifecycle edges, task-channel subscriptions, provenance, and pending calls; both trees operate independently afterward. **Crash mid-recursive-clone (after N of M descendants) reconciles to a single complete tree, not a partial-plus-duplicate — exercising per-descendant `targetKey` idempotency and per-descendant journal progress (Part D).**
   - Edge-kind separation: destroying a conversation's context (recursive) tears down its subagents but leaves its conversation forks fully alive and reachable; a fork can outlive and be inspected/picked from after its source is gone.
   - Fork switcher, tree view, and **live** badges: a message appended in a sibling fork badges the switcher via `fork.head_changed` without any panel poll; **a dropped signal still reconciles from durable state on roster/tree open (§H)**; repeated cross-context panel navigation keeps stateArgs/storage isolation intact.
3. Breaking-changes register (Part F) fully applied — every listed caller updated, every replaced surface deleted.
4. Dead-code audit (repo policy): no orphaned fork/edit/merge scaffolding remains.

---

## Part F — Breaking changes register

Pre-release, no compatibility kept — but per policy, every tightened/removed surface listed explicitly:

1. **`canFork` semantics change**: no longer fails on >1 subscription; becomes per-channel preflight. Callers relying on the old gate (fork.ts preflight) are updated in the same change.
2. **`postClone` (vessel) signature/behavior**: forks a named subscription and **drops all other subscriptions in the clone** (previously: implicitly single-subscription).
3. **The fork worker is deleted**; forking becomes a durable, journaled `fork()` RPC on the parent channel DO that *also appends* `channel.forked` to the parent log — forks become visible to all parent subscribers, and any consumer assuming forks are silent or worker-driven (none known beyond news) changes behavior. **The channel DO gains host-call (`callMain`) access it never had, to drive `runtime.cloneContext`/`destroyContext`; `cloneContext` gains a `targetKey` idempotency parameter (§E1) that its current callers do not pass.**
4. **News panel deep-dive**: bespoke fork wiring deleted; re-implemented on `forkConversation` + lineage events.
5. **Channel reducer output**: `ChannelViewState` gains `forks`; downstream exhaustive switches over event kinds must handle the three new kinds.
6. **`AgentLoopConfig`**: new fields (`publishPolicy`, `wakePolicy` per subscription, subagent limits); fold/effects derivation changes — fold-cache entries invalidate (cache, safe).
7. **`vcs.merge` signature replaced**: `merge({ source: "main" | { contextId } })` (host dispatch `vcsService.ts:446`); the implicit source-=-main form is deleted. Target-side commit-gating is unchanged (`gad-store:6953`), but **source-side commit-gating for a `ctx:` source is net-new** — "commit-gated on both sides" is a new enforcement, not inherited behavior. Correction to an earlier draft: `main` as a merge *target* is **not** rejected at the engine (it routes through `runVcsMergeMain`/`updateMains`, `:6937`); only the host layer rejects a main target. All callers (CLI `vcsCommands`, panels, skills) updated in the same change.
8. **`forkContext` semantics change**: child is no longer a flattened clean pin — it inherits the parent's pinned base, a lineage-descendant ctx head, and the parent's uncommitted edits *as uncommitted edits*. **The logic moves into a new gad-store `vcsForkContext` DO method (§E1); the host `forkContext` (`workspaceVcs.ts:1593`) becomes a thin wrapper.** Anything that assumed a freshly forked context reports clean status (news deep-dive, fork tests, `vcsContextStatus` consumers) sees different — truthful — status. `cloneContext` callers unaffected in content, affected in status.
9. **Context relationships become first-class runtime state**: contexts record typed edges (`lifecycle` for subagents — cascaded and cloned; `lineage` for forks — access/provenance only, never cascaded); `cloneContext` gains `recursive` over lifecycle edges (non-recursive clone of a context with lifecycle children becomes an explicit error rather than a silent partial clone) and returns a rewiring map; `destroyContext` gains `recursive` post-order lifecycle teardown — previously teardown never traversed descendant contexts.
10. **Trajectory event vocabulary**: subagent runs introduce invocation payloads with new shapes; `message.completed` trajectory events may now exist with **no** corresponding channel envelope (under `publishPolicy: "turn-final"`) — anything assuming 1:1 trajectory↔channel message correspondence breaks. **Blast radius is smaller than it reads: trajectory and channel are already separate reducers (`reducer-trajectory.ts` vs `reducer-channel.ts`), and `channel-chat-merge.ts` consumes only `ChannelViewState`, so `turn-final` just yields fewer projected channel messages (intended). The real audit target is transcript/export paths, not the live chat projection.**
11. **Unread-outbox `editMessage`** is *not* extended to read messages — the UI relabels affordances ("Edit" = in-place while unread, "Edit & fork" once read). No API removal, but UX semantics change.
12. **Cross-context reads become possible**: `readFile`/`listFiles`/`diff`/`log`/`status`/`contextStatus`/`pendingMerge` gain a `context: { contextId }` scope authorized by the ownership tree — a *loosening* of the previous strict own-context isolation. **The `context.boundary` gate does not gate reads today (control-plane only, `contextBoundary.ts:10-15`), so this adds a net-new read-authorization surface at that gate rather than relaxing an existing one.** New `vcs.pick` and `vcs.contextDiff` methods; the revert patch-application path is refactored to be direction-agnostic so pick and revert share one engine.

13. **`say` + publish-suppression are unified, not added** (§B4): the pre-existing silent-agent `createSayTool` (`silent-agent-worker/index.ts:51`) and `silentPolicy()` (`agent-loop/policies/index.ts:343`) are **deleted** and replaced by the config-level `publishPolicy` + a single core `say` local tool (now carrying `saliency: "say"`); the silent agent migrates onto them. Any code referencing the old worker-level tool/policy changes.

14. **`appendSeed` — a new privileged, human-attributed append**: the first path that writes a *primary, human-attributed* envelope with no participant-roster entry, on the `postClone` DO-trust plane (`@rpc callers worker/server`). Existing service-authored appends are `senderId:"system"` (system-attributed); this is not that. Must be hard-scoped to the owning fork op and unreachable by userland agents (§E3 adversarial test).

---

## Part G — Decisions (RESOLVED 2026-07-03)

1. **Fork × live subagents** → **recursive tree clone, no restricted mode**: `cloneContext({ recursive })` ships in the same delivery as everything else; forking with live subagents works from day one. No block/detach mode is ever built.
2. **Merge-back** → **commit-gated on both sides** (confirmed final 2026-07-03 after considering and rejecting working-state merging): `merge_subagent` errors precisely when either side is dirty; the agent/human commits deliberately on its private ctx head and retries. No auto-checkpoint, no dirty-target merging. The merge *surface* is still generalized to `vcs.merge({ source })`.
3. **Fork/edit affordance scope** → **agent messages included**: "Edit & fork" also replaces agent turns, published in the fork as user-authored with a `replaces` marker (authorship stays truthful in the log; UI may render in-place).
4. **Fork switcher placement** → **ChatHeader dropdown** as the primary surface, with the full fork-tree overlay behind its "Show tree" action — both ship together, both with live lineage badges.

## Part H — Implementation notes (hard requirements for the implementing agents)

- **Lineage-true fork** (WS-1) is the deepest change, and it lands as a **new gad-store `vcsForkContext` DO method** (the host `forkContext:1593` is a thin wrapper): apply forkLog's lineage mechanics (`parent_log_id`/`fork_seq`/`fork_hash`) to ctx heads and copy edit-op rows. There is no fallback design — build it as specified; its integration test (fork dirty → truthful status → divergent commits → merge base → merge) is the anchor of the E3 suite.
- **Recursive context-tree clone** (WS-3) must re-home pending calls across every cloned pair via the same reconciliation `postClone` runs; calls that cannot be re-homed settle as `aborted-by-fork` (a **new** settle reason) — never silently dropped. It must also be **crash-idempotent per descendant**: `cloneContext` takes a `targetKey` so every context in the tree gets a deterministic, forkId-derived id and the fork-op journal records per-descendant progress — otherwise a mid-clone crash orphans live clones.
- **Per-channel fork** (WS-5) rewrites the most battle-tested path (`postClone`); the existing fork suite plus new multi-subscription cases must both pass — behavior for the single-subscription case is unchanged by construction.
- **Supervisor buffering** (`wakePolicy: "turn-final"`) must not lose envelopes across DO hibernation — buffered state derives from the channel log (replay-safe by construction), never from in-memory queues.
- **Lineage signals** (`fork.head_changed`) are ephemeral and advisory — badges must also reconcile from durable state on roster/tree open, so a missed signal can never wedge the UI.
- **Panel navigation across contexts** (fork switching) exercises `buildPanelLink` cross-context; repeated navigation must keep stateArgs and storage isolation intact (covered in E3).
- **`cloneContext` idempotency is a hard prerequisite, not an optimization** (WS-3): it mints `randomUUID()` today (`runtimeService.ts:512`). The `targetKey` parameter is required for the journaled fork op to resume a crashed clone without orphaning it — the §E3 crash-injection acceptance test cannot pass without it.
- **Source-side merge gating** (WS-1/WS-2): `vcsMerge` gates only the *target* today (`:6953`); the both-sides contract needs a new source-side dirty check for `ctx:` sources — in `vcsMerge` or as a host/vessel pre-check — with a precise "which side, which repos" error.
- **No parallel `say`/publish path** (WS-4): the existing `silentPolicy()` (`agent-loop/policies/index.ts:343`) and `createSayTool` (`silent-agent-worker/index.ts:51`) must be *generalized into* `publishPolicy`/`say` and **deleted**, not left beside the new mechanism (repo dead-code policy).
- **`appendSeed` is a trust-plane surface** (WS-6): it forges human-attributed primary messages with no roster entry — hard-scope it to the owning fork op and add the adversarial §E3 test; an escape lets something post *as the user*.
- **Channel DO gains `callMain`** (WS-6): owning the fork op means the channel DO drives host `runtime.cloneContext`/`destroyContext` across the DO↔host boundary; the journal must treat that RPC as a crashable step (the reason `cloneContext` idempotency is load-bearing).
- **Clone/destroy default asymmetry is intentional** (WS-3, §B7): `cloneContext` errors on lifecycle children, `destroyContext` default-cascades them — resolved as correct (a lifecycle child exists only to serve its owner; forks are lineage edges and never cascade). Enforce only that the cascade follows `lifecycle` edges exclusively and never crosses a `lineage` edge.
