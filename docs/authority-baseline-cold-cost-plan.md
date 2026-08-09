# Authority Baseline Cold-Cost Plan

Status: implemented · 2026-08-09 · revision 2

## Implementation result

The program is implemented as one change set. In the exact
`worker-create-commit-publish` reproduction, the preparing review became visible in 1ms; the
candidate pass reused 103 attestations, compiled the one new unit, and completed in 3.4s with
489ms of main-thread active time. The system test passed as run
`st_a163385698a34b9b91c254ec7bbe1238`.

Cold analyzer-epoch attestation now runs in the analysis worker and prewarms opportunistically.
An unchanged second ephemeral start, with a different workspace ID, restored both indexes from
the profile-shared exact-identity cache in 1.6s without a compiler pass. Publication remains
fully gated: preparing reviews cannot be approved, failed downstream build or authority checks
fail the same review, and main advances only after the ready review is accepted.

The first worker-affecting push after a cold ephemeral start took 142.7s before any approval
prompt could exist, with 99.8% event-loop utilization, relay disconnects, slow Durable Object
dispatches, and failed alarms throughout. This plan supersedes the model-generated note that
diagnosed it, and incorporates a second review pass (see "Review corrections").

This is **one implementation program, landed together**. The ordering below is a dependency
order, not a staging plan: nothing here is deferred to a later milestone, and W5 — removing
whole-workspace compilation from baseline construction — is in scope as implementation, not as a
design note.

## Measurements (from the trace, not re-run)

| Segment                              | Value                                  |
| ------------------------------------ | -------------------------------------- |
| Baseline index (101 consumers)       | 142,696ms — 0 durable hits, 101 misses |
| Candidate index (after baseline)     | 11,114ms — 101 hits, 2 misses          |
| TypeScript program construction      | 22,518ms                               |
| Per-consumer result composition      | 105,753ms (74% of total)               |
| Synchronous compiler-bridge requests | 103,926                                |
| AST nodes fetched / bytes            | 10.4M / ~553MB                         |

W0 exists to make these reproducible.

## Corrections to the original note

Four of the note's load-bearing claims are wrong, and its proposed redesign is aimed at them.

1. **"Static analysis is provider-coupled" — false at the fact layer.**
   `analyzeWorkspaceServiceCalls` is explicitly provider-independent
   (`src/server/buildV2/userlandAuthorityAnalyzer.ts:278-281`). Facts are cached per consumer
   keyed by `(epoch, unitName, effectiveVersion)` plus compiler-dependency content hashes
   (`authorityAnalysisCache.ts:269-276`). Provider binding happens later, in
   `authorityDependencyIndexFromFacts` (`authorityDependencyIndex.ts:93-117`) and
   `authorityFold.ts:355-407`. Adding `workers/task-board-store` did not invalidate 101
   consumers' analysis. The note's step 2 is already implemented.

2. **"The publication gate does a workspace-wide sweep" — false.**
   Selection is already a bounded reverse closure plus `authorityConsumersForProviderChanges`
   over `consumersByProviderUnit` / `consumersByQuery` (`src/server/buildV2/index.ts:1990-2081`),
   commented "never an unrelated whole-workspace sweep." The note's step 5 already exists as
   `consumersByQuery`.

3. **The 101-consumer cost is index _construction_, not index _use_.**
   `AuthorityDependencyIndex` is a whole-workspace object: `consumersByQuery` must cover every
   unit to be sound as a selection input, so constructing it needs facts for all 101 units. This
   is the coupling the note missed, and the only place its protocol idea has real leverage (W5).

4. **"Validation precedes approval publication" — correct, but an ordering choice**, not a
   consequence of the analysis cost. `stageAuthorityIndex` runs inside the build gate
   (`src/server/index.ts:2925`), before the approval record exists.

The note's most important correct claim: **runtime enforcement is the security boundary.**
`workers.resolveService()` selects an exact `workspace-service:<name>` capability checked against
the caller's sealed manifest and grants; direct RPC enforces the provider's receiver policy. The
publication analysis is a _review_ mechanism — it exists so the user can see what they are
approving. That licenses making it faster and better-ordered. It does not license making it
weaker or optional; a review the user cannot see is the failure mode we are fixing.

