# Capability Model Redesign

Status: agreed direction (2026-07-21, revised same day after adversarial review).
Supersedes the authority model as implemented on `better-provenance`; reconciled against
the runtime-foundation decisions summarized in this document's §5 (R1–R4) and system-agent spec set
(`system-agent-design.md`, `system-agent-sa0-plan.md`, `system-agent-sa1-delegation-spec.md`),
and the multi-user plan set (§0.0 trusted-environment framing).

> Canonical runtime-foundation reference: §5 is the in-tree source for the R1–R4
> reconciliation. There is no separate `runtime-foundations-refactor-plan.md`.

> Terminology: "capability" in this document follows the codebase's established usage —
> a named permission evaluated centrally against grants on principals. This is a
> host-mediated authorization model, deliberately not an object-capability
> (reference-possession) model; ambient reachability of open-tier services inside a
> trusted workspace is the product stance, not an oversight.

## 1. Why a redesign, not a fix-up

The branch review found a split personality: workspace code and agents receive empty
authority envelopes (denied nearly everything), while the intended completion path —
generators that scan source, infer capability use, and copy inferred requests into product
grants — would make authority follow mutable source paths and apparent use rather than
decisions. Alongside that: two Durable Object bases with different enforcement semantics,
a dispatcher contract (acquisition/challenge/preauthorization) nothing implements, grant
`binding` variants the evaluator never reads, a delegation model that never fires, and a
legacy approval system running in parallel with the new one. Types promise properties the
runtime does not have.

The fix is a smaller **authority core** with a different center of gravity, not migration
patches. (One part of this plan — context integrity, D8 — is a genuinely new construction,
and is billed as such below rather than folded into the "smaller" claim.)

## 2. Trust model

Vibestudio is a mutually-trusting family/team environment (multi-user plan §0.0). Users are
not threats to each other. The capability system exists for exactly three jobs:

1. **Controllability of code, especially agent-written code** — "is this blessed code or
   something edited five minutes ago?" is a code-identity question.
2. **Gating the dangerous surface** — credentials, external network, destructive and
   system-modifying operations. The only place approval friction belongs.
3. **Agent UX** — discover what exists, know what is callable, and have a recoverable path
   (approval, not a dead end) when something isn't.

The untrusted parties in this environment are not users; they are **content** — web pages,
API responses, logs, cloned repos, dependencies — flowing into agent context. Hence the
core principle:

> **In an agentic/eval setting, trust lives with the context that has been given to the
> agent, paired with the code identity of the harness.**

An agent is model + harness + context. The model holds no authority. The harness (the
runtime that assembles context, mediates tools, and mints evals) is durable, digest-bound
code. The context determines whether an action expresses user intent or outside influence.

## 3. Decision record

### D1 — Method tiers are the primary axis; distinct from SA1 severity

Every service/DO method is classified into one of three **tiers**:

- **open** — callable without any grant (D2).
- **gated** — requires authority: a grant, acquired via approval when absent.
- **critical** — authority is never standing; every exercise requires fresh user approval.

The tier is a _static floor_ — "can this method ever require approval." It deliberately
does **not** reuse SA1's `routine | sensitive | critical` vocabulary, because SA1 severity
answers a different question: whether a _specific pending approval_ may be resolved by a
delegated policy. SA1 severity is a per-approval **verdict**, computed at acquisition time
over the concrete invocation, resource scope, and grant state (the same operation can be
routine when reusing an existing grant, sensitive when widening scope, critical for
secret-bearing scope — per the SA1 spec). The two compose: tier decides _whether_ an
approval is needed; SA1 severity decides _who may resolve it_. Nothing in this plan changes
SA1's classification or erases an approval boundary it defines.

Source of truth: the tier is a **new** field introduced in P2. The existing
`MethodSensitivity` (`read | write | admin | destructive` in
`packages/shared/src/serviceAuthority.ts`) and declared `AccessApproval` gates are _seed
input_ to the P2 classification audit — they are related but not the same concept, and many
methods currently carry no classification at all. The read-only-mode gate keeps consuming
`read/write` semantics unchanged.

The tier is **mandatory forever, not just during the P2 audit**: a method registered
without a tier is a build/registration error. There is no default tier — "open" waives
grants and "critical" forbids standing authority, so a silent default in either direction
is wrong; fail-closed here means failing the build, not guessing.

### D2 — Open tier is implicit — but only the grant requirement is waived

Open methods are callable by any workspace code and any eval with no manifest declaration
and no grant. This removes **only the grant/approval requirement**. Everything else in the
compositional requirement model still applies to open methods:

- declared `@rpc` principals and per-method requirements (`workspace-member`,
  `agent-binding`, …),
- resource scoping and read-only gating,
- receiver-side enforcement (D7) — reachability is still decided per method by its
  declaration, which the P1/P2 audit tightens; "open" never means "every runtime may
  address every object."

One standing rule replaces the bulk of the 2,975-line generated catalog. This is what
restores basic agent functionality. Internal infrastructure methods that are inappropriate
for arbitrary code are **not open** — classifying them correctly is an explicit P2 audit
obligation, not an assumption.

### D3 — Authority comes from decisions, never from inference

The generator pipeline (scan source → infer requests → copy requests into grants) is
removed as an authority source. The scanner survives as tooling only: proposing
`vibestudio.authority` blocks and CI-diffing declared-vs-evident use. Nothing an inference
produces confers authority.

