# Agentic Authority: Negotiation, Vocabulary, and the Living Profile

Status: proposed replacement design (rev 2, comprehensive rewrite)

Date: 2026-07-24 (supersedes the 2026-07-23 draft)

Scope: authority exercised by code evaluated on behalf of interactive agents,
tools, tests, and unattended missions — plus the user-facing permission model
those decisions live in. Fixed installed-code authority, receiver
declarations, grants, context integrity, and critical confirmation remain in
scope where they compose with evaluated code.

This is a replacement design. Remove per-unit `evalCeilings`; do not preserve
them as optional metadata, a compatibility fallback, an empty required field,
or a second authorization path.

Companion specifications (normative, referenced throughout):

- [authority/domain-vocabulary.md](authority/domain-vocabulary.md) — the
  user-facing domains × verbs vocabulary and the capability census.
- [authority/agent-authority-profile.md](authority/agent-authority-profile.md)
  — the per-agent living profile (cell states, `agent` grant scope, locks,
  hygiene).
- [authority/approval-ux-copy.md](authority/approval-ux-copy.md) — normative
  user-facing strings for every surface.
- [authority/mission-governance-ux.md](authority/mission-governance-ux.md) —
  the unattended-work review, revision, and run-supervision surfaces.
- [authority/authority-surfaces.md](authority/authority-surfaces.md) — the
  unified inspection/ratification model: `AuthorityRow`/`AuthorityRowDiff`,
  review subjects on the one approval queue, and the workspace catalog that
  presents units (panels, workers, apps, extensions, agents) and missions
  through the same components.

## 0. Decision

Vibestudio will use **capability negotiation, not capability prediction**, for
dynamic evaluated code — and will give that negotiation a **single, small,
user-owned vocabulary** so that a non-technical person can hold the whole
picture of an agent's authority in their head.

Two halves, equally load-bearing:

**Enforcement (unchanged in spirit from rev 1):**

- A fixed panel, worker, app, or extension continues to declare the gated and
  critical effects performed by its installed code in
  `vibestudio.authority.requests`.
- Evaluated code running in a host-admitted agent session does not inherit a
  speculative capability list from its owner's package manifest.
- A receiver contract decides whether an agent session may reach an
  operation. Grants and denials decide whether it may proceed. A missing
  grant becomes an ordinary user-approval rendezvous.
- An unattended run is bounded by its user-approved, content-addressed
  mission charter and standing mission grants; it cannot widen itself.
- Test automation supplies an explicit per-run policy; it borrows nothing
  from production manifests and no process-wide auto-approval mode.
- Installed code cannot route through eval to evade its manifest: eval
  becomes a session origin only under host attestation.

**Comprehension (new in rev 2):**

- Every permission decision — install review, just-in-time card, mission
  charter, Permissions page — is expressed in one reviewed vocabulary of
  **eight authority domains × three verb classes**, mapped statically from
  the semantic-capability layer. Users learn one language and meet it
  everywhere.
- Each agent has an **authority profile**: a domain-grid view of what it may
  do, built up *by* the just-in-time decisions ("always for this agent"),
  trimmed and revoked on one page, with a durable "Never" that ends
  prompting. The mission charter is a frozen snapshot of profile rows, so
  interactive and unattended authority are one mental model.
- Three invariants protect this from becoming either theater or a loophole:
  **categorization is a trust boundary** (the capability→domain mapping is
  static, reviewed, ledger-audited copy — never runtime inference);
  **the domain is never a grant key** (positive authority stays capability +
  concrete resource; the one domain-granular record is the deny-only cell
  lock, which fails closed); and **no user-facing sentence outruns its
  enforced invariant** — wherever copy promises ("never," "always waits,"
  "can't be undone always asks"), a stated, tested enforcement rule backs
  it.

The authorization kernel remains default-deny. What changes is the source of
the bound — the live user/mission relationship instead of a static prediction
— and the *legibility* of the bound: a picture the user can read, grow, and
revoke.

## 1. Why the Current Model Must Be Replaced

### 1.1 A static ceiling cannot describe dynamic work

An agent eval exists specifically so the program can be written after the
user states a task. The unit author cannot know that future program, its
exact resource, its data lineage, or the user's intent when publishing the
agent worker. That creates an unavoidable failure mode:

- a narrow ceiling is meaningful but unexpectedly breaks legitimate tasks;
- a broad ceiling avoids breakage but ceases to distinguish one agent from
  another;
- a mixture retains both problems.

This is not a tuning problem; no better hand-authored list resolves the
mismatch between a static package contract and an intentionally dynamic
program.

### 1.2 The repository demonstrates the collapse in practice

As of 2026-07-23, the News, Gmail, Linked Agent, and generic Agent Worker
packages contain byte-identical 70-capability `agentic-code-execution`
ceilings (verified: identical normalized SHA-256 across all four), including
broad administrative and destructive capability families and
`workspace-service:*`. The ceiling is not being selected from the agent's
purpose; it is a copied list of everything evaluated agent code might
conceivably ask to do. The authority audit can validate the entries' shapes;
it cannot make them meaningful.

### 1.3 Version review is not a usable policy editor

Eval ceilings are folded into exact-version unit review, where the user
approves the whole version rather than selecting an agent policy, cannot know
which future task needs which entry, and faces developer concepts (tiers,
resource scopes, evidence) as the primary decision. The user technically
ratifies the manifest; the product has not given them a decision they can
meaningfully make.

### 1.4 A declaration miss is mistaken for a terminal condition

When evaluated code reaches a gated operation outside the owner's ceiling,
authorization returns `not-requested` and no approval can be offered, because
a grant cannot exceed the sealed manifest. Repair requires a package edit,
rebuild, review, activation, and rerun. That is right for fixed code and
wrong for dynamic code: the system has just learned an exact,
user-comprehensible need at the best possible moment — the attempted
operation on a concrete resource — and then refuses to let the user decide
it.

### 1.5 Rev 1's gap: legitimacy without economics (why rev 2 adds the vocabulary)

