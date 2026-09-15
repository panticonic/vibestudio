# Hibernation-first delivery hardening

**Status:** proposed repair + hardening program, 2026-08-10
**Scope:** the entire hibernation-first collaboration delivery system landed in
8f2a94936 — the channel DO's mailbox projection, relationship lifecycle, call
dispatch and settlement, the pubsub RPC client, resident sessions and EvalDO,
the agent vessel's effect outbox, and the subagent lifecycle — plus the
verification machinery that keeps it correct as it evolves.
**Companion:** [agentic-messaging-latency-refactor-spec.md](agentic-messaging-latency-refactor-spec.md)
(the spec the rewrite shipped with), [channel-lifecycle-contract.md](channel-lifecycle-contract.md)

---

## 0. Why this plan exists

Commit 8f2a94936 ("make collaboration delivery hibernation-first", Aug 9,
101 files, +11,875/−5,731) replaced activation-bound channel subscriptions and
incarnation-addressed inbox relays with a durable, replayable recipient
mailbox. The first observed casualty was a wedged desktop agent: the mailbox
projection suppressed self-authored events without an explicit audience, so a
`client_eval` terminal authored *as* the calling agent but executed *by* the
panel never created the caller's mailbox row. The agent's effect outbox
redrove the settled call once a minute forever. That specific defect is fixed
in the working tree (protocol builders now stamp `to: caller` on
`invocation.output` and every terminal variant), and a sibling regression —
dual direct-vs-mailbox method dispatch for resident sessions — was identified
but deliberately not patched.

Rather than fix the next symptom and wait for the one after, we ran an
exhaustive six-subsystem audit of everything the rewrite touched:

1. channel DO core (`channel-do.ts`, `delivery-projection.ts`, `broadcast.ts`,
   `calls.ts`, `log-store.ts`);
2. the pubsub client transport (`rpc-client.ts`, `channel-client.ts`,
   `subscription-manager.ts`, `agentic-core/connection.ts`);
3. the agent vessel and effect outbox (`agent-vessel.ts`, `effect-outbox.ts`,
   `agent-loop-driver.ts`, `agent-loop`);
4. the subagent lifecycle (`subagent-runs.ts`, chat-op relay, task cards,
   including follow-up cc9ac3894);
5. resident sessions, EvalDO, and durable-work ownership;
6. protocol/policy audience completeness (every event kind × the projection's
   suppression rule) and the session/worker legs.

The audit produced **~45 distinct findings**, from two more permanent-wedge
mechanisms of the exact class already seen, through crash-window losses, to
latent traps. It also produced a register of invariants that were checked and
found sound — as important as the defects, because it tells future readers
what does *not* need re-deriving.

The conclusion this plan is built on: the findings are not 45 independent
bugs. They are violations of **six invariants** that the rewrite introduced
implicitly but never stated, enforced, or tested. The repair program therefore
has two halves: fix the instances, and make the invariants *load-bearing* —
stated in one place, enforced by construction where possible, and tested where
not — so the next 101-file change to this system cannot silently violate them.

---

## 1. The architecture as built (ground truth)

One paragraph of orientation for every later section.

Every channel event is appended to the GAD log with a deterministic envelope
id. A **fold** advances a per-channel projection cursor strictly one sequence
at a time (`delivery-projection.ts`), maintaining: the relationship table
(join/leave/revise facts → versioned rows per participant), the conversation
delivery context, and — via `deriveDeliveries` — the **mailbox**: one durable
row per (event, entity participant, subscription revision), keyed by a
deterministic delivery id. Live sessions receive events through the
activation-local broadcast fan-out (`broadcast.ts` header: durable entity
delivery *never* passes through it). Entities receive events *only* through
mailbox rows, pumped as durable work: claim (generation- and worker-fenced) →
`acceptChannelDelivery` on the recipient → settle/fail with capped backoff.
Vessels admit deliveries into an idempotent admission journal and run the
agent loop; resident clients (EvalDO / headless) receive them through the
resident-session registrar, which restores the originating execution context.
Method calls (`channel_call`) journal a durable `started`, dispatch (directly
via `onMethodCall` RPC for entity transports; via live signal for sessions),
and settle **terminal-first**: the terminal event is durably appended before
the pending-call row is deleted and before any broadcast.

The suppression rule at the heart of the incident: a self-authored event
creates no mailbox row for its author unless `addresses()` — which reads
`payload.mentions` and `payload.to` only — explicitly targets the author.
Members with `delivery: "addressed"` stance get rows *only* when `addresses()`
matches.

---

## 2. Design laws

These are the six invariants the audit findings violate. They become the
review contract for every future change to this system (§8).

### 2.1 Audience totality

Every recipient that must *durably* receive an event is computable from the
envelope plus the projection's own folded relationship state — `payload.to` /
`payload.mentions`, resolved by the single choke point `addresses()`, which
may consult the relationship table it itself maintains (deterministic under
replay) but nothing outside the fold. Every selector shape the schema admits
must have exactly one defined resolution at `addresses()` — resolvable there,
or rejected at append; "representable but silently no-audience" is the
violation. No recipient may be encoded in side fields the projection does not
read (`payload.target`, `payload.transport.target`, handles), and no event
kind whose semantic author differs from a required recipient may omit its
audience. "The sender already knows" is a
statement about the *author of the payload bytes*, not about the roster
participant recorded as sender; whenever those diverge, the audience must be
explicit. (This is the generalized form of the incident fix.)

### 2.2 One declared route per capability

How a participant receives each capability (events, method invocations) is a
**declared property of its relationship**, stated at join time — never
inferred from the shape of its endpoint id. There is exactly one semantic
delivery path per (event, recipient); a second path may exist only as a
latency optimization that is provably a no-op when both run (idempotent,
same terminal). The rewrite deleted the `participantIsAgentVessel`
discriminator and inferred "direct RPC" from `endpointKind === "entity"`;
every Bug-2 symptom flows from that inference.

### 2.3 Mailbox rows are authority

A ready/retrying mailbox row is a debt the channel owes the recipient. It may
be extinguished only by (a) delivery + settlement, (b) an explicit lifecycle
end of the relationship (leave, retirement), or (c) a **superseding delivery
guarantee** that provably re-covers the same events (a join replay that
actually replays through head). Dropping rows on a revision bump while joins
default to `replay: false` and replay is a 50-event tail violates this;
so does inheriting another channel's rows (fork). (Receipt *timing* is not
part of this law: the companion spec defines "delivered" as row creation by
design — see DH-17.)

### 2.4 At-least-once, acknowledged after processing

Every leg of the pipeline is at-least-once; therefore every consumer is
idempotent — or, where a consumer surface cannot be (arbitrary resident
guest handlers, external provider side effects), its at-least-once exposure
is an explicit documented contract, never an implicit surprise (DH-21,
DH-24, §4.1's guarantee ceiling) — and every acknowledgment (delivery RPC
result, cursor write,
dedup-key registration, claim settlement) happens **after** the processing it
attests to, never before. Crash windows between a durable append and its
derived side effects must be closed by re-derivation on the other side, and
each such window has a kill-point test.

### 2.5 Convergent redrives, no clock authority

Every retry loop terminates through a *lifecycle event* — a durable terminal,
an idempotent "already done" classification, or an explicit typed refusal that
settles the work — never through a timer, and never not at all. A redrive that
can observe "the thing I'm redriving already happened" must treat that as
success, not as an error to re-arm. Poison work (permanently malformed input,
unregisterable recipient) must be *classified* terminally as a durable fact,
not retried blind forever. (Consistent with the no-clock-authority doctrine:
the terminating event is a classification decision, not a deadline.)

### 2.6 Every durable relationship and claim has a lifecycle owner

If a durable fact obligates ongoing work (an entity relationship generates
mailbox rows; a running subagent generates an eventual terminal; a resident
registration accepts deliveries), some component owns *ending* it on every
exit path — success, failure, cancellation, retirement, abandonment. The
audit found four obligations with no owner on at least one path.

---

## 3. Findings register

Stable ids `DH-xx`, grouped by the law they violate. **Status key:**
`fixed` = already in working tree; `open` = this plan schedules it;
`accept` = documented behavior, no change planned. Severity reflects blast
radius; confidence reflects verification depth (all `confirmed` findings were
verified against current working-tree code by line).