### D4 — Two modes of code authority, one evaluator

- **Mode 1, installed units** (panels, workers, DOs, agents): static. Gated capability
  use requires a declared request in the unit's checked-in manifest AND a grant.
  The intersection rule in `evaluateAuthority` stays. Grants bind to code digests.
- **Mode 2, eval/agentic**: dynamic. Eval code is not a durable principal — it is an
  articulation of its initiator's intent. Authority comes from an envelope minted at spawn
  from the initiator chain (acting user → harness → session), plus interactive acquisition.
  Individual invocations and snippets still have content-addressed identity (D5, D6) so
  consent can bind to exactly what was shown.

Skills are **not** units in either mode: a skill is instruction content interpreted by an
already-running harness (a `SKILL.md` at a workspace repo root or under
`workspace/skills/`). Skills never originate RPC and are never principals. They
participate in the model as _content_ (class per D8) and as pinned inputs to a mission
closure (D9).

**Origin and subject-matching semantics.** Subject selection is a core evaluator rule,
so it is specified, not implied — and it encodes the **harness-as-conduit inversion**:
the harness's own code is nearly powerless; standing agentic authority attaches to the
mission/context, which the eval code spawned under it exercises. The harness legitimately
has _less_ authority than its evals.

- Every call has exactly one authorizing origin (unchanged). Host-originated → `host`;
  an installed unit's call → `code` (unit digest); a harness's own call → `code` (harness
  digest — holding only minimal declared infrastructure capability: spawn evals, post to
  its own surfaces, submit approval requests; never ambient authority); an **eval call →
  `session`** (new origin kind; snippet digest, mediating-harness digest, mission, and
  initiator chain ride along as authenticated context facts).
- For a `session` origin, grant lookup matches the subjects `session:<id>` (interactive
  approvals) and `mission:<missionId>@<closureDigest>` (standing agentic authority) — both are
  authenticated facts _of the session_: the host knows which mission spawned it and which
  blessed harness mediates it. A mission grant is not harness authority reaching in; it
  is the session's own authority by virtue of being that mission under that harness.
  Precisely stated, the invariant is **single-origin authority**: the evaluator consults
  exactly one principal's authority set — here, the grants whose subject is the session
  id or its authenticated mission — and never any other principal's grants (the acting
  user's personal grants, the harness's code grants, other sessions'). Within that one
  set: deny precedence is uniform (a deny on either subject blocks an allow on the
  other); compound requirements evaluate against the set as a whole; a live **user**
  approval may mint session grants beyond the mission's preauthorized envelope (the
  human outranks the envelope), while an SA1 **delegated** decision may never exceed it.
  There is no projection/copying machinery — mission binding is direct subject matching.
- Requirement vocabulary: `requirementForPrincipals` maps a declared `code` principal to
  the executing-code family `{code, session}` by default — a method open to installed
  code is open to evals. A method may opt out with an explicit `codeOnly` restriction.

`evaluateAuthority` remains the single evaluator for both modes.

### D5 — Grant subjects: the subject algebra

The principal vocabulary is extended so that every grant subject is a first-class
principal, matched **exactly** (no pattern subjects):

| Principal | Form                                  | Lifecycle                                                                           |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| user      | `user:<userId>`                       | durable                                                                             |
| host      | `host:<hostId>`                       | durable                                                                             |
| code      | `code:<repoPath>@<digest>`            | lapses on any content change                                                        |
| entity    | `entity:<entityId>`                   | attribution/lifetime only — never a grant subject (see below)                       |
| session   | `session:<sessionId>`                 | dies with the session                                                               |
| mission   | `mission:<missionId>@<closureDigest>` | digest half lapses on any closure change; id half dies with the registry entry (D9) |

Grant-to-authority mapping:

| Authority                         | Grant subject                         | Constraints                                                                                                 |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Open                              | none (implicit)                       | —                                                                                                           |
| Gated, single action (eval/agent) | `session:<id>`                        | `invocationDigest` — single-use, see D6                                                                     |
| Gated, session rule (eval/agent)  | `session:<id>`                        | capability + resource scope                                                                                 |
| Gated, standing (agentic)         | `mission:<missionId>@<closureDigest>` | the closure pins the harness digest; the id binds this registry entry — identical charters never alias (D9) |
| Gated, installed unit             | unit `code:path@digest`               | requires declared request                                                                                   |
| Critical                          | never standing                        | fresh user approval only                                                                                    |

Notes:

- The `binding` field on `AuthorityGrant` is deleted; everything it tried to express lives
  in the subject (exact principal) and `constraints` (`sessionId`, `invocationDigest`,
  `missionDigest`). There are **no path-pattern subjects** (`code:path@*` does not exist):
  digest-bound is not just the default but the only code binding — edits (human or agent)
  lapse the grant and re-approval shows the diff. Ephemerality where wanted is expressed
  by session or snippet subjects, not by weakening code identity.
- There is deliberately **no snippet-subject grant** ("approve this exact script"). Eval
  code is regenerated per task; byte-identical recurrence is rare, and a source-text hash
  is not an execution identity anyway. The use cases it would serve have better homes:
  repetition within a session → session rules; recurring/unattended scripts → a mission
  (D9), whose closure pins the environment properly; a script that stabilizes into a tool
  → promotion to an installed unit (D12). Snippet digests survive only as facts — in the
  invocation snapshot (binding `once` grants, carrying code lineage) and in provenance.
