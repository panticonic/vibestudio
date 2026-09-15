# Userland capabilities and the host/userland hard cut: template-split prerequisite

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Receiver requirements remain subordinate detail; confinement and enforcement acceptance are consolidated into U3/U4.

Status: implementation complete as of 2026-07-30. The full conventional suite,
authority ledgers and ratchets, zero-exemption host/workspace boundary, and a
production host build and focused bootstrap tests with `workspace/` absent all
pass. The deterministic live and agentic acceptance scenarios below remain the
pre-extraction gate; their unchecked criteria are intentionally not presented
as completed before that evidence exists.

Status: implementation complete as of 2026-07-30; conventional validation is
in progress. Live full-stack validation and the subsequent physical repository
split remain gated by `docs/official-template-repositories-plan.md`. This
document supersedes its previous draft in full.

## The decisive test

A production host build succeeds with no `workspace/` directory present, and
that host then creates and runs a complete workspace from one exact external
root pin through the public CLI — including building and activating the
workspace's own semantic control plane from the cloned source.

Everything in this plan serves that test. Anything that does not is out of
scope here.

## What this plan is correcting

The intended boundary was always: the host is a generic kernel (identity,
transport, storage, build, isolation, credentials, native effects, and the
trusted approval surface); everything with product meaning is workspace code.
GAD began that way — manifest-discovered, built from workspace source.

Two slides broke it:

1. **Sealed GAD.** Commit `f6ae3ea33` re-exported `GadWorkspaceDO` from the
   host's internal-DO entry, gave it the fixed identity
   `vibestudio/internal`, and made semantic state a precondition of workspace
   startup. This solved a lifecycle-ordering problem by changing residency.
   The ordering problem is real (you need source to build GAD, and today you
   need GAD to serve source); the residency change was not the required fix.
2. **The package moves.** When the template work removed checked-in workspace
   source from the host build's reach, the host stopped compiling. Commit
   `4f398e063` "fixed" this by renaming five workspace packages
   (`workspace-source`, `runtime`, `agentic-protocol`, `vcs-engine`,
   `cdp-client`) into root `packages/` — and
   `tests/host-boundary-checker.test.ts` now contains a test asserting the
   GAD import "needs no exception for product-sealed root packages." The
   boundary violation was not exempted; it was legalized by renaming.
   Package-scope names (`@vibestudio/*`) are now being treated as residency
   evidence, which is exactly backwards.

Splitting repositories on top of this would freeze the wrong boundary into
published contracts. Hence the hard order: fix the boundary, then split.

The second precondition is authority. Sealed GAD enjoys host-owned identity
and reviewed direct-method capability mappings. Moving it to userland without
a replacement yields either broadly callable semantic methods or the current
advisory model — `userlandApproval.request()`, where provider code asks a
question and is _trusted_ to honor the answer. Both are unacceptable. The
replacement is **receiver-enforced userland capabilities**: workspace code
declares capabilities over resources it owns; the host seals the declarations
into the exact build and enforces them before provider code runs.

## Pre-implementation baseline (verified 2026-07-29)

This section records the state the implementation replaced; it is not a
description of the current tree.

Already landed:

- Template composition is fully userland: `workspace/packages/template-composer`
  (resolver + operations), `workspace/extensions/template-composer` (runtime
  service), `workspace/skills/templates`. There is no host `templates` service;
  CLI reaches the composer through the generic extension broker
  (`src/cli/templateComposerClient.ts`). No host template lifecycle, journal,
  or catalog exists to delete.
- A substantial authority substrate exists: `CapabilityGrantStore` (SQLite,
  scoped grants, once-consumption CAS, preauth envelopes),
  `AcquisitionCoordinator`, `EACQUIRE` end to end, invocation snapshots and
  digests, direct-RPC attestations, tier tables, context-integrity primitives.
  `docs/authority-acquisition-spec.md` and
  `docs/authority-p1-enforcement-spec.md` govern this work; this plan does not
  re-specify it.
- Exact-root bootstrap exists in skeletal form: `initWorkspace` accepts a
  `rootTemplate` pin source (alongside `templateDir` and `forkFrom`),
  `workspaceRootTemplateBootstrap.ts` and `acquireRootTemplateSnapshot.ts`
  exist, and creation writes a journaled descriptor.

Still wrong:

- `src/server/internalDOs/index.ts` exports `GadWorkspaceDO`;
  `controlPlane.ts` carries the fixed `SEMANTIC_CONTROL_PLANE` identity; the
  five packages sit in root `packages/`; the boundary test blesses it.