Replacing prediction with per-operation prompts makes each prompt legitimate
but does nothing about their aggregate: without a durable, legible place for
decisions to accumulate, users face an unbounded stream of individually
reasonable dialogs, start approving reflexively, and default-deny becomes
theater (the browser-permission/UAC failure). Android's permission history
teaches the shape of the fix: a small stable vocabulary of permission groups
spoken identically by manifest, runtime prompt, and settings; graduated
scopes ("only this time / while using / always"); a settings surface with
both per-app and per-permission pivots; and hygiene (auto-reset of unused
permissions). It also teaches the failure to avoid: when the comprehension
group became the grant unit ("Storage"), it silently over-granted, and the
platform spent years clawing it back. Rev 2 adopts the vocabulary discipline
and rejects the group-as-grant mistake by construction.

## 2. First-Principles Authority Model

Four independent enforcement questions, plus one presentation layer:

| Layer | Question | Authority source |
| --- | --- | --- |
| Receiver contract | Does this operation exist, and may this kind of principal reach it? | Service method policy or reviewed `@rpc` declaration |
| Fixed-code request | Is this effect expected behavior of this exact installed artifact? | `vibestudio.authority.requests` |
| Task containment | Is this dynamic execution part of a live interactive task or approved unattended mission? | Host-attested session or content-addressed mission charter |
| Effect consent | Has the user authorized this capability on this resource in this context? | Capability grant, denial, or fresh approval |
| **Vocabulary (presentation only)** | How is any of the above shown to a human? | Static capability→(domain, verb) mapping + reviewed copy |

No layer substitutes for another. A manifest request is not a grant; a user
grant cannot expose an undeclared receiver; a version approval cannot create
an interactive task; a session relationship cannot satisfy a critical
confirmation; eval is a conduit under a host-attested session, not a new
ambient principal. And the vocabulary layer feeds **no** enforcement input:
it consumes the others read-only
([domain-vocabulary.md](authority/domain-vocabulary.md) §1).

### 2.1 Decision ownership (single-user scope)

This plan is written for the current single-user product decision: every
grant, lock, and mission approval records its deciding user in provenance
(`decidedBy`), and all decisions belong to the workspace's one user. How
decisions compose across members — who may approve shared resources,
whether one member's "Always" binds another, notification routing, and
conflicting locks — is the multi-user workstream's territory
(`multi-user-wp5-approval-provenance.md`,
`multi-user-wp9-trust-role-attenuation.md`). Nothing here keys authority in
a way that precludes per-member ownership later: subjects are principals,
grants carry the decider, and the profile is already a per-viewer
projection.

## 3. Target Behavior

### 3.1 Fixed installed code

Direct calls by a panel, worker, app, extension, or userland Durable Object
retain the two-key rule: the exact installed artifact must request the
capability/resource envelope in `vibestudio.authority.requests`, and the
applicable grant must authorize the concrete invocation. For fixed code,
`not-requested` remains a terminal build-contract failure with static
inference support. Install review renders these requests grouped by domain
([approval-ux-copy.md](authority/approval-ux-copy.md) §9).

### 3.2 Interactive agent eval

A host-admitted interactive eval is authorized as a session origin:

1. The host proves the EvalDO belongs to the active agent task and records
   its agent binding, user, channel, context, causal invocation, and exact
   mediating harness version.
2. The receiver contract must admit a `session` principal and all required
   live relationships.
3. Open operations proceed after relationship checks.
4. Gated operations consult, in order: a matching lock — resource-,
   capability-, or cell-level (structured `user-denied`, no prompt) — then
   a matching standing `agent` grant or task/once grant (proceed), otherwise
   a user approval rendezvous.
5. Critical operations always require a fresh exact-invocation confirmation,
   and receiver-declared **irreversible** gated operations never carry
   standing coverage — they ask every time
   ([agent-authority-profile.md](authority/agent-authority-profile.md) §3).
6. External-content lineage is matched by **class**: a standing grant covers
   only the lineage classes it was explicitly approved for; a new class
   re-prompts with the taint explained
   ([agent-authority-profile.md](authority/agent-authority-profile.md)
   §3, §5).

There is no per-agent list of capabilities eligible to prompt. If an
operation must never be available to evaluated agent code, its receiver
contract does not admit `session` — a property of the operation, declared
once, and *visible* to users as the permanently locked `safety` domain
([domain-vocabulary.md](authority/domain-vocabulary.md) §2).

### 3.3 Unattended agent eval

Unattended work runs under an active mission:

- The charter fixes the task spec, harness EV, skills, tool exposure,
  userland service bindings, model, network policy, and trigger. Its
  permission section is a **snapshot of authority-profile rows**
  ([mission-governance-ux.md](authority/mission-governance-ux.md)).
- Mission approval issues standing grants constrained to the mission's
  content-addressed subject.
- The runtime intersects every call with the active mission's exposure and
  standing restrictions.
- In-charter + granted → proceed. In-charter without a grant — including an
  operation whose lineage class falls outside the charter's **declared data
  flow** ([mission-governance-ux.md](authority/mission-governance-ux.md)
  §2.3a) — → wait on the ordinary approval promise, surfaced to
  desktop/mobile, without TTL. Standing mission grants never bypass the
  lineage condition; the charter declares and ratifies the expected classes.
- Out-of-charter → the run ends and produces a **revision proposal** the
  user can approve as a one-tap charter diff; the old mission cannot widen
  itself, and "ended for revision" is presented as a decision point, not a
  failure.
- Critical effects always require fresh human confirmation and therefore
  wait when no human is present.
- Revoking a profile row a mission snapshot references lapses it
  immediately; the mission pauses into "needs your review" rather than
  running with withdrawn authority.

The existing mission registry is the one unattended authority mechanism; do
not add a second scheduled-agent ceiling.

### 3.4 Tool eval

A tool running user- or agent-authored code interactively follows the same
session-origin rules, with the tool identity retained as a mediating-harness
fact. A tool performing fixed behavior directly remains bounded by its own
manifest; using an eval engine does not convert fixed behavior into a
session origin.

### 3.5 Test eval

Each test run declares an explicit test authority policy: which concrete
approval requests it expects, each request's decision, whether unexpected
prompts fail the test, and provenance identifying decisions as test rules.
The policy attaches to the run and exact test identity — not to a production
manifest, and not to a global environment switch. System tests that exercise
approval UX leave the policy disabled and drive the real surfaces.

Migration note: the current e2e cold-start flow leans on a process-wide
auto-approve environment variable; WP7 includes converting those suites to
per-run policies as an explicit step, not a cleanup afterthought.

## 4. The Canonical Authorization State Machine

Every host-service and direct-RPC preflight must produce one of these
semantic states:

| State | Meaning | Runtime behavior |
| --- | --- | --- |
| `allowed` | Receiver, containment, and grant checks pass | Execute |
| `approval-required` | Valid operation; user consent can authorize it | Create/deduplicate acquisition, await, then retry |
| `mission-change-required` | Unattended task needs authority outside its charter | End run; emit revision proposal |
| `user-denied` | Explicit denial, lock, or fresh refusal | Stop; carry `standing: true\|false`; show who denied and where to change it |
| `receiver-rejected` | Receiver does not admit this principal/relationship or method undeclared | Stop; developer repair packet |
| `fixed-code-not-requested` | Installed code attempted an effect absent from its exact manifest | Stop; propose exact manifest change |
| `invalid-session` | No provable live task/mission/session relationship | Stop; re-enter through the canonical task route |
| `invalid-attestation` | Direct authority proof absent, invalid, stale, or replayed | Stop; retry through host mediation |

`not-requested` must never be returned merely because a valid interactive
session-origin eval lacks an entry in its mediating harness's manifest.

The state machine is shared. Today the evaluation *policy* is already one
function (`evaluateAuthority` in `packages/shared/src/authorization.ts`) but
it is wired at several independent sites — direct-RPC enforcement, the
service dispatcher, and the server authority runtime/DO entry. WP3 is
honestly scoped as **converging those wiring points onto one choke point**,
not merely "keep using the shared evaluator": the eight-state guarantee holds
only if every path emits it, including streaming, connectionless workers,
panels, EvalDO, preflight, and execution.

## 5. Admission: Prevent Eval from Becoming a Manifest Escape Hatch

Removing eval ceilings is safe only if session origin is established more
strictly than "the caller is an internal EvalDO." Today session origin is
classified from the class name and internal repo path
(`rpcServer.ts` ~L666); that check is the placeholder this section replaces.

The mission charter is durable policy. The host attestation is a live
statement about one execution. They must not be conflated:

- The **charter** is content-addressed data in the mission registry: task,
  trigger, exact harness EV, exposed tools/services, network policy, and the
  profile-row snapshot the user reviewed.
- A **mission approval** records the authenticated user's decision on that
  exact charter closure and issues mission-subject grants.
- A **mission session record** is created by the host when a mission
  actually starts, binding a new authority session and run to the approved
  mission id and closure digest.
- A **host attestation** is derived from those live records for a concrete
  RPC call: this EvalDO/run/session currently belongs to that approved
  closure. It is never authored in `package.json`, selected by the agent, or
  re-approved per call.

For host-service dispatch the server resolves this directly from live
session/mission state; for direct RPC it rides the existing short-lived,
nonce-bound direct-authority attestation. No long-lived capability token; no
attestation in a manifest.

The host constructs an immutable `AgentExecutionSessionFact` per admitted
run, containing at least: authority session id and version; owning user;
workspace and context; agent binding and channel/task reference; exact
mediating harness code identity; EvalDO identity and run id; causal parent
invocation; mode (`interactive` | `mission` | `test`); mission subject for
mission mode; expiry and nonce/digest binding. Host-created, resolved from
live state; callers cannot supply or modify it.

An EvalDO becomes a `session` origin only when its exact identity matches the
fact; the fact is live and belongs to the current RPC session; interactive
mode has a live user-task relationship or mission mode an active matching
mission; the invocation carries the expected causal parent; and the mediating
harness version is still admitted. Otherwise it remains ordinary installed
code under its direct manifest — closing the "route fixed behavior through
eval" escape without predicting dynamic capabilities.

The mediating harness remains in `executingCode` and the initiator chain for
attribution, audit, confinement, version invalidation, and incident response.
It ceases to provide the dynamic request list.

### 5.1 User involvement

Interactive work needs no separate mission decision: the host derives the
fact from the live task, agent binding, channel, and causal tool invocation;
concrete gated/critical effects still ask when grants are missing. Unattended
work requires the explicit governance flow specified in
[mission-governance-ux.md](authority/mission-governance-ux.md): review sheet
in profile language, approval bound to the exact closure, digest-lapsing
edits, revision proposals. **Building that surface is part of this plan** —
a service method callable only through technical tooling is not adequate
user consent, and the mission registry currently has no UI at all.

## 6. Acquisition and Waiting

### 6.1 The attempted operation is the request

Agents do not separately ask for abstract capability names. The normal typed
operation produces the strongest possible request: semantic action; concrete
resource; prepared-state digest; exact arguments digest; caller, task,
mission, and code lineage; outside-content lineage; reviewed risk tier;
human presentation resolved from the capability registry (action copy +
domain chip + resource phrase). Preflight remains available for planning and
aggregation, returning the same state execution would enforce; it does not
mint authority.

### 6.2 One rendezvous, two caller lifecycles

For `approval-required`:

1. Build the canonical invocation snapshot.
2. Deduplicate on the exact snapshot and owning runtime.
3. Publish one request to the existing approval queue.
4. Notify shell/mobile through the existing surfaces
   ([approval-ux-copy.md](authority/approval-ux-copy.md) §3.3).
5. Expose one canonical acquisition record and completion promise.
6. Record the decision in the canonical grant store — including the new
   `agent` scope and lock records
   ([agent-authority-profile.md](authority/agent-authority-profile.md) §2–3).
7. Wake any durable caller that registered interest.
8. Re-evaluate the entire invocation against current live state.
9. Consume one-shot grants atomically where applicable.
10. Retry the original operation, not an agent-reconstructed approximation.

Approval is not success: membership, receiver declaration, provider EV,
prepared state, lineage, session, and denial checks re-run after the human
responds.

No JavaScript continuation is serialized. Panels and connection-holding
callers await the promise with their cancellation signal. EvalDO awaits it
too: its held `run` request lasts the whole eval, and asynchronous agent
`startRun` attaches execution to the DO event with `waitUntil`; while
pending, the EvalDO stays active.

AgentVessel has a different caller lifecycle, not a different authority
system. Its effect outbox already persists an exact unresolved effect before
dispatch and redrives idempotently after hibernation. For an approval wait it
must: retain the effect in the durable outbox; ensure the canonical
acquisition exists; record the acquisition id with the pending effect; yield
and hibernate; treat decision delivery as a wake-up hint; redrive through the
canonical evaluator. The grant/denial record, not the wake-up message,
determines the result — lost or duplicate notifications are harmless.

