# Hibernation-First Agentic Messaging and Subagent Lifecycle Plan

**Status:** proposed · 2026-08-09 · v1
**Scope:** collaboration-channel membership and delivery, Durable Object
residency, agent progress and terminal notification delivery, supervised task
history, and the complete removal of model-managed subagent closure

## 0. Relationship to the existing plans

This is a new plan, not a revision of an existing document.

It builds on the motivation, measurements, and already-landed fast-path work in
[Agentic Messaging Latency Refactor](./agentic-messaging-latency-refactor-spec.md),
the unified semantic merge work in
[Merge Driver & Subagent DX Plan](./merge-driver-and-subagent-dx-plan.md), and
the intent-aware inspection work in
[Provenance-Aware Diff and Merge Plan](./provenance-aware-diff-merge-plan.md).

Where those documents assume any of the following, this plan supersedes that
assumption:

- channel membership is represented by a live response stream;
- a participant incarnation is durable routing identity;
- a task channel must be re-owned or copied before a child context is removed;
- historical task activity requires a special non-member observation path;
- a completed subagent must be closed to release resources or concurrency;
- `close_subagent` is a legitimate semantic lifecycle operation.

Those assumptions were re-checked against the implementation and do not
survive a hibernation-first model. This plan does not introduce a compatibility
mode beside them. Each cutover deletes the displaced route.

Because the latency refactor spec is marked "implementation in progress" and
specifies the opposite delivery contract in its §5.2–5.3 (incarnation inside
`delivery_id`, `subscriber_incarnation` in the mailbox primary key, incarnation
replacement as a subscription log event), those sections must be edited in
place — or stamped with a supersession pointer to this document — before
implementation starts. One authoritative delivery contract in the repository
is invariant 12 applied to the documents themselves.

## 1. Executive decision

An agent's membership in a collaboration channel is durable data. It is not an
open connection and it must not keep either the agent Durable Object or the
channel Durable Object resident.

Agentic delivery becomes a finite, durable, wake-and-drain protocol:

```text
canonical channel log
        |
        v
rederivable recipient mailbox
        |
        | disposable readiness hint
        v
finite recipient RPC + durable idempotent transition
        |
        v
agent becomes idle and may hibernate
```

There is no persistent DO-to-DO stream on this path. Stable entity identity
selects the recipient; activation incarnation and claim generation fence a
particular execution attempt, but never define membership or historical
routing.

Subagent completion is a terminal execution fact, not a request for cleanup.
A completed child, its task transcript, its context, its committed source event,
and its integration projection remain retained and inspectable. No
`close_subagent` tool, prompt, status, UI treatment, teardown routine, discard
mode, slot-release call, or retry-close error remains.

The only model-visible lifecycle actions are real semantic actions:

- spawn delegated work;
- communicate with it;
- inspect it;
- merge or explicitly resolve its semantic result;
- cancel execution that is still live, if cancellation is needed.

Retention and deletion are workspace-wide policy concerns. They are not agent
reasoning steps and are not specific to subagents.

## 2. Why this plan exists

### 2.1 The latency goal

The original performance work began with a no-load message path of roughly
5.2 seconds from readiness hint to visible read. The path paid repeated host
dispatch, exact-execution restoration, authority, channel delivery, agent inbox,
GAD, receipt, and model-effect costs. Receipt messages amplified one user
message into quadratic agent traffic.

The exact-execution readiness cache materially improved the same managed
`subagent-diff-inspection` test:

| Diagnostic                          | Before | After readiness cache |
| ----------------------------------- | -----: | --------------------: |
| Wall time                           |  211 s |                  81 s |
| Agent inbox claim average           | 445 ms |                 31 ms |
| Channel delivery claim average      | 426 ms |                 46 ms |
| Workspace publication claim average | 143 ms |                 20 ms |
| Agent effect claim average          | 376 ms |                 35 ms |

That result proves dispatch overhead was a universal multiplier. It does not
make unnecessary dispatches free. The next material gain comes from removing
work that should not exist:

- permanent subscription streams for dormant members;
- activation/release/recovery work whose only purpose is maintaining those
  streams;
- incarnation replacement as a routing event;
- the channel-delivery-to-agent-inbox relay when one idempotent recipient
  transition suffices;
- subagent progress copied from a task log into a parent log;
- model calls spent closing already-terminal children.

### 2.2 The subagent-performance goal

Observed supervised runs exhibited four related pathologies:

1. Child tool activity was appended to the task channel, delivered to the
   supervisor, converted into `subagent_progress_outbox`, republished as
   `task.progress` on the parent channel, and delivered back through the
   ordinary message machinery. The UI could already render the canonical task
   transcript, so the copied route bought no semantic fact.
2. A terminal child notification could arrive while the parent was suspended,
   but a user message waking the parent could race or displace the background
   wake. The remaining child completion was then not surfaced coherently.
3. `suspend_turn({reason:"waiting_for_background"})` could be accepted after
   every supervised run was already terminal, delaying integration work. (A
   guard refusing suspension when no run is live, naming completed runs
   awaiting integration, has since landed in `agent-worker-base.ts`; the
   pre-cutover tests must re-verify which of these pathologies still
   reproduce rather than crediting the cutover with fixes that already
   shipped.)
4. The model was instructed to call `close_subagent` after integration. This
   consumed another tool turn, conflated integration with lifecycle, destroyed
   inspectable execution state, and produced additional recovery logic and
   failure modes.

The desired DX is simpler: progress exists once, terminal facts are durable
inbox work, completed results remain available, integration is performed by
the common VCS merge procedure, and no housekeeping tool call appears in the
model's task.

### 2.3 The residency discovery

The current channel `subscribe` method returns a long-lived streamed RPC
`Response`. The channel holds a `ReadableStreamDefaultController` for each
subscriber. Agent vessels open and continuously drain that response even
though their structured messages are delivered through a separate durable
host-claimed path.

