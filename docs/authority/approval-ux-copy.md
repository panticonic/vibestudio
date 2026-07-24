# Approval & Permissions UX Copy

Status: specification (companion to
[../agentic-authority-negotiation-plan.md](../agentic-authority-negotiation-plan.md))

Date: 2026-07-24

This document is the reviewed string inventory for every user-facing authority
surface: just-in-time approval cards, critical confirmations, waiting and
denial states, install review, the Permissions/profile pages, and mission
surfaces (mission copy details in
[mission-governance-ux.md](mission-governance-ux.md)). Strings here are
normative: implementations render these templates; changes go through copy
review.

Placeholders: `{agent}` verified agent display name · `{action}` capability
action copy · `{resource}` reviewed resource phrase · `{domain}` domain label
· `{task}` short task description · `{unit}` unit display name.

## 1. Voice and tone rules

1. **Lead with the decision, in one sentence a non-technical person can
   answer.** The title is always a yes/no question about a concrete action on
   a concrete thing.
2. **Verbs over nouns.** "publish this briefing to…" not "Publish
   capability". Never noun-ify a permission in primary copy.
3. **Banned from primary copy**: eval, principal, capability, tier, session,
   manifest, RPC, DO, digest, attestation, scope, grant (as a noun), origin,
   receiver. These may appear only inside the expandable technical section.
4. **The system speaks; the agent is quoted.** Verified facts (identity,
   action, resource, lineage) render in the system voice. Any agent-supplied
   explanation renders visually quoted/framed and labeled as the agent's own
   words. The two must never blend.
5. **No blame, no alarm theater.** Denials and locks are stated neutrally.
   Reserve warning styling for irreversibility and outside-content lineage —
   the two flags users genuinely need.
6. **Sentence case everywhere; no exclamation marks; buttons are 1–4 words.**

## 2. Copy validation rules (enforced, not aspirational)

Extend the existing prompt-copy audit:

- action copy must start with a lowercase verb and contain no banned terms;
- resource phrases must come from receiver resource presentation, length-bound,
  control-character-stripped; raw ids fail the audit;
- workspace-service-declared copy renders only inside the framed userland
  area; host chrome strings never interpolate declared text;
- every gated/critical capability has card copy; every domain/verb has labels;
  a missing string fails the ledger audit (same mechanism as
  `HOST_CAPABILITY_PRESENTATIONS` exhaustiveness).

## 3. The just-in-time approval card (gated tier)

### 3.1 Anatomy

```
┌──────────────────────────────────────────────────┐
│ {domain chip}                        {agent icon}│
│ Allow {agent} to {action} {resource}?            │   ← title (question)
│                                                  │
│ While working on: {task}                         │   ← context line
│ [⚠ Uses content from outside your workspace]     │   ← lineage flag (when tainted)
│ [⚠ This can't be undone]                         │   ← irreversibility flag
│                                                  │
│ ┌ What exactly ─────────────────────────────┐    │   ← substance section
│ │ {host-verified operation substance}       │    │     (required for sharing/
│ └───────────────────────────────────────────┘    │      destructive ops)
│                                                  │
│ ❝ {agent's own reason, if provided} ❞            │   ← framed, untrusted
│                                                  │
│ [ Allow once ]  [ Allow for this task ]          │   ← primary choices
│ [ Always for {agent} (this {resource-kind}) ]    │   ← only when eligible
│ [ Don't allow ]                        ⋯ more    │
│                                                  │
│ ▸ Details                                        │   ← technical disclosure
└──────────────────────────────────────────────────┘
```

### 3.2 Strings

- **Title**: `Allow {agent} to {action} {resource}?`
  - e.g. *Allow News to publish this briefing to `panticonic/briefings`?*
  - e.g. *Allow Gmail Agent to use your Google sign-in?*
- **Context line**: `While working on: {task}` · unattended:
  `From the mission: {mission title}`
- **Lineage flag**: `Uses content from outside your workspace` with
  disclosure: `Part of this request came from {source kind — e.g. "a
  website" / "an email"}. Be extra careful with requests you didn't start.`
- **Irreversibility flag**: `This can't be undone` — and irreversible
  effects never show `Always` or mission-standing coverage; every
  occurrence asks ([agent-authority-profile.md](agent-authority-profile.md)
  §3).