## Review corrections (revision 2)

A second review pass corrected revision 1. Verified against source:

- **The 256-entry LRU is a non-issue. Withdrawn.** `MAX_FACTS` trims only the workspace-local
  cache file. Every committed fact is _also_ written content-addressed to the shared fact
  directory with a base-identity candidate pointer (`authorityAnalysisCache.ts:534-548`), and
  that shared store has **no pruning path anywhere in the tree**. `fact()` and `factForConsumer()`
  both fall back to it (`:386-401`, `:422-443`). Raising `MAX_FACTS` would achieve nothing.

- **There _is_ a durable completeness marker, and revision 1 was wrong to say a cold process must
  always rebuild.** A complete index is persisted and restored after validating its exact
  identity and every constituent fact (`authorityAnalysisCache.ts:445-500`). Restore is
  hash-checking, not compilation — far cheaper than the 11s candidate-index figure.

- **But the reviewer over-generalized:** the index is persisted **only to the workspace-local
  file** (`this.filePath`, keyed `sha256({workspaceId})`, trimmed to `MAX_INDEXES = 8`). Unlike
  facts, it is _never_ written to the shared directory. So "an unchanged second start should
  restore the complete index" holds only when `workspaceId` is stable across starts. The incident
  was a cold **ephemeral** start. Whether ephemeral workspaces get a stable `workspaceId`
  (`buildV2/index.ts:517`) is now a W0 discriminator — and if they do not, the asymmetry between
  shared facts and workspace-local indexes is itself a defect, fixed in W4.

- **W0 cannot derive miss reasons from `decodeFactEntry`. Accepted.** `factForConsumer` hashes
  `{epoch, unitName, effectiveVersion}` into the candidate path (`:307-311`, `:422`), so a
  changed epoch or EV is indistinguishable from "no candidate file" — `decodeFactEntry` never
  runs. W0 needs a deliberate diagnostic index, not a threaded return value.

- **W3 must not assume state-hash supersession. Accepted.** `semanticPublishCall` holds the
  workspace-wide protected-main lease across the entire push
  (`src/server/vcsHost/workspaceVcs.ts:575-616`); the lease is a serialized tail queue, so no
  second publication can move main while the first is analyzing or awaiting approval. Two
  refinements the reviewer missed: `semanticPublishCall` already accepts an `AbortSignal`
  (`workspaceVcs.ts:580`), so caller cancellation has an existing channel; and baseline analysis
  of the _published_ state runs outside that lease (prewarm, plus `authorityIndexAt` at
  `buildV2/index.ts:2016-2021`), so shared-flight cancellation remains a real design problem even
  though publication supersession does not.

- **W1 must not eagerly hash every external file. Accepted.** Revision 1 said "compute the
  group's external-file dependency descriptors once", which read literally means hashing every
  external file in the program — potentially _more_ work than today, since the current code
  hashes only per-consumer reachable files plus ambients.

- **W5 sequencing accepted; its rationale rejected.** The claim that W5's design "could expose
  assumptions that change W1 or W2's desired interfaces" is weak: W1 is an internal refactor of
  composition, W2 is a serialization boundary, and W5 keeps the per-unit compiler check that both
  operate on. W5 moves early because it is the structural fix and this program lands as a whole —
  not because it constrains W1/W2.

## Verified diagnosis

### A. Composition is O(consumers × program files) across a synchronous remote-AST bridge

`createAuthorityCompilerSnapshot` loops over consumers
(`authorityCompilerSnapshot.ts:442-460`) and per consumer calls
`compilerDependencies(groupSourceFiles, ...)` (`:192-238`), which iterates _every_ source file in
the group's program. Per-file descriptors are memoized in `dependencyCache`, but the loop still
evaluates `path.resolve(sourceFile.fileName)` and the `reachable`/`isWithin` filters for every
file on every consumer pass — and each of those property reads is a synchronous round trip to the
TypeScript bridge. 101 consumers × the group's file set plausibly generates the 103,926 requests,
10.4M node fetches, and 553MB. This is 74% of the total and a plain algorithmic defect.

