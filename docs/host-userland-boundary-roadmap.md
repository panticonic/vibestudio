# Host/userland boundary roadmap

Status: proposed pre-release architecture work, revised 2026-08-12 for clean cuts

This document describes the remaining high-value boundary work after the small
host-surface extractions landed in August 2026. It assumes the external-Base
cutover in `docs/external-base-cutover-and-self-development-plan.md` and the
pre-release policy in `docs/agentic-upgrade-migrations-plan.md`.

`docs/host-residency-redesign.md` is historical context, not the specification.

## Objective

The host should be a small authority and effect kernel. It owns facts and
effects that workspace code cannot safely, durably, or independently own:

- authenticated runtime identity and authority admission;
- protected credentials and approval/grant records;
- exact-context repository and build attestation;
- process, native view, OS, and device effects;
- runtime supervision, leases, recovery, and cleanup; and
- sealed application loading and one current client-host protocol.

Workspace code owns product policy, presentation, orchestration, and mutable
application behavior. An extension owns a reviewed local native provider when a
workspace feature needs filesystem, process, or device access but does not need
to become host kernel.

The target is not a low method count for its own sake. Each host method must
represent one irreducible authority fact or native effect, and ordinary product
changes must not require a host release.

## Pre-release cut rule

All workstreams in this roadmap land before the first supported release. They
use coordinated destructive cuts, not migration infrastructure:

1. Define the target owner and current schema.
2. Implement and validate the target against freshly created workspaces.
3. Bump `systemEpoch` for any host/workspace ABI change.
4. Republish Base and every official template at that exact epoch.
5. Switch the only route to the target and delete the old route, reader,
   writer, schema, and storage code in the same release series.
6. Delete and recreate controlled workspaces.

There is no old-owner/new-owner coexistence protocol, maintenance admission,
route receipt, storage-transfer envelope, skipped-upgrade adapter, or downgrade
path. Pre-release internal databases and runtime state are disposable. Valuable
user-level facts may be exported explicitly before the cut and imported through
the fresh product's current interface; obsolete internal stores are not
translated.

This includes Durable Object schemas. Delete the current generic
production-baseline, ordered-migration, migration-ledger, retained-fixture, and
Build V2 migration-chain machinery. The replacement is smaller: initialize a
truly empty store at the one canonical current schema; validate exact version
and shape on later opens; reject every other store unchanged. Host SQLite
stores already follow this model and provide the reference behavior.

If any workstream slips past the first supported release, stop. Its destructive
sequence is no longer authorized. Re-plan it from the actual durable user data
and availability requirements rather than reviving the speculative migration
design removed from this roadmap.

## Ownership model

Classify every record and operation before moving code:

| Category                        | Owner                       | Examples                                                                                        | Current-generation recovery                                                   |
| ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Authority and supervision facts | Host kernel                 | slot/entity/context binding, immutable history identity, active closure digest, lease ownership | Kernel transaction/log recovery; never reconstructed from product projections |
| Protected user facts            | Host kernel or narrow vault | credentials, grants, protected cookies, encryption metadata                                     | Current vault backup/re-authentication; no old-format importer                |
| Durable product facts           | Workspace service/app       | titles, navigation payload, pins, layout, access counters, mission documents                    | Current service persistence and ordinary product export/import                |
| Derived projections             | Workspace service/app       | FTS, ranking indexes, denormalized search rows                                                  | Delete and rebuild from current durable facts                                 |
| Native runtime resources        | Client-host adapter         | `webContents`, `WebView`, `Page`, processes, CDP sessions                                       | Reconcile from current protocol state and leases                              |

Presentation is not synonymous with disposable. Persistence alone does not
justify kernel ownership. Residency follows the exact authority decision or
effect that consumes the fact.

## Non-negotiable boundary rules

1. Move an owner, not one call site. The result has one writer and one route.
2. Never bridge a boundary with compatibility shims, dual writes, translation
   fallbacks, parallel transports, or a second product service.
3. Keep every fact needed by an atomic authority decision in one kernel
   transaction. Userland may refer to an opaque kernel identity; it may not
   become a second authority source.
4. Prefer a narrow effect contract over a product facade. `setNativeZoom` is a
   host effect; applying a user's site preference is workspace policy.
5. Client hosts implement one semantic protocol. Electron, React Native, and
   headless pages are adapters, not separate product architectures.
6. Optional native behavior is negotiated as an endowment, never represented by
   throwing stubs or no-op product adapters.
