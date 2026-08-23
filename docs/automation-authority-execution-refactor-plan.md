# Automation authority and execution refactor

Status: implementation plan. This document defines the replacement architecture
for the current mission/reviewed-closure integration. It is intentionally a
subtractive plan: retain the ordinary authority, runtime, agent, eval, channel,
and approval primitives; remove automation-specific substitutes and repair the
places where conversation identity, user attribution, and execution authority
were conflated.

When this plan lands, it supersedes the automation lifecycle, approval, session,
and authority sections of `docs/mission-subsystem-spec.md`. Historical rationale
may remain there, but it must no longer be described as the implementation spec.

## 1. Decisive outcome

An automation is:

1. a durable, inspectable definition and schedule;
2. one content-addressed standing-authority principal; and
3. a sequence of ordinary, host-admitted executions.

It is not its own capability system, approval system, agent harness, eval path,
conversation type, or session model.

The complete authority-bearing identity of one active automation revision is:

```text
mission:<missionId>@<revisionDigest>
```

Standing grants are issued to that principal by the ordinary authority
acquisition system. At a tick, the host admits one exact execution of that
principal. The admitted execution may use the existing agent and EvalDO paths;
those runtimes do not receive copied grants. Their verified execution-session
facts cause the evaluator to consult the mission principal for the duration of
that exact run.

The implementation is complete only when this sequence works without a channel
lookup or an automation-specific grant issuer:

```text
launch_automation
  -> persist launch intent and immutable preparing revision
  -> compile and publish exact host policy artifact
  -> activate the acknowledged revision
  -> ordinary authority acquisition may issue mission grants

scheduled occurrence
  -> persist one run and one durable workflow
  -> host admits runId for mission:<id>@<digest>
  -> ordinary agent turn
  -> ordinary child EvalDO admission, if requested
  -> ordinary service dispatcher and grant evaluator
  -> ordinary approval fallback, if a grant is missing
  -> durable terminal run result
```

## 2. Why the current shape must be replaced

The current implementation has good foundations but joins them through the
wrong coordinates and owners.

### 2.1 User attribution is treated as permission

`missions.launch` accepts model-authored capability/resource rows. MissionsDO
places those rows in a reviewed closure with no grant dependencies. The host
then issues mission grants and records an attributed user as `decidedBy`, even
though that user did not decide the exact rows through the authority acquisition
system.

Authentication answers which runtime called. User attribution answers which
user owns or initiated its causal chain. Neither is authorization for an exact
capability and resource. Launching a definition may be open and immediate;
minting standing authority must still use the ordinary authority system.

### 2.2 Conversation identity is treated as execution identity

A continuing automation currently binds its reviewed closure with `channelId`
as `sessionId`. Host authority lookup also derives a session key from the
caller's agent-channel binding. This causes two structural faults:

- the same continuing channel cannot be cleanly rebound for its second tick;
- work sharing the channel can be classified under the unattended mission while
  that channel binding is live.

A channel is durable conversation state. A run is a bounded execution. Reusing
the former must never inherit the latter's authority.

### 2.3 Cross-owner work is called atomic without a durable commit protocol

Launch installs host authority before committing the mission record. Edit
suspends the old authority before installing and committing the new revision.
Run startup advances the schedule, then performs a chain of remote effects with
no replayable phase machine. `try/catch` compensation covers returned failures,
not process loss or ambiguous RPC completion.

### 2.4 The automation compiler duplicates runtime knowledge

Hardcoded service and userland-service lists describe what the ordinary agent,
channel, workspace provider, blob store, credential path, and EvalDO happen to
need. These lists are neither the runtime's sealed declaration nor the user's
action policy. They are a second dependency catalog, and recent omissions were
the expected failure mode.

### 2.5 The public model exposes internal authority representation

The agent is instructed to copy method exposure, capability names, resource
scopes, and tiers into separate fields. This asks a language model to keep two
security-sensitive projections synchronized. Documentation cannot make that a
sound authority boundary.

### 2.6 The state model retains abandoned product concepts

`draft`, `needs-reapproval`, `mission_proposals`, optional immutable source
references, critical-valued standing permission rows, and reviewed-closure
session records remain after the product moved to immediate launch. These dead
concepts obscure the active invariants and preserve invalid states.

## 3. Normative ownership

This plan owns automation composition and the deltas needed in the existing
subsystems. It does not fork their contracts.

| Concern                                             | Owning subsystem/document                                   | Automation delta                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Caller authentication and user attribution          | host identity and `AuthorizationContext`                    | Require one canonical host-normalized `actingUser` for user-delegated mutations           |
| Grants, tiers, acquisition, approval, re-evaluation | `docs/authority-acquisition-spec.md` and authority services | Add durable target-subject requests for mission principals; retain invocation rendezvous  |
| Execution admission and causal execution            | execution-session registry, agent loop, EvalDO, method host | Generalize the EvalDO-specific fact into one executor-discriminated parent/child contract |
| Tool and service structural reach                   | ordinary agent tool registry and eval authority manifest    | Compile an automation operation policy into these existing bounds                         |
| Runtime/code identity                               | runtime entity graph and sealed build authority manifest    | Stamp an exact execution image; derive infrastructure from sealed runtime facts           |
| Conversation state and transcript                   | channel service and agent loop                              | Reuse channels only for history/routing; never as an authority key                        |
| Definitions, schedules, revisions, run ledger       | MissionsDO                                                  | Remain the single durable automation/workflow owner                                       |
| Trusted approval and inspector surfaces             | shell approval UI and Automations panel/cards               | Present capability approvals and durable automation state, never a generic launch review  |

## 4. Target concepts

### 4.1 Automation principal

Every behaviorally distinct automation revision has exactly one
standing-authority subject:

```text
mission:<missionId>@<revisionDigest>
```

- `missionId` is stable product identity and prevents two identical definitions
  from sharing authority.
- `revisionDigest` closes over every behavior-bearing field and makes authority
  lapse when behavior changes.
- Display name, timestamps, current UI selection, run counters, and lifecycle
  state are not digest inputs.
- No agent, channel, provider, or harness receives a duplicate of the mission's
  standing grants.

The digest uses an explicit domain/schema version and canonical JSON over:

- exact execution image;
- executable action (prompt, eval source, or method and arguments);
- fresh/continue conversation behavior, excluding concrete per-run IDs;
- trigger, cadence, timezone, jitter, and completion policy;
- compiled operation-policy digest;
- context/data-flow constraints that affect authority.

Display name, non-executed summary copy, owner/device provenance, lifecycle
state, revision number, timestamps, current channel history, and run counters
are excluded. A display-only edit may create a new informational revision while
retaining the same authority digest and mission principal.

### 4.2 Generic execution admission

One automation tick receives one host-minted execution admission. This is a
generic execution relationship fact with a mission mode, not a new capability
token. The current `AgentExecutionSessionFact` is not yet that primitive: it
requires an EvalDO `runtimeId`, `runId`, and authority manifest and its registry
is indexed and renewed by that eval runtime. Phase 0 must replace/normalize it,
not pretend that the current shape can directly admit agent turns and methods.

The common semantic fields are:

```ts
interface ExecutionAdmissionFact {
  v: 2;
  authoritySessionId: string; // host-minted generic execution-session id
  authoritySessionVersion: number;
  admissionKey: string; // deterministic idempotency identity
  mode: "mission";
  ownerUser: `user:${string}`;
  workspaceId: string;
  contextId: string;
  taskRef: string; // exact runId
  taskAuthority: `task:${string}`; // exact run-scoped grant subject
  mission: {
    subject: `mission:${string}@${string}`;
    missionId: string;
    revision: number;
    revisionDigest: string;
  };
  executionImage: ExecutionImage;
  operationPolicyDigest: string;
  executor: ExecutorBinding;
  leaseOwner: { runtimeId: string; executorKind: ExecutorBinding["kind"] };
  parent: { authoritySessionId: string; nonce: string } | null;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

type ExecutorBinding =
  | {
      kind: "agent-turn";
      runtimeId: string;
      entityId: string;
      channelId: string;
      turnId: string;
    }
  | {
      kind: "eval";
      runtimeId: string;
      evalRunId: string;
      authorityManifest: EvalAuthorityManifest;
    }
  | {
      kind: "method";
      runtimeId: string;
      invocationId: string;
      service: string;
      method: string;
    };

interface ExecutionAdmissionRecord {
  fact: ExecutionAdmissionFact;
  state: "live" | "closing" | "terminal";
  childAdmissionIds: readonly string[];
  terminalReason?: "finished" | "cancelled" | "interrupted" | "expired";
}
```

