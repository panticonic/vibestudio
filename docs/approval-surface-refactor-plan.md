# Approval Surface Refactor Plan

Status: implemented in part (2026-09-03), revised the same day after review (§0),
with the exact remaining boundaries recorded in §18. This
plan turns the approval-fatigue audit of a real agentic build session into a
clean authority and interaction cutover. It refines
[`approval-prompt-ux-spec.md`](approval-prompt-ux-spec.md),
[`authority-acquisition-spec.md`](authority-acquisition-spec.md), and
[`template-install-unit-approval-ux-plan.md`](template-install-unit-approval-ux-plan.md).
Those documents already define the task-scoped grant as the chat session: the
UX spec's vocabulary table translates the interactive session as "this task",
and the acquisition spec (§3.1, §5.2) defines `sessionId` as the durable
conversation id. This plan does not supersede that definition. It makes the
runtime finally implement it (§5 A1), because the code drifted to two other
units, neither of which a person can see.

Guiding goal: good, understandable user control without fatigue. Every phase
below is judged by whether a person can predict what a tap covers and whether
it removes a prompt they could not tell apart from an earlier one.

## 0. Review revisions (2026-09-03)

The first draft was reviewed against the running code and the earlier agreed
authority decisions. These are the changes; the rest of the document has been
edited to match. Items 1 to 11 are the first revision and still refer to the
draft's phase numbers; item 12 records the second revision, which replaced the
phases with the single path of §8.

1. **The task is this agent in this conversation, not a new entity.** The draft introduced an
   explicit task object with create/complete/abandon events that the person or
   agent must manage. That is a second lifecycle to learn, a new way to leak
   authority (a task nobody closed), and a new way to re-prompt (a task closed
   too early). The chat already is a stable, titled, user-visible unit with a
   natural end. The authority subject binds to it (§5 A1). Narrower boundaries
   remain available inside a chat through the existing preauthorization
   envelope, which already carries `session_id` and `task_ref`.
2. **A third authority fact was missing from §2.** Besides the turn-scoped task
   subject, the `session` decision binds to `authoritySessionId`, a random UUID
   minted per execution session in `agentExecutionSessionRegistry.ts`, while its
   credential and network copy promises "until you close Vibestudio". Two
   mid-tier choices with different lifetimes and untruthful copy are themselves a
   fatigue and trust defect. The `session` decision is removed as a user choice
   (§6.1); the conversation-bound task rule is the only mid-tier answer.
3. **Outside-content consent becomes task-level (§5 A10).** Under per-grant
   `lineageAtConsent`, one new source invalidates every rule in the chat, so the
   Trello import would produce one delta card per rule (storage, inspection,
   supervision) rather than one. Consent to a source is recorded once per task
   and joined at evaluation; the delta card lists the rules it extends.
4. **Phase 4 is mostly landed.** `unitClearanceGrants.ts` already mints
   exact-version clearance rows for the rows selected in the install review
   (template-install plan §6.4). The audit contains no first-use re-ask of a
   selected row. Phase 4 shrinks to verification plus the one genuinely new
   item, joining agent task preauthorization to the review when both are known.
5. **The `task.permissions` card does not exist.** The draft said "wire the
   existing card". The prompt registry has seven types and none is a
   preauthorization batch; only the envelope tables exist. Phase 1 builds it.
6. **The durable operation is the queue entry, not a new store.** Composition
   already exists (`acquireMany`, `authorityFacets`); the defect is the two
   documented fallbacks to independent acquisition. Phase 2 removes those and
   threads one `operationId` for correlation. It does not add a persisted
   operation table. Pending-queue durability across restart moves to Phase 6
   as a reliability item: the eval reruns after restart anyway (acquisition
   spec §5.2), so the visible cost is one extra prompt in a rare case.
7. **Credential and browser storage unification is demoted.** The capability
   redesign explicitly decided credential-use grants stay in the credential
   system. The user-visible symptom, a network card plus a credential card for
   one request, is fixed by composition in Phase 2. Phase 5 keeps the semantic
   family registry and alias deletion, which do change what users read, and
   makes store unification conditional on composition proving insufficient.
8. **No clock-bound authority.** `expired` is replaced by `ended` (a lifecycle
   event: chat closed, envelope closed, runtime gone). Task rules carry no TTL.
   Cooldown stays, because it changes when a card is shown, never whether work
   succeeds.
9. **Parked is not hidden.** Any ask that the interrupt budget keeps out of the
   foreground returns control to the agent immediately with a pending state,
   and the approvals chip shows it. An agent must never sit on a card the
   person cannot see.
10. **Honest prompt-count targets.** Three decisions for the Trello fixture
    assumes the agent preflights its planned effects into one task-permissions
    card. Without agent cooperation the same fixture settles at seven.
    Both numbers are exit criteria (§10.1), so the design is not judged only by
    its best case.
11. **Audit scope matches the product framing.** This is a trusted family/team
    deployment. The audit contract (§9) is for diagnosis and a Permissions view,
    not a tamper-evident chain. "Immutable" becomes "append-only and
    correlated".
12. **One path, no deferrals (second revision, same day).** The phased plan
    was collapsed into a single path (§8) chosen to reduce risk rather than
    work. Every step reuses a mechanism that already runs: the coordinator's
    rule issuance, `acquireMany` over several leaves, the install review's
    typed partial acceptance, the grant store's revoke-by-subject. Items that
    needed a new mechanism were not deferred but eliminated, and their
    user-visible outcome was absorbed into the path: the preauthorization
    envelope tables and the separate `task.permissions` card give way to one
    "rules card" that also serves the source delta and agent preflight; store
    unification gives way to composition; the dedup-key rewrite gives way to
    copy that is a pure function of security facts; static route validation
    gives way to a loud fallback metric; queue durability across restart is
    dropped because the eval reruns and re-asks. The three edits that carried
    real risk in the first revision (registry liveness, the use-time lineage
    gate, the queue identity function) are no longer edited at all.

## 1. Outcome

A person answers one comprehensible question for each distinct:

```text
actor + task + semantic effect + resource boundary + influence set + risk
```

The runtime may enforce several independent authority leaves for that decision.
Those leaves remain independent constraints, but they are acquired atomically as
one operation and presented as one question. Transport methods, provider
envelopes, panel incarnations, runtime IDs, and copy variations never become
additional consent concepts unless they are genuine security boundaries.

The result is fewer prompts without broader authority. Critical and irreversible
effects remain fresh, exact, once-only confirmations.

## 2. Triggering evidence

The audit traced the `Trello-style task board` chat in workspace `dev-02a05dad`,
channel `chat-940a1e6a`, across two trajectory turns. The session required ten
user decisions:

| Time (Europe/Berlin) | Decision | Scope |
|---|---|---|
| 08:40:27 | Use the ChatGPT Codex model credential | version |
| 08:42:00 | Add the task-board worker and panel | version |
| 08:48:46 | Use Task Board Storage | task |
| 08:48:54 | Use Task Board Storage | task |
| 08:49:04 | Manage workspace runtime state | task |
| 08:49:23 | Inspect panels | task |
| 08:54:22 | Inspect panels | task |
| 08:57:08 | Use Task Board Storage | task |
| 08:58:45 | Use Task Board Storage | task |
| 08:59:04 | Supervise the task-board panel | task |

Eight runtime prompts represented only four visible capability/resource pairs.
Four were therefore indistinguishable repeats from the user's perspective.

Two independent authority facts caused the repetition:

1. **A task grant is currently a trajectory-turn grant.**
   `trajectoryTurnTaskRef()` derives the authority coordinate from the branch and
   turn in `src/server/workspaceSourceProvider.ts`; `TaskAuthorityRegistry` then
   hashes that coordinate into the task subject. A follow-up chat turn receives
   a new subject even when the person is plainly continuing the same task.
2. **The influence set changed without the card explaining the delta.**
   Task Board Storage was first granted with `lineage_at_consent=["none"]` and
   then requested again with `lineage_at_consent=["external"]`. The latter is a
   real security distinction, but both cards asked the same visible question.
3. **The other mid-tier choice is also mislabelled.** The `session` decision
   issues a grant to `session:<authoritySessionId>`, where the id is a random
   UUID per execution session (`agentExecutionSessionRegistry.ts`), while its
   copy for credentials and network reads "until you close Vibestudio". The
   acquisition spec defines this id as the durable conversation id. Two
   mid-tier answers with different, invisible lifetimes give the person no way
   to predict what a tap covers.

