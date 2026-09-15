# Authority Acquisition Protocol Spec (P3)

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Acquisition details remain subordinate contracts. Protected authority placement and native resource enforcement are owned by U3.

Status: implementation spec for Phase P3 of `capability-model-redesign.md` (D5, D6, and
the evaluator deltas of D4). Companion: `approval-prompt-ux-spec.md` (card types, copy,
fatigue rules — referenced here by card-type id, never duplicated). Grounded in the
current code: `serviceDispatcher.ts` (assertAuthority / enforceRequirement),
`authorization.ts` (evaluateAuthority), the production resolver in `src/server/index.ts`,
`evalService.ts` / `EvalDO.ts` (execution model), `capabilityGrantStore.ts`,
receiver-declared userland capabilities, `approvals.ts`, and `approvalQueue.ts`.

Vocabulary note: user-facing wording lives exclusively in the prompt spec. Everything
below is internal API surface and may use model vocabulary freely.

## 1. The loop at a glance

```
gated call ──► dispatcher.assertAuthority ──► evaluateAuthority ──► allowed ──► handler
                                                   │
                                              not allowed
                                                   │
                                        mint AcquisitionRequest
                                        (invocation snapshot, §3)
                                                   │
                             pending registry dedupe (§6.3) ──► approvalQueue card
                                                   │                (§8)
                            ┌── caller can wait (§5): park the call ─┐
                            │                                        │
                      decision arrives              dismissed / lifecycle end / restart
                            │                                        │
                    grant minted (§4) ──► re-evaluate ──► proceed    │
                                                                     ▼
                                                     throw EACQUIRE (§2) with
                                                     acquisitionId; prompt stays
                                                     pending; retry re-attaches
```

The decision **always outlives the call**: a grant minted after the caller gave up is
persisted, and the retry sails through without a second prompt. This is the property
that makes the fail path acceptable DX.

## 2. The acquirable error

### 2.1 New error code

`EACQUIRE` — distinct from `EACCES`. `EACCES` now means _unacquirable_ denial (deny
grant in force, principal-kind mismatch, relationship failure, tier forbids this
caller). `EACQUIRE` means _a decision could allow this_ — a gated approval, or a
critical-tier fresh confirmation (§6.5): critical calls are acquirable too, they just
acquire a single-use confirmation instead of a grant. The eval-side
`EVAL_APPROVAL_REQUIRED` mapping in `enforceRequirement` is replaced by `EACQUIRE`
(same detection point: `decision.code === "missing-grant"` at gated tier, or
`missing-fresh-confirmation` at critical tier); `EVAL_APPROVAL_DENIED` maps to
`EACCES` with `denied: true`.

### 2.2 Shape

Thrown as `ServiceAccessError` with `code: "EACQUIRE"` and a structured `acquisition`
payload (serialized into the RPC error envelope's `data` field, which already crosses
every transport including the eval gateway):

```ts
interface AcquisitionInfo {
  acquisitionId: string; // stable id of the pending decision (§6.3)
  snapshotDigest: string; // invocation digest (§3.3)
  capability: string;
  resourceKey: string;
  tier: "gated" | "critical"; // critical acquisitions mint confirm.critical, never a grant (§6.5)
  cardType: "permission.gated" | "permission.outside" | "confirm.critical";
  renderedAction: string; // action phrase from display metadata (prompt spec §4)
  pending: boolean; // true if a card for this ruleKey is already showing/queued
  cooldownUntil?: number; // set when the ruleKey is in Not-now cooldown (prompt spec §6.2)
  decidedBy?: "user" | "rule"; // present on replay after decision, for transcripts
}
```

### 2.3 Propagation

- **Dispatcher → RPC:** existing `ServiceAccessError` serialization; `acquisition`
  rides the error `data`. No transport changes.
- **Eval gateway:** kernel `gatewayFetch` maps the error body to a thrown
  `AcquirableError` inside the sandbox — eval code `catch`es a typed error with
  `.acquisition`. The kernel helper `vibestudio.acquire(err)` (sugar) re-issues the
  original call after `awaitDecision` (§6.4).
