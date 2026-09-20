# Holistic authority and capability static checking

Status: superseded as an implementation plan by
[Static checking for declared authority](authority-static-checking-scope.md),
2026-09-20. Retained as design history; its full runtime cutover is not the
accepted route to the static missing-capability goal.

## Decision

Extend Vibestudio's existing exact-state authority analysis into an operation
contract system that checks implementation behavior, transport admission,
resource scope, credential prerequisites, and consumer expectations together.
Use the existing TypeScript infrastructure and runtime authorization engine.
Do not introduce a second policy engine or infer grants from observed code.

Start with template publication as a complete vertical slice. Its existing-repo
versus create-repo distinction exposes the central problem: declarations can
agree with each other while all expressing the wrong requirement. A useful
checker must connect declarations to the operations actually performed, and
state exactly where that connection depends on trusted assumptions.

The deliverable is one canonical contract graph with several consumers: the
build checker, runtime admission and preflight, review UI, agent documentation,
and compatibility checks. Generated views may differ; authorization semantics
must not.

## Existing foundations and scope

This is an extension of substantial implemented infrastructure:

| Foundation                       | Existing implementation                                                             | What this plan adds                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Typed calls and method authority | `packages/shared/src/typedServiceClient.ts`, `serviceAuthority.ts`, service schemas | Executable operation prerequisites and implementation summaries           |
| Runtime enforcement              | `serviceDispatcher.ts`, `authorityRequirements.ts`, extension host                  | Contract conformance across routing and delegation                        |
| Exact provider contracts         | `src/server/buildV2/workspaceRpcCatalog.ts`                                         | Operation summaries sealed alongside method contracts                     |
| Consumer analysis                | `userlandAuthorityAnalyzer.ts`, `userlandAuthority.ts`, `authorityFold.ts`          | Effects, scopes, branch prerequisites and unresolved-boundary diagnostics |
| Incremental invalidation         | `authorityDependencyIndex.ts`, index manager, analysis cache and workers            | New semantic inputs in the existing epoch and dependency graph            |
| Host inference                   | `packages/unit-authority-inference` and generated host catalog                      | Shared operation semantics rather than an independent host rule set       |
| Review and drift gates           | Authority matrices, foundation ledgers, explicit manifests, userland RPC checks     | Behavioral conformance checks and independently specified negative cases  |

The exact-state plan in [userland-service-authority-static-validation-plan.md](userland-service-authority-static-validation-plan.md)
remains authoritative for immutable inputs, complete baselines, provider
revalidation, provenance, and atomic index promotion. Its historical gap section
must not be read as an inventory of today's implementation. This plan extends
its scope to implementation and external-operation semantics.

[isolation-plan.md](isolation-plan.md) remains canonical for execution isolation.
[authority-acquisition-spec.md](authority-acquisition-spec.md),
[authority-p1-enforcement-spec.md](authority-p1-enforcement-spec.md), and
[explicit-capability-manifest-plan.md](explicit-capability-manifest-plan.md)
remain canonical for acquisition, receiver enforcement, and explicit requests.
Static checking cannot confer OS access, turn a manifest into consent, or
supersede receiver-side authorization.

## Why the reported failures escaped

The observed incidents occupy different layers and need different guarantees:

| Incident                                                          | Static detection opportunity                                                    | Remaining runtime responsibility                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `upstreamStatus()` missing arguments                              | Validate agent code against exact typed call shape before execution             | Validate all incoming RPC arguments                              |
| Read-only status routed through write-classified `invokeProvider` | Link facade, router and exact selected provider contract                        | Resolve actual target and reject forbidden invocation            |
| Existing repository publication requires administration/write     | Derive prerequisites from the existing-repo operation, separately from creation | Check actual credential and repository access                    |
| Credential absence leaves destination UI broken                   | Exhaustive rendering of a typed preflight outcome                               | Determine current connected accounts and access                  |
| `$lastLargeReturn` treated as a different shape                   | Preserve typed result handles; diagnose unchecked unknown access                | Validate deserialized/untrusted results                          |
| Changed upstream between review and publish                       | Require a review receipt in the publishing call contract                        | Compare current remote commit and reviewed source before writing |