The implementation states the consequence directly: a live response keeps the
channel activation resident. The consuming agent also owns pending outbound
I/O for the lifetime of the response. Therefore idle residency scales with
membership edges rather than active work:

```text
agent A -- live stream --> channel X
agent A -- live stream --> channel Y
agent B -- live stream --> channel X
```

On lifecycle replacement, the implementation releases these streams, keeps a
durable local subscription row, and recreates every response on restart. This
is recovery from a self-created activation resource, not hibernation.

### 2.4 Why automatic cleanup is not the answer

Automatically calling today's close routine would save model tokens but retain
the wrong architecture. The routine currently:

- unsubscribes the supervisor from the task channel;
- recursively destroys the child lifecycle context;
- retires entities and deletes their Durable Object SQLite storage;
- drops the child semantic VCS context and context folder;
- changes the run to `closed` while retaining a receipt.

None of those operations is required for an idle Durable Object to hibernate.
They delete retained state. The task channel service itself is not owned by the
child context and is not deleted by child context destruction; the earlier
assumption that its canonical history needed a new parent owner was false.

The correct response is to eliminate idle activation resources, not automate
state deletion.

## 3. Verified current architecture

### 3.1 Channel invocation

`ChannelClient` resolves `vibestudio.channel.v1` through
`workers.resolveService`. Publication, update, completion, signals, calls,
configuration, and replay are ordinary finite Vibestudio RPC calls to the
channel Durable Object.

### 3.2 Live subscription route

`ChannelClient.openSubscription` invokes `subscribe` through `rpc.stream` and
drains newline-delimited records until explicit release or unsubscribe.

The channel:

- stores response controllers in `subscriptionStreams`;
- treats `participants` as the durable projection of activation-local response
  resources;
- reaps all participant rows observed by a fresh activation as orphans;
- sends non-structured client events through those response controllers.

The agent `SubscriptionManager`:

- opens one response per joined channel;
- stores the live response in an activation-local map;
- retries unexpected response termination with exponential timers;
- releases every response before lifecycle replacement;
- recreates every stored subscription after restart.

### 3.3 Structured agent route

Agent vessels set `receivesChannelEnvelopes=true`. Their content is not carried
by the response stream. Instead:

1. The channel inserts rows into `channel_delivery_queue`, addressed to a
   participant and current incarnation.
2. The host durable-work driver claims a channel row.
3. The host invokes `acceptChannelBatch` on the agent.
4. The agent writes the envelope into `agent_inbox_queue`.
5. The host settles the channel row.
6. The host separately claims and executes the agent inbox row.

This path is durable and recoverable, but it pays two queue protocols and still
requires a redundant live response to establish the incarnation used by step 1.

Worse than redundant: the queue's only writer runs at publish time, with no
derivation cursor into the canonical log, and fan-out throws for a structured
participant with no live-advertised incarnation. A channel activation reaps
all participant rows it observes on start. Therefore a message published
between an agent's stream drop and its resubscribe produces **no structured
delivery at all** — the agent never wakes for it. The §6.4 derivation cursor
is not only a hibernation enabler; it closes an existing message-loss hole.

Channel **signals** (`broadcastChannelSignal`) are enqueued to structured
participants but never appended to GAD; they are queue-only records with no
log backing. See §6.8 for their required disposition.

### 3.4 Canonical message and task history

GAD owns the canonical channel log. The channel's local queues and projections
are derived state. Task channels use that same log. A subagent run row retains
`taskChannelId`, `childContextId`, `sourceEventId`, status, and semantic
integration projection.

The task-card UI can already replay the task transcript. Ordinary joining and
authorized replay are acceptable. There is no need for a special non-member
observer, copied task history, or a second task-log owner.

### 3.5 Primary implementation inventory

The cutover is expected to touch these existing owners. Re-locate by symbol if
line numbers drift; do not create replacement ownership beside them.

| Area                              | Current owner                                                                              | Required disposition                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Channel streamed subscription     | `workspace/workers/pubsub-channel/channel-do.ts`                                           | split durable join/leave from live client transport; remove structured-DO response streams                |
| Channel fan-out and durable queue | `workspace/workers/pubsub-channel/broadcast.ts`, `channel-do.ts`                           | route stable entity IDs into the rederivable mailbox                                                      |
| Agent channel client              | `workspace/packages/agentic-do/src/channel-client.ts`                                      | finite membership/replay RPC; no agent `openSubscription`                                                 |
| Agent subscription lifecycle      | `workspace/packages/agentic-do/src/subscription-manager.ts`                                | reduce to durable membership index/config; delete live response ownership and recovery                    |
| Agent delivery and supervision    | `workspace/packages/agentic-do/src/agent-vessel.ts`                                        | finite idempotent recipient transition; remove inbox relay, progress copy, close, and normal-run teardown |
| Agent tools                       | `workspace/packages/agentic-do/src/agent-worker-base.ts`                                   | remove close tool; preserve semantic merge/inspect/read and live cancellation only                        |
| Run state                         | `workspace/packages/agentic-do/src/subagent-runs.ts`                                       | remove `closed`, discard-for-close, close receipts, and non-live slot accounting                          |
| Tool presentation                 | `workspace/packages/agentic-chat/components/ActionMessage.tsx`                             | delete close-specific rendering                                                                           |
| Task transcript                   | `workspace/packages/agentic-chat/components/SubagentTranscript.tsx`, `SubagentRunCard.tsx` | canonical finite replay/tail without child activation                                                     |
| Agent guidance                    | `workspace/packages/agentic-do/references/subagents.md` and related skills                 | remove all normative closing instructions and explain retained terminal results                           |
| Host durable work                 | `src/server/services/durableWorkDriver.ts` and dispatch owners                             | claim the one mailbox and invoke the finite recipient transition                                          |

## 4. Goals and non-goals

### 4.1 Goals

- An idle channel with any number of durable members is hibernation-eligible.
- An idle agent joined to any number of channels is hibernation-eligible.
- Delivery correctness depends only on durable facts, never on an open stream,
  readiness hint, in-memory roster, or activation incarnation.