- The entity remains what it should be — attribution and lifetime. `agent-binding` is a
  relationship fact requirements can demand (`allOf`), not a competing authorizing origin,
  and grants are never subject to an entity. No grant-set unions (confused-deputy rule
  preserved).

### D6 — The approval system IS the acquisition path

The existing approval flow (approvalQueue, push prompts) is not legacy — it is the
acquisition mechanism of the one model. The parallel machinery (dispatcher
`acquisition`/`challenge`/`preauthorization` contract surface,
`ServiceDispatcher.preauthorize()`, `EvalCapabilityAcquisition`, run-scoped grants) is
deleted and rebuilt as one loop with **specified transaction semantics**:

1. A gated call without authority fails with a typed **acquirable** error — or, for evals,
   suspends on the prompt. The error/prompt carries an immutable **invocation snapshot**:
   capability, resolved resource key, argument digest, snippet digest (for evals), the
   initiator chain, the session's context-integrity lineage (D8), and the **subject code's
   own lineage class** (a snippet inherits the class of the session that generated it; an
   installed unit carries its source's provenance class — persisted facts, independent of
   the current session's latch), and a digest of **host-resolved authorization state**:
   prepared requirement leaves, provider/credential selection, resolved target identity,
   and any other host-selected fact the authorization depends on beyond the arguments.
   The snapshot is content-addressed as the **invocation digest** — so a change in
   prepared state between prompt and retry genuinely produces a new digest and a new
   prompt, not just a change in arguments.
2. approvalQueue presents it (user, or SA1 delegated policy when absent). SA1 computes its
   severity verdict here, over this concrete snapshot — and **metabolizes code lineage**:
   external-lineage code floors the verdict at sensitive (never delegable-as-routine),
   delegation policy matchers receive lineage as a field (policies may refuse or require
   grantor presence for external-lineage code), and the human prompt displays the chain
   ("this script descends from example.com via session X").
3. The decision mints an ordinary `AuthorityGrant` into the **single grant store**, with
   the **object of consent stated honestly in the prompt**:
   - **Allow once** — grant constrained to this exact `invocationDigest`. Consuming it is
     an atomic single-use compare-and-swap; the retried call must present the _same_
     invocation digest (changed arguments or prepared state = new digest = new prompt);
     concurrent calls race for one consumption. Consumption happens immediately before
     effect execution; if the effect then fails, the grant is spent and the retry
     re-prompts (cheap, and fails toward the human).
   - **Allow this session** — consent to a **rule**, not a snippet: "allow `<capability>`
     on `<resource scope>` for this session." The displayed snippet is context for the
     decision, not its object — the prompt copy says so. Every session-rule grant records
     **`lineageAtConsent`**: the set of external lineages displayed and accepted at
     approval time. The use-time gate (D8) requires the context's lineage set ⊆ internal
     ∪ `lineageAtConsent`. So a rule approved while the session was clean does not survive
     later taint silently (new lineage ∉ consent set → re-prompt), while a rule knowingly
     approved _with taint visible_ is exercisable under exactly that taint — and still
     re-prompts if yet another external lineage enters. **Consent covers the sources
     shown**: lineage keys are source-scoped identities (a domain, an API provider, a
     log stream — per the context-integrity spec's LineageKey grammar), so accepting
     "content from example.com" knowingly covers further content from that same source
     within the rule's life; a _new source_ re-prompts. The prompt copy states the
     source-level meaning plainly.
   - **Standing** — digest-bound per D5; only offered where the tier and SA1 verdict
     permit.
4. The call retries/resumes.

**Denial is part of the model, not approval UI.** A deny decision mints an
`effect: "deny"` `AuthorityGrant` with the same subject/scope options as allows (this
invocation via `invocationDigest`; session rule; standing against a code **or mission**
subject — a mission deny durably blocks that mission's standing allows). Deny
outranks allow — the existing evaluator rule. **Dismiss** mints nothing, but
approvalQueue dedupes by invocation digest / rule key with a cooldown, so a stuck or
adversarial runtime cannot storm re-prompts after rejection. Denials are listed and
revocable in the permissions surface alongside allows; SA1 delegated policies may deny
(recorded with policy provenance); a denied preauthorization rule simply never enters the
envelope.

**Preauthorization** returns with a real purpose: before a long autonomous run, an agent
declares the capability/resource rules a task needs and the user approves the batch once —
a task-scoped envelope (bounded by the task's lifecycle and the mission, D9 — not by a
clock) instead of mid-run
interruptions. Batches are **always user-approved, never SA1-delegable** — a
preauthorization _is_ the user pre-directing a mission, so no policy may stand in for
them. The batch prompt shows each rule's worst-case SA1 severity within its scope; a rule
whose worst case is critical cannot be batched (its invocations prompt individually).
SA1 policies evaluate _against_ envelopes at runtime; they never create them.

### D7 — One DO enforcement semantics, behind a parity audit

Extract the enforcement from `workspace/packages/runtime/src/worker/durable-base.ts`
(attestation verification: audience/method/resource/freshness/read-only, then
`evaluateAuthority` against `@rpc` metadata) into a shared module consumed by BOTH bases.
`packages/durable` verifies the attestation the server already stamps
(`attestDirectRpc` fires on every direct relay today; nothing consumes it). Undeclared
methods are default-deny.

**The existing `@rpc({principals})` declarations on internal DOs are NOT trusted as
transcriptions of the legacy guards — they are demonstrably broader in places** (e.g.
BrowserData declares host/user/code while its effective legacy guard admits only
server/shell/one broker extension). Therefore the order of operations is:

1. **Parity audit**: for each of the ~118 internal declarations, tighten
   principals/requirements to be at least as restrictive as the effective legacy guard
   (or explicitly record the intended widening as a reviewed decision).
2. Turn on shared enforcement (attestation + declarations, default-deny).
3. Only then delete the caller-kind guards (`callerKind === "server"`,
   `isTrustedWorkspaceCaller`, per-DO overrides) per R3.

Deleting guards is subtraction only _after_ step 1; without it, it is a reachability
change to sensitive internal state.

**Audit baseline.** The current worktree has _already_ deleted several effective legacy
guards (e.g. BrowserData's shell/server/broker check survives only in git history) while
the internal base defaults open — i.e., the branch as it stands is already wider than the
pre-branch state. The parity audit's source of truth is therefore the **merge-base
commit's effective guards** (recoverable exactly from git), not the current tree, and P1
is urgent rather than optional: it _restores_ restrictions the branch has dropped, then
re-expresses them as declarations.

**Events are part of the inbound surface.** DO bases receive non-request **event
deliveries** through a distinct path (`assertInboundAllowed(caller, "event")`), today
default-open on the internal base. Unified enforcement covers them: a DO's event intake
is declared (which sources/audiences it accepts, alongside its `@rpc` methods),
deliveries carry the same host attestation, and undeclared or unattested events are
default-deny. The parity audit includes the event path; "one DO enforcement semantics"
means the complete inbound envelope surface, calls and events both. Event attestation
stamping (the server-side half) is **in P1 scope**: default-deny for undeclared or
unattested events is active at the end of P1 — no interim "accept unattested" state
survives the phase.

### D8 — Context integrity: the internal/external lattice

The load-bearing question is: **did network/API-origin content get into this context?**

Two content classes, monotone lattice:

- **internal** — born inside the workspace from clean lineage. User authorship is simply an
  internal write (no separate "reviewed" class — human content review is not a behavior the
  model may depend on).
- **external** — crossed the workspace boundary — and everything downstream of it. Sticky
  until explicitly vouched.

**Mediation inventory.** The latch is only as good as the enumerated chokepoints. In scope,
stamped/latched explicitly:

- harness tool responses: web/HTTP fetch, external APIs and MCP servers, email, search;
- external-origin logs (always external — matches the log-watcher design);
- fs service reads/writes; VCS operations (provenance-record class, P4b);
- git clone/fetch from external remotes; package/dependency install (lockfile-entry
  identity); file upload/drag-in;
- channel messages (message-level class — lands with the R4 channel work);
- skill content at context-assembly time (a skill's class is its content's class).

Known gaps, stated rather than hidden: model cognition is not tracked (a paraphrase of
external content is external only because the _session_ latch says so, not because the
bytes are traced); sub-file granularity does not exist; content that entered before P4a
ships is ungoverned until grandfathered (below). Any read path added later that bypasses
these chokepoints is a hole — the mediation inventory is a maintained list, and adding an
ingestion path without a stamping decision is a review flag.

**Mechanics:**

- **Session latch (P4a).** The harness tracks the max class over everything ingested,
  keeping the ingestion log for explanation. It attests the session's class on outbound
  calls (`AuthorizationContext` gains the fact; `AuthorityRequirement` gains a
  `context-integrity` relationship). The attestation is trustworthy **by design decision**:
  the harness is digest-blessed first-party code, and an edited harness loses its blessing
  and its attestations with it. We accept that the harness participates in monitoring its
  own context — the alternative (host-side information-flow tracking through model
  cognition) is out of scope by explicit choice.
- **Persisted content classes (P4b).** Content-writing chokepoints stamp the artifact's
  class from the writing session's class — a field on the provenance record the VCS
  already keeps. With fine-grained provenance, `internal` is _computed_ ("written by a
  session whose ingested set was ⊆ internal"), and taint explanations show the exact
  trajectory chain. Granularity is the content's natural identity: repo, package@version
  (lockfile entry), subtree, file digest, message.
- **Gate.** Standing gated grants — and session-rule grants (D6) — are checked at **use
  time**: the context's lineage set must be ⊆ internal ∪ the grant's `lineageAtConsent`
  (empty for standing grants — standing authority never pre-consents to taint). Open is
  unconditional. Critical always prompts regardless.
- **Interactive approval launders per-action.** A tainted session loses standing and
  session-rule authority; every gated action routes through the prompt, where the human
  sees the concrete invocation snapshot + lineage, and their approval converts
  outside-influenced proposal into user-directed authority for exactly that invocation
  (once) or knowingly re-establishes a rule with the taint visible. (This generalizes the
  log-watcher incident-card flow.)
- **Vouch.** One explicit operation converts external content to internal: attributed,
  scoped to the content's identity, version/digest-bound. **Vouching changes future
  authorization** — content it covers stops tainting, so standing grants can be exercised
  in contexts containing it. Because it is authority-amplifying, vouch is itself
  classified in the model, not left as UI: it is a **gated operation on a user/host-only
  surface** (no `code` principal), **always human-resolved** — never SA1-delegable in v1
  — with SA1 severity _sensitive_. It may be _requested_ from any session, including a
  tainted one (the request is a proposal like any other), but resolves only in trusted
  UI. A one-click vouch inside a taint-approval prompt is recorded as a **distinct
  decision** from the action approval it accompanies — approving the action never
  implicitly vouches the content. Vouch UX rides acquisition moments (VS Code
  workspace-trust precedent): a trust prompt at repo clone, at dependency install
  (persisted against the lockfile entry; version bumps re-ask), at file upload — plus
  one-click vouch from inside any taint-approval prompt, lineage displayed. A
  provenance-powered **trust inspector** UI lists un-vouched lineages in a project for
  batch exception management. Nobody pre-classifies content, ever.
- **No future-version trust.** Vouch and executable admission are exact-version
  decisions. Package names, unit names, and generated censuses never authorize
  future bytes. Agent-identity trust is a separate relationship decision: delegated
  eval may act for that agent, but every action still intersects the agent worker's
  current reviewed execution identity and manifest.
- **Migration:** content committed at cutover is grandfathered internal.

Expected steady state: ordinary work on your own projects never taints (internal lineage +
vouched deps). Prompts cluster exactly where they should — sessions inside freshly cloned
un-vouched repos and un-vouched dependency source — and each prompt carries its own
durable exit.

**Two influence channels, both covered.** External content can steer actions two ways:
through the **cognition channel** (content in context influencing the model — governed by
the session latch, which gates standing-grant _exercise_) and through the **execution
channel** (external-lineage code acting directly when run). The execution channel is
governed by code lineage metabolized at authority decisions: it escalates approval
severity and constrains delegation (D6 step 2), and it gates standing-grant _issuance_ —
**a code subject may receive a standing grant only if its content is internal or
vouched**. Vouch-the-content is thus a prerequisite ceremony before bless-the-code: the
lattice gates entry to the authority tier; blessing assigns the role. The same rule
applies at D12 promotion — installing a unit whose source has external lineage includes
vouching it, chain displayed. Both channels degrade to prompts-with-provenance, never to
lockout.

**Failure analysis, stated precisely.** In the fail-aggressive direction (over-tainting),
nothing blocks: gated actions re-route through the interactive prompt with an explained
lineage and a one-click durable fix. In the fail-lax direction (a missed chokepoint or a
blind vouch), externally influenced execution can exercise standing gated grants — that is
a real loss of D8's protection, and honesty requires saying so; what remains is **today's
model** (standing grants without any context gating) plus the boundaries that never
depended on D8: the credential out-of-band system, critical-tier always-prompt, and
harness/unit digest blessing. D8 is an _added_ protective layer over the status quo, not a
replacement for those boundaries — it can degrade to the status quo, never below it.

**What safety rests on.** Stated so nobody mistakes this model for something it isn't:
D8 is provenance monitoring plus central mediation, not confinement. Nothing here makes
authority absent by construction (contrast object-capability systems, where confined
code starts with no references and can only use what it was explicitly handed). The
system's safety properties rest on three pillars — **complete mediation** of the
ingestion chokepoints, **classification quality**, and **attestation integrity** via
blessed conduits — plus the human checkpoints the model routes decisions through. The
one structural (reachability-bounding) element is the mission closure's tool-exposure
list, which limits what an unattended agent can even address. This is the deliberate
product stance for a host-mediated trusted workspace; it trades confinement-by-
construction for UX, and the trade is made with eyes open.

**Scope honesty.** D8 — especially P4b — is a distributed provenance-propagation system
spanning fs, VCS, channels, installs, and sessions. It is the largest new construction in
this plan and the only part whose soundness depends on comprehensive mediation across
evolving subsystems. That is why it is phased last-but-one, split so that P4a (the
harness-local ingestion latch, covering the primary threat: network content entering
context directly) ships small and early, while P4b (persisted classes closing the
laundering-through-files gap) is the long-tail build.

### D9 — Missions: content-addressed context IS the standing authority subject

For recurring/autonomous agents (cron, watchers, SA1 policies), standing grants are
minted **to the mission**: subject `mission:<missionId>@<closureDigest>` — identity +
version, parallel to `code:<repoPath>@<digest>`: the digest half lapses authority on
any charter change; the missionId half binds authority to _this_ registry entry, so a
byte-identical charter elsewhere (another entry, another owner) never shares it, and
retiring the entry kills its grants without touching look-alikes. The mission digest is an
**EV-style closure** — reusing the R1 content-closure pattern — over everything that
charters the agent's behavior:

- the task spec / system prompt,
- the harness digest (already paired via the grant subject),
- pinned skill digests (skills the mission loads are part of the charter),
- tool exposure / service bindings,
- model configuration and provider selection,
- schedule/trigger configuration.

Because the closure hashes both the task spec and the harness digest, a mission grant is
**literally a content-address of the (context-charter × harness-identity) pair** — the
core trust principle (§2) turned into an identifier. This is also the harness-as-conduit
inversion (D4): the harness's own code holds no ambient authority; the mission does, and
the eval code spawned under it exercises it.

Changing any closure input lapses the grant; re-approval shows the diff. Mutable
workspace _data_ the agent reads at runtime is deliberately excluded — it changes
behavior, not charter, and is governed by D8 instead. Interactive sessions need no
mission (live user turns are the charter; their authority is session grants).

### D10 — Harnesses are above the content lattice

Internal lineage qualifies content to _enter context_. It never qualifies code to act as
a trusted conduit. Harnesses require digest blessing regardless of how clean their
lineage is — otherwise a clean session could author a harness that misattests taint, and
the model is circular. Blessing assigns the **conduit role**, never capabilities: a
blessed harness's attestations are trusted and its digest is eligible to appear in
mission closures (D9), but its own code principal holds only minimal declared
infrastructure capability. Standing agentic authority belongs to missions, not
harnesses (D4/D9).

Privileged first-party units get their blessings from one small hand-written policy file,
resolved to `code:repoPath@digest` **from the host-shipped product snapshot at seed time**
— the digests are computed over the seeded content that ships with the host build (the
SA0 blessed-EV construction), never over the live workspace tree. A host upgrade re-seeds
and re-blesses its own shipped digests; a workspace edit produces a different digest that
matches no blessing and drops to ordinary-code authority. The two statements "host
rebuilds re-bless" and "workspace edits lose blessing" are compatible precisely because
blessing keys off immutable shipped provenance, not the mutable path.

### D11 — Discovery tells the truth it can compute

Authorization is resource-dependent, so a bare catalog entry cannot carry one global
callable/not-callable verdict. Discovery is therefore two surfaces:

- **Catalog** (per method, per caller): tier badge; whether the caller holds any standing
  grant and its resource scope; acquirability class ("would prompt — approval", "would
  prompt — your context is tainted", "unavailable to your principal kind"). Honest
  summaries, explicitly not per-resource verdicts.
- **Preflight**: `preflight(service, method, args)` — a no-effect dry-run of the full
  `assertAuthority` path for a concrete invocation: every requirement leaf (compound
  `allOf`/`anyOf`, argument-derived resources, prepared authority state, principal
  restrictions, read-only sensitivity), returning the decision, what acquisition would be
  offered on failure, and an SA1 severity preview. A capability/resource leaf query
  (`can(capability, resource)`) remains available as a cheap helper, but only preflight
  answers "is this call callable/acquirable" truthfully, because only an invocation has
  that property.

No more filtering by caller-shape into "tool exists, call fails."

### D12 — The promotion path

When an eval snippet matures into an installed unit, its `vibestudio.authority` manifest
is derived from the grants it actually acquired during its eval life. The lifecycle is
explicit:

1. **Observe** — the capability/resource pairs this code's snippet lineage actually
   _exercised_, taken from invocation-snapshot records. Not the session's rule grants:
   session rules consent to the session's work, which spans many snippets and unrelated
   tasks — consent is not attributable to a code identity, but observed use is.
2. **Propose** — a generated manifest draft: capability + resource-scope requests
   translated from the observed invocations.
3. **Confirm at install** — the user reviews the draft as part of installing the unit;
   this approval is the actual authority decision and mints the unit's digest-bound
   grants. Session grants are untouched — they belong to their sessions and expire with
   them. If the unit's source carries external
   lineage, the confirmation includes vouching it (chain displayed) — per the D8 rule
   that standing grants are only issued to internal-or-vouched code.

Manifests are thus the _output_ of the dynamic system on this path; on the static path
(D4 Mode 1) they remain the checked-in input they always were. The scanner's CI-diff mode
checks declared-vs-evident drift either way.

### D13 — Deletions (types promise only what is enforced)

- `AuthorityGrant.binding` (all four variants) — replaced by the subject algebra +
  constraints (D5) before deletion, not after.
- `VerifiedDelegation`, `CodeAuthorityChain.delegations`, the `delegation` requirement flag
  and relationship — the host sees the whole initiator chain as authenticated facts;
  attenuation is the envelope + preauthorization, not wire chains.
- `CodeAuthorityChain.execution/initiator` as currently shaped — replaced by the minimal
  eval fact set: initiator chain, runId, snippet digest, invocation digest, mission
  digest, context class.
- Dispatcher resolver contract fields `acquisition`/`challenge`/`preauthorization` and
  outputs nothing consumes; `ServiceDispatcher.preauthorize()`; run-scoped grants
  (rebuilt per D6).
- `device` principal, `deviceOwnership`, `device-owned-by-user`; `entity-deputy`;
  channel-owner/editor/member relationships (R4 owns channel authority);
  `ExecutionArtifactRef` parallel module (fold needed pieces into the one identity path);
  unused `ResourceScope` variants and grant `constraints.min/maxVersion` if still unused
  after the rebuild.
- `productAuthorityGrantCatalog.generated.ts` and the request→grant copying in the ledger
  generator; `scripts/generate-unit-authority-manifests.mjs` as an authority source.
- All caller-kind guards — after the D7 parity audit, not before.
- The `permissionsService` drops `code` from its principals — grant management is a
  user/host surface at the critical tier.

## 4. Phases

Each phase states its **interim semantics** — what the security/authority model is while
that phase is the latest one landed.

**P1 — Shared enforcement + parity audit + safe purge.**
Extract the shared DO enforcement module; wire attestation verification into
`packages/durable`; run the declaration-vs-guard **parity audit** and tighten the ~118
internal declarations; enable declaration enforcement default-deny; _then_ delete
caller-kind guards. Delete the dead constructs that have no replacement dependency
(`VerifiedDelegation`, device/channel/deputy relationships, `ExecutionArtifactRef`,
unread resolver contract fields). `AuthorityGrant.binding` is deleted here too since
nothing reads it, with the D5 subject algebra landing before any new binding-like need
arises (P3).
_Interim semantics:_ reachability is never wider than the legacy guards (audit
guarantees); everything else behaves as today.
Touches: `packages/durable/src/index.ts`, `workspace/packages/runtime/src/worker/durable-base.ts`
(extract), `packages/rpc/src/authority.ts`, `packages/shared/src/authorization.ts`,
`src/server/services/authorityRuntime.ts`, internal DO declarations + guard overrides.

**P2 — Tiers + implicit open + catalog collapse.**
Introduce the tier field (new; seeded from `MethodSensitivity` read/write/admin/destructive,
`AccessApproval` declarations, and the parity audit — every method gets an explicit tier,
gray cases biased open per the trusted-env framing, internal-infrastructure methods
explicitly gated or principal-restricted). The same audit decides **session admission**
for every existing `code` declaration — confirm `{code, session}` or mark `codeOnly` —
because those declarations were authored under installed-code semantics; the family
default applies as authored intent only to declarations written after this audit, never
silently to old ones (credential pairing and similar surfaces are exactly the cases this
catches). Implement the open-tier implicit rule in the evaluator path. End the generated
catalog's role **for open methods only** — for gated/critical methods the catalog is
**frozen and retained** as the dispatcher admission table (it is what lets those calls
reach the handlers where today's prompts live; full deletion happens in P3 when
acquisition replaces admission). Install the hand-written seed-blessed conduit policy
(D10) with seed-time digest resolution from the shipped snapshot; builder treats
malformed manifests as build errors (absent = unit holds no gated declarations).
**P2 enforces only the open tier.** Gated-tier enforcement at the dispatcher does NOT
land in P2, because today's approval prompts live _inside_ service handlers
(`requestCapabilityPermission`/`withCapability` in egressProxy, externalOpen, gitInterop,
…) — a dispatcher-level rejection would fire before the handler and make the legacy
prompt unreachable, turning every gated method into a dead end. So in P2 the tier is
assigned and _recorded_; open methods get the implicit rule; gated/critical methods keep
today's exact dispatcher behavior (existing legacy/product grants honored, handler-level
prompts still working). Dispatcher-level gated enforcement lands **atomically with P3's
acquisition loop**, which replaces the handler prompts it obsoletes.
_Interim semantics:_ agents/workspace code regain open-tier functionality; gated calls
behave exactly as today — no recovery gap because nothing about their path changed yet.
Touches: `productAuthorityGrants.ts`, generated catalogs (open-role removal + freeze),
`generate-runtime-foundation-ledgers.mjs` (reduce to ledger/docs output),
`serviceAuthority.ts`, `builder.ts`.

**P3 — The acquisition loop, eval-first.**
Subject algebra (D5) in the principal vocabulary and evaluator; typed acquirable errors
with invocation snapshots; once-grant CAS + invocation-digest binding; eval
suspend/prompt/resume; session-rule consent framing in prompt copy; single grant store
consolidation (`capabilityGrantStore` becomes the single authoritative store of
`AuthorityGrant`s; the userland approval store migrates in; credential-use grants remain
in the credential system); **mission-closure digest machinery** (D9 — implemented here
because grants and envelopes are defined against it, but see the P4a gate below);
dispatcher-level gated enforcement switched on as handler prompts are replaced (see P2),
retiring the frozen admission catalog; the `preflight(service, method, args)` dry-run
API lands **with** enforcement, not after it — agents get "would this call succeed, and
what would it cost" the moment gated enforcement exists; SA1 delegated-approval hookup
(severity verdict computed over invocation snapshots).
**Gating deliverable:** `approval-prompt-ux-spec.md` — the prompt registry, card types,
vocabulary rules, fatigue mechanics, scope defaults, and push variants. No acquisition
prompt ships outside that registry; capability display metadata (action phrases) is
fail-closed at build like tiers. The prompt layer is a correctness property of this
model, not polish: the design routes trust through humans reading prompts.
**Minting of mission standing grants and preauthorization envelopes is gated on P4a.**
P3 ships session-scoped authority only — always human-in-the-loop by construction. New
unattended authority paths must never precede the context boundary that constrains them:
introducing mission grants before the latch would let external content steer an
unattended mission with no human checkpoint, violating §2 outright.
_Interim semantics:_ session grants carry today's context semantics until P4a adds
lineage gating (a defined upgrade); no unattended authority exists yet.
Touches: `serviceDispatcher.ts`, `src/server/index.ts` resolver, `approvalQueue.ts`,
`evalService.ts`/`evalDO`, grant stores, agent runtime SDK.

**P4a — Context-integrity latch (small, early).**
Harness-local session latch over direct external ingestion (web/API/MCP/email/search tool
responses, external logs, un-vouched clone/install/upload identities); ingestion log;
attestation fact on outbound calls; `context-integrity` requirement wired into the
gated-tier default (standing + session-rule grants); taint lineage in approval prompts;
vouch operation + storage with clone/install/upload trust prompts; migration
grandfathering; the outside-content prompt variants (banner, trust, always-trust cards
per `approval-prompt-ux-spec.md` §5.2–5.4) land here with the latch. **With the latch
live, mission standing grants and preauthorization envelopes switch on** — their minting was gated on this phase (see P3): unattended
authority never exists without the context boundary that constrains it.
_Interim semantics:_ the primary threat (network content directly in context) is latched;
laundering through files written by tainted sessions is not yet tracked (known gap until
P4b).
Touches: harness runtimes (AiChatWorker, SystemAgentWorker), ingestion tool surfaces,
`AuthorizationContext`, approval prompt UI, vouch store.

**P4b — Persisted content classes (the long-tail build).**
Provenance-record content class + write-time stamping at the fs/VCS/channel/install
chokepoints; computed-internal from trajectory lineage; message-level class with the R4
channel work; trust-inspector data. Closes the file-laundering gap; the mediation
inventory (D8) becomes a maintained checklist.
Touches: fs service, VCS provenance records, channels, skill/content ingestion at context
assembly.

**P5 — Truthful discovery + promotion tooling.**
Catalog tier/grant/acquirability summaries (the `preflight` API itself lands in P3, with
enforcement); mission surfacing in discovery;
grants→manifest promotion pipeline (D12); scanner retargeted to CI drift-diff;
trust-inspector UI.
Touches: `docsService.ts`, `buildCatalog.ts`, promotion tooling, scanner scripts.

P1–P2 yield a working system whose reachability is never wider than today's and whose
open-tier UX is restored; P3 is the centerpiece; P4a/P4b make the trust model real; P5 is
the payoff surface.

## 5. Reconciliation

- **R1/R2 (content-addressed EV, hermetic builds):** prerequisite and unchanged — digests
  used by D5/D9/D10 are these EVs; the mission closure (D9) reuses the R1 closure pattern.
- **R3 (one trust vocabulary):** preserved and completed — caller-kind checks deleted
  (P1, post-audit), everything expressed as grants on principals.
- **R4 (channel ownership):** channel authority relationships stay out of this model
  (deleted in D13); message content-class coordination lands with P4b.
- **SA0:** the system agent becomes a **seeded first-party mission**: SystemAgentWorker's
  digest is seed-blessed as a conduit (D10) and the `system.*` grants are minted to the
  seeded mission closure (D9) — SystemAgentWorker's own code principal holds nothing. No
  special case remains, and the SA0 firewall ("edited worker code runs inert") falls out
  twice over: an edit breaks both the conduit blessing and the mission closure.
- **SA1:** severity remains SA1's per-approval verdict, computed over D6 invocation
  snapshots; tier (D1) is a distinct, static concept; delegated approvals plug into D6
  step 2; delegation policies evaluate preauthorization envelopes; micro-session freshness
  maps to approvals evaluated without tainted conversation context (D8-consistent).
- **Log watcher:** its zero-capability posture becomes a consequence of D8 (permanently
  external context) rather than bespoke architecture; incident-card forwarding is the
  laundering flow.
- **WP5 provenance ledger:** approval resolutions now also record lineage shown and
  vouches made.

## 6. Open questions

1. Latch granularity: per-conversation is v1; per-context-subtree (letting a harness fork
   a clean sub-context from a tainted conversation for a specific tool call) is a
   plausible later refinement — decide only if prompt-clustering data demands it.
2. ~~Grant-store consolidation shape~~ **Resolved:** one single authoritative store for
   capability `AuthorityGrant`s — D6's atomic once-consumption, exact subject matching,
   deny precedence, and uniform constraints require single-store transactional semantics
   that a read-federation over heterogeneous stores cannot provide. The userland approval
   store migrates in during P3. Credential-_use_ grants are not capability grants and
   remain in the credential system (the out-of-band external-access boundary stays its
   own first-class domain).
3. Exact open/gated line for gray methods (e.g. workspace-scoped fs writes) — settle
   during the P2 classification audit, biasing open per the trusted-env framing.
4. Once-grant consumption ordering chose consume-before-effect (effect failure spends the
   grant, retry re-prompts). If re-prompt friction on flaky effects proves annoying,
   revisit with an idempotency-keyed re-issue rather than weakening atomicity.

## Service protocol declarations and concrete provider authority

`vibestudio.authority.serviceRequests` is the consumer-side review vocabulary for
workspace service discovery. Each entry names a stable protocol and whether the
service is required for activation or optional. It is deliberately not a grant:
runtime resolution continues to require the concrete
`workspace-service:<service-name>` capability.

Admission binds every declared protocol to the exact resolved service name,
provider unit, and provider catalog digest. That binding is part of the reviewed
unit identity. Replacing a provider or changing its authority catalog therefore
creates a new review identity; a replacement implementation cannot inherit the
previous provider's grant merely because it implements the same protocol.

The whole-workspace reverse index is built from these declarations without
compiling consumers. A per-unit analyzer attestation proves `actual service
queries ⊆ declared serviceRequests` under an explicit analyzer epoch. Analyzer
epoch changes revalidate those attestations off-thread; they never grandfather
code that a newer analyzer can now see.
