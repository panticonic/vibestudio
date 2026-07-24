# Mission Governance UX

Status: specification (companion to
[../agentic-authority-negotiation-plan.md](../agentic-authority-negotiation-plan.md))

Date: 2026-07-24

Unattended agent work runs under a **mission**: a user-approved, content-
addressed charter. The registry mechanics exist
(`src/server/services/missionRegistry.ts`: drafts, approval, closure digests,
mission-subject grants, `startSession`); what does not exist is any human
surface. This document specifies that surface so that a non-technical user can
review, approve, supervise, revise, and retire missions — entirely in the
[domain vocabulary](domain-vocabulary.md), with hashes and harness identities
demoted to a technical disclosure.

Framing rule: **a mission review is a profile snapshot review.** The
permission section of a charter is a selection of
[authority-profile](agent-authority-profile.md) rows frozen by the closure
digest. The user never meets a second permission language for missions.

Mechanism rule: **a mission review is an approval-queue entry** — the
`mission-review` subject of
[authority-surfaces.md](authority-surfaces.md) §3, rendered by the shared
row/diff components. There is no separate mission-approval mechanism: the
registry's `approve`/`edit` RPCs are invoked only by the queue resolver, so
dedup, mobile fan-out, cancellation, provenance, and the decision record are
the same as every other approval in the product.

## 1. Surfaces

1. **Missions list** (the Missions section of the workspace catalog,
   [authority-surfaces.md](authority-surfaces.md) §4, also reachable from
   Permissions and the per-agent profile §4.1): every mission with state
   chip — `Running` · `Scheduled` · `Waiting for approval` · `Needs your
   review` · `Paused` · `Retired`.
2. **Mission item page**: the catalog item page (§4.2 there) — identity,
   snapshot rows live-diffed against the profile, pending reviews, run
   history, lifecycle controls.
3. **Mission review sheet**: approval of a draft or revision (§2) — a
   `mission-review` queue entry.
4. **Run status view**: per-run timeline (§4).
5. **Revision proposal card**: the out-of-charter flow (§3) — the same
   `mission-review` entry with a one-row diff.

## 2. The mission review sheet

Shown for a new draft or a proposed revision. Sections, in order:

### 2.1 What it will do

- Title: the mission's name, e.g. **Morning news briefing**.
- Plain-language task summary (from the charter's task spec, rendered as the
  charter author wrote it, in the framed untrusted style if agent-drafted,
  with the system label `Task description`).

### 2.2 When it runs

- `Every day at 7:00` / `When {event} happens` — from the trigger, in local
  time words. No cron strings in primary copy.

### 2.3 What it's allowed to do without asking

The heart of the review: profile rows the mission may use unattended,
grouped by domain chips, each line in card grammar:

- `Read the web (news sites)` — see
- `Publish a briefing to panticonic/briefings` — act
- Lines that create *new* standing allowances (not yet in the profile) carry
  a `new` badge; existing profile rows carry `already allowed`. (This is
  the shared `AuthorityRowDiff` of profile-vs-snapshot,
  [authority-surfaces.md](authority-surfaces.md) §2.3 — not a bespoke list.)
- Each `new` row has a checkbox (checked by default). Unchecking rows and
  approving ratifies a **narrower** closure: the charter is re-digested
  without those rows before the approval records. Users can trim a proposal
  without a round-trip through editing.

Below the list, three fixed system lines — the copy teaches both boundaries
(the toolkit and the allowances) instead of conflating them:

- `If it needs a new permission within its toolkit, it pauses and asks you.`
- `To do anything beyond its toolkit, it stops and proposes an update for
  your review.`
- `Actions that can't be undone always wait for you.` (Backed by the
  enforced invariant in
  [agent-authority-profile.md](agent-authority-profile.md) §3: irreversible
  effects are never covered by standing grants.)

### 2.3a Its toolkit and reach

Tool/service exposure and network policy are behavior-bearing and render in
the same vocabulary — they are capability sets, so they project through the
standard rows rather than hiding under technical details:

- `Uses: the web · your files · publishing` (domain chips derived from the
  charter's tool/service exposure; expandable to the exposed services'
  declared rows).
- `Can reach: {network policy in plain terms — e.g. "news sites you've
  listed" / "any website"}.` A broad policy renders with the same visual
  weight as a broad resource scope — never as fine print.
- `Works with content from: {declared data flow — e.g. "news websites"}.`
  The charter declares its expected lineage classes; standing mission
  grants cover **only those declared classes**. An operation influenced by
  an undeclared content source (an email steering a news mission's
  publish) is treated as in-toolkit-but-ungranted: it waits and asks with
  the taint explained, exactly like the interactive lineage rule. Mission
  authority therefore never bypasses the lineage condition — it *declares
  and ratifies* the expected classes instead.

Model choice and harness identity remain under technical details: they are
quality and provenance facts, not authority facts.

### 2.4 What it can never do