- A committed event's intended recipients are deterministically recoverable
  after loss between log append and mailbox projection.
- One recipient's slowness does not block another recipient.
- Agent delivery uses one durable message-path queue rather than two relay
  queues.
- Agent progress and completion are visible promptly without copied messages or
  polling.
- Waking a parent with a user message cannot consume or hide a child's terminal
  fact.
- Completed subagents consume no live-concurrency slot and require no cleanup
  action.
- Completed and failed subagents remain readable, inspectable, diffable, and
  mergeable after arbitrary hibernation and restart.
- Ordinary merge and subagent merge continue to share the same semantic merge
  driver and result vocabulary.
- Runtime observability can prove that no unintended indefinite DO-to-DO
  response remains.

### 4.2 Non-goals

- WebSocket transport. It is irrelevant to DO-to-DO collaboration; an outbound
  WebSocket would pin the initiating DO.
- Claude Code or other external-process lifecycle redesign.
- Provider/model-call cleanup. Active model work is intentionally active.
- Keeping ordinary agents warm as a latency strategy.
- Moving canonical message ownership out of GAD.
- A parallel legacy and new subscription route.
- Retention or deletion policy for old workspace state. This plan ensures
  retained state can sleep; a general retention plan may later decide what to
  delete.
- A subagent-specific messaging channel, observer, mailbox, or transport.

## 5. Binding invariants

1. **Membership is durable relationship state.** It survives hibernation and
   is independent of connectivity and presence.
2. **Presence is not routing authority.** Online/idle/away and connected client
   sessions may be activation-local projections; their loss cannot change who
   should receive a committed event.
3. **Stable identity routes; generations fence.** Recipient entity identity is
   stable. Activation incarnation, workerd boot generation, and claim generation
   may reject stale execution attempts but are not part of membership or
   delivery identity.
4. **GAD owns event facts.** Mailboxes and admission context are rederivable
   projections with versioned cursors.
5. **Hints are disposable.** Dropping every readiness hint delays work but
   cannot lose it.
6. **Finite RPC only between dormant-capable DOs.** No ordinary membership
   operation returns an indefinite response.
7. **Persist before side effects.** Recipient admission and effect derivation
   become durable before model/tool execution.
8. **At-least-once execution, exactly-once durable outcome.** Deterministic
   delivery IDs and generation fencing preserve idempotency.
9. **No model-managed resource housekeeping.** Models express semantic intent,
   never DO memory management.
10. **Execution and integration are independent axes.** A terminal child may
    be unintegrated; an integrated result needs no lifecycle transition.
11. **Retention is not liveness.** Retained contexts and DO storage consume
    storage, not ongoing execution, when no work or connection is active.
12. **One semantic route after each cutover.** No dual delivery, shadow
    consumer, compatibility flag, or subagent fast path remains.

## 6. Target channel model

### 6.1 Separate four concepts currently collapsed into `subscribe`

The target architecture has four independently owned projections:

| Concept             | Owner                     | Durable?                      | Purpose                                     |
| ------------------- | ------------------------- | ----------------------------- | ------------------------------------------- |
| Channel membership  | channel log/fold          | yes                           | authorization and historical participation  |
| Delivery interest   | channel log/fold          | yes                           | which committed events produce mailbox work |
| Presence            | client/session projection | no, except last-seen summary  | UI status only                              |
| Execution readiness | durable work system       | durable work; hint disposable | wake an entity with pending work            |

Joining a channel is a finite RPC that appends or revises durable membership and
delivery-interest facts. It returns after those facts are committed. It does
not open a response.

Leaving is a semantic membership operation, not activation cleanup. It is also
a finite RPC. Agent hibernation, restart, or lifecycle replacement does not
leave channels and does not rewrite membership.

### 6.2 Sequence membership and routing with the canonical log

Membership and delivery-interest revisions must be ordered relative to channel
events. They are represented as versioned log facts and folded into channel
interval state. Fan-out evaluates the interval state at the committed event's
sequence.

Consequences:

- a member joining after event 100 never receives event 100;
- a member active at event 100 remains an intended recipient even if projection
  recovery happens after it leaves at 101;
- restart timing cannot change historical recipients;
- a deleted local projection can be rebuilt from the canonical log.

Post-leave disposition is explicit, not emergent: a mailbox row derived for a
member whose subscription has since ended is created for receipt truth and
immediately terminalizes as `terminal-departed`. Leaving is the member's
semantic statement that it no longer processes this channel; no execution
occurs after departure, and no departed agent is woken. The row still records
honestly that the event was addressed to the member and not delivered.

The generic delivery layer interprets stable subscriber identity, interval,
and normalized audience only. Agentic respond policy, wake policy, streak,
context-integrity facts, and read semantics remain in the separately owned
agentic projection.

Membership identity and executable identity are distinct axes. Channel
members include stable human participants (`user:<userId>`) that are not
executable Durable Object entities. The generic model must never assume a
member is executable:

```text
participantId    — semantic channel identity: authorization, history, fold
deliveryEndpoint — where committed events become work, if anywhere
```

Use three closed, versioned relationship facts:

```ts
type DeliveryEndpoint =
  | { kind: "entity"; entityId: string } // durable executable target: produces mailbox rows
  | { kind: "session" };                 // live client transport only: no mailbox rows

type ChannelRelationshipEvent =
  | {
      kind: "channel.subscription.opened";
      participantId: string;
      revision: number;
      delivery: "all" | "addressed" | "none";
      endpoint: DeliveryEndpoint;
      applicationConfig: VersionedJson | null;
    }
  | {
      kind: "channel.subscription.revised";
      participantId: string;
      revision: number;
      delivery: "all" | "addressed" | "none";
      endpoint: DeliveryEndpoint;
      applicationConfig: VersionedJson | null;
    }
  | {
      kind: "channel.subscription.ended";
      participantId: string;
      revision: number;
    };
```

Only `entity` endpoints produce mailbox rows. `session` members receive
committed events through live client transport and authorized replay; their
membership, historical participation, and receipt truth are participant-based
like everyone else's.