- `userlandApprovalService` (752 lines: `request`, `requestAs`,
  `requestExternal`, `settleExternal`, `requestSecretInput*`, `revoke`,
  `list`) is live, advisory, and carries a wall-clock
  `EXTERNAL_APPROVAL_TIMEOUT_MS`.
- Workspace startup still requires sealed GAD before the build system;
  creation from a root pin still attaches the internal control plane rather
  than building the root's declared one.
- GAD's 72-method surface is largely attested `open`, including `rawSql` and
  its alias `query`.

## Normative sources

This plan-set has suffered from every document re-specifying every subsystem.
The rule from here on: **one contract, one owner.**

| Contract                                                           | Owning document                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Trust model, tiers, subject algebra, lineage classes               | `docs/capability-model-redesign.md`                                     |
| Invocation snapshot, grant store, acquisition loop, preflight      | `docs/authority-acquisition-spec.md`                                    |
| DO ingress enforcement, attestation, nonce replay protection       | `docs/authority-p1-enforcement-spec.md`                                 |
| Approval prompt inventory and copy                                 | `docs/approval-prompt-ux-spec.md`                                       |
| Delegated approvals (severity gate)                                | `docs/system-agent-design.md`                                           |
| DO schema migration mechanics                                      | `docs/durable-object-schema-migrations.md`                              |
| Userland capability declarations, resource derivation, handles     | **this document**                                                       |
| GAD residency, clone-first bootstrap, package residency, deletions | **this document**                                                       |
| Template repository architecture                                   | `docs/official-template-repositories-plan.md` (resumes after this plan) |

Where this document previously duplicated the acquisition spec's structures
(snapshot v2, grant rows, acquisition states, preflight results), those
duplications are deleted, not reconciled. The additions this plan makes to the
snapshot and grant vocabulary are listed in D4; they are deltas against the
owning specs, applied there.

This plan supersedes `docs/host-residency-redesign.md` on two points: H10's
builtin `templates` service (templates are userland; the code already agrees)
and the product-sealed classification of the semantic control plane (D2
below). Its residency vocabulary, kernel decisions, and the principle that
**security friction is bounded by the dangerous surface** all stand and are
load-bearing here.

## Trust model, in one paragraph

Per the capability redesign: this is a mutually trusting family/team
environment. Users are not threats to each other; the untrusted party is
**content** — web pages, API responses, cloned repositories, and the code
agents write under their influence. The capability system exists for three
jobs: controllability of code, gating the genuinely dangerous surface, and
giving agents a recoverable approval path instead of a dead end. Every
mechanism in this plan must justify itself against those three jobs. Ceremony
that defends against a compromised host, or against users attacking users,
defends against nothing in this threat model and is deleted weight.

## Decisions

### D1. The host is a generic kernel; product semantics are workspace code

The host owns: identity (user, device, session, code-build, runtime
incarnation), authenticated dispatch and unforgeable caller propagation, exact
build resolution, grant evaluation and the trusted approval surface,
credential custody, native effects (process, filesystem, Git transport,
browser, device), isolation and supervision, and bounded audit.

Workspace code owns: semantic commits, contexts, refs, projections;
trajectories, channels, memory, collaboration; template DAGs, locks,
composition, and publication policy; domain resources and the capability
declarations protecting them; skills, panels, and repair behavior.

None of the host mechanisms may contain knowledge of GAD, template
composition, channels, or a protected-`main` policy. The residency razor from
the host-residency redesign applies: if an unrelated third-party product could
not use the mechanism unchanged, it does not belong in the host.

### D2. GAD is an ordinary manifest-declared singleton workspace service

The flattened runtime manifest (`meta/vibestudio.yml`) declares the logical
service `gad.workspace`: its source unit, protocol list (including
`vibestudio.workspace-source.v1`), Durable Object class, and stable singleton
key. The generic workspace-service resolver resolves it like any other
service. There is no `SEMANTIC_CONTROL_PLANE` constant, no product catalog
entry, no fixed `vibestudio/internal` identity.

The host requires the **protocol** `vibestudio.workspace-source.v1` as part of
the host/workspace ABI. It must not require that a class named
`GadWorkspaceDO`, a service named `gad.workspace`, or any particular source
path implements it.

The logical service binding `(workspace, service name, singleton key)` is
stable across builds, so DO storage survives ordinary code updates. For the
first supported version those coordinates freeze when the workspace reaches
ready; rebinding them is a separate state-transfer design, deliberately out of
scope.

