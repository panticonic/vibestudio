# Explicit Capability Manifests and No-Silent-Drift Plan

Status: implementation plan, revision 3 (2026-07-21).

Depends on `capability-model-redesign.md`, especially D1–D5, D8, D12, D13. This plan
defines how installed workspace units state authority intentionally, how semantic
capabilities are enforced without losing the caller's authority, and how the build
prevents code, API contracts, manifests, and runtime enforcement from drifting apart.

Revision 2 resolved the first review round (semantic enforcement, soundness, resource
scopes, dependency confinement, critical tier, D12, delegation vocabulary). Revision 3
resolves the second: §4 is rewritten for the compositional authority model (all
requirement leaves evaluated; closures cross receiver boundaries with propagated
context — "checked once" was wrong), confinement claims are staged honestly against
`hardened-runtime-integration.md` (the eval path is not yet a compartment), the
dependency guarantee is scoped to initial authority (§8), the promotion annotation
mechanic is deleted (§9), and migration is anchored to the redesign's P1–P5 (§14).

## 1. Decision

An installed unit's authority manifest is an **author-reviewed source contract**. The
build may analyze code and propose changes, but normal builds and CI must never rewrite
that contract or turn inferred use into authority.

For every buildable unit:

```text
every gated or critical effect reachable by the unit ⊆ explicitly requested authority
explicitly requested authority ⊆ valid semantic capability vocabulary
runtime authority (gated)    = explicit request ∩ standing grant
runtime authority (critical) = explicit request ∩ fresh per-exercise approval
```

The first relation is enforced by **two independent layers**, and the security claim
rests on their conjunction, not on either alone:

1. **Reachability confinement (runtime, load-bearing).** Installed-unit code runs in a
   confined environment where the only powerful objects it can reach are the typed API
   endowments its manifest justifies. An effect the manifest does not request is not
   merely undeclared — it is unreachable. This holds even for code the static analyzer
   cannot see through (aliases, computed calls, higher-order dispatch, dynamic import).
   This property is **staged**, not current: `hardened-runtime-integration.md` defines
   which rollout step delivers which slice of it per environment (today's eval path is
   endowment discipline plus receiver enforcement, not confinement). Until the
   confinement step for an environment lands, receiver-side enforcement is the
   operative boundary there and this plan's claims must be read accordingly.
2. **Static effect check (build, review contract).** The build computes the effect
   closure of the typed API surface actually endowed and compares it to the manifest.
   Its job is not to catch an attacker — confinement does that — but to make every
   authority expansion a review-visible source diff and to keep the manifest honest.

Inference supplies evidence for the review contract only. It never creates a request,
never creates a grant, and never widens an endowment.

Open-tier methods require neither a request nor a grant, but remain subject to their
receiver-side principal, membership, context, resource, and lifecycle requirements.

## 2. Why this is security rather than bookkeeping

A source scanner which rewrites the manifest to match the implementation rubber-stamps
the implementation. It detects mechanical inconsistency, but it does not require the
author or reviewer to decide that a new power belongs in the unit.

The security boundary is the review-visible mismatch:

1. Code begins exercising a new gated or critical semantic effect.
2. The build fails and explains the effect and its source call path — or, if the code
   reached for a power outside its endowments, the call fails at runtime with a typed
   unreachable-authority error naming the missing request.
3. The author either removes the effect or explicitly edits the manifest.
4. Review sees the authority expansion as a dedicated source diff.
5. Runtime seals that reviewed manifest into the exact content-addressed build and
   derives the unit's endowments from it.
6. A separate product policy or user decision grants some or all of the request.

No stage silently converts observed behavior into permission, and no stage lets
unanalyzable code exercise unrequested authority anyway.

## 3. Semantic capability vocabulary

Authors request stable product effects, not transport or storage implementation details.
Examples:

| Author-visible capability   | Possible internal implementation                               |
| --------------------------- | -------------------------------------------------------------- |
| `panel.navigate`            | prepare a target, commit panel-tree navigation, update history |
| `panel.create`              | allocate a panel entity and insert it into the tree            |
| `workspace.files.read`      | route a context-bound read through the filesystem service      |
| `workspace.files.write`     | validate context authority and publish an edit                 |
| `process.execute`           | invoke the shell extension and manage its process lifecycle    |
| `network.fetch`             | route egress through credential and policy evaluation          |
| `credential.use:<audience>` | select and use a credential for one declared audience          |