The fold cursor is `(logSequence, phase, subscriberPosition)`. `phase`
distinguishes applying the event from projecting its recipients;
`subscriberPosition` bounds a single high-fan-out event. Cursor advancement and
each local mailbox batch commit in one channel transaction. Developer-state
projection-version changes reset and rebuild the disposable interval/mailbox
projection from these facts; retained production migrations require explicit
review.

### 6.3 Stable delivery identity

Delivery identity derives from stable semantic coordinates:

```text
deliveryId = hash(channelId, eventId, participantId, subscriptionRevision)
```

It does not contain an activation incarnation, and it is participant-based:
the executable entity is resolved from the subscription's `entity` endpoint at
fan-out, and the endpoint travels with the row. Incarnation remains useful only
inside exact execution:

- host claims work for an entity;
- exact-execution readiness resolves its current sealed runtime;
- a stale host attempt or old activation is fenced by existing generation and
  session checks;
- retry invokes the current activation with the same durable `deliveryId`;
- the recipient's durable transition treats a duplicate as the same work.

This removes reconnect and activation replacement from the semantic delivery
model.

Mailbox rows carry immutable event provenance and event-sequence relationship
facts. They do not freeze mutable runtime capabilities. At execution time, the
host resolves the target entity's current sealed execution and mints the normal
fresh authority attestation. A retired target terminalizes as retired; a stale
activation is fenced; a transiently unavailable active target retries the same
delivery ID. This preserves current authority semantics without making
membership depend on residency.

### 6.4 One message-path mailbox

The channel owns a rederivable recipient mailbox:

```sql
channel_delivery_mailbox (
  delivery_id,
  channel_id,
  event_id,
  event_sequence,
  participant_id,
  endpoint_entity_id,
  subscription_revision,
  envelope_json,
  projection_version,
  state,
  claim_generation,
  claimed_by,
  attempts,
  next_attempt_at,
  terminal_outcome_json
)
```

The channel maintains a bounded derivation cursor over the GAD log. Happy-path
publication advances it immediately; recovery replays from the last committed
cursor. A crash after GAD append but before mailbox insertion therefore heals
without publisher retry or a second semantic journal.

The host claims one mailbox row and invokes one finite idempotent recipient
transition. The recipient transition:

1. validates stable membership and authority facts carried by the versioned
   delivery projection;
2. persists the first admission decision keyed by `deliveryId`;
3. advances context-integrity state before exposing content;
4. commits the trajectory transition and derives any model/tool effect;
5. returns a structured processed/ignored outcome;
6. allows the channel claim to settle.

A lost response after recipient commit is harmless: retry presents the same
`deliveryId`, and the recipient returns its retained outcome. The
message-bearing `agent_inbox_queue` and `acceptChannelBatch` relay are deleted.
Recipient-local scheduled wakes remain agent-owned durable work because they
are not channel mail. Their ordering contract is binding, not incidental:
a local wake dependent on channel sequence S is ineligible until the
recipient's channel work through S is terminal — an explicit causal
prerequisite, never an accident of polling two queues in one lane. Independent
timer wakes need no invented global order. Deleting `agent_inbox_queue`
without this rule breaks scheduled model resumes.

This direct transition is the selected architecture, not an implementation
option. It may perform bounded local coordination and the required GAD/context
integrity commits; it must only derive durable descriptors for model, tool,
eval, HTTP, approval, or other long-running work. It may not create a second
message-bearing recipient queue. If measurement reveals that a bounded
coordination step is too large, split the transition internally around a
durable agent-owned state machine keyed by the same `deliveryId`; do not restore
the channel-to-inbox relay.

### 6.5 Delivery and read receipts

Receipt messages must not re-enter the channel pipeline.

- `received` means the canonical append committed.
- `delivered` means the recipient mailbox row committed.
- `read` is a recipient model-visibility projection/cursor.
- `declined` is a durable agentic admission outcome, not missing delivery.

The UI reads these projections through finite replay/query calls and its normal
external session transport. No receipt publish generates recipient work.

### 6.6 No activation resubscription

Delete the concept of recreating channel subscriptions after a DO restarts.
On activation, an agent reads its durable membership index only when needed.
Pending delivery already exists in the channel mailbox and durable-work
registry. There is no stream to reopen, watcher to restart, incarnation to
advertise, or recovery timer to schedule.

### 6.7 Explicitly resident execution is separate

An EvalDO may intentionally remain resident while an eval depends on in-memory
execution context. That residency belongs to the eval execution/session
lifecycle. It must not be obtained accidentally by opening a channel response
that also pins the Channel DO.

Define a generic, bounded resident-execution lease for components that truly
require in-memory continuity. It has an owner, reason, start, terminal outcome,
and recovery behavior. It is not channel membership and does not alter channel
delivery. Ordinary agents require no such lease while idle.

### 6.8 Signals must choose a side

Invariant 4 makes the mailbox a pure fold over the log. Today's channel
signals never reach the log, so they cannot survive that cutover unchanged.
Every signal kind must be classified, before the cutover, as exactly one of:

- **a log fact** — appended to GAD like any event, paying one append on the
  serialization ceiling, folded into mailbox rows deterministically; required
  for any signal whose loss changes semantic outcome (e.g. invocation
  lifecycle signals);
- **a disposable hint** — same contract as readiness hints: loss delays
  nothing semantically and drops nothing durable (e.g. typing/attention
  indicators), carried outside the mailbox entirely.

No third category exists. A signal that is "usually fine to lose" is a log
fact. The classification table is design lock 7 in §16.

## 7. Target subagent lifecycle

### 7.1 State model

The run's execution status is exactly:

```text
starting | running | completed | failed | cancelled | abandoned
```

There is no `closed` status.

Semantic integration remains a separate projection:

```text
unattempted | integrating | needs-decision | complete
```

The source event and current parent working head determine integration truth.
An unattempted result is simply retained work that the parent did not adopt. It
does not consume execution concurrency and needs no discard operation.