Host/workerd restarts interrupt the eval; recovery records that outcome and
the owning agent may issue a fresh run. The system must not claim transparent
exactly-once continuation across restart, and the UX must not either
([approval-ux-copy.md](authority/approval-ux-copy.md) §5).

**Acquisition lifecycle is tied to run liveness.** A pending acquisition
whose owning task, eval run, or mission run ends — cancellation,
interruption, completion by another path — is resolved to an expired state
through the queue's existing resolve-elsewhere machinery, and its surfaces
show the honest expiry copy. A human decision that races the ending is
recorded with full provenance but drives nothing: effects execute only
through live re-evaluation of a live invocation, and a `once` grant bound to
a dead invocation snapshot lapses with it. Stale approval cards that outlive
their caller, and approvals that "land" into a vanished eval, are therefore
impossible by construction rather than by cleanup.

Mission policy is durable, but an individual mission eval follows the same
execution rule: in-charter approvals may await; out-of-charter ends the run
into a revision proposal; scheduling/retry state may be durable without
pretending to resume an instruction pointer.

### 6.3 Disposition of the existing deferral machinery

| Mechanism | Actual durable state | Target disposition |
| --- | --- | --- |
| Normal RPC acquisition wait | Grant/acquisition records; the promise is live-only | Default for EvalDO, panels, and other live callers |
| AgentVessel effect outbox | Exact unresolved effect, lease, attempt, outcome | Keep as durable source of truth for hibernatable agent work |
| Server `DeferralRegistry` | None — process-memory closure + `onDeferredResult` callback | Remove from the authority-acquisition path |

`DeferralRegistry` is not a durable continuation: its immediate
`{deferred, requestId}` acknowledgement plus later callback is a parallel RPC
completion protocol whose closure disappears on restart, and its ten-minute
TTL turns ordinary human latency into an execution failure. Do not extend it
to EvalDO, panels, workers, or missions. Replace its acquisition use with the
durable-caller protocol above. No server-held protected-handler closure and
no approval deadline: explicit user cancellation, task cancellation, mission
revocation, or invocation invalidation may end an acquisition; elapsed human
time may not. (Dismissal cooldowns suppress prompt spam without expiring an
unresolved decision.)

AgentVessel's deferred eval-job integration (durable job/run reference,
completion notification, polling backstop) stays separate from capability
acquisition. Generic userland DOs/workers get no transparent continuation
from the dispatcher; hibernating across approval requires an explicit
journaled-work contract with idempotent replay — an execution-lifecycle
choice, not an authority policy.

### 6.4 Decisions

The complete decision vocabulary (semantics in
[agent-authority-profile.md](authority/agent-authority-profile.md) §2.3,
copy in [approval-ux-copy.md](authority/approval-ux-copy.md) §3):

- `once` — exact invocation only.
- `task` — until the originating attested task ends (bound to the task
  reference in the execution-session fact, not a wall clock).
- `agent` — standing, keyed `(agentBinding, capability, concreteResource)`
  plus the approved lineage classes; offered only when eligible (gated
  tier, not irreversible, receiver opt-in, lineage stated on the button);
  never wildcard-by-default; auto-suspends after long disuse; follows the
  binding-continuity rules of
  [agent-authority-profile.md](authority/agent-authority-profile.md) §3.1
  (survives version updates of the same unit; never transfers to a
  replacement, new owner, or re-install).
- `deny` — reject this request.
- `lock` — persist a denial at resource, capability, or cell (domain×verb)
  granularity; ends prompting until changed in Permissions; attempts return
  structured `user-denied { standing: true }` with a visible system line and
  a lock-attempt counter, never silence plus mystery. Cell locks cover
  capabilities added to the cell later, so the profile's "Never" stays true
  as the census grows.
- Critical requests: exact confirmation or denial only; no persistence ever.

`version` grants remain available only for code-origin requests. Mission
grants are created only through mission approval, bind to the exact closure,
and lapse when the charter digest changes or a referenced profile row is
revoked. "Trust this version" is never offered for session-origin work.

The rev 1 gap this closes: rev 1 offered persistent denial (`block`) but no
persistent approval, guaranteeing repeat prompts for routine recurring
actions. The `agent` scope is the durable "yes," made safe by concrete
resource binding, lineage conditions, hygiene, and profile visibility.

## 7. User Experience

The full UX is specified in the companion docs; this section fixes the
principles the implementation must not trade away.

### 7.1 One vocabulary, one row model, one queue

Install review, JIT cards, mission review, and Permissions all render the
same domains, verb classes, action copy, and resource phrases. No surface
introduces a second permission language. Primary copy never contains
`eval`, `principal`, `capability`, `tier`, RPC names, or manifest
instructions ([approval-ux-copy.md](authority/approval-ux-copy.md) §1).

Structurally, this is enforced by shared abstractions rather than
discipline ([authority-surfaces.md](authority/authority-surfaces.md)):
every authority statement — a unit manifest's *declared* effects, an agent
profile's *allowed* rows, a mission's *snapshot* rows, a JIT card's single
*prospective* row — projects to one `AuthorityRow` model; every human
ratification (unit version activation, mission approval or revision, JIT
approval, critical confirmation) is a typed subject on the one approval
queue; and one workspace catalog presents units and missions through the
same item-page components, with Permissions as a second pivot over the same
rows. Pre-release clean cut: bespoke per-kind review rendering and any
queue-external approval path are deleted, not deprecated.

### 7.2 Agent installation

Unit-version review shows only effects performed directly by installed code,
grouped by domain, plus the fixed dynamic-code explanation — no speculative
list ([approval-ux-copy.md](authority/approval-ux-copy.md) §9).

### 7.3 Just-in-time approval

The card leads with the decision question (`Allow {agent} to {action}
{resource}?`), shows the verified task context, lineage and irreversibility
flags, the agent's framed untrusted explanation, the scope ladder, and an
expandable technical disclosure. The "Always for {agent}" choice is the
profile's write path and triggers the teaching toast.

### 7.4 Waiting

Pending approval is a calm, non-error state in agent chat, panels, shell,
mobile, and mission run views; reconnects don't disturb the server-side
waiter; restarts are reported honestly as interruptions, never resumption.

### 7.5 Denial, locks, and the Permissions surface