This is the successor to `AgentExecutionSessionFact`, not a parallel automation
transport. Interactive/test/eval facts become variants of the same versioned
contract. Each variant binds an authenticated runtime/object identity and the
exact executor-specific coordinate needed to prevent replay.

Admission has a deterministic idempotency key over mission subject, durable run
ID, executor kind, and exact executor coordinate. The host registry owns the
live lease; the authenticated executor lifecycle renews it. A child is minted
only from a live verified parent, carries an explicit parent coordinate, and
cannot outlive or widen it. A parent close first fences new child derivation,
then waits for or explicitly cancels its children before becoming terminal.
Finish, cancellation, interruption, and closure are idempotent.

The host accepts a root mission fact only from the authenticated MissionsDO run
workflow. It accepts child facts only through the generic causal derivation API
from a live parent. Callers cannot add or replace them in eval arguments,
channel messages, or direct RPC payloads.

`expiresAt` is an attestation/lease boundary, not a maximum automation-run or
human-response duration. The generic execution-session owner renews a live or
legitimately parked admission. If that owner cannot recover or renew it, the run
becomes honestly interrupted; authority must never silently fall back to a
channel lookup or an unbounded timeless fact.

### 4.3 Generic principals used during a run

The evaluator may consult these ordinary subjects:

- `mission:<id>@<digest>` for standing automation authority;
- `task:<...runId...>` for an approval covering this run;
- `session:<authoritySessionId>` for exact/critical confirmation;
- the authenticated origin required by the receiver policy.

The code principal remains an execution identity and structural constraint. A
user principal remains ownership/administration context. Neither is ambiently
unioned into the mission's authority.

### 4.4 Execution image

Replace duplicated `harness` and `target` identity with one canonical value:

```ts
interface ExecutionImage {
  source: string;
  ref: `state:${string}`;
  effectiveVersion: string;
  className: string;
  objectKey: string;
}
```

The native `launch_automation` tool stamps the current agent's image from its
verified runtime environment. The model never supplies these coordinates.
Lower-level method automation validates an explicitly selected exact image.

`ref` is required in the current schema. Historical definitions without one
are migrated or archived; optionality must not remain in the live type.

### 4.5 Operation policy

Replace separate model-authored `toolExposure` and `permissions` projections
with one semantic operation declaration. Its exact API should reuse the
existing authority preflight invocation vocabulary:

```ts
interface AutomationOperationIntent {
  service: string;
  method: string;
  args?: readonly unknown[]; // when stable and known
  resource?: ResourceScope; // bounded policy for dynamic arguments
  use: "action" | "conditional";
}
```

The host-owned compiler resolves each intent against live, sealed method
metadata and produces an immutable operation policy containing:

- exact structurally exposed methods or agent tools;
- receiver capability and resource derivation;
- tier and mission-grant eligibility;
- network origin bounds;
- resolved userland provider identities where relevant;
- the canonical digest consumed by execution admission;
- authority acquisition requests for eligible standing grants.

Action userland providers are resolved and pinned to exact provider identity and
build in the revision. Active automations do not use `follow-head`, live
workspace-service discovery, or unresolved service names for action reach. A
provider update is a behavior change and produces a new authority digest.

Network reach and expected external-data lineage are derived from the declared
operations and receiver/provider metadata. If a prompt action needs a semantic
source not mechanically derivable, it declares that source through a small
public intent vocabulary; it does not author internal `lineageClasses`,
`evalNetwork`, or host capability fields directly.

The agent does not type capability names or tiers. The compiler rejects an
unknown method, an underivable resource, an unresolved provider, a global
wildcard, or a permission request that is broader than the declared operation.

Prompt actions with genuinely dynamic tool choice declare a bounded policy
envelope. Inline eval and method actions should normally declare exact
operations. The inspector renders the compiled policy, not the model's prose
alone.

#### 4.5.1 Canonical policy artifact

The digest is not self-authenticating and MissionsDO is not the authoritative
owner of the compiled body. The host authority/runtime layer owns a generic,
durable, content-addressed operation-policy artifact store. It is writable only
through the in-process host compiler boundary, never by MissionsDO or another
userland RPC caller. Before a revision can become admissible, the host compiler
writes an immutable artifact keyed by its canonical digest containing:

- policy schema and canonicalization version;
- compiler version;
- capability/method/tool catalog digest and resolved provider/build identities;
- the complete canonical operation-policy body; and
- compiler provenance sufficient for the host to recognize the artifact as its
  own output.

Admission receives only the digest/reference and resolves the body from this
trusted host-owned store; successful lookup proves that the host compiler
accepted that exact body. If an artifact crosses a trust/storage boundary, the
reference additionally carries a host-verifiable compiler receipt. Admission
never trusts a policy body supplied by MissionsDO and never recompiles an old
revision against current catalogs. Compiler/catalog changes that alter meaning
require an explicit new artifact and revision/migration.

Artifact publication is content-addressed and idempotent. MissionsDO retains
semantic operation intents and the acknowledged artifact reference in the
revision; its outbox reconciles publication before making that revision
admissible. Live revisions, historical runs, active grants/acquisitions, and
audit-retained revisions are garbage-collection roots. The host deletes an
unreferenced artifact only after the ordinary audit-retention window and a
grace period, so restart, rollback, and historical inspection remain
deterministic.

### 4.6 Infrastructure relationships

The ordinary agent runtime's internal calls are authorized by its sealed code
manifest plus host-authenticated runtime relationships. Examples include its
own channel connection, workspace context, blob-backed prompt storage, eval
child lifecycle, and configured model credential route.

These are not user-selected action authority and must not be represented as
durable mission grants marked `decidedBy: user`.

Delete the term and mechanism “system-derived harness grants.” If a generic
evaluator representation is required for an infrastructural relationship, it
must be a host-derived, task-scoped relationship fact or grant whose provenance
is `system/relationship`, constrained to the exact run resources. It must not
be persisted as standing mission consent.

An operation that is genuinely sensitive to the user remains an action
capability even when runtime code performs it. Calling it infrastructure does
not lower its tier.

## 5. Authority semantics

### D1. Only the authority subsystem issues standing grants

MissionsDO may request authority acquisition for a target mission subject. It
must not call `CapabilityGrantStore.issue`, nor send raw grants to another
service that does so on the basis of attribution.

The authority service gains or formalizes one generic operation:

```ts
authority.acquireForSubject({
  subject: missionSubject,
  sourceExecution: currentExecutionProof,
  operationPolicyDigest,
  scope: "mission",
});
```

The exact API may be an acquisition batch rather than this spelling. It must:

1. resolve capability and resource from receiver metadata;
2. validate that the capability is mission-grantable and non-critical;
3. reuse a qualifying existing grant only under an explicit delegation rule;
4. otherwise create the ordinary trusted approval acquisition;
5. issue the grant to the exact mission revision after approval;
6. record the real acquisition/decision provenance; and
7. return durable grant or acquisition references for inspection.

User attribution is necessary to route ownership and approval. It is never
sufficient to settle the acquisition.

`sourceExecution` is a live, expiring authorization to create the request; it
is consumed at initiation and is never stored as the future proof of consent.
The authority subsystem freezes and validates the target subject, compiled
policy artifact, derived capability/resource leaf, allowed decisions, owner,
and workspace while that proof is live.

