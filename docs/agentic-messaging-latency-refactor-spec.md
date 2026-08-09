# Agentic Messaging Latency Refactor

**Status:** implementation in progress, rev 4; Phase 0 and the first dispatch
fast-path reduction landed
**Date:** 2026-08-09
**Scope:** user message commit through durable delivery, recipient admission,
model-turn claim, receipts, recovery, and the runtime images and dispatch
machinery used on that path

> **Architecture supersession (2026-08-09):** The measurements, latency goals,
> and one-mailbox motivation in this document remain useful. The routing and
> lifecycle design is superseded by
> [Hibernation-First Agentic Messaging and Subagent Lifecycle](./hibernation-first-agentic-messaging-and-subagent-lifecycle-plan.md).
> In particular, activation incarnation is not membership or delivery identity;
> durable relationships use stable participant identity plus an executable
> entity endpoint; DO members own no subscription response stream; receipts are
> projections; and subagents have retained terminal state with no close action.
> Where this document conflicts, the hibernation-first contract is authoritative.

Rev 4 re-baselines the plan against the durable task-card and durable GAD
publication work that landed after rev 3. It makes subagent progress a view of
an execution-independent task log instead of a copied parent-channel message
stream, and replaces the former all-at-once Phase 3 with bounded vertical
cutovers that never run two semantic routes at once. Rev 3 separates the
reusable durable-delivery kernel from the co-located agentic policy projection,
defines current-policy-at-first-admission semantics, and versions both
replayable projections. Rev 2 was a full rewrite: rev 1 was
built on a transaction boundary that does not exist (§2.1), omitted the largest
measured dispatch costs (§3), and sequenced the most expensive interventions
first. This revision preserves rev 1's goals — one mailbox owner, delivery
decoupled from agent activation, small coordination images — but re-derives the
design from the code as it stands.

This specification refines the messaging portion of
`agentic-hot-path-work-dispatch-plan.md`, which is substantially landed: the
§6.1 durable-work queues, generation fencing, exact batch acknowledgement,
recovery-only worker adoption, durable alarm dispatch claims, and the
host-owned `DurableWorkDriver` all exist and work. This document does not
re-litigate that protocol. It changes what the queues carry, who decides
routing, what "delivered" means, and how much machinery one small message must
traverse.

There is no requirement to migrate developer-instance queue rows. Cutovers
reset unresolved local agentic work. There must be exactly one delivery route
after each phase; compatibility shims, dual writes, and shadow consumers are
out of scope.

## 1. Decision

A committed message becomes **delivered** to a recipient when a durable mailbox
row for that recipient exists — not when the recipient's heavyweight reasoning
runtime has activated, admitted, or answered.

Four structural changes carry the design:

1. **A generic durable-delivery kernel owns the mailbox.** GAD remains the
   single owner of event facts (§2.1). The kernel derives one mailbox row per
   effective subscriber from the committed log and a sequenced subscription
   fold. A crash between append and fan-out is recovered by **replaying the
   derivation**, not by an impossible atomic cross-DO co-commit (§2.2).
2. **Agentic policy is a consumer of that kernel, not part of it.** The
   collaboration channel may co-locate the delivery kernel and agentic policy
   projection in one Durable Object and one local transaction, but the kernel
   knows nothing about agent streak, respond policy, model turns, context
   integrity, or model-visible `read` (§5.1).
3. **Routing splits into channel-owned coarse fan-out plus cheap recipient
   admission.** The channel decides _who gets a mailbox row_ from committed
   subscription state, with no per-message call into any agent. The recipient
   still decides _whether to engage_ (respond policy, hop limits, wake policy),
   using a co-derived agentic context plus local state — never live channel
   round trips (§6).
4. **Receipts leave the message plane.** `delivered` is mailbox state and
   `read` is a deterministic fold projection update. Neither is a channel
   publish, so receipts stop re-entering the delivery pipeline and fanning out
   to every structured participant (§4, §3.4).

The host remains the executor for genuinely external or long-running effects:
model provider calls, tools, evals, HTTP, browser work, human waits. Moving
local coordination out of the host entirely (a workerd-native runner with
direct bindings) is a **gated** phase behind two unresolved platform designs —
attestation residency and latch residency (§8) — not an assumption.

## 2. Ground truth this spec is built on

### 2.1 GAD owns the canonical message log; the channel does not

The durable append is `channelLog.append(...)` — a cross-DO RPC from the
channel into `GadWorkspaceDO`
(`workspace/workers/pubsub-channel/channel-do.ts:1471-1481`). Payload bytes,
`contentClass`, and `externalKeys` are persisted in GAD; the fork fold
hard-fails on an envelope lacking them (`channel-do.ts:4249-4258`). Any design
sentence of the form "one local SQLite transaction appends the message and the
mailbox rows" is fiction. The channel's local durable state is: participants,
policy fold cursors (`foldedThroughSeq`), dedup keys, and the delivery queue.

Consequence: the mailbox cannot be atomic with the append. It must instead be
**recoverable from the append** — rederivable from the log cursor plus
committed membership, with deterministic IDs so replay is idempotent. That is
strictly stronger than atomicity for our purposes: it also heals rows lost to
bugs, not only to crashes.

### 2.2 The current fan-out still has an unrecovered crash gap

`appendDurable` commits in GAD before `broadcast()` materializes recipient
mailboxes. Phase 0 now projects the cached participant incarnations and inserts
all structured-recipient rows in one local transaction, replacing the prior
incarnation `SELECT` plus `transactionSync` per recipient. This removes partial
fan-out within one channel transaction, but a crash after the GAD append and
before that transaction still leaves the durable message with no mailbox rows,
and no recovery path re-derives them. §5's derivation cursor closes that
remaining append-to-projection gap.

### 2.3 What one message actually costs today

The measured no-load path for one message on `chat-c0dd4d6c` was ~5.2 s from
hint to visible read. Attribution, from the code:

**Queue mechanics.** Three host round trips (claim / held execute / settle) per
queue item, times at least three queue items (inbox transition,
prompt-artifacts effect, model-call effect), plus one publish effect per
receipt.

**Per-dispatch stack**, paid on every host→DO call
(`src/server/doDispatch.ts:534-578`):

- exact-execution readiness fully re-derived per dispatch —
  `DurableObjectExecutionReadiness.ensureReady`
  (`src/server/durableObjectExecutionReadiness.ts:28-65`) →
  `restoreDurableObjectEntity` (`src/server/workerdManager.ts:837-921`),
  including two-to-three `canonicalJson(authority)` serialize-and-compares and
  a post-condition re-verify; there is no memo of any kind;
- attestation minted fresh per call — `attestDirectRpc` with a `randomUUID()`
  nonce, run **twice** for non-open capabilities
  (`src/server/services/authorityRuntime.ts:358-483`), plus per-call token
  ensure. The former linear scan of the build's `workspaceRpcCatalog` is now
  an index built once per immutable build (`workerdManager.ts:1620-1650`);
- a fresh connection per invocation (`pipelining: 0`,
  `src/server/workerdRpcRelay.ts:33-45`);
- inside workerd, every inbound userland DO request hairpins back into Node —
  `UniversalDO.fetch` calls `GATEWAY.fetch("/_doversion/...")` before touching
  the facet (`src/server/workerdPrograms/universalDo.ts:122-219`).