The `workspace-state.slot.commitPreparedNavigation` service method and its
`WorkspaceDO.slotCommitPreparedNavigation` implementation are userland runtime
infrastructure. They remain explicitly classified and audited, while ordinary
panel authors use panel navigation APIs rather than invoking the transaction
directly.

Runtime protocol necessities such as connection establishment, readiness, and heartbeat
are part of the runtime contract. They are not discretionary powers and must not inflate
author manifests. Their receiver-side restrictions remain strict.

## 4. Semantic enforcement: manifest-facing capabilities over a compositional check

This section defines the authority-preserving translation between the semantic
vocabulary authors request and the receiver enforcement that actually runs. Revision
2's "one capability, checked once, in-process" was wrong on both counts: the redesign
requires every compound/additional/prepared requirement leaf to be evaluated (methods
like `panelTree.navigate` genuinely carry multiple leaves), and real semantic closures
cross service and Durable Object boundaries (`ownerPanelTreeBridge` re-enters the
dispatcher and dispatches on to WorkspaceDO). The corrected model:

> **Semantic capabilities are the manifest-facing vocabulary. The compositional
> requirement evaluation is unchanged. Original-caller context propagates across every
> internal leg of a closure, so no leg substitutes its own authority for the
> caller's.**

Concretely:

1. **Requirement leaves are classified, not collapsed.** Every gated or critical
   method's requirement tree keeps all of its leaves, and the evaluator continues to
   evaluate all of them, exactly per the redesign. Each leaf is classified in the
   census as either:
   - **manifest-facing** — named by a semantic capability (`panel.navigate`,
     `credential.use:<audience>`); checked against the calling code's manifest
     requests ∩ grants. An operation may carry _several_ manifest-facing leaves —
     `network.fetch` plus `credential.use:<audience>` is the canonical compositional
     case — and each must be independently requested. This is why collapsing to "one
     capability" was wrong: independently requestable effects stay independently
     visible in manifests.
   - **closure-internal** — an implementation leaf (e.g. the prepared-navigation
     commit leaf on `panelTree.navigate`). It is still evaluated, but what satisfies
     it is closure membership: the census records which boundary operation owns the
     leaf, and the check verifies that the invocation's authenticated initiator chain
     passes through that boundary operation with its manifest-facing leaves already
     authorized. Closure-internal leaves never appear in author manifests and can
     never be satisfied by a direct external call.
2. **The legacy transport strings are retired as authorization identities.**
   `service:${service}.${method}` and `rpc:${method}` survive only as audit labels on
   invocation records. Dispatch stops synthesizing capability names from the wire
   address and reads the census-declared classification off the method definition. A
   gated method whose definition declares neither a manifest-facing capability nor a
   closure-internal owner fails registration, not dispatch.
3. **Closures span receivers; authority is preserved by context propagation, not by
   staying in-process.** A semantic operation's closure may re-enter the dispatcher
   and cross into other services and DOs — this is normal architecture, not an edge
   case. Each internal leg carries the original invocation context (principal,
   resolved resource, argument digest, context-integrity lineage) via the
   authenticated initiator chain — the generalization of the AsyncLocalStorage
   caller-propagation the panel-tree bridge already implements. Each receiving leg
   verifies, at its own attested boundary, that the chain roots in the owning
   boundary operation and that the original caller's authorization was established
   there. The host never substitutes its own principal for the caller's on a closure
   leg; a leg that cannot present the propagated context is an ordinary external call
   and is evaluated (and for closure-internal methods, refused) as such. "Checked
   once" is replaced by the accurate invariant: **authorized once against the
   manifest, verified at every attested boundary it crosses, never re-authorized
   under a different principal.**
4. **Internal-only methods admit closure-propagated invocations only.** "Admits no
   external principal" means: no invocation whose chain does not root in the owning
   boundary operation. It does not mean the method is unreachable across process/DO
   boundaries — closure legs legitimately reach it with propagated context.