The current acquisition contract cannot satisfy this operation unchanged. Its
pending rendezvous is in-memory, keyed partly by originating runtime, and
`awaitDecision` is restricted to that runtime. Add a generic durable
target-subject request record owned by the authority subsystem:

```ts
interface DurableAuthorityRequest {
  v: 1;
  requestId: string;
  requestKey: string; // digest(target subject + policy artifact + operation leaf)
  targetSubject: `mission:${string}@${string}`;
  targetLifecycle: { kind: "mission-revision"; missionId: string; revision: number };
  operationPolicyArtifactRef: string;
  operationPolicyDigest: string;
  operationLeafDigest: string;
  capability: string;
  resource: ResourceScope;
  allowedScopes: readonly ("run" | "mission")[];
  ownerUser: `user:${string}`;
  workspaceId: string;
  state: "pending" | "settled" | "closed";
  decision?: {
    effect: "allow" | "deny" | "dismiss";
    scope?: "run" | "mission";
    grantSubject?: `task:${string}` | `mission:${string}@${string}`;
    decisionRef: string;
  };
  createdFromExecutionRef: string; // audit coordinate, not a renewable proof
}
```

This extends ordinary acquisition; it is not an automation approval queue. The
authority store owns the record and the normal approval queue is its
idempotent presentation. MissionsDO keeps only the request reference in its
outbox/projection. Recreating the presentation after process loss uses the
stable request key and cannot create a second semantic request or card.

Settlement authenticates the deciding user and validates the frozen request
against the still-existing target subject and canonical policy artifact; it
does not depend on the launch runtime remaining alive. Approval mints the
ordinary grant and records its decision provenance before marking the request
allowed. Denial is durable. Retirement or supersession closes unresolved
requests. A later admitted invocation that proves the same target subject and
operation leaf may join/observe this request despite having another runtime ID;
it cannot alter or settle it. `authority.awaitDecision` therefore needs a
generic target-request join/observe form authorized by the current execution
admission, while its existing exact-runtime form remains appropriate for
invocation-scoped rendezvous.

A launch-time request has no run subject, so it offers mission-scope allow,
deny, or dismissal only. Once a live run joins, policy may additionally offer an
allow for that exact task subject. A run-only choice settles that waiter and
closes the standing request without minting mission authority; a future run may
therefore ask again. A mission-scope choice settles every matching waiter and is
replayed through the durable mission grant/denial. Critical requests never use
this standing-request form.

### D2. Launch is immediate; capability approval is not an automation review

The definition and institution pill are committed without a generic review
step. Launch also submits the compiled standing-authority acquisition batch.

- If no gated authority is needed, launch is immediately ready.
- If authority is already covered by a valid delegable decision, it is issued
  without another prompt according to ordinary authority policy.
- If an exact capability decision is needed, the normal capability approval is
  shown. The automation remains created and inspectable; the approval is not a
  gate on whether the definition exists.
- The inspector shows pending authority explicitly.
- A run reaching the same operation joins the durable target-subject request by
  its stable request key; runtime identity is a waiter coordinate, not consent
  identity, and it must not create duplicate cards.

There is no `automation.setup`, proposal card, or second chat approval.

Seeded product automations use this same principal, operation-policy, and run
admission model. Their standing grants, if any, come from explicit signed
product policy provenance rather than fabricated user attribution. “Seeded” is
definition provenance, not a second authority or execution mode.

### D3. Run-time fallback uses ordinary acquisition

For a service call inside an admitted automation run:

1. Verify the caller and execution-session attestation.
2. Verify that the operation is inside the compiled operation policy.
3. Evaluate ordinary subjects, including the exact mission and task subjects.
4. If a matching mission grant exists, execute.
5. If a gated grant is missing, create or join the ordinary acquisition and
   park the call.
6. On approval, re-evaluate the exact invocation from scratch.
7. On denial, return a typed denial to the eval/agent.

The approval surface may offer, when policy permits:

- **Allow this run**: issue to the run's task principal;
- **Always allow this automation**: issue to the exact mission revision;
- **Deny**: settle the exact acquisition negatively.

Critical authority is exact-invocation/session scoped and is never offered as
standing automation authority.

### D4. Structural policy cannot be widened by approval

Missing authority and missing structural reach are different conditions.

- A missing grant inside the operation policy is acquirable.
- An operation outside the policy is rejected as an automation-definition
  mismatch. Approval cannot silently modify the definition.

Because operation policy and standing-authority planning come from one source,
the common “exposed but forgot the permission row” mismatch disappears. Dynamic
prompt actions still need a deliberately bounded policy.

### D5. Revocation is ordinary and immediately effective

Revoking a mission grant removes it from subsequent evaluation. A currently
parked or retried call re-evaluates and observes the revocation. Future runs
continue under the same definition and may ask again unless a durable denial or
ordinary authority restriction applies.

Pausing changes admission eligibility only. It preserves the same revision,
mission principal, standing grants, pending acquisitions, and durable denials;
resume therefore needs no fabricated reacquisition unless ordinary authority
expired or was independently revoked while paused.

Retiring a mission or switching to an authority-changing revision makes the old
subject unavailable for new admission. An already-admitted run retains its exact
revision until it terminates or is explicitly cancelled. Old grants and pending
requests are retired only after no live run remains admitted under that subject.
Editing never changes the meaning or authority of an in-flight run. A
display-only revision that retains the authority digest also retains the same
principal and consent.

## 6. Execution semantics

### D6. Run authority is admitted once and propagated causally

MissionsDO requests one host execution admission after durably recording the
run. The host validates:

- the authenticated issuer is the canonical automation workflow owner;
- the request is a host-authenticated admission statement from the owner that
  already validated the active revision in its durable transaction;
- the revision digest and operation-policy digest match;
- the execution image is exact and resolvable;
- the code/runtime relationship is valid;
- the owner and workspace are consistent.

The resulting opaque admission identity is attached to the scheduled agent
turn or method invocation. It is not reconstructed from channel, context,
object key, or user fields downstream.

The generic admission API takes an executor-discriminated binding and has one
idempotency key per durable run/executor. The authenticated executor runtime is
the lease-renewal owner; MissionsDO is the durable workflow issuer, not a fake
runtime heartbeat. Root admission, causal child derivation, renewal, and
terminal closure are methods of the same registry and protocol. Parent closure
prevents new children and terminalizes any child that cannot complete
independently. This contract must exist before agent-turn, eval, and direct
method execution are migrated; no executor may carry mission authority in an
ad-hoc payload while waiting for it.

### D7. Child eval admission comes from the verified parent execution

When an admitted scheduled agent calls `eval.start`, EvalService reads the
parent execution session from the authenticated caller/causal RPC context. It
creates an `eval` child variant of `ExecutionAdmissionFact` carrying the same
mission and task facts plus a new exact eval run identity.

Eval arguments cannot select `mode: mission`, a mission subject, task
authority, owner user, or operation policy. Any supplied copies are rejected.

Downstream eval calls use the existing dispatcher, authority evaluator,
acquisition coordinator, context-integrity constraints, and run manifest.

### D8. Channels carry no mission authority

`channelId` remains in:

- conversation configuration (`fresh` or `continue`);
- agent binding and authenticated routing;
- context-integrity provenance;
- transcript/run links.

It is removed from:

- reviewed-closure or mission-principal lookup;
- authority-session identity;
- task authority derivation;
- mission execution mode selection.

Two sequential continuing ticks use two run admissions over one channel.
An interactive turn concurrent with a scheduled tick has its own execution
session and no mission subject.

### D9. Method and agent automations use one authority model

A method automation is not exempt from mission semantics. It executes exact
code under the same run admission and mission principal as an agent action.
The sealed code manifest constrains what the method may call; the mission/task
subjects authorize those calls.

Remove the rule that method automations must have `permissions: []` because
they use unrelated installed code authority. There will be no `permissions`
field, and both action kinds use the compiled operation policy.

### D10. Existing agent and eval machinery remains canonical

