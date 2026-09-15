# System Agent SA1 — Delegated Approvals (implementation spec)

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Delegation contracts remain subordinate detail; delegated decisions cannot bypass native or workspace resource boundaries.

Status: draft for review
Depends on: `system-agent-design.md` (§5 — the decided policy object, micro-sessions,
severity gate), `system-agent-sa0-plan.md` (SystemAgentWorker, blessed EV, full shell-context
eval and service authority), `system-agent-tools-cards-spec.md`,
`capability-model-redesign.md` (§5: R1 pinned launch, R3 capability
principals — the classifier vocabulary), `multi-user-wp5-approval-provenance.md` (settle
coordinator, `ApprovalProvenanceRecord`), `approvals.md`, `capability-approval-design.md`,
`credential-system.md`.

SA1 delivers: the delegation policy store + audit trail, the "Delegate similar to
agent…" action on approval cards, the confirmation flow, the host-side severity
classifier, micro-session evaluation wired into the approval queue, WP5 provenance
stamping for agent decisions, the one-tap renewal affordance for lapsed policies, and
the Delegations surface. All decisions in the parent
design (§5.1–§5.6) are final; this document makes them buildable.

> **Changelog (2026-07-21):** reconciled with `capability-model-redesign.md` — the
> severity classifier gains the subject-code-lineage input (§3), and four cross-model
> constraints are now normative (§3a): lineage floors, the preauthorization-envelope
> ceiling, no delegated vouching, and user-only preauthorization batches. Note the
> redesign's method *tiers* (`open | gated | critical`) are a distinct concept from
> this spec's per-approval severity *verdict* (`routine | sensitive | critical`);
> tiers decide whether an approval is needed, this classifier decides who may resolve
> it.
> **Second pass (same day):** authority graph aligned with the harness-as-conduit
> inversion and the mission subsystem — micro-sessions run under the seeded
> system-agent **mission's** authority (`mission:system-agent@<closureDigest>`, §5);
> the SystemAgentWorker **code principal holds no `system.*` grants**, including
> `system.approvals.decide` (§9). Earlier SA0 phrasing "grants bound to
> `code:…@blessedEv`" is superseded per mission-subsystem spec §7.
> **Excision note (2026-07-29):** an earlier draft carried a fourth delegable
> kind, `userland`, delegating the advisory `userlandApproval` custom-choice
> prompts (matcher fields `allowedChoice`/`optionsFingerprint`; settlement via
> `resolveUserland`/`userland_choice`). That entire surface is deleted by
> `docs/userland-gad-capabilities-prerequisite-plan.md` D7 in one destructive
> cut: receiver-enforced userland capabilities arrive as ordinary
> `capability`-kind acquisitions (delegable here with no new machinery), and
> non-authorizing provider choices move to trusted forms outside the approval
> queue entirely. The kind has therefore been **removed from this spec's
> normative body** — there are three delegable kinds, and nothing here requires
> `requestUserland`, `resolveUserland`, `userland_choice`, or option
> fingerprints. This note is the historical record.

## 1. Policy store

Host-owned store, same substrate family as the WP5 governance log: a `node:sqlite`
database at `governance/delegations.db` (WAL, `synchronous=FULL`), opened and written
only by the hub host. Userland can read a projection through the typed delegation service
`delegations.list`, routed to `delegation.list`;
it can never write.

```sql
CREATE TABLE delegation_policies (
  policy_id               TEXT PRIMARY KEY,            -- "dlg_" + uuid
  user_id                 TEXT NOT NULL,               -- owning user (WP0 subject); policies scope per-(workspace, user)
  created_from_device_id  TEXT NOT NULL,               -- attribution only: device where the delegate action ran (§8) — never a match/partition key
  version                 INTEGER NOT NULL DEFAULT 1,  -- edit-as-new-version counter
  supersedes_policy_id    TEXT,                        -- previous version, if any
  renewed_from_policy_id  TEXT,                        -- lineage: the lapsed policy this one renews (§7a)
  created_from_approval_id TEXT NOT NULL,              -- the approval the delegate action started from
  description             TEXT NOT NULL,               -- plain-language, shown on cards
  matcher_json            TEXT NOT NULL,               -- §2 matcher object, validated at write
  evaluation              TEXT NOT NULL CHECK (evaluation IN ('agent','auto')),
  guidance                TEXT NOT NULL DEFAULT '',    -- only meaningful for evaluation='agent'
  max_uses                INTEGER NOT NULL DEFAULT 100,
  expires_at              INTEGER,                     -- ms epoch; default createdAt + 30d.
                                                       -- NULL = "until revoked" — allowed ONLY while
                                                       -- max_severity = 'routine' (write-time check);
                                                       -- 'sensitive' policies always carry an expiry
  max_severity            TEXT NOT NULL DEFAULT 'routine'
                          CHECK (max_severity IN ('routine','sensitive')),
  requires_grantor_presence INTEGER NOT NULL DEFAULT 0,
  state                   TEXT NOT NULL DEFAULT 'draft'
                          CHECK (state IN ('draft','active','exhausted','expired','revoked')),
  revoked_reason          TEXT,                        -- 'user' | 'superseded'
  created_at              INTEGER NOT NULL,
  confirmed_at            INTEGER,                     -- host-recorded UI confirmation (§7)
  -- stats (denormalized; audit table is authoritative)
  uses                    INTEGER NOT NULL DEFAULT 0,
  escalations             INTEGER NOT NULL DEFAULT 0,
  last_used_at            INTEGER
);
CREATE INDEX idx_policies_owner ON delegation_policies (user_id, state);

CREATE TABLE delegation_audit (
  audit_id        TEXT PRIMARY KEY,
  policy_id       TEXT NOT NULL REFERENCES delegation_policies (policy_id),
  kind            TEXT NOT NULL CHECK (kind IN
                    ('evaluation','lifecycle')),
  -- evaluation rows (one per policy-matched request, including escalations):
  approval_id     TEXT,                                -- queue approvalId
  approval_kind   TEXT,                                -- 'unit-install-review'|'capability'|'credential'
  matched_facts_json TEXT,                             -- the host-verified fields the matcher bound (§2)
  severity_verdict TEXT,                               -- 'routine'|'sensitive'|'critical' (§3)
  decision        TEXT CHECK (decision IN
                    ('auto_approve','approve_once','deny','escalate',
                     'decision-superseded')),          -- 'decision-superseded': compensating
                                                       -- row when a settle fails/loses the
                                                       -- WP5 race after budget was reserved (§4)
  rationale       TEXT,                                -- micro-session one-liner ('' for auto)
  latency_ms      INTEGER,
  budget_remaining INTEGER,
  -- lifecycle rows:
  lifecycle_event TEXT CHECK (lifecycle_event IN
                    ('created','confirmed','draft-expired','revoked','expired',
                     'exhausted','superseded','renewed')),
                                                       -- 'renewed': written on the OLD (lapsed)
                                                       -- policy when a renewal creates a
                                                       -- successor; the new policy row carries
                                                       -- renewed_from_policy_id back (§7a)
  actor_user_id   TEXT,                                -- who performed the lifecycle action
  at              INTEGER NOT NULL
);
CREATE INDEX idx_audit_policy ON delegation_audit (policy_id, at);
CREATE INDEX idx_audit_approval ON delegation_audit (approval_id);
```