- **Substance section** (`What exactly`): a host-verified, receiver-declared
  rendering of the operation's substance, derived from the prepared state
  and exact arguments — never from agent text. Examples: publish → change
  summary (`3 files changed · adds "briefing-jul-24.md"`, expandable diff);
  send → recipient and item count; delete → the named set being deleted
  (`2 saved passwords for github.com`). **Required** for `sharing`-domain
  and destructive operations; receivers for those declare a substance
  presentation or fail the ledger audit. Optional elsewhere. Approving
  binds the decision to the shown substance's digest — if the prepared
  state changes, the approval does not carry over.
- **Buttons**:
  - `Allow once`
  - `Allow for this task`
  - `Always for {agent} (this {resource-kind})` — e.g. *Always for News
    (this repository)*. Appears only per eligibility rules
    ([agent-authority-profile.md](agent-authority-profile.md) §5.4). When
    the request carries a lineage class, the button states what it covers:
    `Always for {agent} (this {resource-kind}, including content from
    {source kind})` — a lineage-bearing standing grant is never created by
    a button that doesn't say so.
  - `Don't allow`
  - Overflow (⋯): `Don't allow and don't ask again` → confirm sheet:
    `Stop {agent} from ever {action-gerund}? It won't ask about this again.
    You can change this in Permissions.` `[ Never allow ]` `[ Cancel ]`
- **Post-"Always" toast**: `Saved. Change this anytime in Permissions.
  (Pauses by itself if unused for 3 months.)` (links to the profile row)
- **Details disclosure** (developer-truthful, users may ignore): exact
  capability id, resource key, requesting unit + version, task/mission id,
  lineage summary, decision-record link.

### 3.3 Mobile notification (4 KB budget)

- Title: `{agent} is asking`
- Body: `Allow {agent} to {action} {resource-short}?`
- Actions: `Allow once` · `Don't allow` · `Open` (full card in-app; `Always`
  and lock choices are in-app only — standing decisions require the full
  card).
- **Open-only rule**: requests that are lineage-tainted, irreversible, or
  critical expose only `Open` — the flags, substance section, and framed
  context these decisions depend on cannot ride a notification, so no
  inline action may resolve them. Body for these:
  `{agent} is asking to {action}. Review in the app.`
- **Redacted mode** (setting, default off): notification bodies omit
  resource names (`{agent} is asking to publish`), for users who don't want
  repository/site/account names transiting push infrastructure
  (approvals.md documents the FCM/APNs path). Full detail always in-app.

## 4. Critical confirmation card

No persistence choices, ever. Distinct visual weight.

- Title: `Confirm: {action} {resource}?`
  - e.g. *Confirm: delete the workspace "Old prototypes"?*
- Body: `{agent} wants to do this now, as part of {task}. Check the details —
  this happens immediately.` plus irreversibility flag when applicable.
- Buttons: `Confirm` / `Cancel` (both explicit; no default focus on
  Confirm; not confirmable from a lock-screen notification — `Open` only).
- Repeat attempts do not batch: every critical action is its own card.

## 5. Waiting, resolution, and interruption states

- Agent chat / tool line while pending: `Waiting for your approval` (+ card
  deep-link chip). Never an error style, never a countdown.
- Panel non-error banner: `{agent} is waiting for your approval to continue.`
- After approval: agent line `Approved — continuing.`
- After denial: agent line `Not allowed — skipping this step.`
- Unattended mission run status: `Waiting for approval` (see mission doc).
- Host restart during wait: `This run was interrupted before it finished.
  The step waiting for your approval didn't happen.` `[ Run again ]` —
  never "resuming where it left off", and never a claim that *nothing*
  happened when earlier steps of the run completed (the run view lists
  completed steps from the effect journal).
- Request outliving its run: when the task or eval that raised a request
  ends (cancelled, interrupted, completed another way), the pending card
  resolves to a quiet expired state: `This request expired because the task
  ended. Nothing was {action-past}.` A decision that races the ending is
  recorded but drives nothing — the effect only ever executes through the
  live re-evaluation path.

## 6. Denial and lock feedback

- Card denial (once): system line in agent surface —
  `{agent} wasn't allowed to {action} {resource}.`
- Standing lock hit: `{agent} wasn't allowed to {action} — you've turned
  that off for this agent.` + link `Change in Permissions`.