Scheduled prompt actions enter the ordinary durable agent turn loop. Scheduled
inline eval enters the same ordinary eval invocation/journal path. Automations
must not add:

- another evaluator;
- another sandbox;
- another tool executor;
- another channel message path;
- another approval queue;
- a timer or poll loop outside MissionsDO;
- a second run ledger.

## 7. Durable definition and revision workflow

### D11. MissionsDO remains the single workflow owner

MissionsDO owns:

- current automation records;
- immutable revisions;
- schedules and occurrence admission;
- semantic operation intents and acknowledged operation-policy references;
- run workflow phases;
- run results and failure projections;
- idempotency records;
- the outbox of remote effects it must reconcile.

The host policy store owns canonical compiled policy artifacts. The authority
store owns durable target-subject requests, decisions, and grants. The runtime
registry owns live execution admissions. MissionsDO owns references and
workflow effects, never copies that become competing sources of truth.
Cross-owner operations are sagas driven by the MissionsDO outbox, never claimed
to be one SQLite transaction.

### D12. Commit intent before remote effects

Launch order:

1. Validate and compile the definition in memory without external mutation.
2. In one MissionsDO transaction, allocate `missionId`, store immutable revision
   1 as internally preparing, store the launch idempotency key, and add
   deterministic policy-publication, activation, projection, and authority
   outbox effects.
3. Publish/recover the content-addressed policy artifact idempotently and record
   its host acknowledgement.
4. Point the mission at revision 1 and make it admissible only after the exact
   policy reference is acknowledged.
5. Publish/recover the institution projection idempotently.
6. Submit standing-authority acquisitions idempotently.
7. Reconcile until every required effect is acknowledged or durably failed.

No host policy artifact, grant, or runtime resource may be created before the
durable intent row that names and recovers it. A content-addressed artifact may
be safely replayed; an orphan is collected under the policy-store retention
rules rather than treated as an active revision.

The native tool does not report successful institution until the idempotent chat
projection is acknowledged. If projection delivery fails after the definition
commit, retry resolves the same mission and re-drives the same event rather than
creating another definition.

### D13. Revisions use prepare, switch, retire

Editing creates a new immutable revision and compiled operation-policy digest.
The workflow is:

```text
revision prepared locally
  -> policy artifact publication and acquisition effects recorded
  -> exact policy artifact acknowledged by host
  -> active revision pointer switched in one local transaction
  -> previous subject becomes unreachable from new admission
  -> previous grants/auxiliary projections retired asynchronously
```

Never suspend or revoke the old active revision before the new revision is
locally ready to become the active pointer. A crash at every boundary must
leave either the old revision active or the new revision active, never a
database pointer to an unusable authority state.

Pending capability acquisition does not make the immutable revision invalid.
It is visible as pending authority and run-time calls may join its durable
target-subject request. A missing/unacknowledged policy artifact does make the
revision inadmissible; it is an internal preparation/effect failure, not
permission state.

### D14. Launch and edit idempotency are durable concepts

Rename `mission_proposals` to `mission_launch_requests` or a generic
`mission_idempotency` table. Store the request key in the same transaction as
the allocated mission/revision before remote effects.

Repeated launch returns the same definition and re-drives missing projections.
Repeated edit with the same command identity returns the same revision.
Idempotency must survive process loss and must not depend on a catch block
running.

## 8. Durable run workflow

### 8.1 Run identity

Scheduled occurrence identity is deterministic from the mission, active
revision, and scheduled occurrence time. Alarm replay therefore admits the
same run instead of allocating duplicates. Manual runs use the caller's command
idempotency identity.

`runId` is the durable workflow/task reference. `authoritySessionId` is the
host-minted execution admission coordinate. `channelId` is neither.

### 8.2 Run phases

Replace the underspecified `starting | running` model with explicit recoverable
phases and terminal outcomes. A suitable normalized model is:

```ts
type RunPhase =
  | "admitted"
  | "execution-admitting"
  | "context-preparing"
  | "executor-preparing"
  | "dispatching"
  | "executing"
  | "waiting-authority"
  | "terminal";

type RunOutcome = "succeeded" | "failed" | "skipped" | "interrupted" | "cancelled";
```

The exact storage may combine these into a discriminated union. It must not
represent `waiting-authority` as generic running, and a terminal row must carry
exactly one outcome.

### 8.3 Replayable effects

Each remote step has a deterministic effect identity and durable acknowledgement:

- admit execution session;
- prepare or select context;
- create/activate channel for fresh mode;
- activate exact executor;
- subscribe fresh agent to channel;
- dispatch prompt/eval/method action;
- publish run projection;
- finish execution admission;
- publish terminal or attention notification.

Effects must be individually idempotent at their receiver. The workflow may
retry an ambiguous effect; it may not infer success from elapsed time.

### 8.4 Recovery

On activation and alarm, MissionsDO reconciles every nonterminal run before
admitting later work for the same mission.

- If dispatch was durably accepted, query/rejoin the existing executor result.
- If a durable agent turn remains open, let the ordinary agent driver recover it.
- If an EvalDO run was interrupted by host restart, record `interrupted` using
  its canonical terminal evidence; do not blindly rerun side effects from the
  top.
- If an effect was never accepted, redrive it with the same identity.
- If exact runtime source is permanently unavailable, fail the run with a
  structured reason and pause future scheduling only according to an explicit
  failure policy.

No `starting` or `running` row may remain forever merely because the owning
process died between awaits.

### 8.5 Waiting for authority

When acquisition parks a call, the execution owner emits a durable phase
transition containing the acquisition ID and exact invocation reference.
MissionsDO projects the run as `waiting-authority`; the inspector links to the
ordinary approval surface.

Approval resumes the existing call when the runtime remains live. If the
runtime was interrupted, the run records that interruption honestly. The
durable target-subject request and eventual grant/denial survive the runtime and
host process, so an explicit subsequent run joins or replays the same semantic
decision without duplicating the question. The live invocation waiter itself is
not misrepresented as durable.

### 8.6 Non-overlap and schedules

Retain one active nonterminal run per mission. A due occurrence during an
active run creates a visible `skipped` terminal occurrence. Waiting for
authority counts as active and therefore does not create overlapping work.

Advance the schedule in the same transaction that admits the deterministic
occurrence. Preserve existing interval, cron, timezone, jitter, `untilAt`,
`maxRuns`, and natural-completion semantics unless an implementation audit
finds a separate defect.

## 9. Identity and ownership

### D15. Normalize acting user once

The host authorization boundary must return one canonical `actingUser` for a
user-delegated call or `null` when no such relationship exists. Domain services
must not each implement precedence across direct subject, authorizing caller,
owner chain, and initiator chain.

- Launch/edit/control invoked from a user-driven turn require canonical
  `actingUser` and workspace membership.
- Scheduled execution uses the mission's stored owner fact; it does not require
  a live authenticated user at 3 a.m.
- Ownership is used for visibility, notifications, and approval routing. It is
  not a grant.
- Missing attribution receives a typed identity/relationship failure, not the
  misleading assertion that the runtime itself is unauthenticated.

### D16. Trusted chrome is an authority relationship

The notification-action error exposed the same architectural smell outside the
mission path: services infer trusted shell behavior from runtime/app shape.
Introduce or reuse one canonical trusted-chrome principal/relationship at the
dispatcher boundary. Notification services declare that requirement; they do
not carry bespoke “shell versus shell app” checks.

This is a small cross-cutting cleanup but belongs in this plan because the
automation UI exercised the defect and because it follows the same rule:
normalize identity once, consume it declaratively.

## 10. Product surface

### D17. Institution pill is a resource projection

The native launch tool publishes one idempotent institution event after the
definition commit. The pill exists before the first tick and opens the exact
automation. It is never an approval card.

The pill and Automations panel show:

- active definition and exact revision;
- action and compiled operation policy;
- standing grants, pending acquisitions, and durable denials;
- cadence, timezone, end policy, and next occurrence;
- fresh/continue conversation behavior;
- current run phase, including waiting for authority;
- bounded recent runs and paged history;
- exact conversation links, results, and structured failures;
- edit, pause/resume, run-now, and retire controls.

Collapsed transcript projections perform no service reads. Active detail views
may subscribe or refresh through one bounded owner API.

Pause prevents new run admission; it does not silently change the authority of
an already-admitted run or revoke standing consent. Resume uses the same
principal and authority state. The surface offers an explicit cancel action for
the current run. Retirement prevents new admission and requests cancellation of
any live run before final cleanup. Editing affects future admissions and leaves
an already-running old revision exact and inspectable until terminal.

### D18. Notifications report durable outcomes

Remove transient “scheduled wake-up is being processed” notifications. Use:

- the channel transcript for durable per-run execution history;
- inbox/interrupt notifications produced by the action for user-facing results;
- a durable attention notification for startup failure, interruption, or
  waiting authority that requires user action;
- the inspector for ordinary running state.

Notification dismissal/action reporting must use the canonical trusted-chrome
relationship and one idempotent report operation.

### Agent documentation and tool contract

The automations skill and API reference must teach only the public semantic
model:

- action, cadence, completion, and fresh/continue behavior;
- operation intents using documented service/tool methods;
- immediate institution and persistent inspection;
- ordinary capability approval and run-time fallback;
- the distinction between waiting authority and failure.

They must not ask the agent to copy capabilities, tiers, resource keys,
lineage classes, provider effective versions, or harness dependencies. The
native tool JSON schema must describe operation intents completely rather than
using opaque `{ type: "object" }` placeholders. Contract tests should reject
examples or prose that reintroduce proposal review, pregranted-only execution,
raw grant rows, or manual runtime identity discovery.

### D19. Update the complete workspace skill and template corpus

The behavior change crosses automation, authority acquisition, execution
inheritance, eval, and notifications. Updating only `skills/automations` would
leave mutually inconsistent agent instructions. Treat workspace skill docs as a
versioned product contract and migrate them in the same coordinated Base/host
release as the schemas they describe.

Before implementation, resolve the exact configured Base checkout and inventory
every `SKILL.md`, linked reference, API reference source, and generated API page
whose prose or examples mention automations/missions, permissions/authority,
approval/acquisition, eval inheritance, agent tool execution, or scheduled
notifications. At minimum the current corpus requires review of:

- Base `skills/automations/{SKILL.md,API.md}`;
- Base `skills/capabilities/SKILL.md` and its authority implementation
  checklist;
- Base `skills/agents/SKILL.md`;
- Base `skills/sandbox/EVAL.md`;
- Base `skills/architecture/SECURITY.md`;
- Base `skills/appdev/CAPABILITIES.md` and `skills/workspace-dev/RPC.md`;
- Base `skills/messaging/SKILL.md` where it describes scheduled results or
  attention notifications; and
- host `skills/vibestudio-agent/{SKILL.md,EVAL.md,API.md}` plus the canonical
  schemas/generator that produce the API page.

This list is a floor, not a closed allowlist. The inventory result is checked
into the implementation evidence so newly added or indirectly linked skill
references cannot be skipped.

The template registry is the authoritative discovery source for optional
workspace templates. Resolve every promoted template at its exact registered
commit and inspect skills, agent/system prompts, service/method authority
metadata, seeded or manifest-declared recurring work, notification behavior,
and examples that could author or execute an automation. Do not search only for
the word `automation`: search the retired schema fields, mission APIs,
`launch_automation`, recurring declarations, scheduled agent turns, provider
bindings, and permission/approval guidance.

The current registered corpus produces these minimum follow-ups:

- **Base template:** update the MissionsDO, agent vessel, inspector/chat UI,
  shell/mobile approval projection, agent/eval runtime, skills, service schemas,
  and both `meta/template.yml` and the generated/current workspace manifest.
- **Google Workspace template:** audit the Google/Gmail operation tables,
  credential-backed provider declarations, method/resource derivation, agent
  skill copy, and tests. Any method intended for an automation must compile to
  an exact pinned provider/policy leaf and ordinary mission-eligible authority;
  template docs must not teach raw pregrants or imply that agent/channel
  identity supplies Google consent.
- **News template:** audit the scheduled briefing/polling worker, its skill, and
  any optional workspace `recurring:` declaration. Migrate host-level standing
  jobs that use the automation system to v2 operation/admission semantics.
  Domain-internal feed polling may remain a worker workflow only when it is
  explicitly not a user-authored mission, does not receive mission grants, and
  does not duplicate the MissionsDO product surface.
- **Examples and Spectrolite templates:** the current snapshots contain no
  automation-system contract found by this audit; record that evidence-backed
  not-applicable result and keep them in stale-schema/terminology checks rather
  than silently omitting them.
- **Template registry:** when a template changes, publish its new immutable
  revision and update the promoted commit/snapshot only after its compatibility
  tests pass. An unchanged/not-applicable template does not receive a synthetic
  release.

New registry entries added before cutover automatically enter this audit. A
template-local scheduler or agent framework is not grandfathered merely because
it uses different vocabulary; classify it by whether it is domain workflow or
the user-facing automation product and remove any accidental parallel authority
path.

The updated corpus must consistently teach:

- launch immediately creates an inspectable automation; there is no proposal or
  generic automation review;
- the agent declares semantic operations, not capabilities, tiers, raw grants,
  lineage internals, or runtime identities;
- launch asks the ordinary authority system for eligible standing consent, and
  a later admitted run may fall back to the same ordinary approval path;
- pending target-subject authority survives the launch runtime and is visible
  from the automation inspector;
- mission/task authority is propagated automatically through authenticated
  parent/child execution admission, including agent -> eval; an agent must
  never discover, copy, or reconstruct it from a channel ID;
- pause preserves consent, revision changes retire old authority after live
  executions finish, and retirement is terminal; and
- transient wake-up chrome is not an execution result; durable run state,
  action notifications, and attention-needed authority UI have distinct roles.

Generated references are regenerated from their canonical service/tool schemas,
never hand-edited. Skill contract tests and a repository-wide stale-vocabulary
check must fail on `propose`, `needs-reapproval`, generic launch approval,
pregranted-only automation execution, raw permission rows, channel-bound mission
authority, or instructions to pass mission/user authority through eval input.

## 11. Schema and vocabulary cleanup

### 11.1 Live automation state

The live definition state becomes:

```ts
type MissionState = "active" | "paused" | "completed" | "retired";
```

Delete `draft` and `needs-reapproval`. Preparation belongs to immutable revision
workflow state, not user-visible mission lifecycle. Failed/pending remote work
belongs to workflow effects and authority projections, not another mission
state.

`paused` may carry a reason such as `user`, `authority-denied`, or
`execution-invalid`, but these reasons do not become new lifecycle states.
Transient model, network, or action failures record a failed run and leave the
schedule active. A permanent execution-image/startup invalidity pauses future
admission. A durable denial of an operation declared mandatory may pause with
`authority-denied`; denial of a conditional operation is delivered to the
action and does not implicitly mutate the schedule.

### 11.2 Revision records

Store immutable, explicitly versioned revision documents. The current mission
row points to one active revision. A revision contains:

- schema version;
- summary and action;
- exact execution image;
- conversation policy;
- trigger and completion policy;
- semantic operation intents;
- compiled operation-policy digest/reference, schema/compiler version, and
  acknowledged host artifact coordinate;
- declared context/lineage policy;
- revision digest.

Do not store model-authored grants or canonical compiled policy bodies inside
the revision. Store grant and durable acquisition references as authority
projections keyed by mission subject; the host stores and authenticates the
compiled artifact body.

### 11.3 Remove inconsistent fields

- Replace `harness` plus duplicate execution `target` with `executionImage`.
- Make immutable source `ref` required.
- Remove `MissionPermission` and its impossible `critical` standing variant.
- Remove model-authored `standingRestrictions`; ordinary authority denials and
  permission policy own restrictions and their provenance.