Exact queue deduplication correctly refused to merge those different security
facts. Weakening exact deduplication would hide authority expansion and is not a
fix. The authority unit and the presentation transaction must change instead.

The trajectory also emitted repeated `decision received` and `granted` progress
events for individual invocations. Those were not additional user decisions,
but they amplify the visual impression of repeated gates and require their own
presentation cleanup.

## 3. Catalog baseline

The refactor owns every interactive authority surface, not only capability
cards.

### 3.1 Runtime authority catalogs

- `packages/shared/src/authority/hostAuthorityCatalog.generated.ts`: 552 host
  methods — 417 open, 117 gated, and 18 critical — across 92 capability names.
- `docs/runtime-foundations/authority-ledger.json`: 716 ledger rows — 432 open,
  255 gated, 20 critical, and 9 mixed `gated|critical` rows.
- `packages/shared/src/hostApprovalCopy.ts`: 48 reviewed semantic prefixes used
  to turn low-level authority into user-facing action families.
- `packages/shared/src/authority/capabilityNotability.ts`: headline/everyday
  classification for all generated promptable capabilities.
- `src/server/services/__serviceAuthorityMatrix.golden.json`: 55 services and
  433 method entries in the service-level golden audit view.
- Dynamic `workspace-service:<name>` envelopes and provider-owned method leaves,
  sealed during Build V2 and enforced independently.

The runtime-foundations ledger contains roughly 570 distinct low-level
capability labels and 284 promptable rows. Those counts are intentionally larger
than the 92 generated host capability names: the files inventory different
layers and include transport/method-specific authority. They are not competing
answers to one count, but their mismatch demonstrates why neither can serve
directly as the user's permission vocabulary.

The generated method and ledger labels are enforcement vocabulary. The reviewed
semantic prefixes are the starting point for the user-facing vocabulary. A new
RPC or transport label does not create a new kind of permission.

### 3.2 Static native-app capabilities

`packages/shared/src/unitManifest.ts` declares 18 native capabilities:

```text
native-menus, notifications, tray, global-shortcut, fs-read, fs-write,
clipboard, dialog, open-external, browser-import, window-management,
camera, microphone, location, panel-hosting, incoming-pair-links,
keychain, connection-management
```

These remain install/admission inputs enforced by the native host. When one
describes the same human effect as a runtime capability, both map to one
semantic operation family; the static declaration does not create a second
user-facing vocabulary.

### 3.3 Queue interactions

The pending queue currently mixes eight interaction kinds:

| Current kind | Target interaction class | Authority decision? |
|---|---|---|
| `capability` | Permission or Critical confirmation | yes |
| `credential` | Permission | yes |
| `browser-permission` | Site permission | yes |
| `unit-install-review` | Code review | admits code and selected clearance |
| `client-config` | Account setup | no |
| `credential-input` | Secure input | no |
| `secret-input` | Secure input | no |
| `device-code` | Sign-in progress | no |

They may share one durable rendezvous and delivery infrastructure, but they do
not share one warning-shaped mental model. UI, telemetry, and audit terminology
must call only the first four rows decisions; protected input and sign-in are
workflows.

At audit time, the prompt registry implemented seven card types:
`permission.gated`, `permission.outside`, `confirm.critical`, and template
add/update/remove/suggest variants. The UX specification describes additional
types such as task permissions, trust, automation, installation, and changes.
This is implementation/specification drift, not permission to render an
unregistered fallback card.

### 3.4 Delivery surfaces

Desktop cards, native attention, OS notifications, mobile push/in-app UI,
terminal launch, bootstrap launch, and attached-host relays are presenters for
one acquisition. They must share the same operation and decision IDs. Delivery
fan-out never creates a second decision or a second grant.

## 4. Problems to remove

### P1. The displayed task and the authority task are different things

`Allow for this task` promises a lifetime the system does not implement. The
current turn-derived subject is invisible, unstable across follow-ups, and too
short-lived to support honest preauthorization. The sibling `session` decision
is worse: its subject is an execution-session UUID and its copy claims the
host process lifetime. The person sees two similar buttons and neither means
what it says.

### P2. One operation is rediscovered as several acquisitions

The dispatcher can acquire multiple authority facets together, but nested calls
can fall back to independent acquisition. A workspace-service envelope,
provider leaf, network request, response read, credential use, and runtime host
operation can consequently interrupt separately even when they are facets of
one prepared effect.

### P3. A hidden influence change renders as an identical question

Lineage at consent is security-sensitive and must remain part of evaluation.
The current card fails to disclose the source-set change that invalidated the
earlier decision. The user sees repetition rather than a changed risk.

### P4. Installation and first use can ask the same semantic question twice

Code admission and runtime authority are correctly distinct concepts. However,
when install review already offered and selected ordinary permissions for the
exact version, the review must mint those exact clearance leaves atomically.
Immediate first-use re-acquisition for the same facts is an implementation
failure, not added safety.

### P5. Parallel ledgers model overlapping authority

Canonical capability grants, durable credential-use grants, ephemeral
credential-session grants, browser site grants, and unit admission records have
separate identity and revocation behavior. A single outgoing request may
therefore produce a network card and a credential card without showing that
they are one operation.

Secret material and physical browser/OS projections may remain specialized
storage concerns. The human decision, constraints, audit identity, and
revocation model must be canonical.

### P6. Capability aliases leak implementation history

Known overlaps include:

- external opening: `external.open`, `open-external`,
  `external-browser-open`;
- network response access: `network.fetch`, `network.response.read`,
  `cors-response-read`;
- publication: `git.publish`, `workspace-main-advance`,
  `workspace.history.write`, `workspace-units.publish`,
  `workspace-shared-git-remote`;
- browser information: browser data, passwords, form-fill, sensitive import,
  and site autofill paths.

The low-level distinctions may remain enforcement facets where necessary. They
must not remain competing user-facing capability names.

### P7. Fatigue controls are specified but incomplete

Dismissal cooldown exists, but concurrent prompts are deliberately presented
immediately. The interrupt budget and task preauthorization behavior specified
in `approval-prompt-ux-spec.md` are not end-to-end invariants today.

### P8. Governance records decisions, not the authority lifecycle

The governance log is attribution/provenance rather than a complete security
audit. It does not canonically join operation creation, coalesced waiters, grant
issuance, use, consumption, suspension, revocation, and effect outcome.

### P9. Pending and standing authority have different durability

The approval queue and acquisition rendezvous are in-memory, while capability
grants are durable. A restart can lose the pending entry that explains a
decision while a standing grant survives. Because an interrupted eval reruns
and re-asks (acquisition spec §5.2), the visible cost is one extra prompt in a
rare case; the acquisition spec already accepts it, and this plan does not
change it.

### P10. Browser panel identity may split site consent accidentally

Browser-permission deduplication includes `panelId`. If panels are not intended
security principals, two incarnations of the same panel/site can ask twice for
the same site permission. Environment, owner, workspace, session epoch, site,
and browser capability are plausible consent facts; panel identity should
remain attribution unless product policy explicitly promotes it to a boundary.

## 5. Design invariants

### A1. The task is the conversation

The unit a person can see, name, and end is the chat. Its title is the task
summary the person wrote or accepted; its end (closed or archived) is the
lifecycle event. The authority subject for `Allow for this task` is the
authenticated agent binding of the execution session (`contextId` +
`channelId`, workspace-qualified): this agent, in this chat. It is never
derived from a trajectory turn or an execution-session UUID.

Consequences:

- Follow-up turns, retries, evals, and nested service calls inside one chat
  share the subject. A new chat is a new subject. Continuing versus starting
  is therefore a choice the person already makes with an existing control.
- The card subline names the boundary concretely:
  `Covers {action} in "{chat title}" until you reset this chat's permissions.`
  The reset control in the chat header is the lifecycle event: it revokes every
  rule whose subject is the chat. Closing or archiving a chat, where the shell
  offers it, performs the same revoke.
- There is no narrower authority boundary inside a chat. A person who wants a
  fresh boundary starts a new chat or resets the chat's permissions from its
  header. The preauthorization envelope tables, which no card ever used, are
  deleted.
