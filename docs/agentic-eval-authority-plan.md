# Agentic Eval Authority — Dynamic Manifests, Delegation, and Approval

Status: implemented 2026-07-15. Direct live-host CLI smoke covers adaptive
activation, strict containment, pregranted-only failure, dynamic approval,
exact-manifest success, and cooperative cancellation with terminal cleanup.
Exact Spark and Luna headless runs reached the selected live providers but
neither provider returned a model response; that external validation blocker is
recorded separately from the passing eval authority path.

Compatibility policy: this is a pre-release clean cut. The eval wire contract,
authority records, generated manifests, clients, agent tool, development-host
bridge, tests, and documentation change together. The replaced `eval.run` /
`eval.startRun` split, ambient `product/eval` authority, top-level `readOnly`
flag, and approval paths are deleted in the same tranche. There is no legacy
reader, fallback token, compatibility overload, or second authorization path.

Related:

- [`runtime-foundations-refactor-plan.md`](runtime-foundations-refactor-plan.md),
  especially R3's compositional authority model;
- [`in-workspace-self-development-plan.md`](in-workspace-self-development-plan.md),
  especially section 12's child-host direct eval path;
- [`approvals.md`](approvals.md);
- [`capability-approval-design.md`](capability-approval-design.md);
- [`permission-system.md`](permission-system.md).

## 0. Decision

Agentic eval is a first-class execution surface, not a narrow escape hatch. A
normal System Agent eval must be able to attempt any operation deliberately
exposed to code: filesystem and VCS work, builds, panels, workers and durable
objects, browser/CDP work, userland services, imports, and direct WorkspaceDO
RPC. It must not fail merely because static source analysis could not predict
which method an arbitrary snippet would call.

That guarantee does not require ambient privilege. It requires a different
authority model for dynamic code:

1. Every eval run has a host-resolved **Eval Authority Manifest**.
2. The manifest has an immutable, verified delegation ceiling and either an
   adaptive or strict activation policy.
3. Adaptive mode activates a capability when the code first uses it. If the
   operation is within the ceiling and already granted, execution continues. If
   it is approvable, the run suspends, asks the user, and resumes. Absence from
   a statically inferred direct-call list is not an error.
4. Strict mode is available for deliberately constrained evals and fails with a
   structured authority error when code exceeds the exact declared envelope.
5. Effective authority is the intersection of the eval executor, initiating
   code, verified delegation, per-run manifest, applicable grants, live
   relationships, and effect constraints, minus denials. No participant lends
   the union of its privileges to another.
6. The same contract applies on the main host and an isolated development host.
   A child approval is brokered to the current host's normal approval UI and
   resolved back on the child; it never waits invisibly in a headless child.
7. Execution durability stops at the active EvalDO incarnation. Agent/tool
   callers are asynchronous and may hibernate, but the EvalDO deliberately stays
   resident while evaluated JavaScript is running or awaiting a challenge. The
   JavaScript continuation is ordinary in-memory state, not a replayable durable
   workflow. Process loss interrupts the run; the runtime never re-executes the
   snippet automatically.

The default agent-tool experience is `adaptive + mutable + prompt`. This
preserves today's core UX: eval can do useful work throughout the system, and a
sensitive operation can enter a visible approval flow instead of crashing into
an unexplained manifest denial.

Hard failure remains correct in four explicit cases:

- the target is not exposed to code at all;
- a live ownership, membership, role, audience, or other relationship fails;
- the user denied or revoked the operation; or
- the caller deliberately selected strict, read-only, or pregranted-only
  containment and the operation exceeds it.

An active run may also end as `interrupted` when its EvalDO, workerd process,
host process, or required child generation is lost. This is a lifecycle failure,
not an authority denial. Prior snippet effects may already have happened, so
automatic replay is forbidden.

## 1. Current implementation and the precise gap

The current main-host eval is broad and operational, but its authority is too
coarse.

### 1.1 What works today

[`scripts/generate-runtime-foundation-ledgers.mjs`](../scripts/generate-runtime-foundation-ledgers.mjs)
builds `product/eval`'s requested capability list from every authority-ledger
row that admits the `code` principal. The generated product catalog therefore
gives the EvalDO exact entries for the current code-callable host-service and
direct-RPC census, plus the supported userland services. A new catalog method
must be regenerated and reviewed, and stale generated state fails CI.

Consequently, ordinary eval does not currently fail just because a service call
was not visible in the snippet. The runtime's dynamic `services.<name>.<method>`
proxy and raw `rpc.call(...)` still reach the canonical dispatcher, but the
EvalDO's generated manifest already requested the current method.

Sensitive service operations may then use the existing capability approval
queue and grant store. Main-host agent eval also uses a durable asynchronous
run path so a hibernating agent need not hold its original tool invocation open.

The EvalDO already distinguishes caller durability from execution durability:
its active/in-flight guard prevents its own eviction alarm from evicting a live
run, and an in-progress Durable Object request/await is not hibernatable. Current
startup reconciliation marks a formerly running row interrupted rather than
replaying it. This plan preserves that simple boundary instead of introducing a
workflow engine for arbitrary JavaScript.

### 1.2 What is wrong today

The same mechanism creates these architectural and UX gaps:

1. **The snippet has no run authority identity.** Outbound calls are attributed
   primarily to the fixed `product/eval` artifact. The snippet, its authority
   intent, and its initiating agent code are not one verified invocation chain.
2. **The broad executor manifest is ambient.** The generated product catalog is
   both the EvalDO's implementation ceiling and the practical answer to dynamic
   code discovery. There is no per-run attenuation.
3. **Delegation is not carried.** The server authority context currently
   constructs `delegation: []`; the EvalDO does not preserve a verified
   initiating-code/delegation chain on every outbound call.
4. **Missing-manifest and missing-grant are terminal dispatcher errors.** The
   pure authority evaluator correctly returns `not-requested` or
   `missing-grant`, but only service-specific helpers know how to turn selected
   missing grants into approvals. There is no general eval authority broker.
5. **Child-host approval is stranded.** The dev-host extension calls the
   child's `eval.run` through a paired direct client, but it does not broker the
   child's approval queue. A sensitive eval in a headless child can wait or time
   out with no actionable prompt on the current host.
6. **Source identity is not execution identity.** Context paths can be resolved
   separately from the bytes later executed, and retained modules/functions do
   not contribute explicit provenance to a later run digest. A path or old scope
   definition can therefore escape the source identity shown in audit.
7. **The existing authority algebra has one code-manifest slot.** Merely adding
   executor, invocation, initiator, and acting-user principals would make
   alternative requirement branches behave like a privilege union unless the
   authorizing origin and delegation chain become explicit.
8. **Execution scheduling and cancellation are implicit.** One object-wide
   promise chain serializes work, while timeout/cancel behavior is effective at
   await points but cannot preempt non-yielding JavaScript. Reset must not create
   an orphaned parallel path around that limitation.
9. **Acquisition cannot be classified only per method.** Existing methods may
   carry primary, additional, and conditional capability leaves with different
   approval policy. One method-level label loses that distinction.
10. **The queue already carries more than capability approval.** Credential,
    device-code, and provider/userland interactions need one typed challenge
    transport, while remaining semantically distinct from authority grants.

Interrupted-on-process-loss behavior is not a gap. The desired design makes it
explicit and deletes any implication that arbitrary JavaScript should resume
after restart.

The wire schema in
[`packages/service-schemas/src/eval.ts`](../packages/service-schemas/src/eval.ts)
also has no authority-manifest or preauthorization input. Its `readOnly` boolean
only expresses one containment dimension. The development-host schema accepts
only `{launchId, code}`.

### 1.3 Why static inference cannot solve eval

Static authority inference is appropriate for a built panel, worker, app, or
extension. Its exact artifact has a reviewable source closure. Arbitrary eval is
different by construction:

- code is often generated after the initiating artifact was built;
- method names may be computed;
- rich clients, dynamic service proxies, and raw RPC are intentional features;
- imported code may choose calls after observing runtime state; and
- an agent may use one eval to inspect, decide, mutate, and verify across
  unrelated service domains.

Teaching the static scanner more syntax can improve ordinary unit manifests,
but it can never make an arbitrary runtime program statically closed. Treating
scanner misses as a production denial would make agentic eval unreliable. Giving
the eval artifact an unconstrained wildcard would hide the problem by making
every run ambiently powerful. The target design instead makes dynamic selection
an explicit property of a bounded per-run manifest.

## 2. Goals and non-goals

### 2.1 Goals

- Preserve broad, low-friction agentic eval as the default System Agent
  workflow.
- Make every outbound eval call attributable to an exact executor, exact
  initiating code artifact when code-originated (or another verified sponsor),
  run source digest, owner/context, and authority manifest.
- Support adaptive activation, exact strict manifests, read-only containment,
  pregranted-only automation, and up-front preauthorization through one model.
- Dynamically prompt for approvable capabilities and resume the exact suspended
  call after a decision while the active EvalDO incarnation remains alive.
- Apply identical authority, error, audit, revocation, and approval semantics to
  host-service and direct WorkspaceDO RPC.
- Make isolated-host eval behavior indistinguishable from main-host eval except
  for its explicit host/generation identity.
- Keep capability discovery and failures legible to an agent without exposing
  secrets or requiring knowledge of internal service implementation.
- Default new service/RPC methods to unavailable to eval until their code
  exposure and approval behavior are classified.
- Delete the current dual sync/async eval substrate and service-local shadow
  approval logic after the unified path is live.

### 2.2 Non-goals

- Granting code access to host-only or human-only administration merely because
  the call originated from eval.
- Treating eval as an OS security sandbox. UnsafeEval containment and authority
  mediation limit Vibestudio APIs; they do not make intentionally hostile native
  same-user code safe.
- Letting an agent mint grants, choose its own verified principal, or approve
  its own pending request.
- Inferring a complete dynamic manifest from source text.
- Replacing ownership, workspace membership, agent binding, channel policy, or
  credential policy with capabilities.
- Adding an eval-specific authorization evaluator. Eval uses the one runtime
  foundations algebra and one canonical method registry.
