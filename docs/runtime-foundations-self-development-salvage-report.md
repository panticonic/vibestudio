# Runtime Foundations and Self-Development Salvage Report

Status: implemented specification — revision 2\
Date: 2026-07-27\
Source reviewed: `origin/refactor/runtime-foundations-self-development` at
`2cc9746b127443a859bdf8d14e07846b08c31900`\
Target architecture: current semantic-workspace mainline\
Verification baseline: `optimization` at `69991d51c318ffbabc687ca7c61712bdeb75f0c7`

## Implementation outcome

All six work packages described by this report are implemented on the current
semantic-workspace architecture. Where an investigative or candidate-design
passage below describes a pre-salvage API, the shipped contracts are
authoritative: [`skills/vibestudio-agent/API.md`](../skills/vibestudio-agent/API.md),
[`workspace/skills/sandbox/EVAL.md`](../workspace/skills/sandbox/EVAL.md), and
[`docs/channel-lifecycle-contract.md`](channel-lifecycle-contract.md). The
implementation retains one public eval execution method (`start`), owner-scoped
`get`/`events`/`cancel` controls, completion push for agents, and
`events.watch` for live observers; it does not retain the former `run`,
`startRun`, or `getRun` service methods.

## Executive decision

The source branch must not be merged or broadly cherry-picked. It is an
alternative platform epoch, not a delayed feature branch.

Its useful work falls into three classes:

1. **Already incorporated and evolved.** Exact executable identity,
   compositional authority, generated authority audits, routed client identity,
   durable system-test evidence, local-model ownership, and explicit first-model
   setup now exist in newer forms.
2. **Still valuable, but architecturally incompatible as code.** In-workspace
   Vibestudio development and explicit per-run eval attenuation remain valuable
   product ideas. Their branch implementations depend on the removed GAD store,
   old capability catalogs, filesystem-diff reconstruction, and obsolete
   transport assumptions. They must be re-derived on the semantic workspace.
3. **Concrete safeguards that were lost.** The branch checked that generated
   runtime ledgers named real evidence. Main retained the ledgers but lost that
   validation. The branch also articulated authoritative execution-retention
   roots and explicit channel structure revisions more strongly than the current
   implementation proves.

This report specifies six work packages:

- RFS-0: immediate execution-artifact retention repair;
- RFS-1: generated-ledger evidence integrity;
- RFS-2: authoritative execution-artifact retention and two-collector
  reachability;
- RFS-3: channel lifecycle contract reconciliation;
- RFS-4: semantic in-workspace Vibestudio development;
- RFS-5: one handle-based, per-run-attenuated eval lifecycle.

RFS-0 is a bounded correctness repair for a live data-loss path and ships
independently and first. RFS-1 is a small correctness repair. RFS-2 is an
architecture program with implementation gates. RFS-3 is a decision-gated audit
whose implementation is conditional. RFS-4 is the principal product salvage.
RFS-5 is a clean API convergence that no longer waits on RFS-4.

## Revision history

Revision 1 was reviewed against the tree at `69991d51`; its factual claims held
up but its sequencing and two designs did not. Revision 2 was then reviewed
twice more — once for UX and agent ergonomics, once adversarially against the
implementation — and several of its own specifications proved wrong. Both passes
are folded in here.

Structural changes:

1. **RFS-0 extracted, then narrowed to report-only.** Revision 1 described the
   build GC as not _proving_ preservation of rollback candidates; verification
   showed it actively destroys them (§4). Revision 2's repair kept a guarded
   sweep — which was itself unprovable, because root collection and deletion are
   not serialized (§6.1). RFS-0 now removes the deletion path entirely and
   accepts bounded, visible storage growth until RFS-2.
2. **Two-collector handshake specified, then corrected.** Revision 1 covered the
   interaction between execution GC and semantic VCS GC in one sentence.
   Revision 2 specified an ordering that manufactured the exact
   `reconstructible: false` condition RFS-2 exists to prevent, and an age
   inequality pointing the wrong way. §21.4 rule 6 now keeps source alive
   through quarantine by reachability rather than timing.
3. **Execution source identity split.** A `VcsStateNodeRef` is semantic
   provenance; `runGc` traverses content roots. Revision 2 conflated them, so
   its `executionSourceRoots` could not have driven a sweep. §20.1 carries both
   identities for their different consumers.
4. **RFS-5 resequenced and de-scoped.** Revision 1 gated eval convergence behind
   RFS-4C. Revision 2 unblocked it but reserved attached-host scaffolding —
   speculative shimming that contradicted invariant 2. RFS-5 now models local
   eval only.
5. **Ledger evidence validation redesigned twice.** Revision 1 parsed test
   source. Revision 2 dynamically imported evidence modules, which would have
   executed excluded `workspace/**` suites inside the host project. §13 now uses
   a reporter over normally-executing tests.
6. **RFS-4 corrected at the root.** `runtime.cloneContext` clones durable
   entities and refuses a context with none — the wrong primitive, failing in
   the common case (§36.1). Source adoption, never specified, is now a named
   precondition (§34.1).
7. **RFS-4C security gate added; 4D and 4E freed from it.** The threat model is
   a delivery precondition (§51), but the current-host client and native
   checkpoints need only a local executor and no longer queue behind it (§68).

Ergonomics changes, from the UX and agent-ergonomics pass:

8. **The eval completion push is preserved and primary** (§56.1). Revision 2's
   `start -> get/events` diagram would have converted the hottest agentic path
   into a polling loop.
9. **Run identity is caller-owned** (§57.1). A server-assigned id keyed by an
   opaque idempotency key leaves a crashed caller unable to address its own run.
10. **`execute` works over a raw call function** (§56.2), because the harness and
    the vessel both call by method name and would otherwise hand-roll settle.
11. **No gratuitous renames.** `timeoutMs` and top-level `reset` keep their
    names; the agent tool's schema and description are part of the migration
    (§64.1).
12. **The standing development grant ships in RFS-4A** (§40.1). Snapshot-bound
    approval alone prompts on every iteration of an inherently iterative loop.
13. **`requires-repair` has an exit** (§50.1), and new failure channels have
    named subscribers (§6.4, §25).
14. **Live output is pushed, not polled** (§61.1).
15. **Relationship facts are derived, never supplied** (§57.2). Revision 2's
    unconstrained `channelId` was a confused-deputy regression against a service
    that already derives channel identity from the verified binding.

Corrections: the eval disposal method is `dispose`, not `release`; there are
three ledgers plus one dependency graph; `AppRegistryEntry.activeBundleKey` and
`HostTargetSelection.buildKey?` are the canonical field names (§6.2);
`closeSession` and `stop` carry idempotency keys (§42).

## 1. Review evidence

### 1.1 Topology and size

The branch and main share merge base
`d54c7596927db0f258d4d3fcf57a044068fe2957` from 2026-07-14.

At review time:

- the source branch had 11 unique commits after the merge base;
- `origin/main` had 162 commits after the merge base (163 by the time revision 2
  was verified — this row is a snapshot of a moving branch, unlike the fixed
  `optimization` verification baseline in §1.3);
- the active `optimization` branch had 186 commits after the merge base;
- the source branch changed 840 files with 220,756 insertions and 17,731
  deletions;
- the source branch tip and `origin/main` differed in 2,395 files;
- only 17 source-branch-touched paths were byte-identical at both tips;
- 178 files present at the source branch tip were absent from main;
- a synthetic merge reported 453 conflicts: 369 content conflicts, 57
  modify/delete conflicts, and 27 add/add conflicts;
- `git cherry` found no patch-equivalent source-branch commit on main.

The size is inflated by generated ledgers and authority manifests, but the
conflict shape is architectural: public VCS, runtime identity, eval, channels,
transport, authority, and workspace storage all changed independently.

### 1.2 Commit disposition