**Activation.** Userland DO facets load via `env.LOADER.load(...)` — an
**unshared isolate per DO instance** (`universalDo.ts:98`) — unlike plain
workers, which share compiled isolates per `name@version` via `LOADER.get`
(`workerdPrograms/workerHost.ts:67-84`). Every agent DO activation individually
pays gateway fetch + JSON decode + parse/compile of the full primary module:
11.0 MB executable for the agent worker (measured; 42.6 MB with the inline map
before the Phase 0 change), 2,911 sealed modules. Worker builds set
`splitting: false` (`src/server/buildV2/builder.ts:2853`), so every existing
`await import(...)` — pi-ai's lazy providers, unpdf — is inlined as an `__esm`
wrapper: execution deferred, parse/compile not. The channel coordination DO is
2.02 MB for the latest measured channel primary (2,018,869 bytes, 219
executable modules). Its executable inputs contain no `@workspace/harness`
module: every channel import from that package is type-only and erased. The
largest source groups in the build metadata are zod (~299 KB), first-party
(~239 KB), `@workspace/runtime` (~238 KB), ajv (~206 KB),
`@workspace/pubsub` (~199 KB), and `@workspace/agentic-protocol` (~189 KB).
The declared harness dependency still expands the effective-version/rebuild
graph, but it does not explain runtime image bytes.

**Per-message transition work** inside the held inbox execution
(`agent-vessel.ts:2891-3078`):

- `shouldRespond` awaits an **uncached** `channel.getPolicyState()` cross-DO
  round trip per message, plus 5 s-cached config/participants and a
  conditional `getMessageSender` (`agent-vessel.ts:3288-3345`);
- `contextIntegrity.ingest` — one agent→host RPC with full authority
  evaluation, which fans into a host→GAD `getChannelEnvelope` for the `msg:`
  class (`src/server/services/contextIntegrityService.ts:20-71`);
- `publishReceivedAck` awaited inline (`agent-vessel.ts:3037`);
- `refreshRoster` on every approved input, with a GAD `roster.snapshot` append
  and a recursive `handleIncoming` cascade on any fingerprint change
  (`agent-vessel.ts:3043-3060, 3500-3520`);
- `FoldCache.loadState` does an unconditional GAD `getLogHead` per loop entry
  and pages the log on any stale fold (`fold-cache.ts:85-90`);
- the GAD append itself — the commit (`agent-loop-driver.ts:1128-1147`).

**Receipt storms.** `message.received` and `message.read` are ordinary channel
publishes. Every receipt is broadcast to **every** structured participant, each
of which runs the full claim → accept → inbox-claim → `shouldRespond` cycle to
conclude the receipt is not for it. With N agents, one human message generates
up to 2N receipt publishes, each fanning out N−1 further deliveries. Read acks
are additionally full effect rows — claim/execute/settle triples each
(`workspace/packages/agent-loop/src/step.ts:273-320`).

**Incidental hot-path costs.** The original baseline had
`DurableWorkDriver.trace()` eagerly building `JSON.stringify` log strings even
when the level filter dropped them (~6 per claim), and `traceHotPath` running a
`DELETE … NOT IN (SELECT … LIMIT 500)` retention sweep ~6× per message. Phase 0
made the former lazy behind `isVerbose()` and amortized the latter to one sweep
per 64 inserts. Every remaining DO `console.*` line is still an RPC + terminal
write + event fan-out through the worker-log bridge (`durable-base.ts:128-142`).

Browser import and test fan-out worsen all of this by consuming CPU and
event-loop capacity, but the no-load trace proves the base path itself performs
too much serialized coordination, activates too much code, and multiplies
itself through receipt fan-out.

### 2.4 The serialization ceiling is GAD, not a hypothetical

All agents' trajectory appends, all channel log appends, every fold head check,
and every `msg:` context-integrity class lookup serialize on **one**
workspace-scoped `GadWorkspaceDO` instance
(`packages/shared/src/workspaceServiceRpc.ts:76-103`). Every design choice in
this spec is scored partly by GAD round trips added or removed, and §10
measures GAD queueing explicitly. This spec removes two GAD hops per message
(§5.3, §6.2) and adds none.

### 2.5 2026-08-09 re-baseline: dispatch dominates, task progress is copied

The durable task-card split (`f36948ba8`) materially improved model behavior:
the exact `subagent-diff-inspection` system test fell from a 604 s timeout with
84 model calls to a passing 211 s run with five model calls. The remaining
trace still shows infrastructure latency large enough to distort progress
delivery. In the bounded 500-transition driver ring from that passing run:

| Queue                 | claim avg | execute avg | settle avg |
| --------------------- | --------: | ----------: | ---------: |
| agent inbox           |    445 ms |    1,505 ms |     534 ms |
| channel delivery      |    426 ms |      539 ms |     459 ms |
| workspace publication |    143 ms |    1,060 ms |     142 ms |
| agent effect          |    376 ms |    3,690 ms |     486 ms |

After exact-execution restoration caching landed, a fresh managed instance ran
the same exact test in 81 s despite making seven model calls rather than the
older run's five. Its bounded ring reported:

| Queue                 | claim avg | execute avg | settle avg |
| --------------------- | --------: | ----------: | ---------: |
| agent inbox           |     31 ms |      106 ms |      45 ms |
| channel delivery      |     46 ms |       48 ms |      51 ms |
| workspace publication |     20 ms |       99 ms |      28 ms |
| agent effect          |     35 ms |    1,570 ms |      32 ms |

This is one before/after diagnostic, not a percentile claim; model and workload
variance still require Phase 1's load profiles. The consistent roughly tenfold
reduction at claim and settlement boundaries does establish that
repeated restoration was a real universal multiplier. `_doversion`, authority
construction, and transport remain inside the new residual.

The same snapshot recorded 903 duplicate readiness hints. Hints are disposable
and coalesced correctly, so this is not a correctness failure, but it proves
that avoidable work is repeatedly presenting itself to the host driver.

Subagent progress currently amplifies that cost. A child tool event is delivered
to the supervising agent's task-channel subscription, inserted into the
supervisor's `agent_inbox_queue`, transformed through
`subagent_progress_outbox`, published as `task.progress` on the parent channel,
and then fanned out again — including back to the same structured supervisor,
which consumes it as non-prompt input. Progress is excluded from model context,
but it still pays the message machinery twice.

The newer task-card UI can already open the child's canonical transcript, but
it cannot simply replace the relay today: `close_subagent` destroys the child
context, and the task channel is currently bound to that context. The relayed
parent log is therefore the only surviving history after close. The root fix is
not batching that relay. It is to make the task log a parent-owned durable task
resource whose lifetime is independent of the replaceable child execution,
then let presentation read and tail that canonical log without accidentally
joining its conversation. Reuse the existing authorized GAD publication and
transcript pipeline if it already satisfies that invariant; introduce a generic
read-only log cursor only for capabilities the existing pipeline genuinely
lacks. The supervisor receives only addressed/explicit child messages and
terminal task facts.

The durable GAD publication outbox (`eaa4fe7f4`) closes GAD trajectory
publication-to-channel delivery for its own publication route. It does not
close the collaboration channel's ordinary `appendDurable` → `broadcast` gap;
the mailbox derivation cursor remains necessary for that path.