### B. The pass runs on the server event loop

The bridge is synchronous, so the pass holds the main thread — the 99.8% ELU, relay disconnects,
slow DO dispatches, and failed alarms. The app was not "showing a long validation", it was
unresponsive. Commit `81d31d934` removed startup prewarming for exactly this reason (23.8s
startup stall) and states the constraint: "Do not launch that CPU-bound pass until it can be
moved off the server thread." Disabling prewarm moved the stall to the first protected push.
**A 3–4× faster pass still stalls the main thread for ~40s.** W2 is not optional.

### C. Zero durable cache hits, cause unknown

Revision 1 listed five causes; two are withdrawn above. What survives, all cheap to distinguish:

- **First-ever run** — the shared fact store may simply have been empty. Then there is no cache
  bug, and W4 is about prewarm and index sharing only.
- **Epoch invalidation** — `authorityEpoch` is `{analyzerVersion, rpcSchemaVersion}`
  (`authorityDependencyIndex.ts:5-8`). Any edit to the analyzer or the RPC schemas invalidates
  every stored fact for every workspace at once, with no partial invalidation. During active
  development on this subsystem that is a near-permanent cold cache.
- **Unknown-EV state scoping** — `buildV2/index.ts:606-607` gives units with no effective version
  the identity `unknown:${stateHash}`, permanently unhittable on any later state.
- **Host-path dependency hashes** — compiler dependencies are absolute paths outside `sourceRoot`
  (node_modules, external manifests). Any install or app upgrade invalidates broadly, and
  legitimately.
- **Ephemeral `workspaceId`** — if it varies per start, the persisted index is unreachable by
  construction (see review corrections).

## The program

### W0 — Make the cost attributable

Build a deliberate diagnostic capability; do not try to infer reasons from existing return
values. `factForConsumer`'s candidate path is a hash of the base identity, so epoch and EV
mismatches are invisible before `decodeFactEntry` runs.

Add a bounded, deletable **diagnostic index** in the shared store, keyed by `unitName`, recording
the most recent stored identities (epoch, effective version, fact key) per unit. It is derived
data with no authority role: corrupt or absent, it costs only diagnostic fidelity, never
correctness. Every baseline construction then classifies each consumer as exactly one of:

- `no-candidate-ever-stored`
- `candidate-for-other-epoch`
- `candidate-for-other-effective-version`
- `candidate-pointer-corrupt-or-missing`
- `fact-corrupt`
- `compiler-dependency-changed` (with the first differing path)
- `hit-local` / `hit-shared`

Also emit: the count of `unknown`-EV units, whether the persisted index was found and if not why,
the `workspaceId` and whether it is stable across starts, and the existing timing breakdown.

Exit: one command reproduces the incident (cold ephemeral start, then add a worker) and prints
the miss-reason histogram. W4's cache work is designed from that histogram, not from guesses.

### W1 — Fix the O(C × F) composition without adding eager work

Behavior-preserving shape, per the review correction:

1. Read each `sourceFile.fileName` exactly **once** per group, building a local
   `absolutePath → {sourceFile, isExternal, isAmbient}` classification. No remote property access
   after this point.
2. Compute each consumer's reachable path set over the in-memory import graphs, touching only
   local path strings.
3. Lazily compute each external descriptor (content hash + nearest package manifest hash) **once
   across the union of all consumer closures**, memoized as today. Files no consumer reaches are
   never read or hashed.
4. Assemble per-consumer dependency lists from those cached descriptors.

Preserve exactly the current semantics that `ambientExternalFiles` are added to every consumer's
reachable set (`authorityCompilerSnapshot.ts:449`) — that makes the sets less consumer-specific
than they appear. Do not "improve" it here.

Exit: `dependenciesByConsumer` digest-identical to the current implementation on both a fixture
workspace **and** the incident-sized workspace; `compositionMs` and `native.requestCount` each
down by an order of magnitude. Target: baseline ≤ 45s before W5, and the composition segment no
longer dominant.

### W2 — Move the compiler pass off the server thread