| Source commit | Original purpose                                              | Current disposition                                                                                                                                                            |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bfa8c526`    | Exact authority and execution roots                           | Core identity and authority ideas landed through later semantic-runtime work. Its ledger test and retention-root discipline remain valuable.                                   |
| `9fed6d91`    | Workspace adoption and self-development surfaces              | Authority projection partly fed later work. Dev host, context synchronizer, GAD repository reducer, and terminal-control additions did not land and are not directly portable. |
| `09d6b682`    | Shared direct client and transport convergence                | Superseded by routed connectivity, negotiated RPC sessions, and current CLI/desktop lifecycle work.                                                                            |
| `ea4f3fe2`    | End-to-end developer workflow tests                           | Superseded by current desktop and system-test coverage.                                                                                                                        |
| `9efc4fed`    | Runtime, self-development, and eval plans plus ledgers        | Three generated ledgers were later copied nearly unchanged. The plans remain useful as requirements archaeology but are not current contracts.                                 |
| `c91d7069`    | Complete authority and runtime lifecycle foundations          | Superseded by semantic capabilities, invocation snapshots, current runtime images, and host lifecycle ownership.                                                               |
| `354a1cc9`    | Asynchronous authority-aware eval                             | Durability, cancellation, acquisition, and owner isolation mostly landed. One public lifecycle and explicit per-run attenuation did not.                                       |
| `0be9ddfc`    | Hermetic repository reducer and owner-controlled local models | Repository reducer is obsolete after semantic VCS. Local-model owner control was independently reimplemented.                                                                  |
| `49aee35f`    | Explicit provider setup choice                                | Reimplemented more fully by current model-readiness and onboarding flows.                                                                                                      |
| `e4f1a650`    | Inspectable system-test failures                              | Closely succeeded by `4e71cb65` and later system-test debugging work.                                                                                                          |
| `2cc9746b`    | Regenerated capability/workspace metadata                     | Obsolete raw catalogs were replaced by reviewed semantic authority requests.                                                                                                   |

Range-diff identifies three especially direct lines of descent:

- `9fed6d91` into `e84edd48`;
- `e4f1a650` into `4e71cb65`;
- `9efc4fed` into `cbd207bf`.

This explains why parts of the branch appear on main even though the branch was
never merged.

### 1.3 Verified current-tree baseline

Every claim below was checked against `69991d51`. Re-verify before starting a
package; these are the facts the specifications depend on.

| Claim                                                          | Verified at                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Seven dangling evidence references across five missing files   | `docs/runtime-foundations/*.json` and `scripts/generate-runtime-foundation-ledgers.mjs`                             |
| Generator performs no evidence-path validation                 | `scripts/generate-runtime-foundation-ledgers.mjs` (900 lines; no `existsSync` over `parityAssertion` targets)       |
| Evidence check gates normal quality and test runs              | `package.json:47,67,74`                                                                                             |
| `build.gc` accepts a caller-supplied unit list                 | `src/server/services/buildService.ts:123`                                                                           |
| Only the current effective build key per unit is retained      | `src/server/buildV2/index.ts:1456-1466`                                                                             |
| Every other build directory is recursively removed             | `src/server/buildV2/buildStore.ts:814-830`                                                                          |
| App rollback history is five deep and keyed by build key       | `src/server/appHost.ts:99,119,1018-1023`                                                                            |
| Rollback resolves artifacts through the build store            | `src/server/appHost.ts:1202`                                                                                        |
| `build.gc` is reachable from userland eval                     | `packages/shared/src/authority/hostAuthorityCatalog.generated.ts`; `docs/runtime-foundations/authority-ledger.json` |
| Semantic content GC is a separate scheduled collector          | `src/server/services/vcsGcScheduler.ts:8-46`                                                                        |
| Content GC root set omits execution artifact source states     | `src/server/vcsHost/workspaceVcs.ts:255-283`                                                                        |
| This codebase already lost data to a missing GC root class     | `src/server/vcsHost/workspaceVcs.ts:274-280` (comment records the cached-view incident)                             |
| Eval exposes two public execution shapes                       | `packages/service-schemas/src/eval.ts:264,285,292`                                                                  |
| Eval disposal method is `dispose`, not `release`               | `packages/service-schemas/src/eval.ts:278`                                                                          |
| Both eval shapes have live consumers                           | `workspace/packages/harness/src/tools/eval.ts:227`; `workspace/packages/agentic-do/src/agent-vessel.ts:4207`        |
| `ChannelStructureRevision` is absent; locked membership is not | `workspace/workers/pubsub-channel/types.ts:92`                                                                      |
| Developer instance supervisor exists                           | `src/dev/instanceRegistry.ts`; `src/dev/runInstance.ts`                                                             |
| Runtime image records already carry execution identity         | `src/server/runtimeImageStore.ts:14-27`                                                                             |

## 2. Current architectural baseline

The specifications below build on these current contracts.

### 2.1 Semantic workspace is authoritative

The sole public VCS registry is `vcsMethods` in
[`packages/service-schemas/src/vcs.ts`](../packages/service-schemas/src/vcs.ts).
It owns stable repository/file identity, exact state references, explicit
move/copy, integration decisions, provenance, and external snapshot import.

Managed filesystem projections are caches of semantic state. They are not an
independent source of truth. External drift must be refused or imported
explicitly. A synchronizer may not scan a directory, infer moves from equal
bytes, and silently author semantic history.

### 2.2 Exact build identity exists

Build V2 separates:

- source state and source closure;
- build key and recipe inputs;
- artifact digest over canonical emitted bytes;
- execution digest binding inputs and outputs;
- sealed authority requests for the exact build.

See [`src/server/buildV2/buildStore.ts`](../src/server/buildV2/buildStore.ts)
and [`packages/shared/src/execution/identity.ts`](../packages/shared/src/execution/identity.ts).

### 2.3 Authority is semantic and receiver-enforced

Installed code declares reviewed semantic requests. Those requests are not
grants. The dispatcher composes exact code identity, caller/session facts,
resource relationships, live grants, denials, read-only containment, and
receiver declarations.

Protected invocations use canonical `InvocationSnapshot` values and the
`AcquisitionCoordinator`; see
[`packages/rpc/src/authority.ts`](../packages/rpc/src/authority.ts),
[`packages/shared/src/authorization.ts`](../packages/shared/src/authorization.ts),
and
[`src/server/services/acquisitionCoordinator.ts`](../src/server/services/acquisitionCoordinator.ts).

No salvage work may reintroduce raw service-method grants, product-wide eval
catalog grants, caller-kind allowlists, or approval logic local to a feature.

### 2.4 Developer instances already have a host lifecycle owner

[`src/dev/instanceRegistry.ts`](../src/dev/instanceRegistry.ts) and
[`src/dev/runInstance.ts`](../src/dev/runInstance.ts) provide:

- named persistent and ephemeral instances;
- exclusive leases and generation identity;
- per-instance state roots and readiness records;
- isolated CLI credentials;
- signal forwarding and owned cleanup;
- stable CLI selection by instance id.

Self-development must reuse these mechanics. It must not add another process
supervisor or another instance registry.

### 2.5 Eval was durable but exposed two public execution shapes

[`packages/service-schemas/src/eval.ts`](../packages/service-schemas/src/eval.ts)
exposed at the audited baseline:

- `run`, which waits for a result;
- `startRun` plus `getRun`, which uses durable asynchronous state;
- `cancel`, `reset`, `dispose`, and scope paging operations.

Both execution shapes ultimately used the owner-scoped EvalDO, but they created
two public compositions and different caller expectations. Per-run containment
exposed `readOnly`; other attenuation was implicit in then-current
authority and session state.

Both shapes had live consumers. The agent harness tool called `eval.run`
(`workspace/packages/harness/src/tools/eval.ts:227`); the agent vessel deferred
through `eval.startRun`/`eval.getRun`
(`workspace/packages/agentic-do/src/agent-vessel.ts:4207`). Convergence is a
real migration, not a rename. RFS-5 completed that migration; neither legacy
shape remains public.

### 2.6 Two independent collectors exist

There are two garbage collectors over one overlapping reachability graph:

- **Execution/build GC.** `buildStore.gc` (`src/server/buildV2/buildStore.ts:814`)
  — synchronous, on-demand, no age guard, no quarantine. Root set is derived
  from a caller-supplied unit list.
- **Semantic/content GC.** `workspaceVcs.runGc`
  (`src/server/vcsHost/workspaceVcs.ts:255`) driven by `VcsGcScheduler`
  (`src/server/services/vcsGcScheduler.ts`) — hourly, 24-hour minimum blob age,
  root set assembled from `vcsContentGcRoots`, `refs.listMains()` content roots,
  and `repositories.collectCachedReachableDigests()`.

Neither collector knows the other's roots. RFS-0 repairs the immediate damage in
the first; RFS-2 §21 specifies the contract between them.

### 2.7 System-test evidence is already the supported repair loop

The current CLI supports `doctor`, `list`, `run`, `inspect`, `trajectory`, and
`rerun`. New work in this report must add focused conventional tests first and
then exact headless system tests through this existing workflow. It must not add
a development-specific test runner.

## 3. Cross-cutting invariants

Every work package below is governed by these rules.

1. **One source of truth per concept.** Generated documents derive from
   reviewed source. Semantic VCS owns workspace meaning. The developer-instance
   registry owns native host lifecycle. EvalDO owns eval run state.
2. **No compatibility layer.** The project is pre-release. When a public schema
   changes, producers, consumers, docs, generated catalogs, and tests change in
   the same tranche.
3. **Exact identity before effects.** Builds and launches bind an immutable
   source state, recipe, toolchain, artifacts, execution digest, owner, and
   target generation before process execution.
4. **Authority can attenuate, never widen.** Run/session/development manifests
   intersect existing authority. They cannot mint a principal or make a closed
   receiver callable.
5. **Relationships are not capabilities.** Ownership, context membership,
   device binding, host generation, and channel membership remain live
   predicates.
6. **No native-path authority.** Host paths are implementation details. Durable
   records use opaque owned-root ids, content digests, semantic state refs, and
   canonical credential-free source URIs.
7. **No inferred semantic intent.** Raw filesystem snapshots may be admitted as
   explicit external snapshots. They do not claim moves, copies, authorship, or
   causal intent that was not observed.
8. **Commit points are explicit.** Before a commit point, compensation is
   compare-and-restore against operation-owned state. After it, recovery resumes
   idempotently. Unknown outcomes become `requires-repair`.
9. **Cleanup cannot outrank the original result.** Cleanup errors are retained
   as secondary diagnostics and never erase the primary build, launch, eval, or
   test failure.
10. **Evidence is executable.** A ledger row, acceptance statement, or
    “implemented” status must name a test or mechanically verified source that
    exists and proves the stated behavior.
11. **Deletion is never silent.** Any collector, cleanup path, or retirement
    operation reports what it removed and what it failed to remove. A swallowed
    deletion error is a defect, not a convenience.
12. **A gate must state its own coverage.** When a check cannot prove part of
    an acceptance criterion, the specification says so and names the gate that
    can. Acceptance is never claimed from a gate that does not test it.

# RFS-0. Immediate execution-artifact retention repair

RFS-0 exists because verification upgraded a suspected weakness into a
confirmed data-loss path. It is deliberately small: no new architecture, no new
contracts, no provider census. It repairs the specific destruction, makes the
default non-destructive, and leaves the design work to RFS-2.

## 4. Problem

`build.gc` destroys application rollback history.

The chain is three steps:

1. `buildService.gc` forwards a caller-supplied unit list
   (`src/server/services/buildService.ts:123`).
2. `buildSystem.gc(activeUnits)` computes, for each named unit, only the
   _current effective_ build key, and passes that set onward
   (`src/server/buildV2/index.ts:1456-1466`).
3. `buildStore.gc(activeKeys)` iterates the builds directory and recursively
   removes every entry not in that set
   (`src/server/buildV2/buildStore.ts:814-830`).

Multiple live registries resolve artifacts by a build key that is, by
construction, _not_ the current effective key:

- **App rollback.** `AppRegistryEntry.previousVersions` retains five records
  (`src/server/appHost.ts:99,119`). `rollbackAppVersion` selects one by
  `activeBundleKey` (`appHost.ts:1018-1023`) and loads it through
  `buildSystem.getBuildByKey` (`appHost.ts:1202`).
- **Pinned host target selection.** `hostTargetSelection` carries `current` and
  `previous` bundle keys (`src/server/hostTargetSelection.ts:74-75,274`), and
  `appHost.ts:1444-1450` rolls back to a pinned non-current selection.
- **Terminal app runtime.** Launch resolves `entry.activeBundleKey` through
  `getBuildByKey` (`src/server/terminalAppRuntime.ts:96-98`) for units that may
  not appear in any caller's `activeUnits` list.
- **Runtime images.** `RuntimeImageRecord` binds one complete verified
  `ExecutionArtifactRefV1` and a generation
  (`src/server/runtimeImageStore.ts:18-30`) for incarnations whose code is not
  the current workspace head. Its artifact contains the exact source closure,
  recipe, build key, and execution digest; it is not a loose collection of
  identity fields.

None of these contribute roots. All of them break when their artifacts are
removed.

Three properties make this worse than an ordinary bug:

- **It is reachable from userland.** `build.gc` is a host method under the
  `service:build.gc` capability and admits the `code` principal
  (`packages/shared/src/authority/hostAuthorityCatalog.generated.ts` and the
  `host:build.gc` row in `docs/runtime-foundations/authority-ledger.json`).
- **It is silent.** `buildStore.gc` catches and discards every per-entry error
  and returns only `{ freed }`. Nothing reports what was destroyed.
- **The failure surfaces late and elsewhere.** The user learns about it at the
  next rollback attempt, as `No rollback version is available for app <name>`,
  with no link back to the collection that caused it.

## 5. Goal and non-goals

### Goal

No caller — host or userland — can destroy a build artifact that a live registry
record still resolves, and no collection runs destructively by default.

### Non-goals

- Do not build the provider census, epochs, or quarantine here. That is RFS-2.
- Do not change the artifact CAS layout or build key derivation.
- Do not attempt cross-collector coordination with semantic VCS GC here. That is
  RFS-2 §21.
- Do not add a retention policy language or user-facing retention configuration.

## 6. Repair

### 6.1 Deletion is removed, not merely defaulted off

Revision 2 specified `mode: "report" | "sweep"` with an mtime grace, on the
theory that host-owned roots plus a 24-hour guard made sweeping safe. They do
not, and the acceptance criterion built on them was unprovable.

Root collection and deletion are not serialized. A concurrent activation can:

1. select an old cached build from the store _after_ roots were collected;
2. publish an authoritative record referencing it;
3. have the sweep delete it, because the directory is older than the guard.

The mtime guard protects builds that are _new_. It does nothing for an old build
that becomes _newly referenced_ mid-collection, which is precisely what rollback,
pinning, and target reselection do. Closing that race needs epochs, quarantine,
and a publish/collect interlock — the architecture RFS-0 explicitly declines to
build.

So RFS-0 does not build half of it. The bounded, provable repair is:

```ts
build.gc(): {
  roots: number;
  reachableBuilds: number;
  unreferenced: number;
  unreferencedBytes: number;
  contributorFailures: Array<{ contributor: string; error: string }>;
};
```

There is no `mode`. There is no deletion path. `build.gc` becomes a pure
diagnostic that reports what a future collector _would_ consider unreferenced,
and the destructive path is removed from the code rather than hidden behind a
flag. `buildStore.gc`'s `rmSync` loop is deleted in this tranche; RFS-2
reintroduces deletion with quarantine and an epoch interlock, once it can be
proved correct.

The cost is explicit: **build storage grows without bound until RFS-2 lands.**
That is a disk-space problem with a visible number attached
(`unreferencedBytes`), and it is strictly preferable to a silent data-loss
problem. It also converts RFS-2 from an architectural preference into a
scheduling requirement, which is the correct pressure.

Operators needing space before RFS-2 stop the server and clear the build
directory — an offline, deliberate, no-concurrency operation with none of the
race described above.

### 6.2 Host-owned root contribution

`buildSystem.gc` assembles its own root set from the registries that already
exist. No new storage, no new contract — a direct read of live records:

| Contributor           | Keys contributed                                                                        |
| --------------------- | --------------------------------------------------------------------------------------- |
| App registry          | every `AppRegistryEntry.activeBundleKey` and every `previousVersions[].activeBundleKey` |
| Host target selection | every persisted `HostTargetSelection.buildKey` (present in `pinned-build` mode)         |
| Terminal app runtime  | every registered `entry.activeBundleKey`                                                |
| Runtime image store   | every `RuntimeImageRecord.artifact.buildKey`                                            |
| Build graph           | the current effective build key of every unit in the graph                              |

Field names are the canonical ones: `AppRegistryEntry.activeBundleKey`
(`packages/unit-host/src/index.ts:146`), and `HostTargetSelection.buildKey?`
alongside `mode: "follow-ref" | "pinned-build" | "pinned-ref"`
(`packages/shared/src/hostTargets.ts:9-18`) — the durable selection stores one
optional key, not current/previous arrays.

Note the last row: the current effective key of _every_ unit, not of a
caller-named subset. The caller list was never a safety mechanism; it was a
narrowing one.

If any contributor throws or is unavailable, `gc` reports the failure and its
counts are marked incomplete. Since nothing is deleted, an incomplete root set
is a reporting defect rather than a hazard — but it must still be visible, not
silently partial.

### 6.3 What RFS-2 must add before deletion returns

Recorded here so the deferral is a specification, not an omission. Deletion may
return only when RFS-2 provides:

- an epoch shared by root publication and collection, so a record published
  during an epoch is either in that epoch's roots or protects its artifact from
  that epoch's sweep;
- quarantine, so a first-time-unrooted artifact is never deleted in the epoch
  that first observed it;
- the §21.4 rule 6 contract, so a quarantined artifact keeps its source alive;
- fail-closed provider semantics across both collectors.

### 6.4 Surface the report

Returning a value is not surfacing it. A `build.gc` result that reaches only its
caller reproduces the standing finding from the July 2026 UX review — background
conditions with no subscriber. Name the destination: a nonempty
`contributorFailures`, or an `unreferencedBytes` past an operator-visible
threshold, emits a host diagnostic on the same channel that already carries
build and extension failures, and the value is retained where an operator can
read it after the fact.

Unbounded growth (§6.1) is only an acceptable trade while it is _visible_. An
unreported disk-fill is not better than the data loss it replaced.

## 7. Tests

- `build.gc` has no code path that removes a build directory;
- `buildStore`'s recursive-removal loop is absent from the tree;
- reported roots include all five retained app versions, a pinned host target
  selection, a terminal app bundle key, and a runtime image key whose unit is
  not at workspace head;
- an unreferenced build appears in `unreferenced` and is still present on disk
  afterward;
- an unavailable contributor is reported and marks the counts incomplete;
- a nonempty `contributorFailures` reaches the diagnostic subscriber, not only
  the return value;
- rollback, pinned reselection, and terminal app launch all still succeed after
  any number of `build.gc` calls.

## 8. Acceptance criteria

RFS-0 is complete when:

- no public or internal GC entry point accepts a caller-maintained active build
  list;
- no code path in the tree deletes a build directory — the destruction is
  removed, not gated;
- `build.gc` is a pure diagnostic whose reported root set covers every
  contributor in §6.2, with canonical field names;
- unreferenced volume and contributor failures reach a subscriber, not only the
  caller;
- the generated authority matrices and ledgers reflect the new `build.gc` shape.

RFS-0 does **not** claim reconstruction guarantees, cross-collector safety, safe
collection, or a complete owner census. It claims exactly one thing: the system
no longer destroys artifacts that live records resolve. Everything else waits
for RFS-2, and §6.3 records what RFS-2 owes before deletion returns.

# RFS-1. Generated-ledger evidence integrity

## 9. Problem

`scripts/generate-runtime-foundation-ledgers.mjs --check` verifies that
generated bytes match the generator. It does not validate that
`parityAssertion` references resolve to real evidence.

The current ledgers contain seven distinct dangling evidence references across
five missing files:

| Ledger           | Dangling evidence                                                              | Occurrences |
| ---------------- | ------------------------------------------------------------------------------ | ----------- |
| Authority        | `src/server/services/runtimeFoundationLedgers.test.ts#host-authority-census`   | 546         |
| Authority        | `src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census` | 327         |
| Bootstrap        | `src/server/services/runtimeFoundationLedgers.test.ts#bootstrap-acyclic`       | 2           |
| Channel          | `workspace/workers/gad-store/gadStore.test.ts`                                 | 2           |
| Channel          | `packages/shared/src/channelStructure.ts`                                      | 2           |
| Execution/update | `src/server/services/devHostService.test.ts`                                   | 2           |
| Execution/update | `workspace/extensions/dev-host/lifecycle.test.ts`                              | 2           |

Because every authority row repeats one of two missing census anchors, the
visual volume of generated JSON hides the fact that the evidence target itself
is absent. 873 rows cite two files that do not exist.

The generated set is three ledgers plus one dependency graph:
`docs/runtime-foundations/authority-ledger.json`,
`channel-behavior-ledger.json`, `execution-update-ledger.json`, and
`bootstrap-dependency-graph.json`.

## 10. Goal and non-goals

### Goal

Make it impossible to generate, check, build, or ship a runtime-foundation
ledger whose evidence target is missing, ambiguous, stale, or unrelated to its
row.

### Non-goals

- Do not restore the old product grant catalogs.
- Do not preserve dev-host or GAD-store rows merely because the old branch had
  tests for them.
- Do not make comments or free-form test names a second evidence registry.
- Do not treat source-file existence alone as sufficient behavioral proof for
  claims that require a test.
- Do not regex arbitrary test source to discover ids.

## 11. Evidence reference contract

Replace unstructured `parityAssertion: string` generation inputs with a typed
internal representation:

```ts
type LedgerEvidenceReference =
  | {
      kind: "test";
      path: string;
      testId: string;
    }
  | {
      kind: "source-contract";
      path: string;
      exportName: string;
    }
  | {
      kind: "generated-census";
      census: "host-authority" | "direct-authority" | "bootstrap";
    };
```

Generated JSON may retain a compact display form, but the generator must
validate the typed source before serialization.

Rules:

- `path` is repository-relative, normalized with `/`, and cannot contain `..`.
- `testId` is a stable explicit id registered by a test file, not a substring
  searched from Vitest display text.
- `source-contract` is allowed only for a structural property that is fully
  represented by the named exported value. Behavioral claims require tests.
- `generated-census` is proven inside the generator from canonical registries.
  It does not point back to a test whose only job is to repeat generator logic.
- Every evidence reference must be used by at least one row.
- Every registered census or ledger-specific test id must be used by at least
  one row; orphan evidence fails the check.

## 12. Canonical evidence registry

Add `scripts/runtime-foundation-evidence.mjs` as the reviewed registry used by
the generator and by the evidence test:

```js
export const runtimeFoundationEvidence = {
  tests: {
    "channel.creation.atomic": {
      path: "workspace/workers/pubsub-channel/channel-do.test.ts",
    },
    "runtime.execution.panel-adoption": {
      path: "src/server/panelRuntimeRegistration.test.ts",
    },
  },
  sourceContracts: {
    "channel.locked-membership": {
      path: "workspace/workers/pubsub-channel/types.ts",
      exportName: "LockedChannelMembershipPolicy",
    },
  },
};
```

This file contains identifiers and paths only. It does not duplicate the ledger
claims or the authority method census.

## 13. Test id registration

Revision 1 proposed extracting ids statically from test source, with a build
transform as a fallback. Both are fragile in the same way: they parse a language
to learn a fact the runtime already knows.

Revision 2 replaced that with a dedicated host test that dynamically imports
every registered evidence module. That is worse, for a reason worth stating so
it is not reinvented: **importing a test file executes its entire suite.** The
evidence set spans projects — `workspace/workers/pubsub-channel/channel-do.test.ts`
is a registered example — and `vitest.host.config.ts:16` deliberately excludes
`workspace/**` from the host project. The check would have dragged excluded
suites into the wrong environment, run them under the wrong config, and made
ledger validation depend on their incidental pass/fail. Never import an
arbitrary test suite in order to inspect it.

Evidence tests declare a stable, greppable name in their own normal suite:

```ts
export function ledgerTest(id: string, fn: () => void | Promise<void>): void {
  it(`ledger:${id}`, fn);
}
```

That is the whole helper. It adds no registry, no side channel, and no import
requirement. The test runs where it belongs, under the config it belongs to.

A Vitest reporter collects the names across **all** projects during a normal
full run and writes one manifest:

```jsonc
// generated: ledger-evidence-manifest.json
{ "ids": ["channel.creation.atomic", "runtime.execution.panel-adoption"] }
```

The reporter records `{id, file, project, status}` for every test whose name
matches `ledger:<id>`. A `check:ledger-evidence` script then compares the
manifest to the registry and fails on:

- a registry id no test declares;
- a declared id absent from the registry;
- a declared id whose file does not match the registry's `path`;
- a declared id whose test did not pass — evidence that fails is not evidence.

Equality in both directions, plus file agreement, plus pass status. No
cross-environment imports and no source parsing.

The manifest is generated, not authored, and is regenerated by the same full
test run that produces it. Treat a stale manifest as a stale generated artifact:
`check:ledger-evidence` reports how it was produced and how to refresh it.

### 13.1 Gate coverage, stated plainly

This design splits validation across two gates, and invariant 12 requires saying
which catches what.

| Failure                                            | Caught by                   | Runs in                             |
| -------------------------------------------------- | --------------------------- | ----------------------------------- |
| Evidence path missing, renamed, untracked, or `..` | `pnpm check:unit-authority` | `quality:check`, `test`, pre-commit |
| Registry entry unused by any ledger row            | `pnpm check:unit-authority` | same                                |
| Census incompleteness or duplication               | `pnpm check:unit-authority` | same                                |
| Generated bytes stale                              | `pnpm check:unit-authority` | same                                |
| Exported `source-contract` symbol missing          | `pnpm check:unit-authority` | same                                |
| Test id stale, renamed, never declared, or failing | `check:ledger-evidence`     | full `pnpm test` (all projects)     |
| Declared id in the wrong file                      | `check:ledger-evidence`     | same                                |

The two gates have genuinely different costs and reach. `check:unit-authority`
is fast, needs no test execution, and is safe in pre-commit.
`check:ledger-evidence` requires a full multi-project test run, because that is
the only context in which every evidence test actually executes — so it belongs
in CI and in `pnpm test`, not in pre-commit.

Do not claim §17 acceptance from `check:unit-authority` alone. It cannot prove a
test id exists, and after this revision it does not pretend to.

## 14. Generator behavior

`generate-runtime-foundation-ledgers.mjs` must perform these phases in order:

1. Load canonical service, direct-RPC, runtime-surface, channel, and bootstrap
   registries.
2. Construct typed ledger rows.
3. Resolve each evidence reference through the evidence registry.
4. Verify that every referenced path exists and is a regular tracked source
   file.
5. Verify every referenced `source-contract` export name.
6. Verify census completeness and uniqueness.
7. Verify that every registry entry is used by at least one row.
8. Serialize deterministic JSON and generated TypeScript.
9. In `--check`, compare generated content to checked-in content.

Evidence validation precedes byte comparison, so a dangling reference fails with
its own message rather than as a diff.

Failure examples must be direct:

```text
execution-update-ledger: surface "dev-host-isolated" references unknown
evidence "development.isolated.candidate-promotion"
```

```text
channel-behavior-ledger: evidence "channel.visibility.workspace-discovery"
points to missing file workspace/workers/gad-store/gadStore.test.ts
```

```text
runtime-foundation-evidence: registry entry "channel.fork.origin" is not used
by any ledger row
```

## 15. Current-row disposition

Before enabling the check, audit every current row.

### Dev-host rows

Remove `dev-host-current-client` and `dev-host-isolated` from the current
execution ledger until RFS-4 implements them
(`scripts/generate-runtime-foundation-ledgers.mjs:708,714`;
`docs/runtime-foundations/execution-update-ledger.json:239,257`). A ledger
describes implemented surfaces, not planned ones.

RFS-4 will re-add them with current tests and current terminology.

### Channel visibility

Replace the deleted GAD-store evidence with a test against the current semantic
workspace/channel discovery owner if the behavior still exists. If current
product behavior no longer promises workspace-wide discovery, change the
contract deliberately and document the product effect.

This disposition is the minimum outcome of RFS-3 and is required here — RFS-1
cannot pass while a row cites a deleted file. It does not commit the project to
RFS-3 implementation.

### System-agent locked admission

Point the row at a current end-to-end test proving that the exact system-agent
principal can join and another principal cannot. The existence of a TypeScript
interface is insufficient. `LockedChannelMembershipPolicy`
(`workspace/workers/pubsub-channel/types.ts:92`) may back a `source-contract`
reference only for the shape of the policy, never for admission behavior.

### Authority and bootstrap census

Move the host/direct census and bootstrap graph checks into generator-owned
structural validation. Add focused tests for the generator failure modes, not a
second census implementation in server tests. This retires 875 of the 883
dangling occurrences.

### Build GC row

RFS-0 changes the `build.gc` public shape. Its ledger row and the generated
authority matrices must be regenerated in the RFS-0 tranche, not deferred here.

## 16. Tests

Add:

- generator unit tests for missing files, duplicate evidence ids, unknown test
  ids, orphan evidence, invalid paths, and wrong evidence kind;
- snapshot tests for concise failure messages;
- a check that deleting or renaming one evidence file makes
  `pnpm check:unit-authority` fail;
- a check that renaming one `ledgerTest` id makes
  `runtimeFoundationEvidence.test.ts` fail;
- a check that adding a host or direct method without a census row fails;
- a check that a planned surface cannot enter an implemented ledger without
  evidence.

## 17. Acceptance criteria

RFS-1 is complete when:

- all current dangling references are removed or replaced;
- the three ledgers and the bootstrap dependency graph contain no untyped
  evidence strings in generator source;
- `pnpm check:unit-authority` validates paths, exports, census, and registry
  usage before byte freshness;
- `runtimeFoundationEvidence.test.ts` proves registry/registration equality;
- both gates run in normal build and pre-commit checks;
- a deliberately missing evidence file and a deliberately renamed test id each
  fail with one actionable message, from their respective gates;
- no old GAD-store, dev-host, or removed channel-structure path remains in
  generated output.

# RFS-2. Authoritative execution-artifact retention

RFS-0 stops the bleeding. RFS-2 replaces the ad-hoc contributor list with a
typed provider contract, adds epochs and quarantine, and — the part revision 1
under-specified — defines how the two collectors share one reachability graph.

## 18. Problem

The forgotten branch's strongest runtime insight was not merely "hash build
artifacts." It was:

> Retention must be derived from authoritative execution roots, never from a
> caller-maintained list or increment/decrement counters.

RFS-0 establishes host-owned roots for the artifact collector. Three problems
remain:

1. **The contributor list is untyped and unenumerated.** RFS-0 hard-codes five
   readers. Nothing prevents a sixth executable owner from being added without a
   contribution, and nothing makes the omission visible.
2. **There is no quarantine.** RFS-0's 24-hour age guard is a blunt proxy. A
   build older than the guard that becomes rooted between root assembly and
   sweep is still at risk.
3. **The two collectors do not share roots.** This is the serious one, and §21
   addresses it directly.

Even with RFS-0, the current design does not by itself prove preservation of:

- pinned historical states;
- a currently running old incarnation;
- a durable object whose code is not the current workspace head;
- active eval imports or retained scope modules;
- an in-progress development launch;
- artifacts referenced by durable provenance or diagnostics.

## 19. Goal and non-goals

### Goal

Every executable incarnation that can still run, resume, roll back, be
inspected, or be selected by an authoritative record remains reconstructible
without mutable workspace input or a warm build cache.

"Reconstructible" is the operative word and it is stronger than "its artifacts
survived." It requires that the artifact bytes _and_ the source closure that
produced them both survive, which is why §21 exists.

### Non-goals

- Retain every build forever.
- Use reference counts as an authoritative truth.
- Make logs or best-effort telemetry into retention roots.
- Keep corrupt artifacts because some unverified string resembles a digest.
- Preserve old branch storage schemas.

## 20. Canonical execution reference

Define one shared value:

```ts
interface ExecutionArtifactRefV1 {
  version: 1;
  /** Both semantic provenance and traversable content closure — see §20.1. */
  sourceState: ExecutionSourceIdentityV1;
  recipeDigest: Sha256;
  buildKey: Sha256;
  artifactDigest: Sha256;
  executionDigest: Sha256;
}
```

Rules:

- `executionDigest` is recomputed and verified when the record is loaded.
- A non-workspace product seed may use `state: null`, but still names an exact
  source closure.
- Runtime images, app candidates, panel history, EvalDO loaded modules, and
  development runs store this complete ref or an immutable key that resolves
  to it.
- A bare build key is not enough for execution admission.

`RuntimeImageRecord` (`src/server/runtimeImageStore.ts:18-30`) now stores the
complete verified `artifact: ExecutionArtifactRefV1` alongside its generation.
Its v6 codec verifies that reference at load and write boundaries. Keep this
single canonical record; do not add a parallel identity store.

### 20.1 Semantic provenance and content closure are different identities

The `sourceState` field above needs both, and conflating them breaks the
handshake.

`VcsStateNodeRef` is a _semantic_ identity — a discriminated union of
`{kind:"event", eventId}` and `{kind:"application", applicationId}`
(`packages/service-schemas/src/vcs.ts:134-143`). It names a point in workspace
history. It is not a CAS tree root, and it is not traversable.

`runGc` traverses _content_ roots: it collects `contentRoots` and mains'
`contentRoot` values and walks them with
`collectTreeReachableDigests(blobsDir, root)`
(`src/server/vcsHost/workspaceVcs.ts:262-275`). Build V2 already retains the
corresponding projection per artifact as `sourceStateHash`, documented as "the
workspace state this artifact was materialized from"
(`src/server/buildV2/buildStore.ts:145`).

A `sourceClosureDigest` does not bridge the two. It is a commitment over the
closure — it proves a set, it does not enumerate one, and it cannot be inverted
into the roots a sweep must mark.

So `ExecutionArtifactRefV1.sourceState` carries both identities, for different
consumers:

```ts
interface ExecutionSourceIdentityV1 {
  workspaceId: string;
  /** Semantic provenance: what history this came from. Not traversable. */
  state: VcsStateNodeRef | null;
  /** Traversable content closure: what the sweep must mark. */
  contentRoots: readonly ExecutionSourceContentRoot[];
  /** Commitment over the closure. Verifies; does not enumerate. */
  sourceClosureDigest: Sha256;
}