## 3. Intent that must be preserved

| Intent               | Required invariant                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Durable delivery     | A committed message's mailbox rows are recoverable from durable state alone — no hint, no live recipient.                    |
| Single fact owner    | GAD owns message facts. The mailbox is a rederivable projection, never a second semantic journal.                            |
| Exact target         | Delivery routes by stable participant identity and entity endpoint; execution generations fence attempts, not membership.    |
| Determinism          | Message, mailbox, work, and receipt IDs derive from stable semantic inputs; replay is idempotent.                            |
| Retry safety         | Execution is at least once; durable outcome application is exactly once (existing generation fencing).                       |
| Ordering             | One recipient observes one channel's messages in channel sequence order.                                                     |
| Isolation            | A slow recipient cannot block another recipient's fan-out, lane, or receipt state.                                           |
| Context visibility   | Prompt context derives from the GAD log fold. Delivery/admission outcomes never subtract conversation context from a member. |
| Agent authority      | GAD remains the authority for trajectory transition and model-turn ownership (gate B, landed).                               |
| Context integrity    | The lineage latch advances before message content is exposed to a model or protected action.                                 |
| Honest receipts      | `delivered` and `read` denote distinct durable facts; neither is inferred from activity.                                     |
| Recovery             | Owner-local state plus the log cursor suffice to rediscover unresolved work after restart.                                   |
| No clock authority   | Claims never expire by elapsed time; retry-at schedules eligibility only; recovery is lifecycle-driven.                      |
| Bounded coordination | A coordination request performs bounded local work and never owns provider/tool latency.                                     |

The context-visibility row is stated because it is easy to break silently: a
member whose delivery mode is `mentions` still sees the full conversation in
its fold-derived prompt when it next runs. Delivery rows decide _wake and
receipt_, never _context_.

### 3.1 General delivery versus collaboration semantics

The deployed channel worker is already a collaboration runtime: it composes
presence, forks, method calls, policy folds, agent-vessel delivery, and
agentic events. Calling the entire worker generic pub/sub would be fictional.
The reusable boundary is narrower and explicit:

1. **Ordered channel log:** event identity, ordering, publisher identity,
   generic audience headers, sequenced subscription lifecycle, and replay.
2. **Durable-delivery kernel:** subscription revisions, incarnation fencing,
   deterministic routing, mailbox rows, claims, retries, terminal outcomes,
   consumer checkpoints, and recovery.
3. **Agentic policy projection:** conversational addressing, admission
   context, respond/hop/wake policy, context integrity, trajectory transition,
   roster consequences, and the product meanings of `declined` and `read`.

These are logical ownership boundaries, not three mandatory services. Phase 3
keeps them co-located so generic delivery rows and agentic context can be
derived in one local transaction with no new network hop. Dependency direction
is one-way: agentic policy imports the delivery kernel; the delivery kernel
must not import agentic protocol or model-turn types. A public plugin framework
is not required until a second application proves that abstraction.

## 4. Receipt semantics

The wire and UI vocabulary becomes:

- **received:** the channel accepted the sender's publish and the GAD append
  committed. (This is today's implicit "message exists" fact; it needs no new
  storage.)
- **delivered:** the recipient's mailbox row is durably committed.
- **read:** the message became model-visible to the recipient. Read is a
  **cursor, not a per-row event**: a turn that exposes conversation content
  through channel sequence S marks every delivered row at or below S read by
  that turn — including previously `declined` rows, whose content enters the
  prompt through the fold when a later message is admitted. This matches the
  semantics the current code already has (`readAckEffects` derives acks from
  the consumed set through `contextThroughSeq`,
  `agent-loop/src/step.ts:273-320`); defining read per-claimed-row would
  regress it and leave model-visible messages permanently unread.

These are **agentic product meanings**, not states baked into the generic
delivery kernel. The kernel records event committed, delivery row created,
claim generation, terminal outcome (`processed`, `ignored`, or terminal
failure), and monotonic consumer checkpoints. The agentic receipt projection
maps those facts to `received`, `delivered`, `declined`, and model-visible
`read`. Another consumer may interpret the same generic checkpoint as indexed,
replicated, rendered, or acknowledged.

**Receipts stop being channel messages.** Today's `message.received` /
`message.read` publishes are deleted along with their fan-out storms (§2.3).
Replacement mechanism:

- `delivered` derives from the generic mailbox insert (§5.3); the co-located
  agentic projection exposes per-message receipt state (`deliveredTo`,
  `readBy`) queried and streamed on the existing channel subscription, not
  appended to the log.
- `read` is reported by the recipient's settlement of the mailbox claim as a
  cursor advance — `readThroughSeq` plus the turn coordinate, deterministic
  identity `read:<channelId>:<recipientId>:<turnId>` — and the channel marks
  every delivered row at or below the cursor read in the projection. A
  duplicate or lagging report is idempotent; the cursor is monotone.
- The UI reducer consumes the projection instead of `receivedBy`/`readBy` fold
  maps (`workspace/packages/agentic-core/src/channel-chat-merge.ts:406-426`).
  Multi-viewer consistency is preserved because the projection is channel
  durable state replayed/streamed to every subscriber, same as presence.

Two intended behavior changes, stated so nobody mistakes them for regressions:

1. **"Awaiting delivery" resolves at mailbox commit** — typically within tens
   of milliseconds — instead of waiting for agent activation, policy fetches,
   and a receipt publish round trip.
2. **The stuck-outbox bug is fixed.** Today an agent whose `shouldRespond`
   returns false never emits any receipt, so the sender's outbox shows
   "Awaiting delivery" for that participant forever, against an
   `intendedRecipients` set snapshotted client-side at send time
   (`agentic-protocol/src/reducer-channel.ts:266-289`). Under this spec the
   intended-recipient set is the channel's own fan-out decision, delivered
   state is real, and an admission decline leaves an honest
   `delivered`-but-not-`read` state instead of a permanent pending.

`delivered` precedes recipient admission by design. A mailbox row for a message
the recipient's admission later declines is an honest fact, not a false
receipt.

## 5. Ownership and data model

### 5.1 One channel worker, two projection layers, strict dependency direction

Phase 3 composes two channel-local projection layers and one recipient-local
decision journal:

- **Generic delivery projection:** sequenced subscriptions, routing,
  incarnation-fenced mailbox rows, claims, terminal outcomes, consumer
  checkpoints, and recovery.
- **Agentic policy projections:** channel-local conversational fold state,
  admission context, trusted content-integrity inputs, model-read cursor, and
  product receipt presentation, plus a recipient-local durable first-admission
  decision.

The two channel-local projections remain in one Durable Object and may update
in one `transactionSync`; the recipient journal stays with the recipient. This
preserves the current latency and atomic local projection while keeping the
delivery kernel reusable. Generic tables and modules contain no agentic columns
or imports. Agentic tables key their state by the generic `delivery_id`. A
separate mailbox service or public extension framework is explicitly out of
scope unless later capacity evidence requires it.

### 5.2 Subscriptions are folded from the log (identity details superseded)

The hibernation-first plan supersedes incarnation replacement and any live
response-resource semantics below. Relationship open/revise/end remains a
sequenced fold, but stable participant identity and entity endpoint determine
historical routing.