- Prompting for a method that the product has classified as non-code or
  non-delegable. Approval cannot turn a closed surface into a public one.
- Serializing, checkpointing, or replaying arbitrary JavaScript continuations.
  Eval persistence makes handles, status, immutable source/provenance bundles,
  scope/data, results, idempotency, grants, bounded events, and audit durable; it
  does not make in-flight UnsafeEval execution restartable.

## 3. Non-negotiable UX and security invariants

1. **Adaptive is the normal agent default.** A System Agent using `eval` without
   an authority override gets adaptive, mutable, prompt-capable execution within
   its verified agentic-eval delegation ceiling.
2. **No scanner-shaped failures.** An adaptive run never returns
   `not-requested` merely because the initiating artifact did not contain a
   literal call to the eventual method.
3. **Requests are not grants.** Runtime activation states what the run wants;
   it never authorizes the operation by itself.
4. **The ceiling is immutable.** A run may activate entries inside its resolved
   ceiling, but code cannot expand the ceiling, effect policy, owner, context,
   audience, or approval policy.
5. **Authority intersects.** Executor capability, initiator delegation,
   invocation activation, grants, relationships, and effects must all permit the
   call. Authority from different principals is never unioned.
6. **Approvals resume live work.** An approvable miss suspends the exact
   operation in the active EvalDO, deduplicates repeat publication for that
   dispatch, and continues or rejects that same operation after resolution. The
   agent need not rerun the whole snippet while that incarnation remains alive.
7. **Closed means closed.** Code-excluded methods, invalid relationships,
   explicit denials, wrong audience, wrong generation, and stale/replayed tokens
   fail without offering a misleading approval.
8. **Read-only covers both planes.** A read-only run cannot mutate through a
   direct RPC, rich facade, dynamic service proxy, userland service, import
   helper, or a method lacking a declared sensitivity.
9. **Revocation is live.** Grant, delegation, membership, ownership, and deny
   changes apply at the next outbound dispatch, including after an idle
   terminal EvalDO cold-rehydrates or a child approval route reconnects.
10. **Scope does not retain authority.** Values and functions may persist in the
    REPL scope, but a later invocation executes every outbound call under the
    later invocation's authority—not the run that created the value.
11. **Child prompts are visible here.** A child-host run cannot enter a
    challenge wait unless the current host has accepted and can render its
    challenge, or another authenticated child approval surface is active.
12. **One catalog, one challenge path.** Method reachability, resource
    derivation, additional capabilities, sensitivity, approval copy, and grant
    scopes come from canonical declarations consumed by both RPC planes.
13. **One authorizing origin.** An eval dispatch authorizes only through its
    invocation-code branch. Acting user, entity, device, owner, and workspace
    facts may satisfy named relationships, but their grants are never alternate
    branches for a code-originated call.
14. **Hashed source is executed source.** Context-file and import closures are
    materialized into immutable content before `runDigest` is finalized. EvalDO
    executes that exact bundle and never re-reads a mutable path behind a digest.
15. **Persistent executable state has provenance.** A later run may invoke a
    function or module retained from an earlier run, but the later run's
    execution-provenance digest includes every executable definition visible in
    its scope/module snapshot. Approval and audit UI identify both the current
    source and retained-code provenance.
16. **Active execution is incarnation-local.** Active EvalDOs do not idle-evict.
    Host/workerd/EvalDO loss marks the run interrupted, invalidates its
    credential, cancels its live challenges, and never reconstructs or replays
    its JavaScript continuation.
17. **Adaptive state is bounded.** Activations, challenges, events, authority
    detail, and retained diagnostics have host-defined per-run limits. Dynamic
    code cannot create an unbounded authority ledger or approval storm.
18. **Deputies get no token.** A worker, DO, panel, subagent, or nested eval
    created by a run receives its own exact identity and an explicit attenuated
    delegation or no authority. The parent invocation credential is never
    exposed or inherited.

## 4. Canonical capability-leaf classification

Eval acquisition policy belongs to each code-capability leaf in the normalized
method requirement graph, not to the method as a whole. A method can require a
baseline primary capability, an approval-classified additional network
capability, and a conditional closed capability in different branches. The
canonical declaration therefore normalizes primary, additional, and conditional
requirements into exact leaves:

```ts
type EvalCapabilityAcquisition =
  | { kind: "baseline" }
  | { kind: "approval"; approval: ApprovalDescriptor }
  | { kind: "closed"; reason: string };

type EvalCapabilityLeaf = {
  capability: string;
  resource: CanonicalResourceDerivation;
  acquisition: EvalCapabilityAcquisition;
};
```

A method-level `evalClosed` is permitted only as shorthand that closes every
code-capability leaf. There is no method-level baseline or approval shorthand.
This metadata is not a second authority rule. It says how an invocation-code
origin may satisfy that exact existing leaf:

- `baseline` permits activation without a human prompt when the rest of the
  authority intersection succeeds;
- `approval` permits adaptive or up-front challenge flow when the verified
  initiator lacks a covering reusable grant; and
- `closed` means eval cannot acquire that leaf. A branch that excludes `code`
  is necessarily closed to an eval dispatch even if its metadata is wrong.

The schema generator rejects:

- a code-excluded leaf marked baseline or approval;
- an approval leaf without canonical resource derivation, copy, severity, and
  allowed reusable scopes;
- any unclassified code-capability leaf after requirement normalization;
- approval metadata for a capability absent from the normalized graph;
- a code-exposed method with unknown sensitivity; and
- inconsistent classifications of the same normalized leaf on the two RPC
  planes.

`MethodAuthorityDescriptor.additional` and the conditional requirement graph
are the only declarations for additional capabilities such as network,
notification, credential, or publish authority. Existing service-local
`withCapability` calls move into those declarations. The dispatcher/gateway
mediates every selected leaf before handler entry. Handlers still validate
domain state, but do not keep a second capability grant check or prompt path.

Argument-only resource derivation remains pure schema data. A method whose
canonical resource, selected conditional branch, diff, or review copy depends
on authoritative state declares a schema-owned preparation resolver ID. The
owning service registers one side-effect-free resolver that runs after argument
validation and before authority evaluation. It may read authoritative state and
return only the canonical operation, selected requirement leaves, resources,
and review descriptor; it may not mutate, prompt, or authorize. Registration
and census tests require every resolver reference to exist on each runtime plane
where the method is callable.

The capability broker does not absorb non-capability domain interactions.
Credential or secret input, device-code authorization, provider-owned userland
questions, and similar typed user interactions share the challenge transport
and queue described in section 9, but retain their own validation and resolution
semantics. A capability grant never stands in for supplying a credential or
answering a domain question.

The generated eval exposure ledger contains exact `(method, capability,
resource derivation, acquisition)` leaves—never a wildcard or implicit default.
Adding or changing a service/direct-RPC method makes the ledger and generated
delegation manifests stale until every normalized code leaf is classified and
tested.

The first ledger transcription preserves behavior leaf by leaf. Capabilities a
current main-host eval can use without a prompt are baseline; capabilities that
currently enter approval retain equivalent review copy and reusable scope;
code-excluded leaves remain closed. Tightening an already code-callable leaf is
a separately enumerated product-policy change, not an incidental consequence of
installing this substrate.

## 5. Built-unit delegation manifests

Direct calls and delegated eval calls are different authority uses and must be
declared separately. Extend the immutable unit authority manifest:

```ts
interface UnitAuthorityManifest {
  requests: readonly CapabilityScope[];
  delegations: readonly {
    audience: "eval";
    purpose: "agentic-code-execution" | "tool-eval" | "test-eval";
    capabilities: readonly CapabilityScopeTemplate[];
  }[];
}

type ResolvedDelegationScope =
  | { kind: "resource"; scope: CapabilityScope }
  | {
      kind: "relationship";
      capability: string;
      relationship: "workspace-resource" | "context-resource" | "owned-entity" | "bound-channel";
      anchor: string;
    };
```

`requests` remains the exact envelope for calls performed directly by the unit.
`delegations` is the maximum authority the exact unit artifact may ask the host
to exercise through an eval invocation. Declaring a delegation still grants
nothing. At activation, the declaration intersects the ordinary grants for that
exact initiating artifact. A baseline capability is usable only when that
initiator grant already exists; an approval-classified capability may acquire
the missing initiator grant through the dynamic approval flow. Only then does
the host derive a run-scoped verified delegation whose issuer is the initiating
code and whose subject is the exact eval invocation principal.

`CapabilityScopeTemplate` supports the existing exact/prefix/origin/domain/
network scopes plus relational templates such as the caller's current
workspace, context, owned entity, or bound channel. At `eval.start`, the host
resolves every caller-independent anchor (for example the exact workspace or
context ID) into an immutable `ResolvedDelegationScope`. It does **not** expand a
relationship into a snapshot list of currently existing child resources.

At each dispatch, the authority evaluator tests the target resource's live
membership or ownership under that immutable anchor. This lets a run operate on
a resource created later inside its already-delegated workspace without
mutating its ceiling, and makes loss or movement out of that relationship fail
immediately. Relational scopes are ceiling/delegation predicates only; reusable
grants remain concrete canonical resource scopes. Code never supplies an
anchor, resolved workspace, owner, or membership fact.

The System Agent and other first-class agent workers receive an exact generated
`agentic-code-execution` delegation list covering every currently reviewed
eval-baseline and eval-approval capability. This list is intentionally broad and
reviewable. It is not inferred from snippet text. When the method census changes,
the generated list changes visibly and CI requires classification. Ordinary
panels, apps, extensions, and specialized workers receive only the delegation
entries their product role declares.

The product seed catalog grants the reviewed baseline portion of that delegation
list to the exact first-class agent artifacts. Approval-classified entries remain
requestable but ungranted until the user chooses a scope. Non-product units enter
the ordinary unit-manifest approval flow for baseline delegation grants. A newly
added capability is not inherited from an older broad grant merely because a
generated delegation list expanded.

A unit with permission to call `eval.start` but no matching eval delegation may
run a computation-only snippet and use EvalDO-local scope/database features. It
cannot use Vibestudio service or direct-RPC capabilities. This separates “may
execute code” from “may delegate system authority to that code.”

