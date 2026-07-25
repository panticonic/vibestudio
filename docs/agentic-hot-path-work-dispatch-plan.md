# Agentic Hot-Path Work Dispatch Refactor

**Status:** Proposed implementation plan (rev 3)
**Date:** 2026-07-25
**Scope:** alarm scheduling, channel delivery, agent inbox processing, agent
effect execution, and recovery
**Supersedes when implemented:** the execution-lifetime portions of
`ws1-agent-loop-spec.md`, `ws2-channel-spec.md`, and
`agent-heartbeats-design.md` that make a DO alarm the primary dispatcher

**Revision history.**

- **Rev 1** proposed the right destination but mis-identified the mechanism of
  the observed regression, ordered the work wrongly, and proposed building three
  components that already exist.
- **Rev 2** replaced the diagnosis with a code-verified one and put the
  scheduler fix first.
- **Rev 3** fixes four defects found in review: the concurrent scheduler needs a
  durable claim protocol (§10.2), cross-DO recovery registration cannot be
  atomic and must be replaced by an owner registry (§7.3), the same-DO
  admission question is unresolved rather than disproven (§2.5), and the
  no-head-of-line invariant needs a capacity envelope (§1, §11). It also drops
  every migration, adoption, and back-compatibility obligation: **this system
  carries no existing durable state forward.**

**Greenfield mandate.** There is no compatibility requirement with the current
implementation and no obligation to preserve existing rows, tables, or
in-progress work. Queues are defined fresh, tables are created fresh, and a
developer instance with unresolved work is reset rather than migrated. Where
this document names existing code, it is naming an _abstraction to reuse_ or a
_defect to delete_ — never state to preserve.

## 1. Executive decision

Vibestudio separates three concerns that are currently fused:

1. **Time-domain scheduling** — deciding _when_ something is due. Owned by
   `AlarmDriver`. Must never be occupied by the execution of what it wakes.
2. **Durable coordination** — validating input, writing local durable state,
   exposing bounded claim/settle methods. Owned by channel and agent Durable
   Objects.
3. **Long execution** — model calls, tool runs, HTTP, panel and human waits.
   Owned by a host-driven work driver, never by a scheduler activation.

A single host-owned `DurableWorkDriver` becomes the immediate dispatcher for
durable outbox work. It receives disposable work-ready hints, claims durable
items from their owner under a worker generation, drives execution outside any
scheduler activation, and acknowledges the exact generation. The durable row —
not the hint, not the driver's memory — is the source of truth.

Alarms remain, but only for real time-domain behavior and recovery:

- explicit deadlines and scheduled heartbeats;
- retry-at times after a recorded failure;
- re-announcing unacknowledged ready generations after an interruption;
- slow maintenance such as retention and reconciliation.

No successful interactive operation may depend on an alarm, polling interval,
stale-call sweep, or elapsed-time ownership inference to advance.

**The scheduling invariant, stated with its capacity envelope:** below declared
lane capacity, no due alarm is delayed by another alarm's dispatch. At or above
capacity, admission is fair, queueing is bounded, and queue depth plus admission
delay are observable. A long-running handler retains its exact claim and
consumes capacity; elapsed time does not make it duplicate-eligible. Rev 2's
absolute phrasing ("no alarm dispatch may delay another") is unsatisfiable by
any bounded system and is withdrawn.

This is a replacement, not an additional route. A work kind has exactly one
execution owner at every commit; no phase leaves an interim route for a later
phase to delete.

## 2. Root cause: what is verified, what is suspected

### 2.1 Verified — `AlarmDriver` is a workspace-global head-of-line block

`src/server/services/alarmDriver.ts`:

- `kick()` returns immediately when `this.driving` is set (line 115), so a fire
  request during an active drive only sets a boolean.
- `drive()` runs one `fireOnce()` at a time (lines 124-138).
- `fireOnce()` awaits `runPool(due, …)` over the **entire** due batch
  (lines 184-249). `runPool` bounds concurrency _within_ a batch (lines 279-290)
  but the call itself is a barrier.
- New due rows are only observed by the _next_ `alarmListDue` (line 171).

Consequence: while one `__alarm` dispatch is held open for 44 s, **no alarm
anywhere in the workspace can fire** — not the channel's, not another agent's,
and not the stalled agent's own freshly scheduled wake. This alone accounts for
the 27–102 s client-method stalls and for recovery timers appearing to be what
eventually breaks the cycle.

This is the only part of the diagnosis that is fully established, and it is
sufficient to explain the observation.

### 2.2 Verified — the agent alarm holds its request open across the effect chain

`workspace/packages/agentic-do/src/agent-vessel.ts:541-554` registers the
`agent-loop-driver` alarm source as `await completion`. Combined with 2.1, one
agent's model/tool chain becomes the workspace's scheduler.

### 2.3 Verified — two nested serial drains inside those activations

- `fireAgentAlarms` (agent-vessel.ts:953-965) fires due sources **sequentially**,
  so the `channel-envelope-inbox` source waits behind `agent-loop-driver`'s
  `await completion` within a single activation.
- `drainStructuredDeliveryOutbox` (channel-do.ts:573-642) is a strictly serial
  `for` loop over up to 100 rows, awaiting one `onChannelEnvelope` RPC per row
  with `STRUCTURED_DELIVERY_TIMEOUT_MS = 15_000` (broadcast.ts:25). One slow or
  absent target delays every other target's delivery in the same drain.

### 2.4 Not the mechanism — host-side call serialization

There is no `blockConcurrencyWhile` anywhere in `src/` or `workspace/`,
`DODispatch.dispatch` is an ordinary per-call HTTP POST (doDispatch.ts:388), and
the workerd transport pool runs with `pipelining: 0`, giving every invocation its
own connection (workerdRpcRelay.ts:34-46). **The host does not serialize calls to
one object.**

### 2.5 Suspected and unresolved — same-DO admission during an active event

Rev 2 over-claimed here. Host-side evidence does not establish what workerd does,
and the tree contains a direct claim to the contrary:

> `workspace/packages/agentic-do/src/agent-loop-driver.ts:2004-2010`: "The alarm
> request must not own provider/model latency: workerd cannot deliver lifecycle
> prepare to the same Durable Object while that alarm event remains active."

That comment asserts a same-DO admission constraint — at minimum for lifecycle
prepare — and concludes that detaching `completion` is _required_. Yet
`agent-vessel.ts:546-550` re-attaches it, on the opposite premise that "a
detached promise can be frozen once its event returns in Workerd." **The
codebase contradicts itself on the single most load-bearing question in this
refactor.** Both comments describe real observations; neither is a measurement.

Three claims must therefore be kept distinct throughout this plan:

| Claim                                                   | Status                    |
| ------------------------------------------------------- | ------------------------- |
| Workspace-global head-of-line blocking in `AlarmDriver` | Verified (§2.1)           |
| Long execution occupying a scheduler activation         | Verified (§2.2, §2.3)     |
| Same-DO admission blocking during an active event       | **Unresolved** — M4 (§13) |
| Detached continuations freezing after event return      | **Unresolved** — M4 (§13) |