On the fixed-point argument that justified sealing: "the authority that
interprets semantic history cannot itself be a workspace edit" proves less
than it claims. What must be workspace-immutable is the _gate_ on changing
GAD — build, activation review, protected publication — and those are host
mechanisms already. The bytes of GAD may change through that gate like any
other unit. Pinned userland with a gated self-update path (D11 upgrade
protocol) provides the fixed-point property without host residency; the system
agent already runs this way.

There is no storage migration from the sealed identity. Vibestudio is
pre-release; development workspaces are recreated at the cut.

### D3. Bootstrap is clone-first, then ordinary workspace activation

Workspace creation accepts one exact root pin:

```ts
interface ExactRootWorkspacePin {
  url: string;
  ref: string; // assertion only — never identity
  commit: string; // full oid
  snapshot: `v1-sha256:${string}`;
  credential?: string; // logical binding, never secret bytes
}
```

Bootstrap performs, mechanically and in order: normalize URL → acquire
credential use through the generic flow when challenged (no credential is a
valid anonymous result) → fetch and require `ref` to advertise `commit` → read
the exact tree, verify `snapshot` → materialize atomically (stage, validate,
rename) → validate the root's ready `meta/vibestudio.yml` and `systemEpoch` →
build and activate the declared workspace-source provider → hand it the exact
snapshot → receive an idempotent receipt → switch to the semantic source
provider and reconcile the rest of the workspace.

The host never reads `meta/template.yml`, resolves template parents, consults
a registry, composes fragments, or manufactures semantic commits. The root
must be independently bootable with its flattened manifest already present.

**One build pipeline.** The boot cycle (need source to build GAD, need GAD to
serve source) is broken by exactly one mechanism: the build system accepts an
immutable **bootstrap-snapshot source reference** alongside its semantic refs.
Same graph, compiler, authority extraction, artifact store; only the byte
source differs. The bootstrap variant is host-constructed only, read-only,
valid only for its creation operation, resolves packages only from the exact
snapshot plus declared immutable external artifacts, and is retired after
handoff. There is no precompiled GAD, no internal image, no fallback.

Creation is journaled as a small mechanical record: exact requested pin,
verified digests, a phase enum advanced by compare-and-swap, an optional
failure with a `retryable` flag, and the semantic receipt. It must not contain
template state, composition locks, approval answers, or credentials. A
workspace is not visible as active until ready; cancellation removes
provisional state; retry reuses the same operation identity and pin. Crash
recovery resumes from the recorded phase and never imports a second copy of a
snapshot GAD has already receipted.

The semantic handoff ABI is the finite `WorkspaceSourceProviderV1`:
`initializeExactSnapshot` (idempotent by command id, receipt-bearing),
`resolveSource`, `currentSource`, `inspectInitialization`, `health`. Semantic
edit, compare, integrate, channel, and template operations are product APIs
above this and never enter the bootstrap ABI. The reverse interface is equally
finite: typed content-tree and native-effect services with their own
capabilities. There is no generic `call(method, input)` control-plane adapter
in either direction.

### D3a. Cloning source does not authorize executing it

Exact Git verification proves which bytes arrived, not that they may run.
Before the first cloned unit activates, the host presents a
workspace-code activation review derived from sealed build metadata: exact
pin, unit closure, requested host capabilities, provided userland
capabilities, runtime kind and native-effect reachability, execution digest.
Trusted chrome renders it before cloned code runs.

A reviewed official root may carry an exact preauthorization for its immutable
pin — but "official", a repository name, a branch, or a signing account is
never a floating grant. Builds must not execute package lifecycle scripts to
produce reviewable metadata; if they would need to, the build model is wrong.
Headless tests settle this same review through an exact approval policy, not a
skip flag.

### D4. Userland capabilities are sealed receiver declarations

A workspace unit declares, in its package manifest under
`vibestudio.authority.provides`, the capabilities protecting resources it
owns:

```ts
interface UserlandCapabilityDefinition {
  name: string; // unit-local, canonical syntax
  title: string;
  action: string; // bounded plain text
  description?: string;
  tier: "gated" | "critical"; // open methods need no definition
  sensitivity: "read" | "write" | "admin" | "destructive";
  resourceType: string; // provider vocabulary, not a host capability
  presentation: {
    domain: AuthorityDomainId; // reviewed shared vocabulary; never Safety controls
    verb: AuthorityVerb;
  };
  grantScopes: readonly GrantScope[]; // subset of the canonical store vocabulary
}
```

`provides` is the mirror of the existing `requests`: a request bounds what a
unit may attempt downstream; a provided capability describes what is required
to enter it. Neither is a grant.