Move the whole CPU- and IO-bound authority pass to a worker thread. The boundary is clean:
inputs are a materialized `sourceRoot`, a unit list, and `nodeModulesPaths`; outputs are plain
data (facts, dependency descriptors, timings).

**Move durable cache validation too, not just the compiler.** Restoring a cached baseline is not
free main-thread work: `AuthorityAnalysisCache` reads and hashes synchronously throughout —
`load()` (`:351-352`), `fact()` (`:389-391`), `factForConsumer()` (`:425-436`), and
`AuthorityCacheValidation.hash()` (`:192`, a `readFileSync` + SHA-256 per dependency path). Across
101 consumers and their dependency closures that is substantial blocking IO and hashing. If only
`createAuthorityCompilerSnapshot` moves, **W4's exit criterion is not delivered** — the warm
restore path still stalls the server. Cache decode and dependency validation move into the worker
with the compiler.

**One coordination domain, not two.** `AuthorityIndexManager.indexAt` already owns single-flight
and result caching. Do not duplicate it in the worker. The split is:

- **Main process** — exact-state orchestration, waiter ownership, shared-flight reference
  counting, candidate staging, and the published/pending/analyzed pointers.
- **Analysis worker** — a queue of compiler and cache executions, plus cancellation of an
  execution when the main process reports that its last waiter left.

**Do not assume `TypeCheckService` reuse follows from a long-lived worker.** The current function
constructs and disposes one service per compiler group
(`authorityCompilerSnapshot.ts:389-397`, `:468`). A long-lived worker makes retention _possible_,
but program construction (22.5s) is only repaid by an explicit retention design with exact
invalidation on source, tsconfig, and `nodeModulesPaths` changes. Treat that as its own piece of
work inside W2 with its own correctness argument — not as a free consequence of worker lifetime.

Exit: with a cold baseline **and** a warm cache restore in flight, main-thread ELU stays within
normal-operation bounds, DO dispatch latency and alarm delivery are unaffected, and the relay
does not disconnect. This is the gate that makes W4's prewarm safe.

### W3 — A typed publication-review lifecycle

Invert the ordering at `src/server/index.ts:2925`: the push creates its review record
immediately, and the authority result streams into it.

Model it as an explicit lifecycle, per the review correction — **not** as state-hash
supersession, which the protected-main lease already precludes:

```
preparing ──▶ ready ──▶ accepted | denied
     └──────▶ failed | cancelled
```

The existing approval queue assumes every pending entry is immediately resolvable and has no
update API. This workstream must specify and implement:

- How a `preparing` entry becomes `ready` **atomically**, so no observer sees a half-populated
  record.
- How resolution (accept/deny) is **rejected** while `preparing` — the gate keeps full strength;
  an unanalyzed record is not approvable.
- How diagnostics update the same record in place, so per-consumer blocking reasons surface on
  the thing the user is looking at rather than as a generic gate failure.
- How caller cancellation propagates to the analysis worker. `semanticPublishCall` already
  carries an `AbortSignal` (`workspaceVcs.ts:580`) — thread it through rather than inventing a
  channel.
- How cancellation interacts with a baseline flight **shared** between prewarm and multiple
  waiters. A shared flight must not be cancelled by one waiter withdrawing; only the last
  interested waiter leaving may abandon it. This is the one genuine supersession-like problem,
  and it lives outside the protected-main lease.

Constraints: **no clocks.** State advances on the analysis completing, failing, or being
cancelled — no TTL, no timeout-driven bypass, no "assume clean after N seconds". Consistent with
the standing position that agentic state resolves on lifecycle events.

Exit — **two metrics, both required.** A `preparing` review is visible and cancellable but
explicitly not approvable, so a single "time to approval surface" number would let W3 pass while
analysis still takes minutes:

- **Time to visible `preparing` review** — within normal push latency from a cold start.
- **Time to `ready` (approvable) review** — the analysis cost the rest of the program is
  driving down; reported separately and never conflated with the first.

### W4 — Restore prewarm and close the standing cache defects

