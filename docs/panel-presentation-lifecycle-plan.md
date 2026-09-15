# Panel Presentation Lifecycle — Single-Owner Cutover Plan

Status: implemented and verified (2026-08-11).

Companion to `panel-surface-architecture.md`. That document defines panel surfaces
and durable identity. This plan has one narrower responsibility:

> Make one requested panel visibly occupy one native shell slot, with one local owner
> and one truthful presentation state.

This replaces the current overlapping loading paths. It does not redesign browser
history persistence, panel-tree history, BuildV2, or the server's runtime-lease model.

## 1. Why this cutover exists

On 2026-08-10, a newly opened cached `about/new` panel reached a stable contradictory
state:

- the server and Electron observation reported the exact panel runtime ready;
- its WebContents loaded successfully and rendered the New Panel UI;
- panel HTTP and RPC connections succeeded;
- hosted shell chrome continued to cover it with `Preparing panel...`;
- two slow `view.ensurePanelLoaded` calls were issued for the same slot.

This was not evidence of random packet loss. Several components owned different
definitions of loading and readiness:

- the server runtime lifecycle;
- `PanelRuntimeLeaseController`;
- `PanelView` and `ViewManager`;
- `PanelRegistry.artifacts`;
- shell hooks and `PaneContent`;
- renderer-driven `PanelSurface` binding.

The shell reconstructed readiness from artifact fields while Electron separately
owned the real native view. Both projections could remain internally stable while
disagreeing forever.

The deterministic panel-lifecycle system test remained green because it observed the
panel renderer directly. It did not prove that shell chrome revealed the corresponding
native surface.

## 2. Scope and non-scope

### In scope

- resolving the currently desired panel entity;
- acquiring the existing runtime lease and preserving lease-denial/takeover UX;
- creating or reusing a panel WebContents;
- navigation and code-panel boot observation;
- binding the exact WebContents to a current native shell slot;
- truthful loading, unavailable, ready, and failed shell states;
- replacement, unload, lease loss, shell replacement, and crash recovery;
- lifecycle diagnostics and native performance profiling.

### Deliberately separate

- ordering asynchronous durable browser-navigation writes;
- changing whether browser navigation mints durable runtime entities;
- replacing the current entity-keyed runtime lease with a slot-scoped lease;
- unifying browser and slot history;
- redesigning BuildV2 or panel authority.

Those are real design topics, but combining them with this cutover would multiply its
state space without helping the observed loading failure. Section 5 defines the local
browser presentation boundary so those later changes cannot corrupt readiness.

## 3. Decision

Electron main owns one `PanelPresentationController`. It is the only component that
may turn desired panel state into a native presentation or publish local presentation
state.

```text
server desired panel + lease facts       shell slot declarations
                 │                                │
                 └──────────────┬─────────────────┘
                                ▼
                 PanelPresentationController
                         (Electron main)
                                │
                 resolve → lease → view → boot → attach
                                │
                                ▼
                replayable presentation snapshot
                                │
                                ▼
                   shell renders state directly
```

Ownership is intentionally small:

- the server owns durable entity and runtime-lease facts;
- Electron owns local view lifecycle and native attachment;
- the shell owns layout declarations and presentation UI;
- the controller sequences the first two inputs and publishes the only shell-facing
  result.

Events report facts. They never create views or independently advance presentation.

## 4. One serialized record per slot

The controller stores one current record for each panel slot:

```ts
interface PresentationRecord {
  readonly token: object;
  readonly slotId: PanelSlotId;
  readonly attemptId: string;
  readonly target: PresentationTarget;
  readonly abort: AbortController;
  readonly completion: Promise<PresentationResult>;

  status: "active" | "ready" | "unavailable" | "failed" | "cancelled";
  stage: LoadingStage;
  lease?: OwnedRuntimeLease;
  view?: OwnedPanelView;
  binding?: OwnedNativeBinding;
  document?: ObservedDocument;
}
```

`token` is private object identity, not another cross-process id. All controller state
mutations run through one per-slot serialized executor.

### 4.1 Operation algorithm

1. A request enters the slot executor.
2. A caller joins `completion` only when the current record is `active`, targets the
   same entity and shell-slot ownership, and every handle already acquired by that
   record remains viable. Bounds and focus changes are layout updates, not
   presentation identity changes.