5. **Invocation snapshots record the manifest-facing capabilities** exercised by the
   boundary operation (all of them, when compositional), with concrete receiver
   methods retained as diagnostic detail. This keeps D12 promotion (§9) and
   acquisition prompts in manifest vocabulary.

The census (§6.1) is the single source of this classification, so the mapping is not a
side table that can drift: it is the same reviewed artifact the runtime loads its
requirements from.

## 5. Tier semantics in the manifest

The redesign's three tiers map onto the manifest as follows:

- **open** — never appears in a manifest. Requesting an open capability is build noise
  and fails (§6.3). Adding open-tier behavior therefore produces no unit authority
  diff; the global census diff is the review surface for tier assignment itself. This
  is a deliberate consequence of D2 and the trusted-environment decision: this plan is
  a **gated-and-critical authority drift contract**, not a total effect ledger.
- **gated** — requires an explicit manifest request; runtime authority is the
  intersection of that request with a standing digest-bound grant.
- **critical** — **requires an explicit manifest request exactly like gated**, but per
  D1 no standing grant ever exists. The request declares intent and creates the
  review-visible diff; every exercise still takes a fresh user approval whose scope is
  bounded by the request. `runtime authority = request ∩ fresh approval`. Adding a
  critical operation to a unit therefore always produces both a manifest diff at
  review time and a prompt at exercise time. A critical request never satisfies a
  gated requirement or vice versa.

Manifest entries are `(capability, resource scope, tier)` — the tier is redundant with
the census but recorded so that a census tier change against an existing request is a
loud, review-visible conflict rather than a silent reinterpretation.

## 6. Build pipeline

### 6.1 Construct the actual service census

The build imports registered service definitions and Durable Object method declarations
and produces a deterministic census containing:

- service and method identity;
- mandatory tier;
- admitted principal families;
- prepared and additional requirements;
- per requirement leaf: the manifest-facing semantic capability, or the
  closure-internal classification with the boundary operation that owns the leaf
  (§4.1 — mandatory for every gated/critical method, no default);
- internal-only classification, for runtime plumbing and closure implementation
  methods, with the boundary operation that owns them;
- the resource-derivation declaration (§7).

The checked-in golden census is compared byte-for-byte with this actual census. A new,
removed, or changed method fails the build until its classification is explicitly
reviewed and the golden is updated. Downstream analysis must consume the actual typed
schema or a golden proven equal to it in the same invocation; it must never consume an
unchecked stale snapshot.

### 6.2 The endowed API surface is the analysis boundary

Installed-unit code does not receive the open-ended dispatch surface. The universal
`services.<name>.<method>` proxy, string-typed `callMain(method, …)`, and dynamic
panel method proxies are **eval-session and runtime-internal affordances**; they are
not part of the installed-unit endowment set and are unreachable from installed code.
Installed units import typed API modules, and the loader endows each unit only with
the operations whose semantic capabilities its sealed manifest requests (plus the
open-tier and runtime-intrinsic surface).

This is what makes the static relation sound: the analyzer no longer has to prove a
negative over arbitrary JavaScript. Effects enter a unit only through typed endowments,
each of which declares its semantic capability and resource-derivation contract. The
effect closure of a unit is the union of the effect declarations of the endowments it
links against — a finite, declared set — not the result of call-site pattern matching.

Enforcement of the boundary is runtime confinement, not linting: guest code runs under
Hardened JavaScript with no ambient host authority, so a computed property, alias,
proxy, or dynamic import can only ever reach what was endowed. The concrete mechanism
differs by environment — SES `Compartment`s where native eval exists (webviews), and a
reconstructed private guest global (scope-proxied evaluation over the UNSAFE_EVAL
compile path plus the host-owned module map) inside workerd, where SES's evaluator
cannot run. Named endowment parameters alone are **not** confinement — evaluated code
retains the realm's `globalThis` — so this property exists only once the
corresponding step of `hardened-runtime-integration.md` §3.2 has landed for the
environment in question; before that, receiver-side enforcement is the operative
boundary. Once it holds, static analysis of call sites within the unit is demoted
from security mechanism to diagnostics (precise call paths in error messages,
unused-request detection).