### 7.2 Completion

On successful child completion:

1. verify and retain the clean committed source event when present;
2. append the terminal task event idempotently;
3. enqueue one durable parent notification addressed by stable entity identity;
4. set execution status `completed`;
5. stop admitting further child execution;
6. retain task history, child context, agent state, semantic source, and run
   index.

The child and channel then naturally become hibernation-eligible. No context
destruction, task unsubscribe, lifecycle receipt conversion, or cleanup prompt
occurs.

The "durable parent notification" in step 3 is not a bespoke mechanism. The
direct child-to-parent completion RPC — with its ownership gate, per-channel
serialization chains, and publish-then-notify-then-status ordering dance — is
deleted. The terminal task event appended in step 2 **is** the notification:
the parent's delivery interest on the task channel is
"addressed + terminal + decision-requiring," so the terminal fact becomes an
ordinary mailbox row with a deterministic delivery ID, admitted through the
same idempotent recipient transition as any message.

The deleted RPC carried three load-bearing properties — caller identity
enforcement, fresh source verification, and settlement ordering. They are
reconstructed durably, not dropped:

1. **Fence, then publish, atomically on the child.** In one child-local
   transaction the child commits the terminal outcome and a post-terminal
   execution fence; after that commit no further model, tool, or effect work
   is admitted for the run. The fence precedes publication so a crash can
   never leave a run executing after its terminal fact exists.
2. **Idempotent durable publication.** The terminal task event is appended
   through the child's existing durable publication route with deterministic
   identity `subagent-terminal:<runId>`. Recovery republishes after any crash
   or lost response; the append is idempotent, so at-least-once publication
   yields exactly one log fact. Publication before fencing is impossible by
   construction of step 1, and fencing without eventual publication is
   impossible because the committed intent drives durable retry.
3. **Provenance validated at admission.** The ownership gate moves from the
   RPC boundary to event admission: the publishing participant must be the
   run's recorded child entity, and the event's task provenance (run ID, task
   channel) must match the run index. An arbitrary task-channel member cannot
   forge terminal status.
4. **Idempotent parent settlement.** The parent's recipient transition,
   keyed by the delivery ID, verifies and pins the retained source event,
   updates the run row's execution status atomically, and composes the
   supervision prompt (sibling status, next-step guidance) at admission time.
   Sibling terminals arrive from distinct task channels as independent
   idempotent transitions against independent run rows; no cross-channel
   supervisor lane or serialization chain is needed or permitted.

Tests 12 and 13 then follow from the general delivery guarantees instead of
needing their own machinery. The parent's durable membership in a terminal
run's task channel is retained relationship data like any other; once
membership owns no stream, it costs nothing and is never cleaned up.

Failed, cancelled, and abandoned runs follow the same retention rule. Their
state is evidence useful for diagnosis and retry.

### 7.3 Concurrency

`maxSubagents` counts only `starting` and `running` rows. Terminal rows never
hold a live slot. This removes the original practical reason models were told
to close children.

A run whose cancellation has been requested but whose terminal event has not
yet committed still counts as live. The slot is released by the terminal fact,
never by the request; otherwise `maxSubagents` briefly over-admits during
cancellation.

### 7.4 Cancellation

If a parent needs to stop live delegated work, expose a narrowly semantic
`cancel_subagent` operation. It is legal only for `starting` or `running` runs.
It fences further execution, emits one terminal cancellation event, and retains
the context and transcript.

Cancellation is not closure and does not imply deletion or semantic discard.
`cancel_subagent` ships with this plan as a first-class semantic operation:
internally it is implemented over the existing interrupt boundary, but it
exposes its own narrow contract and emits its terminal event through the §7.2
protocol like any other terminal. `closeSubagent` is not preserved under a
new name, and no part of its teardown logic is reused.

### 7.5 Integration

`merge_subagent` remains a thin ergonomic adapter over the shared semantic
merge driver. It is available for every retained run with a committed source
event, regardless of terminal age or prior hibernation.

Its result reports integration state, source, changed coordinates, conflicts,
compositions, intents, and whether integration is concluded. It contains no
`closingPermitted`, close guidance, or resource language.

Ordinary `vcs merge` of the same retained source event updates the run's
integration projection through the existing source-committed hook. Integration
truth never depends on which UI/tool entry point was used.

If the parent never begins integration, no explicit discard is necessary. If
the source has entered the parent working chain, remaining coordinates must be
resolved through the merge driver's explicit semantic decisions; lifecycle
labels cannot erase integration debt.

### 7.6 Inspection and task history

`inspect_subagent` and `read_subagent` remain available for terminal runs.
They read the retained child context, source event, and canonical task log.
They never refuse because a run is terminal.

The task-card transcript uses ordinary authorized replay and ordinary lazy
membership where membership is useful. Joining is no longer a live stream, so
opening historical cards creates no residency, receipt storm, or agent wake.
No non-member-observer capability and no parent-owned replacement channel are
introduced.

### 7.7 Suspension and notification

Terminal child delivery is durable parent inbox work, independent of whether
the parent is currently:

- running a turn;
- suspended waiting for background work;
- woken by a user message;
- hibernated;
- restarted between sibling completions.

Multiple terminal facts coexist by deterministic delivery ID. A foreground
user message cannot acknowledge or erase an unprocessed child terminal.

`suspend_turn({reason:"waiting_for_background"})` checks only live execution
rows. If none are `starting` or `running`, it returns immediately with:

```json
{
  "suspended": false,
  "reason": "no_live_supervised_runs",
  "completedRunsAwaitingIntegration": ["call_..."]
}
```

A terminal transition also invalidates any pending wait predicate. The parent
does not rely on being in a special suspended state to receive the notification.

### 7.8 Messaging a terminal run