3. An ordinary ensure request against a valid `ready` record returns the current
   ready snapshot immediately; it does not create or join an operation. A passive
   request against `failed` or `unavailable` likewise returns that canonical terminal
   snapshot.
4. Explicit retry, takeover, recovery, or replacement always creates a new record and
   `attemptId`, even when target and slot ownership are unchanged. Invalid lease,
   WebContents, document, or binding handles also force a new record.
5. The controller creates and installs that replacement record before
   starting asynchronous work.
6. Reusable handles move synchronously from the previous record to the new record and
   are cleared from the previous record in the same executor turn.
7. The previous operation is cancelled if active and may clean up only handles it
   still owns.
8. Each asynchronous completion re-enters the executor and first checks:

   ```ts
   currentBySlot.get(slotId) === record;
   ```

9. A stale completion may dispose its remaining private handle. It cannot publish,
   attach, detach, release a transferred lease, or affect the current record.
10. A successful record remains current and continues owning its lease, WebContents,
    document observation, and native binding after its completion promise settles.

This provides the useful part of generation fencing without a public resource-
generation protocol. Ownership is the current record and the handles physically held
by it.

The executor changes `status` before settling `completion` or publishing the matching
snapshot. Record status, promise settlement, and snapshot state therefore cannot
disagree about whether joining remains legal.

### 4.2 Internal completion

`present()` is an internal controller API. Its promise settles once as:

```ts
type PresentationResult =
  | Extract<PanelPresentation, { state: "ready" | "unavailable" | "failed" }>
  | { state: "cancelled"; attemptId: string };
```

Joined callers receive the same result. Cancellation is explicit so callers cannot
hang, but it is not retained as a second product state. The replayable
`PanelPresentation` snapshot remains canonical.

## 5. Canonical presentation state

The controller publishes a small discriminated union:

```ts
type LoadingStage =
  | "resolving"
  | "leasing"
  | "creating-view"
  | "navigating"
  | "booting"
  | "waiting-for-slot"
  | "attaching"
  | "recovering";

type PanelPresentation =
  | { state: "idle"; slotId: PanelSlotId }
  | {
      state: "loading";
      slotId: PanelSlotId;
      attemptId: string;
      stage: LoadingStage;
      enteredAt: number;
    }
  | {
      state: "unavailable";
      slotId: PanelSlotId;
      attemptId: string;
      reason: "leased-elsewhere";
      lease: LeaseHolderSummary;
      enteredAt: number;
    }
  | {
      state: "ready";
      slotId: PanelSlotId;
      attemptId: string;
      surface: "code";
      runtimeEntityId: PanelEntityId;
      webContentsId: number;
      nativeSlotId: NativePanelSlotId;
      documentRevision: number;
      url: string;
      enteredAt: number;
    }
  | {
      state: "ready";
      slotId: PanelSlotId;
      attemptId: string;
      surface: "external";
      webContentsId: number;
      nativeSlotId: NativePanelSlotId;
      documentRevision: number;
      url: string;
      enteredAt: number;
    }
  | {
      state: "failed";
      slotId: PanelSlotId;
      attemptId: string;
      stage: LoadingStage;
      code: string;
      message: string;
      enteredAt: number;
    };
```

`documentRevision` is a local counter maintained with the WebContents. It prevents a
late boot or navigation completion for an earlier document from publishing `ready`.
It is diagnostic presentation identity, not durable entity identity or a new server
contract.

### 5.1 Ready means visibly attached

For a code panel, `ready` means:

- the current record still targets the exact durable runtime entity;
- this host owns the corresponding current runtime lease;
- the current WebContents loaded and reported boot for that entity's document;
- the current hosted-shell owner still owns the native slot;
- Electron attached that WebContents to that slot.

For an external panel, `ready` means:

- this host still holds the runtime lease required by the existing architecture;
- the current WebContents document revision and URL match Electron's observation;
- the current hosted-shell owner still owns the native slot;
- Electron attached that WebContents to that slot.

External `ready` deliberately does not claim that asynchronous durable browser
history already matches the live document. Durable browser provenance may lag or fail
without making an attached document invisible. Such failure is diagnostic until the
separate browser-history design defines its product behavior.

### 5.2 Browser navigation stays local to presentation

Free navigation inside an already attached browser WebContents does not restart panel
presentation. While Chromium retains the old committed document, the current `ready`
snapshot remains truthful. In the main-frame commit handler, before yielding back to
other work, the controller increments the controller-local document revision and publishes a
new `ready` snapshot for the committed URL. The WebContents, lease, native binding, and
record do not churn.