Lifecycle state machine (all transitions write a `lifecycle` audit row):

```
draft ──confirm (audited verified-human chrome action)──▶ active
draft ──24 h unconfirmed──▶ expired (row retained; audit row 'draft-expired')
active ──uses == max_uses──▶ exhausted
active ──now > expires_at (when an expiry is set; "until revoked" policies skip this edge)──▶ expired
active ──user revoke──▶ revoked
active ──edit──▶ NEW policy row (version = old.version + 1,
                 supersedes_policy_id = old.policy_id, state 'draft'); old remains active
new draft ──confirm──▶ new active + old revoked atomically (reason 'superseded')
exhausted / expired ──one-tap renew (§7a)──▶ 'renewed' audit row on the old policy
                 + NEW policy row born ACTIVE (version = old.version + 1,
                  renewed_from_policy_id = old.policy_id, fresh TTL (or none, if the
                  old policy was until-revoked) and budget,
                  same matcher/guidance/evaluation — the tap IS the confirmation)
active, dead-in-practice (issuer-changed near-miss, §4 step 2)
                 ──one-tap renew (§7a)──▶ old row revoked (reason 'superseded') +
                  'renewed' audit row + NEW policy row born ACTIVE with the
                  issuer EV re-pinned to current
```

Terminal states are terminal: exhausted/expired/revoked policies are never
reactivated; renewal is always a **new** policy row — either a new version through the
confirmation flow, or the one-tap same-terms renewal (§7a), which skips the draft
stage because its terms were already human-confirmed once and the renewing tap is
itself a host-recorded confirmation. A policy must **never lapse silently**: the three
ways a policy stops deciding — budget exhaustion, TTL expiry (when an expiry is set),
and issuer EV drift (the pinned `issuer.effectiveVersion` no longer matches the
worker, the most common death in a workspace where workers are edited daily) — are
all surfaced to the human at the moment they next matter (§7a), not buried in the
Delegations surface.

Audit rows are never deleted; **every** policy row — including drafts that expired unconfirmed — is
retained forever so audit foreign keys stay resolvable (drafts already carry a
`created` lifecycle audit row, so `delegation_audit.policy_id NOT NULL REFERENCES
delegation_policies` forbids deleting them). Expired drafts are inert, not just
retired: the matcher and `idx_policies_owner` filter on `state`, so a policy that is
anything but `active` never matches a request. (The lapsed-near-match detection pass
in §4 step 2 deliberately reads `exhausted`/`expired` rows — and `active` rows that
failed only on issuer EV — but it can only annotate the human
card; it never decides anything.)

## 2. Matcher grammar

The matcher binds only to **host-verified** facts — values the host stamped or
resolved itself (`ServiceContext` caller identity, `CodeIdentityResolver`, host-owned
credential records). Caller-supplied display copy — `title`, `summary`, `warning`,
`description`, `details`, option labels, `credentialLabel`, `bindingLabel`,
`displayName` — is attacker-controlled and is **never matchable**; the matcher schema
has no field for it and validation rejects unknown keys.

Common shape:

```jsonc
{
  "kind": "unit-install-review" | "capability" | "credential",  // required, exact
  "issuer": { ... },            // required; kind-specific, see below
  "subjectPattern": "…",        // required; glob over the kind's subject key
  "channelId": "…" | null       // optional session/channel scope (external-agent-adjacent
                                 // requests carry one; null = any)
}
```

Every delegable decision is a fixed approve/deny — there is no delegable kind
whose verdict selects among provider-supplied options (see the excision note:
the former `userland` kind is deleted with the advisory approval surface, and
receiver-enforced userland capabilities arrive as ordinary `capability`-kind
requests). Non-matches must never be silent where they would be invisible:
policies pin `issuer.effectiveVersion`, workers are edited daily in this
environment, and a plain non-match would be undetectable — so an EV-only miss
is detected and surfaced with a one-tap re-pin (§4 step 2, §7a).

Matchable fields per kind (everything listed is host-stamped on the queue request):