§1 retains "communicate with it" as a semantic action; §7.2 stops admitting
child execution after terminal. These compose as follows: `send_to_subagent`
against a terminal run is refused with a structured semantic outcome that
names the run's terminal status, its retained source event, and the two real
options — merge/inspect the retained result, or spawn a new run (optionally
seeded from the retained context). It does not throw an opaque reference
error, deliver into a log nothing will execute against, or silently revive
execution. Reviving retained work is spawning, not messaging.

## 8. Complete `close_subagent` removal

This is deletion, not deprecation.

### 8.1 Tool and prompting surface

Delete:

- the `close_subagent` tool declaration, schema, handler, label, and renderer;
- all references in `references/subagents.md`, skill documents, system prompts,
  completion notifications, merge results, and error recovery text;
- all instructions to integrate-and-close, discard-and-close, retry close, or
  close to release a slot;
- `closingPermitted` and close guidance from `merge_subagent` output;
- the `ActionMessage` special treatment and tests for `close_subagent`.

### 8.2 Run store and state

Delete:

- `closed` from `SubagentRunStatus` and SQL constraints;
- `countAllocated()` semantics based on `status <> 'closed'`; replace it with a
  live-execution count;
- every branch that makes merge, inspect, read, messaging, or notification
  unavailable for `closed` rows;
- lifecycle receipts whose only purpose is resolving a closed handle;
- `discardedBeforeIntegration` if no remaining non-close behavior needs it;
- close-specific error codes and precondition helpers.

All existing run-store state resets at the cutover. Do not add a status
conversion shim, a `closed`-row migration, or any reader for the old shape.

### 8.3 Teardown

Delete the successful-run route through `teardownRun`, including:

- parent task-channel unsubscribe;
- recursive `runtime.destroyContext` on completion/integration;
- `closed` status update;
- cleanup-incomplete/retry-close errors.

Provisioning compensation for a spawn that fails before a run is published is
a different invariant. If partial context creation must be rolled back, name
and scope that routine as spawn transaction rollback and make it unreachable
from normal run lifecycle. Do not retain a generic close/teardown abstraction
for this one case.

Workspace retention or deletion, if later required, must operate through a
general policy over contexts and durable entities. It must not be a model tool
or a subagent lifecycle state.

### 8.4 Tests

Delete close behavior tests rather than rewriting them around a hidden close.
Replace them with assertions that:

- terminal runs free live capacity immediately;
- retained terminal runs remain inspectable and mergeable;
- task replay works after parent/child hibernation and restart;
- no tool catalog, prompt, notification, card, or merge result contains close
  language;
- no ordinary terminal path invokes `runtime.destroyContext`;
- an unintegrated source creates no parent integration debt until merge begins;
- an integration begun through either merge entry point remains governed by
  the semantic engine alone.

## 9. Canonical task progress

Child activity is appended once to the child's task channel. Presentation tails
or replays that log. The supervisor receives only:

- explicitly addressed child messages;
- deliberate `say` messages intended for the supervisor;
- one terminal task fact;
- exceptional supervision facts requiring a decision.

Delete:

- `subagent_progress_outbox`;
- its synthetic agent-inbox wake rows;
- `publishSubagentProgress`;
- relayed parent-channel `task.progress` messages;
- parent self-delivery caused by those relays;
- polling guidance necessitated by unreliable pushed progress.

The task card retains terminal summary/status on the parent surface and reads
detailed activity from the canonical task transcript. Opening or closing the
card does not change agent membership or execution.

## 10. Latency and resource effects

### 10.1 Eliminated steady-state work

For every durable agent/channel membership edge:

- one indefinite `rpc.stream` response disappears;
- one channel-side stream controller disappears;
- one agent-side stream reader and watcher disappears;
- retry timers and recovery attempts disappear;
- activation release no longer performs remote subscription release;
- restart no longer resubscribes or replays merely to restore liveness;
- presence/incarnation writes stop being prerequisites for agent delivery.

### 10.2 Eliminated per-message work

- Remove the channel queue claim -> `acceptChannelBatch` -> settle relay before
  agent inbox claim.
- Remove received/read receipt publications and their fan-out.
- Remove live channel reads from recipient admission where the co-derived
  projection already owns the fact.
- Remove copied subagent progress publication and self-delivery.
- Remove manual close tool calls and their status/VCS verification.

### 10.3 Expected behavioral improvements

- Dormant workspaces consume storage but negligible ongoing DO execution.
- A terminal child notification no longer depends on a live parent subscription
  incarnation.
- Parent wake latency depends on durable-work readiness and exact recipient
  execution only, not resubscription health.
- Fewer host claims reduce contention with model/eval/tool effects.
- Historical task inspection no longer reactivates a child execution or depends
  on retained stream state.
- Models spend context and tool budget on integration decisions, not lifecycle
  bookkeeping.

## 11. Observability contract

Before removing the old transport, add enough instrumentation to prove the
problem and the cutover:

- open streamed RPC responses by source entity/class, target entity/class,
  method, age, and whether bounded active execution owns them;
- agent and channel activations resident with no claimed work, active handler,
  model/tool/eval execution, or external client connection;
- durable membership count versus live transport count;
- channel derivation cursor lag and oldest underived event;
- mailbox commit, claim, recipient transition, and settlement latency;
- duplicate hints and duplicate idempotent recipient transitions;
- subagent terminal append -> parent mailbox commit -> parent admission latency;
- copied progress events per child tool event, required to reach zero;
- close-tool invocations and close-guidance tokens, required to reach zero;
- retained bytes per terminal subagent run (child agent DO storage, VCS
  context, context folder, task-channel log), so the deferred retention
  policy starts from measured data rather than a declared assumption.

Normal operation must satisfy:

```text
idle agent-to-channel streamed RPC count = 0
idle channel stream-controller count = 0
terminal subagent live-slot count = 0
terminal subagent cleanup tool calls = 0
child tool event canonical appends = 1
child tool event copied parent progress messages = 0
```

## 12. Implementation