### 5.1 Interactive and host sponsors

Not every legitimate eval begins in built userland code. A CLI or shell may be
an authenticated interactive user/device call, and a sealed product workflow may
start a host-sponsored diagnostic. The resolved initiator is therefore
discriminated:

```ts
type VerifiedEvalInitiator =
  | {
      kind: "code";
      principal: ExactCodePrincipal;
      delegationSource:
        | {
            kind: "unit";
            declaration: UnitAuthorityManifest["delegations"][number];
          }
        | {
            kind: "eval-invocation";
            parentRunId: string;
            remainingCeiling: readonly ResolvedDelegationScope[];
          };
    }
  | {
      kind: "interactive-user";
      principal: UserPrincipal;
      device: DevicePrincipal | null;
      policyRevision: string;
    }
  | {
      kind: "host";
      principal: HostPrincipal;
      purpose: string;
      bootManifestDigest: Sha256;
    };
```

Interactive-user ceilings come from live workspace role, device ownership, and
the reviewed interactive-eval policy—not from a client-provided manifest. Their
reusable grant choices are limited to bindings meaningful for that verified
principal/session; a “Trust Version” choice is available only when an exact
client code artifact is also attested. Host-sponsored eval is available only to
sealed product call sites whose boot manifest declares the purpose, defaults to
strict/pregranted-only, and never turns an untrusted request into host authority.

Regardless of sponsor, evaluated outbound calls use the invocation's `code`
principal. Acting-user or host sponsorship can supply a verified delegation and
live relationships, but it cannot call a user-only or host-only method that does
not admit code. This retains CLI/shell ergonomics without laundering human or
host authority through eval.

If `eval.start` itself is classified as available to eval, a nested run uses the
current invocation principal as its code initiator. Its ceiling is an attenuation
of the parent run's remaining ceiling and delegation chain; it never reselects
the original unit's broad agentic profile. The host appends and verifies the new
delegation edge, enforces a bounded nesting depth for resource control, and
invalidates descendants when an ancestor run/delegation is cancelled or revoked.

## 6. Per-run Eval Authority Manifest

The public start request accepts an authority intent. The server resolves it
against authenticated caller facts. Caller input is an attenuation request, not
an authority record.

```ts
type EvalAuthorityIntent = {
  mode?: "adaptive" | "strict";
  effects?: "read-only" | "mutable";
  approvals?: "prompt" | "pregranted-only";
  requests?: readonly CapabilityScope[];
  preauthorize?: readonly EvalPreauthorizationIntent[];
};

type EvalPreauthorizationIntent =
  | { plane: "host-service"; method: string; args: readonly unknown[] }
  | {
      plane: "workspace-do";
      target: VerifiedHandleInput;
      method: string;
      args: readonly unknown[];
    };

type ResolvedEvalAuthorityManifest = {
  version: 1;
  runId: string;
  startIntentDigest: Sha256;
  sourceDigest: Sha256;
  executionProvenanceDigest: Sha256;
  scopeInputRevision: string;
  scopeProvenanceDigest: Sha256;
  runDigest: Sha256;
  invocationPrincipal: ExactCodePrincipal;
  executor: ExactCodePrincipal;
  initiator: VerifiedEvalInitiator;
  ownerEntity: EntityPrincipal;
  contextId: string;
  audience: string;
  purpose: string;
  mode: "adaptive" | "strict";
  effects: "read-only" | "mutable";
  approvals: "prompt" | "pregranted-only";
  ceiling: readonly ResolvedDelegationScope[];
  initiallyActive: readonly CapabilityScope[];
  createdAt: number;
  maxEndsAt: number | null;
  limits: {
    maxActivations: number;
    maxChallenges: number;
    maxPendingChallenges: number;
    maxEvents: number;
    maxAuthorityDetailBytes: number;
    maxRunOwnedResources: number;
  };
};
```

The host performs one ordered start transaction and preparation pipeline:

1. Authenticate and authorize `eval.start`, resolve the exact code initiator or
   verified interactive/host sponsor, owner/context/scope key, live incarnation,
   delegation declaration, and requested attenuation. Normalize mode, effects,
   approval policy, and reset legality before any destructive preparation step.
2. Normalize all public input and compute `startIntentDigest` from the source
   reference or inline bytes, import specs, authority intent, scope target,
   deadline, initiator, and executor. It intentionally precedes path reads.
3. Reserve the idempotency tuple `(exact initiator, owner/context, scope key,
idempotencyKey)`. The same tuple and digest returns the existing handle; the
   same tuple with a different digest returns `EVAL_IDEMPOTENCY_CONFLICT`.
4. Persist the accepted run handle/status and return it asynchronously. Enqueue
   the run on the owner/subcontext scope scheduler; do not execute preparation
   or JavaScript concurrently with another run holding that scope lease.
5. At the queue head, perform a requested `scope.reset` exactly once under its
   canonical destructive capability and the exclusive scope lease, then capture
   `scopeInputRevision` and executable provenance. Derive a short-lived
   preparation-code principal from `startIntentDigest`, attenuated to only the
   source/import/build leaves in the verified eval delegation.
6. Materialize inline/context-file source and the exact transitive import/build
   closure through that preparation principal and the contract below. Store the
   immutable bundle in content-addressed storage and compute `sourceDigest` from
   those bytes, not from mutable paths; then invalidate the preparation lease.
7. Resolve immutable delegation anchors, intersect the requested ceiling with
   initiator policy, validate strict requests and preauthorization intents, and
   install host-defined resource limits.
8. Combine the new bundle with retained executable definitions to produce
   `scopeProvenanceDigest` and `executionProvenanceDigest`.
9. Hash all resolved identity, source, provenance, owner/context, delegation,
   effect, approval, limit, and idempotent-run fields into `runDigest`, then
   derive `code:eval/<initiator>/<scope>@<runDigest>`.
10. Store the invocation record and mint a short-lived, audience-bound lease for
    only the selected EvalDO object and run. EvalDO verifies the captured scope
    revision and executes the exact content-addressed bundle.

This ordering makes the accepted handle idempotent without pretending a mutable
path is already source identity. A queued run whose scope input revision no
longer matches is re-prepared from the new queue-head snapshot before any code
runs; it is never silently attached to a different scope under an old digest.

### 6.1 Source materialization and persistent-scope provenance

Source preparation is not performed with the future invocation credential, the
initiator's direct `requests` envelope, or ambient EvalDO authority. The host
derives an exact preparation-code principal whose identity binds
`startIntentDigest`, initiator, owner/context/scope, executor, and a ceiling
containing only the source/import/build leaves selected from the initiator's
verified **eval delegation**. It carries a short live lease accepted only by the
source materializer and is invalidated before the final invocation lease exists.

The materializer dispatches each prerequisite through the ordinary canonical
evaluator/gateway with the preparation principal as code origin and the same
initiator-rooted delegation chain described in section 7. Each operation gets
normal resource derivation, initiator grants, relationships, effects, and typed
challenges. This is a phase-specific attenuation within the one authority
algebra, not a second authorization path. Inline source requires no filesystem
grant.

Preparation is side-effect-free except for deterministic build/CAS artifacts;
it cannot call arbitrary services. A missing prerequisite may put the run in a
live `awaiting-preparation-challenge` state, but there is no JavaScript
continuation yet. Host or process loss interrupts the run rather than replaying
the preparation pipeline. The materializer records every file, generated module,
resolver version, and import edge in the immutable source bundle. EvalDO never
re-reads a context path or resolves a floating import during execution.

Persistent eval scope creates a second source input. Each serializable function,
module facade, or executable definition retained across runs carries the CAS
digest and definition provenance that created it. At run start, EvalDO freezes
the visible executable-provenance index; the run digest and approval/audit copy
cover both current source and retained definitions. Ordinary persisted data is
not hashed merely because code reads it, but mutations to the executable scope
namespace advance its revision.

The provenance index and retained executable payload count against explicit
per-scope entry/byte quotas. A run cannot evade per-run authority-detail limits
by storing an ever-growing chain of executable definitions in persistent scope.

Retained functions and facades are run-neutral. When invoked, they resolve the
currently active run execution context and current credential; they never close
over a prior token, authority client, initiator, or owner. Every subscription,
callback, task, and async child created by a run is registered as run-owned and
is cancelled or detached at terminal state. No callback may dispatch after its
creating run is terminal.

A preauthorization item names the intended canonical call shape, not a
caller-authored capability, resource label, prompt, or severity. The schema and
preparation resolver validate its arguments/target and derive exactly the same
requirement leaves, resources, relationships, and review descriptor that real
dispatch will use. Preauthorization performs no handler side effects. The
eventual call derives and reevaluates everything again. A reusable approval
creates an ordinary initiator grant; a run-only approval creates an ephemeral
run permit as defined in section 7.

The caller cannot submit `invocationPrincipal`, `executor`, `initiator`,
`ownerEntity`, `contextId`, `ceiling`, `audience`, `runDigest`, or a reusable
grant. Host-only attached session targeting remains possible through a separate
verified target form; it does not overload userland fields with privileged owner
overrides.

### 6.2 Adaptive mode

An adaptive manifest contains an immutable ceiling and an append-only activation
ledger. The ledger is dynamic; the manifest policy is not.

On the first attempted use of a capability/resource pair:

1. the gateway derives the canonical resource from validated arguments and
   authoritative records;
2. it verifies that the pair is covered by the resolved ceiling;
3. it records an idempotent activation event;
4. it evaluates the complete authority intersection;
5. baseline authority continues immediately;
6. an approvable missing grant suspends and asks, unless the run is
   pregranted-only; and
7. every other failure returns a structured terminal error for that call.

Activation is not persisted as a reusable grant and does not affect another run.
It exists in bounded run metadata for audit, diagnostics, and the run's
effective-manifest summary. Reaching an activation or challenge limit returns
`EVAL_RESOURCE_LIMIT`; the broker does not evict older authority facts to make
room for a new request.

### 6.3 Strict mode