- **Agent SDK:** tool-call results carry `{ status: "needs-approval", acquisition }`
  so the model sees a structured, actionable state rather than a stack trace. The agent
  runtime exposes `awaitDecision(acquisitionId)` (§6.4 — lifecycle-resolved, no
  timeout).

## 3. The invocation snapshot

### 3.1 Fields

Assembled in `enforceRequirement` at the point of denial. All fields are
host-authoritative — nothing is caller-supplied except via validated args.

| Field                 | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | In digest                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `v`                   | literal `1` (schema version)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | yes                                                                        |
| `service`, `method`   | dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes                                                                        |
| `capability`          | requirement leaf                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | yes                                                                        |
| `resourceKey`         | `deriveAuthorityResource` output (post-transform)                                                                                                                                                                                                                                                                                                                                                                                                                                | yes                                                                        |
| `argsDigest`          | sha256 over canonical JSON (§3.2) of the **Zod-validated** args array                                                                                                                                                                                                                                                                                                                                                                                                            | yes                                                                        |
| `preparedStateDigest` | sha256 over canonical JSON of the ordered **resolved preparation objects** — resolved requirement, provider identity + provider EV, authorizing-caller principal, challenge presentation — i.e. the full prepared shape of `serviceDefinition.ts` after live resolution (cf. provider selection in `workerService.ts`), not a summary triple. A provider or principal change with unchanged capability/resource _must_ change this digest. `"-"` when the method has no preparer | yes                                                                        |
| `callerPrincipal`     | authorizing origin principal string                                                                                                                                                                                                                                                                                                                                                                                                                                              | no (subject/context fact — the digest identifies the _ask_, not the asker) |
| `sessionId`           | the **durable agentic-session (conversation) id** — survives host restarts; never a connection id or eval-run id                                                                                                                                                                                                                                                                                                                                                                 | no (subject/context fact)                                                  |
| `mission`             | session's mission fact as `mission:<missionId>@<closureDigest>`, `"-"` if none                                                                                                                                                                                                                                                                                                                                                                                                   | yes                                                                        |
| `snippetDigest`       | sha256 of eval source text; `"-"` for non-eval callers                                                                                                                                                                                                                                                                                                                                                                                                                           | yes                                                                        |
| `codeLineage`         | subject code's lineage class (`internal`/`external`/`unknown`) + chain ids                                                                                                                                                                                                                                                                                                                                                                                                       | class: yes; chain: no                                                      |
| `contextLineage`      | session latch state: class + external lineage ids                                                                                                                                                                                                                                                                                                                                                                                                                                | no (display/consent only)                                                  |
| `initiatorChain`      | acting user, agent entity, harness digest                                                                                                                                                                                                                                                                                                                                                                                                                                        | no (context facts, already authenticated)                                  |
| `at`                  | timestamp                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no                                                                         |

Digest-excluded fields ride the snapshot object for prompts, consent recording
(`lineageAtConsent` = the external ids _displayed_), and audit — but must not break
retry identity (a retry after the same prompt must hash identically; lineage can only
have _grown_, which the use-time gate, not the digest, adjudicates).

**This section is authoritative for the digest definition.** Context lineage is
excluded from the digest _by design_ — the digest identifies the ask; taint that
arrives while a call is parked is adjudicated at consumption time by the
`lineageAtConsent` gate (§8.4), which applies to **every** grant kind including
once-grants (§4.2). Any companion-spec text implying the digest covers latch
class/epoch/keys is superseded by this definition.

### 3.2 Canonical serialization

Canonical JSON, enforced by one shared util (`@vibestudio/shared/canonicalJson`, new,
next to the existing `canonicalKey`): UTF-8; object keys sorted bytewise; no
insignificant whitespace; numbers per RFC 8785 (reject NaN/±Infinity; -0 → 0); strings
NFC-normalized; `undefined` properties omitted; arrays order-preserving. Zod validation
runs _first_, so defaults are materialized and unknown keys stripped — two calls that
parse identically hash identically.

### 3.3 Invocation digest

```
snapshotDigest = hex(sha256("vibestudio:invocation-snapshot:v1\0" + canonicalJson(digestFields)))
```

Domain-separated, versioned. `runId` is deliberately **not** in the digest: the whole
point is that a re-run of the same code making the same call matches the once-grant
minted for the prompt the user answered.