- Drift within a long chat is bounded by the rule shape, not by a shorter
  lifetime: rules are capability + resource scoped, a new outside source
  requires a delta (A10), critical effects never reuse, and the chat header
  lists what this chat may do with reset.
- Decided (2026-09-03): the subject is the agent binding the execution
  session already carries, `contextId` + `channelId`, which reads as "this
  agent in this chat". Nothing is added to it: a second agent in the same chat
  has its own context and therefore its own subject, and only a runtime whose
  execution session is bound to that context can consume the rule. The one
  removal is `ownerUser`, so a second member continuing the same chat is not
  re-prompted; `issuedBy` records who answered.

### A2. One prepared operation owns acquisition

Before the first protected effect, the runtime opens one operation, recorded
as the pending queue entry it produces (no separate store):

```text
operationId
actor authority subject
task subject (the chat)
semantic effect family
exact resource constraint
prepared effect digest, when relevant
complete currently known influence set
risk and reversibility
required authority facets
parent operation, if nested
```

All nested service calls carry `operationId`. They may add a previously unknown
facet only by updating the same prepared operation before settlement or by
creating a clearly named delta after settlement. They do not independently
prompt for facets already covered by that operation.

### A3. Composition never weakens enforcement

One card may mint several grants only when the facets share the authenticated
actor, task, purpose, resource envelope, influence set, and compatible risk.
Each receiver still evaluates its own leaf. The service envelope never
authorizes the provider leaf, and a network grant never implies credential use.

Critical, destructive, or otherwise non-batchable facets are excluded from the
ordinary transaction and confirmed exactly once against their prepared effect.

### A4. A changed security fact must be visible

Every acquisition after an earlier related decision carries one reason:

```text
new_task | new_source | new_resource | version_change |
prepared_effect_change | critical_effect | revoked | ended
```

`ended` is a lifecycle event (chat reset or closed, runtime gone).
There is no wall-clock expiry on task rules; timeouts in agentic settings are
suspect by default, and a TTL would turn "waiting" into "asked again".

For `new_source`, the card names the newly influential source and shows the
previously approved operation. It does not repeat the original card unchanged.
The decision binds to the displayed source set. A later source requires another
delta, not retroactive broadening.

### A5. Admission mints only what the review offered and selected

Accepting an exact unit version records admission and atomically issues the
ordinary version-bound clearance rows selected in that review. Unknown,
headline, contextual, and critical effects retain their specified first-use or
once-only behavior. No declaration grants by itself.

### A6. Security identity and presentation identity are separate

Consent coalescing uses only authenticated security facts. Titles,
descriptions, formatting, producer keys, progress text, panel incarnations, and
runtime IDs are presentation/correlation facts unless policy explicitly defines
one as a security boundary.

Exact security identity remains fail-closed. Presentation grouping must never
make one decision authorize a different security identity.

### A7. Delivery is idempotent fan-out

Every presenter resolves the same durable decision ID exactly once. Other
presenters close when it resolves. Reconnection re-attaches to the same pending
entry. Across a host restart, a decided request is durable through its grant:
the rerun eval matches the same digest and does not prompt. An undecided
request is not durable; the rerun asks once more. No re-attachment mechanism
is added (acquisition spec §5.2).

### A8. There is one canonical authority lifecycle

Permission decisions for capabilities, credentials, and browser sites behave as
one lifecycle from the person's side: one card per operation, one row in
Permissions, one revoke. They keep their physical stores; a specialized store
is acceptable because composition (8.4) ensures it never produces a second
human decision or an unrevocable grant.

Secure input, client configuration, OAuth device flow, and secret custody remain
workflows, not authority grants.

### A9. Interruptions are budgeted

At most one ordinary permission request interrupts the foreground. Compatible
pending operations compose into the active task-permissions surface; unrelated
ones wait in the approvals chip. Critical confirmation may interrupt according
to its own policy and never joins an ordinary batch.

Repeated progress events update one acquisition card or transcript entry. They
never render as new decisions.

Parked is not hidden. An ask the budget keeps out of the foreground returns
control to the agent immediately with a pending state, appears in the chip
with a count, and resolves whenever the person opens it. The agent may continue
other work or say it is waiting; it never blocks on a card nobody can see.

### A10. Outside-content consent is recorded once per task

`lineageAtConsent` lives on each grant and the use-time gate reads it. The
lineage projection now retains both the broad risk class and an exact
`source:<key>` class. This is an intentional gate change: without the exact
class, two websites or two external channels collapse into one consent class
and a newly influential source cannot be detected. When that exact-source gate
fails, instead of one card for the rule that happened to
be exercised first, the coordinator gathers every live rule of the chat and
presents one `new_source` card naming the source and listing those rules.
Accepting re-issues the selected rules with the extended source set in one
store transaction, through the same `acquireMany` path that already mints
several leaves under one decision. Standing subjects (`code:`, `mission:`,
`agent:`, `version`) keep an empty consent set, unchanged from the context
integrity spec.

Defaults follow the existing notability classification, so no new policy is
introduced: the rule that triggered the card and every everyday rule are on;
headline rules (publication, credential use, messaging, and the like) are
listed off and must be switched on deliberately. Extending a rule to a source
is an explicit, listed decision made by the person; it is not inferred from the
triggering operation. It is the same source-scoped consent the context
integrity spec §6.1 already describes, presented once per chat instead of once
per rule. The evaluator therefore compares exact source classes as well as the
broad lineage class.

## 6. Target interaction model

### 6.1 Permission

Normal visible actions:

- **Allow for this task**
- **Just once**
- **Don't allow**

Standing version, agent, automation, or site choices live under Details or the
Permissions manager when policy permits them. `lock` is a revocation/block
control, not a normal approval answer. `dismiss` closes without deciding and
starts the bounded cooldown; it is not another spelling of deny.

The `session` decision is removed from ordinary permission cards. Its intended
meaning (the conversation) is what the task rule now means; its actual meaning
(an execution-session UUID) is not something a person can reason about. On
those cards the tiers are: once, task (this agent in this chat), standing
(version, agent, automation), deny. Two other surfaces keep a `session`
scope with a different, truthful meaning and are left alone: the credential
card (host-process lifetime) and site permissions (the browser session).

### 6.2 Critical confirmation

Visible actions are **Confirm** and **Cancel**. The card shows the exact prepared
effect. Critical confirmation cannot create a reusable grant or join a batch.

### 6.3 Code review

One review admits the exact code identity and selects the ordinary capabilities
cleared with it. The result is an atomic admission-plus-clearance transaction.
Runtime authority remains independently enforced; it simply finds the exact
grant already issued by the review.

### 6.4 Site permission

Camera, microphone, geolocation, notifications, downloads, clipboard, autofill,
and popups render as site settings tied to the human-readable site. Panel ID is
attribution unless the product explicitly makes panels separate security
principals.

### 6.5 Secure input and sign-in

Client configuration, credential entry, secret entry, and device-code status
are one guided account/setup family. They never use permission-warning copy and
never claim that entering a secret grants an agent permission to use it.

## 7. Canonical semantic families

Create a reviewed registry in which every promptable enforcement leaf maps to
exactly one semantic family and resource renderer. At minimum:

| Family | Consolidates | User question shape |
|---|---|---|
| External opening | external/open aliases | Open `{destination}`? |
| Network exchange | fetch, CORS, response read | Let `{actor}` exchange data with `{site}`? |
| Credential use | canonical and credential-specific paths | Let `{actor}` use `{account}` for `{destination}`? |
| Publication | Git, main advance, history and unit publication | Publish `{prepared change}` to `{destination}`? |
| Workspace service | envelope plus provider leaves | Let `{actor}` `{service action}` in `{workspace}`? |
| Browser information | data/password/import/form-fill paths | Let `{actor}` read/import `{data classes}` from `{browser/profile}`? |
| Runtime hosting | runtime state, panel host and supervision facets | Let `{actor}` run/reload `{named app}`? |
| Panel inspection | CDP/inspection facets | Let `{actor}` inspect `{named panel}`? |

The registry is exhaustive and fail-closed: every gated or critical leaf has one
family, notability, action phrase, resource renderer, batch policy, and risk
policy. Legacy aliases are removed at cutover, not accepted indefinitely.

## 8. Work plan: one path