| Kind | Issuer fields (all exact-match) | `subjectPattern` matches | Other exact fields |
| --- | --- | --- | --- |
| `unit-install-review` | `callerKind`, `repoPath`, `effectiveVersion` | each part's `"{kind}:{name}"` — the pattern must match **every** part in the review (a review is one decision) | `mode` (`adopt-root`\|`install`\|`update`\|`remove`\|`part-changed`), each part's `repoPath` (optional glob list) |
| `capability` | `callerKind`, `repoPath`, `effectiveVersion` | the grant resource key: `"{capability}:{grantResourceKey ?? resource.value ?? ''}"` — the same key `CapabilityGrantStore` grants bind to, so the matcher and the grant store speak one keyspace | `capability` (exact name from the classifier vocabulary, §3) |
| `credential` | `callerKind`, `repoPath`, `effectiveVersion` | `grantResource.resource` when present (e.g. GitHub `url-path-prefix` `/repos/{owner}/{repo}`), else the request's matched audience URL — both host-computed | `credentialId` (exact), `credentialUse` (`fetch`\|`git-http`\|`git-ssh`), `grantResource.action` (`read`\|`write`\|`use`), `scopes` (subset check against the host-stored credential record) |

Never delegable, therefore no matcher exists for them: `credential-input`,
`secret-input` (human-supplied values by construction), `device-code`,
`client-config` (trust-root surfaces), and `external-agent` (a relayed
external-runtime prompt with per-request one-shot semantics — no grant, no policy).

`subjectPattern` glob semantics (one grammar for every kind; the separator set is
`/` and `:` because both appear in subject ids and resource keys):

- `*` — zero or more characters **excluding** separators (`/`, `:`).
- `**` — zero or more characters **including** separators. `**` may appear anywhere.
- `?` — exactly one non-separator character.
- `[abc]`, `[a-z0-9]` — character class, one character; `[!…]` negates. Separators
  inside a class are rejected at validation.