The authority census and generated golden matrices detect declaration drift;
they do not prove that handlers implement their declarations. Zod validates
wire shapes, not transitive authority behavior. TypeScript cannot recover facts
lost through `any`, arbitrary strings, opaque network calls, or an unsound cast.
A checker must report these gaps instead of presenting annotation consistency
as proof of semantic correctness.

## Guarantees and explicit limits

For an admitted, fully checked operation and exact dependency closure, establish:

1. Calls match the selected method's argument and result schemas.
2. Every reachable modeled effect is allowed by the operation's declared effect
   boundary, with the correct resource and principal scope.
3. Each reachable primitive's authority and credential prerequisites are
   accounted for on the branch where it executes.
4. Transport, facade and provider preserve the same method contract and target
   identity; a generic router does not silently widen or narrow admission.
5. Consumer explicit authority requests cover required code authority, without
   being interpreted as issued grants.
6. Contract-affecting source or provider changes invalidate all affected results
   before the new state becomes executable under a checked guarantee.

These are guarantees relative to a documented trusted primitive model and
checked language subset. They are not proofs of arbitrary JavaScript, external
service behavior, absence of malicious native code, or complete user intent.

Static checks cannot determine whether a PAT is currently valid, an organization
has approved it, a branch protection rule changed, or an approval was revoked.
They cannot infer the minimum GitHub permissions of arbitrary HTTP from first
principles. External adapter specifications and isolation are explicit trust
boundaries. Independent adapter conformance tests reduce this risk; repeating
an annotation in a generated test does not.

## Canonical semantic model

Extend the existing contract representation in place. Before designing new
syntax, inventory every current field and identify its canonical owner. Adopt
one normalized intermediate representation (IR) shared by the existing host and
userland analysis paths. The following are semantic dimensions, not a mandate
to add one independent annotation per row:

| Dimension               | Meaning                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Identity                | Exact artifact, service, method, operation variant and contract digest                              |
| Wire contract           | Arguments, result, typed failure outcomes and protocol version                                      |
| Observable effects      | Public state read/write, destructive change, external I/O, credential use, delegation               |
| Resource scope          | Workspace, receiver object, repository, branch, entity, or opaque handle selected from typed inputs |
| Principals              | Code, session, user, automation identity and permitted delegation relationship                      |
| Capability requirement  | Canonical capability definition and resource selector, including all/any composition                |
| Credential prerequisite | Provider operation and credential suitability, distinct from possession and consent                 |
| Preconditions           | State-dependent facts needed to execute or review safely                                            |
| Implementation evidence | Primitive calls, checked composition, source locations and trusted assumptions                      |

Keep `sensitivity` as the existing admission concept; do not mistake its ordered
labels for a complete effect algebra. A method can read public workspace state
while updating a private cache. The cache write must be represented as a private
implementation effect with bounded ownership, not mislabeled as no effect or
allowed to change public state. External requests may be reads yet still require
credential authority, network confinement and audit treatment.

Today's `access.requires` prose and human-readable conditional descriptions
cannot be executable policy. Replace enforcement-relevant prose with typed
predicates as each surface is migrated; derive explanatory text from these.
Retain free text only for explanation. Never parse prose to authorize actions.

### Branches and operation composition

Represent meaningful variants with discriminated inputs or distinct typed
operations. For publication, use an existing-repository operation and a
create-repository operation that compose shared release-writing primitives.
Do not route both through a resolve-or-create helper and then attempt to undo
its overbroad requirements in the UI.

Requirements follow branches. Sequencing accumulates requirements; alternatives
retain their discriminant and obligations. A runtime-selected alternative must
be resolved before consent when it changes requested authority. A conservative
analysis union is an upper bound for safety analysis, not automatically the
permission bundle presented to the user.

Prohibit effectful actions in preflight. Preflight may resolve a repository and
inspect access, but may not create it, change its permissions, or publish a tag.
The analyzed executable operation supplies both preflight requirements and
execution requirements. Sharing only a hand-written metadata object is not
sufficient evidence that the implementation obeys it.

