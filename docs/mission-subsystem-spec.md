# Mission Subsystem Spec

Status: implementation spec for D9/D10 of `capability-model-redesign.md` (2026-07-21).
Companion specs: `approval-prompt-ux-spec.md` (cards 5.6/5.7),
`system-agent-sa0-plan.md` (the first seeded mission), `agent-heartbeats-design.md`
(scheduled agent turns — the main mission consumer besides the system agent).

A **mission** is the durable, content-addressed charter of an unattended agent. The
*grant subject* for standing agentic authority is
**`mission:<missionId>@<closureDigest>`** — identity + version, exactly parallel to
`code:<repoPath>@<digest>`. The digest half makes grants lapse on any charter change;
the missionId half makes grants die with *this* registry entry, so two byte-identical
charters (separate entries, or different owners) can never alias each other's
authority. This follows the harness-as-conduit inversion: harness code holds no
ambient authority; the mission does, and sessions spawned under it exercise it.
Interactive sessions have no mission — live user turns are their charter and session
grants their authority.

## 1. Mission definition

A mission is a stored document (host-owned mission registry, §4 — *not* a workspace
file; workspace files are mutable content and would make the charter self-editable by
agents). Canonical shape:

```jsonc
{
  "missionId": "msn_<rand>",            // stable identity across revisions (NOT the digest)
  "name": "Nightly Backup",             // display name (prompt cards); NOT in the closure
  "revision": 4,                        // monotonic, informational
  "charter": {
    "taskSpec": "<full system prompt / task instructions, verbatim text>",
    "harness": {                        // the conduit (D10)
      "unit": "workspace/workers/system-agent",   // repoPath of the harness unit
      "ev": "<64-hex>"                  // exact blessed EV the mission runs on
    },
    "skills": [                         // pinned playbooks loaded into context
      { "path": "workspace/skills/server-logs", "contentHash": "<subtree hash>" }
    ],
    "toolExposure": {                   // §5 — the structural bound
      "services": ["logs.query", "notification.post", "channel.postMessage"],
      "userlandServices": [             // resolved bindings, not bare names (§5.1)
        { "name": "backup-runner",
          "provider": "workspace/workers/backup-runner",
          "providerEv": "<64-hex>",     // resolved at approval; "@follow-head" if policy'd
          "upgradePolicy": "pinned" | "follow-head" }
      ],
      "evalNetwork": "none" | "declared-origins" | "unrestricted",
      "declaredOrigins": ["https://backups.example.com"]
    },
    "model": {                          // model configuration
      "modelId": "openai-codex:gpt-5.3-codex-spark",
      "params": { "reasoningEffort": "medium" }   // canonical-JSON, sorted keys
    },
    "trigger": {                        // when it runs
      "kind": "cron" | "event" | "manual",
      "cron": "0 2 * * *",              // when kind=cron
      "event": { "source": "...", "filter": "..." }  // when kind=event
    }
  },
  "owner": { "userId": "...", "deviceId": "..." },  // per SA design: (user, device) scoping
  "state": "draft" | "active" | "needs-reapproval" | "paused" | "retired",
  "closureDigest": "<64-hex>",          // computed, §2; cached, always recomputable
  "createdAt": ..., "updatedAt": ...
}
```

Notes:

- `harness.ev` is an **exact EV**, not `follow-head`. A mission is pinned by
  definition — that is what makes its digest meaningful. Missions wanting newer harness
  code go through edit → diff → re-approval (§3), never silent drift. (This is R1's
  `pinned` upgrade policy, mandatory for missions.)
- `skills` pin **content hashes** (the `manifest:` subtree hashes the EV computer
  already uses), not paths alone. A skill edit changes the closure.
- `name`, `missionId`, `revision`, `owner`, `state` are deliberately **outside** the
  charter/closure: renaming or re-owning a mission is not a behavioral change and must
  not lapse grants. `missionId` nevertheless appears in the grant **subject** (it is
  the identity half of `mission:<missionId>@<closureDigest>`) — it is excluded from
  the *digest*, not from the *subject*.

## 2. Closure computation