## 4. Grants: the single store

### 4.1 Schema

New SQLite database (node:sqlite, WAL — same mechanism as the identity DB) at
`state/authority/grants.db`, replacing the JSON `capabilityGrantsFile`. SQLite is
required by the once-consumption CAS (§4.3); the JSON file cannot express it.

```sql
CREATE TABLE authority_grants (
  id             TEXT PRIMARY KEY,          -- ulid
  effect         TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  capability     TEXT NOT NULL,             -- exact or pattern per capabilityPatternCovers
  resource_key   TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'exact',  -- 'exact' | 'prefix' | 'origin' | 'domain'
  subject        TEXT NOT NULL,             -- principal string: user:/host:/code:path@ev/session:<id>/mission:<missionId>@<closureDigest>
  session_id     TEXT,                      -- constraint: live only while this (durable) session exists
  invocation_digest TEXT,                   -- constraint: once-grant / critical-confirmation binding (§4.3, §6.5)
  mission_subject TEXT,                     -- constraint: full mission:<missionId>@<closureDigest> (used on session-subject preauth rows)
  envelope_id    TEXT,                      -- preauthorization envelope this grant was minted under (§4.5), NULL otherwise
  lineage_at_consent TEXT NOT NULL DEFAULT '[]',  -- JSON array of external lineage ids shown at consent — populated for EVERY allow row (standing rows record '[]': they never pre-consent to taint)
  issued_by      TEXT NOT NULL,             -- user:<id> | rule:<sa1-rule-id> | seed:<policy-entry>
  provenance     TEXT NOT NULL,             -- 'acquisition' | 'preauthorization' | 'install' | 'seed' | 'migrated'
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  consumed_at    INTEGER                    -- once-grants only; NULL = unconsumed
);
CREATE INDEX ag_subject ON authority_grants (subject, capability);
CREATE INDEX ag_session ON authority_grants (session_id) WHERE session_id IS NOT NULL;
```

One store, one transactional boundary. Read API: `grantsForSubjects(subjects: string[],
capability: string): AuthorityGrant[]` — the resolver maps rows to the wire
`AuthorityGrant` shape (subjects/constraints as defined in `authority.ts`; `binding` is
gone per D5).

### 4.2 Decision → row mapping (prompt spec §5.1 actions)

| Decision                      | effect           | subject                               | constraints                                                                                       |
| ----------------------------- | ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Just once                     | allow            | `session:<id>`                        | `invocation_digest` = snapshot digest; `lineage_at_consent` = shown external ids                  |
| Allow for this task           | allow            | `session:<id>`                        | `session_id`; `lineage_at_consent` = shown external ids; resource_scope per scope-cutting default |
| Approve task permissions      | allow (per rule) | `session:<id>`                        | `envelope_id` (§4.5); `lineage_at_consent` = shown external ids                                   |
| Always allow (installed unit) | allow            | `code:<path>@<ev>`                    | `lineage_at_consent` = `'[]'`                                                                     |
| Always allow (automation)     | allow            | `mission:<missionId>@<closureDigest>` | `lineage_at_consent` = `'[]'`                                                                     |
| Confirm (critical)            | allow            | `session:<id>`                        | `invocation_digest`; provenance `critical-confirmation` (§6.5)                                    |
| Don't allow                   | deny             | `session:<id>`                        | `session_id` (session-rule deny)                                                                  |
| Don't allow, ever (overflow)  | deny             | `code:`/`mission:` subject            | durable deny                                                                                      |
| Not now / dismiss             | _no row_         | —                                     | pending entry parked; cooldown (§6.3)                                                             |

Every allow row carries `lineage_at_consent`; the use-time gate (§8.4) adjudicates it
uniformly for **every subject kind** — once-grants included. A once-approval given
with taint visible is consumable under exactly that taint; if further outside content
arrives before consumption, the gate fails and the call re-enters acquisition.

Session-subject rows are pruned when the **session ends** — the durable
agentic-session (conversation) is closed — never on host restart or connection drop
(the session id survives both; a re-run in the same conversation reads the same rows).

### 4.3 Once-consumption CAS

Consume-before-effect (redesign D6), implemented as a single UPDATE:

```sql
UPDATE authority_grants SET consumed_at = :now
WHERE id = :id AND consumed_at IS NULL AND revoked_at IS NULL;
```

`changes === 1` → proceed to the handler; `0` → someone else consumed it → the call
re-enters acquisition (fresh EACQUIRE). Ordering guarantee: the dispatcher consumes
_after_ `evaluateAuthority` selects the once-grant as the satisfying grant and _before_
invoking the handler. If the handler then fails, the grant stays consumed and the retry
re-prompts — deliberate (fails toward the human; open question 4 in the redesign doc
records the idempotency-key alternative). Concurrent identical calls race on the CAS;
exactly one wins by construction.

### 4.4 Pre-release cutover

**`docs/authority-migration-plan.md` is authoritative for cutover semantics; this
section defers to it.** The SQLite authority store is the first supported format.
Development-only predecessor state is neither accepted nor translated; P3 begins with
an empty authority store. `CredentialUseGrantStore` remains in the separate credential
system and is unaffected.

### 4.5 Preauthorization envelopes

The envelope is a **first-class runtime object**, not a provenance string — it is what
SA1's ceiling test evaluates against, and what binds task authority to a task.

```sql
CREATE TABLE preauth_envelopes (
  envelope_id     TEXT PRIMARY KEY,         -- ulid
  session_id      TEXT NOT NULL,            -- durable agentic-session (conversation) id
  task_ref        TEXT NOT NULL,            -- the run/task this envelope charters (agent task id)
  mission_subject TEXT,                     -- mission:<missionId>@<closureDigest> when the task runs under a mission
  state           TEXT NOT NULL CHECK (state IN ('active','closed')),
  created_by      TEXT NOT NULL,            -- user:<id> — envelopes are user-approved only, never rule-created
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
);
CREATE TABLE envelope_rules (
  envelope_id     TEXT NOT NULL REFERENCES preauth_envelopes(envelope_id),
  capability      TEXT NOT NULL,
  resource_key    TEXT NOT NULL,
  resource_scope  TEXT NOT NULL DEFAULT 'exact',
  worst_case_severity TEXT NOT NULL,        -- SA1 verdict recorded at approval; critical-worst-case rules never enter
  PRIMARY KEY (envelope_id, capability, resource_key)
);
```

Semantics:

- The `task.permissions` card approval creates one envelope plus its approved rule
  rows; the per-rule grants minted under it carry `envelope_id` (§4.2). Rejected rows
  simply don't become rules — partial approval is just the surviving row set.