Detect excess declared authority only where the primitive closure is complete.
Else report that minimality is unproven. Do not automatically remove or add
manifest authority: an intentional broader public contract requires explicit
review, and acquisition remains separate from implementation inference.

### Scopes, identities and delegation

Track resource selectors symbolically through checked parameters and opaque
handles. Reject accidental substitution of another workspace, repository,
receiver object, or branch. Do not coerce missing scope into a global wildcard.
Handle evidence must retain issuer/provider identity, resource identity, exact
contract binding and lifetime semantics; plain strings are not equivalent.

Analyze code and session requirements separately. Delegation cannot erase the
original subject, invent standing grants, or turn a read-only caller into a
write-authorized worker. The static rule describes the allowed transfer; runtime
attestation and receiver enforcement validate the actual chain.

Automation provisioning creates an automation definition, not ambient authority
for its future runs. Check watches and actions separately. Revalidate a stored
action when its source or provider contracts change, and acquire its runtime
authority for its actual execution identity. Preserve user pauses and revoked
authority through provisioning and upgrades.

## Checked primitives and the trusted boundary

Use small typed primitives for authority-bearing RPC, credential operations,
external provider calls, persistent mutations and delegation. Their contracts
are the leaves of the analysis graph. Compose checked operations from them.
Implementation analysis must reject unmodeled escapes from a claimed checked
operation, including raw network, raw privileged storage and unchecked generic
RPC paths. Ordinary computation need not be rewritten into a new framework.

Audit `authorityEffectBoundary.ts`: its current package-name exemption list is
a trust assumption, not implementation verification. Replace broad exemptions
with reviewed exported primitive boundaries bound to exact package artifacts.
Analyze non-boundary code inside those packages normally. Seal each boundary's
implementation digest, contract and owner into the existing build inputs.
Changing its bytes invalidates the associated proof and requires review.

Do not maintain a second allowlist that exempts failures. There may always be a
small trusted transport/native boundary, but every such boundary must have a
specific justification, bounded API, conformance tests and visible consumers.
Isolation prevents untrusted code from bypassing that API; static analysis alone
cannot provide that confinement.

For GitHub, model operations such as reading repository metadata, writing Git
objects/refs, and creating repositories. Derive the relevant credential
prerequisites from the adapter operation. Do not confuse repository `admin`
access reported for a user with credential administration scope. Handle token
families using their actual provider semantics, not a single synthetic scope
set that falsely equates OAuth and fine-grained PAT permissions.

Version external adapter assumptions, link their supporting provider docs, and
exercise them with controlled conformance fixtures. API evolution invalidates
assumptions operationally even when our source code has not changed.

## Analysis, linking and enforcement

### Local analysis

Extend the existing analyzer to produce provider-independent call facts plus
symbolic effects, scopes and branch predicates. Use resolved symbols and types,
not method-name regexes. Cover aliases, imports/re-exports, wrappers, callbacks,
async calls and dependencies. Bound interprocedural analysis to checked
composition; detect unsupported recursion or dynamic constructs explicitly.

Use `@vibestudio/typecheck` and its current TypeScript 7 AST/project abstractions.
Do not introduce an old `createProgram` integration or ts-morph dependency that
assumes a different compiler API. Persist serializable facts rather than compiler
objects, preserving the existing worker/cache architecture.

### Exact linking

Resolve facts against sealed catalogs for the candidate workspace state. Link
facade to router to selected provider to primitive summary. Known finite dynamic
sets may be checked exhaustively. An unconstrained target is unresolved, not
read-only, open, or safe by default. A typed protocol constrains the permitted
provider contract; installation must prove the selected implementation conforms.

Use the existing reverse dependency index to recheck unchanged consumers after
provider changes. Include implementation summaries, primitive model versions,
credential predicate versions and compiler/analyzer epochs in cache keys.
Retain complete-baseline and atomic-promotion requirements. Never combine a new
provider catalog with a stale consumer proof because compilation succeeded.

### Runtime agreement