The plan is a single path, ordered so that each step is measured by the
report the previous step produced. Nothing is deferred to a later programme:
each item of the first draft was either absorbed into a step below in the form
that reuses an existing mechanism, or eliminated (§8.9). The path is chosen to
reduce risk, not work; several steps are larger than their draft counterparts
because they include the tests and the copy work that make them safe.

### 8.1 Fixture and report first

1. Turn the audited Trello session into a deterministic coordinator-level
   fixture (§10.1) before any behavior changes.
2. Add `operationId`, task subject, security identity, decision ID, and repeat
   reason to acquisition and governance events; record the sources shown at
   decision time.
3. Collapse duplicate progress emissions by operation and decision ID.
4. Emit a loud metric each time the dispatcher takes either fallback from
   composed to independent acquisition, with the route that took it.
5. Add the diagnostic report: prompts per chat, prompts per rule,
   identical-visible-card repeats with reason codes, fallback routes taken.

Exit: the fixture reproduces ten decisions and four indistinguishable repeats;
the report lists which routes fell back to independent acquisition.

### 8.2 Bind the task rule to the chat

Mechanism reused: `TaskAuthorityRegistry` unchanged; `taskAuthorityPrincipal`
unchanged except for its input; grant store revoke-by-subject.

1. Derive `taskRef` from the execution session's authenticated agent binding
   (`contextId` + `channelId`) instead of `[logId, head, turnId]`. Delete
   `trajectoryTurnTaskRef`. Drop `ownerUser` from the principal input (A1).
   The binding already distinguishes agents sharing a chat; nothing is added.
   Descendant propagation and "already bound to another authority" checks in
   the registry stay as they are.
2. Remove the `session` decision from `decisionsForOrigin`, from copy, and
   from the coordinator's issuance switch. Rewrite the fifteen "until you close
   Vibestudio" strings to the task subline.
3. Add "Reset permissions for this chat" to the chat header, backed by
   revoke-by-subject, and list the chat's live rules above it. Where the shell
   closes or archives a chat, call the same revoke.
4. Tests before landing: warm runtime reused across two chats; forged channel
   id in a caller; a second member continuing the same chat; retry and
   follow-up turn reusing one rule; a new chat not inheriting it.

Exit: follow-up turns reuse the rule; a new chat does not; exactly one mid-tier
answer exists on every ordinary permission card; the fixture drops from ten to
seven.

### 8.3 One rules card for source deltas and agent preflight

Mechanism reused: `acquireMany` and `authorityFacets` (one decision, several
leaves); the coordinator's existing issuance; the existing `preflight` API.