- **SA1's ceiling test is a membership query**: a delegated decision for
  (capability, resource) is within ceiling iff an _active_ envelope of the requesting
  session/task has a rule covering it (`scopeCovers` on the rule's resource scope). No
  active envelope → no ceiling → the delegated decision must escalate to a human.
- **Lifecycle-bound, no clock**: an envelope closes when its task ends (`task_ref`
  lifecycle), when its session ends, or when the user closes it from the permissions
  surface. There is no expiry timestamp.
- The invocation↔envelope association is authenticated: `session_id` and `task_ref`
  are host-stamped facts of the invocation, never caller-supplied — a call is "under"
  an envelope only if the host says its session/task matches.
- Revoking an envelope (user action) closes it and revokes its `envelope_id` grants in
  one transaction.

## 5. Eval suspend/resume

### 5.1 What the execution model allows (investigated)

Facts from `evalService.ts`/`evalDO.ts`: eval code runs in a per-owner EvalDO workerd
isolate; its service calls come back over `gatewayFetch`; runs execute under a held
dispatch with (a) an in-isolate AbortSignal deadline, (b) a Node-side watchdog at
`timeoutMs + grace` that _recycles the sandbox process_ when CPU-stuck, and (c) boot
reconciliation that marks in-flight runs terminally interrupted after a host restart.
There is no isolate checkpointing. Conclusions:

- **In-process suspension is feasible**: parking the gateway call's promise keeps the
  isolate alive awaiting I/O — cheap and natural.
- **Suspension across host restart is not feasible** without checkpoint/replay
  machinery we are not building: the run dies, reconciliation marks it interrupted.
- **The watchdog must know about parked calls**, or a legitimate suspension larger
  than `timeoutMs` gets the sandbox recycled as "unresponsive".

### 5.2 Decision: an ordinary await, resolved by the card's lifecycle

There is no suspension mechanism and no timer. A gated call from an eval is a normal
async host call; when it yields an acquisition, the host simply **does not return yet**
— the isolate sees a slow await, exactly like any other approval-gated handler today.
What resolves the await is the **approval card's lifecycle**, not a clock:

1. **User (or SA1 rule) decides** → grant minted → the parked call **re-enters
   `enforceRequirement`** (full re-evaluation — never "trust the prompt") → response
   flows into the isolate.
2. **User taps Not-now / dismisses** (or the pending entry ends by lifecycle — §6.3)
   → the call fails into the isolate as `AcquirableError` immediately — the agent gets
   control back and can do other work or report it's waiting. The pending entry parks
   in the approvals chip per the prompt spec.
3. **Host restarts** → the run is interrupted per existing boot reconciliation
   (unchanged behavior — an in-flight eval never survives a restart, parked or not).
   **The card and any eventual grant are durable**, and this replay story is now
   internally consistent with the identity rules: `sessionId` is the durable
   conversation id (it survives the restart) and is not part of the digest anyway
   (§3.1), so the re-run — same conversation, same ask — hits the same snapshot
   digest, reads the same still-live session-subject grants, and proceeds without a
   new prompt (§6.3 dedupe covers the still-undecided window).

The only accommodation the eval runtime needs: while a call is parked on a pending
card, the run is flagged `awaiting-approval` and that wall time is **excluded from the
runaway-code clocks** — the Node watchdog's recycle deadline and the in-isolate
AbortSignal deadline (an `extendDeadline` message on the existing run-control path).
Those clocks exist to catch stuck code; a call legitimately waiting on a human is not
stuck, and the UI shows the run as waiting, not running. That exclusion is the entire
delta from "just an async call".

### 5.3 DX consequences (stated honestly)

- User present (any response time — seconds or an hour): seamless mid-eval pause.
- User dismisses, or the host restarts before they decide: the eval fails/reruns from
  the top, so **side effects before the gated call repeat**. Agent guidance (SDK docs
  - system prompts): put gated calls early, make preceding work idempotent, or split
    phases across evals. `preflight` (§7) exists precisely so agents can front-load the
    question.
- For long-absent users, agents should prefer `task.permissions` preauthorization
  (prompt spec §5.5) over mid-run acquisition; SA1 delegated rules cover the rest.

## 6. Acquisition lifecycle

### 6.1 AcquisitionRequest

Minted by the server-side acquisition coordinator (new module,
`src/server/services/acquisitionCoordinator.ts`), which owns the pending registry and
is the only writer of acquisition-provenance grants:

```ts
interface AcquisitionRequest {
  acquisitionId: string; // ulid
  snapshot: InvocationSnapshot; // §3 (full object)
  ruleKey: string; // canonicalKey([capability, resourceScopeRendered]) — prompt row identity
  groupKey: string; // presentation association only; never consent identity (prompt spec §6.1)
  state: "pending" | "decided" | "closed"; // closed = requesting context ended (§6.3) — never a clock
  decision?: GrantedDecision; // once | session | version | deny (approvalQueue vocabulary)
  parkedWaiters: number; // live parked calls attached
}
```

### 6.2 approvalQueue integration

The coordinator submits a `CapabilityApprovalQueueRequest` (existing kind) extended
with `snapshot` and `cardType`; `operation.groupKey` carries §6.1's association for
queue navigation, while deduplication requires exact consent facts. The SA1 delegation
resolver hook evaluates rules against the **snapshot** (severity verdict per redesign
D6 step 2, code-lineage floor included); a rule decision settles the entry with
`issued_by = rule:<id>`. `settle()` remains the single resolution point (WP5
provenance: the ledger row now records `snapshotDigest` and `lineage_at_consent`).

### 6.3 Dedupe, cooldown, replay

The pending registry is keyed by `(snapshotDigest, authenticated runtime id,
callerPrincipal)` with a secondary index on `ruleKey`. The snapshot digest deliberately
omits lifecycle/session coordinates, so using it as a process-global key by itself would
merge identical asks from unrelated runtimes or newly sealed code identities:

- A call whose snapshot digest matches a **pending** entry attaches as a waiter (or
  returns `EACQUIRE {pending: true}` if it can't park) — never a second card.
- A call whose `ruleKey` is in Not-now cooldown returns `EACQUIRE {cooldownUntil}`
  without minting a card (prompt spec §6.2–6.3 escalation applies).
- A call arriving **after** the decision replays it: allow → normal evaluation against
  the minted grant; deny → `EACCES`. Pending entries have **no clock expiry** — they
  resolve only by lifecycle: decided, explicitly dismissed, or their requesting context
  ends (session-origin requests die with the session, whose grants would be useless
  anyway; mission-context requests die when the mission is retired or re-approved —
  a closure change already invalidates the snapshot via its digest). A card the user
  never answers simply waits in the approvals chip until one of those happens.
- The registry is in-memory; after restart it rebuilds lazily from retries (grants are
  durable, so decided-then-restarted is covered; pending-then-restarted re-mints one
  identical card on first retry — acceptable, and the digest match keeps it to one).

### 6.4 awaitDecision

`authority.awaitDecision({ acquisitionId })` — a held service method an authenticated
runtime may invoke _for acquisitions originated by that exact runtime only_; resolves
`{ state, decision? }` on settle, dismissal, or the acquisition's lifecycle end
(requesting context gone). **No timeout parameter**: a clock must not decide the
outcome of a wait on a human (see the timeouts-in-agentic-settings principle); a
caller that wants to stop waiting cancels its own call — that is caller lifecycle,
not protocol. Runtime ownership only protects the rendezvous; retry still performs
full evaluation against the current sealed authorizing principal, so observing a
decision never confers authority. This is the agent SDK's building block and the eval kernel's
`vibestudio.acquire()` implementation.

### 6.5 Critical-tier confirmations

Critical calls run **the same coordinator path** as gated calls — same snapshot, same
pending registry, same park/fail mechanics — with these deltas:

- The error carries `tier: "critical"`, `cardType: "confirm.critical"` (prompt spec
  §5.9). Critical acquisitions are **never coalesced** into burst cards and **never
  resolvable by SA1 rules** — the queue routes them to a human unconditionally.
- The decision mints not a grant but a **single-use fresh-confirmation consumable**:
  an `authority_grants` row with provenance `critical-confirmation`, subject
  `session:<id>`, `invocation_digest` = the snapshot digest, consumed via the same
  §4.3 CAS (consume-before-effect, exactly-one-winner). It can never be standing, has
  no session-rule or always variant, and a changed ask (new digest) always re-prompts.
- Deny at a critical card mints nothing durable by default (the prompt spec offers no
  "don't allow ever" on §5.9); the pending entry settles denied and the call gets
  `EACCES`.
- §8.6's "live fresh-approval fact" **is** this consumable row — one mechanism, not
  two.

## 7. Preflight

`authority.preflight({ service, method, args })` → runs the **entire**
`assertAuthority` path in dry-run mode: descriptor resolution, resource derivation,
prepared resolvers, every leaf through `evaluateAuthority` — with a `preflight` flag
that (a) never mints acquisitions or cards, (b) never consumes once-grants (the CAS is
skipped; the response reports the grant as `consumable`), (c) never applies read-only
containment failures as errors (reported as a leaf status instead).

```ts
interface PreflightResult {
  decision: "allowed" | "acquirable" | "denied";
  leaves: Array<{
    capability: string;
    resourceKey: string;
    status: "granted" | "consumable-once" | "acquirable" | "denied";
    tier: "open" | "gated" | "critical";
  }>;
  severityPreview?: "routine" | "sensitive" | "critical"; // SA1 verdict over the hypothetical snapshot
  wouldPrompt?: { cardType: string; renderedAction: string };
}
```

Contract requirement this imposes: **authority preparers must be pure** (select, never
mutate). The registration-time validation in `registerService` gains a documentation
note; the P2 audit verifies the existing preparers (they are selectors today).

## 8. Evaluator delta (`authorization.ts`)

1. **Origin kind `session`.** `AuthorizationOrigin.kind` gains `"session"`; the
   resolver (`authorityRuntime.ts`) selects it for eval-originated calls
   (`ctx.evalInvocation` / EvalDO-attributed callers), with principal
   `session:<sessionId>`. Context gains authenticated facts:
   `session.mission?` (full `mission:<missionId>@<closureDigest>` subject),
   `session.mediatingHarness?` (code principal),
   `session.contextLineage` (latch class + external ids; `unknown` until P4a).
2. **Subject matching.** Grant selection for an origin collects the origin's authority
   set: origin principal exactly, plus — for `session` origins —
   `mission:<missionId>@<closureDigest>` when the mission fact is present (exact
   match on both halves: the registry identity AND the closure — byte-identical
   charters under different missions or owners never share authority). This is one
   principal's set (single-origin authority); no other principal's grants are ever
   consulted.
3. **Uniform deny precedence.** The deny scan runs over the _entire_ collected set
   before any allow is considered (today's per-grant `effect` check becomes a
   two-pass: denies first, across both subject facets).
4. **`lineageAtConsent` gate — uniform over every grant kind.** An allow grant (or
   critical confirmation) at gated/critical tier is exercisable only when
   `contextLineage.external ⊆ grant.lineageAtConsent` — session rules and once-grants
   carry the ids shown at consent; standing subjects (`code:`, `mission:`) carry `[]`
   and never pre-consent to taint. The gate runs at consumption/use time for all of
   them, which is what adjudicates taint arriving while a call was parked (§3.1).
   Until P4a ships the latch, `contextLineage` is `unknown` and the gate passes
   vacuously — stated interim semantics, per the redesign phase plan.
5. **Family mapping.** `requirementForPrincipals` maps a declared `code` principal to
   accept origins `{code, session}` unless the declaration carries `codeOnly: true`.
   The session branch of the mapped requirement does **not** include the
   manifest-request intersection (sessions have no manifest; their envelope is their
   request); the code branch keeps it unchanged.
6. **Tier admission.** Before requirement evaluation: `open` short-circuits allowed
   (subject only to principal-kind/relationship requirements); `critical` never
   consults standing/session grants — it requires the single-use fresh-confirmation
   consumable of §6.5 (provenance `critical-confirmation`, this exact snapshot
   digest, unconsumed), consumed via the §4.3 CAS.

## 9. Resolver replacement (`src/server/index.ts`)

The production resolver finally consumes its contract: it receives
`{requirement, sensitivity, tier}` (tier threaded from the method registration),
fetches the origin's authority set from the single store, assembles the context facts
(§8.1), and — new — returns `acquirable` metadata when evaluation will fail on
`missing-grant` at gated tier, which `enforceRequirement` turns into the §2 error via
the acquisition coordinator. The dead resolver-contract fields
(`acquisition`/`challenge`/`preauthorization`, `decision: "run"`) are deleted from
`ServiceDispatcher` in the same change (redesign D13).

## 10. Rollout order within P3

1. Canonical JSON util + snapshot assembly (pure, testable).
2. Grant store + migration (behind the old read API first, then cut the resolver over).
3. Evaluator delta §8 (session origin inert until eval attribution flips on).
4. Acquisition coordinator + EACQUIRE + approvalQueue integration; handler-embedded
   `requestCapabilityPermission` call sites replaced service-by-service, each removal
   switching that method's dispatcher-level gating on (the P2→P3 atomic swap).
5. Eval park/resume + watchdog stop-the-clock + `awaitDecision`.
6. Preflight.
7. Delete: dead dispatcher contract fields, JSON grant file codec, `EVAL_APPROVAL_*`
   codes, `run`-scoped decision plumbing.

## 11. Open questions

1. ~~`ACQ_TTL` card expiry~~ **Resolved: no clock expiry on pending acquisitions** —
   lifecycle-bound only (§6.3). There is likewise deliberately no park-duration budget
   (§5.2). Timeouts in agentic settings are suspect by default; the only clocks in
   this spec are the pre-existing mechanical runaway watchdog and soft UX pacing in
   the prompt spec.
2. ~~Kind-level userland approval migration~~ **Resolved by the owning
   prerequisite** (`docs/userland-gad-capabilities-prerequisite-plan.md` D7):
   no legacy row translates — allows *and* denials are dropped and re-asked,
   because old rows lack the exact receiver, definition, and invocation facts
   a new-model grant requires. Report counts at migration if useful; never
   migrate.
3. Whether `awaitDecision` should stream progress (card shown / delegated-rule
   evaluated) for richer agent UX, or stay a bare settle future.
4. Once-grant + handler-failure: revisit idempotency-keyed re-issue only if telemetry
   shows repeated re-prompts on flaky effects (redesign open question 4).

## 12. Userland-capability deltas (normative)

Introduced by `docs/userland-gad-capabilities-prerequisite-plan.md` (D4/D4a);
recorded here because this spec owns the snapshot, digest, store, and scope
contracts. Implementation lands with that plan's WP2, not with P3 — but the
contract is fixed now so WP2 has one canonical definition to build against.

### 12.1 Snapshot v2

When receiver-enforced userland capabilities land, the snapshot schema bumps to
`v: 2` (digest domain `vibestudio:invocation-snapshot:v2\0`), adding four
fields, all in-digest:

| Field                        | Source                                                                                    | In digest |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------- |
| `capabilityDefinitionDigest` | the sealed provided-capability definition digest; `"-"` for host capabilities             | yes       |
| `resourceType`               | the definition's declared `resourceType`; the capability domain for host capabilities     | yes       |
| `provider`                   | receiver provider identity (`<repo-path>`) for userland receivers; `"-"` otherwise        | yes       |
| `providerExecutionDigest`    | the live receiver build's execution digest; `"-"` for host capabilities                   | yes       |

`providerExecutionDigest` is in-digest because a receiver rebuild genuinely
changes the ask — this is also what makes a pending acquisition go stale when
the provider changes underneath it (prerequisite failure semantics), and it is
the canonical fact `version`-scoped grants pin. `resourceKey` is unchanged and
remains the canonical derived key. Everything else in §3 applies unchanged.
v1 and v2 digests are never compared; parked v1 acquisitions at the cutover
are settled or re-entered, not translated.

### 12.2 Grant rows, identity embedding, and matching

For a userland capability, the stored `capability` column holds the **full
canonical identity** from prerequisite D4a:

```text
userland:<provider-repo-path>/<local-name>#<definition-digest>
```

Provider identity and definition digest are therefore part of the exact match
key itself — a definition change produces a different capability string and
lapses every prior grant by identity, with no extra matching rule. Two
denormalized columns support this; neither introduces a second matching
authority:

- `capability_definition_digest TEXT` (NULL for host capabilities) — an
  **invalidation/inventory index only** ("list/lapse everything at digest X",
  and the permissions surface's "why is it asking again" explanation). It is
  never consulted during admission; admission matches the capability string.
- `provider_execution_digest TEXT` (NULL unless populated) — a **constraint**,
  the receiver-side analogue of `invocation_digest`: populated exactly on
  `version`-scoped rows, and a populated value must equal the snapshot's
  `providerExecutionDigest` for the grant to apply. Subject columns identify
  the caller and play no part in pinning the receiver.

`resourceType` is not a separate grant column: the canonical `resource_key`
produced by the declarative derivation is namespaced by the definition's
resource type (`<resourceType>:<derived-key>`), so resource matching remains
the single existing `resource_key`/`resource_scope` mechanism. Indexing: the
existing `(subject, capability)` index covers admission; add an index on
`capability_definition_digest` for invalidation queries.

The provider's execution digest deliberately does not participate in ordinary
matching (prerequisite D4a — rebuilds must not lapse definition-stable
grants); it binds only `version`-scoped rows via the constraint column above.

### 12.3 Canonical grant scope vocabulary

The scope vocabulary is normatively the landed store constraint
(`src/server/services/authorityGrantSchema.ts`):
`once | task | agent | mission | version | session | system`. §4.2's decision
table is a projection of this vocabulary, not a second one, and the userland
`grantScopes` declaration is a subset filter over this set minus `system`
(host-seeded only). Note `agent` scope is a **constraint**
(`agent_binding_id`) on a session- or mission-subject row, not an entity
subject — entity subjects remain forbidden (redesign D5). Companion-spec scope
lists that diverge from this section are superseded by it.
