# Host/userland boundary roadmap

Status: proposed follow-on architecture work, revised after implementation review

This document describes the remaining high-risk, high-value work after the
small host-surface extractions landed in August 2026. It is a forward-looking
plan based on the current implementation. `docs/host-residency-redesign.md` is
historical context, not the specification for this work.

## Objective

The host should be a small authority and effect kernel. It owns facts and
effects that workspace code cannot safely, durably, or independently own:

- authenticated runtime identity and authority admission;
- protected credentials and approval/grant records;
- exact-context repository and build attestation;
- process, native view, OS, and device effects;
- runtime supervision, leases, recovery, and cleanup;
- sealed application loading and client-host ABI negotiation; and
- deterministic migration of storage whose authority owner changes.

Workspace code should own product policy, presentation, orchestration, and
mutable application behavior. An extension should own a reviewed local native
provider when a workspace feature needs filesystem, process, or device access
but does not need to become part of the host kernel.

The target is not a low method count for its own sake. It is a boundary where
each host method represents one irreducible fact or effect, where ordinary
product changes do not require a host release, and where moving code out does
not weaken an atomic authority decision.

## Ownership model

Every record and operation in a migration must be classified into one of these
categories before code moves:

| Category                        | Owner                       | Examples                                                                                                | Recovery rule                                                                                         |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Authority and supervision facts | Host kernel                 | current slot/entity/context binding, immutable history identity, active closure digest, lease ownership | Must remain readable across host upgrades; never reconstructed from product projections               |
| Protected user facts            | Host kernel or narrow vault | credentials, grants, protected cookies, encryption metadata                                             | Lossless deterministic host migration                                                                 |
| Durable product facts           | Workspace service or app    | user titles, navigation payload, pins, layout, access counters, mission documents                       | Migrated once to the new owner; not described as disposable merely because they are non-authoritative |
| Derived projections             | Workspace service or app    | FTS tables, ranking indexes, denormalized search rows                                                   | May be deleted and rebuilt from durable facts                                                         |
| Native runtime resources        | Client-host adapter         | `webContents`, `WebView`, `Page`, process handles, CDP sessions                                         | Reconciled from protocol state and leases after crash or reconnect                                    |
| Migration-only state            | Host upgrade coordinator    | source/target identity, verification digest, committed route receipt                                    | Exists only to make an ownership cutover deterministic; never becomes a product fallback              |

Presentation is not synonymous with disposable. Conversely, persistence alone
does not justify kernel ownership. Residency follows the exact decision or
effect that consumes the fact.

## Non-negotiable migration rules

1. Move one owner, not one call site. At steady state there is one writer, one
   required route, and no fallback reader.
2. Never bridge a broken boundary with compatibility shims, dual writes,
   best-effort translation, parallel transports, or a second product service.
3. Keep every fact needed by an atomic authority decision in the same kernel
   transaction. A userland projection may refer to an opaque kernel identity;
   it may not become a second authority source.
4. Treat semantic workspace repair and durable-owner transfer as different
   mechanisms. Agentic migration notes can repair userland source and product
   schema. They cannot freeze host-owned writes, attest a storage copy, or
   commit a service route.
5. Any operation spanning kernel and userland stores must define its order,
   idempotency key, crash points, replay behavior, and orphan cleanup. “The UI
   will retry” is not a transaction protocol.
6. Prefer a narrow effect contract over a product facade. For example,
   `setNativeZoom(panelId, factor)` is a host effect; applying a user's site
   preference is workspace policy.
7. Client hosts implement one semantic protocol. Electron `webContents`, React
   Native `WebView`, and headless browser pages are adapters, not separate
   product architectures.
8. Optional native behavior is represented by negotiated endowments, not
   throwing stubs, no-op product adapters, or platform-specific service names.
9. Delete special cases made obsolete by the new owner. Explicit
   migration-only readers are permitted during a cutover window, but they are
   not callable product routes and can never be selected after commit.
10. Verify authority, recovery, skipped-upgrade, and workspace-switch behavior.
    A happy-path UI test is not sufficient evidence for an ownership move.