Generate dispatcher admission, preflight requirement descriptions, agent-visible
signatures and UI result types from the same normalized contract. Receiver
checks remain mandatory and use live grants, session identity and actual target.
Generic routing must preserve the selected contract without becoming an
unconditional read entry point into write methods.

A review receipt binds operation variant, exact source snapshot, destination,
remote baseline and contract version. Publishing verifies the receipt and all
live permissions again. Credential identifiers can be bound without embedding
secrets. Revocation or changed remote state returns a typed recovery outcome;
it never silently widens authority or substitutes a different destination.

### Agent evaluation and generated code

Before executing an eval, typecheck and authority-check its exact program against
the current sealed API environment. Explain a missing argument or read/write
mismatch before guest execution. This is a front door to the same analyzer, not
a second agent-only authority implementation.

Keep large-return values behind typed handles or require explicit validated
decoding from `unknown`. `any` and casts must not erase authority evidence.
Arbitrary programs outside the checked subset receive an explicit unresolved
result and cannot execute through the checked path by toggling an effects flag.
Runtime sandboxing and existing approval policy remain necessary for all code.

## User experience derived from contracts

Expose a typed preflight outcome with at least ready, connection-required,
insufficient-access, incompatible-contract, changed-since-review and unavailable
states. Separate transient errors from capability denial. Require exhaustive
handling in UI and CLI adapters; provide shared components where practical.
Static exhaustiveness prevents missing branches, but usability still needs tests.

The publication screen should know the destination independently of whether an
account is connected. Show the account connection/repair action alongside that
destination, preserve the form and review selection, and refresh preflight after
connection. Explain why the review action is unavailable. A connection prompt
must describe the actual operation's required access, not request repository
creation authority for an existing-repository release.

Generate agent documentation and method discovery from the same call contracts,
including required arguments, returned shapes, effects and recovery outcomes.
Avoid tool errors containing only generic Zod union internals. Diagnostics should
name the operation, expected shape and relevant source call site.

## Compatibility and delivery across repositories

Treat schema/compiler compatibility as distinct from app semver. Seal the
contract format and analyzer epoch in build evidence. Declare required runtime
features through the existing workspace/template compatibility mechanism where
available; phase zero must identify its exact owner before adding fields.
Unsupported required features block activation with an actionable app upgrade
path. Do not silently reinterpret an old proof under a new checker.

Before app installation, evaluate installed workspace compatibility with the
candidate runtime. Before workspace activation, check the current app supports
its contracts. If coordination is needed, stage and validate both candidates,
retain the outgoing runnable state, and activate only a compatible pair. Never
require an unsafe intermediate state. Content merging remains an agentic task;
compatibility checking neither merges content nor grants authority.

Host and external templates ship independently. Test supported version pairs
and publish dependencies before dependents require them. No plan may assume
four Git repositories update atomically. Once an incompatible contract revision
is required, fail with a specific compatibility diagnosis, not a generic method
error. Existing compatible wire contracts need not change merely to add evidence.

## Diagnostics and gates

Each diagnostic should include a stable code, source span, operation and branch,
call chain, expected versus inferred effects/scopes, selected provider identity,
contract digest, and whether the conclusion is proven, conservative or unresolved.
Offer source fixes and explanations; never offer automatic permission grants.

Example diagnostics:

- `AUTH_EFFECT_MISMATCH`: read operation reaches a public ref write.
- `AUTH_SCOPE_MISMATCH`: capability for repository A used for repository B.
- `AUTH_PROVIDER_UNRESOLVED`: dynamic provider lacks a checked binding.
- `AUTH_PREREQUISITE_EXCESS`: existing-repo branch declares create authority
  despite a complete primitive summary requiring only existing-repo operations.
- `AUTH_CONTRACT_STALE`: provider or primitive evidence changed since analysis.
- `AUTH_UNMODELED_ESCAPE`: checked operation reaches raw privileged I/O.

Names are proposed; reuse existing diagnostics where their semantics match.

Run the same analysis engine at developer feedback, CI, protected-main candidate
validation and workspace/provider activation. Reuse exact-state caches, not a
weaker editor interpretation. CI checks generated contract drift and boundary
review evidence. Runtime remains fail-closed for unsupported or stale bindings.
Keep unresolved evidence visible during inventory; do not label an entire legacy
workspace verified merely because migrated entry points passed.