- Remove public `declaredLineageClasses`, `evalNetwork`, live service discovery,
  and provider-upgrade policy fields; the operation compiler owns their sealed
  projections.
- Remove `harnessUserlandServices` compatibility optionality from the current
  compiled type.
- Replace `active_closure_digest` with the active revision/policy coordinates
  actually needed after the closure registry is removed.
- Rename `mission_proposals` to its real idempotency purpose.
- Remove duplicate `lastRunAt` mapping and any other mechanical duplication
  found during the schema rewrite.
- Add explicit schema/domain versions instead of relying only on hash tag
  strings embedded in digest functions.

### 11.4 Structured failures

Replace the single bounded `error` string as the canonical run failure with:

```ts
interface MissionRunFailure {
  code: string;
  stage: string;
  message: string;
  retry: "automatic" | "manual" | "none";
  invocationId?: string;
  acquisitionId?: string;
  executorId?: string;
  causalEventRef?: string;
  detailsRef?: string;
}
```

The UI may render a bounded message, but the run ledger retains stable causal
coordinates linking to the ordinary trajectory/eval/approval evidence. Do not
copy unbounded or secret-bearing trajectories into the mission database.

## 12. Deletion inventory

Delete, rather than preserve behind compatibility flags, after migration:

### Host

- channel-keyed `reviewed_closure_sessions` and lookup;
- mission authority selection through `factForSession(channelId)`;
- automation-specific closure activation as a grant-minting path;
- `decidedBy` reconstruction inside reviewed-closure and mission services;
- hardcoded automation harness service/userland-service dependency arrays;
- mission-specific structural exposure checks where the ordinary tool registry,
  eval manifest, receiver declaration, and execution admission own the bound;
- automatic mission grants for channel/GAD/workspace plumbing;
- empty or synthetic reviewed-closure `grantDependencies` used as a substitute
  for real acquisition provenance;
- bespoke trusted-shell-app checks in notification action reporting.

If `ReviewedClosureRegistry` has no non-automation consumer at implementation
time, remove the service, schema, database, authority catalog entries, and tests
entirely. If a genuine non-automation consumer exists, rename and reduce it to
that generic responsibility; no mission session binding or grant issuance may
remain in it.

### Workspace/Base

- proposal/review launch code and terminology;
- raw `permissions` input on `launch_automation` and Missions API;
- separate model-authored `toolExposure` plus permission synchronization;
- model-authored standing restrictions, lineage classes, network authority, and
  provider upgrade/discovery policy;
- `compileMissionHarnessGrants` and static harness reach lists;
- `draft` and `needs-reapproval` runtime branches and UI labels;
- `mission_proposals` naming;
- method-automation permission special case;
- channel ID passed as reviewed-closure session ID;
- `pauseForAuthorityDenial` as a substitute for ordinary waiting/denial state;
- transient run-start notification bar;
- documentation that calls a capability approval an automation review or calls
  attribution consent.

### Tests and generated artifacts

Delete tests asserting removed behavior. Replace them with tests of the new
invariants; do not rewrite old tests merely to preserve obsolete paths. Regenerate
authority catalogs, service matrices, schemas, and ledgers from their canonical
declarations.

### Likely implementation map

The implementation audit must confirm the exact set, but the expected primary
owners are:

| Area                 | Current files/components                                                                                                      | Intended change                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Shared mission model | `packages/shared/src/authority/mission.ts`                                                                                    | v2 revision, execution image, operation intents, reduced lifecycle/run unions                                         |
| Closure compiler     | `packages/shared/src/authority/reviewedExecutionClosure.ts`                                                                   | delete mission compiler/static harness lists; retain nothing mission-specific                                         |
| Service schemas      | `packages/service-schemas/src/missions.ts`, reviewed-closure schemas                                                          | replace raw permissions/exposure; add workflow and structured result contracts; remove obsolete closure API if unused |
| Authority resolution | `src/server/services/authorityRuntime.ts`, `src/server/index.ts`, `packages/shared/src/serviceDispatcher.ts`                  | select mission/task subjects from execution admission, never channel lookup                                           |
| Execution admission  | `src/server/services/agentExecutionSessionRegistry.ts`, `src/server/services/evalService.ts`, live caller/attestation helpers | generic executor-discriminated admission, lease/closure, and verified child propagation                               |
| Policy artifacts     | host compiler/catalog owners plus new generic content-addressed host store                                                    | immutable body/provenance lookup, retention roots, and GC                                                             |
| Grant acquisition    | acquisition coordinator, approval queue, `CapabilityGrantStore`                                                               | durable target-subject requests with real provenance, restart recovery, and scope choices                             |
| Reviewed closures    | `src/server/services/reviewedClosureRegistry.ts`, `reviewedClosureService.ts`, schema/database                                | remove automation grant/session responsibilities; delete entirely if no other owner remains                           |
| Automation owner     | `workers/missions/MissionsDO.ts` in Base                                                                                      | immutable revisions, outbox workflow, deterministic runs, no grant minting/channel authority                          |
| Agent integration    | `packages/agentic-do/src/agent-vessel.ts` in Base                                                                             | semantic launch schema, scheduled execution admission propagation, durable wait/terminal projection                   |
| Inspector            | `about/automations`, agentic automation cards/events                                                                          | new definition, authority, phase, failure, and controls model                                                         |
| Workspace skills     | D19 Base/host corpus inventory, canonical API generators, and contract tests                                                  | coordinated operation, authority, inheritance, pause, inspector, and notification semantics                           |
| Optional templates   | template registry, Google Workspace, News, Examples, Spectrolite, and newly promoted templates                                | audit/migrate prompts, operation metadata, recurring work, skills, manifests, tests, and promoted snapshots           |
| Notification trust   | notification service/action reporting and shell bar                                                                           | canonical trusted-chrome relationship and durable attention behavior                                                  |

Generated authority catalogs and matrices are outputs of these source
declarations. Never edit them as the source of the redesign.

## 13. Migration

The migration is one cutover, not a dual execution path.

### 13.1 Preflight inventory

Before changing schemas, record counts of:

- missions by state and schema version;
- active revisions with and without immutable source refs;
- mission-scoped grants and denials;
- compiled policy digests/bodies and the catalog/compiler versions that produced
  them;
- active reviewed closures and unfinished closure sessions;
- nonterminal mission runs;
- pending acquisitions associated with mission executions.

The inventory is diagnostic output, not a permanent compatibility API.

### 13.2 Definition migration

- Definitions with exact source refs are converted to the new revision schema
  and receive a recomputed revision digest.
- `active`, `paused`, `completed`, and `retired` retain their semantic state.
- Historical `draft` and `needs-reapproval` definitions become `paused`; they
  do not silently start.
- Definitions lacking an exact source ref cannot become live v2 revisions.
  Archive their historical record for display/audit and leave a clear recreation
  notice; do not keep `ref?` in the new core type.
- Existing channel/context values remain conversation configuration only.
- Device ID, when retained, is creation/audit provenance rather than an
  authority owner or visibility key. The owning user remains canonical across
  devices.

### 13.3 Admission fence and run migration

Cutover ordering must preserve the authority needed by every still-live
execution:

1. Atomically fence creation of new old-protocol mission admissions while
   keeping their existing execution sessions and grants valid.
2. Transform terminal history into the new terminal outcome shape.
3. Mark every nonterminal old channel-bound run `interrupted:migration`, request
   executor cancellation, and finish its reviewed-closure/execution session
   idempotently.
4. Verify that no live execution remains admitted under an old mission subject.
5. Preserve channel/context links solely as history.

Do not revoke a grant or remove closure state before step 4. Migration does not
rely on revocation to stop new work; the admission fence does that explicitly.

### 13.4 Definition, policy, and authority migration

Existing mission grants were issued through the attribution-based closure path
and therefore do not have the required acquisition provenance. Do not silently
translate them into new standing grants.