## Where agentic repair replaces machinery

Use the intelligence already present in the migration session for problems that
are semantic and workspace-specific:

- reconciling a locally modified workspace with the new Base contract;
- repairing manifests, service declarations, imports, and product schemas;
- recognizing old product-data shapes and choosing an honest mapping;
- writing or adapting a one-shot non-secret importer and its verifier;
- rebuilding derived projections and diagnosing records that do not conform;
- explaining ambiguous cases and escalating to the user instead of guessing.

Do not build version matrices, migration DSLs, universal product-schema
registries, or host-side semantic planners for those tasks. The migration note
states the target and sharp edges; the agent inspects the actual state.

Agentic judgment stops where improvisation could create authority or lose
unrecoverable data. Write fencing, immutable source snapshots, protected-secret
transforms, route commitment, exact issuer binding, lease fencing, and native
process identity remain deterministic kernel operations.

## Foundation 0: a minimal durable-owner cutover envelope

### Why Base reconciliation is not the transaction

Workspace workers ship through the externally released Base selected by the
host's exact Base pointer. Existing workspaces receive Base changes through
ordinary Composer reconciliation. That remains the only product distribution
path; the host must not seed workers from host source.

Composer reconciliation, however, is asynchronous and may require a semantic
merge. It does not prevent an old builtin from accepting writes, and a
migration note has no applied ledger or cross-store commit record. Therefore a
host/Base pair cannot safely copy data and delete the builtin in one release.

The durable cutover is an **offline, per-workspace startup hold**. The hold is
small and deterministic; semantic migration remains agentic.

### Divide deterministic safety from semantic judgment

The host owns only the facts an agent cannot safely improvise:

1. fence the previous host generation and admit no normal workspace traffic;
2. take one immutable source-storage snapshot;
3. retain the old route as the uncommitted owner;
4. wait for the existing Base/Composer operation to land a conforming target;
5. atomically commit the new owner and route; and
6. after commit, start only the new owner or remain in repair.

The existing Composer migration session and its agent own the semantic work:

- inspect the actual workspace and target Base release;
- repair divergent source, manifests, and service declarations;
- select or patch the bounded data importer for the actual old shape;
- run domain-specific conformance checks; and
- explain or escalate data that cannot be mapped honestly.

There is no generic migration DSL, per-record-family host schema registry, or
host algorithm for deciding whether two semantic datasets are equivalent. A
cutover supplies a simple idempotent importer and a verifier appropriate to
that owner. For a byte-preserving move, the importer may be raw namespace
adoption. For non-secret product data, it may be Base-owned code exercised by
the migration session. Protected plaintext is transformed only by sealed host
code; it is never exposed to the agent merely to make the framework uniform.

Counts, digests, reference checks, and product probes are verifier evidence,
not fields hard-coded into a universal host protocol. The host needs only a
minimal receipt containing:

- cutover and workspace identity;
- immutable source snapshot identity;
- exact target owner and Base/code identity;
- an opaque digest of the successful verifier evidence; and
- the committed route/version.

This is not an applied-notes ledger. It is the authority fact that selects the
one callable owner. The source snapshot remains available for diagnosis or a
new repair attempt, but it is never a post-commit product fallback.

### Cutover sequence

1. A host release identifies its exact target Base release and opens the normal
   durable Composer operation before product startup.
2. Startup holds the workspace and snapshots/fences the old owner. The old
   product route is not started while the hold is active.
3. The ordinary migration agent brings the actual workspace to the target
   contract and runs the cutover importer and verifier against the snapshot.
4. On successful evidence, the host commits the owner/route receipt and admits
   normal traffic to the new owner only.
5. A later retirement release deletes the builtin catalog, product class, DO
   export, and product authority. A bounded offline snapshot reader may remain
   only while a supported skipped upgrade still needs it.

The target Base and cutover may therefore ship together; a separate prepare
release is optional rehearsal, not a correctness requirement. The source
reader, startup hold, and route commit are the correctness mechanism. A host
must never assume that a workspace observed an intermediate release.

### First proofs