## Build versus adopt

Build the domain-specific IR and rules on the existing analyzer. Most needed
complexity is Vibestudio-specific: exact workspace state, code/session authority,
sealed providers, opaque resources, mutable userland code and delegated agents.
A generic policy language cannot discover those semantics from our handlers.

| Tool                                    | Useful role                                                     | Decision                                                                                             |
| --------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| TypeScript / existing typecheck package | Symbol/type resolution and typed contracts                      | Primary substrate; respect the installed TS7 API                                                     |
| typescript-eslint                       | Type-aware custom lint rules                                    | Reference or narrow editor integration; no mandatory lint-stack migration from Oxlint                |
| CodeQL                                  | Additional interprocedural/dataflow audits and escape discovery | Optional independent assurance, not activation authority                                             |
| TypeSpec                                | Contract authoring and generation                               | Reconsider only if replacing current contract authoring pays for migration; no parallel schema truth |
| Cedar / OPA                             | Policy evaluation and schema-aware policy validation            | Keep current runtime policy model; these do not prove handler behavior                               |
| Effect                                  | Explicit service requirements and typed composition             | Borrow the composition principle; no system-wide rewrite or claim of automatic authority proof       |

References: [typescript-eslint custom rules](https://typescript-eslint.io/developers/custom-rules/),
[CodeQL JavaScript dataflow](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/),
[TypeSpec extensions](https://typespec.io/docs/extending-typespec/create-decorators/),
[Cedar validation](https://docs.cedarpolicy.com/policies/validation.html),
[OPA policy language](https://www.openpolicyagent.org/docs/policy-language),
[Effect type](https://effect.website/docs/v3/getting-started/the-effect-type).
These document tool capabilities; the recommendation above is our architectural
judgment. The [TypeScript compiler API page](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
warns about compiler-version differences, reinforcing reuse of our TS7 abstraction.

## Implementation sequence and acceptance gates

### Phase 0 — Inventory and executable specification

Owner boundary: shared authority contracts, buildV2 and external adapter owners.
Inventory all admission/requirement sources, raw privileged APIs, provider routes,
trusted packages, UI preflights and automation execution paths. Mark what is
already checked, assumed, or unresolved. Map existing plan commitments to code.
Record independently specified incident fixtures before changing the analyzer.

Exit: one ownership map; no conflicting canonical field definitions; fixtures
reproduce the concrete gaps above; agreed trust boundary and effect semantics.
This phase must resolve the existing compatibility metadata ownership and exact
compiler extension API, not defer them into implementation surprises.

### Phase 1 — Publication vertical slice

Owner boundary: shared/service schemas, extension host, Base templates/git bridge,
workspace publication UI and CLI.
Implement normalized summaries and checked primitives for existing-repo review,
existing-repo publication and repository creation. Derive preflight requirements
from the analyzed branch; link provider dispatch; add receipt and outcome typing
to the graph. Reuse the publication review code already introduced.

Exit: mutating a read path into a write fails analysis; adding creation authority
to the existing-only branch is diagnosed; create branch still requires its true
prerequisites; read-only status works through the real router; UI handles absent
and inadequate credentials; review receipt invalidation is tested. No special
case keyed on the publication method's name exists in the generic analyzer.

### Phase 2 — Host/userland unification and trust reduction

Owner boundary: authority fold, inference package, RPC catalog and extension host.
Apply the same IR to host and userland methods. Replace trusted package-wide
exemptions with artifact-bound primitive summaries. Add scope/delegation checks,
finite dynamic linking and exact reverse invalidation. Remove redundant hand-
maintained requirement tables as each source is converted.

Exit: supported provider replacements revalidate consumers atomically; unknown
routes fail admission; dependency changes cannot reuse stale summaries; migrated
surfaces have no alternate permissive metadata path. Trust inventory shrinks to
reviewed primitive boundaries with tests and owners.

### Phase 3 — Agents, automations and all clients

Owner boundary: eval/typecheck pipeline, missions, worker runtime, UI and CLI.
Use exact contracts for eval checking, stored watch/action validation, typed result
handling, generated help and exhaustive recovery views. Check caller effects,
execution identity and delegation through the real runtime adapters.

Exit: original failing evals produce useful pre-execution diagnostics; default
update automation runs without ambient grants or a chat panel; changed provider
requirements invalidate affected actions before execution; approvals remain
operation-specific and revocable. Agentic integration tests exercise recovery.

### Phase 4 — Compatibility and release gates

Owner boundary: workspace activation, app installer/update coordinator and CI.
Add required evidence versions to existing compatibility checks, stage candidate
validation, and exercise independently released host/template combinations.
Remove superseded validators after parity is demonstrated; retain one authority
analysis engine with distinct presentation adapters.

Exit: incompatible app/workspace pairs cannot activate; prior runnable state is
retained when coordinated update fails; all authority-bearing production entry
points are either checked or explicitly listed as bounded trusted primitives.
No indefinite warning-only exceptions remain for claimed checked surfaces.

## Verification strategy

Use independently authored positive and negative fixtures plus mutation tests:

| Mutation or scenario                                            | Expected result                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Status handler calls public-state mutation through two wrappers | Effect mismatch with transitive call path                        |
| Existing-repo branch invokes creation helper                    | New authority requirement visible; branch contract rejected      |
| Primitive contract lies about raw API behavior                  | Not statically provable; trusted-boundary conformance test fails |
| Dependency re-exports a raw privileged API                      | Escape detected; no package-name exemption                       |
| Router selects an unknown or write-only provider                | Linking/admission failure, including read-only eval              |
| Provider keeps wire shape but changes scope/effect              | Consumer revalidation and changed evidence digest                |
| Handle from another workspace/receiver                          | Scope/identity rejection                                         |
| Grant revoked after successful preflight                        | Runtime denial with typed recovery; no remote mutation           |
| Remote main changes after review                                | Receipt rejected before publication                              |
| Private cache write inside read operation                       | Allowed only under modeled private ownership boundary            |
| Missing GitHub connection                                       | Stable destination and actionable connection state               |
| Unhandled preflight variant in UI/CLI                           | Typecheck failure                                                |
| Old template with unsupported required contract version         | Compatibility error before activation                            |
| Watch source/provider changes after provisioning                | Revalidation before the next run                                 |

Test the real service dispatcher and extension routing, not only mocks with
matching annotations. Pair static acceptance/rejection fixtures with runtime
conformance tests for the same operation. Add property tests for branch
composition, scope substitution and invalidation. Randomized graphs should
exercise dependency-index completeness and cycles.

Run focused unit/type checks first, then the smallest relevant managed agentic
system test, following repository doctor/inspect/cleanup instructions. Do not
create tests whose only assertion is that generated metadata equals its input.
Measure cold and incremental analysis with the native profiling workflow before
setting budgets; preserve worker isolation and existing analysis caches. Exact
proof inputs must never be omitted to improve a benchmark.

## Risks, checkpoints and completion

The largest risks are an overlarge trusted base, excessive false positives from
unbounded dynamic composition, and duplicated policy during migration. Resolve
these through small primitives, typed finite choices and immediate removal of
superseded definitions. Do not add a generic bypass flag, auto-grant fixer or
second fallback execution channel to make failing code pass.

Set quantitative latency and diagnostic-quality budgets after phase-zero
measurement. Track checked entry points, unresolved edges, trusted primitive
count, stale-proof mutation escapes, and independent conformance coverage.
A large count of declarations alone is not progress toward behavioral assurance.

Before phase two, review whether the publication slice expresses scope and
branch requirements without method-specific exceptions. If it cannot, redesign
the model before expanding coverage. Before rollout, review external-provider
assumptions separately from internal compiler soundness. Before declaring
completion, account for every authority-bearing escape and demonstrate provider
change invalidation across a real installed workspace.

Completion means that the reported classes of mismatch are caught at their
appropriate boundaries with useful explanations, and that the remaining trusted
and live-state assumptions are explicit. It does not mean claiming static proof
of external permissions or removing runtime security checks.