7. Delete old routes and special cases when the new owner lands.
8. Exact epoch equality is the only declared host/workspace generation gate.
   Typed contracts and Build V2 prove the exact current composition.
9. Current-generation crash recovery may use leases, CAS, and idempotent effect
   receipts. It must not parse or translate an obsolete generation.
10. Verify authority, recovery, workspace switching, and fresh provisioning;
    representative old state must fail closed.
11. Persistent schemas are empty-or-exact-current. There are no production
    baselines, ordered migration callbacks, migration ledgers, or retained
    migration fixtures.

## Where agentic intelligence replaces machinery

Use agents for semantic current-generation work:

- deciding the honest host/userland boundary;
- editing Base manifests, service declarations, and imports;
- fixing the exact candidate until type/static/build checks pass;
- rebuilding derived projections;
- interpreting ambiguous product behavior and escalating instead of guessing;
- selecting useful product-level data to export before a destructive cut; and
- reviewing the coordinated host/Base/template release.

Do not build version matrices, migration DSLs, host-side semantic planners,
universal schema registries, or old-shape importers. Agentic intelligence is not
a reason to admit obsolete internal state; it keeps the current system simple.

## Foundation 0: current-generation route and catalog discipline

The original roadmap proposed a durable-owner cutover envelope because it
assumed existing workspaces had to survive host-owner removal. That assumption
does not hold pre-release. The required foundation is smaller:

1. Runtime service catalogs distinguish host contracts from concrete providers.
2. Each service key resolves to exactly one provider in the effective current
   build.
3. Workspace providers may replace removed builtins; builtins do not silently
   shadow them.
4. Duplicate providers fail Build V2 before activation.
5. A host release that removes a provider is promoted only with an exact Base
   release whose fresh composition provides the replacement.
6. The host, Base, and all optional templates carry one exact epoch.
7. Fresh provisioning proves the selected route end to end.
8. Old workspaces are rejected and recreated; no route is inferred from their
   historical lineage.

This is admission of one current configuration, not a compatibility system.

### First proof: phone provisioning

Use phone/device provisioning as the first route proof because it exercises a
real host-to-workspace provider boundary without requiring valuable durable
pre-release data.

1. Separate the host protocol contract from builtin provider registration.
2. Publish the exact Base provider and declare its authority.
3. Make Build V2 prove that the effective Base has exactly one conforming
   provider.
4. Remove the builtin provider and its catalog entry.
5. Bump the epoch and republish official templates.
6. Recreate a fresh workspace and prove provisioning end to end.
7. Verify that a missing, duplicate, or locally deleted provider fails before
   product startup.

### Foundation acceptance

- Fresh current-generation workspaces select exactly one provider per key.
- Builtins cannot shadow workspace providers.
- Missing or duplicate providers fail mechanically.
- Host removal and Base addition are tested as one exact release set.
- Old-epoch fixtures fail closed without maintenance startup.
- No owner-transfer or compatibility artifacts exist.

## Target execution stack

```text
Workspace product service / app
  -> typed current-generation host contract
    -> receiver-enforced authority
      -> narrow host kernel effect or fact

Client presentation
  -> one desired/observed protocol
    -> Electron | React Native | headless adapter
```

The host never needs to understand product workflow to provide a native effect.
The workspace never gains authority merely by presenting desired state.

## Workstream A: one client-host protocol and workspace-owned panel shell

### Current problem

Panel lifecycle and presentation are split across Electron `PanelManager`,
mobile/headless paths, preload/event bridges, and workspace product code.
Different transports carry overlapping semantics, and host-local persistence
can become a second product state.

### A0: convergent desired/observed envelope

Define one generation-fenced protocol:

- client sends a complete desired snapshot for the current workspace and shell
  generation;
- adapter returns revisioned observed native state;
- stale generations and revisions are rejected;
- reconnect resends desired state rather than replaying imperative history;
- unsupported capabilities are absent negotiated endowments; and
- native resource identities and leases remain adapter-owned.

Build a conformance harness with in-memory, Electron, mobile, and headless
adapters. Existing transports may carry the envelope only until the same
current release deletes their old semantic messages; there is never a runtime
choice between protocols.

### A1: relocate Electron panel ownership

Move product behavior out of `PanelManager`:

- workspace shell owns layout, selection, titles, grouping, and presentation
  policy;
- Electron adapter owns `webContents`/view creation, attachment, native bounds,
  focus, zoom effect, teardown, and process identity;
- kernel retains only authority and lifecycle facts needed to validate effects.