interface ExecutionSourceContentRoot {
  /** Workspace-relative repository path; null for external library builds. */
  repoPath: string | null;
  /** The `state:…` content root, as `runGc` and `sourceStateHash` express it. */
  stateHash: string;
}
```

Rules:

- `contentRoots` is a canonical ordered set, so the ref digests deterministically.
- A single workspace composition root is acceptable in place of a per-repository
  set, but only if its complete manifest is retained — a composition root whose
  interior manifests have been swept is exactly the failure recorded at
  `workspaceVcs.ts:274-280`.
- `state` may be null for a product seed. `contentRoots` may not be empty for any
  artifact that claims to be reconstructible.
- Retention decisions read `contentRoots`. Provenance, diagnostics, and UI read
  `state`. Neither substitutes for the other.

## 21. Two-collector reachability

This section replaces revision 1's single sentence on the subject.

### 21.1 Current state

Two collectors, two root models, no contract.

|                       | Execution/build GC          | Semantic/content GC                                                                     |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Entry point           | `buildStore.gc`             | `workspaceVcs.runGc`                                                                    |
| Trigger               | on demand                   | `VcsGcScheduler`, hourly                                                                |
| Root model            | build keys                  | content roots and hashes                                                                |
| Root sources          | RFS-0 registry contributors | `vcsContentGcRoots`, `refs.listMains()`, `repositories.collectCachedReachableDigests()` |
| Age guard             | RFS-0: 24h mtime            | 24h blob age (`DEFAULT_VCS_GC_MIN_AGE_MS`)                                              |
| Missing-root behavior | none                        | throws (`GC root ${root} is missing from the content store`)                            |
| Quarantine            | none                        | none                                                                                    |

### 21.2 The gap

`runGc`'s root set contains no execution artifact source states. Nothing
contributes `ExecutionArtifactRefV1.sourceState.state` or
`sourceClosureDigest` into `reachable`.

So a pinned rollback build can survive artifact collection — RFS-0 guarantees
that — while the semantic collector sweeps the blobs of the source closure that
produced it, provided that state is not independently reachable from a main ref
or a cached view. The artifact bytes remain; the ability to rebuild, diff, or
explain them does not. RFS-2's own goal (§19) fails silently.

The 24-hour blob age is the only thing standing between the current
implementation and that outcome. It is a timing accident, not a contract.

### 21.3 This is not hypothetical

The codebase has already lost data to exactly this class of gap, in the other
direction. `src/server/vcsHost/workspaceVcs.ts:274-280` records it:

> Workspace/context views are immutable CAS compositions, not semantic history
> nodes. They are nevertheless live build inputs while retained by
> WorkspaceRepositories, so their scaffold nodes must participate in the same
> reachability snapshot as semantic repository roots. Omitting them leaves a
> cached state pointer whose interior directory manifests have been swept, and
> the next exact build fails while walking the tree.

A live consumer held a pointer; the collector did not know about the consumer;
the sweep broke the next build. Execution artifacts are the same shape of
consumer, and they are still not in the root set.

### 21.4 Handshake contract

1. **One epoch.** The host allocates a monotonic root epoch. Both collectors
   run within it. Neither may start a new epoch while the other is mid-epoch.
2. **Execution roots first.** Every `ExecutionRootProvider.snapshotRoots(epoch)`
   runs before either sweep.
3. **Projection.** The execution root set projects to two consumers:
   - _artifact reachability_ — `buildKey`, `artifactDigest`, `executionDigest`
     → execution GC;
   - _source reachability_ — the traversable content closure (§20.1) →
     contributed into `runGc`.
4. **`runGc` gains an explicit contributor.** Extend its input:

   ```ts
   runGc(options: {
     minAgeMs: number;
     epoch: number;
     executionSourceRoots: readonly ExecutionSourceContentRoot[];
   }): Promise<{ scanned: number; swept: number; bytes: number }>
   ```

   The element type is a **content root**, not a semantic node reference — see
   §20.1 for why the distinction is load-bearing. `executionSourceRoots` joins
   `contentRoots`, mains, and cached views in the same `reachable` computation.
   It inherits the existing fail-closed behavior: a contributed root missing
   from the content store throws, exactly as a semantic root does today. It does
   not get a softer path because it came from a different owner.

5. **Both fail together.** If any mandatory execution provider is unavailable,
   stale, or returns an invalid ref, _both_ collectors degrade to report mode
   for that epoch. The content collector may not sweep on a partial execution
   root set, because a missing execution root is indistinguishable from an
   artifact that legitimately has no source.
6. **Quarantine retains source.** This rule replaces revision 2's ordering rule,
   which was wrong in a way that manufactured the exact condition RFS-2 exists
   to prevent.

   Revision 2 said: sweep source first, then quarantine any artifact left
   unreferenced. Trace an ordinary old build that has just become unrooted. Its
   provider stops listing it, so its source roots stop being contributed, so the
   content sweep frees its closure — while the artifact itself sits in
   quarantine, undeleted. The system has now _created_ a `reconstructible:
false` artifact, and if a root reappears during the grace period the
   quarantine "saved" bytes that can no longer be rebuilt, diffed, or explained.

   The correct rule is that source outlives artifact, enforced by reachability
   rather than by timing:
   - a quarantined artifact **continues to contribute its source content
     roots** for the entire time it is quarantined;
   - the artifact is deleted only after its quarantine expires;
   - its source roots stop being contributed only after the artifact deletion
     **commits**;
   - content GC may then collect those roots in a later epoch, once nothing
     references them.

   An artifact and its source therefore die in a fixed order, one epoch apart,
   with no window in which the source is gone and the artifact is not.

7. **`reconstructible: false` is an alarm, not a state to reach.** With rule 6,
   the condition should be unreachable through normal collection. If it is ever
   observed — an externally corrupted store, a provider that under-reports, a
   partially applied deletion — the artifact is **not** deleted, the condition
   is reported (§25), and it is treated as a defect to investigate rather than a
   category of object to accumulate.

   Do not attempt to enforce this ordering with an age inequality. Revision 2
   required the execution grace to be ≥ the content `minAgeMs` "so an artifact
   never outlives its source," which is backwards: a longer artifact grace makes
   the artifact survive _longer_, which is the failure being guarded against.
   Ages govern how long an unreferenced object lingers; they cannot establish an
   ordering between two collectors. Only continued root contribution can.

8. **Scheduler ownership.** `VcsGcScheduler` no longer drives `runGc` directly.
   It drives one epoch coordinator that owns both. Its existing interval,
   initial delay, reentrancy guard, and failure logging move to the coordinator
   unchanged.

### 21.5 What this does not do

The handshake does not merge the two collectors, unify their storage, or make
one a subset of the other. They remain separate implementations over separate
stores. It defines only the exchange of roots and the ordering of sweeps —
which is the entire surface on which they can corrupt each other.

## 22. Authoritative root providers

Add a host-internal `ExecutionRootProvider` contract:

```ts
interface ExecutionRoot {
  owner:
    | "runtime-entity"
    | "panel-history"
    | "app-generation"
    | "extension-generation"
    | "terminal-app"
    | "eval-run"
    | "development-run"
    | "product-seed";
  ownerId: string;
  reason: "active" | "pinned" | "rollback" | "in-flight" | "retained-result";
  artifact: ExecutionArtifactRefV1;
}

interface ExecutionRootProvider {
  id: string;
  mandatory: boolean;
  snapshotRoots(epoch: number): Promise<readonly ExecutionRoot[]>;
}
```

Required providers, each replacing one RFS-0 ad-hoc contributor:

| Provider                | Replaces            | Backing state                                   |
| ----------------------- | ------------------- | ----------------------------------------------- |
| `runtime-entity`        | —                   | WorkspaceDO incarnation state                   |
| `panel-history`         | —                   | panel slot history and selected generation      |
| `app-generation`        | app registry reader | `AppRegistryEntry` active + `previousVersions`  |
| `host-target-selection` | selection reader    | `hostTargetSelection` current + previous        |
| `terminal-app`          | terminal reader     | registered terminal app bundle keys             |
| `runtime-image`         | image store reader  | `RuntimeImageStore` records                     |
| `extension-generation`  | —                   | extension-host active/candidate/last-good       |
| `eval-run`              | —                   | active and retained run/module state            |
| `development-run`       | —                   | RFS-4 sessions and launches                     |
| `product-seed`          | —                   | verified boot manifest / internal DO identities |

The census is generated. Adding an executable owner without registering a
provider must fail a check, not merely be discouraged — see §26.

## 23. Mark, quarantine, sweep

This section **restores deletion**, which RFS-0 removed outright (§6.1). It is
the first point in the plan where it is safe to delete a build artifact, and it
must satisfy every item §6.3 listed as owed.

1. Allocate a monotonic GC epoch.
2. Ask every registered provider for a durable snapshot at that epoch.
3. Fail closed if a mandatory provider is unavailable, stale, or returns an
   invalid ref — degrading both collectors per §21.4 rule 5.
4. Verify every root and traverse:
   execution ref → build metadata → artifact manifest → artifact CAS blobs;
   execution ref → source content roots (§20.1).
5. Mark reachable objects.
6. Move unmarked objects to an owned quarantine namespace with
   `{firstUnmarkedEpoch, quarantinedAt}`. Quarantined artifacts continue
   contributing their source content roots (§21.4 rule 6).
7. On a later successful full scan after the grace interval, delete objects
   still unmarked. Their source roots are withdrawn only once that deletion
   commits.
8. If any provider or deletion fails, retain the object and report the failure.

### 23.1 The publish/collect interlock

Quarantine alone does not close the race that forced RFS-0 to abandon sweeping.
That race was: an activation selects an old artifact _after_ roots are
collected, publishes a record for it, and the sweep deletes it anyway.

Two rules close it, and both are required:

- **Publication joins the current epoch.** Publishing an authoritative owner
  record (§24 step 3) stamps the epoch current at publication time. A sweep in
  epoch _N_ may only delete objects that were unmarked in epoch _N_ **and** carry
  no publication stamp from epoch ≥ _N_.
- **Quarantine spans at least one full epoch boundary.** An object first
  observed unrooted in epoch _N_ is eligible for deletion no earlier than epoch
  _N+1_, after a complete successful scan. A publication racing collection
  therefore always lands in an epoch the sweep must re-observe.

Together these give the property RFS-0 could not: a record that exists when
deletion commits always protected its artifact, regardless of when it was
published relative to root collection.

Quarantine is also required for the simpler reason that a build may finish
concurrently with root publication. A new artifact cannot be deleted in the
epoch in which it first appears unrooted.

## 24. Commit-point protocol

Artifact creation and owner publication follow:

1. Write and verify artifact CAS objects.
2. Write complete build metadata.
3. Publish the authoritative owner record referencing the execution ref.
4. Only then expose the incarnation as launchable.

Before step 3, artifacts are uncommitted candidates protected by the current GC
epoch/grace period. After step 3, recovery must finish activation or explicitly
retire the owner record; it cannot delete artifacts and leave a live owner.

Candidate replacement follows prepare → verify → atomically select. Last-good
selection is removed only after the new generation is authoritative and the
surface's adoption contract permits retirement.

## 25. API and diagnostics

RFS-0 already made `build.gc` host-owned and report-only. RFS-2 keeps that
public diagnostic surface while adding a private coordinated collector:

```ts
build.gc(): {
  epoch: number;
  mode: "report";
  complete: boolean;
  roots: number;
  rootBuildKeys: string[];
  storedRootBuildKeys: string[];
  unresolvedAuthoritativeRootBuildKeys: string[];
  reachableBuilds: number;
  unreferenced: number;
  unreferencedBytes: number;
  quarantined: number;
  deleted: number;
  retainedForGrace: number;
  notReconstructible: number;
  notReconstructibleDetails: Array<{ buildKey: string; missing: string[] }>;
  providerFailures: Array<{ provider: string; error: string }>;
  cleanupFailures: Array<{ buildKey: string; error: string }>;
  retainedSourceRoots: ExecutionSourceContentRoot[];
};
```

This call performs no mutation. It is not a mode selector, and userland cannot
nominate roots. The host-owned `GcEpochCoordinator` alone begins an epoch,
preflights the immutable build-root snapshot and source closures, then commits
the private artifact quarantine/sweep and source sweep in that order. No public
RPC exposes a quarantine or sweep phase.

`notReconstructible` and `providerFailures` are alerts, not statistics. Each
needs a named subscriber, for the reason given in §6.4: a background collector
whose failures reach only its caller is invisible, and invisible background
failure is a documented standing defect in this codebase, not a hypothetical
one.

- A nonzero `notReconstructible` emits a host diagnostic naming each affected
  execution digest and its owner. It means an incarnation that some record still
  points at can no longer be rebuilt — a durable, user-visible condition, and
  `build.inspectExecution` must be able to explain any one of them.
- A nonempty `providerFailures` emits a diagnostic naming the provider. Because
  a mandatory provider failure suppresses sweeps in _both_ collectors (§21.4
  rule 5), silent failure here degrades to unbounded disk growth with no signal.
- Both are retained across the run so an operator can read them after the epoch
  ends.

Add bounded inspection by execution digest:

```ts
build.inspectExecution(executionDigest): {
  artifact: ExecutionArtifactRefV1 | null;
  roots: Array<{ owner: string; ownerId: string; reason: string }>;
  reconstructible: boolean;
  missing: string[];
};
```

This is a read diagnostic and must not create retention.

## 26. Provider census check

Generated architecture docs must enumerate the complete provider set, and a
check must fail when an executable owner exists without one. Concretely: any
module that reads `getBuildByKey`, resolves an `activeBundleKey`, or persists an
`executionDigest` must appear in the census or in a reviewed exemption list with
a stated reason. This is the mechanism that keeps §22 from silently rotting the
way the RFS-0 contributor list would.

## 27. Tests

Focused tests must cover:

- active current build survives;
- pinned historical build survives;
- running old incarnation survives a main-head advance;
- panel/app last-good survives candidate failure;
- retained eval import survives restart;
- RFS-4 development run survives parent process restart;
- unrooted build is quarantined, not immediately deleted;
- a root published during a GC epoch prevents later sweep;
- a missing mandatory provider makes GC fail closed;
- invalid execution digest makes activation fail, not retention widen;
- source state and artifact bytes can reconstruct an execution after process
  and cache restart;
- second clean scan deletes a truly unreachable object;
- cleanup failure is reported and retried.

Handshake and interlock tests. These cover the failure modes that two earlier
revisions of this document got wrong, so they are the ones least safe to skip:

- an execution source root prevents its blobs from being swept by `runGc`;
- an execution source root missing from the content store makes the content
  sweep throw, not skip;
- a mandatory execution provider failure suppresses the _content_ sweep, not
  only the artifact sweep;
- **a newly unreferenced artifact keeps its source alive for the whole
  quarantine** — run both collectors repeatedly through the quarantine window
  and assert the source closure is still traversable at every step;
- **an artifact rescued from quarantine by a reappearing root is still
  reconstructible** — this is the case revision 2's ordering broke;
- source roots are withdrawn only after the artifact deletion commits, never
  before;
- `reconstructible: false` is never produced by normal collection; injecting it
  by corrupting the store reports it and deletes nothing;
- a record published _after_ root collection but _before_ sweep protects its
  artifact (§23.1) — the race that forced RFS-0 to abandon sweeping;
- an object first unrooted in epoch _N_ is not deleted in epoch _N_;
- neither collector starts a new epoch while the other is mid-epoch;
- a full round-trip: build, root, advance head, run both collectors, restart the
  process with a cold cache, reconstruct the execution.

## 28. Acceptance criteria

RFS-2 is complete when:

- every executable owner implements or delegates to one typed root provider;
- the provider census is generated and a missing provider fails a check;
- execution GC uses mark/quarantine/sweep with the §23.1 publish/collect
  interlock, satisfying every item §6.3 listed as owed before deletion returns;
- deletion is reintroduced only here, and disk reclamation works again;
- a quarantined artifact keeps its source content roots alive until its own
  deletion commits (§21.4 rule 6);
- the two collectors exchange roots through the §21.4 contract, share an epoch,
  and fail together;
- `runGc` accepts and fail-closed-validates `executionSourceRoots` as content
  roots, not semantic node references (§20.1);
- historical/pinned execution reconstruction has restart tests that run with a
  cold build cache;
- a missing root provider cannot cause deletion in either collector;
- `notReconstructible` and `providerFailures` reach a subscriber (§25);
- runtime and generated architecture docs identify the complete provider census.

# RFS-3. Channel lifecycle contract reconciliation

RFS-3 is an audit whose implementation is conditional. Its guaranteed
deliverable is a truthful ledger. Its schema work happens only if the §30
decisions require it.

## 29. Problem

The retained channel ledger promises:

- explicit atomic creation;
- subscribe never creates structure;
- invitation is discovery metadata for ordinary channels;
- immutable structure revisions and separately mutable presentation;
- explicit fork origin/context rewrite;
- deterministic deletion/reconnect;
- exact-principal locked admission for the System Agent.

Current `pubsub-channel` implements important pieces:

- explicit locked-channel initialization;
- immutable locked membership input
  (`workspace/workers/pubsub-channel/types.ts:92`);
- durable channel membership separate from ephemeral presence;
- config update events;
- crash-safe invite-index projection;
- fork journals.

However, the old `ChannelStructureRevision` source is absent, one ledger row
still points to it, and mutable channel config currently mixes presentation
fields with policy-shaped values (`updateConfig` via
`workspace/packages/pubsub/src/rpc-client.ts:1705` and
`workspace/packages/agentic-do/src/channel-client.ts:377`).

## 30. Required product decisions

These must have written answers before any schema work begins. This is a hard
gate, not a recommendation.

1. Are ordinary workspace channels discoverable to every workspace member, or
   only to invitees?
2. Is `channel_members` discovery metadata or an ACL for ordinary channels?
3. Who may change title, conversation policy, approval level, agent hop limit,
   and named policies?
4. Which fields are presentation and which change admission/governance?
5. Can ownership transfer? What happens when the owner account disappears?
6. Is locked membership immutable for the life of a channel, or revisable
   through an explicit structure transition?
7. What exact identity defines a System Agent participant: stable entity,
   sealed code, live binding, or their intersection?

Each answer becomes a row in the ledger and a test before migration.

## 31. Two possible outcomes

The audit has exactly two legitimate conclusions, and the specification is
neutral between them.

**Outcome A — current behavior is intentional.** The ledger is narrowed to
describe what the implementation actually promises, each surviving row gets
current evidence, and no schema is introduced. This is a complete and successful
RFS-3. It costs one change set.

**Outcome B — the ledger describes behavior the product wants and the
implementation lacks.** Then, and only then, introduce a structure/presentation
split. Appendix A holds a candidate model. It is a starting point for design,
not a target to ratify.

Revision 1 presented the full candidate model inline, ahead of the decisions.
Concrete schemas are persuasive out of proportion to their evidence; a reader
arriving at §30 with a finished type in hand tends to answer the seven questions
in whatever way preserves it. The model is now Appendix A for that reason.

Do not build `ChannelStructureRevisionV1` for behavior nobody has asked for.

## 32. Migration, if outcome B

This is a pre-release clean cut.

1. Add audit fixtures over current behavior.
2. Record the §30 decisions.
3. Introduce the new schema version and migrate test fixtures.
4. For development data, derive a genesis structure only from a current
   explicit channel record. If current state is ambiguous, reset it rather than
   guess ownership/admission.
5. Replace `updateConfig` with presentation-only mutation.
6. Remove fields duplicated between structure and presentation.
7. Regenerate runtime docs and ledger evidence.

Do not add a reader that accepts both old mixed config and new revisions.

## 33. Tests and acceptance criteria

Required in both outcomes:

- every channel ledger row resolves to current evidence;
- subscribe before initialization fails without writing state;
- identical initialization is idempotent; different initialization fails;
- presence never grants admission;
- ordinary multi-human membership behavior matches the recorded §30 decision;
- System Agent exact principal succeeds and lookalike entity/code principals
  fail;
- invite-index retry cannot reorder membership intent.

Additionally required in outcome B:

- presentation mutation cannot change structure;
- stale expected revisions fail atomically;
- fork creates a new channel with explicit source revision and rewritten
  context;
- owner loss preserves structure until explicit recovery;
- tombstone survives restart and rejects reconnect.

RFS-3 is complete when the ledger is truthful and the §30 decisions are
recorded — in outcome A, that is the whole package.

# RFS-4. Semantic in-workspace Vibestudio development

## 34. Product objective

A human or agent working inside Vibestudio can:

1. select the Vibestudio repository in its current semantic context;
2. build from that exact working head, including uncommitted semantic edits;
3. launch:
   - an Electron client against the current host; or
   - a fully isolated host, optionally with its client;
4. inspect build, launch, logs, readiness, provenance, and cleanup;
5. attach to the isolated host through the normal typed service runtime;
6. optionally use a native external tool in a disposable writable tree and
   import explicit checkpoints back through semantic VCS;
7. integrate completed child-context work into the original context using
   normal compare/integrate/commit.

The feature is not "run the checkout containing the server." It is an ordinary
workspace workflow whose native effects are hosted by a trusted executor.

### 34.1 Precondition: the Vibestudio source must exist as a project

Step 1 says "select the Vibestudio repository in its current semantic context."
Revision 2 never defined how it got there, which left RFS-4A with no defined
source to build. The semantic workspace manages the selected workspace tree, not
the host checkout, so the monorepo is not present by default.

Adopt it through the existing import path rather than inventing one:
`gitInterop.importProject` (`packages/service-schemas/src/gitInterop.ts:737`)
establishes `projects/vibestudio` as one ordinary project repository.

The adoption record must fix:

- **Canonical upstream.** A credential-free URI and the selected branch
  (invariant 6). Credentials are resolved at fetch time and never persisted into
  the record.
- **Stable repository identity.** The `repositoryId` that `development.openSession`
  takes and that every checkpoint reuses. It survives re-import; a re-import that
  would mint a new identity is an error, not a silent fork.
- **The exact adopted event.** Which committed event entered the working context,
  so the first execution snapshot has a defined base.
- **Refresh behavior with local semantic work.** Pulling upstream while the
  context holds uncommitted semantic edits is an ordinary integration, decided
  through normal compare/integrate/commit. It never resets, discards, or
  fast-forwards over local work, and it never runs implicitly as a side effect
  of opening a development session.
- **Whole-monorepo representation.** The entire repository is one project
  repository, not a set of per-package repositories. Recipes, lockfile digests,
  and workspace-level builds all assume a single tree.

The old branch adopted the monorepo as `projects/vibestudio` too. That much of
its approach is sound and worth keeping; what it did afterward — the filesystem
synchronizer — is not (§67).

Adoption is a one-time setup step with its own UX, not part of a development
session. A session against an unadopted repository fails with a typed error
naming the adoption action, rather than attempting adoption implicitly.

## 35. Explicit non-goals

- The raw workspace projection is never build input.
- A native writable tree is never the semantic source of truth.
- No live polling loop converts filesystem drift into `vcs.edit`.
- Git does not become semantic ancestry.
- The feature does not expose arbitrary shell execution.
- Child admin tokens are never general RPC credentials.
- A development-specific eval bridge is forbidden.
- The old `devHost` schema, GAD repository reducer, and
  `ContextWorkspaceSynchronizer` are not restored.
- The feature does not imply an OS sandbox. Approved native project code runs
  with the executor account's OS authority unless a separately implemented
  platform sandbox says otherwise.

## 36. Architecture

```text
semantic parent context
  exact committed event + exact working head
             |
             | semantic context fork (preserves exact working state; §36.1)
             v