Subscription changes — open, revision, close, incarnation replacement, and
delivery-mode change — become **durable log events**, appended through the same
GAD path as messages and sequenced by the same log. The generic subscription
interval table is a fold over those events, not independently authored state:

```ts
interface SubscriptionApplicationConfig {
  schemaId: string;
  schemaVersion: number;
  payload: JsonValue;
}

interface ChannelSubscription {
  subscriberId: string;
  incarnation: string;
  delivery: "all" | "addressed" | "none";
  revision: number;
  applicationConfig: SubscriptionApplicationConfig | null;
  effectiveFromSeq: number;
  effectiveUntilSeq: number | null;
}
```

The kernel interprets identity, incarnation, revision, and delivery mode only.
The outer application envelope is closed and generic; the named application
layer validates the payload against its declared schema before append. The
agentic layer owns the schema and meaning of its payload. Raw agentic
`mentions`, `to`, and similar constructs are normalized before routing into a
generic audience header (`broadcast` or resolved participant IDs). That header
is stored in the committed event envelope; the kernel does not interpret
conversational syntax.

No cross-store transaction is claimed: an interval bound is the subscription
event's own GAD sequence. The local interval table is disposable fold state,
rebuilt by the same reconcile that heals delivery rows. Today's `participants`
table remains for live connections and presence only; it carries no durable
routing authority.

Fan-out and recovery evaluate subscriptions **as of the event sequence**. A
subscriber active at sequence 100 remains an intended recipient of event 100
after leaving at 101. A replacement incarnation receives future work only and
does not inherit old executable rows implicitly. This prevents crash timing or
reconnection from changing historical routing.

`delivery` is coarse and general. It determines whether a mailbox row exists;
it does not decide whether an agent responds or what later appears in prompt
context. A mentions-only agent still sees the full fold-derived conversation
when a later admitted turn runs.

### 5.3 Generic delivery rows and agentic context (row schema superseded)

The authoritative mailbox schema and deterministic delivery identity are in
the hibernation-first plan §6.3–6.4. `subscriber_incarnation` is not part of the
primary key or `delivery_id`.

The generic mailbox replaces `channel_delivery_queue` and the message-bearing
portion of `agent_inbox_queue`:

```sql
CREATE TABLE channel_delivery_mailbox (
  channel_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  subscriber_incarnation TEXT NOT NULL,
  channel_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  subscription_revision INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('ready', 'claimed', 'processed', 'ignored',
              'terminal-departed', 'terminal-retired', 'terminal-failed')
  ),
  generation INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  completed_at INTEGER,
  last_error_json TEXT,
  PRIMARY KEY (subscriber_id, subscriber_incarnation, channel_sequence),
  UNIQUE (delivery_id)
);
```

`delivery_id` derives from channel, event, subscriber, and incarnation. Claim
timestamps schedule eligibility and record history; they never establish that
an executor died. Claims are released only by positively identified generation
adoption. `envelope_json` is the validated generic delivery envelope (headers
plus inline body or canonical content reference); it is a rederivable copy for
consumption, not a second semantic owner of the GAD event.

Agentic state is adjacent and separately owned:

```sql
CREATE TABLE agentic_delivery_context (
  delivery_id TEXT PRIMARY KEY,
  projector_version INTEGER NOT NULL,
  context_json TEXT NOT NULL
);
```

`context_json` has a closed, versioned agentic schema. It contains the trusted
`contentClass`/`externalKeys` projection and channel-derived admission facts,
but the generic kernel neither validates nor interprets those fields. This
removes today's pre-model `getChannelEnvelope` lookup without moving semantic
message ownership out of GAD. Agentic delivery context and receipt/read
projection live channel-side; first-admission decisions are recipient-owned
durable rows keyed by `delivery_id`. None are generic mailbox columns.

### 5.4 Fan-out as two rederivable projections

The channel maintains a generic durable delivery cursor and folds log events in
sequence order. For each event:

- a subscription event updates the generic interval table;
- a deliverable event inserts generic mailbox rows for the subscribers selected
  by the interval state and normalized audience header;
- the co-located agentic projector may insert one typed context row per agentic
  delivery;
- the cursor and generic delivery checkpoint advance in the same local
  transaction.

On the happy path the fold runs inline after append and normally covers one
event. Recovery invokes `reconcileDeliveryProjection` for every durable,
reconcile-eligible channel entity, not merely channels already reporting ready
work. It compares the cursor with the GAD head and performs bounded, resumable
replay using `(log sequence, event phase, subscriber position)` so one event
with a large audience cannot create an unbounded transaction. The existing
dedup reservation remains a hint that accelerates targeted reconcile; the
durable channel registry remains the correctness mechanism.

The generic delivery result must be a pure function of versioned log events and
the declared kernel projection version. Agentic context is a separate pure
function with its own `projector_version`. Software updates may not silently
reinterpret history: a version change requires an explicit reset/rebuild rule
for disposable developer state or a reviewed migration for retained channels.
“Replay is byte-identical” always means under the same declared projection
versions.

This deletes `channel_delivery_queue`, `acceptChannelBatch`, and the
message-bearing `agent_inbox_queue` route in one cutover. No generic and
agentic dual delivery paths coexist.

### 5.5 Admission-time semantics

Channel-owned facts are fixed at the event sequence and written by the agentic
projector: sender and audience, resolved `replyTo` sender, prior completed
sender/message, participant ID/handle mapping, conversation policy, hop limit,
and agent streak. Streak is folded channel state, **not recipient-local**.
Judging it at the event sequence is an intentional correction for delayed
admission.

Admission reads current recipient-owned `respondPolicy`, `respondFrom`, wake
policy, self/incarnation, and subagent-run state. This gives control changes
their intuitive meaning: they affect queued work that has not yet been
admitted. The first admission decision is persisted before model/tool work;
the recipient writes an `agent_admission_decision` row keyed by `delivery_id`,
containing the admitted/declined outcome, reason, and policy fingerprint.
Retries resume that row rather than re-deciding under newer settings. Channel
settlement projects the durable recipient outcome into generic
`processed`/`ignored` plus the agentic receipt view; a lost settlement response
is reconciled by the same deterministic delivery identity.

Conversation policy and hop-limit changes need event-sequence semantics, so
they must be carried by sequenced subscription revisions rather than read from
today's mutable configuration during delayed derivation. **Phase 3 entry
criterion:** every input to current `shouldRespond` and wake handling is listed
with one owner — event, generic subscription fold, agentic projection, or
recipient-local first-admission state — and the list has no live channel read.

### 5.6 Recipient-local wakes are not channel mail

`agent_inbox_queue` is today also the injection point for
`scheduled_model_resumes` and subagent-progress synthetic rows
(`agent-vessel.ts:2480-2525`). These are recipient-local facts and must not
move into a channel-owned mailbox. They rehome to a small agent-owned
`agent_local_wake_queue` with the same durable-work contract, claimed on the
same lane as the recipient's transitions so ordering with message-driven turns
is preserved through explicit causal prerequisites, not merely by polling two
queues in one lane. A local wake dependent on channel sequence S is ineligible
until the recipient's channel work through S is terminal; independent timer
wakes need no invented global order. This is in Phase 3's scope; deleting
`agent_inbox_queue` without it breaks scheduled resumes and subagent progress.