Initial external navigation and host-requested replacement still use
`loading(navigating)`. Ordinary in-view browser progress belongs to browser chrome,
not the panel-presentation overlay.

Durable entity replacement events never command the controller to navigate an already
newer live external document backward. They update durable provenance and future
restore state only. Ordering and restart correctness for overlapping durable writes
belong to the separate browser-navigation design.

### 5.3 Lease contention is normal

The existing `{ acquired: false, lease }` response produces `unavailable`, not
`failed` and not a timeout. `LeaseHolderSummary` contains only the exact entity and
connection needed to identify the observed holder plus display-safe label/platform
fields.

The shell renders the existing “Running on … / Take Over” UI directly from that
snapshot. Takeover should carry the observed runtime entity and connection id; the
server should refuse if the current holder changed and return the new holder. This is
a narrow strengthening of the existing takeover operation, not a new lease model.

Lease events with `next: null` do not produce `unavailable(leased-elsewhere)`, because
there is no holder to report. Inside the slot executor, the controller first rereads
the desired entity and residency:

- if the panel is still desired and resident, it installs a fresh record with a new
  `attemptId`, publishes `loading(recovering)`, and attempts acquisition normally;
- if the panel is no longer desired or resident, it releases remaining owned handles
  and publishes `idle`;
- if reacquisition finds a new holder, the fresh attempt terminates as
  `unavailable(leased-elsewhere)` with that returned lease;
- if reacquisition fails operationally, the fresh attempt terminates as `failed`.

This applies to `released`, `revoked`, `expired`, and `retired` events only when the
event invalidates the lease owned by the current record. An event caused by unload or
an already-installed replacement cannot revive the superseded record.

## 6. Legal transitions

```text
idle ───────────────────────────────► loading
loading ── success + attachment ────► ready
loading(leasing) ── denied ─────────► unavailable(leased-elsewhere)
loading ── terminal error ──────────► failed
loading ── superseded/unloaded ─────► next loading record or idle
unavailable ── retry/takeover ──────► loading
failed ── retry ────────────────────► loading
ready ── entity/host replacement ───► loading
ready(external) ── in-view commit ──► ready (new document revision)
ready ── crash ─────────────────────► loading(recovering) or failed
ready ── lease loss to other host ──► unavailable
ready/loading ── lease loss, no holder, resident ─► loading(recovering) (new record)
unavailable ── holder released, still resident ──► loading(recovering) (new record)
ready/loading/unavailable ── lease loss, not resident ─► idle
ready ── shell replacement ─────────► loading(waiting-for-slot)
ready/unavailable/failed ── unload ─► idle
```

Before leaving `ready` for lease loss, unload, or an invalid native owner, Electron
hides or detaches the old surface. A stale `ready` snapshot may never outlive the
native fact that justified it.

Slow thresholds report the current stage but do not manufacture failure. A phase has
a terminal deadline only when its underlying protocol has a real bounded guarantee.
Build duration, for example, is observed and cancellable but not failed merely because
an arbitrary UI timer elapsed.

## 7. Boundary contracts

### 7.1 Server → Electron

The server supplies the current desired entity and the existing runtime-lease result.
It may say an entity is prepared; it does not call local presentation `ready`.

Lease events wake the controller, which rereads current lease state inside the slot
executor. A lease event never directly creates or destroys a view.

The event's `next` value is authoritative: a non-null lease held elsewhere projects
`unavailable`; `next: null` follows the recovery-or-idle policy in §5.3. Event reason
text alone never determines the transition.

This plan keeps `PanelRuntimeLease` and its entity replacement behavior. The
controller consumes that mechanism; it does not introduce a parallel
`PanelPresentationLease`.

### 7.2 Shell → Electron

The shell publishes layout declarations independently of panel readiness:

```ts
interface NativePanelSlotDeclaration {
  nativeSlotId: NativePanelSlotId;
  rendererInstanceId: string;
  bindingSequence: number;
  operationSequence: number;
  panelId: PanelSlotId;
  bounds: ViewBounds;
  resident: boolean;
  focused: boolean;
}
```

Electron retains authority already present in `ViewManager`:

- Electron increments `hostedShellGeneration` when the hosted-shell owner changes;
- `rendererInstanceId` rejects stale renderer documents;
- binding and operation sequences reject reordered declarations;
- the shell never supplies or advances the Electron generation.