development child context
             |
             +---- direct semantic build -------------------------------+
             |                                                         |
             | optional native-tool base commit                         |
             | -> exact materialization -> disposable native tree       |
             | -> explicit checkpoint -> vcs.importSnapshot             |
             |                                                         |
             +---------------- exact state ref -------------------------+
                                                                       v
                                                        execution snapshot
                                                 source + recipe + toolchain
                                                                       |
                                              trusted development executor
                                                     /                 \
                                                    v                   v
                                      current-host Electron      isolated instance
                                                                        |
                                                          attached host session
                                                                        |
                                                     normal typed service clients
```

There are four owners:

- semantic VCS owns source meaning and history;
- the development service owns session/run state and orchestration;
- the execution snapshot store owns immutable materialized build input;
- the existing developer-instance supervisor owns child processes and
  per-instance runtime state.

### 36.1 Fork semantic state, do not clone the runtime

Revision 2 named `runtime.cloneContext` as the branch primitive. That is the
wrong operation, and it would fail outright in the common case.

`cloneContext` reproduces a running world, not a source branch
(`src/server/services/runtimeService.ts:985-1015`):

- it walks the context subtree and clones every durable worker/DO entity along
  with its storage;
- it rejects contexts with lifecycle children unless they are recursively
  cloned;
- it throws when the source context has no cloneable durable entities — and the
  comment records this as deliberate ("Denial for an empty root is
  non-destructive").

A development session wants one thing: a semantic working head it can edit and
build without touching the parent. Cloning it through `cloneContext` would
duplicate the user's agents, their durable state, and their in-flight work as a
side effect of starting a build — and an ordinary source-only context, having no
durable entities to clone, would simply be refused.

RFS-4 therefore uses a dedicated **semantic context fork**, implemented over the
existing internal `forkContext` path:

- it forks semantic state and the working chain only;
- it clones no runtime entity, no durable object, and no agent;
- it succeeds for a context with no durable entities, which is the normal case;
- it is deterministic on the development session id, so retry with the same
  idempotency key resolves the same child;
- the development session owns the resulting lifecycle relationship explicitly,
  and `closeSession` is what retires it.

If a future target genuinely needs a running child world rather than a source
branch, that is a different feature with a different operation. It is not what
"build my working head" requires.

## 37. Development session model

```ts
type DevelopmentSessionMode = "semantic" | "native-tool";

interface DevelopmentSessionV1 {
  version: 1;
  sessionId: string;
  ownerRuntimeId: string;
  ownerUserId: string;
  parentContextId: string;
  developmentContextId: string;
  repositoryId: string;
  repoPath: string;
  mode: DevelopmentSessionMode;
  basis: {
    parentWorkingHead: VcsStateNodeRef;
    childBaseEvent: VcsStateNodeRef;
  };
  nativeTree?: {
    executorId: string;
    ownedRootId: string;
    sourceUri: string;
    lastCheckpointRevision: string;
  };
  status: "opening" | "ready" | "checkpointing" | "closing" | "closed" | "requires-repair";
  createdAt: number;
  updatedAt: number;
  repair?: { phase: string; primaryError: string; cleanupErrors: string[] };
}
```

The development child context is required even for a direct semantic session:

- it gives the work a lifecycle owner;
- it prevents launch bookkeeping from mutating the user's active context;
- it makes native-tool snapshot commits explicit;
- it gives completed work a normal integration source event.

### Opening a semantic session

1. Resolve the caller's verified context and current VCS status.
2. Resolve the requested repository by stable repository id, failing with a
   typed error if it has not been adopted (§34.1).
3. Create a deterministic child context through the semantic context fork of
   §36.1, keyed by the development session id. No runtime entity is cloned.
4. Record the exact parent working head and child state.
5. Return `ready`.

Retry with the same idempotency key returns the same session.

### Opening a native-tool session

After forking:

1. Commit the complete inherited working chain **inside the child context**
   with a generated message such as `Development session base <sessionId>`.
   The parent context remains unchanged and may remain dirty.
2. Materialize that exact child event into an executor-owned private tree.
3. Write a session marker outside the repository root containing only opaque
   ids and digests.
4. Launch the selected native tool with an allowlisted environment.

This base commit is not published. Its purpose is to make the child clean so
`vcs.importSnapshot` can admit explicit tool checkpoints.

## 38. Native-tool checkpoint protocol

Native edits are external observations. A checkpoint:

1. freezes tool writes through the executor's cooperative checkpoint hook;
2. scans the owned tree while rejecting unsupported entry types;
3. writes every file to CAS and constructs a strictly ordered snapshot
   descriptor;
4. computes a deterministic snapshot revision from repository id, paths,
   modes, and content hashes;
5. calls `vcs.importSnapshot` in the development child context with:
   - `source.kind = "filesystem"`;
   - a canonical credential-free URI such as
     `vibestudio-development://session/<sessionId>`;
   - the computed snapshot revision;
   - the existing stable repository id;
6. records the returned event, work unit, application, and external snapshot;
7. resumes the tool.

The import does not infer moves or copies. Same-path files preserve the
identity rules of current snapshot import; new/deleted paths are recorded as
external snapshot effects. If exact move/copy intent matters, the tool must use
the normal typed VCS API rather than raw filesystem mutation.

There is no background bidirectional synchronization. New parent-context work
does not flow into an active native session. To incorporate it, close or
checkpoint the session, integrate the parent's committed event through normal
semantic operations, or create a new session. This avoids an unreviewable
three-way filesystem reconciler.

## 39. Exact execution snapshot

Every run uses:

```ts
interface DevelopmentExecutionSnapshotV1 {
  version: 1;
  sessionId: string;
  developmentContextId: string;
  repositoryId: string;
  sourceState: VcsStateNodeRef;
  repositoryManifestDigest: Sha256;
  materializedTreeDigest: Sha256;
  recipe: DevelopmentRecipeV1;
  recipeDigest: Sha256;
  toolchain: {
    node: { digest: Sha256; version: string; platform: string; arch: string };
    pnpm: { digest: Sha256; version: string };
    hostSourceBuild: { digest: Sha256 };
  };
  declaredEnvironment: Record<string, string>;
  environmentDigest: Sha256;
  snapshotDigest: Sha256;
}
```

`declaredEnvironment` contains reviewed build inputs only. Secrets and ambient
machine paths are forbidden. The executor adds runtime-only secret handles
after snapshot identity and never includes secret values in logs or records.

Materialization writes into a run-owned root. The build never reads:

- the shared context projection;
- the native tool tree directly;
- the source server checkout;
- another run's output;
- ambient global Node or pnpm installations.

## 40. Recipe contract

```ts
interface DevelopmentRecipeV1 {
  version: 1;
  target:
    | { kind: "current-host-client"; client: "electron" }
    | { kind: "isolated-host"; includeClient: boolean };
  install: {
    lockfileDigest: Sha256;
    mode: "frozen";
    network: "offline" | "approved-registry";
  };
  commands: readonly [
    { id: "install"; executable: "pnpm"; args: readonly string[] },
    { id: "build"; executable: "node"; args: readonly string[] },
  ];
  platform: string;
  arch: string;
}
```

Recipes are selected from a reviewed registry for the Vibestudio repository.
Callers choose a target and bounded options; they cannot submit arbitrary
commands or executable paths.

Dependency installation is a visible native-code execution boundary. A frozen
lockfile does not make package lifecycle scripts safe. Approval binds the exact
execution snapshot and recipe digest.

### 40.1 The standing development grant is required, not hypothetical

Binding approval to the exact snapshot digest has an immediate consequence:
every source edit changes the digest, so every iteration of the edit → build →
run loop raises a fresh approval prompt carrying the seven facts in §49.

Self-development _is_ that loop. A design that prompts on every iteration is not
a cautious version of this feature; it is a feature nobody will use, and the
predictable outcome is a user who approves without reading — which is strictly
worse for safety than one well-understood grant.

Revision 2 deferred this to "a standing watch approval, if ever supported."
That deferred the single most important ergonomic question in RFS-4 to an
unscheduled future. It ships in RFS-4A:

```ts
interface DevelopmentStandingGrantV1 {
  version: 1;
  grantId: string;
  ownerRuntimeId: string;
  ownerUserId: string;
  /** Exactly one repository, in exactly one development context. */
  repositoryId: string;
  developmentContextId: string;
  /** Reviewed recipe ids, not arbitrary commands. */
  recipeIds: readonly string[];
  /** Bound executor. A different machine is a different decision. */
  executorId: string;
  /** Source lineage the grant covers. */
  lineage: {
    /** Descendants of this state only. */
    baseState: VcsStateNodeRef;
    /** Fails closed if the install inputs change. */
    lockfileDigest: Sha256;
  };
  network: "offline" | "approved-registry";
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
}
```

What the grant covers: repeated `development.start` on snapshots that differ
only in source content descended from `baseState`, using a listed recipe, on the
bound executor, until expiry.

What it does not cover, each of which re-prompts:

- a different repository, context, executor, or recipe;
- a `lockfileDigest` change — new dependencies are new native code, and this is
  the boundary the frozen lockfile does _not_ protect;
- a widening of `network`;
- a source state not descended from `baseState`;
- anything after `expiresAt` or `revokedAt`.

The prompt that creates the grant states its full scope and duration in the
terms above, and is visibly a broader decision than a single run. The
Development surface (§50) shows an active grant, its remaining time, what it
covers, and a one-click revoke. A grant that cannot be seen and revoked from the
surface it authorizes is not an acceptable implementation.

Expiry is a bound, not a renewal prompt: the grant simply stops, and the next
run prompts normally.

## 41. Development run model

```ts
type DevelopmentRunState =
  | "accepted"
  | "materializing"
  | "awaiting-execution-approval"
  | "installing"
  | "building"
  | "starting"
  | "awaiting-readiness"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "cancelled"
  | "requires-repair";

interface DevelopmentRunV1 {
  version: 1;
  runId: string;
  sessionId: string;
  ownerRuntimeId: string;
  target: DevelopmentRecipeV1["target"];
  snapshot: DevelopmentExecutionSnapshotV1;
  state: DevelopmentRunState;
  commitPoint:
    | "none"
    | "snapshot-retained"
    | "artifacts-verified"
    | "instance-registered"
    | "ready";
  artifacts?: ExecutionArtifactRefV1;
  instance?: {
    instanceId: string;
    generationId: string;
    lifecycle: "ephemeral";
  };
  attachedHostSessionId?: string;
  createdAt: number;
  updatedAt: number;
  terminal?: {
    result: "ready" | "stopped" | "failed" | "cancelled" | "requires-repair";
    error?: string;
    cleanupErrors: string[];
  };
}
```

Run state is durable before the first native effect. Every transition is
compare-and-swap against the expected state and idempotency key.

## 42. Development service API

Add one service schema, preferably `development`, rather than restoring the old
`devHost` name:

```ts
development.openSession({
  repositoryId: string;
  mode: "semantic" | "native-tool";
  nativeTool?: "claude-code" | "system-editor";
  idempotencyKey: string;
}): DevelopmentSessionV1

development.getSession({ sessionId: string }): DevelopmentSessionV1

development.listSessions({
  cursor?: { createdAt: number; sessionId: string };
  limit?: number; // 1..200
}): {
  sessions: DevelopmentSessionV1[];
  nextCursor: { createdAt: number; sessionId: string } | null;
}

development.checkpoint({ sessionId: string; idempotencyKey: string }): {
  session: DevelopmentSessionV1;
  importedEventId: string;
  snapshotRevision: string;
}

development.closeSession({
  sessionId: string;
  disposition: "retain-context" | "destroy-context";
  idempotencyKey: string;
}): DevelopmentSessionV1

development.start({
  sessionId: string;
  target: DevelopmentRecipeV1["target"];
  idempotencyKey: string;
}): { runId: string }

development.get({ runId: string }): DevelopmentRunV1

development.events({
  runId: string;
  after: number;
  limit: number;
  follow?: boolean;
}): { events: DevelopmentRunEventV1[]; next: number }

development.stop({ runId: string; idempotencyKey: string }): DevelopmentRunV1

development.list({
  state?: DevelopmentRunState;
  sessionId?: string;
  cursor?: { createdAt: number; runId: string };
  limit?: number; // 1..200
}): {
  runs: DevelopmentRunSummaryV1[];
  nextCursor: { createdAt: number; runId: string } | null;
}
```

§41 requires every state transition to be compare-and-swap against an
idempotency key, so every mutating method carries one. `closeSession` and `stop`
are mutating and destructive-adjacent; revision 2 omitted their keys, which
would have made exactly the transitions with native side effects the ones a
retry could double-apply.

Reads (`getSession`, `listSessions`, `get`, `events`, `list`) take no key.
Durable-history lists are cursor-paged in stable `createdAt`/id order and never
return more than 200 records, so a long-lived profile cannot make the
Development surface perform an unbounded refresh.

`closeSession({disposition:"destroy-context"})` is destructive and requires
normal context-boundary authority. It cannot remove a context with an active
run.

The service does not expose `exec`, raw environment mutation, arbitrary paths,
or an eval method.

## 43. Trusted executor

Create a narrow provider contract implemented by a trusted extension or
host-local executor:

```ts
interface DevelopmentExecutor {
  identity(): Promise<{
    executorId: string;
    platform: string;
    arch: string;
    capabilities: Array<"materialize" | "native-tool" | "electron-client" | "isolated-host">;
  }>;
  materialize(input: MaterializeRequest): Promise<MaterializeReceipt>;
  checkpoint(input: CheckpointRequest): Promise<SnapshotDescriptor>;
  build(input: BuildRequest): Promise<BuildReceipt>;
  start(input: StartRequest): Promise<StartReceipt>;
  status(input: StatusRequest): Promise<ExecutorStatus>;
  stop(input: StopRequest): Promise<StopReceipt>;
}
```

Requests contain opaque owned-root ids and verified digests, never arbitrary
host paths or commands.

The executor must:

- create roots with restrictive permissions;
- verify every path remains beneath the owned root;
- reject symlinks, sockets, devices, gitlinks, and unsupported modes unless the
  canonical semantic format explicitly supports them;
- pass an allowlisted environment;
- strip parent RPC tokens, database paths, inspector endpoints, management
  tokens, and unrelated credentials;