Receiver methods bind to a local capability in their reviewed `@rpc` metadata
via an exact effect union — `{ kind: "open" }`,
`{ kind: "userland-capability", capability, resource }`, or
`{ kind: "host-capability", ... }` (which workspace code can reference only by
calling the host receiver that owns it, never declare for itself). The builder
validates that every reference resolves exactly once, tiers agree, every
argument path exists in the validated input schema, and test-only methods do
not enter production metadata. Metadata extraction never executes provider
code. A live method with no sealed declaration fails closed at ingress.

The sealed build metadata (requests, provided definitions with digests,
per-method bindings with schema digests) rides in the ordinary build report;
activation refuses artifacts whose embedded metadata differs from the build
store's. Enforcement itself is the P1/acquisition machinery, unchanged: same
snapshot, same evaluator, same store, same approval queue, same attestations.
The deltas this plan contributes to those specs are exactly three snapshot/
grant fields — capability definition digest, derived resource
(type and canonical key), and provider identity — one snapshot schema bump.

`grantScopes` draws from the canonical grant-store vocabulary
(`once | task | agent | mission | version | session`); it is a subset filter
on what the approval card may offer, not a parallel enum. Critical/destructive
definitions cannot offer broad standing scopes. The scope-vocabulary drift
between the earlier drafts of this document, the dynamic-vessels doc, and the
capability redesign is resolved by construction: there is exactly one
vocabulary and it lives in the acquisition spec.

### D4a. Grant identity binds to the definition, not the build

This reverses the previous draft, which folded the provider's execution
digest into capability identity so that **any rebuild of the provider
invalidated every grant anyone held against it.**

Canonical capability identity is:

```text
userland:<provider-repo-path>/<local-name>#<definition-digest>
```

The definition digest covers everything the approval presented and everything
enforcement derives from: title, action, tier, sensitivity, resource type,
resource derivation, grant scopes, and the bound method's input schema digest.
Change any of those and existing grants lapse — correct, because the meaning
of the approval changed.

A caller manifest names that relationship as the bounded definition family
`userland:<provider-repo-path>/<local-name>#*` with
`evidence: "bounded-dynamic"` and an independently bounded resource scope.
This is the only installed-code wildcard form: it follows reviewed revisions
of one capability from one exact provider path while the runtime requirement
and grants still use the full definition digest. Ordinary host and workspace
capability wildcards remain invalid.

The provider's execution digest is recorded in every invocation snapshot and
audit row, and the `version` grant scope ("trust this version") pins it
explicitly. It does not otherwise participate in grant matching, because:

- Which bytes implement a receiver is governed by the code-activation gate —
  build, review, protected publication, blessing. That decision is already
  mandatory and already exact. Re-litigating it inside every grant match
  converts one reviewed decision into a workspace-wide re-approval storm.
- GAD updates itself through the ordinary candidate path (D11). Under
  execution-digest identity, every self-update would invalidate every
  session-, task-, and mission-scoped grant in the workspace. Authority that
  evaporates for reasons users cannot perceive trains reflexive re-approval,
  which is the failure mode the approval system exists to prevent.
- The caller side is unaffected: a `code:<repoPath>@<digest>` subject still
  lapses on any content change (capability-redesign D5), and the
  internal-or-vouched rule still gates standing grants to code subjects.
  That is where content risk actually lives in this threat model.

### D5. Resource derivation is declarative; complex resources use handles

The host never executes provider JavaScript to decide what an approval
protects. The derivation algebra is small and closed: receiver object key,
target runtime identity, a validated scalar argument path (with declared
normalization and bounds), an opaque handle argument, or a bounded tuple of
those under a declared namespace. Derivation runs after schema validation,
before evaluation, and yields a canonical resource key plus bounded
presentation facts. It cannot call services, read provider storage, or emit
content into the approval.

When provider logic must prepare state first, it does so and receives a
host-sealed **opaque handle**: an unguessable id whose meaning lives only in a
host-owned record binding workspace, capability, definition digest, the
logical receiver service and object key, resource type, provider-supplied
bounded presentation, and revocation state. Issuance is permitted only from
declared handle-producing methods; the host binds the live receiver facts
itself. A handle selects a resource and conveys no authority; every use still
requires an applicable grant. Lookup fails closed on unknown, revoked,
wrong-workspace, wrong-capability, wrong-definition, wrong-receiver, or
wrong-type handles.

