# Agent Authority Profile

Status: specification (companion to
[../agentic-authority-negotiation-plan.md](../agentic-authority-negotiation-plan.md))

Date: 2026-07-24

The **authority profile** is the user's per-agent picture of "what this agent
can touch": a projection of the canonical grant, denial, and receiver-contract
records into the [domain vocabulary](domain-vocabulary.md), plus the small
amount of genuinely new state (locks, standing agent-scoped grants) that makes
the picture editable. It is how a non-technical user reads, grows, trims, and
revokes an agent's authority — and it is the *same* object a mission charter
snapshots for unattended work.

The profile is a **view with edit affordances**, not a parallel policy store.
Every fact it displays is derived from, and every edit it accepts writes back
to, the canonical stores (`CapabilityGrantStore`, denial records, receiver
contracts, mission registry). There is exactly one enforcement path; the
profile never becomes a second one.

## 1. The mental model (what the user holds)

For each agent, a grid of [domain × verb cells](domain-vocabulary.md#3-the-verb-classes).
A cell's chip is a **derived summary of its contents**, not a stored state —
real cells mix allowances, locks, and defaults, and the display must never
flatten that mixture into a false absolute:

| Cell chip | Shown when | Backing state |
| --- | --- | --- |
| **Asks first** | No standing records in the cell | Default; attempts produce a just-in-time card |
| **Allowed: {n}** | Only allowances present | Agent-scoped grants (each capability + concrete resource); asks for anything else in the cell |
| **Never** | A cell-level lock is present | A domain×verb lock record (covers everything in the cell, including capabilities added later) |
| **Allowed: {n} · Never: {m}** | Mixed line-item records | Grants and per-capability/resource locks side by side; asks for the remainder |
| **Not available** 🔒 | Structurally unreachable | Receiver contracts exclude `session` (all of `safety`, some infra) |

Suspended (idle-paused) grants count in neither number; they render on
expansion with their own state line. Mixed chips always expand to the exact
line items — the chip is a table of contents, and the line items are the
truth.

The one-sentence summary users learn: *"Agents ask first for everything,
except what you've allowed, minus what you've locked — and some things agents
can never do at all."*

## 2. State model

### 2.1 Derived facts (no new storage)

- **Reachable cells**: which (domain, verb) cells contain at least one
  capability whose receiver admits `session` principals. Everything else
  renders *Not available*.
- **Standing allowances**: agent-scoped grants in `CapabilityGrantStore`
  (scope `agent`, §3), grouped by cell for display.
- **Session/task grants**: short-lived grants shown only in the activity
  feed, not as profile state (they expire with the task).
- **Mission exposure**: for agents with missions, the approved charter's
  standing grants render in the same cells with a mission badge.

### 2.2 New records

1. **Locks**, at three deliberate granularities, all persisted in the grant
   store as denials with provenance
   `{ surface: 'profile' | 'card', decidedAt, decidedBy }`:
   - resource-scoped: `(agentBinding, capability, resourcePattern)` —
     "never publish to repo X";
   - capability-wide: `(agentBinding, capability)`;
   - **cell-level: `(agentBinding, domain, verb)`** — the profile's
     "Never." Stored at domain×verb so that a capability assigned to the
     cell in a later release is automatically covered; the UI promise
     "Never" must not silently expire when the census grows. This is the
     one sanctioned domain-granular record — deny-only, per the amended
     invariant in [domain-vocabulary.md](domain-vocabulary.md) §1 rule 2.
     Evaluation resolves a cell lock through the same static
     capability→(domain, verb) mapping the UI uses, so enforcement and
     display cannot disagree.
2. **Agent-scoped standing grants.** A new grant scope `agent` keyed to the
   **agent binding** (the durable agent identity the host attests in the
   execution-session fact), not to code version and not to a transient
   session. `(agentBinding, capability, concreteResource) → allow`, with
   provenance and lineage conditions (§5).

### 2.3 Scope ladder (complete decision vocabulary)

| Scope | Lifetime | Where offered |
| --- | --- | --- |
| `once` | Exactly this invocation snapshot | Every gated card |
| `task` | Until the current task ends (§2.4) | Every gated card during a task |
| `agent` | Standing, until revoked or auto-lapsed (§6) | Gated cards after eligibility (§5.4); profile page |
| `mission` | While the approved mission closure is active | Mission review only — never a card |
| — `deny` | This request only | Every card |
| — `lock` | Standing, until unlocked | Card overflow menu; profile page |

`version` grants remain available **only** for fixed installed code
(code-origin requests). They are never offered for session-origin agent work:
"trust this code version" is meaningless when the code is generated per task.

### 2.4 What "task" means

A task grant is bound to the host's **authority session for the originating
task**: the interactive agent task (channel task id) the execution-session
fact names. It ends when that task completes, is cancelled, or its session is
closed — not on a wall-clock timer. The card copy says "while it works on
this task"; the enforcement key is the attested task reference. Sub-invocations
of the same task (tool calls, sub-evals with causal parent in the same task)
share the grant; a new task does not.

## 3. Grant semantics for `agent` scope

- **Key**: `(agentBinding, capability, concreteResource)`. Resource matching
  uses the receiver's resource-derivation rules, exactly as other scopes.
- **Never wildcarded by default.** The card's "Always allow" choice binds the
  concrete resource of the current request ("this repository"). A wider
  resource scope ("any repository in this workspace") exists only as an
  explicit, visually distinct choice on the profile page — never the default
  card affordance, and only where the receiver declares a reviewed broader
  resource pattern as offerable.
- **Survives** app restarts, agent restarts, and new tasks. Does **not**
  transfer to other agents, to spawned sub-agents (§7), or to fixed installed
  code.
- **Critical-tier capabilities are excluded.** They never accept `agent`
  scope; every critical action is an exact fresh confirmation, always.
- **Irreversible operations are excluded.** A receiver-declared irreversible
  effect ([approval-ux-copy.md](approval-ux-copy.md) §3 flag) never accepts
  `agent` scope and is never covered by a standing mission grant — it
  prompts (interactive) or waits (unattended) every time. This is the
  enforced invariant behind the user-facing promise "actions that can't be
  undone always wait for you"; the copy claims nothing the model doesn't
  guarantee.
- **Lineage-class-conditioned** (§5): a standing grant records the
  request's **lineage class** at creation — the kind of outside content, if
  any, that influenced it (e.g. `none`, `web`, `email`, `channel-external`).
  The grant covers later requests of the *same class only*. A request
  carrying a lineage class the grant has not seen re-prompts with the taint
  explained, and approving it may extend the grant to that class as an
  explicit choice. This replaces a binary clean/tainted rule, which would
  have made content-processing agents (news, email, research) permanently
  un-automatable while teaching users nothing.

### 3.1 Binding continuity — what "this agent" means over time

Standing authority follows the agent binding, so the binding's identity
semantics are part of the trust model, not an implementation detail:

- **Version updates of the same unit under the same owner keep the
  binding.** Grants and locks persist across the update; the profile
  activity feed records `Updated to v1.4` events so the history is
  inspectable. This matches the user's mental model ("News got better"),
  and the unit's *changed declared behavior* is separately surfaced by its
  `unit-version-review` diff — the two review systems cover each other.
- **Replacement, ownership transfer, or re-installation after removal mints
  a new binding.** Grants never transfer; locks are archived and offered
  for restore ([§6](#6-hygiene-grants-must-not-outlive-attention)). A
  different piece of software under a familiar name must not inherit the
  familiar name's authority.
- **Renames keep the binding** (it is the same agent) but the profile and
  the next approval card show `previously "{old name}"` for one release
  cycle, so a rename cannot be used to shed reputation.
- The binding id, its unit lineage, and these transition events appear
  under the profile's technical details for auditability.

The profile surfaces are built from the shared `AuthorityRow` components of
[authority-surfaces.md](authority-surfaces.md); the per-agent page is the
agent's workspace-catalog item page, reachable from both the catalog and
Permissions (two pivots over the same rows).

### 4.1 Per-agent profile page (Permissions → Agents → News)

Layout, top to bottom:

1. **Identity header**: agent name/icon, verified unit + owner, "active
   since", link to activity.
2. **Plain-language summary line**, generated from cell states (grammar in
   [approval-ux-copy.md](approval-ux-copy.md) §7): e.g. *"News can see the
   web and your files. It always asks before publishing or sending. It can
   never change your safety controls."* For agent units whose installed
   code performs direct effects, the summary includes them in a distinct
   clause — *"Its built-in code also connects to Gmail directly"* — so the
   headline never claims the profile is the whole picture when a manifest
   grants more.
3. **The grid**: eight domain rows; each row shows its verb cells with
   derived chips (§1, including mixed `Allowed · Never` chips). Tapping a
   row expands standing allowances, locks, suspended grants, and — when a
   task is live — transient task-grant chips (*"allowed for the current
   task"*), as individual lines: *"Publish to `panticonic/briefings` —
   always · added Jul 12 · Remove"*. Each domain row also shows a
   read-only **open-access band** where applicable: ungated reads
   receiver-open to any admitted session (*"All agents can see: panel
   layout, project file names"*), rendered informationally with no
   controls — so "can see your files" always has a visible, truthful home
   even where no grant exists to revoke.
4. **Missions section** (if any): each mission with its snapshot badge and a
   link into [mission governance](mission-governance-ux.md).
5. **Activity feed**: recent approvals, denials, uses of standing grants
   (each entry deep-links to the exact decision record).
6. **Reset controls**, labeled by exactly what they clear: "Make News ask
   first for everything" (subtext: *"Removes the permissions you've granted
   to this agent. Your 'never' choices stay."*) and "Remove all permission
   settings for News" (clears grants and locks). Neither touches the unit's
   installed-code manifest authority — that is the unit's, changed by
   version review or uninstall, and the subtext says so when such authority
   exists: *"News's built-in code keeps its declared abilities; remove the
   app to remove those."*

### 4.2 Per-domain pivot (Permissions → Publishing & sending)

The other direction of the Android Settings pivot: one domain across all
agents and units — "who can publish?" Lists every agent/unit with a non-default
state in the domain, plus fixed-code units whose manifests request
capabilities in it. Same line-item revoke affordances.

### 4.3 In-card growth (how the profile gets drawn)

The JIT card is the profile's write path
([approval-ux-copy.md](approval-ux-copy.md) §3). Choosing "Always for News
(this repository)" creates the `agent` grant *and* shows a one-time toast:
*"Saved. You can change this anytime in Permissions."* — teaching the
existence of the surface at the moment it becomes relevant.

### 4.4 Locked-cell behavior

When a cell or capability is locked, agent attempts return structured
`user-denied` (with `standing: true`) immediately; nothing is queued, no
notification fires. The agent-facing result instructs: do not retry, tell the
user what you could not do and why. The agent's chat surface renders the
system-authored line (*"News wasn't allowed to publish — you've turned that
off for this agent"*) so the user always learns work was skipped, from the
system rather than only the agent's paraphrase. A counter on the profile page
("3 attempts while locked, last: yesterday") keeps silent lockdown honest
without re-prompting.

## 5. Anti-fatigue and anti-nag mechanics

The profile succeeds only if prompts stay rare and meaningful.

1. **Dedup + coalesce** (existing queue behavior): identical invocation
   snapshots share one card; concurrent waiters coalesce.
2. **Dismissal cooldown**: dismissing (not denying) a card suppresses
   re-prompts for the same (agent, capability, resource) for the cooldown
   window; the agent receives `dismissed` and must not immediately re-attempt.
3. **Escalation offer, rate-limited**: the "Always…" choice appears on the
   card only when eligible (§5.4), keeping the common card two-choice simple.
4. **Lineage rules**: outside-content-influenced requests show the
   `permission.outside` framing. A standing grant covers only lineage
   classes it has explicitly seen and had approved (§3); a request carrying
   a new class re-prompts with the taint explained, and the card's "Always"
   choice states the class it would add ("…including content from
   websites"). Approving a class extension is always a distinct, explicit
   decision — never an automatic widening.
5. **No prompt-to-grant conversion**: rate limiting and cooldowns never
   auto-approve. Pressure relief is always either a user decision or agent
   backoff.

### 5.4 "Always" eligibility

The `agent`-scope choice appears on a card when all hold:

- capability tier is gated (never critical) and the effect is not
  receiver-declared irreversible;
- the receiver declares `agent` scope offerable (per-capability opt-in in the
  receiver contract, reviewed with the ledger);
- the request's lineage class is `none`, **or** the card explicitly states
  the class the grant would cover (§3) — a lineage-bearing "Always" is
  allowed but never ambient;
- for methods of workspace services whose own manifest requests `sharing`,
  `accounts`, or network-egress capability: the user has already approved
  the same (capability, resource) at least twice
  ([domain-vocabulary.md](domain-vocabulary.md) §5.9).

## 6. Hygiene (grants must not outlive attention)

- **Idle lapse**: an `agent` grant unused for 90 days is suspended — it stops
  matching, the profile shows *"paused (not used for 3 months) — Restore"*,
  and the next agent attempt re-prompts with the history line *"You used to
  allow this."* No silent permanent authority.
- **Agent removal**: uninstalling/retiring an agent binding revokes its
  `agent` grants and archives its locks (re-installing the same unit does
  not resurrect grants; locks are offered for restore).
- **Periodic digest** (optional, off by default): a monthly summary
  notification — *"Your agents used 3 standing permissions this month; 1 is
  unused."* Links to Permissions.

## 7. Sub-agents and deputies

A helper started via `subagents.create` gets its **own** binding and starts
with the **default profile** (everything *Asks first*), regardless of the
parent's grants — grants do not flow down. A causally delegated leg of the
parent's task (host-attested, same task reference) uses the *parent's*
grants **under the parent's identity — approval cards and activity entries
for such legs display the parent's name**, so the user's picture of "who is
acting" matches whose grants apply. The card for `subagents.create` states
both halves precisely: *"{Parent} may use its own permissions for work it
directs. For anything the helper does independently, the helper asks
separately."*

## 8. Relationship to mission charters

A mission charter's permission section **is a snapshot of profile rows**: the
user selects which standing allowances (existing or proposed) the mission may
use unattended, and the closure digest freezes that selection. Details and
review flow in [mission-governance-ux.md](mission-governance-ux.md). Two
invariants:

- Editing the live profile does not silently change an approved mission; the
  mission keeps its snapshot until re-approved — except **revocation**, which
  always applies immediately (revoking a grant lapses it in every mission
  snapshot that referenced it; affected missions pause with a
  *"needs your review"* state rather than running with authority the user
  withdrew).
- A mission can never carry an allowance whose profile row the user could not
  create interactively (no mission-only widening of receiver rules).

## 9. Data-flow summary

```
receiver contracts ──┐  (reachability: which cells exist)
CapabilityGrantStore ─┤  (standing allowances, task/session grants)
lock records ─────────┤  (Never state)
mission registry ─────┤  (mission snapshots + badges)
decision provenance ──┘  (who/when/where lines)
        │  projection (read-only, capability→domain table)
        ▼
  Authority Profile view  ── edits ──► canonical stores (grant/lock/revoke),
                                        never a parallel evaluator input
```

## 10. Open questions (tracked, not blocking)

- ~~Task grants in the grid~~ — resolved yes: transient "allowed for the
  current task" chips render in expanded rows while the task is live
  (§4.1).
- ~~Open read access in the per-domain pivot~~ — resolved yes: the
  open-access band (§4.1) appears in both pivots, read-only.
- Digest notification default-on vs default-off for single-user mode.
- The initial lineage-class taxonomy (`none`/`web`/`email`/
  `channel-external`/…) — final list to be fixed with the
  context-integrity module during WP4.