### 5.7 Claim discipline

Unchanged from the landed contract: claims are bounded by recipient lane and
channel order; a later row for the same recipient/channel is ineligible while
an earlier non-terminal row exists; rows for other recipients and channels are
independently claimable; generation fencing exactly as today
(`channel-do.ts:1063-1213` semantics carry over); adoption happens at recovery,
not per claim (already landed,
`src/server/services/durableWorkDriver.ts:175-177`).

## 6. Recipient admission and the transition

The recipient transition, claimed from the generic mailbox and joined to its
agentic context by `delivery_id`, performs:

1. **Admission** — apply the sequence-fixed agentic context (§5.5) plus current
   recipient-owned policy on first admission. Persist that decision before
   external work. No channel RPC. Outcome `declined` maps to generic `ignored`
   plus an agentic reason; outcome `admitted` proceeds. (This replaces
   `shouldRespond`'s three-to-four live channel calls,
   `agent-vessel.ts:3288-3345`.)
2. **Context-integrity ingestion** — advance the latch from persisted
   `contentClass`/`externalKeys`. Ingestion is **cursor-shaped like read**: a
   turn exposing content through sequence S must ingest the lineage of every
   newly exposed message at or below S, including previously declined rows —
   not only the claimed row. (Today declined messages skip
   `recordMessageIngestion` entirely — the `shouldRespond` return at
   `agent-vessel.ts:3016` precedes ingestion at `:3027` — and coverage falls
   to the prompt-time merge path, chokepoint row 16 of
   `context-integrity-spec.md`. The cutover makes this explicit and test 10b
   pins it rather than inheriting it silently.) The latch store currently
   lives in host-process `node:sqlite`
   (`src/server/services/contextIntegrityStore.ts:60-80`); while it does, this
   is one host call, and it remains the _only_ host call in the transition's
   coordination section. Latch residency is one of the two gates on the
   workerd-native runner (§8).
3. **Trajectory transition** — the GAD append with head-CAS, exactly as
   landed (gate B: GAD owns the transition; the effect outbox is a
   reconciled projection, `agent-loop-driver.ts:1044-1216`).
4. **Settlement** — settle the generic claim as `processed` or `ignored` and
   atomically update the agentic receipt projection, including the read-cursor
   advance (`readThroughSeq` + turn coordinate) when the transition made
   content model-visible. The agentic projection marks every delivered row at
   or below the cursor read — processed and ignored alike; no separate receipt
   publish exists.

Roster refresh becomes event-driven: sequenced subscription changes update the
agentic roster projection, so `refreshRoster`-per-input and its GAD snapshot
cascade (`agent-vessel.ts:3043-3060`) are deleted.

## 7. Execution topology

### 7.1 Near term: one queue, host-claimed

After Phase 3 there is exactly one message-path queue. The host
`DurableWorkDriver` claims mailbox rows and dispatches the recipient
transition (§6) directly at the agent DO — the same claim/held-execute/settle
shape as today's inbox, minus one entire queue's worth of round trips (the
channel-delivery claim/`acceptChannelBatch`/settle triple disappears; its work
is the fan-out transaction inside the channel).

This is the defined route between Phase 3 and any later runner phase. It is
not an interim shim: if §8's gates never clear, this is the end state, and it
already meets the SLO targets for the warm path (§10) on paper — three host
round trips and two GAD round trips per message, with the dispatch stack
cheapened by Phase 2.

### 7.2 Host effect runner

Unchanged: the host driver continues to execute descriptors whose boundary is
outside workerd — model provider requests, tools, evals, external HTTP,
approval/human waits. Each effect keeps one durable owner, one claim route,
one settlement route. Capacity is configured per effect class and measured
with queueing delay; raising generic concurrency is not a substitute.

## 8. Gated: workerd-native coordination runner

Moving coordination claims out of the host into a workerd-native
`CoordinationRunner` with direct recipient/GAD bindings would remove host token
minting, URL routing, HTTP/JSON, and the host event loop from local
coordination. It is the right end state **and it is not designable today**,
because two platform questions are open. Asserting "authority is checked at
the receiving boundary using the same attestation semantics as today" — as
rev 1 did — is false: today's attestation is minted host-side per call with a
fresh nonce (`authorityRuntime.ts:358-441`), `__instanceToken` deliberately has
no workerd-side verifier (`doDispatch.ts:244-276`), and there are **no**
DO-to-DO service bindings at all — even in-workerd calls relay through the
Node gateway (`durable-base.ts:394-424`; the injected `WORKERD_URL` is read by
nothing).

**Gate R1 — attestation residency.** Either minting capability becomes
workerd-resident under the host-residency tier model (a sealed runner service
holding attester material, with the same audience/nonce/freshness semantics),
or the boundary is restructured so the sealed binding identity _is_ the proof
for runner-originated coordination calls. This is a security-architecture
decision with its own review, not a paragraph in this spec.

**Gate R2 — latch residency.** The context-integrity latch and lineage store
move to workerd-reachable durable state, or Phase 5's "host event loop paused"
exit criterion is amended to permit exactly the latch call.

Both gates must close in writing before any runner code. Direct bindings
change _transport and residency only_; authority evaluation, audience checks,
and replay protection must be equivalent under an adversarial review, and test
11 (§12) pins that equivalence.

## 9. Runtime images and dispatch machinery

### 9.1 Cheapest first: the import graph, not the topology

Measured composition of the 11.0 MB agent executable: unpdf 2.4 MB, mistralai
1.55 MB, first-party 1.13 MB, pi-ai 0.9 MB, zod 0.8 MB, @google/genai 0.7 MB,
@babel/parser 0.6 MB, openai/anthropic/opentelemetry/parsers the rest. Entry
chains: `model-spec.ts:14-18` **statically** imports
`@earendil-works/pi-ai/providers/all`; `effect-executors/model-call.ts:9-15`
imports the `compat` barrel that re-exports every lazy wrapper;
`agentic-core/renderer-lint.ts` pulls `@babel/parser` through
`shared/moduleImports`, re-exported from `agentic-do/src/index.ts:59`;
`agent-worker-base.ts:20-29` pulls the harness web/PDF/DOM closure.

The 2026-08-05 attribution pass on the latest channel artifact measured a
2,018,869-byte primary with 219 executable modules and **zero executable
`@workspace/harness` inputs**. The type-only imports are erased. The declared
dependency affects effective-version invalidation and rebuild fan-out only;
runtime-size work must target the measured zod/ajv/runtime/pubsub/protocol
closures rather than assume a PDF/DOM closure is present.

Ordered interventions, each measured before the next is authorized:

1. **Import hygiene (Phase 2).** Move the channel's shared event types to their
   owning protocol package and remove its declared `@workspace/harness`
   dependency to reduce rebuild invalidation; this is not a runtime-byte win.
   Separately, put `providers/all` and the compat barrel behind a real lazy
   boundary and break the babel re-export in the agent. Channel byte reduction
   is budgeted only after build diagnostics attribute the measured
   zod/ajv/runtime/pubsub/protocol closures to concrete entry chains.