Reuses the EV content-closure pattern (`effectiveVersion.ts`: sha256 over
`\0`-separated parts, sorted dep signatures):

```
closureDigest = sha256(
  "mission-closure-v1"            \0
  sha256(canonicalJson(taskSpec)) \0
  "harness" \0 harness.unit \0 harness.ev \0
  ...for each skill (sorted by path):
      "skill" \0 skill.path \0 skill.contentHash \0
  sha256(canonicalJson(toolExposure)) \0
  sha256(canonicalJson(model))    \0
  sha256(canonicalJson(trigger))  \0
)
```

- `canonicalJson` = JSON with lexicographically sorted keys, no insignificant
  whitespace, NFC-normalized strings — same canonicalization the invocation snapshot
  uses (acquisition protocol spec) so digest discipline is uniform.
- The harness contribution is its **EV**, which already closes over the harness's full
  transitive dep tree (`ev(package) = hash(contentHash, depSig...)`). The mission
  closure does not re-walk dependencies; it trusts the EV.
- `trigger` IS in the closure (schedule changes are charter changes — "nightly →
  hourly" is exactly what card 5.7 must show). Debated; resolved *in*: a mission that
  runs 60× more often is behaviorally different.
- **Deliberately excluded** (D9): mutable workspace data the agent reads at runtime
  (governed by D8 context integrity), conversation history, the ingestion log, session
  ids, owner identity, display name, revision counters, timestamps.

Versioning: the leading `"mission-closure-v1"` domain tag means a future field addition
is a new closure version; old grants (bound to v1 digests) lapse on migration and
re-approval shows "Vibestudio updated how automations are described" — never silently
recomputed.

## 3. Lifecycle

```
draft ──approve(card 5.6)──▶ active ──edit──▶ needs-reapproval ──approve(card 5.7)──▶ active
                              │  ▲                    │
                              │  └──────pause/resume──┤
                              ▼                       ▼
                            retired ◀────────────retire
```

- **Create → draft.** Authored by a user directly, by an agent proposing (a draft is
  inert — no grants, no runs), or by promotion of a recurring task. Drafts are freely
  editable.
- **Approve (prompt card 5.6 `automation.setup`).** Always user-approved — never
  SA1-delegable (a mission approval is the user chartering unattended authority; same
  rule as preauthorization batches). Approval: (1) computes and stores `closureDigest`;
  (2) mints the mission's standing grants with subject
  `mission:<missionId>@<closureDigest>` from the reviewed permission rows; (3) sets
  `active`. **Gated on P4a**: before the context
  latch exists, approval is refused at the service level (`EAGAIN`-class typed error
  "unattended automations require the trust update") — not hidden in UI.
- **Run.** The trigger fires → the host verifies: state `active`, harness EV present
  and (for conduit-role harnesses) still blessed, closure digest recomputes to the
  granted value. It then spawns the session with the mission fact stamped (§6). Any
  mismatch → state `needs-reapproval`, run skipped, owner notified (inbox, not modal).
- **Edit → needs-reapproval.** Any charter field change recomputes the digest. Old
  grants do NOT transfer: they remain bound to the old digest, which no session will
  ever present again — **lapse is a consequence of subject mismatch, not a revocation
  sweep**. Card 5.7 (`automation.changed`) shows only changed closure inputs;
  "Approve changes" mints fresh grants to the new digest and retires the old ones
  (explicit cleanup of now-unreachable grants, for permissions-surface hygiene).
  "Keep old version" is offered only while the old harness EV + skills remain resolvable
  in the content store.
- **Pause / resume.** State flag only; grants untouched (unreachable while paused since
  no sessions spawn). Resume needs no re-approval if the digest still matches.
- **Retire.** Terminal. The missionId half of the subject dies with the entry, so
  every grant bearing it is unreachable from that moment — including in the
  (now-impossible-to-confuse) case where another registry entry carries a
  byte-identical charter: that entry's grants bear *its* missionId and are untouched.
  Grants are additionally retired explicitly for permissions-surface hygiene; the
  registry row is kept (provenance/audit) and mission denials remain in the grant
  store as durable negative history.

## 4. Storage & identity

- **Mission registry**: host-owned SQLite (`governance/missions.db`, sibling of the SA1
  `delegations.db`), single-writer via the owning host process. Tables: `missions`
  (definition JSON + state + digest), `mission_revisions` (append-only prior charters,
  for card 5.7 diffs and audit), `mission_runs` (runId, sessionId, startedAt, outcome —
  feeds the transcript and heartbeat views).
- **Identity split**: `missionId` names the *continuing intent* (UI, run history,
  denial provenance); `closureDigest` names the *approved version of the charter*. The
  authority subject `mission:<missionId>@<closureDigest>` carries **both**: the digest
  half enforces "any charter change lapses authority", the id half enforces "authority
  belongs to this registry entry, not to whoever else typed the same bytes". Neither
  half alone is a valid subject; the evaluator matches the pair exactly. The registry
  maps one missionId to many digests over time.
- Mission **deny** grants: subject `mission:<missionId>@<closureDigest>` like allows. A deny the
  user intends to survive edits ("this automation must never touch credentials") is
  re-minted automatically against each new digest at re-approval time — recorded in the
  registry as a `standing_restrictions` list shown on every 5.7 card ("Still blocked:
  {action}"). This keeps the evaluator exact-match simple while giving durable intent.

## 5. Tool exposure — the structural bound

The one reachability-limiting element of the model (capability redesign, "what safety
rests on"). Semantics:

- `toolExposure.services` is an **allowlist of service.method ids** (open tier included)
  addressable by any session running under the mission. It bounds *addressability*,
  before tiers/grants are even consulted: a call to a method outside the list fails
  `EMISSIONSCOPE` with a typed error naming the mission — not acquirable, because no
  human prompt should be able to widen a running mission's reach (that would be an
  un-reviewed charter change; the remedy is edit → re-approve).
- Enforcement point: the **service dispatcher**, as the first check after caller
  verification, keyed off the session's authenticated mission fact (§6). Direct-RPC to
  DOs is covered because attestation minting runs through the same authority context;
  eval network egress is bounded by `evalNetwork`/`declaredOrigins` at the egress proxy.
- Grants and preauthorization envelopes are ⊆ exposure by construction: approval UI
  (card 5.6) derives its permission rows *from* the exposure list + tier table; a grant
  request outside exposure is a validation error at mint time.

### 5.1 Userland service bindings are resolved, not named

A bare userland service *name* is not a bound reach: whoever provides the protocol
tomorrow inherits the mission's trust today. So `userlandServices` entries are
**resolved bindings**: at approval time the host resolves the name to the concrete
provider unit and records `{name, provider, providerEv, upgradePolicy}` in the
charter — and the closure hashes what the policy pins:

- `"pinned"` (default): the closure hashes the resolved `providerEv`. A replacement
  or upgraded provider is a charter change → card 5.7 re-approval ("Uses backup-runner:
  updated — [view]"). This is R1's pinned policy applied to reach.
- `"follow-head"`: the closure hashes the policy marker + provider repoPath (not the
  EV). The user is explicitly chartering "this mission follows this provider's current
  code". **Honest trade, stated on the 5.6 card**: provider updates change what the
  mission reaches without re-approval; what remains pinned is the provider *identity*
  (repoPath) — a different unit claiming the name is still a charter change. Card 5.6
  renders follow-head rows with a marker ("follows updates").

Host-service exposure stays **method-level** (`service.method` ids — already the §5
grammar). Userland exposure is service-level *with* the provider binding above:
per-method userland granularity is deferred until protocols advertise stable method
sets (was open question 3, now resolved to this).
- Authoring ergonomics: the draft editor proposes the exposure list from the task
  spec's evident needs (scanner-as-proposal, D3) and from observed invocations during
  supervised dry-runs; the human confirms. Wildcards are allowed per service
  (`"logs.*"`), never globally (`"*"` is a lint error — an unbounded mission is a
  contradiction).

## 6. Session integration

- At spawn, the host stamps the session's `AuthorizationContext` with the
  **mission fact**: `{ missionId, closureDigest, harness: {unit, ev} }`. It is a
  host-asserted fact (the host resolved the trigger and spawned the session), attested
  alongside the context-integrity class by the blessed conduit harness.
- Evaluator: session-origin lookup matches subjects `session:<id>` ∪
  `mission:<missionId-from-fact>@<digest-from-fact>` (single-origin authority set;
  uniform deny precedence).
  No mission fact → no mission subject in the set. Sessions can never *claim* a
  mission; only spawn-time stamping creates the fact.
- Interactive sessions: no mission fact, ever — including interactive chats *with* the
  system agent (its standing authority applies only to its triggered/unattended runs;
  an interactive turn's gated calls go through ordinary acquisition). This is the
  strictly-reactive posture from the SA design expressed in the model.
- Context integrity: mission sessions start `internal` and latch like any session;
  standing mission grants require ⊆ internal at use time (empty `lineageAtConsent` —
  standing authority never pre-consents to taint). A mission session that reads outside
  content degrades to prompt-per-action → in the unattended case, to SA1 delegated
  policies or the inbox. This is the log-watcher posture generalized.

## 7. Seeded first-party missions

Format: `seed/missions/*.json` in the **host-shipped product snapshot** — same charter
schema as §1, with `harness.ev` and skill hashes written as `"@seed"` placeholders.

At seed time (host install/upgrade), the seeder:

1. Builds/blesses shipped conduit harness units from the seeded snapshot (D10 conduit
   policy — digests computed over shipped content, never the live workspace tree).
2. Resolves every `"@seed"` placeholder to the just-computed EV/content hashes,
   computes the closure digest, and upserts the mission (state `active`,
   `owner: system`, marked `seeded: true`).
3. Mints its standing grants to the new digest and retires grants bound to the previous
   seed's digest.

Host upgrade therefore re-blesses and re-mints automatically (shipped provenance);
a workspace edit to the harness produces a different EV that matches neither the
conduit blessing nor any granted closure — the SA0 firewall, twice over. Seeded
missions are visible in the same UI, pausable by users, but not editable in place
(editing forks a user-owned copy with `"@seed"` pins frozen to concrete values, going
through ordinary 5.6 approval — the seeded original remains).

**SA0 expressed in this format**: mission `system-agent` — harness
`workspace/workers/system-agent@<blessedEv>`; taskSpec = the product-owned system
prompt; skills = the SA recipe set; toolExposure = the `system.*` service list from the
tools-cards registry; model per SA design; trigger `event` (user turns / delegated
approval micro-sessions). Its `system.*` grants are minted to
`mission:system-agent@<seededClosure>` —
`SystemAgentWorker`'s code principal holds nothing. SA0's plan item "grants bound to
`code:…@blessedEv`" is superseded by this (same protection, now uniform with all
missions); the SA0 doc should be amended accordingly.

## 8. Phasing

- **P3** builds: registry, closure computation, lifecycle service (create/edit/diff),
  the mission fact + evaluator matching, tool-exposure enforcement, cards 5.6/5.7
  plumbing. Approval/minting stays refused until P4a (typed error, §3).
- **P4a** switches on: mission approval, standing-grant minting, preauthorization
  envelopes, seeded first-party missions.
- Heartbeats (`agent-heartbeats-design.md`) adopt missions as their charter/authority
  container when they land; cron-adjacent loops (news, gmail) migrate from ad-hoc
  scheduling to mission triggers opportunistically thereafter.

## Open questions

1. **Event-trigger filter language** (`trigger.event.filter`): needs its own small
   grammar; whatever is chosen is closure content, so choose before first approval.
2. **Dry-run mode**: supervised mission runs (interactive, prompts live) for authoring
   the exposure list — worth a small addendum once P3's acquisition loop exists.
3. ~~Exposure granularity for userland services~~ **Resolved (§5.1)**: service-level
   with resolved provider binding (`pinned` EV by default, explicit `follow-head`
   opt-out); per-method userland granularity deferred until protocols advertise stable
   method sets.
4. **Cross-device ownership**: SA design scopes conversations per (user, device);
   missions are per-user with device recorded — confirm whether any mission behavior
   should be device-conditional (`requiresGrantorPresence` analog) or whether that
   remains purely an SA1 policy concern (current answer: SA1-only).
