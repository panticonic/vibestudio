# Panel Boot Lifecycle Redesign

Status: proposed
Date: 2026-08-07
Supersedes: the incremental "panel attempt hardening" draft (reviewed in §2)
Related: docs/agentic-hot-path-work-dispatch-plan.md (redrive invariants),
docs/agentic-messaging-latency-refactor-spec.md

We have no attachment to the current architecture and no compatibility
requirement. The goal is one clean set of abstractions for panel boot: a single
canonical lifecycle object, one owner per fact, and waits that are resolved by
lifecycle events rather than clocks.

---

## 1. What the code actually does today (evidence)

The findings below are from the current working tree (which already contains
the single-readiness-publication change) and drive every design decision in §3.

### 1.1 There is no state machine and no attempt concept

`src/server/panelRuntimeCoordinator.ts` holds three parallel maps
(`leases`, `clients`, `reportedViews`) plus two side-sets. There is no phase
enum, no transition validation beyond exact-`connectionId` compare-and-set, and
no monotonic guard — a stale renderer that still holds the right connectionId
can publish anything.

"Attempt identity" exists only as a **client-side string**:
`panelAttemptId(runtimeEntityId, buildKey)` →
`"${entity ?? "unassigned"}@${buildKey ?? "unbuilt"}"`
(`packages/shared/src/panel/observation.ts:242`). The coordinator never sees or
validates it. The de-facto attempt token is `connectionId`, minted in five
different places with five different prefixes (`adopted-cdp-`, `default-cdp-`,
`replacement-cdp-`, `takeover-`, host-supplied).

Replacement/supersession is five hand-rolled paths:
`replaceRuntimeEntityForSlot`, `advanceResidentSlotEntity`,
`replaceFailedCdpLease`, `replaceUnavailableCdpLease`, `takeOver`
(coordinator L507–927), each with its own cloning, event, and close-code
behavior, plus an ad-hoc vocabulary of WebSocket close codes (4091/4093/4094/ 4095) acting as transition reasons.

### 1.2 There are three independent notions of readiness, not two

1. **Boot handshake** — `PanelBootObservation.phase`
   (`loading | booting | ready | failed`), produced by the loader and now
   (working tree) terminally by the generated entry via
   `__vibestudioPanelMarkReady`, transported both by renderer push
   (`createRuntime.ts:60`) and by host CDP probe
   (`PANEL_PAGE_OBSERVATION_EXPRESSION`). Inspection separately reports
   `observed | unavailable`; probe availability is not a boot lifecycle phase.
2. **Desktop host-local readiness** — `src/main/panelReadiness.ts`:
   `isPanelContentReady` checks lease/artifacts/native-slot/`view.isLoading`
   and **never reads the boot phase**. Its only production consumer is
   `src/main/testApi.ts` — it is a test-diagnostic predicate, not a live
   lifecycle gate — but it is still a second _definition_ of ready that e2e
   assertions rely on, so it must be replaced, not left to drift.
3. **Browser-panel bypass** — `panelRuntime.ts:438` forces phase to `"ready"`
   for `browser:` sources when the document URL matches, bypassing the
   handshake entirely (correctly — those panels don't run the bootstrap — but
   as an inline special case in userland rather than an ownership rule).

### 1.3 Boot state and transport state are conflated

Two orthogonal facts — "did this attempt boot?" and "can I reach it right
now?" — are collapsed into one observation:

- During the 3-second reconnect grace, the coordinator **deletes** the reported
  view (L738–740), so a fully-ready panel reads as having no observation across
  any transport blip.
- `panelRuntimeService.observationSnapshot` (L22–34) vetoes the observation to
  `null` whenever `isRuntimeRouteReachable` is false.

Both are workarounds for the same modeling error: boot phase is an attempt
fact and should be durable; route reachability is a transport fact and should
fluctuate freely without erasing it.

### 1.4 Waiting is slot-versioned, lossy, and does an extra round trip

- The coordinator bumps one per-slot counter for **both** lease changes and
  observation changes, so waiters can't tell what woke them.
- `panelRuntimeService.awaitSlotChange` returns the whole snapshot, but
  userland `waitUntilReady` (`panelRuntime.ts:528`) ignores it and re-calls
  `observePanel()` after every wake — the extra round trip the draft noticed.
- The observation version is smuggled through a
  `WeakMap<PanelObservation, version>` (`observationVersions`, L246); an
  observation that didn't come from `observePanel` throws.
- `awaitSlotChange` itself calls `refreshHostSnapshot` first, which can bump
  the very version being waited on, so the loop frequently wakes immediately
  and spins one extra full cycle.
- The userland phase enum has 8 values; `resolving`, `building`, and `stopped`
  are produced **nowhere**, yet `waitUntilReady` has a live branch for
  `stopped`.

### 1.5 The declared failure code has no producer