- Agent-facing structured result (not user copy, but normative): kind
  `user-denied`, `standing: true|false`, human-readable reason mirroring the
  system line, instruction `Do not retry. Tell the user what you could not
  do.`
- Profile lock counter: `{n} attempts while locked · last {relative time}`.

## 7. Profile page copy

(Layout in [agent-authority-profile.md](agent-authority-profile.md) §4.)

- **Cell states**: `Asks first` · `Allowed: {n}` (expands) · `Never` ·
  `Not available` (🔒 with info: `Agents can never do this in Vibestudio.`)
- **Summary sentence grammar** (auto-generated, in this order):
  1. Standing sight/act allowances first: `{Agent} can {list of allowed
     things in plain phrases}.`
  2. Default: `It asks first for everything else.`
  3. Locks: `It can never {locked phrases}.`
  4. Constant closer for safety domain: `Like all agents, it can't change
     your safety controls.`
  - Example: *News can see the web and publish to `panticonic/briefings`. It
    asks first for everything else. It can never send notifications. Like
    all agents, it can't change your safety controls.*
- **Allowance line**: `{action} {resource} — always · added {date} · from
  {an approval you gave | Permissions} · [ Remove ]`
- **Suspended (idle) allowance**: `paused — not used for 3 months ·
  [ Restore ] [ Remove ]`; on next attempt the card shows the history line
  `You used to allow this.`
- **Reset controls**: `Make {agent} ask first for everything` (subtext:
  `Removes its standing permissions. Your "never" choices stay.`) ·
  `Remove all permission settings for {agent}`
- **Broader-scope editor** (profile page only, never on cards):
  `Allow {action} for {broader pattern — e.g. "any repository in this
  workspace"}` with subtext `This is broader than a single {resource-kind}.
  {Agent} won't ask before {action-gerund} anywhere it covers.`

## 8. Permissions top level

- Tabs/pivots: `By agent` · `By category` (domains) · `Recent decisions`
- Safety domain row (every agent): `Safety controls — Not available to
  agents` 🔒 · info sheet: `Approvals, permissions, and audit records can
  only be changed by you, here. No agent or app can ask for these.`
- Recent decisions entry: `{You allowed | You didn't allow} {agent} to
  {action} {resource} · {when} · {Once | For a task | Always | Never}`

## 9. Install review (fixed code + agents)

(Rendered as a `unit-version-review` diff of declared rows —
[authority-surfaces.md](authority-surfaces.md) §3. New rows carry `new`
badges; removed rows render struck through; tier changes are always shown.)

- Fixed-unit capability section header: `What {unit} can do` — grouped by
  domain chips, each entry `{action}` (+ resource envelope phrase when
  narrower than "anything").
- Agent-unit dynamic-code explanation (replaces ceiling lists):
  `{unit} is an agent: it can run new code for your tasks. When that code
  needs to do something — like publish, send, or sign in — Vibestudio asks
  you first, unless you've already allowed it. You can see and change what
  you've allowed anytime in Permissions.`
- No speculative future-capability list appears anywhere in review.

## 10. Developer-defect surfaces (never consent-styled)

Rendered as a distinct "needs a fix" presentation (neutral-technical, no
Allow/Deny buttons):

- Header: `{unit} hit a problem that needs a developer fix`
- Body (per failure kind):
  - receiver-rejected: `It tried to use "{method}", which isn't available to
    it.`
  - fixed-code-not-requested: `Its installed code tried something it didn't
    declare.`
  - invalid-session / invalid-attestation: `Its connection to this task
    couldn't be verified.`
- Footer: `This isn't something approval can fix.` + `Copy details for the
  developer` (full structured repair packet) · Developer mode may add
  `Propose a code change`.

## 11. Localization & review process

- All strings in this doc live in the host string catalog keyed by stable
  ids; the catalog audit fails on missing keys per locale.
- Copy changes require the same review as `hostCapabilityPresentations.ts`
  today; changes that soften warnings (lineage, irreversibility, lock
  confirmations) must be called out in review.
- Workspace-service-declared copy is validated per
  [domain-vocabulary.md](domain-vocabulary.md) §5.9 and approvals.md's
  existing subject/option rules (length, character class, no shell/system
  masquerade).
