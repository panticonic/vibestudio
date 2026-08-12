# Host/userland boundary roadmap

Status: proposed follow-on architecture work

This document describes the remaining high-risk, high-value work after the
small host-surface extractions landed in August 2026. It is a forward-looking
plan based on the current implementation. `docs/host-residency-redesign.md` is
historical context, not the specification for this work.

## Objective

The host should be a small authority and effect kernel. It owns facts and
effects that workspace code cannot safely or durably own:

- authenticated runtime identity and authority admission;
- protected credentials and approval/grant records;
- exact-context repository and build attestation;
- process, native view, OS, and device effects;
- runtime supervision, leases, recovery, and cleanup;
- sealed application loading and client-host ABI negotiation.

Workspace code should own product policy, presentation, orchestration, and
mutable application behavior. An extension should own a local native provider
when a workspace feature needs filesystem, process, or device access but does
not need to become part of the host kernel.

The target is not a low method count for its own sake. It is a boundary where
each host method represents one irreducible fact or effect, and where changing
ordinary product behavior does not require shipping a new host.

## Rules for every migration

1. Move one owner, not one call site. A migration is complete only when the old
   owner, state, and route are deleted.
2. Do not add compatibility shims, dual writes, fallback reads, or parallel
   transports. If existing durable state must move, use one explicit,
   versioned migration with a verifiable completion record.
3. Keep authority decisions in the kernel. Moving policy to userland must not
   move the authority fact on which the kernel relies.
4. Prefer a narrow effect contract over a product facade. For example,
   `setNativeZoom(panelId, factor)` is a host effect; "apply the user's site
   preference" is workspace policy.
5. Client hosts implement the same semantic host protocol. Electron
   `webContents`, React Native `WebView`, and headless Puppeteer pages are
   adapters, not separate product architectures.
6. Delete special cases made obsolete by the new owner in the same change.
7. Verify both authority behavior and recovery behavior. A happy-path UI test
   alone is not sufficient for a boundary migration.

## Target architecture

The desired execution stack is:

```
workspace app / worker
  product state, policy, orchestration, and presentation
              |
              | authenticated typed RPC
              v
shared client-host protocol
  panel presentation requests, native effects, launch identity
              |
              v
Electron / React Native / headless adapter
  webContents, WebView, Page, OS APIs, native storage
              |
              v
workspace host kernel
  authority, protected facts, supervision, exact execution
```

Extensions sit beside workspace workers. They provide reviewed local native
capabilities through the existing extension invocation boundary; they do not
become implicit host services.

## Workstream A: relocate Electron panel ownership

### Current problem

Electron main instantiates the shared `PanelManager`, owns local presentation
state, and exposes product-oriented panel methods through `view`. Mobile runs
the same product logic in the workspace app. Headless constructs a partially
disabled `PanelManager` with no-op adapters.

This makes Electron main both a native panel host and a product shell. It also
causes behavior to diverge by client because Electron product changes land in
`src/main`, while mobile product changes land under `workspace/apps/mobile`.

### Target cut

`workspace/apps/shell` owns `PanelManager`, panel-tree projection, local layout
state, search updates, and product navigation policy. Electron main owns a
`PanelHostAdapter` with only:

- create, bind, update, focus, and destroy native panel surfaces;
- bounds, visibility, and native input forwarding;
- navigation, find, print, zoom, media, DevTools, and session-data effects;
- native lifecycle/crash notifications;
- lease-bound bootstrap and CDP transport.

The workspace shell persists its client-local presentation state through an
explicit local-state capability. That capability is a generic bounded store,
not a panel-layout database implemented in Electron main.

### Migration sequence

1. Define the final `PanelHostAdapter` contract from the native operations that
   remain after browser-product composition is removed.
2. Make the Electron workspace app instantiate `createShellCore` using an RPC
   implementation of that adapter.
3. Move the current Electron local view-state schema into a versioned workspace
   app state record. Write and test a single migration from the existing native
   record.
4. Route lease-bound panel materialization requests from the workspace shell to
   Electron main.
5. Delete `createElectronShellCore`, the main-process `PanelManager`, product
   methods from `view`, and main-process layout/pin/collapse ownership.
6. Remove Electron-only panel behavior from `PanelOrchestrator`; retain only
   native surface lifecycle and lease reconciliation.

### Acceptance criteria

- Electron main does not instantiate `PanelManager`.
- Electron and mobile execute the same shared panel state machine.
- No panel product state is dual-written across renderer and main.
- Restart, renderer crash, panel crash, lease transfer, and workspace switch
  tests pass without reconstructing state from an obsolete owner.