### 3.1 Law 2.1 — audience totality (the incident's family)

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-01 | conversation-v1 builders | invocation outputs/terminals lacked `to: caller` → caller wedge (the incident) | critical | confirmed | **fixed** |
| DH-02 | `conversation-v1.ts:62-86`, `delivery-projection.ts:612-629` | `invocation.started` carries no `to`; target only in `payload.transport.target`, which `addresses()` never reads. Addressed-stance entities and self-calls have **no durable started leg**. Currently masked by the direct-dispatch route — which makes this the load-bearing constraint on the Bug-2 repair: removing direct dispatch without this breaks method execution outright. | major | confirmed | P2 |
| DH-03 | `channel-do.ts:3759-3789`, `events.ts:608-621` | `ui.feedback` encodes its recipient in `payload.target`; projection never reads it; addressed-stance targets never durably learn their published method/card is broken ("method-rot" feedback loop silently dead). | med | confirmed | P2 |
| DH-04 | `calls.ts:583-648` | `settleMissingCall` journals its recovery terminal addressed to `participantRef("unknown")` and compensates with a **live-only** broadcast; addressed-stance entity callers never see it → parked invocation wedges (Bug-1 symptom through another door). *Verified, plus the repair path confirmed: the provider's incoming call event carries `senderId` and the client's `submitMethodResult` (`rpc-client.ts:1144-1176`) simply drops it — forward it and the channel can address the real caller. Loss is confined to `delivery:"addressed"` durable callers; `delivery:"all"` callers still receive the terminal.* | med-high | confirmed | P2 |
| DH-05 | `linked-agent-worker.ts` `say` RPC, `channelHost.ts:513-523` | Linked (Claude-Code-bridged) subagent `say` never stamps `to: parentParticipantId` (the in-process path does, `agent-worker-base.ts:480-495`). Supervisors watch task channels `delivery:"addressed"` → a linked child's deliberate progress message never wakes the parent; the system prompt's "a deliberate child say can resume you" is false for linked children. *Verified end-to-end; fix confirmed trivial: `subagentIdentity()?.parentParticipantId` is populated at say time (launch binding → STATE_ARGS → inherited parser), so the linked `say` needs the same three-line default as `agent-worker-base`.* | high | confirmed | P2 |
| DH-06 | `channelHost.ts:131-134` | CLI bridge `mentions` are participant *handles*; `addresses()` compares participant *ids* → handle mentions address nobody durably. Compounds DH-05. | low | confirmed | P2 |
| DH-07 | `delivery-projection.ts:624-628`, `agent-vessel.ts:7203-7218` | `ParticipantSelector kind:"role"` is representable and accepted at the `sendAsCaller` surface but dead in `addresses()` — silently no-audience. | med (latent) | confirmed | P2 |
| DH-08 | `subagent-prompt.ts:24-27` | `parentParticipantId` is optional; a child `say` without it silently loses its supervisor audience instead of failing loudly. | low-med | likely | P2 |
| DH-09 | `delivery-projection.ts:624-628` + `:376-381` | `to:[{kind:"all"}]` counts as *explicit* addressing and overrides self-suppression → broadcast-addressed senders receive their own message as a mailbox row (self-wake; possible self-reply loop depending on admission). *Verified: no shipped code publishes `to:[{kind:"all"}]` today — every constructed audience is participant-kind — but `sendAsCaller` passes `opts.to` through verbatim, so it is an externally reachable latent trap.* | minor | confirmed (latent) | P2 |

### 3.2 Law 2.2 — route duality (Bug 2, now fully traced)

The precise mechanism, established end-to-end by the audit:

`participantTransport` (`channel-do.ts:1273-1281`) returns `"entity"` iff the
relationship's `endpointKind === "entity"`. Resident RPC clients (EvalDO,
headless) join with `endpoint: {kind:"entity", entityId: <own DO id>}`
(`rpc-client.ts:1663`) — so the `"resident-session"` transport value **never
matches an actual resident session**; the discriminator that used to separate
vessels from RPC-style DO clients (`participantIsAgentVessel`) was deleted by
the rewrite along with the comment documenting why it was load-bearing.

Consequences per target class:

- **Agent vessel:** direct `onMethodCall` executes; the mailbox `started`
  reaches the vessel's admission path, which does not execute invocations →
  executes once, correct. (This is why desktop panels and vessels looked fine.)
- **Resident EvalDO/headless client:** the direct `onMethodCall` is refused
  (RPC default-deny; the owning DO defines no `onMethodCall`), and the catch
  at `calls.ts:459` **settles the call as an error terminal**. Meanwhile the
  mailbox route executes the method anyway; its `submitMethodResult` finds the
  terminal already durable and is silently discarded. Net: **side effects run
  exactly once, the caller is told the call failed, the real result is lost.**
  Not double execution — refused-then-zombie-executed.
- **Disconnected durable session** (`endpoint_kind='session'`): classified
  `resident-session` → no live broadcast, no mailbox row (projection derives
  for entities only) → the call parks until its journaled deadline, **forever
  if deadline-less** (see DH-12).

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-10 | `channel-do.ts:1273-1281`, `calls.ts:415-439` | Route inferred from endpoint-id shape (above). Repair: **declared invocation route** at join (§4.1). | critical | confirmed | P3 |
| DH-11 | `calls.ts:869` (`redeliverPendingCallsTo`) | The second direct-dispatch site; any route repair must cover both. | — | confirmed | P3 |
| DH-12 | `calls.ts:842` | `redeliverPendingCallsTo` has **no caller anywhere** (call site removed pre-rewrite, 76d261980): pending-call redelivery is dead code. A provider that misses/loses its `started` and rejoins never executes; deadline-less calls pend forever. *Second review round elevated this from cleanup to load-bearing: P3's execution-after-ack window needs it, so the mailbox-based re-attach redelivery lands **in P3** (§4.1); P7 adds claim fencing on top.* | high | confirmed | P3 (+P7 fencing) |
| DH-13 | `runtime/worker/durable-base.ts:1511-1513` | Workspace durable-base exposes `acceptChannelDelivery` against the shared registry but offers no `registerResidentChannelSession` — any non-vessel workspace DO joined as an entity endpoint permanently fails delivery (latent trap; today only vessels join). | low (trap) | confirmed | P3 |