1. Use phone provisioning to prove exact Base distribution, required-route
   gating, fresh/reconciled workspace behavior, and catalog deletion without a
   data transfer.
2. Before moving workspace state, missions, or browser data, prove the offline
   hold/snapshot/commit envelope on the smallest low-value durable builtin or a
   faithful storage fixture, including crash injection at every step.

### Acceptance criteria

- Writes cannot reach either owner while the cutover hold is active.
- A crash before route commit leaves the old owner authoritative on retry; a
  crash after commit selects only the new owner.
- Repeating the importer against the same snapshot converges on the same target.
- A skipped host release either migrates through a supported offline adapter or
  fails before product startup with an exact unsupported-source diagnostic.
- No resolver gives a builtin implicit precedence over a committed workspace
  route.
- Base source is never copied into the host artifact or seeded by host code.
- The host contains no semantic migration planner or record-family framework.

## Target execution stack

```text
workspace app / worker
  durable product state, policy, orchestration, and presentation
              |
              | authenticated, versioned client-host protocol
              v
workspace shell core
  shared panel state machine and product navigation
              |
              | native effects, acknowledgements, leases, host events
              v
Electron / React Native / headless adapter
  webContents, WebView, Page, OS APIs, bounded local storage
              |
              v
workspace host kernel
  authority, protected facts, supervision, exact execution
```

Extensions sit beside workspace workers. They provide reviewed local native
capabilities through the existing extension invocation boundary; they do not
become implicit host services.

## Workstream A: one client-host protocol and workspace-owned panel shell

This combines the former panel-relocation and client-protocol workstreams. The
convergent protocol foundation lands first, panel ownership moves second, and
broad event and preload cleanup finishes third. This order avoids inventing an
Electron-only migration channel and replacing it immediately afterward.

### Current problem

Electron main instantiates the shared `PanelManager`, owns product presentation
state, performs lease/materialization recovery, and exposes product-oriented
panel methods through `view`. Mobile runs the same product logic in the
workspace app. Headless constructs a partially disabled `PanelManager` with
no-op adapters. Connection recovery and event projection are assembled
differently by platform.

The existing generic recovery coordinator and `PanelHostRegistration` are
useful ingredients, but they do not define native command acknowledgements,
renderer crash replay, lease-loss convergence, local-state ownership, or a
cross-adapter conformance contract.

### A0: convergent protocol envelope

Create a versioned package with three deliberately small shapes:

1. A negotiated handshake carrying sealed launch identity, host generation,
   protocol version, and native endowments.
2. A revisioned desired presentation snapshot from the workspace shell and a
   revisioned observed-native snapshot from the adapter.
3. Idempotent request/reply effects for operations that are not desired state,
   such as print, find, downloads, or opening DevTools.

The desired snapshot covers:

- panel surface create, bind, update, focus, visibility, bounds, and destroy;
- lease-bound materialization identity and native binding;
- native navigation and session-data desired effects where they are genuinely
  stateful; and
- product-supplied residency/retention intent.

The observed snapshot covers actual bindings, current revisions, native
crashes/navigation, and capability-dependent observations. Typed host-origin
events wake the shell to fetch a newer observation; they are not a second state
channel.

Recovery is convergence, not a separately programmed workflow. On initial
connection, reconnect, renderer replacement, lease change, or workspace switch,
the current shell generation sends its complete desired snapshot. The adapter
idempotently converges native resources and returns its observation. Generation
and revision fencing reject messages from an obsolete renderer. A disconnected
shell owns no implicit lease on product state; the adapter follows one bounded
resource-retention timeout and then tears down unclaimed resources.

Build the adapter conformance harness here, before moving `PanelManager`. It
tests idempotency, stale-generation fencing, eventual convergence, effect
deduplication, and teardown against in-memory Electron, React Native, and
headless fakes, then against real adapters as they cut over. Existing transports
may carry the envelope during migration; there is still one semantic protocol.

### A1: relocate Electron panel ownership

`workspace/apps/shell` becomes the Electron product shell and owns:

- `PanelManager` and panel-tree projection;
- product navigation and placement policy;
- collapse, focus, layout, pin, title, and search presentation state; and
- derivation of native residency/retention intent.

Electron main owns a `PanelHostAdapter` containing only native surface effects,
native observations, lease reconciliation, and the protocol transport. It does
not understand pinning, column layout, launcher ranking, or product navigation.

#### Local-state inventory and target keying

The migration must cover all current owners, not just `panels.json`:

| Current owner                 | Current data                                                                          | Current scope                                 | Target                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shellCore/localViewState.ts` | collapsed IDs, focused slot, local title projection in `local-view-state/panels.json` | implicit resolved client/workspace state path | versioned shell record keyed explicitly by device, workspace, account, and shell app identity   |
| `PanelLayoutStore`            | opaque multi-column layout                                                            | device + workspace + account                  | versioned shell record with the same explicit scope                                             |
| `PanelPinStore`               | pinned slot IDs                                                                       | device + workspace                            | versioned shell record preserving workspace scope unless a separate product decision changes it |

The local-state host capability is a generic bounded record store with quotas,
atomic replace, version, and explicit scope. It has no panel schema and does not
expose layout or pin methods.

For each old record, use the new record's existence as the natural idempotency
marker: if absent, read and validate the old JSON, atomically write the new
record, and thereafter read only the new record. No separate local migration
ledger or dual write is needed. Corrupt presentation data may reset according
to an explicit per-record policy, but one corrupt record must not silently reset
the other two.

Pins no longer feed native resource GC directly. The shell publishes a
revisioned set of retention intents through the panel-host protocol. The native
adapter combines those intents with mechanical facts it owns, such as attached
surfaces and automation leases, then applies resource caps and idle eviction.
After renderer loss it follows the common recovery policy; it never reopens a
product pin database.

### A2: finish host-adapter consolidation

After Electron runs the workspace-owned shell:

1. Carry native ingress such as pair links and panel locations as typed
   host-origin events on the authenticated protocol.
2. Replace `desktopEvents` with the canonical event domain plus a native event
   source.
3. Reduce Electron preload to authenticated transport, sealed bootstrap
   identity, and genuinely `WebContents`-local input/overlay bridges.
4. Make mobile converge the same desired/observed snapshots and lease changes
   rather than maintaining a parallel materializer contract.
5. Make headless consume the protocol directly rather than instantiate a
   product `PanelManager` with no-op dependencies.
6. Delete `createElectronShellCore`, main-process `PanelManager`, product methods
   from `view`, the native layout/pin stores, and obsolete recovery/event paths.

### Acceptance criteria

- The A0 conformance suite exists before the A1 ownership switch.
- Electron main does not instantiate `PanelManager` or read panel product state.
- Electron and mobile execute the same shared panel state machine.
- No panel product record is dual-written across renderer and main.
- Native GC consumes protocol retention intent, not `PanelPinStore`.
- Restart, renderer crash, panel crash, lease transfer, transport reconnect, and
  workspace switch converge by replaying the same desired snapshot.
- Unsupported features are absent from negotiated endowments.
- The `view` schema contains only native view effects that have not yet moved
  into the canonical protocol; it is deleted when the protocol covers them.

## Workstream B: split workspace authority state from durable presentation

### Current problem

The `workspace.state` builtin contains authority-bearing topology beside
durable product facts and disposable indexes. In particular, `slot_history`
contains the exact entity and context used for context-boundary authorization,
and navigation selects that history entry while changing the current slot
pointer in one storage transaction. Treating all “presentation history” as
userland would split an authority transaction.

Titles and access counters are also durable facts. They are not reconstructable
merely because FTS and ranking projections can be rebuilt.

### Target cut

Retain a small kernel topology/history spine containing:

- slot identity and parent/child ownership;
- current immutable history-entry identity and cursor;
- each committed entry's entity, source, and context facts;
- the entry's bounded opaque presentation payload in the same immutable row;
- prepared navigation authority facts and commit tokens;
- lifecycle leases and cleanup acknowledgements; and
- bounded ancestry and ownership projections consumed by authorization.

Move to a Base workspace service:

- all interpretation and rendering of the opaque history payload;
- user-assigned titles, tags, keywords, and other durable search facts;
- durable access/usage facts; and
- launcher and navigation presentation policy.

Keep only FTS tables, ranking indexes, caches, and denormalized search rows in
the disposable category.

Keeping the opaque payload beside the authority row is deliberate. Splitting it
would require a distributed prepare/commit protocol solely to move uninterpreted
bytes. Storage residency is not product ownership: the kernel enforces a size
bound and returns the exact bytes, but knows no payload schema, default, title,
or rendering rule. Workspace code may change that meaning. When stored payloads
must change, an agentic migration may run one offline transform limited to the
opaque field; the kernel prevents it from changing the entry identity, entity,
source, or context. No runtime compatibility reader remains afterward.

Mutable product facts do not join the navigation transaction. A user title is
written directly and durably by the presentation service. Access observations
are idempotent by immutable entry identity and can be retried or re-observed on
shell recovery. Their use in ranking does not turn them into authority facts or
require a kernel outbox.

### Migration sequence

1. Inventory every table, column, method, and transaction by the exact kernel or
   product decision that consumes it.
2. Make the kernel's history payload explicitly opaque and bounded. Remove any
   kernel interpretation while keeping the existing atomic history/cursor write.
3. Split durable product facts from derived indexes inside the existing owner;
   prove that index rebuild preserves titles, payload, and usage facts.
4. Publish the Base presentation service as the exact cutover target.
5. Use Foundation 0 to migrate durable presentation facts under an offline
   workspace gate and commit the new route.
6. Delete migrated tables, product methods, and search/ranking policy from the
   builtin. Narrow its catalog and authority manifest to the kernel spine.

### Acceptance criteria

- Every remaining builtin field has a named authority or supervision consumer.
- History selection and current-cursor mutation remain one kernel transaction.
- The immutable payload remains available with its entry without a cross-store
  commit, while the kernel has no product-specific knowledge of its contents.
- Deleting an FTS/ranking projection cannot erase titles, payload, or access
  facts and cannot change an authorization decision.
- Userland can change navigation presentation and ranking without a host build.

## Workstream C: reduce missions to immutable reviewed closures

### Current problem

The missions builtin owns mission CRUD, revisions, state transitions, run
records, approval presentation, exposure compilation, and reviewed-closure
activation. Editing currently revokes authority only because the builtin edit
method explicitly suspends its own active closure. A kernel cannot observe
arbitrary writes after mission documents move to a workspace service.

Activation also rejects non-builtin publishers and accepts presentation text
from the caller. Moving `requestReview` before changing those rules would either
fail outright or trust the new userland owner to describe its own authority.

### Target cut

A Base missions service owns documents, revisions, schedules, run presentation,
and mission policy. A small kernel closure service owns:

- canonical closure input and mechanical capability/resource compilation;
- digest calculation, verification, and exact issuer binding;
- trusted mechanical presentation of the verified exposure;
- activation, explicit suspension/replacement, retirement, and session binding.

An activated closure is immutable authority independent of later document
edits. Editing a mission creates a new inactive revision. The previous closure
remains active until an explicit kernel suspend or atomic replace operation.
The product UI must show that distinction rather than imply that editing a
draft changed active authority.

Automatic edit-driven revocation is deliberately not a target. Requiring it
would force a kernel-owned mission revision commitment/CAS and make revision
state partly kernel-owned again.

### Migration sequence

1. Define canonical closure input independent of mission domain models.
2. Make the kernel mechanically render the exact verified authority facts;
   remove caller-authored authority presentation.
3. Replace builtin-only publication with authentication of an exact installed,
   reviewed workspace publisher and issuer. Do not broaden publication to
   arbitrary workspace callers.
4. Implement immutable activation plus explicit suspend/replace and update the
   UI semantics while mission data still has its old owner.
5. Publish the Base missions service and move `requestReview` only after steps
   1–4 are active, or land that boundary atomically.
6. Use Foundation 0 to migrate mission documents, revisions, schedules, and run
   facts to the Base service.
7. Delete mission CRUD tables, edit-triggered suspension, domain compilation,
   and mission-specific approval copy from the kernel.

### Acceptance criteria

- The closure kernel contains no mission title, charter, scheduling, or UX
  policy.
- A malicious missions service cannot omit or soften an authority fact or
  publish as an unreviewed issuer.
- Editing produces an inactive revision and cannot silently mutate active
  authority.
- Suspend and replace are explicit kernel transactions with exact closure
  identities.
- The product clearly distinguishes the active closure from newer drafts.

## Workstream D: decompose browser data into vault and product services

### Current problem

The browser-data builtin combines passwords, form-fill secrets, cookies,
bookmarks, history, favicons, site preferences, search engines, downloads, and
import-job state. Protected secrets justify durable kernel storage; ordinary
browser product records do not inherit that justification.

### Target cut

Create two explicit stores:

1. A host-protected browser vault for passwords, sensitive form-fill values,
   protected cookie material where required, encryption, backup, and recovery.
2. A Base browser-data service for bookmarks, history, favicons, search
   engines, site preferences, download presentation, and import progress.

The vault exposes typed record effects with caller and origin scoping. It does
not expose browser-product workflows such as import jobs or bookmark folders.
Native browser projection remains a client-adapter effect.

### Migration sequence

1. Threat-model every record family and record why compromise or loss requires
   host protection, workspace durability, or only a rebuildable projection.
2. Define vault schemas, encryption/backup invariants, and narrow effect APIs.
3. Define userland durable facts separately from rebuildable browser indexes.
4. For workflows spanning both stores, keep coordination in userland and use
   idempotent vault operation identities plus durable workflow receipts. Do not
   introduce dual writes or a host-owned import workflow.
5. Publish the Base product service as the exact cutover target.
6. Use Foundation 0 under one offline gate to split and verify record families,
   then commit both required routes.
7. Delete the monolithic builtin and register only the protected vault.

### Acceptance criteria

- Workspace code never receives bulk vault contents without an explicit
  reviewed operation.
- Browser presentation features are deployable as Base/workspace changes.
- Bookmarks, history, preferences, and import state are treated as durable
  product facts, not disposable indexes.
- Import, backup, restore, and native cookie projection have one coordinator
  each and idempotent cross-store effects.
- No post-commit read or write falls back to the monolithic store.

## Workstream E: thin mobile and Electron recovery surfaces

### Current problem

The shipped mobile bootstrap is a substantial secondary application containing
pairing, reconnection, approval, and launch behavior. Electron's launch gate is
smaller, but recovery behavior is separately assembled by platform.

### Target cut

After Workstream A defines normal protocol recovery, shipped clients contain
only:

- bundle selection, integrity and ABI verification;
- pairing sufficient to reach an approved workspace app;
- a bounded mechanical approval renderer needed before that app exists; and
- reset, diagnostics, and recovery operations.

The common pre-app launch/recovery state machine lives in a neutral package.
Platform renderers remain small and native-idiomatic. Recovery cannot become a
second normal product shell.

### Acceptance criteria

- Recovery code cannot enter the normal post-launch product state.
- The shipped bootstrap has no panel tree, settings, or ordinary shell flows.
- Approval facts and actions are identical across launch gates.
- Activating an approved app leaves no live recovery transport, native
  retention intent, or duplicate event subscriber.
- Normal reconnect and lease loss use Workstream A's protocol rather than the
  launch-recovery surface.

## Workstream F: reconsider the development builtin

### Current problem

`developmentNative` is already a good exact-effect boundary, but the development
builtin owns a large durable product workflow for sessions, recipes, runs,
repair attention, and target selection. Its `durable-data` justification does
not establish why all of that workflow must be immutable host code.

### Target cut

Keep exact native effects and receipts in the host:

- exact repository materialization and build execution;
- owned process and terminal handles;
- executor attestation and attached-host publication; and
- effect inspection, stop, recovery, and retirement.

Move development workflow and presentation to a Base workspace service. If
durable recovery records must survive workspace code changes, introduce a
generic host-owned execution ledger containing opaque state-machine receipts,
not a development-domain service.

Use the same rule as workspace history: the ledger retains only the exact facts
needed to identify, fence, inspect, and retire native effects. Recipe selection,
pagination, retry policy, and repair presentation remain userland facts.

### Acceptance criteria

- The native service accepts exact identities on every effect.
- Workspace workflow cannot forge process/build receipts.
- Recipe selection, pagination, UX state, and repair presentation are not host
  concerns.
- Crash recovery uses the generic ledger or native effect inspection, not a
  second copy of the product workflow.

## Delivery graph

The dependency order is:

```text
Foundation 0: durable-owner cutover
  |-- stateless Base route proof
  `-- durable transfer crash proof

Workstream A0: desired/observed client-host envelope + harness
  `-- A1: Electron PanelManager relocation
       `-- A2: mobile/headless/event/preload consolidation
            `-- E: thin launch/recovery surfaces