2. **Shared facet loader (Phase 2 spike, gated).** The goal: N agent DOs on
   one build share one compiled isolate's worth of parse/compile instead of
   per-instance `LOADER.load` (`universalDo.ts:98`). This is **not**
   independently shippable as a swap to `LOADER.get(name@version)`: the
   current per-load environment is object-scoped — the `_docode` fetch
   carries `?objectKey=`, `env: code.env` may embed object-specific values,
   and `globalOutbound` binds a per-object egress caller identity
   (`egressBinding(ctx, egressIdentity)`) — so sharing keyed on version alone
   would share the wrong egress/authority identity across objects; and the
   `LOADER.get` entrypoint-stub shape used by plain workers
   (`workerHost.ts:68`) has no demonstrated `getDurableObjectClass` path.
   The spike must design and prove: per-object storage, environment, and
   egress-identity isolation under a shared compiled image; the loader key
   derived from the sealed execution identity, never a mutable selector; and
   the test-17 seal guarantee. It ships only when the isolation proof passes;
   the prize (the largest activation win available) justifies the spike, not
   a shortcut.
3. **Worker code splitting (Phase 2 spike).** Evaluate `splitting: true` for
   worker builds so dynamic imports defer parse/compile. Requires multi-module
   support through the loader path; a feasibility spike gates it.
4. **Coordination/execution worker split (Phase 6, conditional).** Only if the
   post-Phase-4 measurements still miss the cold-path SLOs: split the agent
   into a coordination worker (admission, ingestion, transition, receipt and
   descriptor derivation — schemas and descriptor types only, never provider
   SDKs, PDF, Babel, or optional tools) and an execution worker
   (model/provider orchestration, tool loop). Budgets set only after the
   split baseline is measured; initial targets: channel coordination primary
   < 1 MB, agent coordination primary < 2 MB.

Source maps stay linked build artifacts (landed with this spec's Phase 0;
`BUILD_CACHE_VERSION` 27, `builder.ts:2859, 2892-2896`), with zero map bytes
mounted into workerd. Extensions and terminal apps still embed inline maps;
they are off this path, but the stale "must use inline sourcemaps" rejection
in `packages/shared/src/unitManifest.ts:236-239` is corrected in Phase 0
cleanup. Build diagnostics gain per-worker primary/map bytes and
largest-inputs attribution (workers have none today; only panels do,
`panelBundleReport.ts`).

### 9.2 Exact-execution readiness and attestation caching

The readiness barrier protects a real invariant — a userland dispatch executes
the exact sealed image and never rebuilds from a mutable selector — but
re-derives it on every call (§2.3). `WorkerdManager` gains a single-flight
readiness table keyed by:

```text
(entityId, executionDigest, authorityHash, workerdBootGeneration)
```

`authorityHash` is in the key because `active_authority` can change
independently of the execution digest (`requireExecutable` checks all three,
`durableObjectExecutionReadiness.ts:47-65`); a digest-only key would serve a
stale authority seal. A successful entry means the exact image with the exact
authority is mounted in the current workerd generation. Concurrent callers
share the promise; failures are never cached past the in-flight promise;
entries die on generation change, entity retirement, digest change, or
authority change (invalidated from the entity-row write path, not observed by
polling). On a miss, the existing durable resolution and verification run
unchanged. Internal DOs remain statically ready. Tests must prove all
invalidation cases before the cache is enabled.

Companion reductions in the same phase, same invariant-preservation rule:

- **do not cache dynamic authorization results.** `attestDirectRpc`'s inputs
  include caller identity, grants, locks, relationship state, and
  context-integrity state (`authorityRuntime.ts:358-441`); any cache key
  omitting one of them serves stale authority, and a complete key's
  invalidation surface (every grant/lock/latch mutation) is a reviewed design
  of its own, not a Phase 2 item. Instead: collapse the double evaluation for
  non-open capabilities (`authorityRuntime.ts:469-483`) into one evaluation
  (or document why it is load-bearing), and cache only **static** inputs —
  receiver declarations and indexed catalog lookups. Per-call nonce and
  expiry minting is untouched. If Phase 1 measurement shows the single
  dynamic evaluation still dominates, a keyed authorization cache may be
  proposed then, as its own reviewed design;
- replace the per-request `_doversion` gateway hairpin with a version pushed
  into workerd on activation/invalidation, verified against the sealed
  identity rather than re-fetched;
- index `workspaceRpcCatalog` by method instead of linear scan (landed);
- revisit `pipelining: 0` with an explicit ambiguous-replay analysis before
  touching it — it is deliberate, and stays until the analysis says otherwise.

## 10. Observability contract

Every message carries one correlation ID from publish through read. Monotonic
spans, extended from rev 1 with the owners §2.3 proved are missing:

- channel publish queueing and execution; GAD append round trip and **GAD
  queue delay** (the workspace-global serialization point, §2.4);
- fan-out derivation execution; mailbox rows committed; derivation cursor lag;
- hint delay; claim queueing and execution;
- **readiness hit/miss and restore duration; attestation/authority resolution
  time; `_doversion`/version-resolution time; connection setup; facet load
  (shared-hit vs cold parse/compile)**;
- admission decision; context-integrity ingestion; GAD transition claim
  (head-CAS retries counted);
- effect queue delay per class; receipt projection commit.