- redact logs before persistence;
- record process group/job object identity;
- verify ownership before signal or deletion;
- work on Linux, macOS, and Windows using platform process ownership primitives.

## 44. Reusing the current instance supervisor

Refactor `src/dev/runInstance.ts` into:

- a reusable `DevInstanceSupervisor` library;
- the existing CLI adapter;
- the RFS-4 executor adapter.

The reusable owner takes explicit:

- repo root;
- source execution root;
- instance id;
- instance state root;
- lifecycle;
- bootstrap workspace policy;
- environment;
- readiness callback.

It preserves the current lease, generation, ready-file, CLI credential, signal,
and cleanup contracts.

For an isolated development host:

1. build verified host artifacts in the execution root;
2. allocate an ephemeral instance id derived from the run id;
3. register the instance generation;
4. start the child server from the execution root;
5. bootstrap an ordinary paired CLI/device credential;
6. wait for exact-generation readiness;
7. publish `ready` only after the route described below is attached.

A failed candidate never mutates the current source instance or another named
instance.

## 45. Current-host client target

`current-host-client`:

1. builds the Electron client from the exact execution snapshot;
2. obtains a normal one-time invite from the current host for the initiating
   user;
3. launches the built client through a capable native executor;
4. waits for the client to authenticate and report its exact execution digest;
5. marks the run ready.

The target does not replace the running installed client, modify global
installation state, or use the server admin credential.

Remote hosts require an executor on the selected client device. If none is
available, fail with `executor-unavailable`; do not silently launch on the
server.

This target depends on RFS-4B's executor and nothing else. It crosses no host
boundary: the client authenticates to the current host through an ordinary
one-time invite, exactly as any client does. It is sequenced immediately after
4B (§68), not after attached-host routing.

## 46. Attached isolated-host routing

An isolated child must be usable through normal typed service clients. Do not
add `development.eval`.

Add a generic owner-bound `AttachedHostSession` to the existing routed
connectivity layer:

```ts
interface AttachedHostSessionV1 {
  sessionId: string;
  ownerRuntimeId: string;
  ownerUserId: string;
  developmentRunId: string;
  parentHostId: string;
  childHostId: string;
  childGenerationId: string;
  routePublicKey: string;
  authorityCeilingDigest: Sha256;
  expiresAt: number;
  state: "attaching" | "ready" | "closed";
}
```

The trusted executor pairs to the child using an ordinary device credential.
The parent and child establish an ephemeral Ed25519 route key bound to:

- parent and child host ids;
- exact child generation;
- development run;
- initiating user and runtime;
- authority ceiling;
- expiry.

The attached client transport stamps every ordinary RPC envelope with a signed
parent invocation reference. The child verifies the route and resolves the
ordinary child-side caller/session. The route cannot use the child admin token
and cannot widen authority beyond either host's policy.

The runtime helper:

```ts
const child = await hosts.attach(attachedHostSessionId);
await child.services.eval.start(...);
```

returns the same generated typed clients used locally. Service schemas,
authorization, errors, cancellation, and streaming remain unchanged.

## 47. Cross-host approval routing

When a child invocation needs approval:

1. child authority evaluation creates its ordinary canonical invocation
   snapshot;
2. child sends a signed challenge over the attached host session;
3. parent verifies child generation, run, owner, route expiry, invocation
   digest, capability, resource, tier, and operation substance;
4. parent enqueues the challenge in the canonical approval queue;
5. user decision binds the exact child invocation digest;
6. parent signs the decision result;
7. child verifies it and mints its own exact once grant or denial record;
8. route loss closes the challenge and the child run reports
   `approval-route-lost`.

Standing parent grants are not copied into the child. A child standing grant
requires its own explicit product decision. Critical and irreversible actions
always preserve current confirmation rules.

## 48. Crash recovery

On server start, reconcile every non-terminal development run:

- before `snapshot-retained`: remove only operation-owned scratch and mark
  failed;
- after `snapshot-retained` but before artifacts: resume materialization/build
  with the same digests;
- after `artifacts-verified`: resume start or retain artifacts for retry;
- after `instance-registered`: resolve the exact instance generation and either
  reattach or stop it;
- at `ready`: restore attached route state if both hosts prove the exact
  generation; otherwise close the route and report interruption;
- if process ownership or effect outcome cannot be proven, enter
  `requires-repair`.

Never delete a PID, directory, credential, or registry row merely because its
name resembles a run id.

## 49. Authority model

Introduce semantic capabilities:

- `development.session.open`;
- `development.session.checkpoint`;
- `development.session.close`;
- `development.native.execute`;
- `development.client.launch`;
- `development.host.launch`;
- `development.host.stop`;
- `development.host.attach`.

Resource keys bind workspace, context, repository, executor, snapshot digest,
target, and run as appropriate.

Opening a semantic session is routine context work subject to the existing
context boundary. Native execution and launches are gated. A prompt must state:

- exact repository and context;
- exact snapshot digest;
- target and executor machine;
- whether dependency scripts/native code will run;
- whether network access is requested;
- whether the result starts a new host or client.

The executor's installed code must declare these capabilities, but its manifest
is not a grant.

## 50. UX

The Development surface shows:

- source context, repository, and exact working state;
- whether source contains uncommitted semantic changes;
- semantic or native-tool session mode;
- last native checkpoint and pending external changes;
- selected target and executor;
- materialize/install/build/start/readiness progress;
- exact build and execution digests;
- child instance id/generation and attached-route state;
- active standing grant, its coverage, remaining time, and a revoke action
  (§40.1);
- logs with secret redaction;
- stop, retry, checkpoint, integrate, and inspect actions.

It must say plainly that native build/project code executes with local OS
authority unless a platform sandbox is active.

### 50.1 `requires-repair` must have an exit

`requires-repair` is reachable from both `DevelopmentSessionV1.status` and
`DevelopmentRunState`, and §48 routes every unprovable outcome into it. Revision
2 then offered no action that leaves it. A state the system can enter, that the
user cannot leave, is a dead end — the exact "trust surface dead-end" pattern
the July 2026 UX review flagged as systemic.

Every `requires-repair` record carries its `repair: { phase, primaryError,
cleanupErrors }` and must offer:

- **Inspect.** Show the phase, the primary error, every cleanup error, the
  commit point reached, and — explicitly — what is known to still exist:
  execution root, instance registration, child process, native tree, imported
  events. A repair surface that cannot say what is on disk is not a repair
  surface.
- **Retry from the recorded commit point.** Permitted only where §48 says the
  outcome is provable. Where it is not, this action is absent, not disabled with
  an unexplained tooltip.