Denials produce neutral system lines with deep links; agents receive
structured `user-denied` and must not retry or route around it. Permissions
offers the per-agent profile grid, the per-domain pivot, recent decisions,
revoke/unlock/reset controls, and the permanently padlocked safety domain.
There is no separate eval-ceiling editor, because there are no eval ceilings.

### 7.6 Developer defects

Undeclared receivers, wrong principal families, missing relationships,
invalid attestations, and fixed-code manifest misses render as "needs a
developer fix" — structured repair packet, no Allow/Deny affordances, never
consent-styled ([approval-ux-copy.md](authority/approval-ux-copy.md) §10).

## 8. Data and Type Model

### 8.1 Remove eval ceilings

Delete: `EvalAuthorityCeiling`; `EvalCeilingPurpose`;
`UnitAuthorityManifest.evalCeilings`; `authorityEvalCeilings` from build
metadata, recipes, runtime identities, image stores, panel registrations, and
schemas; eval-ceiling presentation/diff data from unit approvals;
package-level `evalCeilings` in every executable unit; validators and
generators specific to them; documentation instructing authors to choose
them. `vibestudio.authority` contains only direct installed-code `requests`.
This is a pre-release cutover: old artifacts and persisted runtime images
with the superseded shape are invalidated and rebuilt, not translated.

### 8.2 Add the capability→domain mapping

`packages/shared/src/authority/capabilityDomains.ts`, generated from the
reviewed census in
[domain-vocabulary.md](authority/domain-vocabulary.md) §5: every promptable
capability maps to exactly one `{ domain, verb }`. Exhaustiveness enforced by
typecheck (the `HOST_CAPABILITY_PRESENTATIONS` pattern) and by ledger audit
(§9). Dynamic workspace services declare domain/verb/copy in their live
declaration under the §5.9 rules; invalid declarations are receiver-rejected,
never defaulted. The mapping ships in the host build and cannot be overridden
at runtime — categorization is a trust boundary.

### 8.3 Add admitted execution-session facts

A wire-safe, host-authenticated execution-session fact on the authorization
context/session record, sufficient to distinguish interactive, mission, and
test execution without consulting mutable caller claims. Not a bearer token
with a capability list: admission is a relationship/containment fact; grants
remain canonical records.

### 8.4 Extend the grant store

- New scope `agent` keyed to the attested agent binding, with provenance
  `{ surface, decidedAt, lineageClean }` and a `suspendedAt` hygiene field.
- Lock records: persisted denials keyed
  `(agentBinding, capability, resourcePattern?)` with provenance and an
  attempt counter.
- Task grants keyed to the attested task reference.
- Mission grants unchanged in mechanism (mission-subject-bound), plus the
  revocation-cascade link to referenced profile rows.

### 8.5 Preserve code attribution

`executingCode` continues to carry exact code principal, source lineage,
mediating harness identity, and execution digest. For a code origin, direct
requests are checked; for a session origin, code identity is attribution and
confinement, not a ceiling. If one optional `requested` field becomes
ambiguous across the two uses, split attribution from request authority
rather than leaving a field whose meaning changes by origin.

### 8.6 Failure taxonomy

Replace eval-facing `update-authority-manifest` remediation with
`request-user-approval` (valid interactive effects),
`request-mission-change` (out-of-charter unattended effects),
`update-installed-code-manifest` (code origins only), and the existing
receiver/session/relationship/attestation remediations for genuine defects.
`user-denied` carries `standing`. The full structured failure must survive
RPC, streaming, worker HTTP responses, EvalDO sandbox execution, eval tool
formatting, agent-loop persistence, panel error boundaries, and system-test
artifacts — never just an error string.

## 9. Receiver and Capability Registry Responsibilities

Removing per-agent ceilings makes receiver review the enforcement decision
and the census the presentation decision. Every gated/critical receiver
declares: admitted principal families; required live relationships; semantic
capability; resource derivation; risk tier; **irreversibility** (an
enforcement-bearing flag: irreversible effects take no standing coverage);
user-facing action presentation; an **operation-substance presentation**
where required
([authority-surfaces.md](authority/authority-surfaces.md) §2.2a — mandatory
for `sharing`-domain and destructive effects); allowed persistence choices
(including whether `agent` scope is offerable and any offerable broader
resource pattern); whether unattended mission grants are permitted;
prepared-state inputs for race-safe revalidation.

If a capability must never be invoked by evaluated agents, exclude `session`
from its receiver requirement — declared once at the operation, surfaced to
users as the locked domain, never re-guessed per agent package.

The authority ledger and generated matrices must verify:

- no protected receiver lacks a semantic effect;
- every promptable capability has a domain/verb assignment and reviewed
  copy; no `safety`-domain capability admits `session` or userland `code`
  principals; egress-semantic receivers map to `sharing`; infra
  capabilities are closed, not categorized;
- all session-admitting effects have reviewed prompt presentation;
  `sharing`-domain and destructive effects declare a substance
  presentation;
- critical effects cannot persist; irreversible effects cannot take `agent`
  scope or standing mission grants; `agent` scope appears only where the
  receiver opted in;
- effects forbidden to unattended work cannot be mission-granted;
- direct RPC and host service declarations resolve to the same semantic
  model.

## 10. Security Analysis

### 10.1 Prompt abuse and fatigue

Allowing a valid session to ask for any session-admitted operation increases
prompt reachability. Controls, all central: dedup identical requests;
dismissal cooldowns; rate-limit distinct requests per task/agent without
converting them to grants; easy locks that end prompting; lineage rules
preventing outside-content requests from creating or riding standing grants;
reviewed non-technical copy; critical actions exact and never
push-confirmable; "Always" gated by eligibility rules and concrete-resource
binding. A prompt is not authority, and prompting pressure is governed
centrally, not per package. Fatigue is additionally governed structurally:
the profile gives repeat decisions somewhere durable to land, which is the
only real cure for prompt streams.

### 10.2 Confused deputy

The original authorizing origin and causal chain survive every hop. Spawning
a deputy does not replace the session/mission subject or manufacture a
grant. A child acting independently as installed code is bounded by its own
manifest; a causally delegated leg carries the original session and target
relationship. Sub-agents get fresh default profiles; `agent` grants never
flow down
([agent-authority-profile.md](authority/agent-authority-profile.md) §7).

### 10.3 Eval escape