Changing bounds updates layout; it does not restart presentation. Changing the bound
panel or shell owner wakes the controller for that slot.

### 7.3 Electron → shell

The shell opens one revisioned subscription with an atomic initial snapshot:

```ts
interface PanelPresentationSnapshot {
  revision: number;
  presentation: PanelPresentation;
}
```

`PaneContent` renders this union directly. It does not combine registry artifacts,
build keys, lease observation, or native-view events into another readiness
predicate. Reconnection receives the latest snapshot; readiness never exists only in
a transient event.

## 8. Implementation cutover

Preparatory work may land unused, but no release may run two presentation owners for
the same panel. “Atomic cutover” refers to the deployed ownership boundary, not one
enormous commit.

### Workstream A — Capture the current contradiction

Using the repository-native profiler and an isolated managed instance, capture for one
cached `about/new` load:

- every `ensurePanelLoaded` request;
- desired and hosted runtime entity ids;
- lease result and connection id;
- WebContents id, URL, load, and boot observations;
- hosted-shell generation, renderer instance, and native slot binding;
- shell presentation state and overlay visibility.

Preserve one bounded regression fixture. Do not add recovery behavior here.

### Workstream B — Build the dormant controller

Implement the serialized per-slot record and pure transition tests behind fake
mechanisms. It has no production event subscriptions and cannot create a real view.

Mechanism interfaces remain narrow:

- resolve desired entity;
- acquire/release/take over the existing lease;
- create/reuse/destroy/navigate a view;
- observe document and boot state;
- attach/detach/update a native slot.

### Workstream C — Prepare the shell boundary

Add the layout-declaration endpoint and replayable presentation subscription without
switching production ownership. Reuse `ViewManager`'s existing main-owned generation
and renderer/operation fencing. Test the endpoints independently.

### Workstream D — Vertical ownership cutover

In one release boundary:

1. route focus/load, activation, lease, crash, replacement, residency, and unload
   facts into the controller;
2. make the controller the only creator and destroyer of panel views;
3. make the controller the only owner of native attachment;
4. switch `PaneContent` to the canonical snapshot;
5. remove all old production entry points before shipping.

Delete rather than retain:

- `locallyLoadingSlots`;
- recursive materialization triggered by lease assignment;
- view creation initiated directly by lease broadcasts;
- renderer-owned `PanelSurface` binding;
- build-key-driven `ensureLoaded` effects;
- `presentsCurrentEntity`;
- shell use of `PanelRegistry.artifacts` as presentation state;
- `hostedRuntimeEntityId` as a shell readiness field;
- polling, watchdog reloads, or compatibility projections added to reconcile old and
  new state.

`PanelRuntimeLeaseController`, `PanelView`, and `ViewManager` may remain as mechanisms
only if their policy-bearing entry points are removed. Do not wrap an old state machine
inside the new controller.

### Workstream E — Performance acceptance and cleanup

Profile repeated cold and cached `about/new` presentations plus one external panel.
Compare with Workstream A and inspect:

- request to visible attachment;
- time in each diagnostic stage;
- duplicate presentation requests;
- WebContents creation and navigation count;
- shell presentation renders;
- attachment-to-overlay-removal delay;
- retained-view reuse without navigation or server round trips.

Do not invent fixed latency budgets before measuring the baseline. Correctness does
require identical concurrent requests to execute once and stale operations to perform
zero current-state mutations.

Run a final call-site census. The source must show one presentation creator, one
attachment owner, one snapshot publisher, and one shell consumer.

## 9. Verification

### Pure controller tests

- identical concurrent requests join one record and promise;
- settled ready, unavailable, and failed records are never treated as joinable work;
- passive ensure returns a valid terminal snapshot without creating an attempt;
- explicit retry, takeover, and recovery create a new attempt for an unchanged target;
- an invalid owned handle forces a new record rather than returning stale ready;
- replacement installs the new record before cancelling the old one;
- stale completions cannot publish, attach, detach, or release transferred handles;
- cancellation settles every joined caller;
- lease denial produces `unavailable` with takeover information;
- takeover refuses a holder different from the one observed;
- every legal transition is accepted and illegal transitions fail loudly;
- unload releases exactly the handles owned by the current record.

### Main-process integration tests