For every migrated mission, while v2 admission remains fenced:

1. compile operation intents from stored action/tool declarations only where
   exact and mechanically derivable;
2. publish and acknowledge the canonical host policy artifact, then prepare the
   v2 revision reference;
3. after §13.3 proves old sessions terminal, revoke the old closure grants once
   and retire unresolved old requests/closure state;
4. create durable ordinary authority requests for eligible standing operations
   of migrated active missions;
5. enable v2 admission only when its revision and policy artifact are exact;
6. leave the mission inspectable and allow ordinary run-time fallback while a
   new request is pending.

Where an old declaration cannot identify an exact operation/resource, omit the
standing request and surface that fact. Do not infer a wider scope. Paused
missions retain their paused lifecycle through migration, but legacy grants are
still retired because their provenance and subject model changed; resuming
later uses the migrated revision's ordinary authority state.

### 13.5 Store removal

After old admissions are fenced, all old sessions are terminal, legacy grants
were revoked once, and new policy references are acknowledged:

- assert that the reviewed-closure registry has no live mission records, then
  remove its terminal migration rows;
- assert that no legacy mission grants remain rather than issuing a second
  semantic revocation;
- drop the channel binding table;
- remove obsolete mission columns/tables in the next canonical DO schema;
- delete migration code after the supported migration window, according to the
  repository's normal schema-migration policy.

## 14. Implementation phases

Each phase is an architectural vertical slice. Do not ship a flag selecting old
versus new authority semantics.

Host and Base changes use one incremented execution/admission protocol version
and ship as a coordinated workspace release. The upgraded host migrates durable
state before accepting the new Base automation calls and rejects an old
channel-bound mission admission explicitly. Do not maintain both semantics in
one running system.

### Phase 0 — Freeze invariants and update owning contracts

1. Mark this plan as the automation implementation owner.
2. Update the authority acquisition spec with a durable target-subject request
   identity/lifecycle, restart settlement and replay, join authorization, and
   run/mission approval choices. Keep exact-runtime invocation rendezvous as a
   distinct variant of this one generic acquisition contract.
3. Define the generic execution-admission v2 schema: executor-kind union,
   authenticated runtime/object binding, idempotent admission key, causal child
   derivation, renewal owner, and terminal closure. Specify the migration of
   `AgentExecutionSessionFact`, not an automation side transport.
4. Define the versioned revision and canonical operation-policy artifact
   schemas, host store ownership, compiler/catalog provenance, lookup,
   retention, and garbage collection.
5. Specify the admission-fence -> terminalize sessions -> revoke legacy
   authority migration order.
6. Add compile-time/dependency tests preventing channel IDs from entering
   mission authority APIs.

Exit evidence:

- one canonical schema for each new record, executor path, and policy artifact;
- no unresolved question about principal selection, grant provenance, or run
  identity, lease ownership, request recovery, or policy lookup;
- deletion inventory mapped to concrete files and generated artifacts.

### Phase 1 — Generic causal execution admission

1. Generalize the existing EvalDO-specific execution-session registry/fact into
   `ExecutionAdmissionFact` and its executor-discriminated bindings.
2. Add idempotent root admission, causal child derivation, executor-owned lease
   renewal, and idempotent terminal closure.
3. Add issuer validation for MissionsDO root admission.
4. Propagate the opaque admission through scheduled agent turns and direct
   method invocations.
5. Admit child EvalDO runs from the verified parent execution admission.
6. Change dispatcher/eval mission subject selection from channel lookup to the
   execution-session fact.
7. Add generic task/run authority and waiting-state event propagation.

Exit evidence:

- two continuing ticks execute on one channel with different run admissions;
- an interactive eval on that channel cannot observe mission grants;
- fresh and continuing prompt/eval actions use the same admission primitive;
- agent-turn, eval, and method variants authenticate their exact executor and
  reject cross-kind replay;
- spoofed mission/run fields are rejected.

### Phase 2 — Operation-policy compiler and ordinary acquisition

1. Define semantic operation intents in native launch and lower-level APIs.
2. Resolve method/tool metadata through the canonical catalogs.
3. Compile ordinary agent tool bounds and eval authority manifests into a
   versioned canonical artifact.
4. Add the host-owned content-addressed artifact store, authenticated lookup,
   pinned compiler/catalog metadata, retention, and garbage collection.
5. Add durable target-subject acquisition for the mission principal and
   restart-safe projection through the ordinary approval queue.
6. Implement run-only and always-for-this-automation approval choices.
7. Remove raw permission rows from agent input and mission records.
8. Move infrastructural calls to sealed runtime relationship/manifest policy.

Exit evidence:

- model-authored capability names cannot mint grants;
- open operations launch without authority UI;
- gated operations use ordinary acquisition and real provenance;
- critical operations remain invocation-scoped;
- missing standing authority parks and resumes a run;
- outside-policy operations cannot be approved in place.
- a host restart neither loses a pending target request nor causes policy
  recompilation/card duplication.

### Phase 3 — Durable definition and run workflows

1. Introduce immutable v2 revisions and active revision pointers.
2. Commit launch/edit intent and idempotency before remote effects.
3. Add outbox effects for policy publication, activation, acquisition, and
   projection reconciliation.
4. Introduce deterministic scheduled occurrence/run IDs.
5. Add recoverable run phases and structured failures.
6. Project waiting authority from the execution/acquisition lifecycle.
7. Make finish/cancel/interruption callbacks idempotent and admission-bound.

Exit evidence:

- fault injection after every durable/remote boundary leaves recoverable state;
- no orphan authority appears after launch failure;
- edit never disables the old revision before the new pointer can commit;
- no nonterminal row remains stranded after owner restart;
- repeated alarm and command delivery create one semantic run.

### Phase 4 — Schema cutover, UI, and documentation

1. Run the one-time definition, authority, run, and closure migration.
2. Update Automations and transcript cards to the new state/projection model.
3. Add pending-authority and structured-failure inspection.
4. Complete D19's Base/host/registered-template inventory; update every relevant
   skill, prompt, manifest, operation descriptor, and linked reference, then
   regenerate API docs from canonical schemas.
5. Add skill contract/stale-vocabulary checks covering immediate launch,
   ordinary fallback, causal authority inheritance, and pause semantics.
6. Update notification action trust to the canonical chrome relationship.
7. Remove obsolete states, tables, fields, services, docs, and generated entries.

Exit evidence:

- no product surface contains proposal/review language for launch;
- no live schema accepts old raw permission or optional source-ref shapes;
- migrated authority is re-acquired rather than silently trusted;
- every D19 inventory entry is updated or carries an evidence-backed
  not-applicable classification, and generated skill APIs match live schemas;
- every changed optional template passes against the coordinated protocol and
  is promoted through an exact registry commit/snapshot only after publication;
- repository search finds no channel-keyed mission authority path or dead state
  branch.

### Phase 5 — Adversarial and system acceptance

Run focused conventional tests throughout. Then exercise the complete product
through the repository's self-provisioning system-test route.

Required acceptance scenarios:

1. Immediate open-only notification automation; institution pill precedes the
   first tick and the tick produces its durable result.
2. Gated operation approved “always for this automation”; later ticks settle
   from the exact mission grant.
3. Gated operation omitted from standing acquisition but inside operation
   policy; the tick becomes waiting-authority, approval resumes it, and the UI
   never reports a generic hang.
4. Critical operation requests exact approval on every distinct invocation.
5. Denial reaches eval/agent as a typed error and produces a structured run
   outcome without corrupting the schedule.
6. Two continuing ticks share history but not execution authority.
7. A concurrent interactive turn in the same channel cannot exercise mission
   grants.
8. A fresh tick gets isolated context/channel state and the same mission
   principal semantics.
9. Agent prompt -> eval -> gated service call retains the exact run/mission
   attestation without any channel lookup.
10. Method automation uses the same mission/task authority model.
11. Revoking a mission grant affects the next evaluation and a parked retry.
12. Editing changes the principal digest; old grants do not authorize the new
    revision.