Strict mode's `requests` are resolved and activated before code starts. Every
outbound call must be covered by that exact set. A miss returns
`EVAL_AUTHORITY_CONSTRAINT`; it never silently expands and never prompts to
change the manifest. Strict mode is appropriate for tests, scheduled
automation, untrusted delegated tasks, and reproducible tools.

Strict does not mean preapproved. With `approvals: "prompt"`, start may obtain
approval for declared requests up front or a declared resource encountered at
runtime. With `approvals: "pregranted-only"`, any missing grant fails before the
operation.

### 6.4 Effects

`effects: "read-only"` replaces the top-level `readOnly` boolean. It is enforced
from the canonical method sensitivity on both RPC planes before handler entry.
Only methods explicitly marked `read` may execute. Unknown sensitivity is
mutating by default and is blocked. `scope.reset`, `eval.reset`, and
`eval.forceReset` are destructive leaves and cannot be hidden inside a read-only
start.

`effects: "mutable"` permits methods of every declared sensitivity, subject to
the rest of the authority and approval model. It does not preapprove writes,
administration, or destructive actions.

### 6.5 Approval policy

`approvals: "prompt"` means an `approval`-classified capability can suspend the
run and enter the challenge broker; explicit `preauthorize` items are valid only
in this mode and are reviewed before JavaScript starts. `pregranted-only` is a
deterministic non-interactive mode: existing reusable grants may satisfy the
call, but no start-time or runtime prompt is created and `preauthorize` input is
rejected. A miss returns a structured canonical grant intent so an orchestrator
can obtain authority through the ordinary external Permissions flow and retry
deliberately.

## 7. Effective authority and principal chain

The current singular `codeManifest` field is insufficient, but adding more code
principals to the context must not turn `anyOf` into a privilege union. Replace
it with an explicit authorizing origin plus a code authority chain:

```ts
type AuthorizationOrigin =
  | { kind: "code"; principal: ExactCodePrincipal }
  | { kind: "user"; principal: UserPrincipal }
  | { kind: "host"; principal: HostPrincipal };

type CodeAuthorityChain = {
  executor: {
    principal: ExactCodePrincipal;
    manifest: UnitAuthorityManifest;
  };
  execution:
    | {
        phase: "preparation";
        principal: ExactCodePrincipal;
        startIntentDigest: Sha256;
        ceiling: readonly ResolvedDelegationScope[];
      }
    | {
        phase: "run";
        principal: ExactCodePrincipal;
        runId: string;
        runDigest: Sha256;
        manifest: ResolvedEvalAuthorityManifest;
      }
    | null;
  initiator: VerifiedEvalInitiator | null;
  delegations: readonly VerifiedDelegation[];
};

type AuthorizationContext = {
  authorizingOrigin: AuthorizationOrigin;
  codeAuthority: CodeAuthorityChain;
  // Acting user, device, entity, owner, workspace, session, and relationship
  // facts remain separate authenticated facts.
};
```

Ordinary built-code calls use the exact built artifact as code origin and
executor, with no delegated execution entry. Final eval calls use the invocation
principal as the sole authorizing code origin; source preparation calls use the
start-intent-bound preparation principal in the same role. Both carry executor,
initiator, and delegation roles in the chain. Acting user, device, entity,
owner, workspace, and session facts can satisfy named relationship predicates;
their grants are never alternative branches for a code-originated dispatch.

The requirement evaluator first filters `anyOf` branches by
`authorizingOrigin`. For eval, a method requirement such as `anyOf(user, code)`
can select only the `code` branch. It then evaluates every capability leaf and
relationship in that branch. This closes the algebraic hole where adding
executor, invocation, initiator, and acting-user principals could otherwise let
any one grant satisfy the call. A failure names the exact unmet normalized leaf.

For an eval call, effective code authority is:

```text
origin-selected method code branch and normalized capability leaf
∩ leaf's eval acquisition classification
∩ exact invocation principal, live run record, and active request/permit
∩ per-run ceiling and effect policy
∩ attested eval-executor exposure catalog
∩ exact initiator declaration or reviewed sponsor policy
∩ applicable baseline seed or user-approved grant on that initiator
∩ every live delegation edge from initiator to invocation
∩ live relationship and session predicates
− explicit blocks, denials, and revocations
```

Evaluated outbound calls are authorized as the invocation code principal, not
the EvalDO kernel. A code-originated reusable grant remains bound to the exact
initiating artifact (or its exact runtime session), capability, and canonical
resource—never to `product/eval` or the ephemeral invocation. Interactive-user
sponsorship binds reusable grants to its reviewed user/device/session subject
policy. Verified delegation edges attenuate that authority to the invocation,
audience, purpose, and run ceiling. Version trust covers later runs only from
the same exact initiating artifact digest.

The evaluator follows the chain; it does not search all principals for any
matching grant. Every edge names the preceding issuer, next subject,
capability/resource attenuation, audience, purpose, and live validity. A
delegated invocation leaf succeeds only when the root/initiator grant and every
edge to the invocation succeed. This is intersection along one authenticated
chain, not union across context facts.

Approval duration has distinct representations:

- `once` is an in-memory permit for the exact suspended dispatch ID. It is
  consumed by that dispatch and is neither persisted nor a valid
  preauthorization choice.
- `run` is an ephemeral `RunPermit` bound to run ID/digest, normalized leaf,
  canonical resource, and optional operation key. Up-front preauthorization may
  choose it. It expires at terminal state and is not a Permissions grant.
- `session` binds a reusable grant to the verified initiator and exact runtime
  session. `version` binds it to the initiating artifact digest. Broader
  selectors exist only where the canonical authority ledger explicitly permits
  them; eval creates no general follow-head grant.

Rejecting a suspended request fails that exact call and records a run-local
denial for the same leaf/resource so caught exceptions cannot create a prompt
loop. Dismissal rejects only that call and creates no durable or run-local
block. A persistent block is written only by an explicit Permissions/Block
action. Revocation fails the current or next dispatch from live state; it does
not silently reopen a prompt that bypasses the user's decision.

## 8. Eval executor and invocation credential

Split the current broad `product/eval` authority into two concepts:

- **Eval kernel authority:** the minimal fixed capabilities required by trusted
  EvalDO lifecycle, run storage, cancellation, and event cleanup.
- **Eval invocation exposure catalog:** the exact reviewed set of capabilities
  dynamic code may attempt through a verified run. This is a ceiling input, not
  a product principal's ambient grant.

The kernel code principal is used only for kernel operations. Evaluated code is
assigned the run-derived invocation principal described above. The exposure
catalog attests that the exact EvalDO executor is reviewed to mediate a method;
it is not an authority grant to either the kernel or invocation.

Every outbound runtime client created for evaluated code is constructed with the
run's opaque invocation credential. There is no ambient main-host client in the
UnsafeEval global scope and no way to fall back to the kernel client. Rich
facades, dynamic `services`, raw RPC, import helpers, userland service clients,
and event subscriptions all use the same invocation-bound transport.

The credential is:

- random and unguessable;
- stored only as a hash in the live invocation coordinator;
- bound to run ID/digest, EvalDO object key, executor digest, audience, and a
  short lease expiry;
- accepted only from the active matching EvalDO incarnation;
- rotated or invalidated on force reset, cancellation, owner retirement, child
  generation replacement, coordinator loss, or lease expiry;
- renewable only by that active EvalDO while its run, incarnation, scope lease,
  and optional `maxEndsAt` remain valid; and
- revalidated against live grants, denials, delegations, and relationships on
  every dispatch.

It is not a serialized authority snapshot and cannot be replayed against another
method plane, object, run, host, or generation. Lease renewal changes no
authority; every dispatch still reevaluates live state. A run may be unbounded
in wall time when `maxEndsAt` is null, but it never receives an unbounded bearer
credential. Renewal failure interrupts the run.

Durable run metadata stores invocation and manifest digests for status, audit,
and reconciliation, never a minting secret or a suspended transport. The live
host invocation coordinator is authoritative for active credentials and
challenges. EvalDO SQLite is authoritative for persisted handle/status, bounded
events, result, idempotency reference, and scope/database data. On coordinator,
host, workerd, or EvalDO incarnation loss, startup reconciliation marks every
nonterminal run `interrupted`, cancels challenges, and rejects old leases. It
does not reconstruct an accepted or approval-blocked execution.

Every facade or function that can survive in persistent scope is a run-neutral
handle. Its outbound call obtains the currently executing run context at call
time. No credential, authority client, or refresh handle is serializable into
scope, module exports, user database, child bindings, callback arguments, or
logs. A worker, DO, panel, subagent, or nested eval gets its own authenticated
principal and explicit attenuated delegation, never the parent's credential.

## 9. One live typed challenge broker

The authority evaluator remains pure and returns structured decisions. Both RPC
planes wrap it with an `AuthorityChallengeAdapter`. That adapter is one producer
for the host's generic `ChallengeBroker`, which also transports credential
input, device-code authorization, provider/userland questions, and other typed
interactions. The queue, shell/mobile routing, deduplication, expiry, and
resolution envelope are shared; each challenge kind retains its own payload
schema, resolver, and security semantics.

Ordinary built-code calls use the same authority adapter. Their immutable unit
manifest must already request the leaf, so there is no adaptive activation, but
an approval-classified missing initiator grant follows the same grant,
reevaluation, and continuation path. Adaptive activation is the only
eval-specific step.

For an eval capability leaf:

| Decision                                     | Adapter behavior                                         |
| -------------------------------------------- | -------------------------------------------------------- |
| allowed                                      | Dispatch immediately.                                    |
| adaptive leaf inside ceiling but inactive    | Activate within the run limit, then reevaluate.          |
| approval leaf lacks initiator grant/permit   | Reuse grant/permit or suspend and enqueue one challenge. |
| explicit block, run denial, or revoked grant | Fail; do not prompt around the decision.                 |
| relationship/session/delegation failure      | Fail with the exact unmet predicate.                     |
| outside strict request or adaptive ceiling   | Fail with an eval constraint error.                      |
| code-excluded or eval-closed leaf            | Fail as non-delegable; approval is unavailable.          |