`runtime_handshake_timeout` exists in `PanelFailureCode`
(`observation.ts:30`) and `PanelFailureCodeSchema` (`panelContracts.ts:89`) and
is produced by **zero** call sites. There is no supervision of a renderer that
loads its bundle and then neither reports ready nor throws — that attempt hangs
forever, and so does any eval awaiting it (`awaitSlotChange` has no deadline;
`PanelWaitOptions` carries only an `AbortSignal`).

### 1.6 The build cache will serve protocol-incompatible bundles

The working-tree change moved the only `ready` publication into the generated
entry (`builder.ts:1496`, appending `__vibestudioPanelMarkReady?.()`) and
removed `bundle.onload` from the loader. But:

- `BUILD_CACHE_VERSION` is still `"27"` (`effectiveVersion.ts:232`).
- The generated wrapper text is **not** an input to `computeBuildKey`
  (`effectiveVersion.ts:491`) — only source content and root dep files are.

So any panel with unchanged sources keeps its old build key and is served a
cached bundle that never calls the readiness hook, while the (dynamically
served, `no-store`) loader no longer has `bundle.onload`. Every such panel
stalls at `booting` forever. This is a live bug in the working tree, not a
hypothetical.

### 1.7 The eval redrive is sound; the observability gap is real but small

The ~60s parked-row redrive (`agent-loop-driver.ts:1539`) is the delivery-loss
backstop for deferred evals. Re-execution is triple-guarded: the monotonic
`deferredEvalStarted` descriptor flag (`agent-vessel.ts:4420`), EvalDO's
`runId` idempotency + input-digest drift rejection (`EvalDO.ts:1090`), and
in-flight promise sharing (`EvalDO.ts:1317`). Recovery uses only `eval.get`.
docs/agentic-hot-path-work-dispatch-plan.md already states the invariant that
no successful path waits for the redrive and that it must be "observably
unused on healthy traces." What's missing is purely observability: the
hot-path trace's `effect.claimed` row carries only an opaque `trigger` string —
nothing distinguishes a backstop dispatch from a first dispatch, and there are
no counters anywhere in the eval path.

The external-wait idea has an exact plug-in point that already exists: the
eval execution-context `call()` wrapper (`EvalDO.ts:693–734`) already writes an
`{stage:"outbound-rpc", state:"waiting", targetId, method}` checkpoint and
pauses the liveness lease for the duration of `panelRuntime.awaitSlotChange`.
The wait is already unbounded-but-observable; it's just not _semantically_
observable.

---

## 2. Review of the draft plan