M4 adjudicates the last two, and no phase may assume either answer.

### 2.6 Observed timings

Observed on `chat-d572c778`:

| Stage                                       | Observed duration |
| ------------------------------------------- | ----------------: |
| Model call that selected `load_action_bar`  |             3.7 s |
| Panel work after invocation start           |      about 10.6 s |
| Durable invocation start to terminal        |            68.7 s |
| Agent alarm occupation in the same interval |              44 s |
| Other client-method stalls                  |          27–102 s |
| Normal provider time to first event         |         0.5–1.7 s |

The delay was neither provider generation nor OAuth. It was coordination time
manufactured by our scheduler.

## 3. Abstractions to reuse

These exist and work. Reuse the _shape_; carry forward none of the _state_.

| Rev 1 proposed to build                          | Already in tree                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptChannelBatch` as a "local-inbox-only RPC" | `onChannelEnvelope` (agent-vessel.ts:1962-1981) already validates the caller, inserts into an inbox with a deterministic delivery key, advances no reasoning, and schedules a wake. The delta is batching, incarnation fencing, exact acknowledgement (§8.3), and hint-instead-of-alarm. |
| A durable-work claim protocol                    | `EffectOutbox` (effect-outbox.ts) with `due`, `claimReady`, `releaseLease`, `recordFailure`, `maxAttempts`, `backoffMs`, and `inspectEffectOutbox`. It lacks a host-wide worker-generation adoption protocol; §6 adds it.                                               |
| Typed effect executors                           | `EffectExecutor<D>` (effect-executors/types.ts:195-213) already takes a frozen descriptor, `AbortSignal`, narrow ports, and an ephemeral sink, returning an outcome or `{deferred: true}`.                                                                                               |
| A long-running host→DO call shape                | `DODispatch.dispatchHeld` (doDispatch.ts:399), used by `EvalDO.executeRun` with a 300 s coarse progress report.                                                                                                                                                                          |
| A durable registry of live owners                | `entities` (workspaceDO.ts:442-460) with `status`, already consulted by `alarmSet` to refuse inactive objects. This is the basis for recovery scanning (§7.3).                                                                                                                           |

Genuinely new: the work-ready receipt, `DurableWorkDriver`, worker generations on
all queues, participant-incarnation addressing, durable alarm-dispatch state,
and the owner-registry recovery scan.

## 4. First principles

### 4.1 A scheduler is never an executor

An alarm activation may read local state, reconcile due rows, mark work
claimable, and return a next-wake time. It may not execute the work it
discovers, and the scheduler that dispatched it may not block on other
scheduling while it runs.

### 4.2 Coordination owners do bounded work

A coordination DO request may authenticate and authorize, validate input, read
and write its local SQLite state, derive deterministic identifiers and durable
work descriptors, and return a bounded result.

It may not await a callback into another coordination DO, a delivery whose
recipient can publish back to the caller, retry sleep, polling, or deadline
passage.

Long _self-owned_ execution is a separate question, unresolved until M4. A held
RPC executing the agent's own model call inside the agent DO violates neither
ordering nor liveness provided (a) it is not a scheduler activation, (b) it holds
no lease on another owner, (c) it cannot re-enter its caller, and (d) M4 shows
the DO still admits concurrent events. §9.1 gates this.

Any authority or semantic append crossing a DO boundary must be audited. If it
can re-enter the caller or has unbounded latency, it belongs in durable work.

### 4.3 Persist locally, then notify, and never depend on the notification

The owner atomically writes the semantic fact and its unresolved work row in one
local transaction. A crash has only two valid outcomes:

- before commit: neither fact nor work exists;
- after commit: both exist, and the owner can derive readiness from its own
  local state alone.

**Correctness may never depend on a cross-DO write.** Hints and index entries are
accelerators. Recovery works by scanning registered owners and asking each to
derive its own readiness (§7.3). This is the rev 3 correction: rev 2 required a
local commit and a `WorkspaceDO` index entry to be atomic with each other, which
is impossible — they are separate Durable Objects with no shared transaction.

### 4.4 At-least-once execution, exactly-once durable outcome

The system does not claim exactly-once external side effects.

- A work item has a deterministic identity.
- Claims have a monotonically increasing worker generation.
- A stale generation cannot settle or fail a newer claim.
- Execution may be retried after an ambiguous failure.
- The semantic owner accepts one deterministic terminal outcome.
- Mutating receivers must honor the work item's idempotency key.
- Where a receiver cannot be idempotent, the descriptor must encode a
  prepare/commit protocol or the operation is classified non-retryable after
  dispatch.

### 4.5 Ordering belongs to the semantic owner

The driver may execute independent work concurrently but cannot define
conversation order. The channel log defines channel order; GAD defines
trajectory order; the agent fold derives which effects are eligible;
per-recipient delivery batches preserve channel sequence; outcome commits use
deterministic ids and head-CAS rules.

### 4.6 Recovery is not the normal scheduler

Healthy-path traces contain no recovery alarm, stale redelivery, expired lease,
or backstop poll. A recovery path firing is observable evidence of an
interruption or bug.

### 4.7 Backpressure cannot seize a coordinator or a scheduler

A slow recipient may accumulate durable work for itself. It may not block
publications, results from other participants, deliveries to other recipients,
agent inbox acceptance, unrelated agents or channels, or — below declared
capacity — any due alarm.

Claims and execution are bounded by batch size, per-owner concurrency,
per-target ordering, and global driver concurrency. Queue depth is durable and
observable.

## 5. Target topology

```text
Panel / user
    │ publish or submitMethodResult
    ▼
Channel DO
    │ local transaction: append log + enqueue delivery rows
    └─────────────────────────── return + work-ready receipt
                 ▼
         DurableWorkDriver ── claim delivery batch (per-target lane)
                 ▼
Agent DO.acceptChannelBatch
    │ local transaction: insert inbox rows (all-or-nothing, §8.3)
    └─────────────────────────── return + work-ready receipt
                 ▼
         DurableWorkDriver ── claim inbox transition
                 ▼
      Agent transition executor
                 │ append/derive exact effects
                 ▼
         Agent effect outbox
                 │ work-ready receipt
                 ▼
         DurableWorkDriver ── claim effect, dispatch per §9.1
                 ▼
       Typed effect executor (model/tool/http/channel)
                 ▼
Agent DO.settleEffect
    │ deterministic outcome commit (generation-fenced)
    └─────────────────────────── return

AlarmDriver ── only: deadlines, heartbeats, retry-at, expired leases
    │ durable dispatch claims (§10.2), per-target lanes, non-blocking loop
    └─── marks rows claimable, returns next wake, emits work-ready receipt

Owner registry (entities) ── recovery scan basis; each owner derives its own
                             readiness from local state (§7.3)
```

Live UI stream fanout remains a non-authoritative acceleration after the channel
append. It must be non-blocking; replay is the recovery mechanism.

## 6. The common durable-work contract

Extract one protocol from `EffectOutbox`'s shape and apply it to channel
delivery, agent inbox transitions, and agent effects. Domain tables keep their
domain-specific payloads and indexes; they implement one behavioral contract.

```ts
type DurableWorkQueue = "channel-delivery" | "agent-inbox" | "agent-effect";