The whole plan is implemented as one semantic cutover. There is no backward
compatibility, no migration, and no accommodation of existing state anywhere:
every schema this plan touches is created fresh, and every existing queue row,
subscription row, run row, projection, and relayed history may be discarded at
the cutover. Clean abstractions and performance are the only criteria. No
stage ships dual delivery routes, shadow consumers, or inert folds — the new
membership fold is authoritative the moment it exists, and the old writer is
deleted in the same change. Because closure removal and the stream cutover
land together, no terminal run ever retains a live parent task-channel
stream, and no interim automatic-unsubscribe cleanup is ever needed.

Internal ordering exists only where evidence demands it: instrumentation and
contract tests precede the cutover so before/after proof exists; validation
follows it.

### 12.1 Before the cutover — instrumentation and contract tests

- Add streamed-response age/residency diagnostics from §11.
- Capture idle workspace baselines with increasing agent/channel membership
  edges.
- Add hibernation-reconstruction tests using a fresh DO activation over the
  same SQLite state.
- Add system tests for parent suspended, parent active, user wake racing one of
  multiple child terminals, and parent restart between terminals.
- Record current exact-test baselines for messaging latency and
  `subagent-diff-inspection`.

Gate: every indefinite DO-to-DO stream is named; no unknown stream is waved
through as “probably active work.”

### 12.2 The cutover

One change, containing all of the following.

Membership and routing:

- Append versioned membership/delivery-interest facts to the canonical log;
  build the interval fold and versioned derivation cursor (§6.2).
- Replace participant-incarnation routing with participant identity plus
  endpoint resolution (§6.3); prove historical recipient selection is
  identical with and without restart.
- Separate `participants`/presence projection from durable membership and
  routing.

Delivery:

- Cut structured agent delivery to the one-mailbox finite-RPC protocol (§6.4);
  delete `channel_delivery_queue`, `acceptChannelBatch`, and the
  message-bearing `agent_inbox_queue` relay in the same change.
- Change agent join/revise/leave to finite RPC operations; delete agent
  `openSubscription`, response draining, unexpected-close recovery,
  release-on-lifecycle, resume-after-restart resubscription, channel stream
  creation for structured DO participants, and incarnation replacement as a
  delivery event.
- Keep recipient-local durable wakes on their own explicit queue with the §6.4
  causal prerequisite rule.
- Classify and reroute every signal per §6.8.
- Move every remaining `connectViaRpc`/HeadlessSession channel subscriber that
  runs inside a Durable Object to stable-identity finite RPC or durable cursor
  consumption; give genuinely resident execution (including active EvalDO
  work) its explicit bounded lease (§6.7); remove every indefinite DO-to-DO
  `subscribe` response.
- Replace receipt messages with delivered/read/declined projections (§6.5);
  remove live channel policy/roster reads from recipient admission using the
  versioned co-derived agentic context; make roster projection event-driven;
  validate context-integrity ordering and read-cursor semantics.

Subagents:

- Render task activity solely from the canonical task log; delete the progress
  relay and copied parent messages (§9). Pre-cutover relayed history is not
  preserved or migrated.
- Replace the completion RPC with the §7.2 terminal protocol; restrict
  supervisor delivery to addressed/terminal/decision-requiring facts; fix
  `suspend_turn` admission against live execution rows and durable pending
  terminals.
- Perform every closure deletion in §8; count concurrency from live execution
  only; retain all terminal run contexts, transcripts, source events, and
  projections; ship `cancel_subagent` (§7.4).
- Update merge/inspect/read/card/docs/system tests to the retained-result
  model.

Gate: ordinary agents and channels with durable membership but no work are
hibernation-eligible; all hints dropped plus host/workerd restart still
deliver every committed event exactly once visibly. The repository has no
indefinite DO-to-DO streamed RPC except the reviewed bounded execution lease.
One child tool event causes one canonical append and zero supervisor claims
unless addressed; every terminal wakes or remains pending for the parent
exactly once regardless of suspension or foreground user traffic. One human
message generates no receipt-driven deliveries and no serialized channel reads
before recipient admission. No executable product code, tool catalog,
normative agent guidance, prompt, product test fixture, or UI result exposes
`close_subagent` (historical architecture plans may name the deleted
operation only when clearly marked superseded); ordinary terminal paths never
destroy child context, and all retained results remain mergeable.

### 12.3 Validation — capacity and failure

- Run idle, fan-out, simultaneous model/eval/tool, and multi-subagent profiles.
- Kill host/workerd at append, derivation, claim, recipient commit, response,
  and settlement boundaries with all hints dropped.
- Validate slow/failing/retired recipients do not block peers.
- Run the smallest exact system tests, then only the broader coverage justified
  by observed blast radius.
- Publish before/after queue, residency, notification, and wall-time results.

Gate: latency and hibernation criteria in §14 hold under the declared capacity
envelope with no delivery loss or duplicate visible transition.

## 13. Required tests

1. A channel with many durable agent members and no work owns zero response
   streams and reconstructs membership after a fresh activation.
2. An agent joined to many channels and no work owns zero response streams and
   reconstructs its membership index after a fresh activation.
3. GAD append committed followed by channel crash before projection produces
   every missing mailbox row on replay and no duplicate.
4. Membership routing is evaluated at event sequence across join, leave,
   restart, and delayed projection.
5. A stale activation or claim generation cannot execute or settle current
   work; retry against the current activation preserves the same delivery ID.
6. Lost response after recipient durable commit retries to the retained outcome
   without a duplicate visible transition.
7. Dropping every readiness hint still drains every mailbox through registry
   reconciliation.
8. One slow or failing recipient does not delay another recipient's mailbox,
   claim, transition, or receipt.
9. Same-recipient/channel ordering survives retry and restart.
10. Context lineage advances before content becomes model-visible.
11. Active EvalDO execution retains its required in-memory context without any
    channel-owned response stream; terminal eval releases only its explicit
    execution lease.
12. Two sibling subagents completing while the parent is suspended produce two
    durable terminal facts and exactly one processing outcome each.
13. A user message waking the parent between those completions neither hides nor
    acknowledges the second terminal.