The exact suspended RPC promise, arguments, and continuation stay in the active
EvalDO/gateway call stack. The live coordinator indexes it by an unguessable
dispatch ID. The UI queue record contains only canonical, redacted challenge
metadata:

- challenge kind and schema version;
- origin host and optional parent host;
- run ID/digest and bounded source/provenance location;
- verified initiator/sponsor, entity, acting user, and executor identity;
- normalized leaf, canonical resource, operation, severity, and allowed choices
  for an authority challenge;
- launch/generation identity for child-host challenges; and
- dispatch ID plus created, expiry, cancelled, and resolved state.

The record may be durably mirrored so disconnected UI clients and audit readers
can observe it, but it is not a durable continuation. It contains no raw method
arguments, secret answer, token, resolver closure, or replay instruction. If the
live coordinator/EvalDO incarnation is lost, reconciliation cancels the record,
marks the run interrupted, and ignores a late decision. It never reconstructs
or redispatches the operation.

Repeated publication/resolution of the same dispatch ID deduplicates. Distinct
dispatch IDs remain distinct even when their leaf/resource matches, so an exact
`once` decision cannot silently authorize concurrent calls. The UI may group
equivalent records visually. A reusable grant or run permit wakes every grouped
dispatch and each reevaluates independently; an exact once permit releases only
its selected dispatch and leaves the others pending. Different resources and
challenge kinds never share a decision. No handler side effect has occurred yet,
so approval resume requires no special handler replay/idempotency shim.

With `approvals: "prompt"`, up-front `preauthorize` intents use the same adapter
before JavaScript starts. The UI may group review, but each leaf/resource
resolves independently. `run`, `session`, and `version` are valid choices when
declared by the leaf; `once` is not, because no exact dispatch exists yet.
Rejecting one item cannot broaden or rewrite the remaining manifest.

Cancellation, deadline, force reset, child termination, caller retirement, or
terminal loss of the route's bound process/generation invalidates pending
decisions immediately. A temporary transport outage with both bound processes
alive enters `approval-route-lost` and accepts no resolution until the same route
is reauthenticated. Resolution is idempotent across desktop/mobile races.
Per-run and per-initiator limits cap live challenges, total challenge creations,
redacted detail bytes, and event records; exceeding them fails the operation
with `EVAL_RESOURCE_LIMIT` rather than producing an approval storm.
Every challenge has a finite host-defined TTL; route loss never extends it. On
expiry, the exact call rejects and the run may continue only if its code handles
that typed error.

## 10. One asynchronous eval lifecycle

Replace the current synchronous `run` and asynchronous `startRun` execution
implementations with one handle-based lifecycle:

```ts
eval.start(input): Promise<EvalRunHandle>
eval.get({ runId }): Promise<EvalRunSnapshot>
eval.events({ runId, after }): Response
eval.cancel({ runId }): Promise<{
  status: "requested" | "cancelled" | "terminal";
}>
eval.reset({ scope }): Promise<{ status: "reset" | "waiting-for-safe-boundary" }>
eval.forceReset({ scope }): Promise<{
  status: "requested" | "reset" | "requires-process-restart";
}>
```

`eval.start` authenticates, reserves idempotency, persists `accepted`, enqueues,
and returns. A transport-agnostic `eval.execute(input)` helper composes start +
events/poll + terminal result for CLI, panels, extensions, and the agent tool.
The caller may hibernate or disconnect because the handle and status are
durable. That does not make the evaluator's JavaScript continuation durable.

Each `(owner, context, scope key)` routes to one deterministic EvalDO
coordination atom. It owns one FIFO execution lease covering preparation,
preauthorization, JavaScript, and challenge waits. A later run for the same
persistent scope cannot observe or overwrite half-complete scope state. Runs for
different scope keys route to different EvalDOs and may proceed independently.
`get`, `events`, and cancellation are not scheduled behind the FIFO lease. The
host coordinator can always return the last persisted/mirrored snapshot and can
invalidate a credential or challenge immediately. It cannot make an EvalDO
event loop that is inside non-yielding synchronous JavaScript process a fresh
request; fresh progress/events appear only after that code yields.

The lifecycle is:

```text
accepted -> queued -> preparing
preparing -> awaiting-preparation-challenge -> preparing
preparing -> awaiting-preauthorization -> preparing
preparing -> running
running -> awaiting-challenge -> running
awaiting-challenge -> approval-route-lost -> awaiting-challenge
preparing | running | awaiting-* -> cancellation-requested
accepted | queued | preparing | running | awaiting-* | cancellation-requested
  -> succeeded | failed | cancelled | expired | interrupted
```

Only valid edges are compare-and-set in persisted status. The live execution
Promise remains on the active EvalDO call stack from preparation entry through
terminal cleanup. Cloudflare's
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
does not hibernate an object while a request/event or awaited I/O is in progress,
and this runtime's active-run guard also prevents its own idle eviction policy
from firing. Idle, terminal EvalDOs may evict and cold-rehydrate persistent scope
later.

A repeated `eval.start` with the same idempotency tuple and digest returns the
same handle. Changed input under the same tuple conflicts. No state transition
replays JavaScript: if the host, coordinator, workerd process, EvalDO incarnation,
or required child generation disappears, reconciliation moves every affected
nonterminal run to `interrupted`, invalidates credentials and challenges, and
records that prior side effects may have occurred.

Cancellation is cooperative. `cancel` records `cancellation-requested`, aborts
the ordinary run signal and pending challenge, then rotates the same credential
into a non-renewable, 30-second terminal-cleanup phase. Ordinary continuations
retain the aborted signal and cannot dispatch. Only handlers explicitly
registered with `ctx.onCleanup` receive an independent cleanup signal; they keep
the original delegation ceiling and strict/read-only constraints, and cannot
open a new approval prompt. The host invalidates the invocation immediately
after cleanup settles. Awaited RPC, import, timer, subscription, and challenge
boundaries observe the abort and settle as `cancelled`. JavaScript already
executing synchronously cannot receive a timer, abort event, or new DO request
until it yields; the API does not claim to preempt an infinite CPU loop. Such a
run remains `cancellation-requested`; host process termination, if separately
authorized operationally, ends it as `interrupted`, not `cancelled`.

Deadlines use the same cooperative mechanism. `forceReset` aborts ordinary run
authority immediately, permits only the same bounded terminal-cleanup phase,
then invalidates the invocation credential and clears scope/database after the
evaluator reaches a safe boundary. It must never orphan a still-executing chain
and allow a new run to share the same engine or scope. If synchronous code will
not yield, the result explicitly says `requires-process-restart`.

Persistent REPL scope and user database remain bound to their deterministic
EvalDO scope. Run authority, credentials, once/run permits, challenge
continuations, and run-owned async work are not stored there. Terminal cleanup
releases the FIFO lease only after all run-owned resources have been detached.

## 11. Public schema and developer ergonomics

The exact final naming may follow repository conventions, but the public model
must be structurally equivalent to:

```ts
eval.start({
  source: { kind: "inline", code, pathHint?, syntax? }
    | { kind: "context-file", path },
  scope?: { key: string; reset?: boolean },
  imports?: Record<string, string>,
  deadlineMs?: number,
  idempotencyKey?: string,
  authority?: {
    mode?: "adaptive" | "strict",
    effects?: "read-only" | "mutable",
    approvals?: "prompt" | "pregranted-only",
    requests?: CapabilityScope[],
    preauthorize?: EvalPreauthorizationIntent[],
  },
});
```

`idempotencyKey` is scoped to the verified initiator plus owner/context/scope
key. Reuse with byte-for-byte equivalent normalized intent returns the original
handle; reuse with changed source reference, imports, authority, target, or
deadline returns `EVAL_IDEMPOTENCY_CONFLICT`. `deadlineMs` requests a host
deadline but has the cooperative cancellation semantics in section 10; it is not
a synchronous-JavaScript preemption guarantee.

An idempotency hit returns the original terminal state too, including
`interrupted`; it never treats interruption as permission to retry. Because
prior effects may be unknown, an intentional retry requires a new key and an
explicit caller decision.

Defaults are explicit in discovery and result metadata:

```ts
{
  mode: "adaptive",
  effects: "mutable",
  approvals: "prompt"
}
```

Omitting `deadlineMs` yields `maxEndsAt: null`; it does not create a
never-expiring credential. The host still applies short renewable invocation
leases and fixed resource/cardinality limits. Callers may request a shorter
deadline but cannot raise host limits.

The agent-facing `eval` tool keeps its concise code/path/import ergonomics and
adds a small optional containment group. Agents do not need to enumerate
capabilities for ordinary work. Strict manifests and preauthorization are
advanced controls for delegation and reproducibility, not ceremony on the happy
path.

Capability discovery exposes, for each normalized capability leaf:

- whether the leaf is baseline, approval, or closed to eval;
- its sensitivity and canonical capability name;
- resource shape and allowed grant scopes;
- required live relationships or credentials;
- representative examples and documented errors; and
- whether the current run has activated, already holds, awaits, or lacks it.

An authority failure is structured on the wire and rendered with an actionable
summary. At minimum:

```ts
type EvalAuthorityErrorCode =
  | "EVAL_AUTHORITY_CONSTRAINT"
  | "EVAL_CAPABILITY_NOT_DELEGATED"
  | "EVAL_CAPABILITY_CLOSED"
  | "EVAL_APPROVAL_REQUIRED"
  | "EVAL_APPROVAL_DENIED"
  | "EVAL_GRANT_REVOKED"
  | "EVAL_RELATIONSHIP_FAILED"
  | "EVAL_READ_ONLY"
  | "EVAL_INVOCATION_EXPIRED"
  | "EVAL_INVOCATION_INVALID"
  | "EVAL_APPROVAL_ROUTE_LOST"
  | "EVAL_CHALLENGE_EXPIRED"
  | "EVAL_IDEMPOTENCY_CONFLICT"
  | "EVAL_RESOURCE_LIMIT"
  | "EVAL_CANCELLATION_PENDING"
  | "EVAL_INTERRUPTED";
```

The error contains safe capability/resource labels, the run's mode, the failed
predicate, whether approval is possible, and the catalog action an agent can
take. It does not expose tokens, hidden resources, secret-bearing arguments, or
unrelated grant state.