Inventory and eliminate all current local-state owners, not merely
`panels.json`. Land the new envelope and deletion atomically in the coordinated
epoch release; recreate workspaces rather than importing old panel state.

### A2: consolidate mobile, headless, event, and preload paths

- Mobile and headless implement the same envelope and endowments.
- Preload exposes transport, not product policy.
- Event projection is derived from observed protocol state.
- Legacy event/message forms are deleted.
- There are no platform-specific product services or no-op adapters.

### Acceptance

- The shell can converge after reconnect from desired plus observed state.
- A stale client cannot mutate current native resources.
- Workspace switching cannot leak a view/process across generations.
- Unsupported features are absent, not represented by failure stubs.
- Source search finds one semantic protocol and no legacy message readers.

## Workstream B: split workspace authority from presentation

### Current problem

`workspace.state` contains authority-bearing topology beside product facts and
derived indexes. `slot_history` binds the exact entity/context used by
authorization while titles, access counters, search policy, and ranking are
product behavior.

### Target cut

Retain a small kernel topology/history spine:

- slot identity and parent/child ownership;
- current immutable history-entry identity and cursor;
- each entry's entity, source, context, and bounded opaque payload;
- prepared navigation authority facts and commit tokens;
- lifecycle leases and cleanup acknowledgements; and
- bounded authority projections.

Move to a Base service:

- interpretation/rendering of the opaque payload;
- titles, tags, keywords, and durable search facts;
- access/usage facts; and
- launcher/navigation presentation policy.

FTS, ranking indexes, caches, and denormalized rows are rebuildable.

### Clean-cut sequence

1. Inventory each table, column, method, and transaction by consumer.
2. Make the kernel payload opaque and bounded while preserving its atomic
   history/cursor transaction.
3. Define the fresh Base service and current product schema.
4. Prove projection rebuilds from current-format fixtures.
5. Delete product tables/methods/policy from the builtin.
6. Bump epoch, republish, and recreate workspaces. Do not copy the obsolete
   builtin store.

### Acceptance

- Every remaining builtin field has a named authority/supervision consumer.
- History selection and cursor mutation remain one kernel transaction.
- Kernel has no title, ranking, or product-payload interpretation.
- Userland can change presentation without a host build.
- No old-store reader or transfer operation exists.

## Workstream C: reduce missions to immutable reviewed closures

### Current problem

The missions builtin owns documents, revisions, schedules, runs, approval
presentation, exposure compilation, and authority activation. Editing currently
revokes authority only because the builtin owns both product and kernel state.

### Target cut

A Base missions service owns documents, revisions, schedules, run presentation,
and policy. A kernel closure service owns:

- canonical closure input and mechanical capability/resource compilation;
- digest verification and exact issuer binding;
- trusted mechanical presentation of verified exposure; and
- activation, suspension/replacement, retirement, and session binding.

An activated closure is immutable. Editing creates a new inactive revision;
the previous closure changes only through explicit suspend/replace.

### Clean-cut sequence

1. Define canonical closure input independent of mission models.
2. Make the kernel render mechanical authority facts.
3. Authenticate one exact installed/reviewed workspace publisher.
4. Implement immutable activation and explicit suspend/replace.
5. Publish the Base missions service.
6. Delete mission product tables, CRUD, compilation, and UX copy from kernel.
7. Bump epoch and recreate; old mission data is not imported.

### Acceptance

- Kernel contains no mission title, charter, schedule, or UX policy.
- A workspace service cannot omit authority facts or forge issuer identity.
- Editing cannot mutate active authority.
- Product clearly distinguishes active closure from draft.
- No old mission-store reader remains.

## Workstream D: split browser vault from product data

### Current problem

The browser-data builtin combines passwords, form secrets, cookies, bookmarks,
history, favicons, preferences, search engines, downloads, and import state.

### Target cut

Create:

1. a host-protected vault for passwords, sensitive form values, protected
   cookie material, encryption, backup, and recovery; and
2. a Base browser-data service for bookmarks, history, favicons, search
   engines, preferences, download presentation, and import progress.

The vault exposes narrow typed effects with caller/origin scoping. It does not
expose browser product workflows.

### Clean-cut sequence

1. Threat-model each record family and assign its target owner.
2. Define one current vault schema and narrow effect API.
3. Define one current product schema and rebuildable indexes.
4. Keep cross-store workflow in userland with idempotent current-generation
   vault operation identities.