- The `view` schema contains only native view and panel-host effects.

## Workstream B: split workspace authority state from presentation state

### Current problem

The `workspace.state` builtin contains both authority-bearing topology and
ordinary presentation data. Slot/entity/context bindings, ancestry, leases,
and cleanup queues feed authorization and supervision. Search indexes, access
counts, launcher ranking, titles, and navigation presentation do not.

Keeping both in one builtin lets presentation features inherit kernel residency
from neighboring authority rows.

### Target cut

Retain a small builtin topology service containing:

- slot identity and parent/child ownership;
- current entity and context binding;
- prepared navigation commit facts;
- lifecycle leases and cleanup acknowledgements;
- bounded ancestry and ownership projections consumed by authorization.

Move search, ranking, user-facing titles, access counters, and presentation
history to a seeded workspace service. The userland service may consume stable
slot identifiers but may not author or reinterpret the authority topology.

### Migration sequence

1. Inventory every table and method by the exact kernel decision that consumes
   it. A claim such as “used by the shell” is not authority evidence.
2. Define separate topology and presentation schemas with no shared write
   method.
3. Give the presentation service a rebuild operation derived from the bounded
   topology projection so its data is disposable and recoverable.
4. Migrate presentation rows once, verify counts/digests, then remove those
   columns/tables from the builtin.
5. Narrow the builtin catalog and authority manifest to the topology surface.

### Acceptance criteria

- Every remaining builtin row has a named authority or supervision consumer.
- Deleting and rebuilding presentation storage cannot change an authorization
  decision.
- Userland can change search and launcher behavior without rebuilding the host.

## Workstream C: decompose browser data into vault and product services

### Current problem

The browser-data builtin combines passwords, form-fill secrets, cookies,
bookmarks, history, favicons, site preferences, search engines, downloads, and
import-job state. Protected secrets justify durable kernel storage; ordinary
browser product records do not automatically inherit that justification.

### Target cut

Create two explicit stores:

1. A host-protected browser vault for passwords, sensitive form-fill values,
   protected cookie material where required, encryption, backup, and recovery.
2. A workspace browser-data service for bookmarks, history, favicons, search
   engines, site preferences, download presentation, and import progress.

The vault exposes typed record operations with caller and origin scoping. It
does not expose browser-product workflows such as import jobs or bookmark
folders. Native browser projection remains an Electron/mobile adapter effect.

### Migration sequence

1. Threat-model each current record family and write down why compromise or
   loss requires host protection.
2. Define vault record schemas and encryption/backup invariants.
3. Move non-secret families to a seeded workspace DO and update the portable
   browser-data broker to call both stores.
4. Migrate secret rows into the vault with count and digest verification.
5. Delete the monolithic builtin and register only the vault as protected host
   infrastructure.

### Acceptance criteria

- Workspace code never receives bulk vault contents without an explicit
  reviewed operation.
- Browser presentation features are deployable as workspace changes.
- Import, backup, restore, and cookie projection have one authoritative owner
  each and no dual-write period.

## Workstream D: reduce missions to a mechanical reviewed-closure kernel

### Current problem

The missions builtin owns mission CRUD, revisions, state transitions, run
records, approval presentation, exposure compilation, and reviewed-closure
activation. Only the last group feeds kernel authority.

### Target cut

A workspace missions service owns documents, revisions, schedules, run
presentation, and domain policy. A small builtin closure service owns:

- canonical mechanical compilation of a submitted closure description;
- digest calculation and verification;
- trusted mechanical presentation of the exact authority exposure;
- activation, suspension, retirement, and session binding.

The kernel must not trust prose supplied by the userland compiler as the
description of authority. It renders the capability/resource facts it verifies.

### Migration sequence

1. Define the canonical closure input independent of mission domain models.
2. Move mission document and run-state methods to a workspace service.
3. Replace product-specific approval copy in the builtin with mechanical
   capability/resource rendering.
4. Bind activated closure digests back to mission revisions as opaque facts.
5. Delete mission CRUD tables and domain compilation from the builtin.

### Acceptance criteria

- The closure kernel has no mission title, charter, scheduling, or UX policy.
- A malicious workspace missions service cannot cause the approval UI to omit
  or soften an authority fact.
- Editing a mission invalidates the exact active closure without parallel
  revision paths.

## Workstream E: make client hosts adapters to one protocol

### Current problem