Every terminal result includes a bounded authority summary: activated
capabilities, approvals reused/requested/denied, constraint failures, and the
resolved manifest digest. It also identifies `sourceDigest`,
`executionProvenanceDigest`, `scopeInputRevision`, and terminal reason, so a
retained function cannot be audited as though only the latest snippet executed.
Full details live in bounded, pageable audit/event storage rather than inflating
ordinary eval results.

## 12. Isolated development-host eval

`devHost.eval` becomes a typed facade over the same asynchronous handle model.
Its target always includes the verified launch and active generation. The
current host service reauthorizes launch ownership on start, get, event resume,
cancellation, and challenge resolution. A retained or candidate generation
requires the separate operator capability already specified by the
self-development plan.

The original current-host caller remains the initiator. The paired dev-host
extension/device is only a transport deputy and never substitutes its own code
or device grant for the caller's. Before the extension starts a child run, the
current host resolves the caller's exact code delegation ceiling or reviewed
interactive/host sponsor policy and issues an opaque, short-lived extension of
the shared `DirectAuthorityAttestation`, bound to:

- parent and child host principals;
- launch and active generation/process identity;
- exact verified initiator, entity/user relationships, and parent authority
  revision;
- requested child eval start-intent/authority digest;
- audience `dev-host-eval:<launch>:<generation>` and the eval purpose; and
- the one child session/entity the launch supervisor created for this origin.

The direct client carries this as authenticated transport metadata, never as a
caller-controlled eval argument. The child accepts it only through the paired
parent-host relationship established for that launch. It derives the child's
invocation principal and run manifest from the attested initiator plus its own
verified target records. The extension cannot alter, reuse, widen, or inspect the
delegation.

The call path is:

```text
agent tool
  -> current host devHost service
  -> current-host authority attestation
  -> trusted dev-host extension
  -> paired @vibestudio/direct-client
  -> child eval.start
  -> child EvalDO
  -> child challenge broker
  -> child service / direct WorkspaceDO RPC
```

The extension never mints a child grant or turns its paired device credential
into initiating-code authority. When the child broker needs a decision:

```text
child pending challenge
  -> typed child approval exchange over the paired direct client
  -> dev-host extension
  -> current host challenge broker
  -> ordinary shell/mobile approval UI
  -> initiator grant/permit on the current host, scoped to child host/resource
  -> fresh parent-to-child verified delegation
  -> typed child approval resolution
  -> child live relationship/resource re-evaluation
  -> suspended child dispatch resumes
```

The child is authoritative for its method exposure, canonical resource,
workspace/entity relationships, run state, and final dispatch. The current host
is authoritative for the original initiator's manifest, grants, denials, and
user decision. Their results intersect through verified delegation; neither host
copies the other's database or treats the extension as authority.

The current host also treats child-supplied display detail as untrusted. It
verifies child process/generation identity and the canonical method/capability/
resource envelope carried by the paired protocol, labels the exact development
build in UI, and never lets free-form child copy obscure that identity. This
protects the transport boundary without claiming an OS sandbox against
intentionally malicious same-user development code.

The exchange reuses the canonical typed challenge and decision schemas. It is
transport, not a second challenge system. The current host queue stores an
origin descriptor containing child host identity, launch ID, generation/process
identity, child run ID, challenge kind, and canonical capability/resource when
applicable. An authority challenge may issue an exact once/run permit or write a
reusable grant for the original verified initiator. Every choice includes the
child host in its canonical resource scope, so it cannot silently authorize the
main host or a different child. Other challenge kinds never write a capability
grant. The UI makes the child boundary visually explicit.

The extension may forward only challenges from the paired child identity owned
by that launch, and may resolve them only from a host-issued, user-resolved
decision record. Userland `devHost` callers cannot invoke an approval-resolution
method. Parent and child bind each message to the active generation and a
monotonic challenge ID so a restarted process cannot accept a stale decision.

Each child outbound dispatch receives fresh parent authority mediation, or a
revision-keyed lease whose acknowledged invalidation is proven to have identical
next-dispatch revocation semantics. Loss of the parent authority channel fails
closed. This preserves live parent grant/deny/membership changes without placing
a reusable parent credential or stale authorization snapshot in the child.

If the bridge is absent or loses liveness, the child does not enter an invisible
unbounded wait. Every child run with `approvals: "prompt"` confirms an active
approval route before source preparation or JavaScript starts, regardless of
read-only/mutable effects: credential, device-code, and userland questions can
occur in reads too. Without a route the caller must use pregranted-only behavior.
If the route disappears while both host generations remain alive, a pending live
challenge becomes `approval-route-lost` with retry/cancel actions. Loss or
replacement of the parent process, child process, EvalDO incarnation, or
generation interrupts the run, cancels the bridge record, and rejects stale
decisions; neither side reconstructs the child continuation after restart.

No child admin token, paired credential, raw direct client, or approval resolver
is returned through `devHost`. Logs and run diagnostics redact the same data.

## 13. Audit, permissions, and observability

Each run emits correlated structured events for:

- accepted identity, start-intent/source/execution-provenance/scope/manifest
  digests, and idempotency outcome;
- executor, initiator, entity, owner/context, host, and dev generation;
- capability activation and canonical resource;
- authority decision code and failed predicate;
- typed challenge creation, forwarding, display, resolution, expiry, route
  loss, and cancellation;
- grant reuse, creation, denial, and live revocation;
- outbound dispatch start/end and RPC plane;
- state transition, heartbeat, cancellation request/observation, interruption,
  and terminal result; and
- token rotation/rejection without logging token material.

Run events and authority detail are bounded by the manifest limits. Durable
security audit storage is separately retained, redacted, paged, and pruned under
the product audit policy; it is not an unbounded per-run SQLite array. Live
continuations and raw challenge answers never enter audit storage. When a limit
is reached the run emits one terminal/resource-limit record rather than dropping
the fact that enforcement occurred.

Immutable source/provenance bundles are reference-counted by nonterminal runs,
the bounded audit-retention window, and retained executable scope entries. A
garbage collector deletes unreferenced CAS content; digesting source does not
create permanent storage growth.

The Permissions surface groups eval-created grants under the verified initiator
(normally the initiating code) and shows “used through eval” as provenance. It
never groups them under the global EvalDO artifact. A grant row shows capability,
resource, session/version or user/device binding, origin host, last-used run, and
revoke action. Revocation affects the next dispatch and wakes/cancels any
challenge now made impossible.

The approval UI shows verified identity before untrusted snippet copy:

- initiating app/agent and exact version;
- “via Eval” and run/source location;
- main host or named development launch/generation;
- operation, resource, severity, and scope choices; and
- a compact diff or structured detail where the canonical operation supports
  one.

Approval surfaces must use the shell's established overlay/stacking system and
remain actionable above panel content, notifications, connection errors, and
development-host status banners. Desktop and mobile render from the same queue
record; either may resolve it idempotently.

## 14. Failure semantics

The run and the caller receive one stable error taxonomy rather than arbitrary
dispatcher strings:

| Condition                                           | Outcome                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Adaptive capability inside ceiling, baseline        | Activate and continue.                                                      |
| Adaptive capability inside ceiling, approval needed | Suspend, prompt, reevaluate, resume or deny.                                |
| Strict capability absent from requests              | `EVAL_AUTHORITY_CONSTRAINT`.                                                |
| Capability outside delegator ceiling                | `EVAL_CAPABILITY_NOT_DELEGATED`.                                            |
| Selected leaf not code-exposed / eval-closed        | `EVAL_CAPABILITY_CLOSED`.                                                   |
| Read-only calls write/admin/destructive/unknown     | `EVAL_READ_ONLY`.                                                           |
| Explicit/run-local denial                           | `EVAL_APPROVAL_DENIED`; no prompt loop.                                     |
| Dismissed challenge                                 | Exact call rejects; no durable or run-local denial.                         |
| Challenge TTL expires                               | `EVAL_CHALLENGE_EXPIRED`; exact call rejects.                               |
| Missing grant in pregranted-only mode               | `EVAL_APPROVAL_REQUIRED` with canonical external grant intent.              |
| Membership/ownership/agent binding fails            | `EVAL_RELATIONSHIP_FAILED`.                                                 |
| Grant/delegation revoked during run                 | Current or next dispatch fails live; no cached allow.                       |
| Idempotency key reused with changed intent          | `EVAL_IDEMPOTENCY_CONFLICT`; no second handle or source read.               |
| Source/import changes after materialization         | Run executes frozen CAS bytes; later run gets a new digest.                 |
| Scope revision changes before execution             | Requeue/reprepare before code; never execute under a stale digest.          |
| Run exceeds activation/challenge/event/detail limit | `EVAL_RESOURCE_LIMIT`; no silent eviction of authority facts.               |
| Cancel while at an awaited boundary                 | Credential/challenge invalidate; run settles `cancelled`.                   |
| Cancel during non-yielding synchronous JavaScript   | `cancellation-requested`; no false preemption claim.                        |
| Deadline during non-yielding synchronous JavaScript | Same cooperative limit; terminal only when code yields or process is lost.  |
| Host/coordinator/workerd/EvalDO incarnation is lost | `EVAL_INTERRUPTED`; invalidate and cancel, never replay JavaScript.         |
| Active EvalDO hibernation                           | Impossible while its request/await is live; terminal/idle scope can reload. |
| Reusable grant persisted just before process loss   | Grant remains auditable; run interrupts and no dispatch is replayed.        |
| Once/run permit followed by process loss            | Permit disappears; run interrupts.                                          |
| Child generation exits or is replaced               | Run interrupts with generation identity; parent challenge is cancelled.     |
| Child approval route is lost                        | Visible blocked state with retry/cancel; never an invisible hang.           |
| Credential replay/wrong audience/object             | `EVAL_INVOCATION_INVALID` and security audit event.                         |

The authority adapter does not convert invalid arguments, unavailable providers,
domain conflicts, build failures, or ordinary runtime exceptions into
capability prompts. A method may deliberately emit a separately typed credential,
device-code, or userland challenge through the shared broker; that remains a
domain interaction and cannot create an authority grant.