14. `waiting_for_background` is rejected when no run is `starting` or `running`,
    and names terminal runs awaiting integration.
15. A terminal subagent immediately frees live concurrency without any tool
    call.
16. Terminal completed, failed, cancelled, and abandoned runs remain readable
    and inspectable after parent and child hibernation/restart.
17. A completed clean source remains mergeable through both `merge_subagent`
    and ordinary VCS merge; both update the same integration projection.
18. No terminal or integration path calls `runtime.destroyContext`.
19. Task history remains available without copied parent progress, special
    observation membership, or child execution activation.
20. Tool catalog, prompts, notifications, UI cards, merge output, skills, and
    docs contain no `close_subagent` or equivalent housekeeping instruction.
21. A spawn failure before publication either rolls back through the narrowly
    scoped provisioning transaction or leaves a diagnosable failed record; it
    cannot call a normal-run close routine.
22. One user message with N agents creates zero receipt messages and zero
    receipt-driven mailbox rows.
23. A message published while a member agent has no live activation — including
    across a channel activation restart — still produces that member's mailbox
    row and eventual admission (the current stream-drop message-loss window is
    closed).
24. Every log-fact signal survives hint loss and restart like a message; every
    disposable-hint signal lost under the same faults changes no durable state
    and no semantic outcome.
25. `send_to_subagent` against each terminal status returns the structured
    refusal naming the retained source event; no path revives execution.

## 14. Release criteria

### 14.1 Correctness

- No committed message is lost across any tested boundary.
- No durable delivery creates two visible recipient transitions.
- Historical routing is independent of activation and recovery timing.
- User foreground work and background terminal work compose without one hiding
  the other.
- Semantic integration remains engine-owned and entry-point-independent.

### 14.2 Hibernation

- Durable agent membership creates no indefinite response or outbound
  connection.
- Durable channel membership creates no in-memory controller.
- Fresh activation reconstructs all required state from SQLite/log facts.
- Idle agents and channels have no timers, pending I/O, or `waitUntil` work
  attributable solely to membership.

### 14.3 Latency and DX

- Warm publish-to-mailbox and mailbox-to-recipient-transition percentiles meet
  the latency plan's declared SLOs or an updated measured envelope approved
  before release.
- `subagent-diff-inspection` does not regress from the post-readiness-cache
  baseline for infrastructure-attributable time.
- Terminal notification latency is measured separately from model time and has
  no subscription-recovery component.
- One child tool event is stored once and not copied.
- A successful supervised workflow requires no lifecycle housekeeping call.

### 14.4 Deletion proof

- No old live agent subscription route remains.
- No old structured channel-delivery-to-agent-inbox relay remains.
- No copied subagent progress route remains.
- No `closed` run state or `close_subagent` behavior remains.
- No compatibility flag or second semantic path remains.

## 15. Rejected approaches

- **Automatically close after merge.** Saves one model call while retaining
  unnecessary deletion, conflated state axes, and cleanup failure modes.
- **Keep close as an optional expert tool.** The operation still advertises a
  false requirement and will continue consuming model attention.
- **Rename close to archive.** Terminology does not fix state destruction.
- **Parent-own or copy the task channel.** The task channel already persists
  independently of child context; re-ownership invents a lifecycle problem.
- **Special non-member task observation.** Ordinary authorized replay and
  membership are sufficient once membership no longer allocates a stream.
- **Hibernatable WebSockets between DOs.** Only the accepting endpoint can
  hibernate; an outbound socket pins the initiating DO.
- **One WebSocket per channel from the RPC hub.** Moves connection scaling and
  residency into the hub and is unnecessary for durable delivery.
- **Keep the stream only as an incarnation lease.** Incarnation is execution
  fencing, not routing identity.
- **Keep agents warm.** Hides cold latency at a residency cost that scales with
  membership and does not remove coordination work.
- **Poll the channel from every agent.** Converts resident streams into periodic
  wake storms and worsens latency.
- **Dual-write old and new mailboxes.** Creates two delivery authorities and
  ambiguous receipts.
- **Treat an unmerged terminal child as integration debt.** Debt begins only
  when the source enters the parent working chain.
- **Delete retained contexts to save compute.** Hibernatable retained state is
  not active execution; deletion belongs to a general retention policy.
- **Make EvalDO channel membership special.** Eval residency belongs to a
  generic explicit execution-session contract, not a channel transport
  exception.

## 16. Design locks before implementation

The architecture is selected above. Implementation starts only after review
locks these remaining contract details in the relevant schemas:

1. The relationship-event schemas in §6.2, including the closed versioned
   `applicationConfig` envelope owned by the outer application rather than the
   generic delivery kernel.
2. The bounded derivation cursor `(logSequence, phase, subscriberPosition)`,
   batch limits, projection-version reset rule, and registry-driven recovery
   entry point.
3. The direct recipient-transition input/output schema, deterministic outcome
   record, and proof that a response lost after commit returns the prior
   outcome on retry.
4. The execution-time authority contract in §6.3: immutable provenance in the
   row, current sealed target and fresh attestation at invocation, explicit
   terminal-retired outcome.
5. A generic resident-execution lease API for EvalDO and any future component
   with a genuine in-memory continuity requirement. The lease must be bounded
   to an active operation, inspectable, and absent from channel relationship
   state.
6. Retention policy remains explicitly outside this plan; no implementation
   phase may block on it or substitute deletion for hibernation. The
   retained-bytes-per-terminal-run metric in §11 must exist at the cutover so
   the deferral is measured, not merely declared.
7. The signal classification table from §6.8: every existing signal kind
   assigned to log fact or disposable hint, reviewed before the cutover.
8. The terminal-run messaging contract from §7.8: the structured refusal
   shape for `send_to_subagent` against terminal runs.
9. The agent-local wake queue's causal prerequisite rule from §6.4: how a
   wake dependent on channel sequence S expresses its eligibility condition.

Everything else follows from the core decision: durable relationships sleep,
durable work wakes them, and models never manage runtime residency.