1. Register one card type, `task.rules`: a title, a reason line, and one row
   per rule with a toggle, all on by default. Its two reasons are
   `new_source` ("This chat has read outside content: {source}. Extend these
   permissions to cover it?") and `planned` ("{agent} plans to: {summary}.
   Allow these now so it won't interrupt you later?").
2. `new_source`: when the exact-source use-time gate fails, gather the chat's
   live rules and include the current first-use ask when it is not already a
   rule. Present them once, and on acceptance issue or re-issue the selected
   rows with the extended source set in one transaction (A10).
3. `planned`: an agent's `preflight` of several planned effects yields
   acquirable leaves; instead of prompting per leaf, present them as one
   `task.rules` card whose acceptance issues ordinary chat rules. There is no
   envelope; the rows are the same rules 8.2 issues one at a time. Delete the
   `preauth_envelopes` and `envelope_rules` tables and their writers.
4. Rows with a critical worst case never appear on a rules card; the reason
   line says so. On a `new_source` card, headline rows are off by default
   (A10).
5. Tests: a rule exercised after a new source without the delta is refused; a
   declined row stays ungranted and does not block accepted rows; two sources
   arriving in sequence produce two cards, each naming its own source.

Exit: the Trello fixture produces one source-delta card for the whole chat;
with agent preflight, the fixture drops to three decisions.

### 8.4 Compose facets that arrive together

Mechanism reused: the same `acquireMany` path.

1. Convert every route the 8.1 metric shows falling back to independent
   acquisition, starting with the workspace-service envelope plus provider
   leaf. Then delete both fallback branches in `serviceDispatcher.ts`. A
   route the metric never observed fails its call with a clear acquisition
   error when first hit, and is converted then; it can no longer split into
   prompts. The metric prioritizes; the deletion is what makes the invariant
   structural.
2. Leave the credential path alone. Credential use enters the queue as its
   own `credential` kind from `egressProxy.ts`, outside the dispatcher, and
   bridging that into `acquireMany` would be a second settlement mechanism.
   The audited session had one credential decision and it was not a repeat.
   A request that needs both a network rule and a credential may therefore
   still show two cards, one of which is the credential card; that is the
   accepted compromise. The credential card keeps its own decisions, including
   its host-process `session` lifetime, whose copy ("until you close
   Vibestudio") is truthful for that card.
3. Make card title and description a pure function of the security fields in
   the queue request, enforced by a test that renders the same snapshot twice
   and diffs. The dedup identity function is not edited.
4. Remove `panelId` from browser-permission dedup identity; site consent keys
   on environment, owner, workspace, origin, and capabilities.

Exit: no route in the report falls back and the fallback branches are gone;
two panels on one site ask once.

### 8.5 Install review carries planned chat rules

Mechanism reused: `unitClearanceGrants.ts` and the review's typed partial
acceptance.

1. Verify by test that a row selected in the review never re-asks at first use
   and that outgoing-version clearance retires in the same acceptance. Fix what
   the test finds.
2. When an agent's `preflight` and a unit install are pending together, the
   review shows the agent's planned rules as a separate, labelled group below
   the unit's rows. Accepting issues code-subject clearance and chat-subject
   rules as distinct rows in one transaction (§15.7). The review remains the
   only surface; there is no second card.

Exit: one visible transaction for the Trello build; the unit does not inherit
the agent's inspection rule and the agent does not inherit the unit's version
clearance.

### 8.6 One family per leaf, at the copy layer

Mechanism reused: `hostApprovalCopy.ts` semantic prefixes and the fail-closed
notability check.

1. Land the exhaustive leaf-to-family registry as a mapping table: every gated
   or critical leaf maps to one family with one action phrase, one resource
   renderer, one notability, and one batch policy. The build fails on an
   unmapped leaf.
2. Aliases (external open, network response read, publication, browser
   information, runtime hosting, panel inspection) are canonicalized where the
   requirement is emitted, so only one capability string per family reaches
   the queue and the store. The old strings are deleted, not mapped. There is
   no store migration; development grant state is wiped, as at 8.2. Mapping
   only the copy would make two aliases read identically while still
   prompting separately, which is the exact defect this plan exists to remove.
3. Resolve the stale `userland` approval documentation/test contract by
   deleting the obsolete API, docs, and tests together.
4. Add the three-way registry invariant (§14.4).

Exit: one capability string per family is emitted; every promptable leaf has
one family; the documented and runtime interaction unions are identical.

### 8.7 Chip and interrupt budget

Mechanism reused: the existing dismissal cooldown and the queue's pending
list.

1. At most one ordinary card interrupts the foreground; further ordinary asks
   go to the approvals chip with a count. Critical confirmation follows its own
   policy and never stacks.
2. An ask that is not foregrounded returns a pending state to the agent
   immediately (A9). The agent may continue or say it is waiting.
3. Render the five interaction classes (§6) as registered, visibly distinct
   cards; secure input and sign-in never use permission styling or count as
   approvals.

Exit: never two modals; parked asks are visible and counted; workflows are not
counted as decisions.

### 8.8 Repeat the accounting

Re-run §13's accounting against the fixture. Required: at most three decisions
with preflight and seven without, no identical visible card, the same or
stricter enforced leaf set, one causal chain per operation.

### 8.9 Eliminated, and what absorbed each

| First draft item | Disposition | Absorbed by |
|---|---|---|
| Explicit task entity with create/complete/abandon | eliminated | the chat, plus the reset control (8.2) |
| `session` decision | eliminated | the chat rule (8.2) |
| Preauthorization envelope tables and `task.permissions` card | eliminated | the `task.rules` card issuing ordinary chat rules (8.3) |
| Task-level consented source record with versioning | eliminated | re-issue of listed rules under one decision (8.3) |
| Persisted operation table | eliminated | `operationId` on the queue entry (8.1) |
| Static validation of uncomposable routes | eliminated | fallback metric, convert by evidence (8.1, 8.4) |
| Dedup identity rewrite | eliminated | copy as a pure function of security fields (8.4) |
| Credential and browser store unification | eliminated | left as is; a credential card may accompany a network card (8.4) |
| Alias store migration | eliminated | canonical string at the emit chokepoint, dev state wiped (8.6) |
| Presenter fan-out rework | eliminated | already converges on the queue contract |
| Pending queue durability across restart | eliminated | eval reruns and re-asks (acquisition spec §5.2) |
| Full authority lifecycle audit chain | eliminated | the report fields of 8.1 and the Permissions list |
| Wall-clock expiry of task rules | eliminated | reset and chat end as lifecycle events |

## 9. Audit contract

For each operation, the events of 8.1 carry the stable operation, decision,
task subject, actor, semantic family, resource constraint, sources shown, and
verified resolver identity. They exist for the report, the Permissions list,
and reconstruction of a session without joining unrelated stores. The log does
not replace enforcement; grant evaluation remains the security boundary. This
is a trusted family/team deployment and the log is not a tamper-evident chain.

Required product metrics:

- foreground interruptions per chat;
- decisions per chat;
- prompts per semantic family/resource;
- repeated decisions by reason code;
- identical-visible-card repeats;
- fallback routes taken;
- denial, dismissal, cancellation, and later-approval rates;
- time blocked on a pending decision;
- composed facet count per decision;
- grants issued but never used.

The invariant is zero identical visible prompts within one chat unless the
card explicitly names the changed security fact.

## 10. Verification plan

### 10.1 Session regression fixture

Turn the audited Trello session into a deterministic authority-level fixture:

1. create a worker and panel;
2. build and run the panel;
3. access Task Board Storage;
4. inspect the panel;
5. continue through a second chat turn;
6. read from an existing Trello panel;
7. import into Task Board Storage;
8. reload the task-board panel.

Expected target interaction sequence when the agent preflights its plan:

1. model credential decision, only if no applicable standing version grant;
2. one code-review/task-permissions transaction for the build;
3. one `new_source` delta for the follow-up Trello import, naming the Trello
   source and listing the storage/inspection/supervision rules it extends.

Expected sequence when the agent does not preflight and each rule is met at
first use:

1. model credential decision, as above;
2. install review for the worker and panel;
3. Task Board Storage, first use;
4. manage runtime state, first use;
5. inspect panels, first use;
6. one `new_source` delta for the Trello import covering the chat's rules;
7. supervise the task-board panel, first use, under the already consented
   Trello source.

There are no critical effects in this fixture. Both sequences are exit
criteria: at most three decisions with preflight, at most seven without, down
from ten, without omitting any enforcement leaf and with no two cards that
read alike.

### 10.2 Authority invariants

- A task rule survives model retries, eval calls, and multiple trajectory turns
  inside the same chat, and ends with the chat's reset or close.
- A separate chat receives a distinct task subject.
- No rule carries a wall-clock expiry.
- A new outside source produces one delta card per chat, not one per rule.
- A new source, resource, actor, prepared effect, or risk cannot reuse an
  incompatible grant.
- A source delta prompts exactly once and names the added source.
- Workspace-service envelope and provider leaves are settled by one decision and
  evaluated independently.
- Install review mints only the selected exact-version facets.
- Critical effects always require an exact once-only confirmation.
- Revocation prevents the next use and resolves parked operations predictably.

### 10.3 Queue and presenter invariants

- Concurrent identical security identities join one durable acquisition.
- Presentation-only differences do not split consent.
- Security-identity differences never coalesce merely because copy or resource
  labels match.
- Desktop, mobile, push, terminal, bootstrap, and attached-host delivery share
  one decision ID and settle once.
- Repeated progress events update one transcript/card entry.
- After a restart the rerun eval finds a decided request by digest and does
  not prompt again; an undecided request asks once more, never twice.

### 10.4 Catalog invariants

- Every gated or critical host method maps to exactly one semantic family.
- Every family has reviewed copy, resource rendering, notability, risk, batching,
  and standing-grant policy.
- No legacy alias remains accepted after cutover.
- Interaction kinds classified as workflows cannot issue authority grants.
- The documented and runtime approval-kind unions are identical.

## 11. Implementation order and change boundaries

Steps land in the order of §8 because each is measured by the report the
previous one produced:

```text
fixture and report
  -> chat-bound task rule, reset control
  -> one rules card (source delta, agent preflight)
  -> compose facets that arrive together
  -> install review carries planned rules
  -> one family per leaf at the copy layer
  -> chip and interrupt budget
  -> repeat the accounting
```

Each step is a coherent code-and-test change, not a runtime feature flag. If a
step fails, revert that step. Do not retain both old and new acquisition paths
or add a fallback prompt. Development approval state is wiped at 8.2, which is
already the pre-release pattern, so no migration code is written.

## 12. Definition of done

The refactor is complete when:

1. `Allow for this task` refers to the chat named on the card, ends with that
   chat's reset or close, and is the only mid-tier answer.
2. One prepared operation creates at most one ordinary decision, regardless of
   how many internal authority leaves enforce it, and no route in the report
   falls back to independent acquisition.
3. A new outside source produces one card per chat that names the source and
   lists the rules it extends.
4. Agent preflight and unit install settle in one visible transaction with
   distinct subjects.
5. Each decision appears once in Permissions; a credential card may still
   accompany a network card for one request.
6. Every promptable leaf belongs to one family, and one capability string per
   family is emitted.
7. At most one ordinary card interrupts; parked asks are visible in the chip and
   the agent regains control immediately.
8. Protected input and sign-in workflows are not presented or measured as
   approval decisions.
9. The Trello fixture requires at most three decisions with preflight and
   seven without, with no identical visible card and every enforcement leaf of
   the original ten preserved.
10. The envelope tables, the `session` decision, `trajectoryTurnTaskRef`, and
    the `userland` approval contract are gone.

## 13. Forensic hand-off

This section records enough evidence to reproduce the audit without access to
the original conversation.

### 13.1 Session identity

```text
workspace: dev-02a05dad
channel/session: chat-940a1e6a
context: ctx-7e102ce8521cd2833093c90d5d440378
agent: do:workers/agent-worker:AiChatWorker:ai-chat-f03f-a46115cc
runtime requester: do:vibestudio/internal:EvalDO:6c07a8e41643708a397774aeabf409ee7d8b1aca
title: Trello-style task board
initial request time: 2026-09-03T06:40:18.957Z
trajectory turns: 2
```

Initial request:

> Build me a slick Trello-style task management app, with per-card comments,
> checklists and markdown support throughout.

The trajectory contained 439 events: 111 invocation starts, 107 completions,
four failures, 49 progress events, and two turns. Its action sequence was
coherent: inspect skills and workspace state, scaffold a worker and panel,
build/test, inspect and repair the panel, then use an existing Trello browser
panel as outside input, normalize/import its data, reload the task-board panel,
and disconnect the browser session.

### 13.2 Evidence locations at audit time

The inspected source-instance state root was:

```text
/home/werg/.config/vibestudio/instance-state/e45ec82112f0e5c9/source
```

Relevant evidence under that root:

```text
governance/governance.db
workspaces/dev-02a05dad/state/authority/grants.db
workspaces/dev-02a05dad/state/governance/content-trust.db
workspaces/dev-02a05dad/state/logs/server-log.jsonl
workspaces/dev-02a05dad/state/blobs/sha256/
```

The workspace trajectory projection was the universal-DO database whose file
name ended in:

```text
a78b455614954e9ae8fb6c694321658503caf6a0a1d7156a8054c2b00957577b.1.sqlite
```

The main chat-worker database ended in:

```text
e5b7a6d7058c540cbebe6d6038cbc157ee085f8418ac9376bcbec7c0f4ba3d20.1.sqlite
```

These are development-instance paths, not product-stable identifiers. A future
regression fixture must copy the semantic event sequence into test-owned data
rather than depend on these files remaining present.

The trajectory projection's `trajectory_approvals` table was empty. The
decision history had to be reconstructed from the host governance records plus
`invocation.progress` authority-pending/decision payloads and their referenced
blobs. Step 8.1 must eliminate this multi-store forensic join.

### 13.3 Exact attribution boundary

Governance records after the session began included unrelated activity from
other concurrent chats. The audit attributed a decision only when the caller,
workspace, session/task subject, and causal invocation matched this chat.

Two nearby records were deliberately excluded:

- a browser-data version grant around 08:44, requested by
  `@workspace-extensions/browser-data` for a different browser-migration flow;
- a runtime-state task grant around 08:48, requested by another EvalDO for an
  imported-Firefox collection context.

The session's event stream included a `context.boundary` progress gate during
the Trello-panel access. It did not correspond to an additional independently
resolved governance decision. Likewise, the `workspace-main-advance` progress
gate was satisfied as part of the workspace-part install interaction. Counting
progress events as clicks would overstate the user decisions.

### 13.4 Prompt and grant accounting

The eight runtime decisions were:

| Semantic pair | User prompts | Why repeated |
|---|---:|---|
| Task Board Storage + its exact workspace-service resource | 4 | `none`/`external` influence split inside each of two turn-scoped tasks |
| Panel inspection + selected panel resource | 2 | one for each turn-derived task subject |
| Workspace runtime-state management | 1 | first use in the first turn |
| Runtime supervision of the task-board panel | 1 | new effect in the second turn |

This yields four repeated prompts relative to one visible prompt per semantic
capability/resource pair. It does not mean all eight runtime decisions were
unnecessary. Storage under a new influence set and supervision of a new runtime
effect are real authority distinctions. The intended reduction comes from a
stable task, operation composition, and explicit deltas—not from deleting those
checks.

The two turns produced different opaque task subjects. Within each turn, the
two storage grants differed in `lineage_at_consent`:

```text
["none"]
["external"]
```

The content-trust projection attributed the external closure through panel/CDP
history and included the Trello web source among the influences. Because this
source fact was absent from the visible repeated storage card, the second
decision taught the user that apparently identical prompts are meaningless.

## 14. Current implementation map

The following map is the starting point for implementation. Line numbers are
audit-time hints; names and responsibilities are controlling.

| Concern | Current implementation | Preserve / replace |
|---|---|---|
| Generated host-method policy | `packages/shared/src/authority/hostAuthorityCatalog.generated.ts` | Preserve as enforcement/audit input |
| Semantic approval copy | `packages/shared/src/hostApprovalCopy.ts` | Evolve into the exhaustive semantic-family mapping; stored identities untouched |
| Capability notability | `packages/shared/src/authority/capabilityNotability.ts` | Preserve fail-closed coverage; move classification onto canonical families |
| Prompt registry | `packages/shared/src/authority/promptRegistry.ts` | Expand to all actual interaction classes; remove spec/runtime drift |
| Pending interaction types | `packages/shared/src/approvals.ts` | Keep typed payloads, separate decisions from workflows |
| Service preflight/composition | `packages/shared/src/serviceDispatcher.ts` | Preserve `authorityFacets`/`acquireMany`; make operation composition mandatory |
| Acquisition and scopes | `src/server/services/acquisitionCoordinator.ts` | Rebase on the chat-bound task subject; drop the `session` decision; add the rules card; restore interrupt budget |
| Queue and exact settlement | `src/server/services/approvalQueue.ts` | Preserve as is; copy becomes a pure function of its security fields |
| Canonical capability grants | `src/server/services/capabilityGrantStore.ts` | Become the one human-authority lifecycle |
| Task subject derivation | `src/server/workspaceSourceProvider.ts`, `src/server/services/taskAuthorityRegistry.ts`, `src/server/index.ts` | Replace turn coordinate with the agent binding's chat; liveness from channel state |
| Execution-session subject | `src/server/services/agentExecutionSessionRegistry.ts` (`authoritySessionId`), coordinator `session` decision | Delete as a user choice; keep the id for execution admission only |
| Preauthorization envelopes | `capabilityGrantStore.ts` (`preauth_envelopes`, `envelope_rules`) | Delete; the `task.rules` card issues ordinary chat rules |
| Install clearance | `src/server/services/unitClearanceGrants.ts`, `unitInstallAcceptance.ts` | Preserve; already mints selected exact-version rows |
| Credential grants | `src/server/services/credentialUseGrantStore.ts`, `credentialSessionGrants.ts` | Compose into one card first; unify storage only if composition leaves a visible defect |
| Credential prompts | `src/server/services/credentialService.ts`, `egressProxy.ts` | Join credential and network facets into one prepared operation |
| Browser site grants | `src/server/services/browserPermissionsService.ts` | Project canonical decisions; remove panel ID from consent identity unless made an explicit boundary |
| Workspace-service enforcement | `src/server/rpcServer.ts`, `src/server/buildV2/authorityFold.ts` | Preserve envelope and leaf enforcement; compose acquisition only |
| Unit admission/review | `src/server/unitInstallReviewCoordinator.ts`, `packages/unit-host/src/index.ts` | Make admission plus selected clearance one atomic transaction |
| Governance types | `packages/shared/src/governance/types.ts` | Extend from resolution provenance to the full operation/grant lifecycle |
| Desktop attention | `src/main/approvalAttention.ts`, `src/main/serverEventBridge.ts` | Presenter for the canonical decision ID |
| Mobile/push | `packages/shared/src/approvalContract.ts`, `src/server/services/approvalPushBridge.ts` | Presenter/fan-out only |
| Bootstrap/terminal | `packages/shared/src/bootstrapLaunchGate.ts`, `src/bootstrap/index.ts`, `src/cli/terminalLaunchGate.ts` | Preserve distinct launch question; use shared decision identity |
| Attached host | `src/server/services/attachedHostApprovalPresenter.ts` | Preserve signed evidence, eliminate duplicate-looking local decision |

### 14.1 Existing mechanisms worth keeping

The refactor is not a rewrite of the evaluator. Several current mechanisms are
already the right foundation:

- `PendingCapabilityApproval.authorityFacets` can represent multiple enforced
  leaves under one card.
- `serviceDispatcher.acquireMany` can preflight and acquire those leaves
  together.
- Queue exact dedup includes the facts necessary to avoid authorizing a changed
  operation.
- Critical effects are already constrained to once-only decisions.
- Once grants have atomic consumption.
- Dismissal already has a bounded ten-minute cooldown and 24-hour fatigue
  memory.
- Grant records support consumption, expiry, suspension, restoration, and
  revocation.
- Unit install review can carry server-derived permission rows and typed partial
  acceptance.
- Presenter fan-out already converges on common queue contracts in much of the
  shell/mobile path.

The work makes these mechanisms share honest identity and lifecycle; it should
not replace them with a second orchestration layer.

### 14.2 Current persistence topology

At audit time, authority-related state was split as follows:

| State | Store/lifetime | Consequence |
|---|---|---|
| Pending approval queue | in-memory `ApprovalQueue` | restart loses unresolved presentation/rendezvous state |
| Acquisition rendezvous/fatigue memory | in-memory coordinator state | not a durable parent for issued authority |
| Capability grants | SQLite `CapabilityGrantStore` | durable, supports scoped lifecycle operations |
| Credential-use grants | separate JSON `CredentialUseGrantStore` | separate subject/scope semantics and revocation path |
| Credential session grants | ephemeral `CredentialSessionGrants` | third credential authority interpretation |
| Browser site decisions | separate browser grant store/projector | different scope vocabulary and dedup identity |
| Unit admission/identity | exact-version admission/approval state | code identity is durable but not one lifecycle with runtime grants |
| Governance | append-style resolution provenance | records queue settlement but not every grant use/effect |

This topology explains why one logical effect can be approved through more than
one subsystem and why a complete audit currently requires correlation rather
than following one operation record. The target does not require secrets,
browser OS state, and code admission to share physical tables. It requires one
authoritative human-decision and grant lifecycle, with specialized stores acting
only as custody or enforcement projections.

### 14.3 Current scope vocabulary

Internal decision outcomes include `once`, `session`, `task`, `mission`,
`agent`, `version`, `lock`, `deny`, and `dismiss`; browser permissions separately
use `once`, `session`, `always`, `block`, and `dismiss`.

This vocabulary is useful to policy and storage but too large for routine
cards. The target interaction model intentionally exposes only the choices a
person can distinguish in context. Advanced standing scopes belong in Details
or the Permissions manager, and equivalent concepts across capability,
credential, and site decisions must have one lifecycle meaning.

### 14.4 Prompt-registry drift

The prompt registry currently implements only a small subset of the card types
described by `approval-prompt-ux-spec.md`, while runtime queue kinds and legacy
tests describe additional interactions. Before surface work begins, generate a
three-way invariant over:

```text
runtime interaction union
prompt registry
documented interaction inventory
```

The build fails if an interaction exists in only one or two of those sources.

## 15. Reasoning and rejected designs

### 15.1 Do not coalesce by visible title or capability name

The two storage cards had the same visible title but different influence sets.
Merging on title, resource label, or capability alone would let consent given
before outside input authorize an effect influenced by that input. Coalescing
must use authenticated security identity; presentation grouping is separate.

### 15.2 Do not remove the workspace-service envelope or provider leaf

The envelope answers whether the caller may use the selected service. The leaf
answers whether the receiver permits the exact method/effect. They protect
different boundaries. The correct change is one acquisition transaction that
mints and audits both leaves, not one leaf standing in for the other.

### 15.3 Do not equate installation with blanket runtime authority

Admitting code says this exact code may exist and run. It does not mean every
declared capability is safe in every context. Install review may issue only the
ordinary, exact-version clearance rows it displayed and the person selected.
Contextual, headline, unknown, critical, or newly influenced operations retain
their own policy.

### 15.4 Do not make the person manage a task lifecycle

The first draft proposed an explicit task entity with create, complete, and
abandon events. Rejected: it is a second lifecycle for the person to learn and
a new API for the agent to get wrong. A task nobody closes leaks authority
silently; a task closed too early re-prompts for work the person already
allowed. The chat is the entity people already create, name, and end, and the
UX and acquisition specs already define the task rule as the chat session.

The drift concern is real and is answered by the rule shape rather than by a
shorter lifetime: rules are capability + resource scoped, a new outside source
requires an explicit delta (A10), critical effects never reuse, the chat header
lists what the chat may do with reset, and a person who wants a tighter
boundary starts a new chat. What the draft called "conversation adjacency"
is, from the person's side, the only boundary they can see.

### 15.5 Do not ignore influence changes

Outside content can affect an agent's action. Removing `lineage_at_consent` from
the security identity would trade fatigue for confused-deputy exposure. The
first decision should close over already known/inevitable sources; genuinely new
sources produce an intelligible delta.

### 15.6 Do not solve fatigue with a global cooldown

A cooldown suppresses attention but cannot authorize an operation. It either
leaves work mysteriously parked or encourages unsafe automatic reuse. The
solution is preauthorization for a stable task, composition for one prepared
operation, and queueing of unrelated questions. Cooldown remains useful only
after dismissal.

### 15.7 Do not use the install review as a bag for agent debugging powers

The installed unit's version clearance and the agent's task authority have
different subjects. They may share one visible transaction when both are known,
but the review result must issue separately constrained rows. The installed
panel does not inherit the agent's panel-inspection permission, and the agent
does not inherit the panel's version clearance.

### 15.8 Do not preserve legacy stores behind adapters

Dual reads, compatibility aliases, and fallback prompt paths make authority
depend on which subsystem happened to answer first. This repository is
pre-release: cut over development state, delete the old writers/readers, and
reacquire permission under the canonical model.

### 15.9 Do not count every queue item as an approval

A secret-entry form or OAuth device-code status is not a security decision.
Presenting every rendezvous item with approval styling trains users to treat
warnings as generic progress dialogs and corrupts fatigue metrics.

### 15.10 Do not add a mechanism where a card over existing rules suffices

Three draft items (task-level source consent, preauthorization envelopes, a
persisted operation) each introduced a new record type with its own lifecycle.
Each turned out to be a card that lists several existing rules and settles
them under one decision, which `acquireMany` already does. New record types
are where authority bugs live; a card over existing rows is reviewed by the
same evaluator that reviews single rules.

## 16. Security review checklist

Every phase must answer these questions before landing:

1. Which authenticated principal receives each resulting grant?
2. What exact effect and resource boundary does it cover?
3. Which source/influence set did the person see when deciding?
4. Can a retry, nested call, presenter, or restart widen the grant?
5. Can presentation grouping cause two different security identities to settle
   together?
6. Can one low-level facet be omitted while the composed card still claims the
   whole operation is allowed?
7. Does denial, dismissal, cancellation, expiry, or revocation leave the effect
   parked, failed, or retriable in a deterministic state?
8. Are critical and irreversible effects excluded from reusable grants and
   ordinary batches?
9. Does the audit connect the decision to every issuance, use, effect outcome,
   and revocation?
10. Has the old path been deleted rather than retained as a fallback?

Security-sensitive regression cases include:

- same visible action, newly external influence;
- same capability, different resource;
- same resource, different actor;
- same actor/resource, changed prepared effect;
- two panels at the same site versus two intentionally isolated panel
  principals;
- network request with and without a credential binding;
- install review accepted with one permission row deselected;
- operation approved on mobile while desktop is disconnected/reconnecting;
- revocation while nested callers are waiting;
- restart between decision settlement and effect execution;
- concurrent critical and ordinary acquisitions;
- a source set that grows after an operation was prepared.

## 17. Implementation hand-off checklist

The first implementing engineer should proceed in the order of §8:

1. Re-run the generated host catalog and ledger checks and record fresh counts;
   count drift is expected, missing semantic coverage is not.
2. Preserve the Trello forensic data as a sanitized deterministic fixture before
   the development instance is cleaned up. Reproduce the ten-decision baseline
   and four indistinguishable repeats with the report.
3. Confirm where the shell can host the chat header list and reset control,
   and how the execution session exposes its channel binding to
   `taskAuthorityPrincipal`.
4. Land 8.2 with its five tests. Wipe development grant state.
5. Land 8.3. Reset development authority state at the grant-schema cutover;
   there is no backward-compatible grant migration. Make the exact-source
   lineage class explicit at the use-time gate as specified by A10.
6. Convert the routes the fallback metric reports, then delete the fallback
   branches (8.4).
7. Land 8.5, 8.6, 8.7 in order, each behind its own exit criterion.
8. Repeat the §13 accounting against the fixture.

The likely focused conventional suites are:

```text
src/server/services/approvalQueue.test.ts
src/server/services/acquisitionCoordinator.test.ts
src/server/services/capabilityGrantStore.authority.test.ts
src/server/services/browserPermissionsService.test.ts
src/server/services/credentialUseGrantStore.test.ts
src/server/services/approvalPushBridge.test.ts
src/server/unitInstallReviewCoordinator.test.ts
packages/shared/src/approvalCopy.test.ts
packages/shared/src/authority/promptRegistry.test.ts
packages/shared/src/authority/hostMethodCapabilities.test.ts
packages/shared/src/authority/capabilityNotability.test.ts
packages/shared/src/authority/unitInstallReview.test.ts
packages/shared/src/bootstrapLaunchGate.test.ts
```

Before declaring completion, repeat the forensic accounting from §13 against the
new fixture. The expected result is at most three user decisions, no identical
visible repeat, the same or stricter enforced leaf set, and one auditable causal
chain per operation.

## 18. Implementation record

The straightforward cutover has landed across the host checkout and the
configured Base checkout. This section is the implementation hand-off; it is
deliberately explicit about what is code-complete and what is not.

### 18.1 Landed

- Task authority is now the workspace-qualified `contextId` + `channelId`
  binding. `ownerUser` and the trajectory-turn coordinate are absent from the
  subject. Nested runtimes inherit the host-attested binding, and a forged
  causal channel is rejected.
- Ordinary capability cards no longer offer the execution-session `session`
  decision. Task copy says that the grant lasts in the chat until its
  permissions are reset. Credential and browser session scopes retain their
  separate truthful meanings.
- The chat header lists its active task rules and exposes a typed reset action.
  Reset revokes every task subject stamped with that channel, so all agent
  bindings in the visible chat are reset together while grants in other chats
  remain intact.
- `task.rules` is a registered typed card. Planned preflight requests are
  presented once, individual rows can be deselected, and the server rejects a
  selected key it did not offer. The client returns only selected keys and
  resets local selection when the queue advances.
- A newly influential exact source produces one source-delta rules card for all
  live rules in the chat. The triggering rule and everyday rules default on;
  headline rules default off. Only selected rules are reissued, atomically,
  with the extended exact-source lineage.
- The unused preauthorization envelope schema and API are deleted. Schema v7
  is created fresh after development authority state is reset; no compatibility
  migration, reader, or alias remains.
- Both dispatcher fallbacks from composed acquisition to independent prompts
  are deleted. An uncomposable route now emits its route and leaves and fails
  with `EAUTHORITYCOMPOSITION` instead of splitting one operation into several
  prompts.
- Browser-site deduplication no longer treats `panelId` as a consent principal.
- Only one ordinary acquisition requests foreground attention at a time;
  later ordinary requests remain visible in the queue/chip. Critical requests
  retain independent interrupt policy.
- Runtime aliases for external opening, response reads, publication, history
  writing, unit publication, and Git remote management are canonicalized at
  emission. Static native-app capability `open-external` remains an admission
  input, as specified in §3.2, rather than a runtime alias. The generated host
  catalog and runtime-foundation checks accept the canonical vocabulary.
- A deterministic fatigue report fixture records operation, task, security,
  decision, family, resource, source, repeat reason, and fallback fields. It
  reproduces the audited 10/4 baseline and asserts the 3-with-preflight and
  7-without-preflight budgets.

### 18.2 Verification evidence

The implementation passed:

- host and workerd TypeScript checks;
- Base and Base-integration TypeScript checks through the semantic dependency
  projection;
- generated host-authority, built-in catalog, host-residency, and
  runtime-foundation ledger checks;
- 298 focused host RPC/task-binding tests;
- 281 focused acquisition, queue, grant-schema, copy, catalog, and publication
  tests;
- 60 focused Base approval-card, chat-header, and protocol tests, followed by
  the approval-card regression suite after its final selection/keyboard fix.
- 70 focused host task-policy, workspace-alarm, acquisition, and chat-rule
  tests after adding task-scoped system-test authority; 17 deterministic
  system-test validator cases; and host plus Base semantic type checks.
- Agentic system run `chat-task-permission-reuse` passed with two natural
  permission reads in one headless conversation. Independent harness snapshots
  after each turn observed exactly one `permissions.read` task rule with the
  same grant id (`st_c280c536edb54439a6456cad17316468`).

### 18.2.1 Reviewer feedback validation

- Confirmed and fixed: a source-delta card could omit a first-use current ask,
  then translate acceptance into `deny`. The current ask is now a selectable,
  default-on prospective row when no matching rule exists. A deterministic
  test awaits the real outcome and requires `decision: task`.
- Confirmed, then superseded by product policy: the first schema-v7 migration
  was unsafe against the released v6 shapes. Backward compatibility is not a
  requirement, so the migration and its compatibility tests were removed.
  Existing development grant stores are reset and v7 is created directly.
- Not current: the Base shell already renders `task.rules`, maintains row
  selection, and calls `resolveTaskRules`; the focused 60-test Base suite covers
  acceptance, dismissal/denial, and queue advancement.
- Accepted design change: exact `source:<key>` lineage is part of the use-time
  evaluator. This is required to distinguish a newly influential website or
  channel inside one broad risk class and matches source-scoped consent.
- Causal mission/automation check: `automation-scheduled-notification` produced
  two successful mission runs and two successful causal `notify` invocations
  without a binding denial. Its overall validator still failed because the
  durable user-notification query returned zero after those two channel
  deliveries (`st_ac05fc2d68f943839d873b951c06736e`); that is a separate
  harness/accounting mismatch. `automation-native-launch` also reached a
  successful mission launch; its later correction attempt failed because the
  worker had not declared `missions.retire`, not because of causal binding
  (`st_1068813cd32c4d529ad9018aa579a867`).

### 18.3 Remaining architecture boundary

The install-review/preflight merge in §8.5 is not implemented. The current unit
reconciliation path is system-originated: `UnitHost` and
`UnitInstallReviewCoordinator` receive the changed units, batch key, target,
and origins, but no initiating chat subject, preflight identity, or operation
identity. The authority preflight path has the chat subject and authority-plan
digest, but none of those values is causally shared with reconciliation.

Consequently, “pending together” is only temporal proximity in the current
model. Joining on time, repository, target, or the nearest pending card would
allow one chat's planned authority to be issued by an unrelated installation
review. No such heuristic join or parallel settlement path was added. The
three-decision fixture remains the target accounting, not a claim that the
install-review transaction currently carries the task-rule rows.

### 18.4 Other incomplete exit criteria

- The report in §18.1 is a deterministic diagnostic module and fixture, not yet
  a projection of production acquisition/governance events. Current dispatcher
  observations carry acquisition and task facts, while queue governance owns
  the human decision ID; there is no canonical join between those owners.
- Duplicate per-leaf progress observations have not been collapsed into a
  single operation/decision transcript event for the same reason.
- Ordinary cards do not yet include the human chat title in their task subline.
  Execution admission authenticates context and channel IDs but does not carry
  channel presentation metadata. The header itself supplies the visible chat
  boundary and reset control.
- The shell has no root-chat close/archive action to hook. Fork archival and
  panel archival are different lifecycles and therefore were not made to revoke
  root-chat authority.

These are open definition-of-done items. They are recorded here so the landed
security cutover is not mistaken for completion of the entire plan.

### 18.5 Comprehensive follow-up (2026-09-03)

The subsequent implementation closed the locally actionable items from §18.4
without adding a correlation table or a second authority path:

- Every acquisition-owned queue entry now carries its canonical acquisition
  ID, authenticated task subject, consent-equivalence identity, prompt family,
  exact outside-source set, and repeat reason. Approval settlement writes those
  facts together with the approval ID and the exact visible title,
  description, and rows into the same durable governance record.
  `approvalSurfaceRecordsFromGovernance` therefore builds the production
  fatigue input directly; it does not join dispatcher observations to queue
  decisions by time or content.
- In-band acquisition now emits one requested observation and one terminal
  decision observation. The post-grant re-evaluation no longer emits a second
  `granted` event, and a composed operation no longer emits one pair per leaf.
  Leaf detail remains on the one approval surface and its governance snapshot.
- The chat panel registers its current human title against the
  workspace-qualified task subject. The title is presentation metadata only:
  it is explicitly excluded from the task-principal hash. Ordinary task
  decisions can now say `Covers this action in “{chat title}” until you reset
  this chat's permissions.`
- A person-addressed `notify` can no longer be downgraded to `alert: none`.
  Human addressees have an inbox floor; channel-only messages remain available
  by addressing the channel. This made the scheduled-automation check observe
  the two promised durable inbox records rather than merely two successful
  channel sends.
- The agent worker's sealed authority manifest now declares the receiver-owned
  `missions.edit`, `missions.run`, and critical `missions.retire` leaves in
  addition to the missions service envelope. Native automation control no
  longer reaches a capability the installed code omitted from review.

Fresh managed system-test evidence from the post-change checkout:

- `automation-native-launch`: pass, no tool failures
  (`st_ad3251e362df4a44b4af1639b6c04acc`).
- `automation-scheduled-notification`: pass; two distinct durable
  notifications independently observed (`st_0952483d6e074e3c8f56fec8458404c0`).
- `chat-task-permission-reuse`: pass; first-use approval, follow-up reuse, and
  new-chat isolation (`st_6908808db111437e856b719a6bcc0113`).

Two boundaries remain deliberately unimplemented because the required causal
lifecycle does not exist yet:

1. A system-originated unit reconciliation has no initiating chat subject or
   preflight operation token. Only an install review produced inside the same
   acquisition already shares an operation ID. Merging a separate chat
   preflight into reconciliation would still be a temporal/proximity join and
   could mint one chat's rules from another operation. The next implementation
   must introduce one explicit producer-owned operation token carried through
   both preflight and publication; until then the two decisions remain separate.
2. Vibestudio archives panel slots and fork projections, but it has no durable
   root-conversation close/archive event. Closing a panel is not ending a chat:
   another panel may show the same channel. Reusing panel archive as the task
   lifecycle would revoke live authority unexpectedly. The existing explicit
   Reset control remains correct; automatic revocation requires a canonical
   root-channel lifecycle owner before it can be wired.

These are missing domain primitives, not UI omissions. No flag, heuristic
association, panel-unmount cleanup, or alias endpoint was added around them.