13. Pausing prevents new admission while preserving standing grants and pending
    requests; resuming the unchanged revision does not reacquire or fabricate
    consent.
14. Host restart during approval wait interrupts any live executor honestly,
    preserves the durable target-subject request, rebuilds at most one card, and
    lets a later matching run join/replay it.
15. Process loss at every launch, edit, and run effect boundary reconciles
    idempotently.
16. An agent/code caller invoking the lower-level launch API with fabricated
    capability rows cannot mint authority.
17. A forged channel ID, mission subject, task subject, or parent execution ID
    is rejected at host admission.
18. Migrated active definitions remain inspectable and reacquire standing
    authority through the standard path.
19. Migration fences old admission, terminalizes every old session, and only
    then revokes legacy grants/removes closure rows.
20. Admission after host restart resolves the exact stored policy artifact; a
    missing, forged, or current-catalog-recompiled body is rejected.

### Phase 6 — Coordinated multi-repository publication

1. Synchronize each changed host, Base, and optional-template branch with its
   remote integration branch before the final commit; resolve conflicts in the
   canonical schema/contract owner rather than adding compatibility shims.
2. Commit and push host and Base protocol changes as one declared compatibility
   release. Source may land separately, but no production cutover may expose a
   host/Base protocol mismatch.
3. After Phase 5 passes on the exact coordinated revisions, commit and push each
   affected optional template against that protocol. Do not republish
   evidence-backed not-applicable templates.
4. Publish immutable template revisions, then update and push the registry's
   promoted commits/snapshots last.
5. Read back every remote commit, tag/artifact, Base revision, and registry
   snapshot and verify it equals the locally accepted content.

If synchronization introduces a change inside the tested blast radius, rerun
only the affected checks and exact system scenarios. Do not claim publication
complete from a local commit or push response alone.

## 15. Required testing strategy

### Pure/unit

- canonical revision and operation-policy digests;
- operation-policy artifact provenance, catalog/compiler version pinning,
  lookup, retention roots, and garbage collection;
- mission principal construction and version separation;
- operation intent -> method metadata -> capability/resource compilation;
- standing eligibility and critical rejection;
- schema discriminated unions and migration transforms;
- schedule occurrence/run identity;
- derived UI status from run phase/outcome.

### Authority integration

- subject-targeted acquisition provenance;
- durable request dedupe/join across runtime IDs and host restart;
- settlement after source-execution expiry and closure on revision retirement;
- task versus mission versus exact-session grant selection;
- lineage/resource constraint enforcement;
- grant withdrawal and denial precedence;
- execution-session mission subject inclusion only in mission mode;
- child admission equality with parent mission/task facts;
- executor-kind authentication, admission idempotency, lease renewal, and
  parent/child terminal closure;
- action policy enforcement before acquisition.

### Workflow/fault injection

Inject loss before and after every remote effect acknowledgement. Restart the
owner and prove convergence. Cover launch, edit, pause/resume, retire, scheduled
admission, fresh context/channel creation, executor activation, dispatch,
approval wait, terminal callback, and notification projection.

Include a cutover fault matrix proving that new old-protocol admissions are
fenced before any legacy revocation, and that no legacy grant is revoked while
an admitted old execution remains live.

### Workspace skill and template contracts

- inventory all relevant Base and host skill files using D19's concept search;
- verify every linked reference was considered, not only each top-level
  `SKILL.md`;
- resolve and scan every registry entry at its promoted immutable commit;
- regenerate generated API references and fail on a dirty regeneration diff;
- schema-check every automation example against the native launch tool;
- execute representative immediate-launch, standing-acquisition, run-time
  fallback, pause/resume, and agent -> eval inheritance examples; and
- run stale-vocabulary assertions across the host, Base, and all registered
  template repositories;
- run focused build/unit/contract tests in each affected template, then install
  it over the coordinated Base protocol in an isolated workspace; and
- prove template-owned schedulers classified as domain workflows neither accept
  mission authority nor appear as a second automation product path.

### UI/contracts

- institution and run event idempotency;
- collapsed cards make no reads;
- waiting-authority action opens the exact acquisition;
- inspector distinguishes action operations, standing grants, pending
  authority, and infrastructure identity without jargon;
- no transient start notification;
- trusted chrome can report action/dismissal while untrusted apps cannot.

### System tests

Use a unique managed `pnpm system-test --instance ID` instance, run doctor,
then the smallest exact scenarios above. Inspect any failed run and trajectory
before classifying it. Stop the exact managed instance after verification.

Do not use model prompt over-specification to route around a harness,
documentation, authority, or validator defect. Do not rerun already-passing
coverage unless a subsequent change affects it.

## 16. Architectural ratchets

Add tests or static checks that fail if:

- a mission authority lookup accepts `channelId`;
- an automation API accepts capability/tier grant rows from model-authored input;
- MissionsDO or a closure service directly issues an allow grant;
- a mission standing allow records user attribution without an acquisition
  decision reference;
- a pending mission acquisition depends on the originating runtime remaining
  live or creates a second request/card after restart;
- admission accepts a policy body from MissionsDO, recompiles an old revision
  against current catalogs, or cannot resolve the canonical host artifact;
- an agent/eval child can supply its own mission or task subject;
- an agent-turn, eval, or method invocation can use an admission without an
  authenticated executor-kind binding or can renew another executor's lease;
- a current revision omits an immutable source ref or schema version;
- a critical grant is issued to a mission subject;
- a global service wildcard enters an operation policy;
- infrastructure dependency lists are duplicated in the automation compiler;
- a nonterminal run lacks a recoverable phase/effect identity;
- launch/edit performs an external mutation before durable intent;
- pausing an unchanged mission revokes its standing grants or pending requests;
- migration revokes a legacy mission grant while an old execution session is
  still live;
- any relevant workspace skill or generated API reference retains obsolete
  proposal, raw-permission, pregranted-only, or channel-authority guidance;
- an optional template prompt, manifest, operation descriptor, or example uses
  the removed mission schema or reconstructs automation authority;
- a template-owned domain scheduler admits mission authority outside the
  canonical MissionsDO execution workflow;
- `draft`, `needs-reapproval`, `mission_proposals`, or channel-bound closure
  sessions return after the migration.

## 17. Explicit non-goals

- Do not fork the generic capability evaluator, grant store, approval queue,
  acquisition coordinator, or execution-admission registry for automations.
  This plan does require the generic acquisition contract to gain durable
  target-subject requests and the generic execution contract to gain
  executor-discriminated admissions because the current runtime-bound forms
  cannot express the invariants above.
- Do not introduce a workflow framework solely for automations; use the
  repository's existing durable outbox/step patterns where they satisfy the
  required crash semantics.
- Do not add a policy language for arbitrary user-authored code. Operation
  intents remain bounded by registered receiver metadata and existing tool/eval
  manifests.
- Do not make channels host-owned semantic authority objects. The host may know
  their authenticated routing identity without making them grant subjects.
- Do not promise exactly-once external side effects. Guarantee exactly-once run
  admission and idempotent dispatch; actions remain responsible for idempotent
  effects where replay is possible.
- Do not preserve obsolete behavior through flags, dual schemas, fallback
  lookup, or compatibility branches in the live model.

## 18. Final acceptance statement

The refactor is done when the following explanation is both complete and true:

> The automation definition owns a versioned mission principal. The ordinary
> authority system grants capabilities to that principal. MissionsDO admits one
> durable run at a time. The host attests that the ordinary agent, method, or
> child eval execution belongs to that run. The standard dispatcher evaluates
> the mission and run grants, and the standard approval path handles anything
> missing. Channels carry conversation history only. Every cross-owner step is
> idempotent and recoverable, and the user can inspect the exact definition,
> authority, wait, result, or failure from the persistent automation surface.

Anything needed to explain the system beyond those primitives must identify a
real generic runtime or authority invariant. Automation-specific session,
grant, harness, or approval machinery is a regression.