Requires W2. Re-enable `prewarmAuthorityIndex()` after the ready record is published, alongside
`prewarmWorkspaceBuilds()`, reverting the relevant half of `81d31d934`. Then, driven by W0:

- **Share the persisted index the way facts are shared.** The current asymmetry — facts
  content-addressed in a global store, indexes confined to a workspace-local file — is why a cold
  ephemeral start cannot restore a complete baseline even when every constituent fact is present.
  Persist the index content-addressed by its identity (`stateHash`, epoch, environment digest,
  graph digest), which is already exactly what `indexKey` hashes.
- **Fix `unknown:${stateHash}` identity scoping.** Either give those units a real effective
  version or exclude them from fact caching with an explicit logged reason. Silently
  state-scoping a cache key is wrong either way.
- **Narrow the epoch where it is sound.** `analyzerVersion` invalidating all facts globally is
  defensible. `rpcSchemaVersion` may be narrowable to the units whose schemas actually changed —
  evaluate against the fold's actual schema dependencies; do not assume.
- **Leave `MAX_FACTS` alone** (see review corrections), but add a pruning path to the shared
  store, which currently grows without bound.

Exit: a second cold start on an unchanged workspace restores a complete baseline from the durable
index by hash validation alone, off-thread, with no user-visible stall — regardless of whether
`workspaceId` is stable.

### W5 — Manifest-declared protocol requests

In scope as implementation. This is the structural fix: it removes whole-workspace compilation
from baseline construction entirely.

Today "which services does this unit query" is derived from TypeScript, which is why
`consumersByQuery` requires compiling every unit. Consumers instead declare their service
requirements by stable protocol in the manifest, so `consumersByQuery` is built by reading
manifests. The static check becomes strictly local and per-unit — _the calls this unit makes are
covered by this unit's own declaration_.

The vocabulary partly exists: service bindings already carry `protocols`
(`userlandAuthority.ts:24`), aliased into `providersByQuery`
(`authorityDependencyIndex.ts:93-108`). The consumer-side request is what is missing.

#### W5a — How protocol declaration maps to runtime authority

This must be settled before any code lands. Runtime resolution today selects the **concrete**
capability `workspace-service:${service.name}` and checks _that_ against the caller's sealed
manifest and grants (`src/server/services/workerService.ts:349`, prefix at `:163`, `:399-402`).
A protocol declaration must not quietly become a second, looser grant axis.

Three candidate contracts, and the choice:

1. _Dependency-only_ — the protocol declaration is index and review vocabulary; the concrete
   `workspace-service:<name>` capability is still separately requested and granted.
2. _Protocol-authorizing_ — a protocol grant authorizes any provider implementing it.
3. _Bound at admission_ — the reviewed protocol request is bound to an exact provider identity
   and catalog digest when the binding is admitted.

**Reject (2).** It lets a replacement provider inherit a grant the user gave to a different
implementation — the provider becomes substitutable _after_ review, which is precisely the
substitution the review exists to prevent.

**Adopt (1) composed with (3).** The protocol is the _static_ vocabulary: it is what the manifest
declares, what `consumersByQuery` is built from, and what makes the per-unit check local. Grant
identity stays **concrete** — the enforced capability remains `workspace-service:${service.name}`
at `workerService.ts:349`, unchanged. Admission binds the reviewed protocol request to an exact
provider identity and catalog digest, and receiver-policy enforcement is untouched. A provider
swap therefore produces a new binding that needs its own review, not an inherited grant.

Consequence to state plainly: W5 does **not** loosen runtime enforcement at all. It changes only
where the _index_ gets its consumer→query edges from.

#### W5b — Durable per-unit proof model

Revision 2 said the per-unit proof is "cacheable by effective version and invalidated only by the
unit's own change." That is wrong, and the error matters. An analyzer or compiler-semantics change
can discover effects an earlier analyzer missed — which is exactly why `authorityEpoch` currently
invalidates every stored proof. Without an explicit rule, a cold process cannot soundly assume
every existing manifest still covers its code.

Three possible rules:

1. Published units carry a **durable attestation** recording the analyzer epoch under which
   `actual ⊆ declared` was proved; an epoch change triggers revalidation of the affected units.