The agent's locks and the structural safety line, same copy as the profile
summary closer (`Like all agents, it can't change your safety controls.`).

### 2.5 Technical details (collapsed)

Closure digest, harness identity/EV, exact tool/service exposure, model,
network policy, trigger spec, skills list. Copy header: `For developers`.

### 2.6 Decision row

- `[ Approve mission ]` `[ Not now ]`
- Approving records the decision against the exact closure digest and mints
  the mission-subject grants (existing `approve()` mechanics).
- Subtext: `You can pause or change this anytime. Changes take effect after
  you review them.`

## 3. Out-of-charter: the revision proposal

When a running mission needs authority outside its charter, the run ends (per
the main plan) and produces a **revision proposal**, not a failure:

- Mission state becomes `Needs your review`; list chip + notification:
  `Morning news briefing needs a new permission.`
- Proposal card:
  - Title: `{Mission} wants to also be able to:`
  - The requested rows, in the same line grammar, each with a `new` badge
    and the concrete trigger context: `While running {date/time}, it needed
    to {action} {resource}.`
  - Buttons: `[ Allow and update mission ]` `[ Don't add ]`
  - `Allow and update mission` = approve the revised closure (digest
    changes, grants re-mint, next scheduled run uses it). `Don't add` keeps
    the old charter; the mission resumes its schedule and the agent-facing
    record marks the row denied-for-mission (no re-proposal for the same row
    without new cause).
- The proposal is host-constructed from the actual blocked invocation
  snapshot. Agent-authored justification text renders framed/quoted only.
- **Non-permission revisions diff too.** A proposal or edit that changes
  the toolkit, network reach, data-flow classes, schedule, or task renders
  those as typed side-section diffs in the same review sheet (`Schedule:
  daily 7:00 → hourly` · `Can reach: news sites → any website`, the widening
  visually flagged). Permission rows are the common case, not the only
  case; no behavior-bearing charter field changes without a visible diff
  line.
- **A mission that cannot proceed without a denied row must say so.** If a
  run ends against a row already marked denied-for-mission (the agent
  reports the blocked step as required), the mission does not silently
  retry into the same wall on schedule: it pauses into `Needs your review`
  with `This mission can't finish without: {row}. Allow it, change the
  mission, or pause it.` Denial stays respected; the outcome becomes a
  visible decision instead of a recurring dead end.

## 4. Run status and waiting

Run timeline entries (per run, newest first): `Started` · `Waiting for
approval: {action} {resource}` · `Approved by you ({when})` · `Finished:
{outcome line}` · `Ended early: needed a permission change` · `Interrupted
(the app restarted)`.

- **In-charter missing grant** (allowed to wait): run shows `Waiting for
  approval`, the ordinary card is queued to desktop + mobile with the
  mission context line (`From the mission: {title}`). No TTL: a slow human
  is not an error. Cancellation is available on the run view.
- **Critical actions** always wait for exact confirmation, same card as
  interactive (§4 of [approval-ux-copy.md](approval-ux-copy.md)).
- **Interruption**: honest copy, no resume fiction and no false "nothing
  happened" claim — earlier steps may have completed: `This run was
  interrupted before finishing. The step in progress didn't happen.
  Completed before that: {steps from the effect journal, or "nothing"}.
  Next run: {schedule}.` "Run again" repeats the mission's work from the
  start; the copy never implies it continues the interrupted run.

## 5. Lifecycle controls

On the mission page: `Pause` / `Resume` (immediate), `Edit` (opens draft →
review sheet; behavior-bearing edits change the digest and require
re-approval — the sheet shows a diff view: added rows `new`, removed rows
struck through), `Retire` (confirm sheet; revokes mission grants).

Revocation invariant (from
[agent-authority-profile.md](agent-authority-profile.md) §8): revoking a
profile row a mission depends on immediately lapses it in the mission;
the mission pauses into `Needs your review` with the line
`A permission this mission used was removed.` — it never runs with withdrawn
authority and never silently re-acquires it.

## 6. Notifications

| Event | Notification |
| --- | --- |
| Draft/revision awaiting review | `{Mission} is ready for your review.` (Open) |
| Run waiting on approval | ordinary approval notification with mission context |
| Run ended out-of-charter | `{Mission} needs a new permission.` (Open) |
| Mission paused by revocation | `{Mission} paused — a permission was removed.` (Open) |

Standing decisions (approve mission, add rows) are in-app only; notification
actions never approve a charter (consistent with the secret-input rule in
approvals.md — lock-screen actions can't carry standing consequence).

## 7. What this surface must never do

- Present tool ids, service names, EV hashes, or cron syntax as the decision.
- Offer "approve all future changes" or any auto-widening.
- Let an agent-authored string render outside the framed untrusted style.
- Collapse "waiting for an in-charter approval" and "needs a charter change"
  into one state — the first is patience, the second is a decision.
- Offer mission approval from a lock-screen action.