**Fail-closed rule (normal builds, not just `suggest`):** any dynamic dispatch site
that escapes the typed endowment surface — a raw transport handle, a string-method
escape hatch, an endowment marked unbounded — fails the build unless the API it uses
declares an explicit bounded effect set, and that whole set is charged against the
manifest. There is no category of call that contributes "no evident effect"; a call the
model cannot attribute is an error, never a vacuous pass.

### 6.3 Compare; do not rewrite

The build compares the unit's effect closure with the explicit manifest:

- missing request: fail with the capability, tier, source call path, resource-evidence
  class (§7), and suggested manifest entry;
- unknown capability: fail;
- request for an open/runtime-intrinsic operation: fail as obsolete noise;
- unused gated or critical request: fail unless the endowment marks it as an
  intentionally dynamic bound. "Used" means present in the static effect closure —
  an unexecuted branch is used; no execution-history annotation exists (§9);
- resource request broader than its evidence class supports: fail unless annotated as
  an intentional broad bound (§7);
- dependency authority expansion: fail and show which dependency and endowment
  introduced it (§8);
- unattributable dynamic dispatch: fail (§6.2);
- eval-ceiling expansion (§10): always require an explicit manifest edit and dedicated
  diff.

Only an explicitly invoked developer command may produce or apply a suggested manifest
patch. Like the build, it exits non-zero if any use cannot be explained by typed effect
metadata — the build and the suggest command share one attribution engine and one
fail-closed rule.

### 6.4 Seal the reviewed contract

After validation, the builder seals the explicit manifest, semantic-effect closure,
endowment set, source state, build key, and execution digest together. Activation
accepts only that complete identity, and the loader constructs the unit's compartment
endowments from the sealed manifest — the same artifact review saw. Runtime dispatch
evaluates the request/grant (or request/approval, for critical) intersection against
the sealed identity and the receiver's current census-declared method contract.

## 7. Resource scopes in the evidence model

A manifest request is a `(capability, resource scope)` pair, so the evidence model must
speak about resources, not just capabilities. Every typed endowment declares, per
operation, a **resource-derivation contract** — how the receiver's
`deriveAuthorityResource` will resolve the resource from the arguments. From it the
analyzer assigns each use one of three evidence classes:

1. **Exact** — the resource-bearing argument is statically constant at the call site
   (literal origin, literal path prefix, literal audience). Evidence supports an exact
   or narrower request; a broader request over this capability is flagged as
   over-broad.
2. **Bounded-dynamic** — the argument is runtime-computed, but the endowment or call
   site declares a bound (e.g. `network.fetch` scoped to `origin:*.example.com` by an
   attenuated endowment). Evidence supports a request equal to the declared bound.
   Attenuation is enforced at runtime by the endowment wrapper, not merely asserted:
   the endowment refuses arguments outside its bound before dispatch, and the receiver
   still independently checks the resolved resource against the grant.
3. **Unbounded-dynamic** — runtime-computed with no declared bound. This supports only
   a request explicitly annotated `intentional-broad` in the manifest, which is a
   review-visible marker, and the diagnostic names the call site that forces it.

Rules: a request must be at least as broad as the evidence of every use it covers
(else the build fails with the uncovered use), and no broader than its widest evidence
class allows without an `intentional-broad` annotation (else the build fails as
over-broad). "The capability appears somewhere" is never sufficient to justify a wide
resource: coverage is checked per `(capability, resource)` request, not per capability.

Runtime remains the authority on the concrete resource: the receiver derives the actual
resource key from the actual arguments and checks it against the granted scope on every
invocation, exactly as today. The static classes exist so that review sees the honest
shape of the request, not to replace the runtime check.

## 8. Dependencies: confined, not trusted

The threat model names dependencies as untrusted content. Two consequences, replacing
the previous revision's reliance on dependency-supplied metadata:

1. **Dependency effect metadata is never package-authored.** The build runs the same
   endowment-closure analysis over the dependency's exact content-addressed sources as
   over first-party code, at install/build time. Results may be cached, keyed by
   content digest, but a digest proves _which bytes_ were analyzed, never substitutes
   for analyzing them. Registry-supplied or package.json-declared effect claims are
   ignored as evidence. Since dependencies are confined the same way units are (below),
   this analysis is again diagnostics and review-shaping, not the security boundary.