Detailed transition traces stay in bounded inspectable storage
(`durableWork.inspect()`'s ring). Normal logs report summaries, threshold
violations, and failures. Trace/log string construction must be lazy behind
the level check — durable-work transition serialization is now lazy, and the
DO console bridge (RPC + terminal + event per line) must carry zero per-item
lines on the happy path.

Service-level objectives under the declared capacity envelope:

| Boundary                                               |   p50 |    p99 |
| ------------------------------------------------------ | ----: | -----: |
| publish accepted → GAD append committed                | 15 ms |  60 ms |
| append committed → mailbox rows committed (delivered)  |  5 ms |  25 ms |
| mailbox commit → transition claim                      | 10 ms |  25 ms |
| claim → GAD transition committed, warm                 | 25 ms | 100 ms |
| messaging while another agent runs a model/tool effect | 25 ms | 100 ms |

Report CPU saturation, RSS, workerd image bytes, event-loop delay, ready-queue
depth, active lanes, oldest-item age, and **GAD queue depth** beside latency.
Core count alone is not a capacity model.

## 11. Implementation phases

### Phase 0 — safe reductions (landed with this spec)

- Worker source maps emitted as linked `map` artifacts; only primary
  JavaScript mounted in workerd; build cache identities invalidated
  (`BUILD_CACHE_VERSION` 27).
- Durable-work generations adopted during recovery, not per claim (landed).
- Queue traces retained in `durableWork.inspect()` below normal log level and
  serialized only when verbose logging is enabled (landed).
- Sourcemap validation requires maps without prescribing inline storage
  (landed).
- `traceHotPath` retention sweeps run on first activation use and every 64
  inserts, bounding each channel at 500–563 retained rows (landed).
- Structured channel fan-out snapshots participant incarnations once and
  enqueues every recipient in one local transaction (landed); the remaining
  GAD-append-to-projection crash gap is still Phase 3.
- Workspace RPC declarations are indexed once per immutable build instead of
  linearly scanned on every dispatch (landed).
- Channel bundle attribution corrected: `@workspace/harness` contributes no
  executable inputs; its remaining cost is rebuild-graph fan-out (measured).

Exit: measured agent primary ≈ 11 MB rather than 45.4 MB, map still sealed in
the build. (Met.)

### Phase 1 — measurement and budgets

- Consolidate the already-landed bounded durable-work and agent hot-path traces
  into the §10 correlation schema, including the dispatch-stack and
  GAD spans rev 1 lacked.
- Complete the remaining happy-path console-bridge audit; durable-work trace
  construction is already lazy (Phase 0).
- Per-worker bundle bytes and largest-inputs in build diagnostics; budget
  assertions that fail with input attribution.
- Idle, browser-import, model-call, and fan-out load profiles captured;
  percentile and queue-age assertions in the messaging load harness.

Exit: every second of the current five-second trace is attributed to a named
owner in §2.3's taxonomy; receipt-storm volume is quantified.

### Phase 2 — fast-path reductions, no topology change

All independently shippable; each measured against Phase 1 baselines:

- import hygiene (§9.1.1); the shared-facet-loader isolation spike (§9.1.2,
  gated) and the splitting spike (§9.1.3);
- exact-execution restoration caching by active entity, sealed execution,
  canonical authority, and workerd boot generation is landed; the active
  durable entity is still resolved on every dispatch and concurrent cold
  restoration is single-flight;
- attestation single-evaluation with static-input caching only, and
  `_doversion` elimination (§9.2), remain;
- batch fan-out enqueue into one transaction (the §2.2 loop) is landed as a
  safe precursor inside the _existing_ delivery queue;
- `publishReceivedAck` off the inline transition path (temporary, dies in
  Phase 3 with receipts-as-messages);
- `traceHotPath` retention amortization is landed; roster refresh remains to
  be made event-driven.

Exit: warm-path dispatch overhead (readiness + attestation + transport, per
call) drops by an order of magnitude on the histogram; the facet-loader and
splitting spikes each conclude with a written ship/no-ship decision backed by
the isolation proof (shipping is not required to exit the phase); no
regression in the exact-execution invalidation test matrix.

### Phase 2.5 — task progress without message replication

This is a bounded product cutover, not a special-case fast path:

- make the durable task channel/log a task resource owned by the parent
  lifecycle context; the child execution context receives authority to
  participate but does not own the log's lifetime;
- give presentation authorized replay plus live tail of the canonical log
  without a roster entry, presence event, structured mailbox, receipt, or wake.
  Prefer the existing GAD publication/transcript pipeline; if it cannot express
  the required cursor, add that capability to the generic log-reading boundary
  rather than creating a task- or subagent-specific observer. A panel
  multiplexes visible cursors over its existing session rather than opening one
  participant connection per card;
- configure the supervisor's task subscription for addressed delivery. Normal
  child tool/turn traffic stays in the canonical task log; explicit `say` or
  addressed messages reach the supervisor, and the terminal task event still
  wakes it;
- render live and historical task-card activity from the canonical task log;
  terminal summary/status remains on the parent task card;
- atomically delete `subagent_progress_outbox`, its synthetic agent-inbox wake,
  `publishSubagentProgress`, and relayed parent `task.progress` publications.

Exit: one child tool event is appended once and causes zero supervisor inbox
claims unless it is explicitly addressed; closing the child preserves complete
task history; opening many historical task cards creates no roster or receipt
traffic; terminal completion still resumes the parent exactly once.

### Phase 3 — durable-delivery kernel and mailbox cutover

**Entry criterion:** the reviewed enumeration of every `shouldRespond` and
wake-policy input with exactly one owner — event, generic subscription fold,
agentic projection, or recipient-local first-admission state (§5.5) — plus the
declared generic and agentic projection versions.

Build the final schemas and recovery machinery inertly, then make two bounded
atomic route replacements. At no point may an event be delivered or receipted
through both old and new routes.

**Phase 3A — receipts projection cutover:**

- derive delivered/read state from the final mailbox/agentic projection model;
- cut UI receipt reads to that projection and delete
  `message.received`/`message.read` publication in the same change;
- prove one human message with N agents generates zero receipt events before
  proceeding.

**Phase 3B — mailbox transition cutover:**

- subscription lifecycle modeled as durable log events (§5.2) — open, revise,
  close, incarnation replacement, and delivery-mode change become appended,
  sequenced facts; application-owned admission configuration is carried as a
  closed, versioned payload without entering the generic kernel. The
  channel-local `participants` table remains for live-connection state only
  and carries no routing authority; existing channels seed their subscription
  log with one opening event per current participant at cutover;
- the generic subscription interval/mailbox projection and separately owned
  agentic context/receipt projection are co-derived locally (§5.1–§5.5);
- `channel_delivery_mailbox` + versioned derivation cursor +
  `reconcileDeliveryProjection` replace `channel_delivery_queue` in one schema
  reset;
  `assertExactSqlTableSchema` in the same change; the recovery scan invokes
  reconcile on every durable reconcile-eligible channel;
- recipient transition (§6) claimed directly from the mailbox by the host
  driver (§7.1); `acceptChannelBatch` and `agent_inbox_queue` deleted; no
  dual writes;
- recipient-local wakes rehomed with explicit causal prerequisites (§5.6);
- agent-local scheduled resumes move to their final local wake queue.

Exit: delivery requires no recipient activation; dropping all hints and
restarting the host recovers every row **including rows never derived before
the crash** (the §2.2 gap test); one human message with N agents generates
zero receipt-driven deliveries; the stuck-outbox scenario shows
`delivered`/`declined` instead of permanent pending.

### Phase 4 — capacity and failure validation

- Per-recipient slow/failing/declined/deleted-incarnation scenarios.
- Simultaneous browser import, model calls, and test fan-out at declared
  capacity; GAD queue-delay measured under multi-agent load and published as
  the ceiling number.
- Host and workerd killed at every commit/claim/settle/derivation boundary;
  recovery with all hints dropped; stale settlements replayed.
- Category and smoke system tests on a fresh ephemeral workspace instance.

Exit: no message loss, duplicate visible transition, cross-recipient
head-of-line block, false or missing receipt, or context-integrity ordering
violation; §10 SLOs hold at p99 in the declared envelope.

### Phase 5 — workerd-native coordination runner (gated on R1 and R2)

Only after both §8 gates close in writing:

- bounded claim/settle RPCs on the channel for the runner; direct
  recipient/GAD bindings under the selected attestation design;
- context-integrity ingestion per the R2 resolution;
- host driver stops claiming mailbox work; queues limited to §7.2 effects.

Exit: channel commit through trajectory transition completes with the host
event loop paused (modulo the R2 amendment if taken); test 11 proves authority
equivalence.

### Phase 6 — coordination/execution worker split (conditional)

Authorized only if post-Phase-4 (or post-Phase-5) cold-path measurements miss
SLOs. Scope per §9.1.4, with dependency and byte budgets enforced in the
build, and cache-invalidation tests proving exact execution across restart,
retirement, update, rollback, and concurrent restore.

## 12. Required tests

1. two distinct failure shapes, tested separately: (a) GAD **rejects** the
   append — no message, no mailbox rows, no receipt entries; (b) GAD
   **commits but the response or channel process is lost** — the retry
   recovers idempotently to exactly one message and one row set (an
   after-commit loss cannot leave "no GAD append", only an unresolved one);
2. derivation replay from the cursor after a crash creates exactly the missing
   rows and no duplicates (`INSERT OR IGNORE` on `delivery_id` proven); a
   deleted subscription interval table is rebuilt by the same replay under the
   same declared kernel/projector versions, and generic delivery rows plus
   agentic context derived before and after the rebuild are identical;
3. subscription routing is evaluated as of the message sequence: a member
   added after a message's append receives no row for it, ever; a member active
   at append receives its row **even when derivation runs after that member
   departs** — crashed and crash-free paths produce identical recipient sets,
   and the departed member's row is immediately terminalized for consumption;
4. a removed or replaced incarnation cannot consume an old row;
5. one slow recipient does not delay another recipient's derivation, claim, or
   receipt state;
6. same-recipient/channel sequence preserved across retry and restart;
7. dropping every ready hint still recovers all rows, **including rows never
   derived before the crash** — proven against the registry-driven
   `reconcileDeliveryProjection`, with the reconcile shown to be bounded and
   resumable (batch limits honored; a kill mid-reconcile resumes from the
   persisted position without duplicates);
8. stale generation settlement cannot consume a newer claim;
9. context lineage advances before GAD makes content model-visible;
10. read-cursor semantics: (a) `read` is absent while content has never
    entered a turn; `declined` is present with a reason; the projection never
    reports `read` without `delivered`; (b) when a later admitted turn
    exposes content through sequence S, every delivered row at or below S —
    **including previously declined rows** — becomes `read` with that turn's
    coordinate; (c) the lineage of every message newly exposed through S,
    including declined ones, is ingested before the model call (the latch
    cursor matches the read cursor); (d) prompt construction either proves
    model visibility is prefix-shaped or the scalar cursor is rejected in
    favor of an interval/exposure-set representation;
11. (Phase 5) runner-originated calls are rejected in exactly the cases host
    dispatch rejects them — adversarial equivalence, not sampling;
12. a readiness-cache hit is impossible after boot-generation,
    execution-digest, **or authority** change;
13. workerd receives no source-map payload in its primary module;
14. coordination builds fail their executable dependency/byte budgets with
    input attribution;
15. host effect saturation does not violate coordination latency SLOs below
    declared coordination capacity;
16. one human message with N structured participants produces zero
    receipt-driven mailbox rows;
17. (if the §9.1.2 spike ships) the shared facet loader can never serve a
    build other than the sealed active execution identity, including across
    concurrent version advance — and two objects sharing one compiled image
    observe fully isolated storage, environment, and egress caller identity
    (an egress request from object A can never carry object B's identity);
18. the generic delivery package and schema contain no agentic protocol,
    model-turn, context-integrity, respond-policy, streak, or read-receipt
    dependency; the agentic projection depends on the kernel, never reverse;
19. a recipient-policy change affects queued work not yet admitted, but a
    crash/retry after the first durable admission decision cannot re-decide it;
20. projection-version change cannot silently reinterpret retained history —
    it is rejected until an explicit reset or reviewed migration is selected;
21. a local wake causally dependent on channel sequence S cannot overtake
    unresolved work through S, while an independent timer wake is not forced
    into a fictitious global channel order.

## 13. Rejected approaches

- **One local transaction spanning message append and mailbox insert.** The
  append is a cross-DO GAD commit; the co-commit is impossible. Rederivable
  projection replaces it (rev 1's central mechanism, withdrawn).
- **Moving canonical message storage into the channel DO.** Inverts GAD
  ownership, touches replay/forks/lineage/policy folds, and buys nothing the
  derivation cursor doesn't.
- **Putting the mailbox in GAD.** Adds per-message fan-out writes to the
  workspace-global serialization point (§2.4).
- **A channel-owned subscription epoch stamped on each message envelope.**
  Deterministic and hot-path-cheap, but it splits the routing fact across two
  owners (epoch table channel-side, epoch reference in the durable message)
  and cannot rebuild routing history from the log alone; a lost channel store
  loses routing authority. Subscription-as-log-events keeps one fact owner and
  one recovery mechanism (§5.2).
- **Interval bounds committed "atomically" with sequenced subscription
  events.** The sequence is assigned by the GAD append; channel SQLite cannot
  share that transaction — the same fiction as rev 1's central transaction,
  in miniature. Bounds are the events' own log sequences, folded (§5.2).
- **Agentic fields in the generic mailbox.** `agentStreak`, respond/hop policy,
  context-integrity inputs, `read_turn_id`, and agentic decline reasons belong
  to the separately owned agentic projection. Co-location is not ownership.
- **Labeling GAD append as delivered without a mailbox.** Weakens the fact the
  UI reports.
- **Keeping receipts as channel messages.** O(N²) receipt fan-out per message;
  the delivery pipeline processing its own acknowledgements.
- **Keeping agents permanently warm.** Hides activation cost, grows memory
  with agent count, removes no serialized dispatch work — and the shared
  facet loader captures most of the benefit without the residency cost.
- **Raising host concurrency globally.** Cannot parallelize dependencies
  within one message.
- **In-memory delivery.** Violates recovery.
- **Context integrity after model admission.** Breaks the happens-before
  security boundary.
- **Removing generation fencing or deterministic IDs.** Converts retries into
  duplicate semantic outcomes.
- **Clock-expired claims or TTL-based ownership inference.** Elapsed time
  never proves an executor died; adoption of a positively identified
  replacement generation is the only release path.
- **A workerd runner on asserted-equivalent authority.** Attestation residency
  is a designed and reviewed change (gate R1) or it does not ship.
- **A fast path beside the durable path.** Two owners create ambiguous
  receipts, ordering, and recovery. Every phase replaces its old route
  atomically.
- **Jumping to the worker split before import hygiene and shared loading.**
  The maximal intervention first, with the least evidence.

## 14. Decisions required before Phase 3

1. Confirm the receipt vocabulary and its two intended behavior changes (§4):
   delivered = mailbox commit preceding admission; stuck-outbox pending
   becomes `delivered`/`declined`.
2. Confirm the ownership resolution (§5): GAD keeps the canonical log;
   generic subscription state and delivery rows are one rederivable kernel
   projection; agentic context and receipts are a separately owned co-derived
   projection keyed by `delivery_id`; `participants` is demoted to live
   connection state.
3. Confirm queued-message policy time: channel facts and subscription revision
   are fixed at event sequence; current recipient policy applies at first
   admission; that decision is then durable across retry.
4. Approve the complete admission-input ownership table and decide exactly
   which conversation/hop configuration changes become sequenced subscription
   revisions.
5. Confirm that replacement incarnations do not inherit old executable rows;
   any historical replay is an explicit new operation.
6. Prove that model context exposure is prefix-shaped enough for one monotonic
   read cursor; otherwise replace it with an interval/exposure-set model.
7. Define the durable channel reconciliation registry, retirement rule, and
   bounded cursor coordinate `(sequence, phase, subscriber position)`.
8. Declare kernel and agentic projector version/reset/migration rules.
9. Define causal ordering between channel delivery and agent-local wakes.
10. Set the declared coordination capacity envelope and the environments where
    the §10 SLOs are release gates, using Phase 1's measured attribution.
11. (Before Phase 5 only) Close gates R1 and R2 in writing.

Everything else follows from the durability, authority, ordering, and
context-integrity intent already landed in
`agentic-hot-path-work-dispatch-plan.md`.