Only a host-admitted execution session produces a session origin. An
arbitrary installed worker cannot instantiate an EvalDO and claim dynamic
authority; missing admission falls back to code-origin enforcement.

### 10.4 Prompt injection and outside content

Context-integrity lineage remains part of the invocation snapshot and is
matched by **class** rather than a clean/tainted binary: a standing grant
(interactive `agent` scope or mission grant) covers only lineage classes
explicitly approved — stated on the "Always" button, or declared in the
mission charter's data flow. An unexpected class forces the distinct
`permission.outside` presentation and a fresh decision; outside content can
never alter mission policy, locks, or standing grants without an independent
user action. This keeps the injection defense where it matters (unexpected
influence) without making content-processing agents un-automatable — the
binary rule would have either prompted a news mission on every legitimate
run or been silently bypassed by mission grants. The evaluated program's
explanation is untrusted supporting text rendered in the framed quoted
style; verified receiver presentation, concrete resource, and host-verified
substance remain primary.

### 10.5 The vocabulary as an attack surface

New in rev 2, because the vocabulary is new power: if an attacker could
influence which domain a request renders under, they could disguise egress as
housekeeping. Hence categorization is static reviewed copy shipped with the
host, joined by capability id at render time; request payloads carry no
domain; workspace-service declarations are validated, framed, and restricted
(no `safety`, stricter standing-grant eligibility for `sharing`/`accounts`);
and the ledger audit enforces the egress→`sharing` rule. The domain is never
a grant key, so even a miscategorization cannot widen enforcement — only
presentation — and the audit exists to keep presentation honest too.

### 10.6 Unattended widening

An unattended mission cannot convert a missing permission into ambient
authority: in-charter requests wait; out-of-charter requests end the run
into a human-reviewed revision bound to a new digest; profile-row revocation
cascades immediately; and no notification action can approve a charter.

## 11. Implementation Workstreams

### WP0 — Vocabulary and census (new; unblocks all UX work)

1. Land `capabilityDomains.ts` from the census in
   [domain-vocabulary.md](authority/domain-vocabulary.md), with typecheck
   exhaustiveness.
2. Extend the ledger audit with the §9 vocabulary checks.
3. Add domain/verb/copy fields to dynamic workspace-service declarations
   with §5.9 validation.
4. Review pass over existing `hostCapabilityPresentations.ts` copy against
   the [approval-ux-copy.md](authority/approval-ux-copy.md) rules; converge
   its `group` field with the domain mapping (one source of truth).

Completion: every promptable capability has exactly one reviewed
domain/verb/copy assignment; the audit fails on gaps; no runtime input can
alter categorization.

### WP1 — Contract removal

1. Remove eval-ceiling types and parsers from shared authority manifests.
2. Remove eval-ceiling schema fields from build, runtime, approval, and
   panel contracts.
3. Remove the fields from build recipes, metadata, execution identity,
   runtime images, activation, and approval stores.
4. Delete all package `evalCeilings` declarations.
5. Update authority audit/generation to validate only fixed-code requests.
6. Invalidate old artifacts and regenerate ledgers/catalogs.

Completion: no production type, artifact, package, or UI mentions
`evalCeilings`.

### WP2 — Session admission

1. Define `AgentExecutionSessionFact`.
2. Mint it in the host eval dispatch path from verified owner/task/mission
   state.
3. Bind it to EvalDO identity, run, causal parent, session, and harness EV.
4. Verify at RPC admission; reconstruct on connectionless calls.
5. Remove the class-name-based session-origin classification in
   `rpcServer.ts`.
6. Tests: expiry, replay, wrong-owner, wrong-run, stale-harness.

Completion: eval cannot become a session origin without a live host-created
interactive task or approved mission.

### WP3 — Unified authorization

1. Apply installed-code request checks only for `code` origins.
2. For admitted `session` origins: receiver/relationship checks → lock check
   → grant/acquisition checks.
3. Intersect mission-bearing origins with charter exposure and standing
   restrictions.
4. Implement the canonical state machine for preflight and execution.
5. Converge the existing wiring points (direct-RPC enforcement, service
   dispatcher, authority runtime/DO entry, streaming, prepared multi-effect
   operations) onto one evaluator invocation path; add a conformance test
   that drives every dispatch path through the same scenario matrix and
   asserts identical states.

Completion: an interactive eval outside the former ceiling reaches the normal
approval flow; the equivalent direct installed-code call still fails
`fixed-code-not-requested`; all paths emit identical states.

### WP4 — Grant model extensions

1. `agent` scope in `CapabilityGrantStore` keyed to attested agent binding,
   with provenance, approved lineage classes, and hygiene suspension;
   binding-continuity semantics (update-preserving, transfer-severing) in
   the binding registry.
2. Lock records at resource, capability, and cell (domain×verb)
   granularity, with attempt counters and profile provenance; cell locks
   resolved through the static mapping at evaluation time.
3. Task grants keyed to attested task references; define task-end semantics.
4. Receiver-contract fields: `agent`-scope offerability, irreversibility,
   substance presentation, offerable broader resource patterns,
   mission-grant permission.
5. Lineage-class taxonomy fixed with the context-integrity module; charter
   data-flow declarations and their intersection with mission grants.
6. Revocation cascade from profile rows into mission snapshots; acquisition
   expiry on run death.

Completion: every decision in §6.4 round-trips through the store with
provenance, and revocation behaves per
[agent-authority-profile.md](authority/agent-authority-profile.md) §8.

### WP5 — Asynchronous acquisition

1. One canonical acquisition record per exact snapshot and owning runtime,
   with a live completion promise.
2. Live callers (panels, EvalDO) await with lifecycle cancellation.
3. AgentVessel: outbox-associated acquisitions, hibernate, wake-hint,
   idempotent redrive through full re-evaluation.
4. Remove `DeferralRegistry`/`callDeferred` from authority acquisition — no
   protected-handler closure, no result callback, no human-response TTL.
5. Keep eval-job completion (durable run state, notify, poll) distinct from
   acquisition.
6. After decision or durable redrive, re-evaluate and retry the exact
   invocation.
7. Preserve cancellation, denial, dismissal cooldown, idempotency, one-shot
   consumption, decision provenance.
8. Surface pending state per
   [approval-ux-copy.md](authority/approval-ux-copy.md) §5 across shell,
   mobile, panel, agent chat, mission runs.
9. Preserve honest restart behavior.