Handles are invalidated by lifecycle, not clocks: provider revocation,
definition-digest change, logical-service retirement, or explicit workspace
teardown. They are not invalidated by ordinary provider rebuilds (the
provider's durable state survives those; if a migration changes the meaning
of prepared state, the provider revokes as part of its migration) and they
carry no TTL.

### D6. No clock decides an authority outcome

Codifying the acquisition spec's stance as a plan-wide invariant, because the
previous draft violated it repeatedly:

- Pending acquisitions never expire; they resolve by decision, dismissal, or
  the end of the requesting lifecycle (session death, mission retirement,
  provider or workspace shutdown — each with an explicit terminal outcome and
  a settled waiter).
- `awaitDecision` has no timeout parameter; a caller that wants to stop
  waiting cancels its own call.
- Preauthorization envelopes are bounded by task and session lifecycle, not
  duration.
- Attestation replay protection is single-use nonce consumption with a wide
  clock-skew bound for table hygiene (per the P1 spec) — not a tight
  freshness window.
- Resource handles carry no expiry (D5).
- `EXTERNAL_APPROVAL_TIMEOUT_MS` is deleted with its service. A relayed
  external approval settles when decided or when the requesting context ends.

The one intentional exception domain is delegated-approval _policy_ hygiene
(system-agent-design §5), which is that document's concern, not this plan's.
This plan introduces zero new clock-bound authority.

### D7. One approval system; the advisory API is deleted

Every authorization question flows through the acquisition loop: gated call →
`EACQUIRE` or parked invocation → trusted card → decision → grant → resume
with full re-evaluation. Userland capabilities get the identical treatment as
host capabilities: same queue, same severity computation (SA1 may resolve
routine verdicts under an active policy; sensitive requires opt-in; critical
always reaches a human), same inventory, same revocation, same audit. Cards
show host-verified chrome — provider, source, exact version, caller, causal
lineage, tier, scope choices — with provider copy bounded, attributed, and
namespaced so it cannot impersonate builtins.

Every `userlandApproval` callsite is classified as exactly one of:

| Existing intent                                           | Replacement                                          |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Permission to enter a receiver-owned operation            | Receiver-enforced userland capability                |
| Permission to exercise a host/native effect               | Capability on the actual host receiver               |
| Secret/token/passphrase entry                             | Dedicated trusted input surface, no grant semantics  |
| Non-authorizing choice among application behaviors        | Ordinary trusted form / interaction state            |
| External party asks the local user to approve a local act | Acquisition bound to the local exact invocation      |
| Approval history shown in a trajectory                    | Projection of the acquisition outcome, never a grant |

The census covers runtime approval helpers, extension-host bridges, shell,
browser data, mobile debug, test runner, pubsub/channels, linked/external
agents, the template composer, generated catalogs, system-test skills, and
approval-card fixtures. When the classified replacements land, `request`,
`requestAs`, `requestExternal`, `settleExternal`, the flat `list`/`revoke`
pair, the `userland.choice/*` grant namespace, and the provider SDK helpers
are deleted. No row translates: old rows lack the exact receiver, definition,
and invocation facts, so they are dropped and re-asked.

Friction discipline: per the residency redesign's fourth principle, this
migration adds no prompt to a flow that is promptless today. Reads and
routine operations are open-tier; a definition exists only where a named
dangerous operation exists. Every prompt this plan introduces must be
registered in `docs/approval-prompt-ux-spec.md` before it ships.

### D8. Original authority context survives forwarding

Calling through GAD, the composer, a panel, or any intermediary never replaces
the original caller. Receiver entry sees the authenticated immediate caller
_and_ the original subject, causal lineage, and context-integrity class; an
intermediary can narrow through an explicit host-recorded relationship, never
amplify. Downstream host effects evaluate their own capabilities against the
propagated original context (D9). This is the P1/acquisition machinery's
existing contract; it is restated here because GAD becomes the system's
biggest intermediary the moment it is userland.

### D9. Host effects remain independently protected

A userland capability admits entry to its provider's own resource — nothing
else. It cannot authorize credential use, egress, host filesystem or Git
mutations, process/PTY operations, browser opens, device operations,
extension installation, runtime lifecycle, or another provider's resource.
When a GAD or template operation reaches such an effect, the owning receiver
runs its own evaluation over the original invocation closure. Template policy
stays userland (the composer decides _what_ to publish); the generic
protected-write primitive verifies and applies the prepared mutation after its
own capability succeeds, without learning template semantics.

### D10. GAD's method surface gets a complete authority audit

Every public `GadWorkspaceDO` method (72 today, 67 attested open) receives:
schema, principals, tier, sensitivity, effect binding, relationship
requirements, and bounded presentation. The audit's shape:

| Category                                  | Default shape                                     |
| ----------------------------------------- | ------------------------------------------------- |
| Health/schema/version reads               | open to related principals, bounded output        |
| Semantic/projection reads                 | open or gated by privacy of the exact resource    |
| Ordinary trajectory/channel appends       | open only with an exact live relationship         |
| Context/log/channel creation              | gated over the exact parent/destination           |
| Ref and publication updates               | gated over the exact ref and expected state       |
| Membership, invitations, registries       | gated/admin over the exact resource               |
| Delete, purge, rewrite, integrity repair  | critical, usually once                            |
| `rawSql`, `query`, generic escape hatches | removed from production; diagnostics become typed |

The ledger is an exact-set CI test against generated production exposure; an
unclassified method fails the build. Agent-tool approval events may remain in
GAD as provenance data; they are never grants and admit nothing.

### D11. Residency follows ownership; the five-package move is reversed

Target shape:

```text
product repository:  packages/ = host mechanisms + genuinely shared wire
                     contracts; src/ = installed host; no workspace source
base repository:     workspace-source worker, runtime, agentic-protocol,
                     vcs-engine, and every other base userland unit
```

Dispositions: the `workspace-source` worker, `agentic-protocol`, `vcs-engine`,
and `runtime` return to base userland and use workspace-owned package
identities. Package scope is never residency evidence: every workspace-owned
unit uses the centralized `@workspace*` scopes, while `@vibestudio/*` is
reserved for host-supplied platform packages. `cdp-client` goes with the
browser-capable feature that uses it. Where the host genuinely needs a shared
type, the narrow contract is extracted into a root package that imports no
userland implementation; a broad `shared`/`runtime` import is not a
substitute.

The boundary gate is strengthened from a source-string lint into a build
property: reject host imports resolving into userland source roots regardless
of package scope; reject host package-manifest edges to userland-resident
packages; inspect esbuild metafiles for workspace-source inputs to host
artifacts; reject symlink-realpath escapes; build and test the production host
in a checkout with `workspace/` absent; verify the internal-DO bundle contains
only declared internal sources. Hard violations are non-allowlistable. The
`host-boundary-checker` test that blesses the current GAD import is deleted
and replaced by a regression fixture reproducing the original escape.

**GAD self-update** (the fixed point, done properly): current GAD publishes a
candidate → the host builds and reviews the candidate from that exact state →
any failure leaves the old image live → a successful swap advances the runtime
image against the same logical DO storage, with the schema-migration receipt
as the point of no return (mechanics per
`docs/durable-object-schema-migrations.md`: quiesce, transactional migration,
never two writable incarnations, old code never runs against new schema) →
the manifest/build gate rejects any candidate that drops the required
workspace-source protocol or mutates the frozen service coordinates, so a
workspace cannot publish itself into an unbootable state.

### D12. The cutover is destructive and singular

No compatibility mode: no `vibestudio/internal` GAD identity or storage
probing, no dual service resolution, no internal-bundle fallback when userland
GAD fails, no legacy approval lookup, no definition-translation shim, no old
target ids in tests, skills, or generated catalogs. Bootstrap, GAD residency,
and authority land as one supported architecture change (reviewable commits,
single supported state), because every partial combination is worse than
either endpoint: userland GAD without clone-first cannot boot; clone-first
with sealed GAD keeps two source authorities; userland GAD without receiver
enforcement loses authorization; receiver enforcement beside advisory
approvals is two authorization paths. Failure to declare, build, activate, or
authorize the semantic service fails workspace startup with a precise
diagnostic — it never silently selects a different authority.

## Startup, target shape

- **Phase A — mechanical root readiness.** Generic infrastructure only; pin
  resolved; credential acquired if challenged; commit and snapshot verified;
  tree materialized atomically; epoch and flattened manifest validated.
- **Phase B — bootstrap build.** From the flattened manifest, find the unique
  `vibestudio.workspace-source.v1` provider and its singleton binding; build
  exactly that closure from the bootstrap source reference; seal authority
  metadata; obtain activation review; activate only that service. No panels,
  agents, routes, or recurring jobs start early merely because the manifest
  declares them.
- **Phase C — semantic handoff.** Initialize GAD with the exact snapshot;
  require the idempotent receipt; switch the source provider; reconcile and
  build the remaining declared units; retire the bootstrap view.
- **Phase D — steady state.** Manifest-driven lookup everywhere; GAD updates
  itself through D11; template operations call the userland composer; native
  effects cross capability-enforced host services; restart restores the exact
  active runtime image with no internal-GAD branch.