## 15. Implementation workstreams

### EA0. Freeze the eval authority contract

- Generate a machine-readable census of every host-service and direct-RPC
  method, its current code admission, product/eval reachability, sensitivity,
  normalized primary/additional/conditional capability leaves, resource
  derivation/preparation resolver, and current approval behavior.
- Add parity fixtures for representative filesystem, VCS, build, panel, worker,
  browser/CDP, credential, notification, network, userland-service, and direct
  WorkspaceDO calls from main-host eval.
- Capture current success, prompt, denial, error, result, and latency behavior.
- Inventory non-capability credential, device-code, and userland challenges that
  need the shared transport without becoming grants.
- Classify every code-capability leaf baseline, approval, or closed. Unknown
  blocks EA1.

Exit: there is no unclassified callable code-capability leaf, every existing
typed interaction has an owner, and broad eval UX is measured before changes.

### EA1. Canonical capability-leaf acquisition declarations

- Extend service and direct-RPC declarations with per-leaf eval acquisition.
- Move service-local additional-capability and approval descriptions into the
  canonical requirement graph.
- Register side-effect-free preparation resolvers and normalize conditional
  branches identically on both planes.
- Generate the eval exposure ledger/catalog and enforce complete classification
  in CI.
- Make the pure evaluator return structured unmet requirements without changing
  live dispatch yet.

Exit: both RPC planes can explain whether and how eval may satisfy every selected
leaf, with no handler-private grant or prompt policy.

### EA2. Delegation manifests and shared authority chain

- Extend `UnitAuthorityManifest` and build identity with exact delegation
  declarations.
- Generate reviewed agentic-eval delegation lists for first-class agent workers.
- Replace singular code-manifest context with one authorizing origin and the
  executor/invocation/initiator chain; make `anyOf` origin-selecting, not a
  cross-principal grant union.
- Resolve immutable relational anchors at start and evaluate target membership
  live so later resources inside the same anchor do not widen the ceiling.
- Generalize the current code-only capability grant-store API into the one
  canonical `AuthorityGrant` store for exact code, interactive user/device, and
  delegated invocation subjects; migrate by the declared pre-release state cut,
  not an eval-specific shadow store.
- Implement verified delegation issuance, audience/purpose attenuation, live
  revocation, and confused-deputy tests.

Exit: an eval outbound call can be evaluated from authenticated facts without
borrowing the EvalDO's ambient product identity.

### EA3. Invocation authority coordinator

- Add canonical authority-intent schemas and server resolution.
- Implement idempotent acceptance with changed-input conflict and deterministic
  owner/context/scope routing.
- Build the initiator-authorized source materializer and immutable CAS closure;
  compute source, scope, execution-provenance, and final run digests in order,
  with reference-counted retention and garbage collection.
- Persist bounded run/activation/event metadata and audit records, not suspended
  JavaScript, RPC arguments, or resolver continuations.
- Mint, renew, and invalidate short audience-bound invocation leases.
- Split minimal eval-kernel calls from invocation-bound runtime clients.
- Ensure every rich, dynamic, raw-RPC, import, and userland-service path carries
  the invocation credential.
- Make retained functions/facades run-neutral and all async resources run-owned.

Exit: EvalDO executes the exact hashed source/provenance closure; a missing,
stale, replayed, cross-object, or cross-run credential cannot call either plane;
scope persistence cannot retain old authority.

### EA4. Adaptive activation and unified challenge broker

- Implement adaptive and strict activation behavior.
- Implement mutable/read-only effect enforcement on both planes.
- Build the authority adapter on one generic typed challenge broker and migrate
  credential/device-code/userland interactions to that transport where needed.
- Keep exact dispatch continuations live in EvalDO/gateway memory; queue mirrors
  are UI/audit records and process loss cancels them without replay.
- Reuse the canonical authority grant store; add exact once permits, ephemeral
  run permits, preauthorization grouping, denial/dismiss semantics,
  deduplication, live reevaluation, limits, and audit events.
- Delete migrated handler-local `withCapability` checks and any approval shadow
  state.

Exit: an adaptive eval either proceeds, visibly prompts and resumes, or returns a
precise non-approvable failure; it never ends at a raw missing-manifest error.

### EA5. One asynchronous run API and client ergonomics

- Replace `run` and `startRun` with start/get/events/cancel.
- Implement one asynchronous handle/status state machine, FIFO scope lease, and
  process-loss reconciliation to `interrupted`.
- Implement cooperative cancellation/deadlines and safe-boundary reset without
  orphaning synchronous execution or claiming CPU preemption.
- Migrate EvalDO, eval service, hosted runtime, agent tool, CLI, panels,
  extensions, tests, capability docs, and generated authority manifests.
- Add `execute` as a client composition, not another server execution path.
- Remove top-level `readOnly` and privileged owner/context overloads.

Exit: all callers use one execution substrate, callers may disconnect or
hibernate, active JavaScript is never replayed, and ordinary agent eval requires
no capability boilerplate.

### EA6. Development-host approval exchange

- Extend dev-host typed schemas with eval handles and authority intent.
- Add the typed child approval challenge subscription/resolution exchange.
- Bridge child challenges into the current host queue with launch/generation
  attribution and liveness.
- Reauthorize launch ownership on every operation and stream resume.
- Confirm a route for every prompt-capable child run, mediate every child
  dispatch from live parent authority, and treat process/generation loss as
  interruption rather than continuation recovery.
- Handle temporary bridge route loss, cancellation, stale decisions, parent
  restart, and untrusted child display detail explicitly.

Exit: a live child eval can request and receive a user decision through the
current desktop/mobile UX without exposing credentials or hanging headlessly;
process loss visibly interrupts it.

### EA7. Permissions, discovery, and diagnostics

- Surface per-leaf eval acquisition and current-run authority in the capability
  catalog.
- Add structured JIT errors and safe remediation hints.
- Group approvals and grants under the verified initiator with eval provenance.
- Add bounded run/audit inspection, source/provenance digests, resource-limit,
  cancellation-pending, and interrupted states to CLI/dev-host status.
- Update agent, sandbox, workspace-development, approval, permission, and
  architecture documentation.

Exit: a developer or agent can tell what was requested, what authorized it,
what is waiting, what was denied, and what safe next action exists.

### EA8. Clean cut and deletion

- Remove ambient full-census `product/eval` grants, retaining only the minimal
  kernel manifest and generated exposure catalog.
- Remove `delegation: []` construction and the singular eval code identity.
- Remove `eval.run`, `eval.startRun`, duplicated held/background execution, and
  their compatibility call sites.
- Remove service-local approval gates replaced by canonical declarations.
- Remove child direct eval without approval exchange.
- Regenerate all manifests/ledgers and reject mixed old/new runtime-foundation
  state with the repository's explicit pre-release reset UX.

Exit: repository search finds one eval lifecycle, one authority chain, one typed
challenge broker, and no ambient or legacy path.

## 16. Verification program

### 16.1 Unit and property tests

Authority algebra:

- invocation origin ∩ executor ∩ initiator grant ∩ delegation ∩ run ∩
  relationship, never union;
- `anyOf(user, code)` branch selection by authorizing origin and proof that an
  acting-user or executor grant cannot satisfy invocation-code authority;
- adaptive activation inside/outside ceiling;
- strict exact/prefix/origin/domain/network coverage;
- deny precedence, revocation, expiry, wrong audience/purpose, and stale
  incarnation;
- baseline versus approval versus closed classification for primary,
  additional, and conditional leaves of one method;
- read-only sensitivity on host-service and direct-RPC methods;
- immutable relational anchors, live success for a newly created in-anchor
  resource, and failure after it leaves that relationship;
- once-dispatch/run-permit/session/version binding to the verified initiator
  rather than EvalDO, including code and interactive-user cases;
- deny/dismiss/persistent-block precedence and prompt-loop prevention;
- nested-eval attenuation, depth bounds, ancestor revocation, and cancellation;
  and
- spawned worker/DO/panel/subagent isolation and proof that no invocation
  credential enters child arguments, bindings, environment, storage, or logs.

Invocation lifecycle:

- canonical start/source/scope/provenance/run digest vectors, frozen path/import
  bytes, retained-function provenance, CAS reference/garbage collection, and
  any-input-change properties;
- idempotent same-input start, changed-input conflict, FIFO same-scope ordering,
  interrupted-handle retention, explicit-new-key retry, and independent-scope
  concurrency;
- token hashing, expiry, replay, wrong object/run/host/generation, rotation, and
  renewal/force-reset invalidation;
- coordinator/host/EvalDO loss marks every nonterminal run interrupted, cancels
  live challenges/permits, and never redispatches source or side effects;
- active run/challenge keeps its EvalDO incarnation live, while terminal idle
  scope cold-rehydrates correctly;
- scope/database persistence without authority persistence;
- run-neutral retained facades and terminal cleanup of callbacks,
  subscriptions, tasks, and async children;
- cancellation while calling RPC, awaiting a challenge, importing, and at other
  await points, plus `cancellation-requested` for non-yielding synchronous CPU;
- safe reset/force-reset boundaries with no orphaned execution chain;
- activation/challenge/event/detail resource limits; and
- duplicate completion/event delivery reconciliation.

Challenge broker:

- fast path for baseline and existing grants;
- prompt path for both RPC planes;
- same-dispatch publication/resolution deduplication, distinct concurrent
  dispatches, grouped reusable-grant wakeup, and exact-once isolation;
- exact once/run/session/version behavior, deny, dismiss, persistent block,
  timeout, mobile/desktop race, and revocation;
- preauthorization groups recording independent run permits or grants, with no
  `once` option;
- live re-evaluation after a positive decision; and
- no capability prompt for relationship, closed-surface, invalid-argument, or
  domain failures;
- typed credential/device-code/userland challenges sharing transport without
  creating capability grants; and
- a stale durable UI mirror cannot resume a dispatch after process loss.

Generation and schema:

- every normalized code-capability leaf has an eval classification;
- closed/code-principal contradictions fail;
- approval declarations have canonical resources and requirements;
- agentic eval delegation lists contain exact reviewed entries and no wildcard;
- new methods make generated ledgers/manifests stale; and
- all old eval schema shapes are rejected after the cut.