Completion: approval waits never fail on human latency; AgentVessel
hibernates without losing journaled effects; no parallel continuation or
RPC-completion subsystem exists.

### WP6 — UX surfaces

0. Shared foundations first
   ([authority-surfaces.md](authority/authority-surfaces.md)): the
   `authorityRows`/`authorityRowDiff` projection modules; the
   `unit-version-review` and `mission-review` queue subjects (with
   `unit-batch` reduced to a grouping of the former, and the mission
   registry's approve/edit callable only via the queue resolver); the
   subject-parameterized card shell shared by desktop and mobile; the
   unified decision/provenance record across capability, version, and
   mission decisions; the workspace catalog list and item pages.
1. JIT card per [approval-ux-copy.md](authority/approval-ux-copy.md) §3
   (domain chip, scope ladder, lineage/irreversibility flags, framed agent
   text, details disclosure), critical card per §4, mobile actions per §3.3.
2. Authority profile page and per-domain pivot per
   [agent-authority-profile.md](authority/agent-authority-profile.md) §4,
   including summary-sentence generation, lock counters, reset controls,
   hygiene states, and the teaching toast.
3. Waiting states across panel, eval, agent chat, shell, mobile, mission
   runs; honest interruption copy.
4. Denial/lock system lines with Permissions deep links.
5. Install/version review as `unit-version-review` diffs: domain-grouped
   declared rows + the dynamic-code explanation; delete the bespoke
   capability-section rendering and ceiling sections.
6. Mission governance per
   [mission-governance-ux.md](authority/mission-governance-ux.md): catalog
   item page, review sheet as a `mission-review` queue entry (with per-row
   narrowing), revision proposal as the same entry, run timeline, lifecycle
   controls, notifications.
7. Developer-defect presentation, never consent-styled.
8. Structured remediation carried end-to-end through EvalDO and the eval
   tool.

Completion: no user-facing flow asks a person to understand or repair an
eval manifest; every surface speaks the one vocabulary; no approval or
authority-inspection surface renders outside the shared row/diff/card
components, and no authority ratification resolves outside the queue.

### WP7 — Missions and tests

1. Mission exposure as the sole unattended predeclared boundary; charter
   permission sections as profile-row snapshots.
2. Await-and-notify for in-charter missing grants; revision proposals for
   out-of-charter effects; revocation-cascade pause.
3. Per-run test approval policy with provenance; remove process-wide
   auto-approval from production-like runs; migrate the existing e2e
   cold-start suites off the auto-approve environment variable.
4. Approval-UX system tests driving the real queue and shell/mobile
   resolvers.

Completion: unattended and test execution are deterministic without
borrowing authority from an agent package.

### WP8 — Documentation cleanup

Update `workspace/skills/capabilities/SKILL.md`,
`workspace/skills/architecture/SECURITY.md`, sandbox/runtime API guidance,
worker and agent authoring guides, capability approval and permission docs,
authority ledgers and generated catalogs. Delete every instruction that says
to repair dynamic eval by adding a ceiling entry. Add authoring guidance for
the census: how a new capability gets its domain/verb/copy reviewed.

## 12. Cutover Sequence

1. **WP0 vocabulary** lands first — it changes no enforcement and unblocks
   UI work.
2. Land admitted execution-session facts while the old ceiling check exists;
   assert facts in shadow diagnostics without a parallel decision.
3. Make session admission mandatory for EvalDO session origin.
4. Change the canonical evaluator: admitted sessions → dynamic acquisition
   (with locks and `agent` grants); code origins → manifests.
5. Converge asynchronous acquisition and end-to-end structured remediation.
6. Ship the shared row/diff/card foundations and workspace catalog, then
   the profile page, card scope ladder, and mission governance surface on
   top of them (WP6 step 0 before steps 1–7).
7. Remove eval ceilings across contracts, artifacts, packages, review UI,
   and docs in one schema cutover.
8. Rebuild the workspace template; invalidate prior runtime images/build
   identities.
9. Exercise interactive agent, panel-origin tool eval, unattended mission,
   and test eval flows end-to-end.

Step 2 may collect diagnostics but must not become a lasting shadow-policy
system. After cutover there is one evaluator and no compatibility branch.

## 13. Verification

### 13.1 Unit and integration coverage

Everything from rev 1, plus vocabulary and profile items:

- Interactive session + missing grant produces one acquisition; approval
  retries the exact invocation once; denial never retries.
- Critical confirmation cannot persist; external lineage invalidates
  incompatible remembered consent and suppresses `agent`-scope offers.
- A session-admitted capability absent from the harness manifest is
  promptable; the same call with code origin is `fixed-code-not-requested`.
- A fake EvalDO without an admitted fact cannot use session authority; stale
  harness EV invalidates admission.
- `agent` grants: match only the exact binding + capability + resource +
  approved lineage classes; do not cover sub-agents; suspend after the idle
  window; revocation takes effect on next dispatch; a request with an
  unapproved lineage class re-prompts past an existing grant; grants
  survive a version update of the same unit and never survive replacement,
  transfer, or re-install.
- Irreversible gated effects: never offered `agent` scope, never covered by
  a standing mission grant, prompt/wait on every occurrence.
- Locks: suppress prompts, return `user-denied { standing: true }`,
  increment counters, unlock via Permissions only; a cell lock denies a
  capability newly added to its cell without any migration step.
- Acquisition expiry: ending the owning task/run resolves pending
  acquisitions to expired; a decision racing the ending records provenance
  but executes nothing; substance-bound approvals lapse when the prepared
  state changes.
- Task grants end with the attested task, not a timer; sub-invocations with
  the same causal task share them; a new task does not.
- Census audit: unmapped promptable capability fails; `safety` + `session`
  admission fails; egress receiver outside `sharing` fails; promptable infra
  capability fails; workspace-service declaration without valid domain/copy
  is receiver-rejected.
- Missions: cannot call services outside the charter; grants lapse on digest
  change; profile-row revocation pauses dependent missions immediately.
- Restart interrupts a waiting eval without executing or replaying the
  protected effect; AgentVessel hibernation/wake/redrive converges on the
  recorded decision through lost and duplicate notifications.
- An unresolved acquisition outlives the former `DeferralRegistry` TTL; no
  acquisition path holds a protected-handler closure or uses
  `onDeferredResult`.
- Direct RPC, host service, streaming, and connectionless paths emit
  identical structured states for the same scenario matrix (the WP3
  conformance suite).
- Eval tool results preserve full `authorityFailure` remediation; a
  receiver-undeclared failure never creates a consent prompt.
- Surface unification
  ([authority-surfaces.md](authority/authority-surfaces.md) §7): row
  projections always agree with the static domain mapping; version and
  mission diffs mark added/removed/retiered correctly; approving a
  mission review with rows unchecked ratifies the narrowed, re-digested
  closure; no shell/mobile package renders manifest/grant/charter
  capabilities outside the shared components.

### 13.2 Headless system tests

1. An interactive agent evals a previously unlisted gated capability, waits,
   is approved `once`, completes.
2. The same request denied; the agent reports the denial without workaround.
3. The same request approved "Always for this agent"; a second task performs
   the action with no prompt; the profile page shows the row; removing the
   row restores prompting.
4. A locked capability: no prompt, structured standing denial, visible
   system line, counter increments.
5. Outside content forces fresh approval and hides the "Always" choice.
6. A critical action requires exact confirmation and never offers
   persistence.
7. Host restart while approval pends: interruption reported; nothing
   executed or replayed.
8. An unattended mission waits for an in-charter missing grant across a long
   human delay.
9. An unattended mission produces a revision proposal for an out-of-charter
   operation; approving it re-mints grants under the new digest; declining
   resumes the old charter.
10. Revoking a profile row pauses a dependent mission into "needs your
    review."
11. Installed code cannot route fixed behavior through an unadmitted EvalDO.
12. A panel/tool eval receives the same approval UX as agent eval.
13. Terminal receiver and attestation defects arrive as actionable
    structured failures with no consent styling.
14. AgentVessel hibernates across an approval, survives restart or lost
    wake-up, converges on one recorded outcome by idempotent redrive.
15. A slow human response does not expire the acquisition.
16. Card, profile, and mission surfaces render the same domain chip and
    action copy for the same capability (vocabulary-coherence check).

Follow the repository headless-system-test protocol: repair infrastructure
failures rather than teaching prompts to route around platform defects.

### 13.3 Comprehension validation (WP6 acceptance, not CI)

Automated tests prove consistency; they cannot prove a person understands.
WP6 acceptance therefore includes task-based usability passes — scripted
walkthroughs with participants unfamiliar with the internals — checking at
minimum that a non-technical user can:

1. predict what will happen before confirming a card (including reading the
   substance section correctly);
2. find and revoke a standing "Always" they created minutes earlier;
3. explain the difference between what an app *declares* and what they have
   *allowed*;
4. read a mixed cell (`Allowed: 1 · Never: 1`) without concluding either
   absolute;
5. interpret a mission revision diff, including a non-permission change
   (schedule, reach);
6. recognize an expired/interrupted request as "nothing happened" vs
   "partially happened" correctly.

Failures here are treated as copy/layout defects with the same severity as
rendering bugs — the completion claim "a non-technical user can hold the
picture" is validated by these passes, not asserted.

## 14. Completion Criteria

The replacement is complete when:

- no executable package contains an eval capability ceiling, and no
  build/runtime identity seals or compares one;
- interactive evaluated code can request any receiver-admitted gated action
  through the canonical approval flow, and approval causes the waiting
  caller to re-evaluate and retry the exact invocation;
- every promptable capability carries exactly one reviewed domain/verb/copy
  assignment, enforced by typecheck and ledger audit, immutable at runtime;
- each agent has a Permissions profile a non-technical user can read as one
  summary sentence and edit line-by-line, with durable "always" and "never"
  that provably start and stop prompting;
- mission charters are reviewed, revised, and supervised through the
  governance surface in profile language, with revision proposals replacing
  silent out-of-charter failures and revocation cascading immediately;
- units and missions are inspected through one workspace catalog, every
  authority statement renders through the shared `AuthorityRow`/diff
  components, and every ratification — unit version, mission charter, JIT,
  critical — resolves through the one approval queue with one decision
  record shape;
- AgentVessel approval waits are represented by its durable outbox and
  canonical acquisition state, never a server-held closure; no acquisition
  expires on human latency;
- installed fixed code remains bounded by its manifest; only host-admitted
  task/mission eval receives session origin; unattended work is bounded
  solely by mission closure and grants;
- terminal technical failures remain structured and visible but never appear
  as user-consent questions;
- every absolute in user-facing copy ("never," "always waits," "expired,"
  "can't be undone always asks") is backed by a stated, tested enforcement
  invariant, and the §13.3 comprehension passes have run;
- broad copied agent ceilings and `workspace-service:*` eval declarations
  are gone;
- all focused, category, smoke, typecheck, authority-ledger, and artifact
  consistency checks pass, including the new census and dispatch-conformance
  suites.

## 15. Non-Goals

- Automatically granting agents broad authority because they are agents.
- Allowing evaluated code to approve its own requests, author its own
  prompt copy outside the framed untrusted area, or influence
  categorization.
- Domain-level *positive* authority — grants, ceilings, exposure, or
  toggles that widen what code may do. (Deny-only cell locks are the single
  sanctioned domain-granular record; they fail closed.)
- Replacing receiver declarations with user prompts, or removing fixed-code
  manifests.
- Persisting critical confirmations, or offering "Always" for critical or
  lineage-tainted requests.
- Adding a second approval queue, grant store, eval-specific permission
  database, or compatibility evaluator.
- Treating an acknowledgement/callback RPC pair as a durable continuation,
  holding protected-handler closures across human waits, or serializing
  guest JavaScript continuations across restarts.
- Making human absence a denial: in-charter unattended requests wait and
  notify.
- Growing the domain vocabulary casually, adding a "misc" domain, or letting
  any surface introduce synonym permission language.

## 16. Result

The resulting system has a simple rule, and now a simple picture:

> Fixed code declares what its version is expected to do. Dynamic agent code
> asks for the concrete action when it needs it. Unattended code acts only
> within a user-approved mission. And everything the user is asked, shown,
> or allowed to change is spoken in one small vocabulary: *agents ask first
> for everything, except what you've allowed, minus what you've locked — and
> some things agents can never do at all.*

Default-deny is preserved without asking package authors to predict the
future, without asking users to ratify meaningless inventories, and — the
rev 2 addition — without burying users in prompts that have nowhere durable
to land. The negotiation draws a picture; the picture belongs to the user.