Foundation 0 durable proof
  |-- B: workspace authority/presentation split
  |-- C: missions closure split
  `-- D: browser vault/product split

B authority-boundary patterns + Foundation 0
  `-- F: development workflow re-evaluation
```

Recommended landing order:

1. Implement the offline upgrade gate, receipt-backed route commit, and skipped
   upgrade behavior.
2. Prove the Base route with stateless phone provisioning, then prove a durable
   transfer with crash injection.
3. Land A0's minimal desired/observed protocol envelope, generation fencing,
   and adapter conformance harness.
4. Relocate Electron `PanelManager` and all three local-state owners in A1.
5. Finish mobile, headless, event, and preload consolidation in A2.
6. Split workspace state around its authority-bearing history spine.
7. Land mechanical closure rendering and immutable activation, then move
   missions.
8. Split browser vault and browser product data.
9. Thin pre-app recovery surfaces.
10. Re-evaluate development workflow after the generic migration and execution
    receipt patterns have proven themselves.

Steps 6–8 may be designed in parallel after their prerequisites, but each
durable owner cutover uses the same offline primitive. They must not invent
service-specific fallback routes or new migration channels.

## Evidence and verification

Every ownership workstream must produce:

- an old-owner/new-owner inventory at method, field, table, durable object, and
  native-resource granularity;
- an authority data-flow naming the exact kernel decision that consumes every
  retained fact;
- a classification of durable product facts versus rebuildable projections;
- for operations that genuinely span stores, a protocol table listing operation
  order, idempotency identity, crash points, replay, and orphan cleanup;
- an exact Base release and required-route proof for every new workspace unit;
- an immutable source fixture, cutover-specific semantic verifier, committed
  owner receipt, and skipped-upgrade fixture for every durable move;
- focused unit tests for the new owner and proof that old routes are absent;
- generated authority/catalog checks;
- client-host conformance tests where applicable;
- the smallest exact headless system test for the affected user workflow;
- crash/restart/reconnect/workspace-switch testing whenever ownership or local
  presentation state changes; and
- a final residency census showing the deleted host surface and any bounded
  migration-only adapter that remains.

For durable cutovers, inject failure after freeze, after target preparation,
after verification, immediately before route commit, and immediately after
route commit. Verification is incomplete until every restart chooses exactly
one owner.

Method and line-count reductions are evidence, not the acceptance condition.
The decisive evidence is that product behavior has one workspace owner, atomic
authority facts remain together, migrations cannot lose writes, and the
remaining host contract consists only of irreducible facts and effects.

## Explicit non-goals

- Moving an authority-bearing field merely because it also affects
  presentation.
- Treating user titles, payload, counters, pins, or layout as rebuildable cache.
- Using agentic migration notes to attest host-owned storage movement.
- Preserving a routable builtin as a safety fallback after cutover.
- Giving extensions implicit service authority or using them as a second Base
  distribution channel.
- Designing one client protocol per platform.
- Completing all extractions in one host/Base release.

The minimal-host goal remains intact. Authority atomicity, deterministic owner
transfer, and native lifecycle reconciliation are legitimate kernel
responsibilities; retaining them is not host-surface metastasis.