- `\` — escapes the next character (`\*` matches a literal `*`; `\\` a backslash).
- Matching is case-sensitive, anchored (the pattern must match the **whole** subject
  string), and performed on the raw string — no normalization beyond what the host
  already validated at enqueue.
- The empty pattern is invalid. A bare `**` is legal but the confirmation card renders
  an explicit breadth warning.

Patterns are validated at policy write time (draft creation and confirmation both
re-validate); an invalid pattern is a hard error, never a silent non-match.

Breadth cuts both ways: alongside the widening warning above, validation flags
patterns that are **unlikely to ever match again** — e.g. an exact subject containing
a date stamp or one-shot id (`reports/2026-07-13-summary.md`) — so the confirmation
card can warn that the policy as drafted matches one request ever. Neither warning
blocks confirmation; both must be visible on the card (§7 step 3).

## 3. Severity classifier

Host-side pure function `classifySeverity(request) → routine | sensitive | critical`,
computed from **verified facts only**: request kind, verified issuer identity, the
capability name, the host-stored credential record and grant state, the grant
stores (`CapabilityGrantStore`, `CredentialUseGrant`s), and — once the redesign's
invocation snapshots exist (P3/P4b) — the **subject code's lineage class** from the
snapshot (`internal | external | unknown`). It never reads `title`,
`description`, `warning`, or any other display string. The verdict is stamped into the
micro-session context and the audit row.

The classifier's vocabulary **is the R3 capability namespace**: the strings below are
the capability names as they exist in code today; when R3's grant-set transcription
renames them, the severity table rows rename in the same change (the severity map is
reviewed as part of R3's in-scope grant-set review). The `critical` list ships in the
product bundle (`packages/shared/src/approvals/severityCriticalList.ts`), is host-owned,
and is not workspace-configurable.

Concrete first pass — every capability name and credential shape found in code:

| Verified fact | Severity | Rule |
| --- | --- | --- |
| `unit-install-review`, `mode: part-changed` | routine | routine reconcile of already-known parts |
| `unit-install-review`, `mode: adopt-root`, `install`, or `update` | sensitive | admits new parts / writes workspace config |
| `external-browser-open`, `open-url` | routine | opens a URL in the user's browser |
| `cors-response-read` | routine | read-only response access |
| `external-network-fetch`, `egress.fetch` — re-grant of an origin this exact `(repoPath, ev)` already holds | routine | re-grant of held authority |
| `external-network-fetch`, `egress.fetch` — first grant of a new origin/domain | sensitive | new egress authority |
| `external-network-fetch`, `egress.fetch` with `resourceScope: { kind: "network", value: "*" }` | critical | network-wide access (design §5.4 critical list) |
| `context.boundary` | sensitive | cross-context data movement |
| `workspace-main-advance` (publish / restore) | sensitive | advances shared workspace main; carries `diffReview` when content changes |
| `workspace-project-import` | sensitive | admits external code |
| `workspace-shared-git-remote` | sensitive | shared remote configuration |
| `workerd.inspector` | critical | runtime inspection of arbitrary code |
| `client-config-delete` | critical | service-setup / trust-root surface |
| `credential-revoke` | critical | credential lifecycle mutation |
| `external-agent.tool` | critical | not delegable regardless (kind excluded, §2) |
| `credential` use where a matching `CredentialUseGrant` (bindingId, resource, action) already exists for this `(repoPath, ev)` | routine | use within already-granted scope |
| `credential` use adding a new `grantResource.resource` or new binding, `action: read`/`use` | sensitive | scope addition |
| `credential` use with `grantResource.action: "write"` or `gitOperation.action: "write"` | sensitive | write authority |
| `credential` with `gitOperation.force: true`, or `oauthAudienceDomainMismatch: true`, or `replacementCredentialLabel` set | critical | destructive / trust-anomaly signals |
| `credential` whose stored material class is secret-bearing beyond a token (`sshPrivateKey`, `cookieSession`/`cookieHeader`, `samlAssertion`, `awsSecretAccessKey`) being granted a **new** scope | critical | secret-bearing credential scopes (design §5.4) |

**Fail-closed default rule:** any capability name, credential shape, or request field
combination not matched by a row above classifies as `critical` — never delegable,
always falls through to human surfaces. The enumeration above is expected to be
incomplete as the codebase grows; unknown-→-critical is the invariant that makes that
safe. Test names `example-capability` / `demo.cap` are unknown at runtime and therefore
critical.

Note: `PendingCapabilityApproval.severity` (`"standard" | "severe"`) is a
**presentation hint** supplied by callers (capability-approval-design §8.2) and is
ignored by this classifier entirely.

## 3a. Cross-model constraints (capability-model-redesign reconciliation)

These are normative on top of the table above:

1. **Lineage floor.** When the invocation snapshot reports the subject code's lineage
   as `external`, the verdict floors at `sensitive` (a routine row match escalates to
   sensitive; sensitive and critical rows are unchanged). Lineage `unknown` (pre-P4b,
   or a snapshot without the fact) is treated as `external` for flooring purposes —
   conservative until the data exists. Policy matchers may additionally match on
   lineage (e.g. refuse delegation, or set `requiresGrantorPresence`, for
   external-lineage code).
2. **Envelope ceiling.** A delegated decision may never allow beyond the task's
   preauthorization envelope when one exists: if the requested capability/resource
   falls outside the envelope's rules, the policy must `escalate` regardless of its
   own matcher — only a live user approval may exceed an envelope.
3. **No delegated vouching.** Trust decisions over content (vouch, and a fortiori
   always-trust policies) are never delegable request kinds. They do not enter the
   delegation gate; they always resolve on human surfaces.
4. **Preauthorization batches are user-only.** Policies evaluate *against* envelopes
   at request time; they never approve the batch that creates one. A `task-permissions`
   approval card is not a delegable kind.

## 4. Queue integration

The policy check is a **delegation gate** inside `approvalQueue`, running for the three
delegable request kinds only, positioned **inside enqueue, before the entry becomes
observable**:

1. `request()` creates the `QueueEntry` exactly as today, but
   **before** the entry is published to any listener — before the first
   `pending-changed` fires — it synchronously calls the injected
   `delegationEvaluator.match(pendingApproval)` (host service, §5). The policy-table
   match is a synchronous lookup (only the micro-session is async), so this adds no
   await point to enqueue. The entry carries a new optional field
   `delegation?: { policyId: string; state: "evaluating" | "escalated" | "lapsed";
   rationale?: string; lapse?: DelegationLapse }` where

   ```ts
   type DelegationLapse = {
     reason: "exhausted" | "expired" | "issuer-changed";
     policyId: string;
     description: string;            // the policy's plain-language description
     usedOfMax?: [number, number];   // exhausted: e.g. [100, 100]
     expiredAt?: number;             // expired: ms epoch, for "expired 2d ago" copy
     changedIssuer?: { pinnedEv: string; currentEv: string };     // issuer-changed
     renewable: boolean;             // §7a eligibility (owner + matcher still valid)
   };
   ```
2. Matching order: active policies whose matcher binds (§2), whose owner presence
   check passes (§8), whose remaining budget > 0, and whose `maxSeverity` ≥ the
   classifier verdict (`critical` never passes). Multiple matching policies of one
   user: newest confirmed wins. On a match, the entry is stamped
   `delegation: { policyId, state: "evaluating" }`. **On no active match, the gate
   runs one more pass over the same owner's non-matching candidates to detect a
   lapsed near-match**: an `exhausted` or `expired` policy whose matcher would
   otherwise bind, or an active policy that failed **only** on
   `issuer.effectiveVersion` — the pinned EV no longer matches the request's
   verified issuer EV because the worker was edited (`issuer-changed`; in this
   environment workers are edited daily, so this is the most common way a policy
   dies, and without this pass it would be a plain non-match with no surfacing).
   The newest such policy stamps the entry
   `delegation: { policyId, state: "lapsed", lapse }` — this stamp never holds the
   push or settles anything; it exists purely so human surfaces can explain the lapse
   and offer renewal (§7a). With no match and no lapsed near-match the entry carries
   no stamp. Only then does `pending-changed` fire — the push bridge reacts to
   `pending-changed` and sends immediately when no shell is active, so the hold
   marker must exist before the entry is ever observable, never after.
3. **Push hold:** `approvalPushBridge.shouldPushApproval()` returns `false` while
   `delegation.state === "evaluating"` — no FCM/APNs fanout during evaluation. Desktop
   surfaces still render the entry (subdued "agent evaluating…" state on the approval
   bar); a human clicking through during evaluation resolves normally, and the WP5
   settlement lock (`entry.settlement`) rejects whichever verdict arrives second.
4. `evaluation: "auto"` policies skip the model: the evaluator resolves immediately
   with `once` (audit `decision: "auto_approve"`). `evaluation: "agent"` policies run
   a micro-session (§5).
5. Settlement is uniform across the three kinds: micro-session `approve_once` → the
   evaluator calls the queue's `resolve(approvalId, "once", agentResolver)` through
   the standard WP5 settle coordinator; `deny` →
   `resolve(approvalId, "deny", agentResolver)`. On `escalate`, **timeout (30 s), or
   any failure** → the entry flips to `delegation: { policyId, state: "escalated",
   rationale }`, `pending-changed` fires, and the push bridge fans out normally with
   the rationale attached to the card. Escalation is a success outcome, not an error.
6. The decision transaction **reserves** budget: budget decrement, `stats` update,
   and the audit row are written together with the decision before the queue settle
   is attempted; `uses == max_uses` transitions the policy to `exhausted` in the same
   transaction. If the settle then fails or loses the WP5 settlement race to a human
   (`entry.settlement` rejects the agent verdict), the evaluator writes a
   compensating `decision-superseded` audit row and releases the reservation
   (re-decrementing `uses`, and reverting `exhausted` back to `active` if the
   reservation was what exhausted it). `agentResolver` settlement is idempotent per
   `(policyId, approvalId)` — a retry after a crash between reserve and settle
   neither double-spends budget nor double-settles the entry.

Policies never grant scope: an agent decision is always `once` (`GrantedDecision`
`"once"`); `session`/`version` grants remain exclusively human choices. Deduped
requests coalesced onto one entry are settled together by the one decision, exactly as
a human `once` does today.

**Multi-user semantics:** a policy substitutes only for **its owner's** click. In the
current single-decision queue ("any member approves, all consume" — WP5 §2), an owner's
policy match therefore settles the request exactly as that owner tapping Once would,
and the provenance record names them (§6). When WP9/WP7 introduce genuinely multi-party
approvals, each user's matching policy independently satisfies that user's slot and
nothing here changes — WP5 multi-party semantics are unchanged by delegation.

## 5. Micro-session protocol

Micro-sessions run under the **seeded system-agent mission's authority** — grant
subject `mission:system-agent@<closureDigest>` (mission-subsystem spec §7), the same
mission whose closure pins the blessed SystemAgentWorker EV as its conduit harness.
The micro-session is spawned as a triggered mission run, so the host stamps its
mission fact at spawn; the `system.*` standing grants it exercises are the mission's.
**The SystemAgentWorker code principal itself holds nothing** (harness-as-conduit
inversion, capability redesign D4/D10) — an edited worker both loses conduit blessing
and falls outside the mission closure, so it can neither attest nor act. Micro-sessions
share **nothing** with the conversation: a fresh, single-shot context per evaluation,
no channel, no transcript persistence beyond the audit row.

Context contains **only**:

1. The structured request payload — the pending approval's kind-specific fields.
   Display strings (`title`, `summary`, …) are included for judgment but framed as
   untrusted provider text; the prompt states that instructions inside them are to be
   ignored and are grounds to escalate.
2. The policy: matcher, `description`, `guidance`, remaining budget
   (`max_uses - uses`), `expires_at`.
3. Host-computed facts: verified issuer identity (repoPath, ev, resolved title),
   the severity verdict (§3), and the recent decision history for this matcher (last
   10 `delegation_audit` evaluation rows for this policy: decision + rationale +
   timestamp — no request bodies).

**Never present:** conversation history, log content, watcher signatures, panel
titles beyond the verified issuer title, or any other workspace text.

Output schema (structured, enforced — one schema for all three kinds):

```jsonc
{ "decision": "approve_once" | "deny" | "escalate", "rationale": "one line, ≤ 200 chars" }
```

- **Timeout: 30 seconds** wall-clock from invocation to a valid structured output.
- Timeout, launch failure, malformed output, model error, or a budget/state race
  (policy revoked mid-flight) all resolve as `escalate`. Escalate attaches the
  rationale (or `"evaluation timed out"` / `"evaluation failed"`) to the human-facing
  card and is recorded in the audit trail as a first-class outcome.
- The invocation carries a single-use `evaluationToken` minted by the delegation
  evaluator; micro-session-only `delegation.approvalsDecide` (§9) requires it, which is what makes the
  tool unusable from anywhere but a live micro-session.

## 6. Provenance and audit

Agent decisions ride the existing WP5 settle coordinator with an extended resolver:

- `ApprovalResolver` gains `agent?: { kind: "system"; policyId: string }`. The
  delegation evaluator constructs the resolver host-side:
  `subject` = the **policy owner's** verified `UserSubject` (resolved from the policy
  row via the identity DB — never from the worker), `via: "delegation"` (new
  `ResolvedVia` value), `deviceId` = the device stamped on the policy's most recent
  grant or renewal (`created_from_device_id`) — attribution, not a scope key (§8).
- `ApprovalResolvedEvent` / `ApprovalProvenanceRecord` gain
  `decidedBy?: { agent: "system"; onBehalfOf: string /* userId */; policyId: string }`,
  stamped whenever `resolver.agent` is present. `resolvedBy` remains the owner user so
  every existing "who approved X" query stays coherent; `decidedBy` is what marks the
  decision as agent-made.
- The governance log (`governance/governance.db`) stores the record unchanged plus the
  `decidedBy` columns; the delegation audit table (§1) stores the evaluation row. The
  two are linked by `approval_id`.

Every auto-decision **and** every escalation writes a `delegation_audit` evaluation
row — escalations that a human later resolves produce both the escalation row here and
the ordinary human provenance record in the governance log.

Surface treatment: any resolution event carrying `decidedBy` renders visibly distinct
from a human decision on every surface — the approval bar/sheet "resolved" flash and
the governance timeline show a robot glyph and the copy
"Approved by System Agent for @handle · policy 〈description〉", tappable through to the
policy's audit trail. Escalated-but-pending cards show the rationale line under an
"Agent escalated:" label.

**Foreseeable exhaustion:** every agent-decided flash/card additionally shows the
policy's running budget and remaining TTL — "uses 92/100 · 12d left" (until-revoked
policies render "no expiry" in place of the countdown) — sourced from the
`budget_remaining` written in the same decision transaction (§4 step 6), so the user
watches the budget drain instead of discovering it empty. The decision that consumes
the final use renders the notice on the final decision card itself: "This was the last
use — policy 〈description〉 is now exhausted", with the same one-tap renew chip as §7a.
Equivalent copy applies when a decision lands within 24 h of `expires_at`
("expires in 5h") — moot for until-revoked policies, which have none.

## 7. Delegation flow end-to-end

1. **Card action.** Every approval card for a delegable kind
   (`workspace/apps/shell/components/ApprovalCard.tsx` /
   `approvalCardModel.ts`, and the mobile sheet) gains a **"Delegate similar to
   agent…"** action. The UI exposes it only when `classifySeverity(request)` is not
   `critical` (the shell asks the shared `delegation.severityFor(approvalId)` service, capability
   `system.delegations.read`; the server recomputes on every subsequent step — the
   client bit is presentation only).
2. **Invocation.** The action calls the user's System Agent conversation (SA0
   `resolveConversation`; per-user — the current device is stamped as attribution)
   with the approval's full structured payload as a
   human-gesture-initiated turn (the card tap is the gesture; System Agent turns are
   initiated by human gestures, not only typed messages).
   The agent calls `delegations.propose` from full eval, which drafts:
   a plain-language `description`,
   a matcher (§2) pre-filled from the request's verified facts (issuer exact,
   `subjectPattern` initially the exact subject, `channelId` null), `evaluation:
   "agent"`, `guidance` drafted from the payload, defaults `maxUses: 100`, TTL 30 days,
   `maxSeverity: "routine"`, `requiresGrantorPresence: false`. The host writes the
   `draft` row and returns `policyId`. The exact-subject default is safe but can be
   pointlessly narrow — a date-stamped path matches one request ever — which is why
   the confirmation card leads with a scope choice (step 3), not the raw pattern.
3. **Confirmation card.** The client renders the draft as a delegation-draft card
   whose primary scope UI is **never raw glob editing**: the card leads with a
   human-readable scope summary ("requests like this one, from this worker") and a
   **scope selector** of host-generated patterns — *exact* (this precise subject),
   *this directory* (the subject's containing prefix + `**`), *this worker* (any
   subject from this verified issuer). Raw pattern editing stays available behind an
   "advanced" affordance only. Whatever is chosen, the card warns in both directions
   per §2: on widening, and on a scope unlikely to ever match again (e.g. a
   date-stamped exact path). TTL and `maxUses` are adjustable; for `routine`-severity
   policies the duration selector includes **"until revoked"** (no expiry — revocation
   plus the audit trail is the safeguard in this trusted environment), while flipping
   `maxSeverity: "sensitive"` on forces a finite expiry (30-day default remains
   required for sensitive). `maxSeverity: "sensitive"` is an explicit toggle **off by
   default**, `requiresGrantorPresence` a toggle. Defaults are displayed prominently,
   not buried.
4. **Confirmation is an ordinary audited human-chrome service action.** A card click calls
   `delegations.confirm({ policyId, edits })` as the verified user/device. Conversation EvalDO
   callers are denied even when carrying the blessed owner lineage: activation expands the
   agent's future authority and therefore remains at the independent human-consent boundary. The
   host validates the edits against §2, re-runs matcher validation, stamps `confirmed_at`,
   transitions `draft → active`, and writes the lifecycle audit row with actor/device provenance.
   No receipt or model-specific confirmation path is involved.
5. **Unconfirmed drafts expire after 24 hours** (host sweep — long enough to sleep on
   a decision, short enough that stale drafts don't accumulate); the row transitions
   to the terminal `expired` state and a `draft-expired` lifecycle audit row is
   written. The row is retained like every other terminal-state policy (§1) — the
   state filter keeps it out of matching forever.
6. The confirmed policy takes effect immediately, **including for the triggering
   approval if it is still pending**: activation re-runs the delegation gate (§4 step
   2) over `listPending()`.

## 7a. Renewal affordance — lapsed policies must explain themselves

The failure mode this section exists for: a user delegates a decision, the policy
quietly runs out (budget, TTL, or issuer EV drift), and the next
matching request nags them again with no explanation. The answer must be on the approval card, with a
one-tap fix — never buried in the Delegations surface.

1. **Card copy.** When a pending entry carries `delegation.state === "lapsed"` (§4
   step 2), every human approval surface — desktop approval bar/sheet, mobile sheet,
   and the push notification body — states the lapse in plain terms above the normal
   decision controls: "Policy 〈description〉 expired 2d ago" / "…used 100/100" /
   "…the worker was updated since you delegated"
   (`issuer-changed`, annotated with the policy name and the pinned-vs-current EV).
2. **One-tap renew.** Next to the lapse copy, a **"Renew policy (same terms)"** chip
   (shown only to the policy owner, and only when `lapse.renewable`). Tapping it calls
   service method `delegations.renew({ policyId })` (§9): the host creates a fresh policy
   row copying every field of the lapsed policy — matcher, description, guidance,
   evaluation, `maxUses`, TTL duration, `maxSeverity`, `requiresGrantorPresence` —
   with a fresh budget (`uses = 0`) and a fresh `expires_at` (now + the old TTL
   duration; an until-revoked policy renews with no expiry), `version =
   old.version + 1`, `renewed_from_policy_id = old.policy_id`.
   There is **no draft stage and no conversation round-trip**: the tap is the
   host-recorded confirmation (`confirmed_at` = now, state born `active`), legitimate
   because the terms are byte-identical to ones this user already confirmed and the
   tap comes through the same `system.delegations.manage`-gated shell surface as
   `delegationsConfirm`. Audit: a `renewed` lifecycle row on the **old** policy and a
   `created` + `confirmed` pair on the new one, all attributed to
   `ctx.caller.subject`; the lineage chain (`renewed_from_policy_id`) is rendered in
   the Delegations surface and the per-policy audit trail.
3. **Issuer-changed renewals are not quite "same terms".** When the lapse reason is
   `issuer-changed`, the chip reads **"Renew for updated worker"** (owner-only, like
   every renewal): the new policy is byte-identical except `issuer.effectiveVersion`
   is re-pinned to the request's **current host-verified** issuer EV — never a
   worker-supplied value. The card shows the policy name and pinned-vs-current EV
   (`lapse.changedIssuer`); because the old policy is still nominally `active`
   (dead-in-practice), the renewal additionally revokes it (reason `superseded`) in
   the same transaction — one live policy per lineage. This is the everyday
   renewal in a workspace where workers are edited daily.
4. **After the tap** the renewed policy takes effect immediately, including for the
   triggering entry: activation re-runs the delegation gate over `listPending()`
   exactly as §7 step 6 — the request the user was staring at is typically decided by
   the renewed policy seconds later, which is the point.
5. Renewal is offered from three places, all calling the same `delegationsRenew`:
   the lapsed approval card (this section), the exhaustion notice on a final decision
   card (§6), and a "Renew" action on exhausted/expired rows in the Delegations
   surface (§9). Revoked policies are never renewable — revocation was an explicit
   human "stop", not an accident of arithmetic.

## 8. Policy scope and device attribution

Policies are owned and managed per **(workspace, user)** — a delegation the user
grants from their phone is the same policy their desktop sees, edits, and revokes.
Devices are **attribution, not partition**: `created_from_device_id` stamps which
device performed each grant or renewal (renewals stamp the renewing device on the new
row), it renders in the audit trail and the Delegations surface, and it is never a
match key, a listing partition, or a lifecycle trigger. Device revocation therefore
does **not** touch policies — they belong to the user, who revokes them explicitly if
desired.

Evaluation is **hub-side and independent of device presence**: a phone-granted policy
keeps deciding while the phone is pocketed (approving-while-away is a primary use
case). The per-policy opt-in `requiresGrantorPresence: true` restricts matching (§4
step 2) to windows where the **owning user** has an active authenticated session on
any of their devices — since policies are user-scoped, presence is user-level too.
Presence comes from `shellPresenceService`: it gains
`isUserActive(userId, maxAgeMs = 60_000)`, keyed on per-connection heartbeats
attributed to verified device sessions resolved to their owning user (the same
`shell:{deviceId}` runtime-id parsing `shellApprovalService.resolverFrom` uses).
Presence failure → the policy simply does not match; the request falls through to
human surfaces with no audit row (it never matched).

## 9. Delegations surface and method schemas

**Surface.** A "Delegations" section (desktop: settings-adjacent panel reachable from
the System Agent drawer; mobile: under the System tab) lists the current user's
policies in one flat per-user list (no device grouping — policies scope per-(workspace,
user), §8): state badge, description, matcher summary, budget remaining
(`uses/max_uses`, expiry countdown or "until revoked"), the granting/renewing device
as an attribution line, and the full per-policy audit trail
(every auto-approval, deny, and escalation with rationale and timestamp). Actions:
one-tap **Revoke** (immediate, `revoked` + lifecycle audit row), **Edit**, which
opens a new-version draft pre-filled and on human confirm activates it while atomically revoking
the old (§1 state machine), and **Renew** on exhausted/expired rows (same
`delegationsRenew` as the card chip, §7a). Renewal lineage
(`renewed_from_policy_id`) renders as a chain so "why did this policy exist" reads in
one place. System Agent eval can call `delegations.list` and publish the same bundled cards.

**Method schemas** live in the owning
`packages/service-schemas/src/delegation.ts`. Chrome and System Agent eval use the same
service; method policy distinguishes non-expanding management from independent human consent.
There is no parallel `systemAgent.*` shell contract:

```ts
// Shared service method — shell surfaces and System Agent eval.
delegationsList: {
  params: z.object({ includeAudit: z.boolean().default(false) }).strict(),
  result: z.object({ policies: z.array(delegationPolicySchema),
                     audit: z.array(delegationAuditRowSchema).optional() }),
  access: { capability: "system.delegations.read" },
},