2. **Per-package confinement bounds each package's _initial_ authority.** Within a
   unit, each dependency package loads in its own confinement scope — a per-package
   content-addressed bundle linked through the host-owned module map (a SES
   `Compartment` where native eval exists; see `hardened-runtime-integration.md` §5) —
   and is endowed only with what the unit's manifest routes to it. The manifest's
   request entries may carry a `packages:` attenuation listing which dependency
   packages an endowment is passed to; absent an entry, powerful endowments stay with
   first-party unit code and dependencies get none. A compression library therefore
   cannot exercise `network.fetch` merely because the unit requested it for its sync
   module — _unless something passes it a reference_. Routing does not, and in an
   object-capability system cannot, prevent capability references from flowing after
   link time: a package can receive a capability as an argument or return value, or
   drive another endowed package as a deputy through its exports. That flow is ocap
   delegation, confined to explicit module-boundary interfaces that review sees. The
   honest guarantee is: no route and no collaborator-passed reference ⇒ no exercise;
   and receiver-side enforcement still evaluates every invocation regardless of
   which package issued it. Deep post-sharing flow control (membranes) is a possible
   future layer, not part of this plan.

A dependency upgrade that widens any package's required endowments fails the build with
the dependency, the introducing import path, and the manifest edit that would admit
it — the same review-visible flow as first-party expansion.