2. Published proofs are grandfathered until the unit changes.
3. Manifest declarations become the authoritative review contract and static source checking
   becomes advisory for already-published units.

**Adopt (1).** Options 2 and 3 both break the stated invariant that static analysis is never
optional — under either, an analyzer improvement that discovers a real effect in published code
would never be applied to it. Attestation keeps the invariant intact while making the common case
free: proofs are keyed by `(epoch, unitName, effectiveVersion)` as today, an unchanged epoch
compiles nothing, and an epoch bump schedules revalidation of published units through the W2
worker and W4 prewarm — off-thread, before any push needs it.

This corrects the exit criterion below: zero compilation on a cold baseline holds **at unchanged
epoch**. An epoch bump is a bounded, prewarmed revalidation of published units, not a surprise
cost on the next protected push.

Remaining scope:

- Add a consumer-side protocol request to the manifest schema and the authority request
  vocabulary.
- Build `consumersByQuery` from manifests; keep the per-unit compiler check as the proof that
  declared ⊇ actual, recorded as a W5b attestation.
- **Migrate every existing consumer that calls `resolveService`.** During the transition an
  absent declaration must fail loudly and block, never silently degrade the review. There is no
  permissive mode.
- **Treat missing providers as availability, not authority** — a declared optional service with
  no provider is unavailable; a required one produces an activation/readiness error. First verify
  whether the runtime already behaves this way before treating it as new work.
- Write the contract change up against `docs/capability-model-redesign.md` and
  `docs/explicit-capability-manifest-plan.md`. This changes what the user is approving — from
  "these calls, resolved against the real world" to "these calls ⊆ this reviewed manifest" — and
  that must be a deliberate, documented decision, landed with the code rather than after it.

Exit: at unchanged analyzer epoch, baseline index construction performs **no** TypeScript
compilation — `consumersByQuery` comes from manifests and every per-unit proof is a valid W5b
attestation. Per-unit checks compile only changed units; the incident scenario — adding one
worker — compiles two units. On an epoch bump, published units are revalidated off-thread via W4
prewarm, and that revalidation must complete without a user-visible stall.

## Dependency order

```
W0 ──▶ W1 ──▶ W2 ──▶ W4
  │      │       └──▶ W3
  └──────┴──▶ W5
```

W2 must precede W4: re-enabling prewarm on the main thread reproduces the exact stall
`81d31d934` removed. Everything else is parallelizable and lands together.

## Non-goals

- Weakening, sampling, or making optional the publication-time analysis. Runtime enforcement
  being authoritative makes the static pass a review artifact; a skipped review artifact is worse
  than a slow one.
- Any clock-based mechanism: no analysis TTL, no "stale baseline is good enough", no
  timeout-driven gate bypass.
- Reworking affected-unit selection — already narrow and correct (correction 2).
- Redesigning the protected-main lease. W3 works within it.
- Making `AuthorityIndexManager` durable in-memory-to-disk. The durable marker is the persisted
  index (`authorityAnalysisCache.ts:445`); W4 fixes its reachability, not the manager.

## Verification

Scenario: cold ephemeral start, then push a workspace change adding a worker unit.

- Time to a visible `preparing` review, **and** separately time to a `ready`/approvable review.
  Never report these as one number (W3).
- Baseline index time with segment breakdown; candidate index time; second-cold-start restore
  time.
- Main-thread ELU during a _warm cache restore_, not only during a cold compile (W2).
- Units compiled on an analyzer-epoch bump, and whether that revalidation is user-visible (W5b).
- Fact-cache hit/miss counts with W0 miss reasons; persisted-index found/not-found with reason.
- Peak and mean main-thread ELU during the pass; DO dispatch latency; alarm delivery; relay
  continuity (W2).
- `native.requestCount`, `nodesFetched`, `bytesReceived` (W1).
- Digest equality of `dependenciesByConsumer` and of the resulting `AuthorityDependencyIndex`
  against the pre-refactor implementation, on a fixture workspace **and** the incident-sized
  workspace (W1 correctness).
- Count of units compiled during baseline construction: 101 before, 0 after W5.