// Shared service method; writes a DRAFT, never activates.
delegationsPropose: {
  params: z.object({
    createdFromApprovalId: z.string(),
    description: z.string().min(1).max(300),
    matcher: delegationMatcherSchema,          // §2, strict, unknown keys rejected
    guidance: z.string().max(1000).default(""),
    evaluation: z.enum(["agent", "auto"]).default("agent"),
    budget: z.object({ maxUses: z.number().int().min(1).max(500).default(100),
                       // null = "until revoked" — the host rejects it unless the
                       // policy's maxSeverity is (and stays) 'routine' (§1, §7 step 3)
                       ttlMs: z.number().int().min(60_000)
                               .max(365 * 24 * 3600_000).nullable()
                               .default(30 * 24 * 3600_000) }),
  }).strict(),
  result: z.object({ policyId: z.string(), state: z.literal("draft") }),
  access: { capability: "system.delegations.write" },
},

// Human activation. Method policy rejects DO/agent callers before the handler.
delegationsConfirm: { params: z.object({ policyId: z.string(),
                        edits: delegationConfirmEditsSchema }).strict(), …,
                      policy: { allowed: ["shell"] },
                      access: { capability: "system.delegations.manage",
                                sensitivity: "admin" } },
// Non-expanding management remains available to eval under normal lineage/audit.
delegationsRevoke:  { params: z.object({ policyId: z.string() }).strict(), …,
                      access: { capability: "system.delegations.manage" } },