interface DurableWorkRef {
  owner: { source: string; className: string; objectKey: string };
  queue: DurableWorkQueue;
}

interface WorkClaim<T> {
  itemId: string;
  generation: number;
  idempotencyKey: string;
  createdAt: number;
  attempt: number;
  payload: T;
}

interface ClaimRequest {
  workerId: string;
  now: number;
  limit: number;
}

interface SettleRequest<T> {
  workerId: string;
  itemId: string;
  generation: number;
  outcome: T;
}
```

Each work source exposes narrow internal operations:

- `claimReady(request) -> WorkClaim[]`
- `settleClaim(request) -> accepted | duplicate | stale`
- `failClaim(request) -> retryAt | terminal`
- `inspectWork()`, read-only and bounded
- `hasReadyWork()` and `nextRecoveryAt()`, both derived **from local state
  alone**, for the recovery scan in §7.3

`claimReady` updates ownership and generation in the same local transaction that
selects rows. There is no read-then-claim gap.

### 6.1 Queue schema

Every queue table is created fresh with these columns. There is no migration
step and no adoption of existing rows; a developer instance is reset.

**Common to all three queues:** `idempotency_key`, `attempts`,
`next_attempt_at`, `lease_owner`, `lease_generation`, `created_at`,
`last_attempt_at`, `disposition` (typed: `ready` | `leased` | `parked` |
`retrying` | `terminal-*`).

**`agent_effect_queue`:** `branch_id`, `effect_id`, `channel_id`, `kind`,
`descriptor_json`. Primary key `(branch_id, effect_id)`.

**`channel_delivery_queue`:** `target_participant_id`, `target_incarnation`,
`channel_seq`, `delivery_key`, `envelope_json`. Ordered claim index on
`(target_participant_id, target_incarnation, channel_seq)`.

**`agent_inbox_queue`:** `channel_id`, `source_incarnation`, `channel_seq`,
`delivery_key`, `envelope_json`, `continuation_cursor`. Ordered claim index on
`(channel_id, channel_seq)`.

`lease_generation` is not optional on any queue. Without it §21's "old runner
settles after re-claim" row is untestable, and rev 1 specified it in principle
while providing the column on none of the three tables.

Claims do not expire. A driver generation owns a claim until it settles or a
new, positively identified driver generation is adopted. Elapsed time can make
a scheduled retry eligible; it cannot prove that an executor died.

`assertExactSqlTableSchema` declarations are written to match, in the same
change that creates each table.

## 7. Work-ready notification and recovery

### 7.1 The receipt

`DurableObjectBase` gains a transport-level, internal work-ready receipt. A DO
marks one or more queues ready during the request, after its durable writes. The
server's DO dispatch boundary consumes the receipt only after the response's
storage output gate has committed, strips it from the caller-visible response,
and calls:

```ts
durableWorkDriver.notify({ owner, queues });
```

`notify` performs no semantic work and stores no authoritative state. It
coalesces duplicate hints by owner and queue and starts a drain immediately.

The receipt rides three response paths: ordinary method dispatch
(durable-base.ts:1266, the `nextAlarmAfterRequest` hook point); the `__alarm`
response, which returns `{ nextAlarm }` today (durable-base.ts:892-912) and gains
`{ readyQueues }`; and `__lifecycle/resume`, so a restored instance announces
adopted work.

### 7.2 Driver ownership

The driver is a host service, not a global Durable Object:

- it cannot become a workspace-wide serialization point;
- bounded global concurrency plus keyed per-owner/per-target lanes;
- one slow claim does not block the scheduler loop;
- shutdown closes admission, aborts runner-owned transports, waits for dispatch
  boundaries;
- unresolved leases remain durable at their owners and are recovered after
  restart.

`AlarmDriver` and `DurableWorkDriver` share lifecycle and instance-isolation
primitives, not semantics. Both must satisfy §4.1 and §10.2.

### 7.3 Recovery by owner registry, not by cross-DO hint

Rev 2 required a work-ready hint and a `WorkspaceDO` recovery-index entry to be
durable together before the response became observable. That is unimplementable:
they are separate Durable Objects with no shared transaction, so a crash between
the local commit and the index write strands exactly the work the index was
meant to protect. Reusing `do_alarms` compounds the error — its primary key is
`(source, class_name, object_key)` with an upsert on conflict
(workspaceDO.ts:2633, 1156-1165), so one wake exists per owner and a work-recovery
write would silently clobber a genuine heartbeat or deadline.

The design instead makes recovery independent of any cross-DO write:

1. **Registration precedes capability.** An owner is recorded in the durable
   registry of work-capable objects _before_ it can accept work. `entities`
   (workspaceDO.ts:442-460) already carries this, with `status` and the
   active-entity check `alarmSet` performs. Registration is a one-time
   lifecycle fact, not a per-item write, so it has no atomicity coupling to any
   work commit.
2. **Owners derive their own readiness.** Each work source implements
   `hasReadyWork()` and `nextRecoveryAt()` from local state alone (§6). The
   local transaction that commits the fact and the work row is the _only_ write
   correctness depends on.
3. **Recovery scans the registry.** A new `DurableWorkDriver` activation
   enumerates registered work-capable owners and asks each for readiness. This
   is bounded by the registry, not by "every possible object," and needs no
   per-item durable index.
4. **Hints accelerate, never guarantee.** A lost hint costs one recovery-scan
   interval. It cannot lose or duplicate semantic state.
5. **`do_alarms` keeps exactly its current meaning** — one real time-domain wake
   per owner. Work readiness never writes to it.

The recovery-scan interval is the only periodic timer in the design. It is a
crash-recovery backstop, must never advance a healthy operation, and its use is
counted and asserted at zero in the latency suites (§11).

## 8. Channel delivery

### 8.1 Durable write

The channel transaction that appends an event also inserts one
`channel_delivery_queue` row per DO participant that should receive it, with the
§6.1 fields.

The participant incarnation is part of the delivery address. A replacement
cannot acknowledge work addressed to an older activation.

### 8.2 Claiming and batching

The driver claims an ordered batch for **one target** and calls
`acceptChannelBatch`. Per-target lanes replace the single serial drain of
channel-do.ts:573-642: one target's 15 s timeout must never sit in another
target's critical path.

### 8.3 Exact batch acknowledgement

"Highest accepted sequence" is unsafe on its own — it silently permits deleting
past an earlier rejected row. The batch endpoint therefore commits
**all-or-nothing** in one local transaction and returns **per-row dispositions
plus the highest contiguous committed sequence**:

1. validate the authenticated channel caller and target incarnation;
2. in one transaction, insert every envelope into `agent_inbox_queue` with
   deterministic keys and the channel sequence;
3. advance no agent reasoning inline;
4. return `{ perRow: Array<accepted | duplicate-match | integrity-error>,
highestContiguousCommittedSeq }`;
5. emit an `agent-inbox` work-ready receipt.

The claimant may release only rows at or below `highestContiguousCommittedSeq`.
A gap stops release at the gap, regardless of later successes. A duplicate whose
stored envelope matches is a successful acknowledgement; a mismatched duplicate
is a hard integrity error that fails the whole batch transaction.

The endpoint performs no external I/O.

### 8.4 Offline and failed targets

An offline participant leaves its rows pending with explicit retry state.
Failure delays affect only that participant's lane. `DO_NOT_CREATED`, retired
incarnations, and channel departure get typed terminal dispositions. Note that
today's drain deletes on `DO_NOT_CREATED` (channel-do.ts:616-623) and re-arms
indefinitely for an absent participant row (channel-do.ts:592-601); both are
replaced by explicit dispositions.

The channel alarm may mark expired delivery leases ready and emit a recovery
receipt. It never calls a participant.

### 8.5 Stream participants

Panel/RPC subscriptions keep receiving live events through their existing
stream. Sending bytes remains non-blocking with bounded per-connection buffers. A
slow connection is disconnected and catches up from the durable channel log; the
channel DO never awaits its drain.

The module-level `deliveryChains` map and the detached
`void deps.deliverParticipant(pid, data)` (broadcast.ts:37, 206) are
hibernation-scoped in-memory ordering state plus a detached promise. The ruling:
the _stream_ fanout path is non-authoritative and may stay detached; the
_structured DO delivery_ path loses its in-memory chain entirely, since
per-target ordering moves into the durable row's channel sequence.

## 9. Agent inbox, transitions, and effects

`acceptChannelBatch` only journals inbox entries. It does not call GAD, build a
prompt, run the loop, publish an acknowledgement, or execute a tool.

The driver claims ready inbox work and invokes a bounded transition executor
that:

1. loads the exact inbox event and durable trajectory coordinate;
2. records ingestion and applies the pure loop transition;
3. appends deterministic trajectory events;
4. materializes newly derived effect rows;
5. commits the inbox acknowledgement;
6. emits `agent-effect` work-ready only after that commit.

The transition is bounded by event count and time. Exceeding the bound persists a
continuation cursor and returns another immediate work-ready receipt; it never
holds a request open to drain an unbounded chain. This replaces the serial
`drainChannelEnvelopeInbox` loop and its `break`-on-error semantics
(agent-vessel.ts:2000-2034), where one failing envelope stops the whole drain.

### 9.1 Design gate A — where effects execute

`EffectExecutor.execute` takes `state: AgentState` — the full folded loop state —
plus `ExecutorDeps` carrying `blobstore`, `channel`, `credentials`,
`localModels`, `localTools`, `promptArtifacts`, and `http`
(effect-executors/types.ts:150-213), all constructed from DO-internal capability
and authority context (agent-loop-driver.ts:470). Relocating execution means
either shipping the fold out of the DO per dispatch or reconstructing every port
host-side with the agent's authority.

**Option A — held execution RPC.** The driver claims the effect and calls a
dedicated long-running agent method via the `dispatchHeld` shape
(doDispatch.ts:399). Execution stays in the DO with its fold and ports intact;
what changes is that it no longer occupies a scheduler activation.

**Option B — host-side executors.** Executors run in the host process against
reconstructed ports, receiving a serialized descriptor plus the minimal fold
projection each executor needs.

The claim/worker-generation protocol, per-effect lanes, cancellation, and
settlement are identical under both.

**Gate criteria — M4 must clear every item, not just admission.** A synthetic
two-minute held RPC tests too little. With a held effect active in an agent DO,
verify:

1. concurrent `onChannelEnvelope`, `onMethodCall`, and `__alarm` admission
   latency for the same agent;
2. local SQLite reads and writes from the held call and from a concurrent call;
3. streaming ephemeral output for the duration, with no backpressure into
   settlement;
4. cancellation mid-execution, including a runner that ignores its
   `AbortSignal`;
5. terminal completion racing deferred parking (`{ deferred: true }`);
6. `__lifecycle/prepare` delivery during the held call — the exact case
   agent-loop-driver.ts:2004-2010 claims workerd blocks;
7. restart and code update mid-execution, including whether a detached
   continuation survives its event returning (the agent-vessel.ts:546-550
   claim);
8. two or more concurrent held effects on one agent;
9. authority propagation and re-evaluation at protected operations during the
   held call.

Selection rule: ship Option A only if every item above passes. Item 6 or 7
failing selects Option B, whose first deliverable is a written enumeration of
every `ExecutorDeps` port with its host-side authority source, before any
executor moves.

Because M4 also adjudicates §2.5, it is the highest-priority work in the plan
and blocks the sizing of §18.

### 9.2 Design gate B — who owns the transition

One semantic owner for the inbox-to-trajectory transition:

- if GAD can atomically append the transition and effect intentions, GAD owns
  the transition and the agent inbox is a delivery projection;
- otherwise the Agent DO owns a local transition journal and GAD publication is
  a durable effect.

The current split — remote GAD authority plus an Agent DO transition that waits
on GAD — is not carried forward. The selected owner must make the crash boundary
explicit and eliminate dual authority.

**Decision (re-derived during implementation, 2026-07-25): GAD owns the
transition; the Agent DO inbox and effect outbox are projections.** The earlier
draft selected local Agent ownership, but the implementation census exposed the
wall that decision ignored: the fold, deterministic command identities,
head-CAS, replay conflict rules, and authoritative trajectory already live in
GAD. Re-implementing them in a second local journal would create the dual
semantic authority §9.2 prohibits.

The host-claimed inbox transition therefore asks GAD to append the deterministic
transition intentions. A successful GAD append is the commit. Agent effect rows
are a locally reconstructed projection of those intentions; `reconcile`
re-derives a missing row after a crash, and deterministic event identities make
an inbox redelivery after an ambiguous response a replay rather than a second
transition. The inbox claim is acknowledged only after that authoritative
append/projection boundary succeeds. No alarm or channel request waits on GAD,
and no second local semantic journal exists.

### 9.3 Effect runner contract

Long effects are claimed, never inlined into a scheduler activation:
`model_call`, `prompt_artifacts`, `local_tool`, `channel_call`, `http_call`,
credential resolution/acquisition checks, and publication that can block on
another owner.

An executor receives only the frozen descriptor, authenticated owner reference,
idempotency key, cancellation signal, and narrow ports — already true of
`EffectExecutor`. It cannot mutate the agent fold or delete its queue row. It
reports exactly one of: terminal outcome; typed retryable failure with retry
advice; typed terminal failure; parked external continuation with its durable
correlation address.

`settleEffect` validates the claim generation, appends the deterministic
outcome, derives follow-up work, deletes or parks the row, and returns quickly.
The 60 s `deferRedrive` backstop (agent-loop-driver.ts:1452) becomes
recovery-only and must be observably unused on healthy traces.

### 9.4 Streaming

Provider deltas and tool progress are ephemeral observations, not effect
ownership. The runner sends them through a bounded signal port keyed by message
and attempt. The durable terminal is the source of truth. Slow UI consumers
cannot backpressure provider reads. Ephemeral buffers are bounded and
coalescible; final durable content is always replayable.

### 9.5 Cancellation and lifecycle

Cancellation updates durable owner state first, then signals the active runner. A
late runner result carries an obsolete generation and is rejected without
changing semantic state.

Runtime replacement closes new claim admission, aborts transports owned by the
outgoing driver, does not manufacture semantic failure, leaves leases to expire
or explicitly releases them, and resumes from durable work after the replacement
starts. The `releaseActivation` fence (agent-loop-driver.ts:1988) is the model
and must keep working when the claim owner is the driver rather than the alarm.

## 10. Alarms after the refactor

### 10.1 `AlarmDriver` must stop serializing

Required properties:

1. `drive()` never awaits a `__alarm` dispatch. Dispatch runs in per-target
   lanes with bounded global concurrency; the scheduler loop only lists, admits,
   and acknowledges.
2. A fire request arriving during an in-flight dispatch is honored for every
   target not itself in flight.
3. A target already in flight is not dispatched again; its next wake is
   evaluated after its outcome is acknowledged.
4. The due row survives until its replacement or clear succeeds — unchanged from
   today (alarmDriver.ts:238-248).
5. The authority-paused deferral (alarmDriver.ts:190-204) keeps its semantics but
   must not occupy a lane for the pause duration.
6. Failure retry stays bounded and driver-owned; no detached retry, no
   zero-delay reschedule storm (alarmDriver.ts:258-277).

### 10.2 The scheduler needs durable dispatch claims

Rev 2 asserted this phase required no schema change. That was wrong, and the
consequence is a live-lock.

`alarmNextWakeAt()` is `MIN(wake_at)` over all rows with no exclusion for
in-flight dispatch (workspaceDO.ts:1213-1218), and `alarmListDue` deliberately
does not consume (workspaceDO.ts:1229). Today's blocking `drive()` is the only
thing that prevents a spin: make dispatch non-blocking and the still-present row
keeps reporting a past wake, so `refreshTimer` computes a zero delay, fires,
re-lists the same row, suppresses it in memory, reports success, refreshes, and
loops — an unbounded zero-delay polling storm against `WorkspaceDO`. In-memory
suppression is also lost across a host restart while a dispatch may still be
executing.

`do_alarms` therefore gains durable dispatch state:

- `dispatch_generation INTEGER NOT NULL DEFAULT 0`
- `dispatch_owner TEXT` — driver instance id, null when unclaimed

And the API changes accordingly:

- `alarmAdoptWorker(workerId)` positively installs the current server
  generation and releases claims owned by the superseded generation.
- `alarmClaimDue(now, workerId, limit)` selects due, unclaimed rows and stamps
  owner/generation in one `transactionSync`. It replaces `alarmListDue` as the
  driver's entry point.
- `alarmNextWakeAt(now)` excludes claimed rows, so an in-flight target
  contributes no wake and cannot produce a zero delay.
- `alarmSet` / `alarmClear` accept and verify `dispatch_generation`. A stale
  generation is rejected, so a dispatch from a prior driver instance cannot
  acknowledge a re-claimed row.
- Lane completion re-arms scheduling by requesting one refresh after the
  acknowledgement commits.
- A claim is released only when a positively identified replacement driver
  generation is adopted. A clock never declares a live dispatch dead.

`do_alarms` keeps exactly one wake row per owner (§7.3); this adds claim state to
that row, it does not add rows or repurpose the table for work readiness.

### 10.3 Agent alarm

Responsible for heartbeat cadence, scheduled model resume at a real provider
reset time, explicit effect deadlines, retry-at after a recorded failure, and
re-emitting an unacknowledged ready generation.

It performs local reconciliation and marks due work ready. It does not execute
the effect, drain the inbox, call the channel, or wait for the driver. The
`await completion` at agent-vessel.ts:541-554 is deleted, and `fireAgentAlarms`
marks all due sources ready before executing any, so one source cannot delay
another's readiness.

### 10.4 Channel alarm

Responsible for call deadlines, presence transitions and retention, invite-index
retry, fork-operation recovery, dedup retention, and expired delivery lease /
recorded retry-at recovery.

It does not call a participant, redeliver a method through a live subscription,
or wait for a target. The `now + 100` floor (channel-do.ts:2776) stays as
scheduling hygiene but must be off every successful path.

### 10.5 Recovery wake

When an alarm discovers ready work, its complete action is: make the row
claimable in local storage; return a work-ready receipt plus the next actual
deadline; nothing else. The host starts the immediate driver after the alarm
response commits.

## 11. Performance contract

"No latency" means no avoidable scheduler latency. Provider generation,
intentional user interaction, remote network transit, and the actual tool
operation still take time.

Hard invariants:

- no fixed delay on the successful path;
- no successful path waits for the 100 ms alarm floor;
- no successful path waits for a 10 s pending-call stale threshold;
- no successful path waits for a 15 s structured-delivery timeout;
- no successful path waits for a 60 s effect redrive;
- no successful path waits for the recovery-scan interval;
- one slow target cannot delay another target;
- below declared lane capacity, one slow alarm dispatch cannot delay another due
  alarm;
- one running model cannot delay channel or agent inbox acceptance;
- queue advancement begins in the same host turn that observes the committed
  work-ready receipt.

### 11.1 Load envelope

Every p99 target below is stated **at or below declared capacity**, and the
declared capacity is part of the guardrail. A target without a load envelope is
unfalsifiable, and one that ignores handler duration is unachievable while any
handler may still perform unbounded provider work.

Declared envelope for the initial guardrails: 20 agents, 20 channels, alarm lane
capacity ≥ 8, driver global concurrency ≥ 8, every alarm handler bounded to
< 250 ms of local work and zero external I/O.

| Measurement                                        |    Guardrail |
| -------------------------------------------------- | -----------: |
| Due alarm → its `__alarm` dispatch begins          |  p99 < 25 ms |
| Channel terminal committed → agent inbox committed |  p99 < 50 ms |
| Agent inbox committed → first transition claim     |  p99 < 25 ms |
| Effect outcome committed → next effect claimed     |  p99 < 50 ms |
| Messaging while a two-minute model call is active  | p99 < 100 ms |
| Healthy operations using alarm recovery            |    exactly 0 |
| Healthy operations using stale redelivery          |    exactly 0 |
| Healthy operations using the recovery scan         |    exactly 0 |

Above the envelope, the assertions change in kind: admission stays fair, queue
depth stays bounded, and admission delay stays observable — but no absolute p99
is promised.

The first row pins §2.1. Note that "alarm recovery: exactly 0" cannot detect
§2.1 by itself, because heartbeats and deadlines are legitimate alarm traffic —
the regression lived entirely inside _healthy_ alarm scheduling.

Budgets exclude the operation's own execution and deliberate batching. If
profiling shows ordinary local transport is materially faster, tighten them; do
not add batching delays merely to meet throughput targets.

## 12. Observability

Every work item carries one trace identity from creation through settlement.
Record monotonic stage times: semantic fact committed; work row created;
work-ready receipt observed; driver notified; claim granted; execution started;
first ephemeral output; execution completed; outcome accepted; next work
notified; user-visible durable terminal.

Expose:

- ready, leased, parked, and retrying counts by queue and owner;
- oldest ready age;
- commit-to-claim latency;
- execution duration separate from scheduling duration;
- settle duration;
- duplicate hint, duplicate execution, stale settlement, and integrity-error
  counts;
- recovery alarm, ready-generation replay, and recovery-scan counts;
- alarm admission delay (due time → dispatch start) per target;
- alarm lane occupancy, and the count of due targets waiting on a lane;
- alarm dispatch claim generation and owner;
- per-target backpressure and batch size;
- current claim owner/generation in debug inspection.

`activationDebugState` (agent-vessel.ts) and `inspectEffectOutbox` provide the
per-agent view; extend rather than duplicate them.

Logs report typed failure codes and exact owner/item identities without
credentials, prompts, tool arguments, or other sensitive payloads:

```text
admit_ms=3 schedule_ms=4 execution_ms=8412 settle_ms=7 recovery=false
```

An alarm-recovered item is warning-level with the original lease and stage.
Repeated recovery of the same item becomes an error and a visible terminal
diagnostic when its domain retry policy is exhausted.

## 13. Phase 0 — Freeze the evidence and resolve the platform questions

### M4 evidence recorded during implementation

The real-workerd probes in `src/server/internalStorageWorkerd.test.ts` now
establish the following:

| Gate item                                                             | Result                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| concurrent ordinary method and `__alarm` admission during a held call | passes; admitted while a two-second held SQLite call remained active             |
| concurrent local SQLite work                                          | passes; a second held call wrote and settled its own SQLite row                  |
| `__lifecycle/prepare` during a held call                              | passes inside 1 s                                                                |
| two concurrent held calls on one object                               | passes                                                                           |
| `ctx.waitUntil` continuation after response return                    | passes; timer ran after 3.0 s without another request and completed outbound RPC |

The effect-level probes complete the matrix:

| Gate item                                       | Evidence and result                                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| same-agent ordinary methods and alarm admission | the real-workerd held-call probe admits both while the first call remains active; ordinary methods share the `onChannelEnvelope` / `onMethodCall` dispatch path                                                |
| concurrent SQLite access                        | both held calls read and write their own rows concurrently                                                                                                                                                     |
| bounded ephemeral streaming                     | `emitEphemeral` is synchronous; delta storage is capped at 256 events and signal delivery at four pending batches, so a slow stream cannot backpressure terminal settlement                                    |
| cancellation, including ignored signal          | `agent-loop-driver.test.ts` proves `releaseActivation` returns immediately, aborts the signal, and rejects a non-cooperative runner's late result                                                              |
| completion versus deferred parking              | the deferred-delivery and duplicate-delivery race tests prove one durable terminal and a harmless late duplicate                                                                                               |
| lifecycle prepare during execution              | the real-workerd probe admits `__lifecycle/prepare` in under one second                                                                                                                                        |
| restart/code replacement and detached work      | replacement adopts a new worker generation and releases the prior generation's claims; the waitUntil probe establishes that workerd runs event-owned continuation after return, but correctness does not rely on detached work |
| concurrent held effects                         | two held calls execute concurrently on one object in the real-workerd probe                                                                                                                                    |
| live authority                                  | the protected-port probe revokes authority after execution starts and verifies the operation re-evaluates and rejects at use time                                                                              |

**Gate A decision (2026-07-25): Option A — held execution RPC.** All nine
criteria pass. Effects retain the Agent DO fold and narrow capability ports, but
their claims and dispatch lifetime move out of alarms. The contrary claim that
lifecycle prepare cannot enter during a held event has been removed from
`agent-loop-driver.ts`. Detached work remains prohibited as a correctness
mechanism even though the probe observed `waitUntil` continuation.

1. Add stage timestamps and queue-age inspection without changing scheduling.
2. Add the alarm admission-delay metric — the direct instrument for §2.1.
3. Capture focused traces for: plain message → first model event; model → client
   tool → model; approval wait and resolution; panel method result; multi-agent
   message; restart during each stage.
4. Add a deterministic reproduction in which the agent alarm is occupied while a
   panel method completes, asserting on alarm admission delay, not only
   end-to-end time.
5. Make the current 27–102 s behavior fail a latency assertion.
6. **Run M4 in full — all nine items in §9.1.** Completed above; Option A is
   selected and both open rows in §2.5 are resolved.

Exit gate: the regression is reproducible; its time is partitioned into
admission, scheduling, execution, and settlement; M4's nine results are recorded
in this document; gate A is closed in writing.

## 14. Phase 1 — De-serialize the scheduler

No semantic cutover. One schema change (§10.2), which is the correction to rev
2's claim that this phase needed none.

1. Add `dispatch_generation` and `dispatch_owner` to `do_alarms`; add
   `alarmAdoptWorker` and `alarmClaimDue`; make `alarmNextWakeAt(now)` exclude
   claimed rows; generation-verify `alarmSet` / `alarmClear`.
2. Rewrite `AlarmDriver` to §10.1: lanes, non-blocking drive loop, durable
   in-flight claims, lane-completion re-arm, unchanged acknowledgement
   durability.
3. Make `fireAgentAlarms` mark all due sources ready before executing any.
4. Prove no zero-delay spin: a test that holds one dispatch open and asserts a
   bounded number of `WorkspaceDO` scheduler calls over the interval.
5. Close design gate B (§9.2) in writing.

Exit gates: the Phase 0 reproduction's alarm admission delay is inside budget;
the spin-loop test passes; a killed driver mid-dispatch reclaims its expired
claim exactly once.

## 15. Phase 2 — Contract, driver, and receipt

1. Specify the durable-work claim protocol and typed outcomes in a shared
   package, extracted from `EffectOutbox`'s shape (§3).
2. Add model-based/property tests for claim, renew, settle, fail, duplicate, and
   stale-generation behavior against a reference reducer.
3. Add the work-ready receipt on all three response paths (§7.1).
4. Implement the owner-registry recovery scan (§7.3): `hasReadyWork()` /
   `nextRecoveryAt()` derived from local state, registry enumeration, bounded
   scan interval, zero healthy usage.
5. Build `DurableWorkDriver` lifecycle, keyed scheduling, bounded concurrency,
   and inspection against fake work sources.
6. Create the §6.1 queue tables fresh, with matching
   `assertExactSqlTableSchema` declarations.
7. Complete the implementation census: every alarm, outbox, `waitUntil`,
   detached promise, redelivery timer, and cross-DO callback, including
   broadcast.ts:37, 206.

Exit gates: crash-state enumeration shows no lost-work, double-terminal, or
unfenced-writer state; a test proves recovery works with **every** hint dropped;
a test proves work readiness never writes to `do_alarms`.

## 16. Phase 3 — Channel structured delivery

1. Implement transactional per-target batch claims and settlement.
2. Implement `acceptChannelBatch` with all-or-nothing insertion and per-row
   dispositions plus highest-contiguous-committed sequence (§8.3).
3. Connect channel work-ready receipts to the driver.
4. Remove cross-DO delivery from `PubSubChannel.alarm()`; delete the serial
   drain at channel-do.ts:573-642.
5. Delete `queueDoEnvelope` and the structured-delivery `deliveryChains`; keep
   the non-authoritative stream path per §8.5.
6. Keep the channel alarm only as a retry-at and unacknowledged-ready notifier.

Exit gate: a blocked agent cannot delay channel publish, panel method result, or
another participant's delivery — asserted on per-target admission timestamps. A
gap in a batch releases nothing past the gap.

## 17. Phase 4 — Agent inbox transitions

1. `acceptChannelBatch` emits `agent-inbox` readiness after commit.
2. Add bounded inbox claims and transition settlement; replace the serial
   `break`-on-error drain with per-item disposition.
3. Move GAD/trajectory transition work to the owner selected in gate B.
4. Remove inbox draining from the agent alarm.
5. Preserve wake policy, read acknowledgements, edits/retractions, terminal
   routing, and participant-incarnation fencing through the same protocol.

Exit gate: inbox acceptance stays within budget during active model, approval,
tool, heartbeat, and lifecycle operations.

## 18. Phase 5 — Agent effects, in one atomic cutover per kind

Scope follows gate A. Under Option A this phase re-owns scheduling and claiming;
under Option B it also relocates executors, and its first deliverable is the
`ExecutorDeps` authority enumeration.

The `await completion` deletion (agent-vessel.ts:541) happens **here**, in the
same change that installs the driver-owned claim/held-execution path for that
kind. Rev 2 put the deletion in Phase 1 and the replacement in Phase 5, which
created an interim route that a later phase deletes — prohibited by §25.

Move effects in dependency order:

1. `publish_envelope`
2. `channel_call`
3. `http_call` and credential checks
4. `prompt_artifacts`
5. `local_tool`
6. `model_call`

Each kind, in one commit: idempotency audit and recorded classification;
compile-time owner switched to `DurableWorkDriver`; previous dispatch route
deleted; crash injection at every claim/execution/settle boundary; cancellation
and authority decisions verified against live state; confirmation that no later
kind relies on an in-memory continuation from the old path.

Exit gate: no agent alarm performs effect I/O; every effect executes under a
lease generation; no kind has two dispatchers at any commit.

## 19. Phase 6 — Delete recovery-as-flow

1. Remove stale pending-call redelivery as an ordinary completion mechanism.
2. Remove alarm-driven structured delivery.
3. Remove alarm-driven effect dispatch and whole-chain draining.
4. Remove obsolete in-memory delivery chains, detached continuation comments,
   and lifecycle workarounds — including whichever of the two contradictory
   comments in §2.5 M4 disproves.
5. Retain only explicit deadline, retry, ready-generation replay, and
   recovery-scan paths.
6. Update `ws1-agent-loop-spec.md`, `ws2-channel-spec.md`,
   `agent-heartbeats-design.md`, and `agentic-architecture.md` to the landed
   model.

Exit gate: code search and architecture tests find no external I/O loop inside
channel or agent alarms, and no scheduler that awaits a dispatch.

## 20. Phase 7 — Performance and resilience qualification

1. Run focused unit and integration suites.
2. Run the relevant headless agentic system tests using the repository's
   `system-test doctor/list/run/inspect/trajectory` workflow.
3. Run category coverage, then smoke coverage.
4. Run sustained multi-channel and multi-agent load with slow, offline, and
   reconnecting participants, at and above the §11.1 envelope.
5. Compare stage histograms to the Phase 0 traces.
6. Treat every alarm recovery, recovery-scan hit, or unexpected tool failure as
   an investigation, not a passing retry.

Exit gate: all correctness suites pass; §11 holds at p99 within the declared
envelope; above it, degradation is bounded and observable.

## 21. Failure matrix

| Failure point                             | Required outcome                                               |
| ----------------------------------------- | -------------------------------------------------------------- |
| Before fact/work commit                   | No fact and no work                                            |
| After commit, before work-ready receipt   | Owner derives readiness locally; registry scan finds it (§7.3) |
| Every hint permanently lost               | Recovery scan still completes all work                         |
| After receipt, before claim               | Duplicate notification safely claims once                      |
| After claim, before execution             | Replacement worker generation adopts and releases prior claims |
| During external execution                 | Retry policy and idempotency contract decide                   |
| Execution succeeds, response is lost      | Retry may re-execute; one terminal wins                        |
| Terminal commits, acknowledgement is lost | Duplicate settle returns accepted/duplicate                    |
| Old runner settles after re-claim         | Generation fence rejects it                                    |
| Batch has a gap mid-sequence              | Nothing released past the gap (§8.3)                           |
| Target is offline                         | Only its lane waits; channel remains responsive                |
| One alarm handler runs long               | Other due alarms dispatch on time below capacity               |
| Alarm dispatch in flight                  | Its row contributes no wake; no zero-delay spin (§10.2)        |
| Driver dies mid-alarm-dispatch            | Expired dispatch claim is reclaimed exactly once               |
| Stale driver acknowledges an alarm        | Dispatch-generation check rejects it                           |
| Due alarms exceed lane capacity           | Fair admission, bounded queue, observable delay                |
| Agent restarts with inbox rows            | Transition resumes from durable cursor                         |
| Driver restarts                           | Readiness rediscovered from the owner registry                 |
| Channel/agent incarnation changes         | Old-address work cannot enter the replacement                  |
| Cancellation races completion             | Durable ordering selects one terminal                          |
| Authority changes during execution        | Receiver re-evaluates at the protected operation               |
| GAD head advances concurrently            | Existing deterministic CAS/reload rule applies                 |
| Queue is overloaded                       | Bounded admission/backpressure, visible typed failure          |

## 22. Test plan

### 22.1 Scheduler tests

- a long-running `__alarm` dispatch does not delay another target's due
  dispatch, below capacity;
- **no zero-delay spin: bounded scheduler-call count while a dispatch is held**;
- an in-flight target's row contributes no wake to `alarmNextWakeAt`;
- an expired dispatch claim is reclaimable exactly once;
- a stale `dispatch_generation` cannot acknowledge a re-claimed row;
- lane completion re-arms scheduling;
- a fire request arriving mid-dispatch is honored for non-in-flight targets;
- acknowledgement durability under dispatch failure and acknowledgement failure
  independently;
- authority-paused deferral does not occupy a lane;
- failure retry stays bounded with no zero-delay storm;
- above capacity: fair admission and bounded queue depth.

### 22.2 Protocol and storage tests

- atomic claim under concurrent claimers;
- generation increments exactly once per successful re-claim;
- stale settle/fail rejected;
- duplicate matching settlement idempotent;
- duplicate mismatched settlement is an integrity failure;
- retry eligibility is time-based; ownership is not;
- owner/queue notification coalescing cannot lose readiness;
- **every hint dropped: recovery scan still drains every queue**;
- work readiness never writes to `do_alarms`;
- an owner unregistered from the registry cannot accept work.

Use a state-machine model to generate operation sequences and compare the SQL
implementation with a small reference reducer.

### 22.3 Channel tests

- ordered batch delivery;
- all-or-nothing batch insertion; a mid-batch integrity error commits nothing;
- a gap releases nothing past the gap;
- duplicate-match acknowledges, duplicate-mismatch fails the batch;
- target-incarnation replacement;
- offline target fairness;
- one target's 15 s timeout does not delay another;
- panel result accepted while agent execution is stalled;
- live stream disconnect followed by exact replay;
- fork, cancellation, call deadline, and participant departure;
- typed disposition for `DO_NOT_CREATED`, retired incarnation, and departure
  instead of silent delete or unbounded re-arm;
- no channel alarm performs participant RPC.

### 22.4 Agent tests

- inbox accepts during a stalled model call;
- one failing inbox envelope does not stop the rest of the drain;
- terminal delivery advances the exact parked effect;
- steering, pause, and cancellation while execution is active;
- approval waits arbitrary human time without occupying the scheduler;
- heartbeat due while a user turn runs;
- model deltas do not backpressure durable settlement;
- lifecycle replacement fences late runners under driver-owned claims;
- transition and effect queues reconcile from GAD after every crash boundary;
- no agent alarm executes an effect;
- the M4 matrix (§9.1) re-run as regression tests against the selected option.

### 22.5 End-to-end latency tests

With deterministic fake model/tool delays:

1. Hold a model execution for two minutes.
2. Publish messages, invocation progress, and a method terminal during it.
3. Assert each is committed and acknowledged within the messaging budget.
4. Assert every alarm due in that window dispatched within its admission budget.
5. Release the model and assert semantic order is correct.
6. Assert recovery and recovery-scan counters remain zero.

Repeat with: 100 queued messages; the §11.1 envelope; deliberate overload above
it; one permanently offline target; rapid panel reconnect and incarnation
replacement; server restart after each durable boundary.

Tests assert stage timestamps, not merely eventual transcript content.

## 23. Rollout and change discipline

No legacy execution mode, compatibility flag, dual write, or state migration. A
compile-time ownership table and tests assert exactly one dispatcher per work
kind at every commit.

Each phase lands as: additive schema and shared protocol; tests proving new
ownership; one atomic work-kind cutover including deletion of the previous
owner; focused validation before the next kind moves. A phase never leaves an
interim route for a later phase to remove.

Because there is no compatibility obligation, a schema or owner transition is
performed by **resetting** the developer instance, not by adopting its rows:
inspect and discard queue depth and active leases, quiesce the exact instance,
create the fresh schema, start that same instance, and run the focused recovery
and latency scenario. Preserving a pre-phase snapshot is a debugging
convenience, not a rollback requirement.

Workspace-template changes are validated on a fresh named ephemeral instance per
`AGENTS.md`; another live instance is never stopped or reused.

## 24. Required code areas

Host/runtime:

- `src/server/services/alarmDriver.ts` — durable claims and de-serialization
  (Phase 1), then recovery scheduling only
- `src/server/internalDOs/workspaceDO.ts` — `do_alarms` dispatch claim state and
  `alarmClaimDue`; `entities` as the owner registry
- `src/server/services/durableWorkDriver.ts` — new immediate driver and recovery
  scan
- `src/server/doDispatch.ts` — consume work-ready receipts; `dispatchHeld` is the
  existing held-execution precedent
- `workspace/packages/runtime/src/worker/durable-base.ts` — work-ready receipt on
  the method, `__alarm`, and lifecycle-resume response paths
- a shared durable-work contract package extracted from `effect-outbox.ts`

Channel:

- `workspace/workers/pubsub-channel/channel-do.ts`
- `workspace/workers/pubsub-channel/broadcast.ts`
- `workspace/workers/pubsub-channel/calls.ts`

Agent:

- `workspace/packages/agentic-do/src/agent-vessel.ts`
- `workspace/packages/agentic-do/src/agent-loop-driver.ts`
- `workspace/packages/agentic-do/src/effect-outbox.ts`
- `workspace/packages/agentic-do/src/effect-executors/`
- `workspace/packages/agentic-do/src/channel-client.ts`
- GAD/semantic-control-plane append and inspection surfaces

The Phase 2 census must find every alarm, outbox, `waitUntil`, detached promise,
redelivery timer, and cross-DO callback before coding. The list above is a
starting point, not permission to ignore another owner.

## 25. Explicit prohibitions

- No scheduler that awaits the execution it dispatches.
- No non-blocking scheduler without durable in-flight claim state.
- No correctness dependency on a cross-DO write pair.
- No work-readiness write to `do_alarms`.
- No interim execution route that a later phase deletes.
- No timeout reduction presented as a latency fix.
- No provider-, tool-, panel-, OAuth-, or approval-specific fast path.
- No "try direct, then alarm" dual execution route.
- No feature flag retaining the alarm executor.
- No second semantic outbox for the same fact.
- No process-memory promise as durable continuation.
- No detached DO promise relied on for correctness.
- No unbounded drain loop or batch.
- No cross-DO await while holding a coordination alarm.
- No batch acknowledgement that releases past a gap.
- No absolute latency invariant without a declared capacity envelope.
- No silent dropped delivery or swallowed settlement error.
- No rewriting tests to tolerate retry latency.
- No claim of exactly-once external side effects.
- No new global DO bottleneck, and no new global host bottleneck.
- No reimplementation of the abstractions listed in §3.
- No state migration, adoption path, or compatibility shim.

## 26. Completion criteria

The refactor is complete only when:

- no scheduler activation delays another due activation below declared capacity,
  and above it degradation is fair, bounded, and observable;
- the scheduler holds durable dispatch claims, and no configuration produces a
  zero-delay polling loop;
- channel and agent coordination RPCs perform bounded durable work and return;
- every long effect is claimed under a worker generation and executed outside a
  scheduler activation, in the host decided by gate A on M4 evidence;
- all ready work receives an immediate host-driven dispatch, and dropping every
  hint loses no work;
- recovery depends only on the owner registry plus each owner's local state;
- alarms perform only real scheduling and recovery;
- batch acknowledgement is exact and never releases past a gap;
- all work kinds have exactly one compile-time execution owner at every commit;
- crash injection proves no lost work, duplicate terminal, or stale writer;
- authority, cancellation, incarnation, ordering, fork, and replay behavior
  remain intact;
- recovery and recovery-scan activity is zero in healthy latency tests;
- the §2.5 contradiction is resolved by measurement and the disproven comment is
  deleted;
- focused, category, smoke, typecheck, and artifact-consistency checks pass;
- obsolete execution and recovery paths are deleted;
- the architecture and operational docs describe the landed system rather than
  the superseded alarm-owned design.

## 27. External design references

- Cloudflare Durable Objects, alarms:
  <https://developers.cloudflare.com/durable-objects/api/alarms/>
- Cloudflare Durable Objects, state and `waitUntil`:
  <https://developers.cloudflare.com/durable-objects/api/state/>
- Cloudflare Durable Objects, rules and scheduling:
  <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
- Cloudflare Durable Objects, lifecycle:
  <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>