| Draft phase                                        | Verdict                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — cache epoch bump, single publication           | **Keep, extend**                   | Correct and urgent (§1.6). Extended: fold a wrapper-protocol fingerprint into the build key so this class of bug is structurally impossible, not just fixed once (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1 — formalize boot protocol, coordinator validates | **Replace with a rewrite**         | The draft assumes there is a state machine to harden. There isn't (§1.1). With no compatibility constraint, adding validation to three maps and five replacement paths is patching the wrong shape; §3 replaces the coordinator's model with an attempt store. The draft's boot-record schema and ownership table survive almost intact — they become the store's write API.                                                                                                                                                                                                                                                                                                                                                 |
| 2 — `awaitAttemptChange`                           | **Keep, strengthen**               | The evidence (§1.4) supports it fully. Strengthened: the attempt ID becomes server-minted and returned from the navigation commit, killing the client-computed `entity@buildKey` string and the WeakMap version stash, not just the extra round trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3 — bootstrap lease                                | **Reshape**                        | A renewal lease is a clock dressed as a protocol, and this codebase's standing principle is that pending states resolve by lifecycle events, not TTLs. Most of what the lease would catch is already evented (route loss, CDP detach, `bundle.onerror`, `error`/`unhandledrejection`, build failure). One genuine gap remains — a bundle that evaluates forever without reporting or throwing — and closing it needs _some_ notion of "no progress." §3.6 closes it with a probe-anchored stall detector on the existing pull path (counted observation rounds with no revision advance) rather than a free-running wall-clock lease. This is the narrow, UX-justified exception, scoped to the loading/booting window only. |
| 4 — semantic external waits                        | **Keep, relocate the declaration** | Right idea, and the plug-in point already exists (§1.7). Improvement: declare the wait semantics **in the method schema** (service-schemas) rather than having callers or the eval wrapper special-case method names — making it a property of the contract, not of one client.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5 — redrive observability only                     | **Keep, thin**                     | The architecture verdict is confirmed by evidence: parked-row + get-only recovery is more crash-resilient than any leased cross-DO wait. Scope this phase to labeling and counters; the "observably unused" invariant already lives in the hot-path dispatch plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| (absent) — boot/transport split                    | **Add**                            | The draft says push and probe must share one canonical record but misses that the record itself conflates two axes (§1.3). Splitting boot phase from route reachability deletes the reconnect-grace observation-hiding and the route veto — two standing sources of "ready panel reads as dead."                                                                                                                                                                                                                                                                                                                                                                                                                             |
| (absent) — unify readiness notion #2 and #3        | **Add**                            | The draft names two notions of readiness; there are three (§1.2). Desktop `panelReadiness.ts` and the browser-panel bypass must be absorbed, or the "same canonical boot record" invariant is false on day one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 3. Target architecture

### 3.1 The attempt is the unit; the coordinator owns it

A **PanelAttempt** is one materialization of one runtime entity into one slot.
It is minted **server-side by the coordinator** at the moment a slot commits to
an entity (navigation commit / `ensureSlot`), with an opaque id:

```ts
interface PanelAttempt {
  attemptId: AttemptId; // opaque, coordinator-minted (uuid)
  epoch: string; // coordinator process epoch (see restart, below)
  slotId: PanelSlotId;
  runtimeEntityId: PanelEntityId;
  buildKey?: string; // attribute, set when the build resolves
  effectiveVersion?: string;
  hostConnectionId?: string; // attribute, set when a route is assigned
  phase: AttemptPhase;
  revision: number; // per-attempt, coordinator-assigned, monotonic
  failure?: AttemptFailure; // present iff phase === "failed"
  stopReason?: StopReason; // present iff phase === "stopped"
  reporter: Reporter; // who produced the current phase
  updatedAt: number; // diagnostics only, never ordering
}
```

The draft's `{slotId, runtimeEntityId, buildKey}` triple becomes **attributes
of** the attempt, not its identity. Identity-by-attributes was the source of
the `"unassigned@unbuilt"` placeholder strings: `buildKey` isn't known at
attempt creation, so any identity that includes it is either late or fake.

`connectionId` is demoted to a transport detail inside route state (§3.4).
Crucially, **renderer-side reports carry no attempt id at all**: the
coordinator attributes an inbound renderer report to the attempt currently
bound to the route it arrived on (and a host probe relay to the attempt bound
to the probed target — §3.3). Attempt ids appear only in the server-side API,
for waiters and supervisors. This is what actually makes supersession safe —
a superseded attempt's route binding is severed at `commitAttempt`, so its
late reports have no attribution and are rejected — and it removes any need
for the renderer to know, persist, or be trusted about its own identity.

**Persistence and restart.** The attempt store is deliberately in-memory. Two
facts constrain the design here. First, renderers can _outlive_ a server
restart: the desktop CDP provider explicitly reconnects and re-registers its
live `WebContents` targets after broker loss
(`cdpHostProvider.ts` `socket.on("close")` → `scheduleReconnect` →
`registerAllTargets`, with a test asserting exactly this), so a restart
erases attempt state while referenced renderers may be alive and healthy — a
synthesized "host-lost" would be a lie. Second, guest code does not resume
mid-body across a runtime restart: an eval blocked in `awaitAttempt` when the
runtime goes away is terminated by whichever of the **three existing
lifecycle paths** applies — graceful server shutdown dispatches `cancel` to
every active run (`evalService.shutdown`), planned runtime replacement stamps
`runtime_generation_lost` (`markRunGenerationLost`), and only an unplanned
crash falls to the orphan reconcile's `eval_runtime_restarted` ("we never
auto-re-run"). The deferred-eval redrive only recovers _results_ via
`eval.get`; it never replays an interrupted guest RPC. This design adds no
fourth path and changes none of the three: in every case there is no
"redriven wait" to resolve; in-flight waits die with their callers, typed per
how the runtime went down.

What remains to specify is the treatment of _new_ calls carrying stale
references. Attempt references in the server-side API are
`AttemptRef = {epoch, attemptId}` (`epoch` is the coordinator's existing
process-lifetime `randomUUID()`, carried on every `PanelAttempt` record). A
call with a foreign-epoch or unknown ref gets a typed answer, not a
synthesized record — the coordinator cannot fabricate a `PanelAttempt` for an
attempt whose slot and entity it never knew:

```ts
type AwaitAttemptResult =
  | { kind: "report"; attempt: PanelAttempt }
  | { kind: "unknown-attempt"; ref: AttemptRef }; // immediate, terminal answer
```

What callers do with `unknown-attempt` is caller policy, per the §3.6
contract that an attempt waiter is never silently switched: `rebuild()` and
other exact-attempt waiters fail with a typed infrastructure error (the
attempt's outcome is unknowable — mirroring `eval_runtime_restarted`, not
pretending the replacement is the same operation); slot-level consumers were
using `awaitSlot` anyway and simply see the post-restart world. Live
renderers that re-register after a restart are re-adopted: the coordinator
mints fresh attempts for them (today's `adopted-cdp-` path, now
`commitAttempt`), and the host's probe relay (§3.3) republishes each
renderer's boot record — which the renderer still holds in
`__vibestudioPanelBoot` — onto the new attempt, so an alive-and-ready panel
reads as ready again without rebooting.

### 3.2 Phases: one monotonic order, two kinds of terminal

```
pending → loading → booting → ready → stopped
      └────┴─────────┴──── failed (terminal)
```

- Total order `pending < loading < booting < ready < stopped`.
  Every accepted transition strictly advances; the coordinator rejects
  regressions, unknown attempts, and any write after `failed` or `stopped`.
- `failed` is terminal and reachable from any phase before `stopped`.
- **Build state is not an attempt phase.** A build is keyed by `buildKey` and
  shared — cached across attempts, slots, and panels — and its ordering
  relative to the slot commit **differs by creation path**: panel creation
  reserves the entity, commits the slot, and only then activates the sealed
  execution (`runtime.activateReservedEntity` runs after
  `workspace-state.slot.create`), while navigation prepares the entity before
  its commit. There is no single point in either flow where "the attempt's
  build phase" could be uniformly reported — the build may start before the
  attempt exists or after. That variance is precisely why build belongs on
  its own axis. The join key is the **slot**, not the buildKey: the server
  materialization path knows which build it is preparing or waiting on for a
  given slot at every moment — including the creation path's post-commit
  interval, when the attempt exists but its `buildKey` attribute is not yet
  resolved — so it supplies the composite observation's
  `build: {state, buildKey?}` field directly. The attempt's `buildKey`
  attribute is stamped once known, for identity and diagnostics, never as the
  join mechanism. The UI derives "building" display state from the axis. A
  terminally failed build fails an
  attempt via one rule that is path-independent: the server materialization
  path reports `failed{stage:"build"}` on the slot's current attempt when it
  cannot proceed because the build that attempt depends on is terminally
  failed.
- `ready` is **boot-terminal**: it means the generated entry evaluated and the
  framework mount returned — nothing about application data. No later report
  can move a ready attempt anywhere except `stopped`.
- `stopped` is **attempt-final** with a typed reason:
  `superseded | retired | unloaded | host-lost`. It absorbs the current 4091/
  4093/4094/4095 close-code vocabulary and the post-ready renderer-crash case
  (route loss on a ready attempt → the coordinator stops it with `host-lost`).

This gives `stopped` its first producer ever. `resolving` and `building` are
deleted from the phase vocabulary — metadata resolution belongs to navigation
preparation, and build state surfaces on its own axis (above) precisely
because its timing relative to attempt creation varies by path. `unavailable`
is deleted from the boot vocabulary entirely; "I couldn't observe" is a probe
outcome (§3.4), not a phase.

### 3.3 One boot record, one owner per fact

All producers write the same schema-validated record through one coordinator
entry point; push (renderer RPC) and pull (host CDP probe) are transports for
the same record, never separate truths. For that sentence to be honest, the
table below must distinguish **fact origin** from **delivery principal**: the
renderer-owned rows (`loading`/`booting`/`ready`) originate inside the
document, but they reach the coordinator over two principals — the renderer's
own route, or the presentation host _relaying_ what the probe expression read
out of `__vibestudioPanelBoot`. The coordinator therefore accepts
renderer-originated phases from either the bound renderer route or a host
relay for the bound target, attributing both to the same attempt (§3.1 route
binding); the host may _originate_ only its own rows. Without the relay rule,
a lost renderer push would strand the canonical record behind what the probe
can plainly see — the exact split-brain this design exists to remove.

| Fact                                                            | Owner                           | Notes                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`                                                       | coordinator                     | at attempt mint                                                                                                                                  |
| `failed{stage:"build"}`                                         | server materialization path     | when the attempt's build (a shared per-buildKey fact, §3.2) fails terminally                                                                     |
| `loading`, `booting`, `failed{stage:"bundle-load" \| "config"}` | loader (`panelBootstrapScript`) | unchanged from today's emission sites                                                                                                            |
| `ready` (managed panels)                                        | generated entry                 | sole producer: `__vibestudioPanelMarkReady`                                                                                                      |
| `ready` (`browser:` panels)                                     | presentation host               | document-ready + URL match; the host is the legitimate owner because these panels run no bootstrap — this replaces the userland bypass (§1.2 #3) |
| `failed{stage:"navigation" \| "renderer-crash"}`                | presentation host               |                                                                                                                                                  |
| `failed{stage:"boot-stall"}`                                    | coordinator                     | via §3.6 supervision                                                                                                                             |
| `stopped{*}`                                                    | coordinator                     | only the coordinator ends attempts                                                                                                               |

`AttemptFailure` is structured: `{stage, code, message?, stack?}` with `code`
drawn from a pruned `PanelFailureCode` union — `runtime_handshake_timeout` is
renamed to `boot_stalled` (it finally gets a producer; the old name described
a mechanism we are not building) and unused codes (`parent_resolution_timeout`)
are deleted.

Validation lives in the coordinator only: attempt exists; reporter is
authorized for that phase per the table; phase strictly advances; attempt not
terminal. Rejected reports are logged with the full record (they are the
primary race diagnostic), never thrown back to the renderer.

**Honesty note on reporter authorization.** The coordinator can distinguish
_principals_ — build pipeline, presentation host, and coordinator are
server-side; the renderer is one principal per connection. It cannot
distinguish loader from generated entry from user panel code: they execute in
the same document under the same panel-runtime principal and arrive over the
same route, and user code can call `__vibestudioPanelMarkReady` directly. The
loader/entry rows of the table are therefore a **protocol convention within
the renderer principal**, enforced by codegen and monotonicity — not a server
authorization boundary. That is acceptable here: this is a trusted
environment, the panel is the user's own code, and a panel that self-reports
`ready` early merely mislabels its own boot (exactly as it could today). The
invariants that matter — a _superseded_ or _foreign_ attempt cannot publish,
and no phase regresses — are enforced at the principal/attempt level, which
the server can verify.

Desktop `src/main/panelReadiness.ts` is **deleted as an independent
predicate**. Its legitimate inputs (native slot bound, artifacts present)
become host-side _gates for when the host reports_ — they stop being a second
definition of ready. Anything in it that gated UI chrome reads the canonical
attempt record instead.

### 3.4 Boot state and route state are orthogonal

The coordinator exposes a composite observation:

```ts
interface SlotObservation {
  attempt: PanelAttempt | null; // current attempt for the slot
  route: { reachable: boolean; connectionId?: string };
  build?: { state: "building" | "ready" | "failed"; buildKey?: string };
  //        supplied by the materialization path per slot (§3.2) —
  //        buildKey may be unresolved while state is "building"
  version: SlotVersion; // {epoch, counter} — slot-current waiters
}
```

- Boot phase is durable per attempt. A transport blip flips
  `route.reachable`; it never erases or hides the boot record. The
  reconnect-grace observation deletion (coordinator L738) and the
  route-reachability veto (`panelRuntimeService.ts:22`) are both deleted —
  their entire purpose was to prevent a stale `ready` from leaking through a
  conflated observation, which the split makes structurally impossible.
- Consumers pick the axis they mean: `waitUntilReady` resolves on
  `phase === "ready"`; the agent-invoke path requires `ready && reachable`
  and keeps its existing exactly-once replacement handling for route loss.
- Reconnect grace survives as a _route_ policy (how long the coordinator
  waits before declaring `host-lost` and stopping the attempt) — resolved by
  the host's own disconnect/reconnect lifecycle events, as today.

### 3.5 Supersession is one operation

```ts
commitAttempt(slotId, {runtimeEntityId, host}): PanelAttempt
```

Atomically: the slot's current attempt, **if non-terminal**, transitions to
`stopped{superseded}` and its connection closes; an attempt already in
`failed` or `stopped` keeps its terminal record and is merely detached — the
slot's current-attempt pointer moves, the record is immutable history. A new
attempt is minted in `pending` and returned. (Boot outcome and slot residency
are distinct facts: terminality freezes the former; supersession only changes
the latter.)

**Retention.** Immutable history cannot mean unbounded history in an
in-memory store — a rebuild-heavy long-running session would otherwise
accumulate terminal records and their diagnostics for the process lifetime.
The coordinator keeps, per slot, the current attempt plus a small fixed ring
of the most recent terminal attempts (enough for late waiters and the
diagnostics window); older records are evicted. Eviction needs no new
semantics: a ref to an evicted attempt resolves through the exact same typed
`unknown-attempt` path as a post-restart ref (§3.1) — callers already handle
it, by construction. All five current replacement paths become policy-level
callers of this one primitive:

- navigation / `rebuild()` → `commitAttempt` with the new entity;
- failed-lease recovery ("one clean recovery attempt") → `commitAttempt` with
  the same entity on a fresh host;
- host-unavailable reassignment → same;
- `takeOver` → `commitAttempt` with an explicit host;
- `retireEntity` / `unloadSlot` → `stopAttempt(attemptId, reason)` with no
  successor.

A superseded attempt cannot publish into its replacement by construction: its
route binding is severed at supersession, so its late reports have no
attribution (§3.1). The
`writeLease`-preserves-observation-iff-same-connection subtlety, the
re-announcement race-closer, and the five connectionId prefixes all dissolve.
The WebSocket close codes do **not** disappear — peers still need concrete
codes on the wire — but the ad-hoc vocabulary is replaced by one central
mapping from typed `StopReason` to close code, applied where the connection is
closed, instead of five call sites choosing codes independently.

The navigation commit **returns the attempt** (threaded through
`ensureSlot` → userland), so callers wait on the exact attempt they created —
no client-side identity computation.

### 3.6 Waiting: attempt-scoped, snapshot-returning, event-resolved

Two primitives, replacing `awaitSlotChange` + the re-observe loop:

```ts
getAttempt(ref: AttemptRef): AwaitAttemptResult                    // snapshot
awaitAttempt(ref: AttemptRef, afterRevision, signal): Promise<AwaitAttemptResult>
awaitSlot(slotId, afterVersion, signal): Promise<SlotObservation>
```

(`AttemptRef` and the `AwaitAttemptResult` union are defined in §3.1; an
unknown or foreign-epoch ref resolves immediately with `unknown-attempt`.)
`getAttempt` is the non-blocking read that makes attempt refs resolvable by
consumers that hold only a ref — the attempt record carries its `slotId`, so
ref → `getAttempt` → `slotId` → `awaitSlot`/observe is the declared join path
the external-wait UI uses (§3.8).

- `awaitAttempt` wakes only when _that attempt's_ revision advances — boot
  phase transitions, never route or build churn — and returns the resulting
  record directly, no follow-up `observePanel`. If the attempt was superseded,
  the caller receives its `stopped{superseded}` record and can decide whether
  to follow the slot; it is never silently switched to a different runtime.
- `awaitSlot` serves slot-current consumers (UI chrome, the invoke path) and
  wakes on any change to the composite observation — attempt transitions,
  `route.reachable` flips, build-state changes, supersession. The two
  primitives deliberately have different wake surfaces: route flapping wakes
  slot waiters (who render it) and never attempt waiters (who await boot).
- Both preserve `signal` cancellation exactly as today (the existing
  `ctx.signal` wiring in `panelRuntimeService` is correct; keep it).
- Every waiter eventually resolves because every attempt eventually reaches
  `ready`, `failed`, or `stopped`: terminal-by-event where events exist, and
  by the stall detector below for the one gap that has none.
- Userland `waitUntilReady` becomes a thin loop over `awaitAttempt` using the
  attempt returned from the navigation commit. The
  `WeakMap<PanelObservation, version>` stash, `panelAttemptId()`, and the
  refresh-races-the-wait behavior are deleted.

**Stall detection (the one clock-shaped thing, and why).** Events cover every
failure mode except a bundle that evaluates without ever reporting ready or
throwing. Per the project's UX-over-purity rule: an eval or user waiting
forever on a wedged boot is worse than the impurity of detecting it.

The detector must be **coordinator-driven, not observer-driven**. Today's
probes fire on demand (`refreshHostSnapshot` runs inside every
`observeSlot`/`awaitSlotChange` call), and §3.6's `awaitAttempt` deliberately
removes that re-observe loop — so if probing stayed demand-driven, an attempt
with parked waiters would never be probed again, an unwatched panel would
never fail, and N would be reached at a rate proportional to how many
observers happened to be polling. Instead: the coordinator itself owns one
supervision schedule per **non-terminal attempt**, stopped on any terminal
transition. Observer calls never feed it, so the outcome is deterministic
regardless of how many waiters exist — zero or many. It covers both
non-terminal regions:

- **`loading`/`booting`** (route assigned): the coordinator asks the host to
  run the existing observation expression at a fixed cadence and keeps **one
  counter: consecutive probe rounds without an observed revision advance**.
  Every round counts — whether the probe returned a valid-but-unchanged
  observation or no observation at all — and only an actual revision advance
  resets it. (Two counters keyed to _consecutive_ valid vs. _consecutive_
  unobservable rounds would let a wedged renderer alternating between the two
  outcomes reset both forever.) At the threshold the coordinator publishes
  `failed{stage:"boot-stall", code:"boot_stalled"}` with a `detail`
  describing the probe mix (`"no-progress"` when rounds were mostly valid,
  `"unobservable"` when the renderer wasn't answering — the CDP provider maps
  evaluation timeout to unobservable, so a blocked event loop lands here),
  carrying the last boot record and last host observation.
- **`pending`** (pre-route: activation, build, materialization): the same
  schedule is anchored to server-side progress facts — build-state
  transitions and materialization steps for the slot reset the counter. A
  build or materialization operation that never settles therefore produces
  `failed{stage:"materialization", code:"boot_stalled"}` rather than an
  attempt parked in `pending` forever. Without this region the terminality
  guarantee would be false for every attempt that never reaches a route.

No progress-renewal lease, no deadline around `rebuild()` or the surrounding
eval; route loss during the window is handled by the `host-lost` path, not
the detector. Whatever the failure mode — silent no-progress, a blocked event
loop that answers no probe, a hung build — the attempt reaches a terminal
state; terminality does not depend on the renderer's event loop or the build
pipeline being polite. Yes, "fixed cadence × threshold" is time-shaped; the
honest framing is that this is the sanctioned narrow exception (same category
as SA1), scoped to non-terminal attempts under active supervision, and it
produces a typed failure with full diagnostics rather than a silent hang.

### 3.7 Builds carry a protocol fingerprint

`computeBuildKey` gains a new input: a fingerprint of the generated-wrapper
protocol. Derivation matters — hashing a hand-maintained list of "template
constants" is not structurally safe, because generator logic can change
without the list changing. Instead the fingerprint is computed by **running
the actual generators against canonical fixture inputs** — covering every
generation branch, not one: for each adapter,
`generatePanelEntry(FIXTURE_EXPOSE, FIXTURE_ENTRY, adapter, module)` is
evaluated **both with an explicit fixture module and with the argument
absent**. The absent branch is the one ordinary panels actually get — React
and Svelte substitute their default framework-module constants
(`frameworkModule ?? REACT_FRAMEWORK_ENTRY_MODULE`), so a fixture that always
passes a module would silently miss changes to those defaults. The
concatenated outputs of all variants are hashed, together
with an explicit `PANEL_ENTRY_PROTOCOL_VERSION` constant co-located with the
loader for the loader↔entry contract side (the loader is served dynamically,
so its text can't be hashed into build keys, but its protocol version can).
Any change to wrapper codegen changes the hash by construction.
`BUILD_CACHE_VERSION` remains the manual big hammer for everything else. A
build-level regression test asserts that changing wrapper output changes
every build key.

### 3.8 External-wait semantics are declared in the contract

Method schemas in `packages/service-schemas` gain an optional wait
declaration:

```ts
progressSemantics: {
  kind: "external-wait",
  operation: "panel.boot",          // stable operation vocabulary
  resource: { arg: 0, kind: "panel-attempt" },  // which arg, and what it names
}
```

The EvalDO execution-context `call()` wrapper (which already writes the
`outbound-rpc` checkpoint and pauses the liveness lease) reads the annotation
and enriches its checkpoint to:

```ts
{ stage: "external-wait", operation: "panel.boot",
  resourceId, targetId, method }
```

and `getRun` surfaces `activity: {kind: "external-wait", ...}` while liveness
is suspended. Scope honestly: the checkpoint carries only **static,
call-time** metadata — operation, resource id (extracted from the call args
per the annotation), target, method. It does not track the panel's live phase
or route reachability while the RPC is pending; EvalDO has no channel for
that, and inventing a server→EvalDO progress push for it would be a second
readiness transport, which this design exists to eliminate. Consumers that
want the live picture (the UI rendering "Waiting for Kanban Board — runtime
connected, boot phase: booting") join the checkpoint's resource — an attempt
ref, which the coordinator resolves to its slot — against the canonical slot
observation, which they can already read. Because the
declaration lives on the method schema, this is a general RPC facility: any
future long-wait method (authority decisions already behave this way ad hoc)
opts in by annotation, with zero eval-side special-casing.

### 3.9 The redrive stays; it gets labels

Confirmed keep (§1.7). Changes, all observability:

- `effect.claimed` hot-path-trace rows gain an explicit
  `source: "redrive-backstop"` when the dispatch came from the parked-row
  alarm, vs the push/nudge sources — making the dispatch-plan invariant
  ("observably unused on healthy traces") checkable from the trace alone.
- Counters (in the same trace/debug-snapshot surface, no new metrics stack):
  deferred-eval completions by direct push vs backstop poll.
- The repetitive `eval.get backstop … failed (run parked; …)` warnings
  coalesce per runId.
- Cadence stays at 60s unless the new counters show real cost.

---

## 4. Implementation scope — one cutover

This lands as **one change**: the whole target architecture of §3, no
compatibility branches, no staged landings, no throwaway adapters bridging
old and new shapes. Half-migrated states are where this subsystem's current
pathologies came from (two readiness notions, declared-but-unproduced codes,
client-side identity), and an incremental landing would manufacture more of
them. The old model is deleted, not deprecated.

The full scope of the cutover:

**Build.** Bump `BUILD_CACHE_VERSION` to `"28"` (annotation: readiness
publication moved into the generated entry). Add the wrapper-protocol
fingerprint to `computeBuildKey` (§3.7 — all generator branches) with its
regression test. Keep the working tree's single-publication tests.

**Coordinator.** `PanelAttempt`, `AttemptPhase`, `AttemptFailure`, the report
schema; attempt store keyed by `attemptId` with per-attempt revisions and
per-slot terminal-history ring (§3.5); `commitAttempt`/`stopAttempt`/
`reportAttemptPhase` with transition validation and route-binding attribution
(§3.1/§3.3); the supervision schedule over both non-terminal regions (§3.6);
the central `StopReason`→close-code mapping. Deleted outright: the five
replacement paths, the ad-hoc close-code call sites, `reportedViews`,
`samePageObservation`, the reconnect-grace observation deletion, the
route-reachability veto.

**Service and userland.** `getAttempt`/`awaitAttempt`/`awaitSlot` in
`panelRuntimeService` with service-schemas updated (including the
`progressSemantics` annotation on `awaitAttempt`); navigation commit returns
the attempt through `ensureSlot`; `panelRuntime.ts` rewritten —
`observePanel` reads the composite observation, `waitUntilReady` rides
`awaitAttempt`, `rebuild()` waits on its own committed attempt and surfaces
`unknown-attempt` as a typed infrastructure failure, invoke path checks
`ready && reachable`. Deleted: `panelAttemptId`, the WeakMap version stash,
the dead phase values, the pruned failure codes.

**Hosts.** Desktop and headless report per the ownership table over the
relay rule; browser-panel `ready` moves from the userland bypass to the host;
re-adoption of surviving renderers after server restart republishes held boot
records onto fresh attempts. `panelReadiness.ts` deleted; the `testApi.ts`
assertions that consumed it rewritten against the canonical record.

**Eval.** EvalDO wrapper reads `progressSemantics` and enriches its
checkpoint to `external-wait`; `getRun` surfaces the activity. Redrive
observability: `redrive-backstop` trace labels, push-vs-backstop counters,
log coalescing (§3.9).

**Tests.** The coordinator suite is rewritten around the state machine
(transition-table tests, not scenario mocks) in the same change, plus the §5
matrix. Internal commit structure on the branch is whatever serves review;
it carries no architectural meaning and nothing in between is expected to
ship or even build green — only the merged result is.

---

## 5. Verification

State-machine level (table-driven):

- Every phase pair: accepted iff strictly advancing and reporter-authorized;
  post-terminal and unknown-attempt reports rejected and logged.
- Superseded attempt racing to publish `ready` → rejected; replacement attempt
  unaffected; the racer's waiter receives `stopped{superseded}`.

Integration:

- `rebuild()` with unchanged source and build key on a visible desktop panel:
  old attempt stops, new attempt reaches `ready`, waiter resolves on the new
  attempt only.
- Same scenario headless, via the existing deterministic panel-lifecycle
  suite. These two are the principal system tests.
- Transport blip on a `ready` panel: phase stays `ready`, `route.reachable`
  flips false→true; **attempt** waiters do not wake, **slot** waiters wake on
  each route flip (they observe the composite); invoke path recovers.
- Server restart with a live desktop renderer: the eval that was blocked in
  `awaitAttempt` terminates via the lifecycle path matching how the runtime
  went down — `cancelled` on graceful shutdown, `runtime_generation_lost` on
  planned replacement, `eval_runtime_restarted` on crash (all three asserted;
  unchanged behavior); the surviving renderer is
  re-adopted into a fresh attempt and the host relay republishes its held
  boot record, so the panel reads `ready` without rebooting; a new
  `awaitAttempt` call carrying the pre-restart ref returns `unknown-attempt`
  immediately, and `rebuild()`'s waiter surfaces that as a typed
  infrastructure failure rather than adopting the replacement.
- Unwatched stall: an attempt with zero waiters still reaches
  `failed{boot_stalled}` (the supervision schedule is coordinator-owned); a
  stall with many waiters fails after the same number of rounds, not sooner.
- Fresh CDP attachment after replacement targets the new attempt's connection.
- Browser-source panel reaches `ready` via host ownership with no bootstrap.

Stall & cancellation:

- Suppressed readiness publication (bundle that mounts nothing and never
  throws) → `failed{boot_stalled, detail:"no-progress"}` with last boot
  record + host observation attached; the awaiting eval receives the typed
  failure.
- Blocked renderer event loop (probe expression never answers, WebSocket
  nominally open) → `failed{boot_stalled, detail:"unobservable"}`; no
  infinite wait.
- Alternating probe outcomes (valid-no-progress interleaved with
  unobservable) still terminate — the shared no-progress counter is reset
  only by an actual revision advance, never by a change of probe outcome.
- Pending-region stall: a materialization/build operation that never settles
  → `failed{stage:"materialization", code:"boot_stalled"}`; no attempt parks
  in `pending` forever.
- Eval cancelled mid-`awaitAttempt`: `ctx.signal` propagates, waiter rejects,
  no orphaned coordinator listener.

Eval integration:

- Eval awaiting panel boot exposes `activity.kind === "external-wait"` with
  the static operation/resource metadata while liveness is suspended, and the
  carried attempt ref resolves through the coordinator to the slot whose
  observation supplies the live phase (the join the UI performs).
- Lost EvalDO completion push recovered by the backstop without re-execution
  (exists — keep), now asserting the `redrive-backstop` trace label.
- Healthy-path trace contains zero `redrive-backstop` claims (the dispatch-
  plan invariant, now testable).

Build:

- Changing the wrapper protocol text changes every build key.
- A pre-cutover-keyed cached artifact is not served after the bump.

---

## 6. Rejected alternatives

- **Hardening the existing lease/connection model** (the draft's Phase 1):
  rejected because there is no model to harden — validation would be bolted
  onto five replacement paths and a conflated observation. Cost of the rewrite
  is comparable and buys a real invariant surface.
- **Progress-renewal bootstrap lease** (the draft's Phase 3): a wall-clock
  lease renewed on phase advancement is a TTL by another name; every failure
  mode it covers except one is already evented. Replaced by event resolution
  plus the narrow probe-anchored stall detector.
- **Client-computed attempt identity** (`entity@buildKey`): identity must
  exist before its attributes are known and must be unforgeable by stale
  writers; only a server-minted opaque id satisfies both.
- **Permanently leased cross-DO wait replacing the eval redrive**: strictly
  less crash-resilient than the parked-row design (a lease holder can die
  holding the lease; a parked row cannot lose the fact that start was
  acknowledged). Confirmed by code inspection; keep the redrive.
- **Timeout/deadline around `rebuild()` or `awaitAttempt`**: waits are
  resolved by attempt terminality, which the state machine now guarantees;
  callers keep `AbortSignal` for their own policy.