- **Force-retire.** Abandon the run or session, attempting owned cleanup and
  reporting exactly what it could not remove, with the ids needed to find it.
  Force-retire never claims success it did not achieve, and never deletes
  anything it cannot prove it owns (§48's final rule holds here).
- **Keep.** Leave it untouched and stop surfacing it as actionable. The record
  remains inspectable.

Force-retire on a session with a live native tree states what happens to
uncheckpointed work before it runs, and offers a checkpoint first where the tree
is still readable.

The same requirement will apply to eval's `approval-route-lost` when RFS-5.1
introduces it: the run must report it as a distinct terminal condition with a
restart action, never as a generic failure and never, silently, as an approval.

## 51. Security review gate for RFS-4C

RFS-4C introduces the highest-risk surface in this document: ephemeral route
keys, a cross-host authority ceiling, and an approval decision made on one host
that authorizes an invocation on another. Nothing else here creates a new trust
boundary between two running systems.

A written threat model is a precondition for starting 4C implementation, not a
deliverable of it. It must cover at minimum:

- **Route key compromise.** What an attacker holding `routePublicKey`'s private
  half can do; why expiry and generation binding bound the damage; whether key
  material ever touches durable storage or logs.
- **Approval replay and substitution.** Why a parent-signed decision for
  invocation A cannot authorize invocation B on the child, including after a
  child restart, a generation change, or a run id collision.
- **Ceiling bypass.** Proof that `authorityCeilingDigest` is evaluated on the
  child and cannot be asserted by the parent alone, and that a compromised
  parent cannot widen child authority beyond the child's own policy.
- **Confused deputy.** Whether the child can induce the parent to enqueue an
  approval prompt whose displayed substance differs from the invocation that
  will execute.
- **Route loss and partition.** What happens to in-flight challenges, pending
  grants, and cleanup authority when the route drops mid-decision; why
  `approval-route-lost` cannot be mistaken for approval.
- **Credential isolation.** Confirmation that the child admin token is
  unreachable over the route, and that stripping in §43 covers every credential
  class the parent holds.
- **Downgrade.** Whether an attacker can force the pair onto a weaker path — an
  unattached direct connection, an older generation, an expired-but-accepted
  session.

The threat model is reviewed alongside the existing security review documents
under `docs/`. 4C does not enter the delivery order until it is accepted. If the
threat model concludes the design needs changes, those changes precede
implementation.

## 52. Tests

### Conventional

- semantic context fork preserves the exact dirty working head;
- the fork clones no durable entity, and succeeds for a context that has none —
  the case `runtime.cloneContext` refuses (§36.1);
- a session against an unadopted repository fails with the typed adoption error
  and does not import implicitly (§34.1);
- upstream refresh with local semantic work integrates rather than resets;
- native child base commit does not mutate parent;
- checkpoint imports a deterministic exact snapshot;
- unsupported native entries fail before VCS mutation;
- checkpoint retry reuses command id and snapshot revision;
- parent integration recognizes inherited base work as shared/already
  satisfied;
- build reads only the execution root;
- recipe/toolchain/environment digests are stable;
- executor rejects path escape and foreign process ownership;
- isolated instances preserve current lease/generation contracts;
- current-host client proves its execution digest;
- child route rejects wrong generation, owner, expiry, and signature;
- child approval route binds exact invocation and closes on route loss;
- recovery resumes each commit point;
- cleanup error remains secondary.

Each §51 threat-model conclusion that asserts a bound must have a corresponding
negative test. A threat model without tests is documentation, not a control.

### Headless system tests

Add exact discoverable scenarios:

- `self-development-current-client`;
- `self-development-isolated-host`;
- `self-development-dirty-semantic-state`;
- `self-development-native-checkpoint`;
- `self-development-build-failure-recovery`;
- `self-development-child-eval`;
- `self-development-child-approval`;
- `self-development-owned-cleanup`.

Each validator binds success to exact state, execution digest, instance
generation, typed invocation, and cleanup evidence. It must not accept prose
claims or unrelated child processes.

## 53. Delivery phases

### RFS-4.0: source adoption

- `projects/vibestudio` established through `gitInterop.importProject`;
- canonical upstream, stable repository identity, adopted event;
- refresh semantics with local semantic work;
- adoption UX and the typed not-adopted error.

A precondition for everything below (§34.1), and the only phase with no
dependency on the development service.

### RFS-4A: exact semantic build

- development sessions;
- semantic context fork (§36.1) — no runtime entity cloning;
- exact execution snapshot;
- reviewed recipe;
- the standing development grant (§40.1);
- build-only run and diagnostics;
- no native tool and no launch.

### RFS-4B: isolated host

- reusable instance supervisor;
- trusted executor;
- isolated start/status/stop/recovery;
- exact readiness and artifact retention;
- `requires-repair` affordances (§50.1).

### RFS-4D: current-host client — depends on 4B only

- client-device executor selection;
- one-time invite;
- execution-digest handshake.

### RFS-4E: native tool session — depends on 4B only

- child base commit;
- owned writable tree;
- explicit snapshot checkpoint;
- normal semantic integration back to parent.

### RFS-4C: attached host — gated by §51

- accepted threat model;
- generic attached host session;
- typed child clients;
- signed challenge routing;
- child eval through the normal eval service.

The ordering ships every target that needs only a local executor — builds,
isolated hosts, the current-host client, native checkpoints — before the one
that opens a trust boundary between two running systems. 4C is last not because
it is least valuable but because it is the only phase whose failure mode is a
security failure.

## 54. Acceptance criteria

RFS-4 is complete when:

- a dirty semantic context can build and launch exact code without committing
  or mutating the parent;
- no build reads a shared projection or source checkout;
- isolated hosts reuse the canonical instance supervisor;
- child services are reached through normal typed clients;
- the 4C threat model is accepted and every asserted bound has a negative test;
- native edits enter semantic history only at explicit external snapshot
  checkpoints;
- every native effect is owner-scoped, approval-bound, inspectable, and
  recoverable;
- focused tests, category system tests, and smoke coverage pass from a fresh
  bootstrap workspace.

# RFS-5. One per-run-attenuated eval lifecycle

## 55. Objective and sequencing

Converge eval on one durable handle-based server lifecycle while preserving:

- owner-scoped notebook state;
- exact context and parent resolution;
- live kernel residency and cold-recovery diagnostics;
- asynchronous durable settlement;
- cooperative cancellation and cleanup authority;
- optional positive deadlines with host watchdog recovery;
- current semantic authority acquisition;
- large result paging.

Add explicit per-run attenuation without reintroducing eval-specific grants or
old generated product catalogs.

### 55.1 Why this no longer waits on RFS-4C

Revision 1 sequenced RFS-5 after RFS-4C. The only coupling is two optional
values: `attachedHostSessionId` in run identity, and the attached-host route
ceiling in the §58 authority intersection. Neither is required for convergence
of `start/get/events/cancel`, per-run manifests, or strict-mode attenuation.

Gating on 4C was actively harmful. Invariant 3.2 forbids a compatibility layer,
so the migration must delete `run`, `startRun`, and `getRun` in one tranche —
and their consumer set grows with every week of delay. Today that set is 17
`eval.run` call sites plus the agent vessel's defer path
(`workspace/packages/agentic-do/src/agent-vessel.ts:4207`) and its test doubles.
Waiting for the largest package in the document to finish before touching it
maximizes the cost of the change that has to be atomic.

RFS-5 therefore ships after RFS-1, and it models **only local eval**.

An earlier draft of this revision reserved attached-host scaffolding — an
always-absent `attachedHostSessionId`, an unreachable `approval-route-lost`
state, an empty ceiling term — to spare RFS-5.1 a later record change. That is
speculative compatibility shimming, and it contradicts invariant 2 in the same
document that states it. These are internal pre-release records; adding an
unreachable state costs real complexity now (§50.1 would have to specify a
repair affordance for a condition that cannot occur) to avoid a cheap change
later. It is removed.

What survives is a structural choice, not a schema one: the outbound authority
context is written as an intersection over a **list** of ceilings rather than a
fixed pair of operands (§63). That is how the code should be written regardless
of whether anything ever appends to it, and it declares nothing.

One rule does hold permanently and is asserted now, because it is about
authority rather than compatibility: **transport and relationship facts are
never accepted from eval input.** See §57.2. RFS-5.1 will populate attached-host
provenance from verified transport, which is exactly why input may not name it —
before or after 4C.

RFS-5.1, delivered with or after RFS-4C, adds attached-host provenance to the
run record and the route ceiling to the intersection. That is an internal record
change in a pre-release system, and the clean-cut rule says to make it then.

## 56. Public lifecycle

The server exposes:

```text
start ──> (run executes in the owner's EvalDO)
  │                     │
  │                     ├─── completion push ──> registered result receiver   [primary]
  │                     │
  └──> get / events ────┴─── poll ─────────────> terminal                     [backstop]
         │
         └─> cancel

reset/dispose/readScopeTextPage/deleteScopeValue remain owner-scoped controls
```

Remove public `run`, `startRun`, and `getRun`.

Note the method name: the current schema's disposal method is `dispose`
(`packages/service-schemas/src/eval.ts:278`), not `release`. Revision 1 named a
method that does not exist. Migration checklists must use the real names or the
clean-cut deletion in §64 will miss its target.

### 56.1 The completion push is primary, not decorative

Revision 2 drew this lifecycle as `start -> get/events -> terminal`, which
described polling as the mechanism. That is wrong about the current system and
would be a serious regression if implemented literally.

Today the EvalDO pushes the terminal result to the initiating receiver:
`this.rpc.call(args.agentRef, "onEvalComplete", [...])`
(`packages/builtin/src/eval-engine/EvalDO.ts:874`). The agent vessel's own comment states
the relationship explicitly — `getRun` is "a poll BACKSTOP, not the primary
settle path" (`workspace/packages/agentic-do/src/agent-vessel.ts:4218-4226`).

The push is the hot path for every agent eval in the product. Converging the
public lifecycle must preserve it:

- `eval.start` accepts an optional `resultReceiver` describing where to deliver
  the terminal snapshot. When present, the EvalDO pushes on settle exactly as
  it does today.
- The push carries the terminal snapshot, not a wake-up. A receiver that got
  the push never needs a follow-up `get`.
- `get`/`events` remain the backstop for a lost push, a late-joining observer,
  a restarted caller, and any caller that did not register a receiver.
- A push failure is not a run failure. It is logged, the run stays terminal and
  readable, and the backstop settles it.

Polling is what you fall back to, not what you build on.

### 56.2 `execute` must work over a raw call function

Revision 2 placed `execute` in generated clients only. At the audited baseline,
the two hottest callers did not use a generated client:

- the agent harness tool calls `callMain<EvalRunResult>("eval.run", [...])`
  (`workspace/packages/harness/src/tools/eval.ts:227`);
- the agent vessel calls `scopedRpc.call("main", "eval.startRun", [...])`
  (`workspace/packages/agentic-do/src/agent-vessel.ts:4207`).

Both addressed the service by method name over a raw transport. A
generated-client-only helper reaches neither, so the migration would produce
three independent hand-rolled start/settle/cancel loops — precisely the
duplication invariant 1 forbids.

Ship `execute` as one shared composition parameterized by a call function:

```ts
type EvalCall = <T>(method: string, args: unknown[]) => Promise<T>;

export function createEvalExecutor(
  call: EvalCall,
  options?: {
    receiver?: EvalResultReceiverRef;
    signal?: AbortSignal;
  }
): (input: EvalStartInputV1) => Promise<EvalRunResult>;
```

Generated clients bind their own transport to it. The harness binds `callMain`.
The vessel binds `scopedRpc.call`. One implementation of settle ordering, abort
semantics, push/backstop reconciliation, and large-payload windowing.

`execute` is still composition, not a service method or alternate execution
path. There is exactly one server lifecycle underneath it.

Panels, CLI, agents, system tests, and — after RFS-5.1 — attached hosts all use
the same server methods, and all reach them through the same executor.

## 57. Input contract

```ts
type EvalSource =
  | {
      kind: "inline";
      code: string;
      pathHint?: string;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
    }
  | {
      kind: "context-file";
      path: string;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
    };

interface EvalAuthorityIntentV1 {
  mode: "adaptive" | "strict";
  effects: "read-only" | "mutable";
  approvals: "prompt" | "pregranted-only";
  requests?: CapabilityScope[];
  preauthorize?: EvalPreauthorizationIntent[];
}

interface EvalStartInputV1 {
  source: EvalSource;
  target?: { kind: "caller" } | { kind: "owner-session"; sessionId: string };
  /** `subKey` in the current schema. For an agent, this is its channelId. */
  scope?: {
    key: string;
    lifecycle?: "persistent" | "finite";
  };
  /** Top-level, as today: clears scope/db atomically before this run. */
  reset?: boolean;
  imports?: Record<string, string>;
  /** Opt-in wall bound. Same name and meaning as the current parameter. */
  timeoutMs?: number;
  /** Caller-owned stable handle. See §57.1. */
  runId: string;
  /** Optional push target for the terminal snapshot. See §56.1. */
  resultReceiver?: EvalResultReceiverRef;
  authority?: Partial<EvalAuthorityIntentV1>;
}
```

There is no `channelId`. See §57.2.

Defaults:

```ts
{
  mode: "adaptive",
  effects: "mutable",
  approvals: "prompt"
}
```

Validation:

- `requests` is valid only in strict mode;
- requests use current semantic capability ids and `ResourceScope`;
- requests cannot contain capability wildcards unless the initiating sealed
  code already has an equivalent reviewed broad request;
- `preauthorize` is valid only with `approvals:"prompt"`;
- `pregranted-only` never creates an approval card;
- owner-session selection is verified against a live same-host binding, not
  caller-supplied owner/context strings;
- no relationship or transport fact may be named in input — see §57.2;
- `timeoutMs` is opt-in and cannot be used to shorten authority cleanup below
  its safe boundary.

### 57.1 Run identity is caller-owned, because replay depends on it

Revision 2 specified a required `idempotencyKey` and a server-assigned `runId`.
That breaks the agent crash-replay contract, and the current system already got
this right.

Today the vessel derives its run id deterministically _before_ calling —
`const runId = ids.invocationEffect(invocationId)`
(`workspace/packages/agentic-do/src/agent-vessel.ts:4185`) — and passes it into
`startRun`. This buys two properties at once:

- **Idempotence.** A replayed invocation produces the same run id, so
  `startRun` recognizes the existing run instead of executing the code twice.
  Arbitrary code is never duplicated by a crash.
- **Addressability.** A vessel that crashed _before receiving the response_
  still knows the run id, because it computed it. It can poll, cancel, or
  re-register a receiver.

A server-assigned id keyed by an opaque `idempotencyKey` provides only the
first. The caller learns the id from a response it may never receive, and a
replayed caller has no address for its own in-flight run — the exact situation
replay exists to handle.

Therefore:

- `runId` is caller-supplied and required. It is the idempotency key; there is
  not a second one.
- `start` with a known `runId` and byte-identical normalized input returns the
  current snapshot of that run. It does not start a second execution.
- `start` with a known `runId` and _different_ normalized input is a typed
  `run-identity-drift` error. It never silently returns the stale run, and it
  never overwrites the existing one. This is the same drift rule Appendix A
  applies to `initializeChannel`.
- `runId` must be caller-namespaced within the owner scope. The service rejects
  a `runId` that collides across scope keys.
- `runDigest` (§59) still binds the full normalized intent. `runId` addresses
  the run; `runDigest` proves what it was.

Every read and control method addresses runs by the same caller-owned id, so a
recovering caller needs nothing it did not compute itself.

### 57.2 Relationship facts are derived, never supplied

Revision 2 carried a `channelId?: string` on `EvalStartInputV1` and never
constrained it in validation. That is a confused-deputy regression against a
service that currently gets this right, and it violates this document's own
invariant 5.

The current implementation derives channel identity from the **verified agent
binding**, not from arguments: the owner resolves through
`ctx.caller.agentBinding` (`src/server/services/evalService.ts:355-364`), and an
agent-bound run additionally has its causal parent checked against
`channelTrajectoryFor(agentBinding.channelId)`, rejecting a cause that "does not
belong to the relay's host-bound trajectory"
(`src/server/services/evalService.ts:415-430`).

Accepting a caller-named channel would let code with a legitimate eval capability
address a channel it has no relationship to, and would do it through the exact
argument the service currently refuses to trust.

So: `channelId` is removed from input, and the rule generalizes to every fact of
this kind. Channel, mission, agent, context, owner, host generation, and
attached-host identity are all resolved **exclusively** from verified transport
and entity bindings. Input may carry intent — what to run, how to bound it, how
to attenuate it — and nothing about who the caller is or what it is related to.

The harness tool passes `subKey` and `channelId` as the same value today
(`workspace/packages/harness/src/tools/eval.ts:227-236`). After this change it
passes the scope key alone; the channel comes from the binding that already
proves it.

This is the one permanent rule §55.1 refers to, and it is asserted now with
tests (§65), independently of whether attached hosts ever exist.

## 58. Authority semantics

The per-run manifest is an attenuation over current authority.

For each outbound invocation:

```text
receiver declaration
∩ sealed executor code request
∩ verified initiating code/session authority
∩ attached-host route ceiling, when present
∩ per-run manifest
∩ live grants
∩ live ownership/membership/relationship predicates
− denials and locks
```

RFS-5 implements this without an attached-host term, because no such route
exists yet. Write it as an intersection over a list of ceilings rather than a
fixed chain — that is the right shape for an intersection regardless, and it
declares nothing about a transport that has not shipped. RFS-5.1 appends the
route ceiling when RFS-4C makes one real.

### Adaptive mode

The manifest does not pre-enumerate operations. When code invokes a reviewed
code-callable receiver:

1. canonical dispatch resolves capability, resource, tier, target
   requirements, operation substance, and invocation snapshot;
2. read-only containment is enforced before acquisition;
3. existing grants are evaluated;
4. if acquirable and prompts are allowed, the canonical acquisition coordinator
   is used;
5. after a decision, the exact invocation retries through the same dispatcher.

Dynamic discovery is not ambient privilege. It is bounded by receiver exposure,
sealed code requests, caller/session authority, relationships, and denials.

### Strict mode

Every protected capability/resource must be covered by a declared run request.
A missing request returns a structured `run-manifest-denied` authority failure.
Approval cannot widen an exact eval request allowlist.

### Read-only

Use the existing receiver sensitivity enforcement. Do not maintain a separate
eval method allowlist. Direct RPC attestation carries the same read-only bit.

### Pregranted-only

If the invocation is not already allowed, return a structured failure
describing the missing capability/resource and do not enqueue a challenge.

### Preauthorization

Before execution, resolve each typed operation through the canonical
dispatcher's preflight path:

- exact method and args;
- exact prepared state and resource;
- exact tier and operation substance;
- current relationships;
- current grants/denials.

The user may approve exact prospective invocations. The resulting once grants
bind the final invocation snapshot digest. Preauthorization does not approve a
string capability independently of arguments.

## 59. Run identity and provenance

```ts
interface EvalRunIdentityV1 {
  runId: string;
  ownerRuntimeId: string;
  contextId: string;
  sourceDigest: Sha256;
  sourceState?: VcsStateNodeRef;
  scopeInputRevision: string | null;
  authorityManifestDigest: Sha256;
  initiatorChain: string[];
  runDigest: Sha256;
}
```

`runDigest` binds the exact normalized start intent, source bytes/state,
imports, scope input revision, authority manifest, initiator chain, owner,
context, target host generation, and caller-owned `runId`. Comparing a
recomputed `runDigest` against the stored one is how §57.1 detects identity
drift.

Inline code and context-file code both produce exact source digests. A
context-file path is resolved and retained before execution; later path changes
cannot alter the accepted run.

## 60. State machine

```ts
type EvalRunState =
  | "accepted"
  | "queued"
  | "preparing"
  | "awaiting-preauthorization"
  | "running"
  | "awaiting-challenge"
  | "cancellation-requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted";
```

Every state here is reachable in RFS-5. `approval-route-lost` belongs to
RFS-5.1, which adds it when a route exists that can be lost — declaring an
unreachable state now would oblige §50.1 to specify a repair affordance for a
condition that cannot occur.

Rules:

- acceptance is durable before returning a handle;
- only one owner/scope execution mutates the live notebook at a time;
- queued runs can be cancelled without activating the sandbox;
- cancellation becomes terminal only after registered cleanup settles;
- `timeoutMs` expiry is distinct from user cancellation;
- reaching a terminal state fires the completion push (§56.1) when a receiver
  is registered, before the run becomes visible as terminal to pollers, so a
  pushed caller never races its own backstop;
- non-yielding code may require current host watchdog recovery;
- process loss marks a running run `interrupted`; arbitrary code is never
  replayed automatically;
- prior external effects remain recorded even when the run fails or is
  interrupted;
- scope reset occurs only at a safe serialized boundary.

## 61. Events

```ts
interface EvalRunEventV1 {
  sequence: number;
  at: number;
  kind:
    | "state"
    | "console"
    | "progress"
    | "authority-requested"
    | "authority-decided"
    | "kernel"
    | "cleanup"
    | "diagnostic";
  payload: unknown;
}
```

Events are durable and bounded:

- console payloads are windowed/spilled through the existing large-value
  mechanism;
- authority events contain capability/resource/tier and acquisition ids, not
  secrets or raw credentials;
- `events({after,limit})` has a hard maximum and stable next cursor;
- `get` returns the latest snapshot and terminal result, not the full event
  history;
- system-test inspection may retain richer bounded provenance through its
  existing artifact store.

### 61.1 Live output is pushed through the canonical event service

A cursor-paged read API describes how to _catch up_. It does not describe how a
panel shows a running cell's console output, and specifying only the pull side
would silently downgrade a live surface into a polling loop.

`eval.events` remains one bounded cursor page. Live observers subscribe to the
canonical `eval:run-event` using `events.watch`, then use `eval.events` to catch
up after reconnect or backpressure:

```ts
events.watch({ names: ["eval:run-event"] })
eval.events({ target?, scopeKey?, runId, after?, limit? })
```

- `eval.events` returns one bounded page and a cursor. This is the catch-up and
  system-test path.
- `events.watch` owns live streaming, cancellation, backpressure, and error
  propagation; eval does not invent a second subscription transport.
- A follower that falls behind the retention bound receives a `diagnostic`
  event naming the gap and the cursor to re-read from. It is never silently
  truncated.
- Dropping a subscription never affects the run. Streams are observers.

Panels and the CLI's live view follow. Agents generally do not — they take the
§56.1 completion push and read `get` once. Nothing in the product needs a timer
to learn that an eval finished.

## 62. Service methods

```ts
eval.start(input): {
  runId: string;
  status: "accepted" | "already-running" | "terminal";
  runDigest: string;
  /** Present when `status` is "terminal" — a settled run needs no second call. */
  snapshot?: EvalRunSnapshotV1;
}

eval.get({ target?, scopeKey?, runId }): EvalRunSnapshotV1

eval.events({
  target?,
  scopeKey?,
  runId,
  after?: number,
  limit?: number,
}): {
  events: EvalRunEventV1[];
  next: number;
}

eval.cancel({ target?, scopeKey?, runId }): {
  status: "requested" | "cancelled" | "terminal";
}
```

Every method addresses a run by the caller-owned `runId` from §57.1. There is
no server-assigned handle a recovering caller could fail to know.

`start` returning `terminal` matters for the short-eval case. A replayed caller
whose run already settled, or a trivially fast run that completed within the
acceptance window, gets its result in the same round trip rather than paying
start + get. The current `run` shape achieved this by blocking; the converged
lifecycle achieves it without a second public method.

`reset`, `dispose`, `readScopeTextPage`, and `deleteScopeValue` use the same
verified target/scope routing type.

## 63. Internal implementation

Preserve the current EvalDO and evolve it:

1. replace separate synchronous/asynchronous service branches with durable
   `acceptRun`, keyed on the caller-owned `runId`;
2. **retain the terminal completion push.** `evalDO.ts:874`'s
   `rpc.call(agentRef, "onEvalComplete", ...)` becomes the general
   `resultReceiver` delivery of §56.1. It is preserved behavior, not a legacy
   path to be replaced by polling. Delivery failure is logged and does not
   change the run's terminal state;
3. let the shared `execute` composition (§56.2) reconcile push and backstop, so
   no caller implements settle ordering itself;
4. persist normalized authority manifest and run identity with the accepted
   row;
5. carry the manifest in the EvalDO's outbound authority context;
6. emit lifecycle/acquisition/cleanup events at owning transition points, and
   publish live records through `events.watch` (§61.1);
7. retain the current inter-cell lease, notebook recovery, scope paging,
   cancellation registry, and watchdog;
8. write the outbound authority context as an intersection over a ceiling list
   so RFS-5.1 can append the attached-host ceiling without restructuring.

Do not duplicate the acquisition coordinator inside EvalDO. EvalDO may suspend
on the canonical dispatcher's challenge, but the host owns presentation and
grant issuance.

## 64. Clean-cut migration

In one tranche:

- change service schema to `start/get/events/cancel`;
- update generated runtime clients;
- add the shared `createEvalExecutor` composition (§56.2) and bind it in the
  generated clients, the harness, and the vessel;
- update CLI, system-test runner, panels, and docs;
- migrate the 17 `eval.run` call sites, including
  `workspace/packages/harness/src/tools/eval.ts:227`;
- migrate the agent vessel defer path
  (`workspace/packages/agentic-do/src/agent-vessel.ts:4207`) and its test
  doubles in `chat-op.test.ts` and `agent-loop-driver.test.ts`;
- delete `run`, `startRun`, `getRun`, and their compatibility overloads;
- remove sync-specific service activity handling that no longer applies;
- regenerate authority matrices and runtime docs;
- migrate no durable pre-release run rows; reset incompatible EvalDO run
  metadata while preserving explicitly supported notebook scope data only if
  its codec remains exact.

Do not retain old and new method names together.

### 64.1 The agent tool surface is part of the migration

The `eval` agent tool's parameter schema and description
(`workspace/packages/harness/src/tools/eval.ts`) are agent-facing UX, not
incidental strings. The description is a tuned prompt covering kernel restarts,
scope recovery from stable ids, output windowing to `scope.$lastConsole` /
`scope.$lastReturn`, `help()` discovery, and the rule against calling
`eval.reset` from inside a running eval. Agents depend on every one of those
statements.

This tranche must therefore:

- keep `timeoutMs` and top-level `reset` with their current names and meanings —
  revision 2 renamed them to `deadlineMs` and `scope.reset` for symmetry, which
  bought nothing and would have invalidated tuned tool text;
- keep `subKey` as the wire name for the scope key, or rename it in the tool
  schema and description simultaneously — the current call passes `subKey` and
  `channelId` as the same value for a reason (`tools/eval.ts:227-236`) and that
  coupling must survive or be explicitly retired;
- re-read the description against the new lifecycle and correct anything it now
  misstates, rather than leaving prose that describes the removed blocking call;
- keep the tool's observable contract intact: one call in, one formatted result
  out. `execute` absorbs start/settle so the tool does not grow a polling loop
  or a new deferral state visible to the model.

A migration that changes the service but leaves the tool description describing
the old lifecycle reproduces the documented drift theme in the July 2026 UX
review, on the surface with the most readers.

Note that the EvalDO's _internal_ `startRun` method
(`packages/builtin/src/eval-engine/EvalDO.ts`, exercised by
`src/server/internalStorageWorkerd.test.ts:536` and
`packages/builtin/src/eval-engine/EvalDO.cancel.test.ts`) is a durable-object method, not
the public service method. It may keep its name. Only the public service surface
is being cut.

## 65. Tests

### Schema/client

- defaults and invalid authority combinations;
- strict request canonicalization;
- same-host owner-session verification;
- attached-host identity cannot be supplied or overridden in eval arguments —
  asserted now, and unchanged by RFS-5.1;
- `execute` composition and abort behavior, exercised over a bare call function
  as well as a generated client;
- `timeoutMs` and top-level `reset` keep their current names and meanings;
- the agent tool's formatted result is unchanged for an identical run;
- no direct call to removed methods remains.

### Identity and replay

- `start` with a known `runId` and identical input returns the existing run and
  does not execute twice;
- `start` with a known `runId` and different input fails `run-identity-drift`
  and neither returns the stale run nor overwrites it;
- a caller that never received the `start` response can address, poll, cancel,
  and re-register a receiver using only the `runId` it computed;
- a `runId` colliding across scope keys is rejected;
- a trivially fast run returns `status: "terminal"` with a snapshot from
  `start`, in one round trip.

### Delivery

- terminal push reaches a registered receiver without any poll;
- push failure leaves the run terminal and readable, and the backstop settles
  it;
- a pushed caller never double-settles against its own backstop;
- `events.watch` streams `eval:run-event` records live until unsubscribe;
- a follower past the retention bound receives a gap `diagnostic` with a
  re-read cursor rather than silent truncation;
- dropping a subscription does not affect the run.

### Authority

- adaptive already-granted success;
- adaptive prompt and exact resume;
- adaptive denial;
- strict exact success;
- strict missing-request failure despite a broad user grant;
- pregranted-only failure without queue entry;
- preauthorization binds exact args/prepared state;
- read-only rejects host and direct mutations;
- relationship failure cannot be approved around;
- the ceiling list intersects correctly with zero ceilings present.

### Lifecycle

- accepted run survives caller hibernation;
- ordered run serialization;
- cancellation before start, during await, and during cleanup;
- timeout versus cancellation classification;
- process loss becomes interrupted without replay;
- restart reports exact restored/lost scope keys;
- large console/return/error paging;
- event paging and retention bounds;
- cleanup authority remains valid until terminal cancellation.

### System tests

Update existing eval lifecycle coverage and add:

- `eval-exact-authority`;
- `eval-pregranted-only`;
- `eval-preauthorization`;
- `eval-events`;
- `eval-agent-replay` — kill the vessel between `start` and settle, prove the
  replayed invocation neither duplicates the run nor loses its result.

`eval-attached-development-host` belongs to RFS-5.1, not here.

## 66. Acceptance criteria

RFS-5 is complete when:

- only one server execution lifecycle exists;
- every caller uses `start/get/events/cancel` through the one shared `execute`
  composition; no caller hand-rolls settle ordering;
- run identity is caller-owned and a crashed caller can always address its own
  run;
- the terminal completion push is preserved and is the primary settle path;
  polling is a backstop everywhere it appears;
- live output reaches panels by subscription, not by timer;
- per-run intent can attenuate but never widen semantic authority;
- current notebook durability, recovery, cancellation, and paging behavior is
  preserved;
- the agent tool's schema, description, and observable contract are consistent
  with the shipped lifecycle;
- no relationship or transport fact is accepted from eval input, and no
  speculative attached-host field, state, or term exists in the schema;
- old method names and compatibility readers are absent from source, docs,
  generated catalogs, and tests.

RFS-5.1 is complete when attached child eval uses the same schema and authority
path, populated from verified transport facts, with no schema change relative to
RFS-5.

## 67. Implementation boundary

The clean-cut lifecycle migration is implemented as
`start/get/events/cancel` plus the existing owner controls. `start` requires the
caller-owned `runId`, derives owner/context/channel facts from verified
bindings, preserves the EvalDO's terminal push for agent vessels, and offers a
short terminal fast path. The shared executor composition provides the existing
one-call tool and CLI experience; `get` remains the recovery backstop. Public
`run`, `startRun`, and `getRun` are removed. Internal EvalDO method names remain
implementation details, as allowed by §64.1.

Live output uses the repository's canonical watched-event transport rather than
adding a second streaming shape to `eval.events`. The EvalDO first persists each
bounded event, then publishes it through an authenticated, nonce-bound internal
ingress. That ingress re-derives the exact owner and initiating caller and emits
`eval:run-event` only to their watched transports. `eval.events` remains the
stable cursor catch-up path and inserts an explicit retention-gap diagnostic
when a cursor fell behind. Cancelling a watch owns unsubscription and never
affects the run.

Per-run adaptive/strict, mutable/read-only, prompt/pregranted-only, and typed
preauthorization intent is implemented as a canonical authority ceiling in the
existing dispatcher. The service normalizes and digests the manifest, the
execution-session registry binds it to the exact run, dispatcher preflight owns
prospective invocation preparation, and ordinary acquisition remains the only
approval path. Eval does not maintain a parallel capability or grant engine.

RFS-5.1 is also implemented with RFS-4C: attached-host identity and the route
ceiling come only from verified transport facts, are included in run
provenance, and join the same ceiling intersection. The public eval input shape
did not gain a caller-supplied host, route, owner, channel, or generation field.

# Appendix A. Candidate channel structure model

This appendix exists only for RFS-3 outcome B (§31). It is a starting point for
design after the §30 decisions are recorded. It is not a target, and its
presence here is not evidence that the split is needed.

```ts
interface ChannelStructureRevisionV1 {
  version: 1;
  revisionId: string;
  channelId: string;
  predecessorId: string | null;
  createdAt: number;
  createdBy: Principal;
  reason: "created" | "forked" | "owner-transfer" | "policy-revision" | "owner-recovery";
  owner: Principal;
  contextId: string;
  origin:
    | { kind: "created"; key: string }
    | { kind: "fork"; sourceChannelId: string; sourceRevisionId: string };
  governance: "standard" | "locked";
  admission:
    | { kind: "workspace-members" }
    | { kind: "channel-members" }
    | {
        kind: "exact-principals";
        principals: Principal[];
        codeBindings: Array<{ entity: Principal; code: Principal }>;
      };
  presentationEditors:
    | { kind: "workspace-members" }
    | { kind: "owner" }
    | { kind: "exact-principals"; principals: Principal[] };
}

interface ChannelPresentationRevisionV1 {
  version: 1;
  channelId: string;
  revision: number;
  predecessor: number | null;
  updatedAt: number;
  updatedBy: Principal;
  title?: string;
  titleExplicit?: boolean;
  approvalLevel?: 0 | 1 | 2;
  conversationPolicy?: "open" | "directed" | "moderated";
  agentHopLimit?: number;
  policies: string[];
}
```

Separation rules, if adopted:

- subscribe evaluates the current structure but never writes it;
- presentation updates cannot change admission, owner, origin, context, or
  governance;
- structural changes append a revision with an expected predecessor;
- locked exact-principal admission requires both the live entity binding and
  exact sealed code binding;
- ordinary `channel_members` remains discovery metadata unless the reviewed
  decision explicitly chooses member admission.

Persistence, if adopted. ChannelDO owns:

- `channel_structure_revisions`;
- `channel_presentation_revisions`;
- one current structure pointer;
- one current presentation pointer;
- deletion tombstone;
- existing durable messages, members, presence, and fork journal.

Host-only creation:

```ts
initializeChannel({
  structure: ChannelStructureRevisionV1;
  presentation: Omit<ChannelPresentationRevisionV1, "revision" | "predecessor">;
}): ChannelSnapshot
```

The call is idempotent only for the exact same canonical payload. Drift is an
error.

Presentation mutation:

```ts
updatePresentation({
  expectedRevision: number;
  patch: ChannelPresentationPatch;
}): ChannelPresentationRevisionV1
```

Structure mutation:

```ts
reviseStructure({
  expectedRevisionId: string;
  next: ChannelStructureRevisionInput;
}): ChannelStructureRevisionV1
```

Delete:

```ts
tombstone({
  expectedRevisionId: string;
  reason: string;
}): { deletedAt: number }
```

Reconnect after tombstone returns a stable typed error. It cannot recreate the
channel.

# 67. Work explicitly not to salvage

The following source-branch artifacts should remain historical only.

| Artifact/idea                                          | Reason                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `packages/direct-client` implementation                | Current routed connectivity and negotiated RPC sessions are the canonical transport foundation.             |
| `packages/context-workspace` filesystem synchronizer   | It reconstructs semantic edits from disk scanning and cannot preserve explicit move/copy identity.          |
| GAD repository contract/reducer/store                  | Replaced by the semantic control plane and current VCS protocol.                                            |
| Raw product authority grant/direct-capability catalogs | Replaced by reviewed semantic requests, invocation snapshots, and live acquisition.                         |
| Old `devHost` service and child eval bridge            | RFS-4 uses the current instance supervisor and normal attached typed clients.                               |
| Old terminal-control protocol                          | Current terminal, shell, and CLI transports own this lifecycle.                                             |
| Provider setup gate/components                         | Current model-readiness flow is more complete.                                                              |
| Old exact-content-store wrappers                       | Current CAS/blob/build stores should be audited and extended in place.                                      |
| Three “implemented” branch plans                       | They describe obsolete APIs and may be mined for requirements, but must not be merged as current contracts. |
| Generated ledgers from the branch                      | Current ledgers must be regenerated from current registries after RFS-1.                                    |

# 68. Delivery order and dependencies

```text
RFS-0 stop destroying artifacts   [ships first, independent, small]
  |                                 build storage grows until RFS-2 — §6.1
RFS-1 ledger integrity
  |
  +--> RFS-5 eval lifecycle convergence     (local eval only)
  |
  +--> RFS-3 channel audit
  |       (outcome A closes it; outcome B adds Appendix A work)
  |
  +--> RFS-2 retention architecture + two-collector handshake
          |    restores safe deletion; unblocks disk reclamation
          |
          +--> RFS-4.0 adopt projects/vibestudio        (§34.1)
                  |
                  +--> RFS-4A exact development builds
                          |
                          +--> RFS-4B isolated host + executor
                                  |
                                  +--> RFS-4D current-host client
                                  |
                                  +--> RFS-4E native tool checkpoints
                                  |
                                  +--> [§51 threat model accepted]
                                          |
                                          +--> RFS-4C attached host
                                                  |
                                                  +--> RFS-5.1 attached-host
                                                       eval provenance
```

Sequencing decisions, and why:

- **RFS-0 precedes everything.** It is the only package repairing an active
  data-loss path, and it is small enough to land while RFS-1 is in review. Its
  cost — unbounded build storage — is what makes RFS-2 a scheduling requirement
  rather than a preference.
- **RFS-5 does not wait on RFS-4C.** See §55.1. It ships as a local-eval
  convergence with no attached-host scaffolding; the alternative is a
  delete-in-one-tranche migration whose consumer set grows every week.
- **RFS-4C is gated on a document, not a predecessor package.** The threat model
  can be written in parallel with 4A and 4B.
- **RFS-4D no longer sits behind RFS-4C.** Revision 2 placed the current-host
  Electron client after attached-host routing, but 4D needs only the executor
  and client-launch foundation from 4B: it builds a client, takes an ordinary
  one-time invite, and proves an execution digest. Nothing in it crosses a host
  boundary. Making the lowest-risk launch target wait on the highest-risk
  transport work delayed the most useful deliverable for no dependency.
- **RFS-4E likewise depends on 4B, not on 4C.** Native checkpoints are a VCS
  import path; they never touch a route.
- **RFS-4.0 is called out separately** because §34.1 is a precondition, not an
  implementation detail: without an adopted `projects/vibestudio`, RFS-4A has no
  defined source to build.

Recommended change sets:

1. remove build-artifact deletion and ship the GC diagnostic (RFS-0);
2. ledger truth repair (RFS-1);
3. eval public lifecycle convergence (RFS-5);
4. channel contract audit and ledger correction (RFS-3, outcome A or gate to B);
5. channel implementation, only if the audit confirms missing behavior;
6. execution-retention provider census and report-only collector (RFS-2);
7. two-collector handshake, quarantine, and restored deletion (RFS-2);
8. adopt the Vibestudio monorepo as a semantic project (RFS-4.0);
9. development session, semantic context fork, plus exact build (RFS-4A);
10. reusable instance supervisor plus isolated launch (RFS-4B);
11. current-host client (RFS-4D);
12. native-tool checkpoint flow (RFS-4E);
13. attached host transport and approval route (RFS-4C, post-threat-model);
14. attached-host eval provenance (RFS-5.1).

Each change set must be independently reviewable and delete any superseded form
in the same tranche.

# 69. Verification ladder

For every package:

1. schema and pure-model unit tests;
2. owner/storage/service focused tests;
3. generated contract checks;
4. host and userland type checks;
5. exact system test;
6. category run;
7. smoke run;
8. rerun every prior failure or unexpected tool failure.

For changes under `workspace/`, validate against a fresh bootstrap copy, not a
named instance's preserved semantic state.

For RFS-0 and RFS-2 specifically, add a ninth rung: **cold-cache reconstruction**.
Delete the build cache and the process state, then prove the retained
incarnation still builds and launches. Every other rung can pass while
reconstruction is broken, because every other rung runs against a warm tree.

The final release gate includes:

- no dangling ledger evidence;
- no caller-supplied execution GC roots;
- no unclassified executable owner;
- no collector that sweeps on a partial root set from its counterpart;
- no artifact retained without a reachable source closure, or deleted because
  its source closure was already swept;
- no mixed channel structure/presentation mutation if RFS-3 outcome B is
  implemented;
- no self-development build from shared projection or checkout;
- no development-specific eval transport;
- no old eval execution method;
- no unaccepted threat model on a shipped cross-host route;
- no hidden approval, credential, cleanup, or native process path.

# 70. Branch preservation and retirement

Keep `origin/refactor/runtime-foundations-self-development` until:

- this report is accepted;
- RFS-0 and RFS-1 are implemented;
- branch-only self-development and eval requirements have issue/plan ownership;
- any useful test fixtures have been re-expressed against current schemas.

Afterward, retain the commit hashes in this report and archive or delete the
remote branch. Version control remains the historical implementation record;
the active repository should not carry copied obsolete plans, dormant
compatibility code, or alternate execution paths.