5. Publish the Base product service and delete the monolithic builtin.
6. Bump epoch, recreate workspaces, and require re-authentication/re-import.
   Do not translate the old vault or product store.

### Acceptance

- Workspace code cannot bulk-read vault contents.
- Browser product features deploy as Base changes.
- Product facts are durable in their current owner, not mislabeled as cache.
- Each cross-store workflow has one coordinator.
- No old monolithic route or reader remains.

## Workstream E: thin mobile and Electron recovery surfaces

Recovery surfaces run before arbitrary workspace apps and therefore remain
narrow native infrastructure:

- load sealed current-generation recovery UI;
- expose the same mechanical approval facts/actions as normal UI;
- negotiate current protocol/endowments;
- activate the approved app; and
- tear down every recovery transport and native retention intent.

Normal reconnect and lease loss use Workstream A. Recovery never parses old
workspace formats or becomes a second product shell.

### Acceptance

- Recovery UI cannot host general workspace product behavior.
- Approval facts/actions match normal launch gates.
- Activation leaves no duplicate transport/subscriber.
- Old-epoch state fails before recovery tries to interpret it.

## Workstream F: reduce the Development builtin

### Current problem

`developmentNative` is close to an exact-effect boundary, but the Development
builtin owns product workflow for sessions, recipes, runs, repair attention,
and target selection.

### Target cut

Keep exact native effects and receipts in host:

- exact repository materialization and build execution;
- owned process and terminal handles;
- executor attestation and attached-host publication; and
- effect inspection, stop, recovery, and retirement.

Move pair selection, recipes, retries, pagination, repair UX, and presentation
to Base. A generic execution ledger may retain opaque facts needed to identify,
fence, inspect, and retire native effects; it does not model Development
workflow.

This minimal slice lands early enough to support external-Base
self-development without enlarging the temporary builtin.

### Acceptance

- Every native effect accepts exact identities.
- Workspace workflow cannot forge process/build receipts.
- Recipe and repair policy are userland.
- Crash recovery inspects generic exact effects, not a second workflow model.

## Delivery graph

```text
External Base: exact source + current-only schemas
  -> Foundation 0: exact provider/catalog discipline
       -> phone provisioning proof

Workstream A0 protocol + harness
  -> A1 Electron panel cut
     -> A2 mobile/headless/event/preload consolidation
        -> E thin recovery surfaces

Foundation 0
  -> B workspace authority/presentation split
  -> C missions/closure split
  -> D browser vault/product split

External-Base self-development
  -> early F Base-owned pair workflow
```

Recommended order:

1. Land external-Base exact-source and current-only format contracts.
2. Land provider/catalog discipline and fresh phone provisioning proof.
3. Move pair workflow/presentation to Base and keep narrow exact host effects.
4. Externalize Base and delete in-tree `workspace/`.
5. Land A0, A1, A2, and E.
6. Land B, C, and D as separate epoch-coordinated destructive cuts.
7. Finish any remaining Development extraction.
8. Complete all boundary cuts before declaring a supported release.

Each cut republishes the official template set and recreates controlled
workspaces. It does not share a migration primitive because none exists.

## Evidence and verification

Every workstream produces:

- an old-owner/new-owner inventory at method, field, table, object, and native
  resource granularity;
- an authority data flow naming the kernel consumer of every retained fact;
- a classification of durable product facts versus projections;
- the exact Base release and fresh provider proof;
- focused tests for the new owner and proof old routes are absent;
- generated authority/catalog checks;
- client-host conformance tests where applicable;
- the smallest exact managed headless test for the user workflow;
- crash/restart/reconnect/workspace-switch tests for current-generation state;
- a representative old-state fixture that fails closed; and
- a final source/residency census with no compatibility reader or adapter,
  including no Durable Object migration definition or ledger.

Method and line-count reductions are evidence, not acceptance. The decisive
facts are one product owner, co-located authority facts, one current protocol,
and a host surface made only of irreducible authority and effects.

## Explicit non-goals

- Preserving pre-release internal workspace state.
- Building migration, maintenance-admission, downgrade, or skipped-upgrade
  infrastructure.
- Moving an authority fact merely because it affects presentation.
- Treating product facts as cache in the current target architecture.
- Preserving a builtin as fallback after its replacement lands.
- Giving extensions implicit service authority or a second Base channel.
- Designing one client protocol per platform.
- Carrying compatibility adapters into steady state—or creating them for the
  cutover window.
- Completing all extractions in one commit. They may be separate clean cuts,
  but all finish before the supported release.