// One-tap same-terms renewal (§7a). Owner-only (host checks ctx.caller.subject ==
// policy.user_id); rejects unless state is 'exhausted' or 'expired', OR 'active' with
// a host-detected issuer-changed near-miss on approvalId (in
// which case the old row is revoked 'superseded' in the same transaction); never
// 'revoked'. For issuer-changed renewals it re-pins issuer.effectiveVersion from the
// approvalId's host-verified issuer identity, never from any worker-supplied value.
// A verified human chrome tap is the only path; conversation EvalDO callers are denied.
delegationsRenew:   { params: z.object({ policyId: z.string(),
                        approvalId: z.string().optional()  // issuer EV re-pin source
                      }).strict(),
                      result: z.object({ policyId: z.string(),
                                         state: z.literal("active") }),
                      policy: { allowed: ["shell"] },
                      access: { capability: "system.delegations.manage",
                                sensitivity: "admin" } },

// Shared severity service (§7 step 1).
severityFor: {
  params: z.object({ approvalId: z.string() }).strict(),
  result: z.object({ severity: z.enum(["routine", "sensitive", "critical"]) }),
  access: { capability: "system.delegations.read" },
},

// Micro-session invocation ONLY; absent from the eval/say conversation registry.
delegationApprovalsDecide: {
  params: z.object({
    approvalId: z.string(),
    evaluationToken: z.string(),               // single-use, minted per invocation (§5)
    decision: z.enum(["approve_once", "deny", "escalate"]),
    rationale: z.string().min(1).max(200),
  }).strict(),
  result: z.void(),
  access: { capability: "system.approvals.decide" },
},
```

`delegationApprovalsDecide` is the only agent path to protected approval payload/settlement. It is
enforced unusable outside micro-sessions by **three** independent layers: (1) the host authorizes
it only for an invocation context carrying the evaluation descriptor and never exposes that
authority through the conversation EvalDO's `services`/`rpc`; (2) the host validates the single-use
`evaluationToken` against the in-flight evaluation (approvalId-bound, consumed on first
use, void after the 30 s timeout); (3) the `system.approvals.decide` capability check
requires a grant held only by the seeded system-agent mission
(`mission:system-agent@<closureDigest>` — §5); the SystemAgentWorker code principal
holds no such grant, and no userland code or interactive session can reach it at all.

The evaluation token is not an action receipt or a general shell authorization. It identifies one
already-delegated pending request at the separate consent boundary and is unusable for ordinary
eval service calls.

The conversation EvalDO may list mechanical pending metadata but is denied ordinary approval
payload/options reads and every settle/approve/deny method. A broad shell grant does not override
this consent check. The explicit “Delegate similar…” gesture may post the one triggering request's
structured payload into the conversation for policy drafting; that does not supply an evaluation
token and cannot settle the request.

Conversation eval may call `delegations.propose`, `delegations.list`, and
`delegations.revoke`. It cannot call `delegations.confirm` or `delegations.renew`, nor activate an
edited replacement. Those method policies require the verified shell caller representing human
chrome, so the agent cannot turn a draft into its own persistent future authority.

## 10. Work items

1. **Store + classifier** — `delegations.db` schema, `delegationPolicyStore.ts`,
   `classifySeverity` + shipped critical list, matcher validator/globber with
   exhaustive unit tests (character classes, escaping, separator semantics, anchoring).
2. **Queue gate** — `delegation` field on `PendingApproval`, synchronous evaluator
   hook in `approvalQueue` enqueue paths **before first `pending-changed`** (ordering
   test: no push fanout can observe an unstamped matched entry), uniform
   settle through the WP5 coordinator, push-hold in `approvalPushBridge`,
   escalation fall-through, the lapsed-near-match pass and `DelegationLapse` stamp
   (exhausted, expired, issuer-changed; never holds push), settle-lock race
   test (human vs agent verdict) including the budget reservation/
   `decision-superseded` compensation path.
3. **Micro-session runner** — evaluation invocation as a triggered run of the seeded
   system-agent mission (mission fact stamped at spawn; authority =
   `mission:system-agent@<closureDigest>`, §5), evaluationToken lifecycle, 30 s
   timeout → escalate, output-schema enforcement.
4. **Provenance** — `ApprovalResolver.agent`, `decidedBy` on
   `ApprovalResolvedEvent`/`ApprovalProvenanceRecord`, `via: "delegation"`, governance
   log columns, surface rendering of agent-vs-human resolutions.
5. **Flow + UI** — delegate action on `ApprovalCard.tsx`/`approvalCardModel.ts` and
   mobile sheet, `delegations.propose` eval recipe, confirmation card with human-readable
   scope summary + scope selector (exact / this directory / this worker; raw glob
   behind "advanced" only) and both breadth warnings (widening AND
   unlikely-to-match-again, §2/§7 step 3), until-revoked duration option gated to
   routine severity, 24 h draft expiry sweep, Delegations surface (flat per-user list,
   device attribution line) with revoke/edit-as-new-version and renew-on-lapsed-rows.
6. **Renewal + budget visibility** — `delegationsRenew` (owner check, state check,
   issuer EV re-pin, lineage columns, `renewed` audit row), lapsed-policy copy and
   renew chip on approval card/sheet/push body, running "uses N/M · TTL" on
   agent-decided flashes, final-use
   exhaustion notice with renew chip, gate re-run over `listPending()` after renewal.
   Tests: renewal copies every field and resets budget/TTL (an until-revoked policy
   renews with no expiry); renewal of a revoked
   policy is rejected; renewal by a non-owner is rejected; an
   issuer-changed near-miss (matcher binds except `issuer.effectiveVersion`) stamps
   the entry `issuer-changed` with the policy name, offers the owner-only "Renew for
   updated worker" chip, and the renewal re-pins the EV from host-verified identity
   and revokes the old row `superseded`; the
lineage chain resolves old → new in both audit queries; until-revoked is rejected
   at propose/confirm time when `maxSeverity` is `sensitive`.
7. **Adversarial exit tests** — a hostile `title`/`summary` cannot influence matching
   (matcher has no field for it); an unknown capability name classifies critical and
   never matches; a policy for user A never settles a slot attributed to user B; the
   conversation runner provably lacks protected approval payload/settlement and
   `delegationApprovalsDecide`; a replayed evaluationToken is
   rejected; `requiresGrantorPresence` blocks matching when every one of the owner's
   device heartbeats is stale (user-level presence, §8); and `delegationsConfirm`
   and `delegationsRenew` reject full System Agent eval regardless of blessed
   lineage while verified human chrome succeeds.