Compartment limits are acknowledged, not papered over: compartments share one JS agent,
so this confers no CPU/memory-exhaustion isolation (that remains the workerd/process
layer's job), and endowment implementations are TCB and must themselves preserve the
boundary — which is exactly why §7 requires attenuation to be enforced inside the
endowment wrapper.

## 9. Reconciling D12 promotion

D12 derives a draft manifest from the invocations a snippet actually exercised. Under
this plan that draft is necessarily incomplete (unexecuted branches) — so promotion is
defined as **observation proposing, static closure completing, the user deciding**:

1. Invocation snapshots already carry semantic capabilities and resolved resources
   (§4.4), so observed use translates directly into manifest vocabulary — no
   receiver-string conversion step exists anymore.
2. At promotion, the promoted source is compiled as an installed unit for the first
   time, producing its full static effect closure (§6). The install-review draft shown
   to the user is the union, partitioned honestly:
   - **observed and statically evident** — normal entries, resource scopes narrowed to
     observed use where the evidence class allows;
   - **statically evident, never observed** — unexercised branches; the user either
     confirms them (they become ordinary requests — no annotation is needed, because
     "unused" is defined against the static closure and a statically evident branch
     is used by definition; nothing at runtime ever writes back into the source
     manifest) or prunes the code;
   - **observed but no longer evident** — dead authority from earlier snippet
     iterations; dropped by default.
3. Confirmation at install remains the actual authority decision, minting digest-bound
   grants for gated entries only. Critical entries are confirmed as requests but mint
   nothing (§5). Session grants remain untouched.

Both plans' shared invariant stands: promotion never silently converts inferred or
observed use into authority — it converts it into a _draft_ the user reviews, and the
draft is complete because the static closure, not just the execution trace, feeds it.

## 10. Eval authority ceilings (retiring "delegation")

The redesign (D13) deletes the delegation chain, `VerifiedDelegation`, and the
delegation requirement flag. The word "delegation" in the manifest schema survives from
before that deletion and now means something narrower, so it is renamed to match what
it enforces:

- The manifest field `delegations` becomes **`evalCeilings`**: the maximum authority
  this exact artifact may endow to code it evaluates (agentic execution, tool evals,
  test evals), expressed in the same semantic-capability/resource vocabulary as
  requests. A ceiling is not a request and mints nothing; it caps what the unit's eval
  sessions can even ask for, and composes with mission tool exposure and
  preauthorization from the system-agent design: `effective eval authority ⊆
evalCeiling ∩ session envelope ∩ (grants or fresh approvals)`.
- Ceiling expansion follows the same rule the old text gave delegation expansion: an
  explicit manifest edit and a dedicated review diff, never inferred.
- No other delegation concept exists in the target model. Chain-style re-delegation of
  a caller's authority is expressed only by the initiator chain the host already
  authenticates, never by manifest entries.

## 11. Sources of truth

The system has four non-overlapping sources of truth:

1. **Method tier, semantic capability, and receiver requirements** live with the
   registered service or Durable Object method definition, surfaced through the census.
   Every gated/critical method names its capability or is internal-only; registration
   has no default.
2. **Endowment effect and resource-derivation contracts** live with typed public API
   operations.
3. **Unit requests, annotations, package attenuations, and eval ceilings** live in the
   unit's checked-in `vibestudio.authority` manifest and are edited intentionally by
   the author.
4. **Grants, denials, and per-exercise approvals** live in the runtime grant/approval
   store and result only from reviewed product policy or user decisions.

Generated ledgers are derived audit views. They are never an independent source of
authority.

## 12. Developer and agent UX

Build failures must answer:

- what power the code is trying to exercise, as a semantic capability;
- whether it is open, gated, or critical, and what that implies (nothing / standing
  grant / fresh approval every time);
- which source call and dependency path require it, and which compartment it runs in;
- which resource scope the evidence supports, and its evidence class;
- which manifest file must be edited;
- whether adding the request will still require product policy or user approval.

Example:

```text
panels/example uses gated capability panel.navigate (resource: exact "about/server-logs")
  panels/example/src/openLogs.ts:18 -> panel.open("about/server-logs")
  endowment: @workspace/runtime PanelApi.open (compartment: first-party)

Add an explicit request to panels/example/vibestudio.authority, or remove the call.
This request does not grant the capability; installed code still needs a digest-bound grant.
```

`pnpm authority explain <unit>` prints the complete evident/requested/granted
separation, including endowment routing per compartment. `pnpm authority suggest
<unit>` emits a patch to stdout. `--apply` is explicit and is never used by build, dev
startup, pre-commit, or CI. Both the build and `suggest` fail on any unattributable
use (§6.2).

## 13. CI and protected-main policy

The protected-main check runs, in order:

1. service registration and Durable Object census parity, including semantic-capability
   and internal-only completeness (no gated/critical method without exactly one);
2. endowment effect-contract and resource-derivation completeness;
3. unit effect-closure versus explicit-request parity, including resource evidence and
   dependency compartment routing;
4. confinement integrity tests: representative attempts to reach unendowed authority
   from unit and dependency compartments fail with the typed unreachable-authority
   error;
5. generated audit-ledger freshness;
6. build sealing and activation identity tests, including endowment-set binding;
7. representative allowed and denied runtime tests across gated and critical tiers.

The check fails closed. It never commits generated changes and never accepts a broad
wildcard in place of an unexplained exact capability. Generated ledgers may be
refreshed by an explicit maintainer command only after the underlying source decisions
are present.

## 14. Migration from the current generator

This is pre-release software. There is no compatibility mode and no legacy manifest
fallback.

**Relation to the redesign's P1–P5 (`capability-model-redesign.md` §4) — this sequence
does not float independently.** The controlling order is the redesign's; this plan's
steps attach to it as follows. Steps 1–3 below are part of P2 (tiers + census). Step
4 — the vocabulary cutover — is a single atomic phase inserted **after P3** (receiver
enforcement + acquisition), because retiring `service:x.y`/`rpc:x` must change
manifests, stored grants, method requirements, invocation snapshots, prompts, and
direct-DO attestations in one revertible commit set; it cannot trickle. Steps 5–6
(endowment surface, confinement) run alongside per `hardened-runtime-integration.md`
§7 and gate nothing in P1–P4. Steps 7–9 extend P5 (scanner + promotion). The manifest
schema changes (tier field, `packages:`, `evalCeilings`) land with step 4's atomic
phase. Rollout semantics throughout follow `authority-migration-plan.md`: revertible
tagged commits, no runtime feature flags.

1. Freeze the current generated manifests as an inventory, not as trusted decisions.
2. Make the service-definition census self-validating before any inference consumes it.
3. Introduce mandatory method tiers and classify every registered method.
4. Define the initial semantic capability vocabulary; classify every gated/critical
   requirement leaf as manifest-facing or closure-internal with its owning boundary
   operation (§4); generalize initiator-chain context propagation across closure
   legs; delete `service:x.y`/`rpc:x` as authorization identities — one atomic phase
   across manifests, grants, requirements, snapshots, prompts, and attestations.
5. Define typed endowment modules with effect and resource-derivation contracts;
   remove the `services` proxy, string `callMain`, and dynamic panel proxies from the
   installed-unit surface (they remain eval-session affordances under eval ceilings).
6. Land the hardened-runtime sequence per `hardened-runtime-integration.md` §7:
   de-globalize the eval kernel; `lockdown()` + `harden()` in the EvalDO isolate
   (compat suite as merge gate, revertible commit, no flag); webview lockdown; the
   private guest global; then per-package bundles linked through the module map with
   manifest attenuation routing (§8).
7. Replace manifest mutation with compare-only validation under the fail-closed
   attribution rule.
8. Review every existing unit manifest: collapse internal RPC leaves into semantic
   requests, classify resource scopes into evidence classes, delete unused/broad
   requests, rename `delegations` to `evalCeilings`.
9. Update invocation snapshots and the D12 promotion path to semantic vocabulary and
   the union-draft flow (§9).
10. Delete the source-rewriting generator and all startup/build mutation paths.
11. Require the new CI chain on protected main.

Each phase keeps runtime enforcement strict. Migration failures stop builds; they do
not fall back to inferred grants or old manifests.

## 15. Immediate stabilization boundary

Before the full redesign lands, the existing exact-RPC manifest system must still be
internally consistent so the app is usable:

- regenerate the reviewed service census from actual registered definitions;
- fail if that census is stale before unit inference runs;
- refresh explicit current manifests for the userland navigation transaction;
- verify fresh desktop onboarding, initial chat delivery, panel creation/navigation,
  extension readiness, and approval interaction;
- verify the same identity and connection contracts through mobile and CLI smoke paths.

These are current-contract repairs, not the target authoring model. They must not add
runtime auto-grants, manifest repair, wildcard requests, legacy entity repair, or
retries that conceal an authority mismatch.

## 16. Completion criteria

The plan is complete when:

- changing a method definition without reviewing its tier/capability/census fails
  immediately;
- every gated/critical requirement leaf is classified manifest-facing or
  closure-internal; closure-internal leaves are satisfiable only by
  closure-propagated invocations, and no closure leg ever runs under a substituted
  host principal;
- adding a gated or critical typed API call without editing the unit manifest fails
  before launch, and the failure identifies the semantic capability, resource evidence,
  and call path;
- code cannot reach authority its manifest does not request, even when static analysis
  cannot attribute the call — verified by confinement integrity tests;
- no dynamic dispatch contributes zero evident effect: unattributable use fails the
  build;
- a dependency package with no manifest route and no collaborator-passed reference to
  a capability cannot exercise it; cross-package capability flow occurs only through
  explicit module-boundary interfaces;
- critical operations appear as manifest requests, never as standing grants, and every
  exercise prompts;
- promotion drafts contain the full static closure, partitioned by observed/unexercised,
  in semantic vocabulary;
- normal builds never modify source manifests; adding a request never creates a grant;
- build identity binds the exact reviewed request set and endowment set;
- open and runtime-intrinsic operations do not pollute author manifests;
- generated ledgers cannot be stale while checks pass;
- all shipped desktop, mobile, CLI, and agentic-system paths pass with enforcement
  active.

## Consumer-declared workspace service protocols

The explicit manifest contains a second, non-authorizing collection:

```json
"serviceRequests": [
  { "protocol": "example.notes.v1", "availability": "required" }
]
```

This collection describes which stable protocols installed code may query. It
exists to build the consumer→protocol review index without a whole-workspace
TypeScript program. The compare-only build check remains mandatory and local:
every statically observed `resolveService()` query must be covered by the unit's
declaration, and the resulting proof is durable only for its exact analyzer
epoch and effective version.

Protocol declarations do not authorize providers. Admission records the exact
service name, provider unit, and catalog digest selected for each protocol;
runtime enforcement still checks the concrete `workspace-service:<name>`
manifest request and grant. A provider substitution changes that binding and
must be reviewed again. Missing optional providers are an availability result;
missing required providers are an activation/readiness error, never an
authority shortcut.