Electron, mobile, and headless share pieces of shell core but assemble panel
hosting, event projection, launch recovery, and CDP routing differently.
Electron has a distinct `desktopEvents` service and several preload side
channels. Headless ports mobile logic and supplies no-op product adapters.

### Target cut

Create one versioned client-host protocol package covering:

- sealed launch identity and native endowments;
- panel surface lifecycle and presentation acknowledgements;
- native navigation/effect requests;
- host-origin events;
- connection recovery and lease loss;
- optional CDP capability negotiation.

Each client advertises supported protocol features. Optionality is expressed by
negotiated protocol capabilities, not throwing stubs or platform-specific
service names.

### Migration sequence

1. Extract the common state machine from Electron CDP, headless host bridge, and
   mobile panel hosting without changing transport.
2. Carry native ingress such as pair links and panel locations as typed
   host-origin events on the authenticated transport.
3. Replace `desktopEvents` with the canonical event domain plus a native event
   source.
4. Reduce Electron preload to the authenticated transport, bootstrap identity,
   and truly WebContents-local input/overlay bridges.
5. Make headless consume the protocol directly instead of instantiating a
   product `PanelManager` with no-op dependencies.

### Acceptance criteria

- One conformance suite runs against Electron, React Native, and headless
  adapters.
- No platform needs a parallel product event service.
- Unsupported features are absent from negotiated endowments.
- Reconnection and lease-loss behavior is defined once.

## Workstream F: thin mobile and Electron recovery surfaces

### Current problem

The shipped mobile bootstrap is a substantial secondary application containing
pairing, reconnection, approval, and launch behavior. Electron's launch gate is
smaller, but recovery behavior is still separately assembled by platform.

### Target cut

Shipped clients contain only:

- bundle selection, integrity and ABI verification;
- pairing sufficient to reach an approved workspace app;
- a bounded mechanical approval renderer needed before that app exists;
- reset, diagnostics, and recovery operations.

The common launch/recovery state machine lives in a neutral package. Platform
renderers remain small and native-idiomatic.

### Acceptance criteria

- Recovery code cannot enter the normal post-launch product state.
- The shipped bootstrap has no panel tree, settings, or ordinary shell flows.
- Approval facts and actions are identical across launch gates.
- Activating an approved app leaves no live recovery transport or duplicate
  event subscriber.

## Workstream G: reconsider the development builtin

### Current problem

`developmentNative` is already a good exact-effect boundary, but the development
builtin owns a large durable product workflow for sessions, recipes, runs,
repair attention, and target selection. Its `durable-data` justification does
not establish why all of that workflow must be immutable host code.

### Target cut

Keep exact native effects and receipts in the host:

- exact repository materialization and build execution;
- owned process and terminal handles;
- executor attestation and attached-host publication;
- effect inspection, stop, recovery, and retirement.

Move development workflow and presentation to a workspace service. If durable
recovery records must survive workspace code changes, introduce a generic
host-owned execution ledger containing opaque state-machine receipts—not a
development-domain service.

### Acceptance criteria

- The native service continues to accept exact identities on every effect.
- Workspace workflow cannot forge process/build receipts.
- Recipe selection, pagination, UX state, and repair presentation are not host
  concerns.
- Crash recovery uses the generic ledger or native effect inspection, not a
  second copy of the product workflow.

## Delivery order

The workstreams should land in this order:

1. Electron panel ownership, because it removes the largest active product
   facade and establishes the common adapter contract.
2. Client-host protocol and event unification, built around that adapter.
3. Workspace-state authority/presentation split.
4. Missions closure-kernel split.
5. Browser-data vault split.
6. Recovery-surface thinning.
7. Development builtin re-evaluation after the generic execution/recovery
   primitives have stabilized.

The order is intentionally dependency-driven. Browser-data and missions can be
designed earlier, but they should not invent new client-host or durable-state
patterns while those foundations are still moving.

## Evidence and verification

Each workstream requires:

- an old-owner/new-owner inventory at method and durable-row granularity;
- an authority data-flow showing which exact host decision consumes each
  retained fact;
- focused unit tests for the new owner and deleted routes;
- generated authority/catalog checks;
- client-host conformance tests where applicable;
- one exact headless system test for the affected user workflow;
- crash/restart/reconnect testing when ownership or durable state changes;
- a final residency census showing the deleted host surface.

Method and line-count reductions are evidence, not the acceptance condition.
The decisive evidence is that product behavior has one workspace owner and the
remaining host contract consists only of irreducible facts and effects.