### 3.3 Law 2.3 — mailbox rows are authority

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-14 | `channel-do.ts:4531-4591` (postClone) vs `delivery-projection.ts:213-215` | **Fork inheritance** *(verified; precision: child seqs continue from the fork point, so the wedge triggers on retro-forks — forking at an earlier message, a real UI path via `useForkLineage.ts:484,497` — while at-head forks escape; verification also confirmed the inherited-mailbox hazard concretely: the claim pump stamps the child's channelId onto parent-event envelopes and vessel identity checks pass, and inherited relationships encode parent state "from the future" relative to the child log)*: `postClone` resets fork_ops/participants/pending_calls/dedup_keys but none of the six projection tables. A forked child inherits the parent's cursor (say 40) over a log re-rooted at forkPoint (20): every child event ≤ 40 folds as a silent no-op → **zero mailbox rows** — the fork seed, early conversation, and any invocation terminal on the child are never delivered to any entity. Inherited relationships point at parent-lineage DO ids (ghost dispatch targets); inherited ready rows get delivered to *parent* agents stamped with the *child's* channelId; the inherited delivery context is permanently wrong (skipped seqs never correct it). | critical | confirmed | P4 |
| DH-15 | `delivery-projection.ts:283-299`, `channel-do.ts:2699-2748` | **Revision retire:** any `subscription.revised` — including metadata-only `updateMetadata`, which performs no replay at all — flips every pending ready/retrying row of older revisions to `terminal-retired`. The justifying comment ("replay in the join ACK reconstructs everything") is not honored by any caller: join replay is a 50-event tail with no `sinceId`, and vessels routinely join `replay:false`. Concrete trigger (verified, frequency corrected): linked-agent bridge attach and detach each stamp changed `linkedAttachment` metadata → one revision bump per **edge** (two per cycle), each silently retiring any pending backlog; byte-identical refreshes are short-circuited on both client and channel and bump nothing. Repair: **carry pending rows forward unchanged** across same-endpoint revisions (§4.2 — the row's revision stamp is an at-sequence historical coordinate the recipient contract already accepts). | high | confirmed | P4 |
| DH-16 | `calls.ts:339-355, 393-405` | **Live-only redrive backstop:** when a caller redrives an already-settled call, the channel "re-broadcasts" the durable terminal via `broadcastLive` — which durable entity callers never receive. Combined with DH-15 (the terminal row retired before delivery), the caller redrives forever: the incident's exact symptom through a second hole. | high | likely | P4 |
| DH-17 | `delivery-projection.ts:411-422` | ~~"delivered" receipts written at row creation~~ **Reclassified: per-spec design, not a defect.** The companion spec (§1, §4) defines *delivered* as "the recipient's mailbox row is durably committed" — deliberately not activation/admission/processing. The residual dishonesty (rows retired by DH-15 before any pump still read delivered) is a DH-15 consequence and shrinks with its fix; rows retired at genuine *departure* are spec-honest "delivered but not read". If the UI ever needs "processed", that is a **new** receipt kind, not a redefinition of this one. | — | confirmed | **accept** |
| DH-18 | `agent-vessel.ts:2549-2571` | A delivery arriving between the channel-side join commit and the vessel's local subscription INSERT (crash window) is journaled as a **permanent decline**, retained for all duplicates even after the store converges. | low-med | likely | P4 |

### 3.4 Law 2.4 — at-least-once / acknowledgment discipline

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-19 | `rpc-client.ts:1536-1539` vs contract `:270-272` | **Resident ack-before-processing:** a live mailbox row arriving during replay is buffered in activation memory and the finite delivery RPC resolves — the channel settles the row while the event exists only in RAM. Activation death in the window = settled-but-never-seen. Violates the rewrite's own stated invariant ("resident delivery is acknowledged only after this handler accepts the hydrated event"). *Repair decided (verified both variants implementable): during the replay window, fail the delivery with a typed retryable error so the channel retains the row — more failure-isolated than holding the cross-DO RPC and its delivery lane open for the whole replay (which would also inherit DH-25's wedge).* | major | confirmed | P5 |
| DH-20 | `rpc-client.ts:711` vs `:722` | Replay dedupe key registered *before* handling, which can throw → an intra-generation retry of the same event is dropped as a duplicate. | minor | confirmed | P5 |
| DH-21 | `durableWorkDriver.ts:559-575` | Crash between execute and settle of a channel-delivery claim redelivers the envelope to resident guests, which have no per-live-event dedup — guest `onEvent` sees it twice. At-least-once is the declared contract; the exposure is that resident *guest code* is not told so. | low | confirmed | accept + document (P8) |
| DH-22 | `agent-loop-driver.ts:1108-1119`, `effects.ts:308-311` | `record_receipt` effects are by design never re-derived; a crash in the append→outbox-insert window permanently drops the read-cursor update. | minor | confirmed | P6 |
| DH-23 | `agent-vessel.ts:4690-4710` | Crash between `eval.start` ack and `markDeferredEvalStarted` replays the *start* path; if EvalDO disposed in the window, the eval re-executes — the precise hazard the marker exists to prevent. | minor | likely | P6 |
| DH-24 | `agent-loop-driver.ts:1514-1520`, `agent-vessel.ts:1654` | A completed-but-unsettled effect outcome is discarded when the claim generation was superseded, and the §1.4.2 mutating-tool crash-replay guard is a stub (`alreadyApplied: () => false`, pre-existing) → generation adoption re-executes a finished mutating tool / re-spends a finished model call. The rewrite made adoption a routine path, widening exposure. *Verified, with a hard repair fact: in the exposure window `applyOutcome` has by definition not run, so **no existing durable fact records that the tool executed** — a journal-backed `alreadyApplied` cannot be synthesized from current journals. The repair requires new commit-time evidence written atomically with the mutation, keyed by `descriptor.invocationId` (the guard's existing key); the deferred-eval `deferredEvalStarted` marker is the in-repo precedent for exactly this pattern.* | major | confirmed | P8 |

### 3.5 Law 2.5 — convergence failures

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-25 | `rpc-client.ts:1667-1713, 1748` | **Ack-settlement deadlock:** `acknowledged = true` is set before ACK-envelope replay ingestion, which can throw (missing blob, missing provenance, unstable cursor); the catch only rejects when `!acknowledged` → the ack promise never settles → `recoverSubscription` never returns → `recovering` stuck `true` → the client is a **permanent zombie on a healthy transport**; every future recovery no-ops. *Verification added a second leg: even when the failure is transient and a later recovery succeeds, the initial `openSubscription` promise still hangs, so `fullyReady`/`client.ready()` never resolves for the original caller. Fix ordering verified safe: `ready()` gates on the ready control emitted at the end of ingestion, so resolving ack first exposes no un-ingested state; the one behavior to audit per consumer is `onReconnect` firing before ingestion completes.* | critical | confirmed | P1 |
| DH-26 | `agentic-core/connection.ts:180-194` | Rewrite moved the per-event `try/catch` outside the loop: one throwing `onEvent` exits the `for await` permanently while the subscription stays open and status stays `"connected"`; events accumulate unread in an unbounded queue. One-line regression, silent total delivery stop. | major | confirmed | P1 |
| DH-27 | `rpc-client.ts:1466-1478` + `:1536-1539` | Ready-path replay-ingestion failure is swallowed (`rejectReady` no-ops after first settle); `replayComplete` stays false; every subsequent live event is buffered forever — stall + unbounded memory, no recovery trigger. | major | confirmed | P1 |
| DH-28 | `agent-loop-driver.ts:2199-2213`, `agent-vessel.ts:2996-3034` | **Scheduled-resume poison:** the resume row is deleted before the wake row settles; on host death in the window, adoption re-readies the wake row, every redrive finds the resume row gone, throws "transition is not due", and re-arms at ~30s **forever**. *Verified with two corrections: (1) the wake lane is degraded, not starved — during backoff the poison row is not a candidate, so other wakes proceed; the permanent effects are the retry-forever loop and repeated slot theft. (2) The fix must key on row **existence, not dueness**: the lookup filters due rows, so "not found" today conflates deleted-because-executed with present-but-rescheduled-later; treating the latter as success would settle the wake row terminal and (via DH-51) silently lose the future resume. Verified safe otherwise: the only deleter runs after successful execution, so absent ⇒ executed.* | major | confirmed | P1 |
| DH-51 | `agent-vessel.ts:2701-2713, 2940-2946, 3081-3089` | **Settled wake-row id collision (new, found in verification):** terminal-completed `scheduled-resume:<channel>:<messageId>` wake rows persist forever; a later legitimate reschedule of the same `(channel, messageId)` re-arms via `INSERT OR IGNORE` against the dead wake id and is silently swallowed, while `readyDurableWorkQueues` keeps signaling ready off the still-due resume row — an unclaimable busy ready-signal and a lost resume. Fix alongside DH-28: delete (not terminal-mark) settled scheduled-resume wake rows, or salt the wake id. Subsumes the DH-relevant part of V7's unbounded terminal-row accumulation. | med | confirmed (reachability gated on same-messageId reschedule) | P1 |
| DH-29 | `agent-vessel.ts:3414-3427` | A redelivered already-settled terminal (or a chatOp relay terminal whose in-memory pending entry died with the activation) fails delivery for the *entire duration of any unrelated in-flight model call* ("may still materialize" probes `inFlightModelCall` globally) → head-of-line blocks the ordered mailbox for minutes. *Verified both halves: the failure is correctly scoped to the one claim item, but the channel's blocker predicate stalls the participant's entire lane behind the failed head row, including through its backoff window — an absolute per-participant head-of-line stall for the duration of the unrelated model call.* Scope the probe to the invocationId / check the journaled terminal. | med | confirmed | P1 |
| DH-30 | `rpc-client.ts:713-721, 365-372` | **Poison events:** an event missing provenance stamps or referencing a GC'd blob throws retryably forever — resident: head-of-line mailbox block; stream: resubscribe/error loop. Needs a permanence classification (typed settle-with-error). *Fifth review round: the originally proposed "back-stamp legacy provenance" leg is dropped — pre-provenance events exist only in pre-cutover channels, which are reset, not repaired. The classification itself is not legacy work: blobs can be GC'd and payloads malformed post-cutover too.* | major | likely | P8 |
| DH-31 | `channel-do.ts:1099-1140` + `EvalDO` lifecycle | **Abandoned resident relationship:** if an eval ends without `connection.close()` (or the activation dies), the drain stops the receiver but nothing leaves the channel: the entity relationship keeps generating mailbox rows; each delivery fails `ResidentSessionUnavailable`; `failReadyWork` retries with capped backoff forever; the channel never idles. The resolving lifecycle event has **no owner**. Repair: detached membership (§4.5) — the typed `ResidentSessionUnavailable` refusal becomes a durable detach fact; delivery pauses, membership persists, re-registration re-attaches. | high | likely | P6 |
| DH-32 | `agent-vessel.ts:2975-2994` | Vessel-side `failReadyWork` has no maxAttempts exhaustion, unlike the executor-failure path — thrown `executeEffectClaim` errors retry forever. **Decided (§6.0):** retained for transient infra; deterministic throws go to the P8 poison classification. *Verification corroborated: the wake-queue `failReadyWork` (`agent-vessel.ts:2996-3034`) is equally uncapped — it is what makes DH-28 unbounded — so the classification must cover both queues.* | minor | confirmed | P8 |
| DH-33 | `channel-do.ts:3868-3886, 1152-1174` | A fold failure after a successful append is healed only by the *next traffic*; the alarm never folds and `durableWorkStatus` never compares cursor to head — a quiet channel can hold an undelivered event indefinitely. *Verified; one mitigation exists: `adoptDurableWorkWorker` runs a catch-up once per server-generation adoption, so a server restart heals the lag — all other catch-up sites are traffic-driven.* | minor | confirmed | P4 |
| DH-34 | `calls.ts:652-672` | `ensureMethodRoot` appends a deterministic-id envelope without `idempotency:"idempotent-by-id"` (its sibling `journalCallStart` passes it) → concurrent settles race into a hard "exact" integrity error; transient settle failure. | minor | confirmed | P1 |

### 3.6 Law 2.6 — lifecycle ownership gaps

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-35 | `agent-vessel.ts:929-949, 2477-2493` | **Retirement orphans children:** `releaseForLifecycle("retire")` unsubscribes channels and cancels deferred evals but never cancels/abandons live subagent runs → children execute on, publish terminals into channels the parent left, run rows read `running` forever, no `task.abandoned` is ever recorded. *Verified exhaustively (host side too: `retireEntity` has no child cascade). Repair shape corrected by verification: cancellation must run **before** the unsubscribe loop, and the durable wake-row backstop is **invalid across retirement** (post-retire, the vessel's wake queue is unreachable — hints discarded, execution refused). Per `listLive()` run: fence the child (`cancelSubagentExecution` / provider release) and supervisor-author the terminal **inline** via `settleSubagentTerminal(run, "abandoned")` — admission accepts supervisor-authored non-completed terminals.* | med-high | confirmed | P6 |
| DH-36 | `agent-vessel.ts:3223-3238` vs `:6284-6321` | **Recovery conflates identity axes:** runs recovered from the parent-channel card carry `childParticipantId: null`; terminal admission then falls back to `childEntityId` — exactly the conflation the spawn code documents as forbidden for external runs (`vesselParticipantId` ≠ `vesselEntityId`). Where they differ, the child's terminal is dropped with a warning and the run wedges. *Verification downgraded this to **latent-only**: both ids provably derive from the same DO addressing triple today (`do:<source>:<class>:<key>`) for Pi and claude-code launches alike, so the fallback comparison currently succeeds — the trap is guarded only by a comment and arms the day either id scheme moves.* Persist `childParticipantId` in the `task.started` card and restore it (cheap, still correct). | med (latent) | confirmed | P6 |
| DH-37 | `subagent-runs.ts:263-271` | `getBySourceEvent` picks `ORDER BY started_at DESC LIMIT 1`, but forked no-op siblings legitimately share a source event id → the wrong run's integration snapshot is marked complete; the other reads "awaiting integration" forever (guidance/provenance error, no data loss). | low-med | likely | P6 |
| DH-38 | task terminals only on task channel; `SubagentRunCard.tsx:80-111` | The parent channel's `ProjectedTask` never reaches a terminal state, so every historical subagent card re-opens an observer connection to its child channel on every panel mount, forever; if the child channel becomes unobservable the card is stuck "running" — execution status diverging from reality, the class the rewrite meant to abolish. Mirror the terminal to the parent channel under the same `subagent-terminal:<runId>` idempotency key. | med | confirmed | P6 |
| DH-39 | `subscription-manager.ts:96-107, 124-129` | Join/leave revisions derived from a possibly-stale local row and never reconciled with the channel (relationshipState consulted only when no local row exists). *Verified, mechanism corrected: the channel's semantics are byte-identical same-revision join = silent re-assert (so one crash direction self-heals), but any other mismatch — revision behind, ahead-by-≥2, or same-revision-different-payload — is a **hard error**, and the manager has no resync path: every subsequent join and leave throws forever.* Membership strands permanently (or ghosts accumulate undeliverable rows). *Client-side verification narrowed reachability: the local write happens after the join RPC, so only remote-ahead desync is reachable, and the two common crash cases self-heal (absent row → remote consult; changed-relationship retry → idempotent re-assert). The hazardous residue is the revert case: relationship content reverts to the stored JSON after a crashed bump, the manager reuses the stale revision, and every join/leave then hard-errors forever.* Have join/leave return the channel's authoritative revision and persist it; on revision-mismatch errors, resync from `relationshipState` instead of failing forever. | major (narrow trigger) | confirmed | P5 |
| DH-40 | `EvalDO.ts:3374-3377`, `rpc-client.ts:854-856` | `settleResidentSessions` awaits in-flight deliveries, which await the guest's `residentEventHandler`: a non-resolving guest `onEvent` pins the eval's terminal path. The drain is right to await; the missing piece is an abort lever into the delivery (AbortSignal in the resident contract, part of the P7 provider lane). | med | confirmed shape | P7 |

### 3.7 Agent-loop and presentation semantics

| id | where | defect | sev | conf | phase |
|---|---|---|---|---|---|
| DH-41 | `step.ts:1580-1601, 1688-1703`, `fold.ts:224-241` | **Parked terminal report:** if a child terminal is admitted while the parent's turn is open and its report-prompt artifact preparation is still in flight when `suspend_turn` settles, the turn parks `waiting`; the later `prompt.artifacts_ready` promotes only when there is *no* open turn or steering exists → in a quiet resident DO the report sits in `deferredPostTurnQueue` indefinitely: child shows completed, parent never sees it. (cc9ac3894's tests only cover the artifacts-already-ready case.) *Verification **upgraded** this finding: the interleaving is lane-deterministic, not a race — the suspend tool and the report's artifact-preparation effect share the per-channel outbox lane, and the suspend row predates the preparation row, so the park-before-ready ordering is **guaranteed** whenever a child terminal is admitted while `suspend_turn` is in flight. Every alternative wake path was traced and none fires.* | high | confirmed | P6 |
| DH-42 | `step.ts:1126-1132` | `alreadyIngested` doesn't cover `deferredPostTurnQueue` or promoted entries → redelivered terminal reports burn `APPEND_RETRIES` fold reloads before converging via the journal. Latency/fragility only; layered defenses hold. | low | confirmed | P6 |
| DH-43 | `agent-vessel.ts:3264-3285`, `chat-op.test.ts:3166-3210` | Near-simultaneous sibling terminals each snapshot the other as "remains live"; the test **asserts the inaccurate text**. Guidance error steering the model to suspend for finished work. | low | confirmed | P6 |
| DH-44 | `rpc-client.ts:874-883, 2207-2233` | Recovery-replay events are stored but never emitted to already-running `events()` iterators → disconnect-gap events silently dropped for stream consumers that don't independently resync on `onReconnect`. **Pre-existing**, preserved by the rewrite. *Verified with a refinement that de-risks the decided repair: post-ready late replay already emits to running iterators today, so emitting mid-recovery replay widens an existing event shape, not a novel one. Consumer survey: all phase-filtering consumers safe by construction; `useChannelMessages` is explicitly phase-aware; only `ConnectionManager.onEvent` consumers need an idempotency check.* | major (for stream consumers) | confirmed | P5 |
| DH-45 | `rpc-client.ts:762, 1583-1585, 1685-1691` | During the deliberate old/new subscription overlap, async ingestion from the superseded generation can regress `lastSeenSeq` → spurious gap repair → duplicate `live`-phase emissions that bypass dedupe (live messages have no dedupe key at all — verified concrete). Make `lastSeenSeq` monotonic and drop superseded-generation ingress post-ACK. *Scoping (verified): stream transports only — the resident path aborts and awaits the previous generation before joining, so residents never overlap.* | minor | confirmed | P5 |
| DH-46 | `rpc-client.ts:1019, 2036-2038` | Terminal correlation falls back from `causality.transportCallId` to `invocationId`. *Verified: every channel-authored terminal path stamps `transportCallId` (pending-row key, synthetic recovery row, cancel override), so the fallback is exercisable only by non-channel-authored `invocation.*` events — a real coding hazard with theoretical operational exposure today. Still index `methodCallStates` by both keys (cheap), as defense against future emitters.* | minor | confirmed (theoretical) | P5 |
| DH-47 | `rpc-client.ts:1760-1769` | `recoverSubscription` destroys roster/dedupe/replay state before the replacement subscription exists; a failed rejoin leaves an empty-state stall window. Stage the reset behind the replacement ACK. | minor | confirmed | P5 |
| DH-48 | `channel-do.ts:2807-2844` | `getParticipants` labels durable *session* relationships as live `'do'` participants; a user whose stream dropped is listed forever. Roster/UI semantics only. | minor | confirmed | P4 |
| DH-49 | `handlers.ts:275-313`, `channel-chat-merge.ts:487-488` | Read-acks bump `updatedAt`, which is the transcript sort key → late acks reorder messages below their replies. **Pre-existing**; the new persistent read-cursor machinery makes late acks more common. Sort by seq/startedAt. | low | confirmed | P6 |
| DH-50 | `EvalDO.ts:2852-2888` | One-microtask post-completion delivery window re-enters a returned sandbox run; bounded and drained. Informational. | info | confirmed | accept |

---

## 4. Architectural repairs

Four structural repairs carry most of the register; the rest are point fixes
scheduled in §6.

### 4.1 Declared invocation route, then a single provider lane (DH-02, 10–13, 40)

**Step one — declaration (P3).** The join endpoint gains an explicit route:
`endpoint: { kind: "entity", entityId, invocation: "direct" | "mailbox" }`.
The declaration is **required at the join API** — every new entity join states
its route; nothing may omit it and silently inherit the privileged direct
path (that would recreate the implicit-routing class this law exists to end).
There is **no legacy interpretation and no recovery choreography**: the
declaration is required in the schema and in the fold alike, and **the
cutover is destructive by policy** — pre-cutover channels and dev instances
are reset/re-onboarded, full stop (the companion spec's stated stance:
cutovers reset unresolved local agentic work). This paragraph converged
over three review rounds, each cutting deeper: draft one made the field
optional with a `direct` default (silently privileging the exact implicit
route the law bans); draft two kept an absent→`direct` rule in the fold as
"reading immutable history" — a conversion shim, since this pre-release app
has no installed base whose history deserves a working interpretation;
draft three replaced the default with poison-skip *plus a rejoin
convergence story* — still accommodation, and the fifth review round showed
it was **nonfunctional anyway**: after a poison-skip the projection holds
no relationship, so a fresh rejoin re-derives the same early revision the
old undeclared fact already occupies, and the channel's verified join
semantics (same revision + different payload = hard error; idempotent
append returns the original fact) mean the declared relationship never
establishes. A recovery path that cannot recover is pure complexity. Final
form: the fold requires the field; an undeclared fact is malformed input
handled by the generic poison-skip like any other malformed fact — a
diagnostic, not a migration lane — and no rejoin dance exists because the
channels that would need it are reset instead. Ships with the P3
projection version bump. Vessels declare
`"direct"`; the resident RPC client declares `"mailbox"`.
`participantTransport` classifies mailbox-route entities as mailbox-served:
`dispatchCallStart` and `redeliverPendingCallsTo` stop direct dispatch for
them and rely on the durable `started` row, which the resident client already
executes correctly on live delivery. Prerequisite: DH-02 (`started` must
stamp `to: [target]`, the exact mirror of the terminal fix, so
addressed-stance and self-call targets derive a mailbox row at all). The
spurious-refusal terminal disappears; the discarded-result path disappears;
steady-state behavior for vessels and panels is unchanged. The cutover
itself is destructive, by policy: pre-cutover channels are reset and
re-onboarded, not converged.

**Ordering constraint (review-validated):** P3 makes the mailbox the sole
invocation route for resident targets, so the mailbox's known loss mechanisms
must be repaired *first* — DH-15/16 (P4) and resident process-before-ack
DH-19 (P5). Landing P3 before them would let a revision bump erase the only
start row or an activation death acknowledge one that existed only in memory.
Execution order in §6 reflects this: **P4 and P5 precede P3.** (Today's
pre-P3 state fails differently — spurious error terminal, discarded result —
so the reorder trades a deterministic wrong-failure for correctness landed in
the right sequence, not a regression window.)

**Execution-after-ack window (second review round, validated):** even with
P4/P5 landed first, one loss window remains structural to P3's shape. The
resident client acknowledges the delivery, then launches method execution
fire-and-forget (`rpc-client.ts:864-868` — deliberately, so cancellation is
not head-of-line blocked), with dedup state held only in activation memory
(`:1199-1217`). If the activation dies after the ack but before
`submitMethodResult`, the started row is settled, the call is still pending,
and nothing redelivers it — a deadline-less call wedges. P3 therefore ships
with a bounded slice of P7's start redelivery: **pending-call start
redelivery on provider re-attach** — when a mailbox-route provider's
relationship re-attaches (rejoin, revision bump, detach→attach), the channel
re-derives ready rows for its still-pending `started` envelopes (the
`pending_calls` row survives until terminal, so this is a deterministic
query; `redeliverPendingCallsTo`'s purpose returns through the mailbox
rather than direct dispatch). Semantics for unsettled calls are
at-least-once — re-execution is possible after activation loss, late
results of already-settled calls are discarded by the channel today — and
P7's claim fencing narrows the duplicate window to crash recovery (§ below
for why that is the honest ceiling).

This is deliberately the *smallest correct* repair: route is declared, one
semantic path per recipient, nothing inferred from id shape. What it does not
provide: generation-fenced single-claimant execution and a formal
cancellation lane — those are P7.

**Step two — the provider lane (P7).** The full recipient-owned provider
route from the original analysis, landed once the system is stable. One
state-model clarification forced by the fourth review round: "the channel
retains the start until settlement" means the **`pending_calls` row** — the
canonical start evidence, which already survives until the terminal — and
the provider-claim state beside it. It must NOT be modeled as a
non-terminal *mailbox* row: the mailbox lane is strictly ordered per
participant (an earlier non-terminal row blocks every later claim,
`channel-do.ts:900`), so a long-running or deadline-less method would
head-of-line block the provider's entire event lane, including the very
cancellation the lane exists to deliver. The started *delivery* settles on
admission like any other; the invocation's pending lifecycle lives in
`pending_calls` + the claim record, and re-attach redelivery re-derives
from there (as P3 already specifies). With that split: providers claim
idempotently with generation fencing; late results are
suppressed by generation rather than silently dropped; cancellation travels
outside the execution lane with an AbortSignal contract threaded through the
resident-session registrar (also resolving DH-40); canonical start redelivery
after relationship revision (subsuming dead DH-12); one protected provider
hook shared by vessels, EvalDO clients, and headless sessions. **Honest
guarantee ceiling (third review round, accepted):** claim fencing gives
*single-claimant* execution — no concurrent or routine duplicate execution —
but it cannot close the crash window between an arbitrary provider method's
external side effect and the durable record of its outcome; lease recovery
must re-execute. That is the same structural limit DH-24 names for mutating
tools, and no fencing scheme escapes it without provider-side idempotency
evidence. The plan therefore claims **at-least-once with single-claimant
fencing**, not "effectively-once"; providers whose side effects demand more
supply their own commit-time evidence (the DH-24 pattern). **Decided:** the
lane also restores a direct-dispatch **fast path** for mailbox-route
targets — a latency optimization permitted by law 2.2 because execution is
fenced by the same provider claim (keyed on `transportCallId`), so in the
absence of a crash the direct attempt and the mailbox row collapse to one
execution, and a refused or lost direct attempt is harmless (the mailbox
remains authoritative). Files:
`calls.ts`, `channel-do.ts`, `delivery-projection.ts`, `rpc-client.ts`,
`agent-vessel.ts`, `residentSession.ts`, `EvalDO.ts`, `headless-session.ts`,
`agentic-core` types. This is the ~10–14-file change; step one removes the
urgency that previously argued for a shortcut version of it.

### 4.2 Projection lifecycle correctness (DH-14–17, 33, 48)

**Fork reset — boundary-aware, not replay-from-zero.** A first draft of this
repair ("reset the projection and replay from cursor 0") was **refuted in
review**: the fork is no-copy — the child log contains the parent prefix
*verbatim, including relationship facts* (the test at
`channel-do.test.ts:2088` documents exactly this) — so a zero replay would
fold the parent-lineage relationships straight back into the child's
projection: the ghosts return by construction. A second review catch refined
the repair again: skipping the prefix *wholesale* is also wrong, because the
prefix carries two kinds of state the fork needs **opposite** behavior for.
Parent relationships must not be reconstructed — but the conversational
projections must be: `deriveEvent` embeds `agenticContext` built from
`channel_delivery_context` and resolves `replyToSenderId` from
`channel_delivery_message_senders` (`delivery-projection.ts:329-372`,
verified), so a child event replying to a pre-fork message needs the prefix
folded into those tables or it derives against initial conversation state
with unresolvable reply senders. The repair is therefore a **two-regime
fold**: `postClone` drops all six projection tables and records the boundary
(`forkPointId`, already persisted by the fork flow); the fold replays the
prefix in *context-only mode* — conversation-state and message-sender folds
apply; relationship application and all delivery derivation are skipped —
and switches to the full regime at the boundary. Relationship state starts
empty at the boundary (child participants re-join with their own identities,
already the fork flow's behavior) while conversational state stays faithful
to the inherited transcript. The regime switch keys on the durable boundary,
so replay is deterministic; `ensureProjectionVersion` applies the same
two-regime rule on any rebuild.

**Revision transition semantics.** Split what a revision bump means:

- *leave / endpoint change / departure* → retire pending rows (current
  behavior, correct: the recipient is gone or its address is invalid);
- *same-endpoint revision* (metadata update, presence refresh, config
  re-subscribe) → **carry pending ready/retrying rows forward unchanged** —
  no retire, no re-key. This repair went through three wrong drafts before
  the third review round pointed at the fact that makes the trivial answer
  correct, and the history is worth keeping. Draft one recomputed delivery
  ids and claimed admission journals dedupe across revisions (false — the id
  incorporates the revision, so a recomputed id is a fresh admission,
  `agent-vessel.ts:2514`). Draft two preserved the id (worse — admission
  hard-fails a same-id duplicate whose revision differs,
  `agent-vessel.ts:2526-2535`: a permanent wedge). Draft three recomputed
  ids again and leaned on event-level idempotency — real for vessels,
  admittedly weaker for resident method calls. All three drafts shared a
  false premise: that a pending row's revision stamp must match the current
  relationship revision. It must not. The row's `subscription_revision` is
  the **at-sequence historical coordinate** — the relationship revision when
  the event folded — and the recipient contract already says exactly this:
  "the locally stored revision may legitimately be newer … decline only when
  this vessel is not the addressed participant at all"
  (`agent-vessel.ts:2553-2560`), while the channel reads the row's revision
  only as a claim passthrough (`channel-do.ts:942`). So the entire fix is to
  **narrow the retire condition in `foldRelationship`**: retire pending rows
  on leave/endpoint change (the recipient is gone or re-addressed); on a
  same-endpoint revision, leave them exactly as they are. No new admission
  identity, no duplicate delivery, no idempotency argument required — the
  fix deletes aggression rather than adding machinery. This closes DH-15
  for every trigger — including linked-agent bridge attach/detach, which
  bumps the revision once per *edge* (byte-identical refreshes are already
  short-circuited on both client and channel) — without demanding
  `replay:true` from any caller.

**Durable redrive backstop.** The settled-call redrive path (DH-16) and
`settleMissingCall` (DH-04), when the caller's transport is mailbox-served,
re-insert a ready mailbox row for the durable terminal under the caller's
*current* revision instead of (or in addition to) `broadcastLive`. With this,
"the terminal is durable" finally implies "the caller can always converge",
which is the invariant the settle pipeline was built for — DH-15/16 can then
only delay, never wedge.

**Receipts stay at row creation** (DH-17, reclassified): the companion spec
defines *delivered* as durable mailbox commitment, by design. No change; see
the register entry.

**Lag healing** (DH-33): the alarm (or `durableWorkStatus`) compares the
projection cursor to head and kicks a bounded `deriveDeliveries` when behind.

Any change to fold semantics ships with a **projection version bump** — the
projection is disposable-by-design and rebuilds deterministically; version
discipline is what makes that safe (§5).

### 4.3 Transport settlement discipline (DH-19, 25–27, 39, 44–47)

The client-side principle: **every acknowledgment settles, and settles after
processing.** Concretely: the subscribe-ACK promise settles on every path
(move `resolveAck` before fallback ingestion; ingestion failures flow to the
terminal error path, never a silent swallow — DH-25/27); a replay-ingestion
failure aborts the subscription controller so recovery runs instead of
buffering forever; resident deliveries hold the delivery RPC until the
handler has processed the row, or fail retryably while replay is in progress
so the channel retains it (DH-19); the stream event loop regains its
per-event catch (resident propagation stays — that asymmetry is the retry
contract, DH-26); `lastSeenSeq` becomes monotonic with superseded-generation
ingress dropped (DH-45); recovery staging replaces destroy-then-rebuild
(DH-47); recovery-phase replay is emitted to running iterators tagged
`phase:"replay"` (DH-44, decided §6.0).
`subscription-manager` stops trusting its local row: join/leave return the
channel's authoritative revision and the local store persists that (DH-39).

### 4.4 Subagent lifecycle closure (DH-35–38, 41–43)

Retirement, **before** its unsubscribe loop, fences every `listLive()` child
(`cancelSubagentExecution` / provider release) and supervisor-authors the
`abandoned` terminal **inline** via `settleSubagentTerminal` — the child
obligation gets an owner on the retire path. (Not via the durable
`subagent-cancel-settle` wake row: verification showed that backstop is
unreachable across retirement — post-retire, the vessel's wake queue is
refused and its hints discarded.) Task terminals are mirrored to the parent
channel under the same `subagent-terminal:<runId>` idempotency key, making the
parent-channel projection terminal-complete: historical cards stop opening
observer connections and can never diverge from reality. Recovery persists
`childParticipantId` (and external session ids) in the `task.started` card
details and restores them, ending the identity-axis conflation. The
`prompt.artifacts_ready` handler promotes a ready deferred report into an
open *waiting* turn exactly as the suspension-settlement branch does
(DH-41 — the missing fourth promotion path). `alreadyIngested` covers the
deferred queue and promoted source ids; sibling roster lines are computed
after status advance (and the test asserting the phantom-sibling text is
corrected, not preserved).

### 4.5 Detached membership (DH-31) — staying on the channel, correctly

The first-draft repair ("EvalDO drain leaves the channel") answered the
ownership gap by ending the membership. The better answer — keeping law 2.3's
"rows are authority" and law 2.6's ownership — is a third relationship state:

- **attached** (today's active state): rows derive, pump delivers;
- **detached**: the member remains a member, but **no mailbox rows are
  materialized at all** — the detach fact records the log sequence at which
  delivery paused, and the channel owes the member the *range*, not
  pre-materialized rows. (Third review round: the first detach draft kept
  deriving rows while the pump paused, which converts DH-31's infinite
  retry into unbounded mailbox growth with no owner — a fair hit. The log
  is already the durable record of every event; materializing per-event
  debt for a member that may never return duplicates that record
  indefinitely. Derive-on-reattach keeps the projection's storage
  proportional to *active* obligations.);
- **ended** (leave/retire): today's terminal, unchanged.

Transitions are lifecycle events, never clocks: graceful drain (eval
completes without guest `close()`) detaches explicitly; the crash path
detaches when a delivery fails with the *typed* `ResidentSessionUnavailable`
refusal — the refusal itself is the durable detach fact, requiring no new
client code. Re-registration of the same delivery identity re-attaches: the
fold derives the member's rows for the recorded gap `(detachedAtSeq, head]`
in one bounded backfill keyed on the durable detach sequence, and the pump
resumes. **Backfill context contract (fourth review round):** backfilled
rows stamp the `agenticContext` current at the *re-attach* fold point, not
the historical at-sequence context — reconstructing at-sequence context
would require replaying from channel origin, which is rejected as
machinery for a field nobody reads: the resident receiver contract hands
guests only `{channelId, envelope}` and **drops `agenticContext` entirely**
(`residentSession.ts:88-93`, verified), and resident members are the only
detachable class. Per-event facts remain exact regardless (envelope bytes
are the log's; `replyToSenderId` resolves from the cumulative
message-senders table, which keeps folding while detached). This is
deterministic across rebuilds — the backfill's context is defined by the
re-attach fact's fold position — and it is recorded as a constraint: if a
context-consuming member class ever becomes detachable, it needs
at-sequence replay, and that is the moment to build it. Explicit
leave remains the true ending, and it gains a second owner with a **durable
enumeration source** (fourth review round — the in-memory receiver registry
and execution-local cleanups cannot name the memberships after an
activation loss, exactly the DH-31 case): registration commit persists a
small resident-membership catalog row in the EvalDO's own storage (channel
ref + delivery identity). **Catalog ownership follows the relationship,
not the registration** (sixth review round — an earlier phrasing keyed
clearing to "`close()`", which is ambiguous and wrong in one reading: the
per-eval registration cleanup that runs on every eval completion
(`EvalDO.ts:3374→3331`) is the *drain* — a detach, under which the catalog
row must survive, or retirement loses its enumeration again). The row is
written idempotently at first registration for a channel, retained across
every drain/detach/re-attach cycle, and deleted only when the
*relationship* ends: the guest's explicit `connection.close()` (which
performs the channel leave) or the retirement / context-destruction sweep
itself, which reads the catalog, leaves each channel, then clears the rows.
Both deleters are idempotent against each other — leave on an
already-inactive relationship is a verified silent no-op — so a crash
between leave and catalog delete just makes the sweep re-leave harmlessly.
**EvalDO retirement / context destruction reads that catalog and leaves
each channel** — so an identity that can never re-register cannot hold a
detached membership open. Between detach and that terminal event the
channel holds one small relationship row and one sequence number, not a
growing mailbox: the storage law is satisfied by construction, not by a
reaper.

Both contingencies are now **verified in the design's favor**:

- The resident delivery identity is stable across successive evals in the
  same EvalDO *by necessity* — `deliveryId = clientId ?? selfId` resolves to
  the EvalDO's own DO identity, and the receiver registry and inbound
  delivery routing are keyed by exactly that id, so any *working* resident
  configuration already uses a stable, DO-resolvable identity. A later eval
  re-registering on the same channel re-attaches the same relationship and
  the backlog drains. Only a *different* EvalDO (different objectKey) orphans
  a relationship — that is the one place an explicit identity contract would
  ever be needed, and it can wait for a concrete consumer.
- The crash-path detach requires **channel-side changes only**: the host
  driver already forwards the failure error to the channel
  (`DurableWorkFailure.error`, `durableWorkDriver.ts:611-616`), and
  `failReadyWork` (`channel-do.ts:1060-1063`) simply ignores it today.
  Reading `error.code === "ResidentSessionUnavailable"` there and folding a
  detach fact is the entire crash-path mechanism — no client plumbing.

**Execution-context boundary (second review round, accepted with a
refinement):** stable transport identity proves *routability* to the same
EvalDO, not ownership by the same resident operation — a later eval has its
own execution context, method roster, and authority lineage, and the backlog
may contain `invocation.started` rows intended for the completed execution.
The design resolves this by making **capability, not identity, the execution
gate**: backlog *events* are folds (safe under the documented idempotent-fold
contract); backlog *method starts* execute only if the re-attached
registration actually advertises the method — `handleMethodCallExec` looks
the method up in the current registration's roster, and an unknown method
settles the call with a typed method-unavailable failure instead of
executing in the wrong context. A successor eval that re-registers the same
methods is semantically a restarted provider handling queued requests (the
ordinary at-least-once contract); one that doesn't is a clean typed refusal
that converges the caller. Authority follows the executing registration, as
it does for any restarted provider.

The third review round pressed further: a matching method *name* does not
prove continuity of credentials, causal ownership, or authorization scope.
True — and here the plan draws a deliberate line against over-engineering.
This system runs in a **trusted single-workspace environment** (a design
premise recorded elsewhere in this repo): successive evals in the same
EvalDO are the same workspace's code operating under the same trust
domain, and every execution's *actual* authority is resolved by the
authority system at call time from the executing registration — never
inherited from the invocation. The residual risk is therefore "the same
workspace's later program handles a queued request the earlier program
accepted," which is ordinary restarted-provider semantics, not an
authority transfer: no privilege travels with the queued start. If this
system ever hosts mutually untrusting tenants, the upgrade is one field —
an execution **epoch** declared at registration, stamped on starts, and
fenced at execution with a typed stale-epoch refusal. That is deferred
deliberately, with its shape recorded here, rather than built now for a
threat model the product explicitly does not have.

---

## 5. Downstream ramifications

What each repair touches beyond its own diff — the questions to answer
*before* each phase lands, so this program does not become its own 8f2a94936.

**Projection determinism and versioning.** The fold is a deterministic
replayable function; DH-14/15 change its outputs. Every fold-semantics
change bumps the projection version so channels rebuild rather than mixing
regimes mid-log. Rebuild is cheap and already exercised
(`ensureProjectionVersion`); the discipline is non-negotiable — a fold change
without a version bump would make old and new rows coexist under different
semantics, which is exactly the class of temporal bug this plan exists to end.
This discipline is a **forward** contract (fifth review round): it
guarantees determinism for every channel created after the cutover,
including future rebuilds when later phases bump the version again. It
promises nothing about pre-cutover channels — those are governed by the
reset policy, and an earlier draft's claim that the rebuild "retroactively
heals" broken forks is withdrawn as exactly the kind of compatibility
promise the reset policy exists to avoid making. The two-regime fork fold
(§4.2) is design for post-cutover forks, not a repair service for old ones.

**Wire and store compatibility.** The route declaration is **required
everywhere** — schema and fold; an undeclared relationship fact is malformed
input (generic poison-skip, no recovery lane — §4.1); pre-cutover channels
are reset. This is a pre-release app with no installed
base: cutover policy is reset, not migration, so no compatibility rule
exists for the field at all. `to` on
`invocation.started` is additive schema, same as the landed terminal fix.
Pending mailbox rows are **carried forward unchanged** across same-endpoint
revisions (§4.2) — their revision stamp is the at-sequence historical
coordinate the recipient contract already accepts, so there is no re-key,
no new admission identity, and no duplicate delivery.

**Behavioral deltas to assess in review.**
- Mailbox-served invocations trade the direct-RPC latency for the mailbox
  pump on resident targets. Resident evals are the only affected class (panels
  are live sessions; vessels stay direct); the pump is the same machinery that
  delivers their every other event, and correctness beats the lost
  milliseconds. If latency ever matters, the P7 lane may re-add direct
  dispatch as a *provably idempotent* fast path (law 2.2 allows exactly that).
- `started` audience rows mean addressed-stance vessels now receive started
  rows for calls targeting them. Vessel admission consumes invocation events
  without executing (verified sound in the audit); net effect is a wake, which
  is precisely what a call to an addressed-stance supervisor should cause.
- The carry-forward split changes `terminal-retired` population downstream:
  rows are no longer retired on same-endpoint revisions, so anything
  monitoring retired counts (durableWorkStatus heuristics, tests) must
  expect retire to mean *departure or endpoint change*, never *revision* —
  and pending rows may now legitimately carry a revision stamp older than
  the current relationship revision.
- Terminal mirroring to the parent channel adds one event per subagent run to
  parent-channel logs; task projection already freezes terminal states against
  late/duplicate facts (verified sound), so replay is safe.
- Detached membership (DH-31, §4.5) means an eval's relationship persists
  across evals with delivery paused, and a later eval with the same delivery
  identity resumes the backlog. Consumers of such backlogs must be idempotent
  folds over the union view (they already are — the headless reducer — and
  the contract gets documented with the feature). Anything that *wants*
  eval-scoped membership ends it with an explicit `close()`.

**Test enshrinement.** Three test sites currently assert defective behavior
(`chat-op.test.ts:3166-3210` phantom sibling; cc9ac's suspension tests cover
only the artifacts-ready case; `channel-do.test.ts:1704` and its siblings
*assert the DH-10 direct `onMethodCall` dispatch to resident participants* —
these flip to mailbox-route assertions in P3, and a mock that realistically
rejects `EvalDO.onMethodCall` already fails against them today, faithfully
reproducing the production refusal). Fixing behavior means correcting
tests — a reminder that "tests pass" was true throughout the incident; §7
is what actually guards this system.

**What we deliberately do not change.** The suppression rule itself (sender's
ordinary self-authored events create no self-row) is correct and stays; the
repair philosophy is *audience totality*, not suppression removal. Vessel
`onMethodCall` direct dispatch stays (it is the declared route). The no-clock
doctrine stays: every fix here terminates loops by classification or
lifecycle event, none by timeout. At-least-once stays the delivery contract;
we document it for resident guests (DH-21) rather than pretending
exactly-once.

---

## 6. Phased execution

### 6.0 Resolved decisions (2026-08-10)

- **Execution order is P0 → P1 → P2 → P4 → P5 → P3 → P6 → P7 → P8.** Phase
  *numbers* are stable identifiers from the first draft; the *order* was
  corrected in review: the route switch (P3) makes the mailbox the sole
  invocation path for resident targets, so mailbox authority (P4) and
  transport settlement (P5, esp. DH-19) land first.
- **DH-32:** unbounded retry is *retained* for genuinely transient
  infrastructure failures (it converges when the dependency recovers — the
  no-clock doctrine applied); deterministic throws get classified into the
  P8 poison taxonomy instead. The asymmetry with the executor budget becomes
  explicit and documented, not accidental.
- **DH-31:** detached membership (§4.5), not leave-on-drain — membership
  persists, delivery pauses on a typed lifecycle fact, re-attach resumes.
- **P7 fast path:** committed — direct dispatch returns for mailbox-route
  targets as a claim-fenced, provably idempotent latency optimization.
- **DH-44:** the transport guarantees continuity — recovery-replay events are
  emitted to running iterators tagged `phase:"replay"`; consumers already
  filter by phase.
- **P2 single behaviors** (review: "resolve or reject" is not a spec): role
  selectors are **rejected at append** until a resolver exists;
  `settleMissingCall` **threads the real caller identity** through
  `submitMethodResult` (no `kind:"all"` fallback); handles are resolved to
  participant ids at the linked-vessel boundary.
- **All work lands on this branch** (`workspace-templates`), phase by phase.
- **P1 lands as seven separate commits**, one per fix, each with its own
  targeted test and independently revertible — the phase is a batch of
  independent point fixes, not one change (review point on P1's breadth
  accepted in this form: the fixes stay together as a phase, the *diff
  units* stay separate).

Phases are ordered by (a) dependency, (b) severity of what they close, (c)
blast radius — each phase is independently landable and testable in the
§6.0 order, and no phase changes semantics a later phase depends on
reversing.

**P0 — landed.** Audience fix on invocation outputs/terminals (DH-01) + its
projection/policy/protocol tests.

**P1 — convergence emergencies** (no schema, no fold changes; each fix is a
few lines with a targeted test):
DH-25 ack settlement totality; DH-26 per-event catch; DH-27 abort on
ingestion failure; DH-28 scheduled-resume idempotent no-op (**keyed on row
existence, not dueness** — verified constraint) + DH-51 settled-wake-row
deletion; DH-29 scoped materialize probe; DH-34 idempotency flag; DH-20
dedupe-after-processing.
*Files:* `rpc-client.ts`, `connection.ts`, `agent-loop-driver.ts`,
`agent-vessel.ts`, `calls.ts`. *Risk:* low; every change converts a
hang/loop into an existing well-tested path.

**P2 — audience totality** (protocol + builders + emitters; additive schema):
DH-02 `started` `to:[target]`; DH-03 `ui.feedback`; DH-04 `settleMissingCall`
(threads the real caller identity through `submitMethodResult` — decided,
§6.0); DH-05/06 linked `say` audience + handle→pid resolution; DH-07 role
selectors rejected at append until a resolver exists (decided, §6.0 — one
testable behavior per selector shape, per law 2.1); DH-08 required
`parentParticipantId`; DH-09 `kind:"all"` no longer overrides
self-suppression. Ships with the **builder-enumeration audience test** (§7).
*Risk:* low-medium; DH-09 is the only suppression-semantics change and needs
a projection version bump only if folded state depends on it (it does not —
`addresses()` is evaluated at derive time; bump anyway per discipline).

**P3 — declared route (Bug-2 minimal)** — depends on P2 (DH-02) and, per
§6.0, lands **after P4 and P5** so the route it makes sole is no longer
lossy:
DH-10/11 endpoint `invocation` declaration + classifier + both dispatch
sites; DH-13 durable-base guard (reject entity joins from DOs that cannot
register a resident session, typed error); DH-12 replace the dead
`redeliverPendingCallsTo` with the **mailbox-based pending-call start
redelivery on provider re-attach** (§4.1 — the bounded P7 slice that closes
the execution-after-ack window; the direct-dispatch version stays deleted).
*Files:* `rpc-client.ts` (join), `channel-do.ts` (classify), `calls.ts`,
`delivery-projection.ts` (re-attach re-derive), `types.ts`,
`durable-base.ts`. *Verification:* the headless onboarding run that exposed
the refusal; the matrix test {vessel, resident, session,
disconnected-session} × callMethod; and a kill-point test on the
ack→submit window followed by re-attach.

**P4 — mailbox authority** (fold changes ⇒ projection version bump; runs
**before P3** per §6.0): DH-14 boundary-aware fork reset; DH-15 revision
carry-forward vs retire split (§4.2); DH-16 durable redrive
backstop; DH-33 lag healing; DH-48 roster labeling; DH-18 decline→retryable
in the join window.
*Verification:* fork e2e (fork → converse → invocation on child), presence-
flap test (attach/detach linked bridge under queued rows), kill-point tests
on the carry-forward transition (rows survive a revision bump and deliver
under their historical stamp).

**P5 — transport settlement:** DH-19 process-before-ack; DH-39 authoritative
revisions; DH-44 replay emission to iterators; DH-45 monotonic seq +
generation fencing; DH-46 dual-key correlation; DH-47 staged recovery reset.
*Risk:* medium — this is the subtlest code in the client; each change lands
with a dedicated interleaving test (the audit's scenarios are the test
scripts).

**P6 — lifecycle closure:** DH-35 retire cancels children; DH-38 terminal
mirroring; DH-36 recovery identity; DH-37 `getBySourceEvent` all-matches;
DH-41 artifacts-ready promotion into waiting turns; DH-42 `alreadyIngested`
coverage; DH-43 sibling roster accuracy (+test correction); DH-31 detached membership
(§4.5); DH-22/23 crash-window closures; DH-49 transcript sort key.

**P7 — the provider lane** (the full §4.1 step two, including DH-40's
AbortSignal and DH-12's resurrected start redelivery). Enters only after
P1–P6 have soaked; it is the largest coherent change and everything before it
reduces what it must carry.

**P8 — permanence policy:** DH-30 poison classification (no legacy
back-stamp — pre-provenance events live only in reset-not-repaired
channels); DH-32 explicit infra-vs-permanent failure split on the vessel
lane; DH-24 real `alreadyApplied` for mutating tools (new commit-time
evidence, per verification); DH-21 resident at-least-once documentation. These need design notes of their
own (classification taxonomies are contract surface, not patches).

---

## 7. Verification doctrine — how this stays fixed

The incident's uncomfortable fact: unit tests, typechecks, and manual UI
inspection all passed while the system could not complete one eval from an
agent. Component tests exercised components; nothing owned the invariants.
The program above adds machinery so that each law is checked *as a law*:

1. **Audience totality test (with P2).** Enumerate every event builder in
   `channel-policies` and every direct `appendEvent`/publish site; for each
   event kind, assert its declared audience policy (explicit `to`, mentions,
   broadcast-by-design) against a registry in the test. A new event kind
   fails the test until its audience policy is declared. This turns law 2.1
   from review lore into CI.
2. **Route matrix test (with P3).** {vessel, resident entity, live session,
   disconnected durable session} × {callMethod, cancel, redrive} — asserting
   exactly-one execution, correct terminal, correct audience. *Honest
   coverage:* the matrix proves steady-state routing; restart, lease
   adoption, cancellation-lane, and revision-redelivery behavior are P7's
   harness, and the matrix gains those columns when P7 lands. Until then
   the Bug-2 *steady-state* class is what a red cell catches.
3. **At-least-once fuzz (with P4/P5).** A projection/delivery harness mode
   that delivers every mailbox row twice and replays every fold from its
   boundary after each transition, asserting identical terminal state (the
   projection is deterministic — exploit it). Kill-point tests extend the
   existing harness to every append→derive→ack window this plan names.
4. **Stall assertions + wedge detector (e2e, with P1).** Two layers, because
   (review-validated) the incident's log signature (`callMethod re-drive for
   settled call`) catches only its own class — DH-25/26/27/31/33-style
   stalls are *silent*. (a) End-of-run **durable-state assertions**: no
   ready/retrying mailbox rows above an attempt threshold, no unsettled
   outbox effects above a redrive count, no pending call whose terminal is
   already durable, no relationship retrying against an unregisterable
   recipient — counters, not clocks, read from the state-inspection paths
   the e2e harness already exposes. (b) The log-signature grep, kept for
   the redrive class it does catch. *Honest coverage (second review round):
   these gates observe durable debts and known signatures — they cannot see
   a detached in-memory iterator (DH-26), events buffered only in activation
   memory (DH-27), or a row still under its attempt threshold at run end.
   Those classes are covered instead by their P1 point fixes with dedicated
   interleaving tests, and by the scenario-level semantic validators, which
   assert the *outcome* (a final agent response) and therefore catch any
   stall on the exercised path regardless of mechanism. The gates make
   silent parking structurally hard on paths the suite exercises; they are
   necessary, not sufficient, and the doctrine says so rather than
   overclaiming.*
5. **Fold version discipline (review rule).** Any diff touching
   `delivery-projection.ts` fold semantics must bump the projection version;
   a test asserts the version constant changes when the fold's golden replay
   output changes.
6. **The invariant register (§2) as review checklist.** Every PR touching
   delivery, calls, subscriptions, or subagent lifecycle answers six
   questions in its description — one per law. The questions are cheap; the
   incident shows what their absence costs. A future rewrite of this system
   is welcome to change the laws — explicitly, in this document, not
   implicitly in a projection rule.

Soak signal: mailbox `terminal-retired` counts, failed-delivery retry counts,
and redrive counts are already durable facts — surface them in the existing
diagnostics (no new clocks, just counters) so a converging system is
observable as one.

---

## 8. Appendix

### 8.1 Verified-sound register (checked by the audit; do not re-derive)

- Fold determinism: strict cursor+1 advance, bounded replay fallback, poison
  relationship events skip-with-advance; duplicate folds no-op.
- Mailbox identity: GAD envelope id per event; `(event, participant,
  revision)` uniqueness; deterministic delivery ids; recipient admission
  journal with byte-compare; per-participant head-of-line ordering is
  structural.
- Claim lifecycle: generation+worker fencing on settle/fail; stale settles
  typed; no TTL-based lease authority anywhere (adoption-based release).
- Calls: terminal-first settle ordering; `startInFlight` barrier; duplicate
  settles converge on the durable terminal; publish idempotency converges
  across crash windows.
- Effect outbox: serialized per-channel `applyOutcome` with row re-fetch (no
  double settlement); terminal correlation keys have no reuse path; crash
  windows closed by reconcile + re-derivation (exceptions: DH-22/24).
- Subagent terminals: dual-publisher fencing via shared idempotency key;
  supervisors cannot author `completed`; child crash-after-complete
  converges; cancellation wake row precedes side effects; task projection
  freezes terminal states.
- Resident sessions: registration requires an active execution; drain runs on
  success/error/cancel; ALS restore targets the registering execution;
  delivery ack does not await method execution (cancellation is not
  head-of-line blocked); retired-recipient hardening in the durable-work
  driver is complete.
- The P0 audience fix is complete for the conversation-v1 builder surface
  (sole policy); `to` equals the roster participant id the projection
  compares.

### 8.2 Finding → phase index

Execution order: P0 → P1 → P2 → P4 → P5 → P3 → P6 → P7 → P8 (§6.0).
P1: 20 25 26 27 28 29 34 51 · P2: 02 03 04 05 06 07 08 09 · P3: 10 11 12 13 ·
P3 (perf): 53 · P4: 14 15 16 18 33 48 52 · P5: 19 39 44 45 46 47 · P6: 22 23 31 35 36 37 38
41 42 43 49 · P7: 12 40 (+§4.1 step two + fast path) · P8: 21 24 30 32 ·
fixed: 01 · accept: 17 50

**Verification pass (2026-08-10):** every finding scheduled in P1–P6 was
adversarially re-verified against the working tree by three independent
verifiers before implementation; each register row carries its verification
note. Net changes: DH-41 upgraded to deterministic; DH-36 and DH-09
downgraded to latent; DH-15's trigger frequency and DH-28's blocking scope
corrected; DH-39 narrowed to the revert-after-crashed-bump trigger; DH-51
added; the DH-15 re-key and DH-14 fork-reset repair designs were each
corrected once against code (details in §4.2); DH-24's repair was proven to
require new commit-time evidence. No finding was refuted outright.

### 8.3 Commit accounting

- 10cfb0379 (Jul 24): panel-affine `client_eval` onboarding — worked before
  the rewrite.
- **8f2a94936 (Aug 9): the rewrite.** Introduced the mailbox projection and
  with it DH-01/02/03/09, DH-10/11 (deleted the `participantIsAgentVessel`
  route discriminator), DH-13/14/15/16/18/19, DH-25/26/27/28, DH-29, and
  the lifecycle-ownership gaps (DH-31/35/38). It did **not** introduce
  DH-12 (dead since 76d261980, pre-rewrite — the rewrite's contribution was
  making mailbox delivery the leg that *needed* it) or DH-17 (spec-designed
  behavior, reclassified `accept`, listed here only for completeness of the
  original report's claims).
- cc9ac3894 (Aug 10): supervised-completion/settlement changes; introduced
  the DH-41 promotion gap and enshrined DH-43.
- 3fd71d79f (Aug 10): onboarding composition change; exposed, did not cause.
- Pre-existing, surfaced by the rewrite's new load: DH-12 (76d261980),
  DH-24 (427e61662), DH-44, DH-49.

---

## 9. Latency and performance pass (2026-08-10)

Motivated by an observed pattern: changes to this system tend to make it
slower, and agentic messaging is already sluggish. This section is built on
a measured map of the delivery mechanics (verified against working-tree
code, file:line in the findings), classifies every plan item by latency
effect, and adds the regression gate that turns "we got slower" from a vibe
into a failing test.

### 9.1 Measured mechanics (the baseline to protect)

The mailbox pump is **push-driven and timer-free in the happy path** — this
is worth protecting, because it means the sluggishness lives in the cliffs,
not the pipeline:

- Readiness hints piggyback on DO response headers
  (`X-Vibestudio-Work-Ready`, `durable/src/index.ts:1181-1222`); the host
  driver pumps on the same tick (`durableWorkDriver.ts:369-384, 464-534`),
  no debounce, no batch timer; backlog drains via in-process continuation
  hints. A mailbox delivery costs ~3 cross-process RPCs
  (claim/accept/settle) after publish; publish itself carries the GAD
  append + fold + per-recipient row inserts synchronously.
- Sessions keep the in-process live broadcast: 0 extra RPCs.
- Backoff constants: channel mailbox 1s base ×2 → 30s cap; vessel wake
  250ms base; vessel effects 500ms·2ⁿ → 30s; method-start redrive
  100ms → 5s; driver recovery scan 30s.
- Method calls: direct dispatch ≈ 4-5 RPCs; the full mailbox route ≈ 9-11
  RPCs plus two per-participant lane traversals — roughly double.
- **Cliffs** (ms → seconds degradations): (1) any transient failure on a
  claim/accept leg parks the delivery ≥1s and, via the head-of-line
  predicate (`channel-do.ts:886-903`), parks the participant's whole lane;
  (2) **resident receiver re-registration does not notify the channel** —
  retrying rows wait out their backoff, up to 30s *per event* at cap: the
  single biggest cliff for hibernation-first recipients; (3) worker
  generation change waits on the 30s recovery scan; (4) a persistently
  unacknowledged ready-edge spins the DO alarm at ~10/s (hidden cost of
  every poison-retry loop in the register); (5) the mailbox route's three
  DOs each add cold-start time.

### 9.2 Plan items classified by latency effect

**Wins** (most of P1/P4/P6 is latency repair, not just correctness):
DH-25/26/27 turn permanent client stalls into progress; DH-28+51 end a
retry loop *and* its ~10/s alarm spin; DH-29 removes minutes-long
per-participant lane stalls (the head-of-line cliff's worst trigger);
DH-15 carry-forward delivers backlogs that today are silently dropped
(re-discovery was infinite latency); DH-16 makes wedged callers converge
immediately off the durable terminal; DH-31 detach eliminates the
abandoned-relationship retry churn and its alarm load; DH-33 heals fold
lag without waiting for traffic; DH-38 removes the per-panel-load observer
connection storm (N historical subagent cards × WebSocket+replay each);
DH-41 turns an indefinitely parked child report into an immediate wake.

**Neutral:** P2 audience stamps (rows only for addressed-stance/self-call
targets — small, and each is a *wanted* wake); two-regime fork fold
(rebuild-time only); catalog rows (one insert per registration).

**Costs, quantified and mitigated:**
- **P3 mailbox-route invocations:** ~2× RPC count vs direct dispatch for
  resident targets. Context: the direct path for resident targets is
  *broken* today (spurious refusal + discarded result), so P3 trades
  broken-fast for correct-double-hop; panels (sessions) and vessels are
  untouched. Mitigation is DH-53 (below) + the P7 fast path, which
  restores the 4-5-RPC direct attempt under a claim fence for hot paths.
  Gate: the P3 matrix test records the call→execution span; budget set on
  first measurement, regression fails the gate.
- **DH-19 retry-during-replay:** each affected row eats the 1s first
  retry; replay windows are short and the population is rows arriving
  mid-join. Accepted; the alternative (holding the delivery RPC) inherits
  DH-25's wedge class and pins the lane longer.

### 9.3 New findings from this pass

| id | where | finding | phase |
|---|---|---|---|
| DH-52 | `delivery-projection.ts`, `channel-do.ts` | **Implemented:** agentic context is normalized into one `channel_delivery_event_context` row per event and joined only when a direct recipient is claimed. Recipient mailbox rows no longer copy the O(active members) payload, mailbox-route recipients receive `null`, and projection version 11 forces a canonical rebuild. A 12-recipient structural regression test asserts twelve mailbox rows, one context row, and zero per-recipient context copies. | P4 |
| DH-53 | `channel-do.ts:1099-1140` + join path | **Re-attach doesn't accelerate retries** (cliff 2): when a resident receiver re-registers / a member re-attaches or rejoins, its retrying rows keep waiting out backoff — up to 30s per event. Fix: the re-attach/rejoin/registration lifecycle event resets the member's retrying rows to `next_attempt_at = now` and re-marks readiness, so the response-header hint drives immediate delivery. This is lifecycle-driven re-arming, not a shorter timer — fully inside the no-clock doctrine, and it makes §4.5's re-attach a latency *win* over today's behavior. | P3 (with the route work) |

Also recorded: a diagnostics counter for unacknowledged ready-edge alarm
spins (cliff 4), so the next poison loop is visible as load, not just log
noise.

### 9.4 Latency regression gate (extends §7)

Instrument three spans as durable diagnostics counters/histograms (no new
clocks in *authority* — measurement is not authority): publish → recipient
execution; `callMethod` → provider execution; `submitMethodResult` →
caller settlement. The e2e harness records them per run and fails on
regression beyond budget against a checked-in baseline; budgets are
calibrated from the first measured run, not invented. Every phase that
touches the delivery path updates the baseline deliberately in its PR —
a silent regression becomes a red gate, which is the structural answer to
"changes tend to make us slower."

### 9.5 What this pass deliberately does not do

No speculative caching, no batching layers, no parallel-lane redesign of
the ordered mailbox: the measured happy path is already push-driven and
lean, and the sluggishness evidence points at the cliffs and the O(N²)
write pattern, all addressed above. If the gates later show the steady
state itself is too slow, the next lever is the P7 fast path's scope —
widen it — not new machinery.