### 16.2 Integration and smoke matrix

Run adaptive main-host eval through each public route:

- `fs` read/write/delete and context scoping;
- VCS inspect/edit/publish approval;
- build and typecheck;
- worker/DO create, call, update, and lifecycle approval where declared;
- panel open/navigation/tree operations;
- browser/CDP and external network approval;
- credentials use without secret leakage;
- notifications and external-open approval;
- userland GAD/VCS/channel/models/testkit services;
- raw direct WorkspaceDO RPC;
- dynamic `services[name][method]` selection;
- context-file and runtime imports whose frozen transitive closure calls
  services, including a path mutation after materialization;
- persistent retained functions invoked under a later narrower run;
- typed credential/device-code/userland challenges;
- event subscribe/unsubscribe, terminal cleanup, and post-terminal idle
  eviction; and
- large result paging, cancellation, reset, and force reset.

Repeat representative reads, writes, approval waits, direct RPC, imports, and
cancellation through isolated `devHost` eval. Test read-only prompt routing,
active generation success, candidate rejection, generation replacement, child
crash, temporary bridge loss, and parent restart interruption.

For every surface, cover baseline success, new approval, reused grant, denial,
revocation, strict miss, read-only miss, closed method, invalid relationship,
and pregranted-only behavior where meaningful.

### 16.3 Headless agentic system tests

Add exact discoverable cases:

- `agent-eval-adaptive-code-surface`;
- `agent-eval-dynamic-method-name`;
- `agent-eval-approval-resume`;
- `agent-eval-preauthorization`;
- `agent-eval-pregranted-only`;
- `agent-eval-strict-manifest`;
- `agent-eval-read-only-both-rpc-planes`;
- `agent-eval-revocation-next-dispatch`;
- `agent-eval-no-confused-deputy`;
- `agent-eval-scope-does-not-retain-authority`;
- `agent-eval-frozen-source-and-retained-provenance`;
- `agent-eval-idempotency-conflict`;
- `agent-eval-process-loss-interrupts-approval`;
- `agent-eval-cooperative-cancellation`;
- `agent-eval-authority-resource-limits`;
- `agent-eval-typed-domain-challenge`;
- `dev-host-eval-adaptive-code-surface`;
- `dev-host-eval-approval-bridge`;
- `dev-host-eval-read-only-prompt-route`;
- `dev-host-eval-approval-route-loss`;
- `dev-host-eval-stale-generation-decision`;
- `eval-capability-census-closed-by-default`.

Implementation follows repository policy for every non-zero run: doctor,
discover, smallest exact test, inspect and full trajectory, root-cause repair,
exact rerun, category, then smoke. Unexpected tool failures are rerun from the
original run after repair.

### 16.4 Desktop and mobile end-to-end tests

- A main-host eval approval renders above panel content and other banners,
  identifies the initiating agent/version and eval run, and resumes once.
- The same challenge can be resolved from mobile; the desktop record disappears
  idempotently.
- A child-host challenge renders with child launch/generation identity and
  resumes only the matching child run.
- A stale child decision after rebuild/restart is rejected and removed.
- Deny and dismiss reject the suspended call and leave the run usable when the
  snippet handles the exception; deny suppresses a same-run prompt loop while
  dismiss does not create a block.
- Revoking the resulting grant in Permissions blocks the next call without
  restarting the run.
- Cancelling or closing the run removes the pending approval from every surface.
- Restarting the host or child while a challenge is pending removes the stale
  queue record and renders the run `interrupted`; no decision resumes it.

### 16.5 Fault injection and performance

Inject process loss before and after acceptance, source CAS commit, invocation
creation, EvalDO scheduling, activation write, challenge mirror/forwarding, user
resolution, grant write, reevaluation, handler entry, completion, and cleanup.
Before handler entry, no side effect occurs. After handler entry, audit may say
the outcome is unknown and prior effects may exist, but the runtime always
converges to `interrupted` and never automatically replays the source or
dispatch. A reusable grant committed before loss remains committed without a
duplicate grant row; once/run permits and live challenge continuations
disappear.

Record the EA0 latency and memory baseline. Acceptance requires:

- no approval or extra network round trip for already-authorized main-host
  baseline calls; child-host authority mediation may use the existing local
  control session but must not create a human-latency or per-call connection
  setup path;
- bounded local authority lookup on each dispatch;
- no unbounded capability catalog or grant scan in an interactive path;
- bounded live waiters, challenge detail, activation/event state, persistent
  executable provenance, and run-owned async resources;
- active execution/approval waits keep only their owning EvalDO incarnation
  resident, while terminal idle EvalDO eviction and cold scope rehydration remain
  effective;
- credential lease renewal does not add a round trip to every dispatch; and
- adaptive bookkeeping does not materially regress ordinary eval start or
  service-call latency relative to the captured baseline.

## 17. End-to-end acceptance scenario

The final cutover exercise proves the complete product pillar:

1. Start a normal System Agent and run an eval with no authority options.
2. Dynamically select and call unrelated read APIs from filesystem, VCS, panel,
   build, worker, and direct WorkspaceDO surfaces; observe no manifest-shaped
   failures or approval noise.
3. Perform an approvable mutation. Observe a correctly stacked approval with
   verified agent, exact version, run, operation, and resource.
4. Approve once. Observe the exact suspended call resume without rerunning prior
   snippet effects.
5. Repeat and choose version trust. Observe reuse for the same initiating code
   and resource, but a prompt for a different agent version or broader resource.
6. Revoke the grant while the run remains alive. Observe the next matching call
   stop at the live authority boundary.
7. Run the same program read-only and prove every mutation route—including raw
   direct RPC—fails before side effects.
8. Run with a strict exact manifest and prove an undeclared dynamic call fails
   with the named constraint and no manifest expansion.
9. Run pregranted-only, receive a machine-readable missing intent with no queue
   entry, grant it through the ordinary external Permissions flow, and retry
   successfully. Separately start a prompt-mode strict run with up-front
   preauthorization, choose a run permit for one leaf and a reusable grant for
   another, and confirm no `once` choice exists.
10. Persist a function in eval scope, begin a new narrower run, and prove the
    function uses the new run's authority and the result/audit includes its
    retained executable provenance.
11. Launch an isolated development host from a dirty exact context and repeat a
    baseline read plus a typed read-side challenge and sensitive mutation.
    Resolve its child challenges from the current host UI and observe the child
    run resume.
12. Rebuild the child while a second challenge is pending. Observe the stale
    decision reject, pending UI clear, and old run become `interrupted` with its
    exact generation identity; observe no replay on the new generation.
13. Add an unclassified code-admitted test method and prove generation/CI fails
    until each normalized capability leaf has eval acquisition and tests.
14. Inspect the run and Permissions page. Confirm executor, initiator,
    delegation, source/execution-provenance/manifest digests, activations,
    approval provenance, grant scope, host/generation, and revocation are
    coherent and no credential material is present.
15. Mutate a context file immediately after start preparation and prove the run
    executes the frozen CAS bytes. Start again and observe a different source
    and run digest.
16. Cancel once while code awaits RPC and once during a bounded synchronous CPU
    loop. Observe prompt cancellation at the await boundary and
    `cancellation-requested` until the synchronous loop yields—never a false
    preemption claim.
17. Repeat an identical lost-response start and receive the same handle; change
    one normalized input under the same idempotency key and receive
    `EVAL_IDEMPOTENCY_CONFLICT`.
18. Terminate the host/EvalDO while an approval is pending. Observe
    `EVAL_INTERRUPTED`, credential/challenge invalidation, stale-decision
    rejection, and no automatic re-execution of prior snippet effects.

## 18. Definition of done

This plan is complete only when:

- a normal first-class agent's adaptive eval can attempt every reviewed
  code-delegable capability without static-inference failures;
- the broad generated eval catalog is only an exposure ceiling and cannot grant
  a call without a verified invocation chain;
- every eval outbound call preserves one invocation-code origin, exact executor
  and initiator roles, owner/context, agent binding, delegation, run/source/
  execution-provenance digests, and live relationships;
- adaptive, strict, read-only, mutable, prompt, pregranted-only, and
  preauthorization behavior are implemented through one manifest model;
- sensitive capability misses dynamically prompt and resume the exact live
  suspended call on both RPC planes;
- capability, credential, device-code, and userland challenges share one typed
  queue/transport without conflating domain answers with grants;
- child-host challenges are visible and resolvable from the current host without
  credential or admin-token exposure;
- main-host and development-host eval share one asynchronous handle lifecycle
  and error taxonomy;
- grants bind to the verified initiator/resource and revocation applies on the
  next dispatch;
- EvalDO scope cannot retain or resurrect prior-run authority;
- exact content-addressed source/import bytes and retained executable provenance
  are hashed before execution; mutable paths are never reread behind a digest;
- active EvalDO continuations remain in memory, process/incarnation loss always
  interrupts without replay, and durable state is limited to handles/status,
  immutable source/provenance bundles, scope/data, results, idempotency, grants,
  bounded events, and audit;
- cancellation/deadlines are correct at cooperative boundaries and never claim
  to preempt non-yielding synchronous JavaScript;
- same-scope runs are FIFO, changed-input idempotency conflicts, and adaptive
  authority/challenge/event state is bounded;
- all code-capability leaves have reviewed eval acquisition and new leaves
  default closed through a failing census gate;
- the capability catalog, approval UI, Permissions surface, logs, and run
  inspection explain the same canonical authority records;
- focused unit/property/integration suites, both-plane smoke, desktop/mobile
  e2e, exact headless cases, their categories, and smoke coverage pass; and
- repository search finds no old eval wire shape, ambient full-census eval grant,
  empty delegation construction, service-local shadow approval path, or child
  eval without the typed challenge exchange.

At that point agentic eval is both broadly useful and honestly governed: dynamic
code can reach the system by default, constrained callers can make that reach
exact, sensitive actions stop for a real user decision, and no host or EvalDO
quietly lends authority the verified initiator did not possess or receive.