## Work packages

Ordering is load-bearing: authority substrate before GAD exposure, GAD
residency before bootstrap rewiring, everything before extraction.

**WP0 — Package residency correction.** Produce the per-package ownership
audit (host production consumers, workspace consumers, contract vs
implementation) for the five moved packages and every root package they
dragged in; extract narrow contracts where both sides genuinely share one;
move implementations back under `workspace/`; delete the blessing test. No
template release ships from the current placement. Deliverable: reviewed
ownership map, green baseline.

**WP1 — Finish the unified acquisition foundation.** Complete the P1/P3 work
per their owning specs (shared DO enforcement with parity audit; acquisition
loop, one grant store, once-CAS, suspend/resume, preflight, SA1 hookup). This
plan's only additions: the D4 snapshot/grant field deltas and the D6 clock
purge. Deliverable: host capabilities acquire through one loop with no
dead-end gated method.

**WP2 — Receiver-enforced userland capabilities.** Definition schema,
derivation algebra, definition digest, identity (D4/D4a); sealed build
metadata and validation; handle issuance/revocation; enforcement in every
dispatch route (service dispatcher, direct DO, resumed invocations, alarms
acting for a principal, test-harness parity); provider-attributed cards;
inventory/audit integration. Deliverable: a provider that omits its own check
cannot receive a gated call; changing a definition invalidates its grants;
an ordinary rebuild does not.

**WP3 — Userland GAD.** Move the `workspace-source` worker (and its implementation
deps) back to workspace source; declare `gad.workspace` in base's flattened
manifest; complete the D10 method audit; remove `rawSql`/`query`; re-point
all callers to logical-service/protocol resolution; fixtures construct a
userland build or a direct test DO, never a product identity. Deliverable:
GAD builds and passes its suite as a standalone workspace package with no
host import.

**WP4 — Manifest-driven startup and self-update.** Generic singleton
resolution in startup; `WorkspaceSourceProviderV1` client replaces
`SEMANTIC_CONTROL_PLANE` adapters; lifecycle reordered per Phases A–D; DO
continuity across GAD rebuilds; crash tests at every handoff boundary; the
D11 self-update path proven transactional. Deliverable: a workspace-declared
GAD boots, restarts, and updates its own implementation through normal paths.

**WP5 — Exact-root bootstrap completion.** Harden the existing pin path per
D3: production Git transport for local/anonymous/authenticated/GitHub
remotes; anonymous-means-anonymous credential lookup; atomic
materialization; the bootstrap source reference in the build API; minimal
mechanical creation record; activation without template interpretation.
Deliverable: the CLI creates a working workspace from a local smart-HTTP root
through exactly the paths external URLs use.

**WP6 — Deletion.** Remove the `GadWorkspaceDO` export, `controlPlane.ts`,
product GAD catalog/principal/grant generation, internal-GAD branches in
workerd management, runtime-image restoration, reviewed target sets, GC and
startup; delete `userlandApprovalService` and the `userland.choice/*` store
namespace per D7; delete root dependencies retained only for the sealed
bundle; regenerate ledgers and catalogs from the new declarations.
Deliverable: searching production code for the internal target or the
advisory API returns nothing.

**WP7 — Boundary enforcement as a build property.** Land the D11 gate set,
including the host-builds-without-`workspace/` CI job and the regression
fixture for the original escape. Deliverable: the violation cannot be
reintroduced directly, transitively, by rename, or by symlink.

**WP8 — Composer, Git bridge, docs, and DX.** Declare receiver capabilities
for template-composer resources and migrate its flows to acquisition;
Git-bridge operations independently acquire their Git/credential effects;
template cards become projections of real invocation snapshots; CLI and
agents receive identical structured outcomes; skills, contract fixtures,
generated catalogs, and agent guidance updated so preflight/acquire/deny/
stale-build are discoverable without teaching internals. Deliverable:
removing the composer package makes template operations fail cleanly — the
host has no fallback.

**WP9 — Commit boundary.** Review the complete diff for accidental host
residency; land as descriptive commits (authority foundation; userland
capabilities; userland GAD + startup; bootstrap + deletion; guards + tests +
docs); record validation commands and system-test run ids. Only then does the
template plan resume at physical extraction.

## Test strategy

Unit/contract coverage follows from the decisions (definition identity and
lapse-on-definition-change, rebuild-does-not-lapse, handle fail-closed
matrix, deny precedence, once-CAS races, dispatcher/direct-DO parity,
forwarding non-amplification, the D10 exact-set ledger, bootstrap phase
idempotence at every crash point). Boundary/packaging tests are the WP7 gate
set. Two suites are singled out because they define done:

**The deterministic full-stack test.** A local smart-HTTP Git server and the
public CLI, against a host artifact built with no checked-in workspace
source: publish an exact base root tag; create a workspace from the pin;
verify anonymous and authenticated acquisition through the ordinary
credential flow; observe the manifest-driven GAD build, activation review,
receipt, and restart; exercise open, gated, denied, once-, session-, and
version-scoped GAD calls; revoke and reacquire; update GAD through an
ordinary semantic candidate and verify definition-stable grants survive while
`version`-pinned grants lapse; add, update, and remove a template through the
userland composer; push/pull through Git bridge; restart the host and verify
full restoration with no internal artifact. The approval driver auto-approves
only exact expected cards and fails on any unexpected capability, resource,
provider, or scope — approval behavior is part of the assertion, not a
bypass.

**Agentic system tests.** Per the repository's headless procedure: discover a
GAD method and its capability; preflight then acquire; explain a denial;
choose a narrow scope; recover from revoked authority and from a stale
definition; distinguish credential acquisition from userland resource
authority; author and publish a template from inside the workspace; diagnose
a deliberately broken root manifest without finding a host fallback.

## Failure semantics

Root unacquirable → exact Git/credential/snapshot error, no partial
workspace, no packaged-source substitute. Root builds but GAD does not →
exact diagnostics, resumable mechanical operation, never an alternative GAD.
GAD starts but initialization fails → retain snapshot and receipt, retry the
same idempotent initialization, never import a different tree. Invalid
declaration → build failure, never runtime repair. Missing authority → one
structured acquirable or one stable denial, never a generic infrastructure
error. Provider changes while an approval is pending → the old acquisition is
stale; the new invocation acquires freshly. Host effect fails after userland
admission → reported separately; a userland grant implies nothing about the
downstream effect.

## Acceptance criteria

- [ ] `GadWorkspaceDO` exists only in workspace/base source; the internal DO
      bundle does not contain it; no host source or root package imports a
      userland implementation; no boundary exception or blessing test exists.
- [ ] A production host builds and passes tests with `workspace/` absent, and
      creates a ready workspace from an exact external pin via the CLI.
- [ ] Base declares and boots `gad.workspace` through the generic resolver;
      the host has no literal internal GAD target; crash recovery at every
      bootstrap phase is deterministic.
- [ ] Every GAD production method carries reviewed schema, principals, tier,
      sensitivity, and effect; `rawSql`/`query` are gone; the exact-set
      ledger gates CI.
- [ ] Userland gated methods are enforced before provider code runs; direct
      DO and dispatcher enforcement are equivalent; forwarding preserves the
      original authority context; downstream host effects evaluate
      independently.
- [ ] One evaluator, grant store, approval queue, inventory, and audit model
      cover host and userland capabilities; the advisory approval API and its
      grant namespace are deleted; every new prompt is registered in the
      prompt UX spec.
- [ ] Definition changes lapse grants and handles; ordinary rebuilds lapse
      neither; `version`-scoped grants pin execution digests; no authority
      object introduced by this plan carries a TTL.
- [ ] The deterministic full-stack test passes with an exact approval script;
      focused, category, and smoke agentic tests pass.
- [ ] Template operations fail cleanly without the userland composer; the
      host has no fallback; repository extraction begins only after all of
      the above land as reviewed commits.

## Explicitly rejected

- Root-package residency for GAD's dependency closure (the `4f398e063`
  placement), and `@vibestudio/*` naming as residency evidence.
- A host-owned "semantic kernel" substitute for userland GAD; a precompiled
  internal GAD fallback; dual identities during migration; migrating
  pre-release internal storage.
- Providers enforcing decisions returned by an advisory API; userland
  capabilities authorizing host effects.
- **Execution-digest-bound grant identity** (previous draft): rebuilds must
  not invalidate definition-stable grants; the activation gate, not the grant
  matcher, governs which bytes run.
- **Clock-bound authority**: TTLs on pending acquisitions, decisions,
  attest­ation freshness (beyond nonce-hygiene skew), handles, or external
  approvals.
- A parallel wire-level re-specification of the snapshot, grant store, or
  acquisition loop in this document (own­ed by the acquisition and P1 specs).
- A special disposable/local Git path bypassing external-URL behavior; broad
  test auto-approval accepting unnamed cards; splitting template repositories
  before the boundary is proven.