- cached and cold code panels;
- initial external panel and one real main-frame navigation;
- same-URL code replacement with a different runtime entity;
- activation or lease events before and during presentation;
- lease transfer to another holder after ready;
- released, revoked, expired, and retired leases with `next: null` while resident;
- `next: null` after unload does not reacquire or revive the panel;
- WebContents crash during loading and after ready;
- shell replacement during attachment and after ready;
- stale renderer and regressing slot operations;
- retained ready view reuse.

### Hosted-shell system test

The regression test must exercise ordinary hosted shell UI:

1. open cached `about/new`;
2. observe one controller record;
3. wait for `ready`;
4. assert shell chrome has no loading or failed overlay;
5. assert the exact native slot owns the exact WebContents;
6. assert visible New Panel content;
7. close the panel and assert its current resources are released.

Run the same boundary cold. Direct panel CDP readiness alone is insufficient.

Add one focused takeover test and one focused browser-navigation test. Do not build an
exhaustive cross-product of every failure at every stage; expand only where a changed
mechanism creates a distinct causal boundary.

## 10. Implementation outcome (2026-08-11)

The cutover is live as one vertical ownership boundary:

- `PanelPresentationController` owns per-slot attempts, lease acquisition,
  WebContents materialization, exact code-document boot evidence, recovery, and the
  final native attachment commit;
- navigation and history selection commit durable state first and immediately enter
  that controller for the committed incarnation;
- execution-activation and lease broadcasts feed the same attempt machinery rather
  than starting independent view convergence;
- `ViewManager` retains Electron-minted hosted-shell generations and renderer-scoped
  declaration ordering, while `PanelSurface` only declares geometry and residency;
- `PaneContent` consumes the revisioned `PanelPresentation` snapshot directly;
- attempt completion is separate from the replayable product snapshot, including an
  explicit `cancelled` result for superseded callers;
- holderless lease loss uses shell-declared residency—not successful attachment—as
  the recovery predicate, so loss during startup cannot turn a visible pane idle;
- retained lease cleanup is fenced by private attempt-token ownership before it may
  release a resource adopted by a newer attempt.

The obsolete artifact-derived shell visibility predicate and renderer-owned loading
path were deleted. Test diagnostics also use the local presentation snapshot as their
sole readiness oracle; coordinator observation remains adjacent diagnostic evidence
and cannot veto a locally committed presentation.

Verification evidence:

- the focused host lifecycle/native-slot suite passes 194 assertions, including
  active-only joining, retry, takeover identity, stale slot cleanup, post-ready slot
  revocation, exact boot identity, and holderless resident recovery;
- the native Electron same-panel convergence flow passes from `about/new` through
  repeated durable replacements with no loading overlay, leaked operation failure, or
  stuck build state;
- shell component tests, host/workspace type checks, generated authority checks, and
  the focused browser-host bridge tests pass;
- native profiles recorded a 1,607 ms baseline `about/new` open and a 463 ms
  post-cutover open sample; the post-cutover cache-disabled reload was 247 ms with
  68 ms FCP/LCP, 27 requests, no failed requests, and no long tasks. These samples are
  evidence against a loading-speed regression, not fixed latency budgets.

## 11. Completion criteria

The cutover is complete when:

1. Exactly one component can start or supersede local panel presentation.
2. Identical requests execute once and joined callers always settle.
3. Only viable active records are joinable; retry, takeover, recovery, and invalid
   handles always create a new attempt.
4. `ready` implies the current WebContents is attached to the current native slot.
5. Code `ready` also implies the exact desired runtime entity and owned lease.
6. External `ready` identifies the current live document without claiming durable
   history has already caught up.
7. Lease denial retains the existing holder and takeover UX.
8. Holderless lease loss creates a fresh recovery attempt only while the panel remains
   desired and resident; otherwise it reaches `idle`.
9. Crash, lease loss, unload, and shell replacement revoke obsolete readiness.
10. The shell consumes one replayable snapshot without reconstructing readiness.
11. Existing Electron shell-generation and renderer-operation fencing remains intact.
12. Old lifecycle writers and compatibility projections are deleted.
13. Cached and cold hosted-shell regression tests pass.
14. Native profiles show no unexplained duplicate work or material regression.

The desired result is not merely that the spinner eventually disappears. At any
moment, one Electron-owned record explains what this slot is presenting, which stage
blocks it, and which exact native attachment justifies `ready`.
