# Approval & Trust Prompt UX Spec

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Prompt UX remains product detail. Authentic resolution and native/workspace resource enforcement are governed by U3/U4.

Status: companion to `capability-model-redesign.md` (2026-07-21). This spec is a
**gating deliverable for P3** (and its outside-content variants for P4a): no prompt in
the acquisition loop ships without a card type registered here. Where
`system-agent-tools-cards-spec.md` and this spec overlap, tools-cards wins on
names/schemas; this spec wins on prompt copy and interaction rules.

Audience assumption: prompts are read by **non-technical family members**, often on a
phone, often mid-task, often as the second or third interruption of the hour. Every rule
in this spec follows from that.

## 1. Principles

1. **A prompt is a question a person can answer in one read.** Actor, action, scope,
   duration — one sentence. If the question needs a paragraph, the gate is cut wrong.
2. **The recommended answer is the big button.** Users click the primary action ~90% of
   the time; the primary must therefore be the answer we'd advise, not the most cautious
   one.
3. **Progressive disclosure.** At most three visible actions; everything else (details,
   lineage, narrower/wider scopes, always-allow, trust) folds behind "Details" /
   overflow. The card must be answerable without expanding anything.
4. **Interrupt rarely, queue the rest.** Modal interruption is a budgeted resource
   (§6.4). Everything over budget goes to the approvals chip, not the screen.
5. **System vocabulary never leaks.** The words principal, capability, grant, session,
   mission, taint, lineage, vouch, digest, harness, eval, snippet, conduit, tier,
   attestation, origin do not appear in any user-facing string. Ever. §2 is the law.

## 2. Vocabulary

### 2.1 Canonical translations

| Internal concept | User-facing language |
|---|---|
| agent / harness / eval / snippet | the agent's display name ("Research Agent"). The harness and eval NEVER surface; the agent is the actor. |
| session (interactive) | "this task" (chat/agent work); "this conversation" only in the outside-content banner |
| mission / unattended agent | "automation" — always with its display name: "the Nightly Backup automation" |
| mission closure change | "{Name}'s setup changed" |
| capability + resource | an **action phrase**: "save files in your project folder", "access example.com" (§8) |
| grant (allow) | "permission" (noun), "Allow" (verb) |
| grant (deny) | "Don't allow" |
| standing grant | "always allowed" |
| preauthorization batch | "task permissions" |
| external content / taint | "outside content" — "content from outside your workspace" |
| internal content | "from your workspace" (rarely needed; internal is the silent default) |
| vouch | "**Trust**" (verb) / "trusted" — always aimed at content: "Trust this folder" |
| delegated eval identity | "**Trust this agent**" — the eval is never named and remains constrained by the agent's reviewed executable version |
| code digest / version pin | "this exact version" / "the version you reviewed" |
| critical tier | never named; expressed by the Confirm card's distinct visual treatment (§5.9) |
| SA1 delegated decision | "approved automatically by your rule '{rule name}'" |
| revoke | "Remove permission" |
| promotion / install confirmation | "Install {name}" |

### 2.2 Banned words (CI-linted, §9)

`principal, capability, grant, scope, session, mission, taint, tainted, lineage,
provenance, vouch, digest, hash, harness, eval, snippet, conduit, tier, attestation,
origin (as noun), subject, envelope, acquisition, invocation, resource, delegation,
integrity, artifact, closure, RPC, DO, dispatcher`.

Allowed plain substitutes only. One deliberate exception: "Details" panes may show a
labeled technical block (§5.11) for users who want it — banned words may appear *inside
that block only*, never in titles, bodies, or buttons.

### 2.3 Grammar of a prompt

Every prompt title is a question of the form **{Verb} {actor} to {action phrase}?** or
**{Verb} {object}?** Every body is at most two sentences: sentence 1 = what and where;
sentence 2 (optional) = the one fact that changes the decision (outside content, first
time, changed setup). Buttons are verb phrases, 1–4 words, no punctuation. Duration
lives in the button, not the body ("Allow for this task", "Just once").

## 3. Prompt inventory architecture

Prompts are **registry-driven**. A central prompt registry (extending the tools-cards
registry) defines every card type; the approval queue can only render registered types,
and a gated flow that would need an unregistered prompt is a build error — the same
fail-closed pattern as method tiers. Each registration declares:

```
{
  id: "permission.gated",            // stable card-type id
  trigger: <which model event mints it>,
  facts: [...],                       // required invocation-snapshot fields
  title: <template>,                  // §5 templates, referenced not inlined
  body: <template>,
  actions: [...],                     // ≤3 visible, ordered; overflow list
  details: [...],                     // disclosure panes
  push: <push variant or "none">,     // §7
  groupKey: <template>,               // §6.1 coalescing identity
  fatigue: { cooldown, escalation },  // §6.2–6.3
}
```

Adding a prompt anywhere in the product means registering a card type here first. The
registry is also the copy source of truth — no inline strings in service code — so the
lint rules in §9 run against one file set.

## 4. The action-phrase registry

Every capability that can gate carries **display metadata** in the tools-cards registry
(§3 there), added at P3 and fail-closed like tiers: a gated capability without display
metadata is a build error.

```
display: {
  verb: "save files",                    // infinitive verb phrase, ≤4 words
  scopeRenderer: "fsPath" | "netOrigin" | "credential" | "repo" | ...,
}
```

`scopeRenderer` maps a resource key to human text (§8.3). The composed action phrase is
always `{verb} {renderedScope}`: "save files **in your project folder**", "access
**example.com**", "use **your GitHub credential**". Composition is mechanical so copy
stays consistent across the whole surface.

## 5. Card types and exact wording

Placeholders: `{agent}` display name; `{action}` composed action phrase; `{source}`
outside-content origin ("a page from example.com", "the cloned project acme/website",
"the package lodash 4.17.21", "a file you added: report.pdf").

### 5.1 `permission.gated` — a gated action needs approval

- **Title:** `Allow {agent} to {action}?`
- **Body:** `{agent} wants to {action} while working on this task.`
  (First occurrence of this agent ever: append `This is the first time {agent} has
  asked for this.`)
- **Actions:** **[Allow for this task]** (primary) · [Just once] · [Don't allow]
- **Overflow:** `Always allow for {unit/automation name}` (only where the tier and
  severity verdict permit standing authority) · `Don't ask again for this task` (mints
  a session deny) · `Details`
- **Details panes:** the exact operation ("What exactly?" — rendered arguments, e.g.
  the file list or the outgoing request), and the technical block (§5.11).
- Primary rationale: "Allow for this task" is the session rule — the consent object per
  the capability model. The card **must** carry the subline under the primary:
  `Covers {action} until this task ends.` "Just once" covers exactly the shown
  operation; if the agent retries with anything different, a new card appears.

### 5.2 `permission.outside` — gated action from a task that read outside content

Same as 5.1 plus a banner **above the title**, amber, icon ⚠:

- **Banner:** `This task has read outside content: {source}.`
- **Body:** unchanged from 5.1 — the banner carries the fact; don't repeat it.
- **Actions:** identical to 5.1. Allowing here records consent *for the shown outside
  content* (the model's `lineageAtConsent`); if different outside content arrives
  later, the next card's banner names the new source.
- **Overflow adds:** `Trust {source}…` → opens 5.3 as a separate card. Trusting is
  never bundled into the Allow tap (distinct decisions in the model, distinct taps in
  the UI).
- **Multiple sources:** banner shows the most recent + `and {n} more` linking to the
  details pane listing all of them, newest first.

### 5.3 `trust.content` — trust a specific piece of outside content

Appears at clone / dependency install / file upload, from 5.2's overflow, and from the
Trust inspector.

- **Title (repo):** `Trust the code from {org/name}?`
  **Body:** `You copied this project from {host}. Trusting it means Vibestudio treats
  this copy like your own work — agents can read it without asking.`
- **Title (package):** `Trust {package} {version}?`
  **Body:** `This version was downloaded from {registry}. Trusting it means agents can
  read its code without asking. New versions will ask again.`
- **Title (file):** `Trust {filename}?`
  **Body:** `You added this file from outside Vibestudio. Trusting it means agents can
  read it without asking.`
- **Actions:** **[Trust this version]** (primary) · [Not now]
- **Overflow:** `Details` (where it came from, when, what has read it).
- "Not now" is costless: nothing breaks, agents that read it just show the 5.2 banner.
  Say so when entered from clone/install: append body sentence
  `You can keep working either way — you'll just be asked before agents act on it.`

### 5.4 Future versions are never pre-trusted

There is no name-level or package-pattern decision that approves code or content which
does not exist yet. A changed exact version returns through the ordinary version review,
with added permissions first and unchanged permissions collapsed. Agent-identity trust
is different: it trusts a specific agent relationship, while the agent's executable
version and manifest remain an independent intersecting constraint.

### 5.5 `task.permissions` — preauthorization batch

- **Title:** `Approve permissions for this task?`
- **Body:** `{agent} plans to: {task summary, one line, agent-provided, plain text}.
  It's asking up front so it won't interrupt you later.`
- **Rows:** one per rule — `{action}` with a per-row toggle, all on by default. A row
  whose worst case is heavier than the rest carries the subline
  `May include: {heaviest concrete example}` (e.g. "May include: deleting files in
  /project/build").
- **Actions:** **[Approve selected]** · [Ask me each time] · [Cancel task]
- Rules the model forbids batching (critical worst case) simply don't appear; the body
  then appends: `Some steps will still ask you individually.`
- Approved rows read back in the task transcript: `You approved: {action}, {action}.`

### 5.6 `automation.setup` — approve a new automation (mission)

- **Title:** `Set up the {name} automation?`
- **Body:** `Runs {schedule, humanized: "every night at 2:00"}. {One-line purpose from
  the task spec}.`
- **Rows:** its standing permissions, same rendering as 5.5 (no toggles — an automation
  is approved whole or edited first).
- **Actions:** **[Set up]** · [Edit first] · [Cancel]

### 5.7 `automation.changed` — closure diff re-approval

- **Title:** `{name} changed — review before it keeps running.`
- **Body:** none. Go straight to the diff.
- **Diff rows:** only what changed, one per closure input, old → new in plain terms:
  `Instructions: edited ({n} lines) — [view]` · `Runs: nightly → hourly` ·
  `Can now also: {action}` (added permission, highlighted) · `No longer: {action}` ·
  `Uses model: {old} → {new}` · `Reads playbook: {skill name} updated — [view]`
- **Actions:** **[Approve changes]** · [Keep old version] · [Pause automation]
- "Keep old version" is honest only when the old closure is still runnable; when it
  isn't, the action reads [Pause automation] alone.

### 5.8 `unit.install` — install / promotion confirmation

- **Title:** `Install {unit name}?`
- **Body:** `Built from work in this task. It will be able to:` followed by permission
  rows derived from observed use (5.5 rendering, toggles on).
- If the unit's source carries outside content: the 5.2 banner appears, and installing
  requires the trust decision first — the primary becomes **[Review outside content]**
  until 5.3 is resolved.
- **Actions:** **[Install]** · [Edit permissions] · [Cancel]

### 5.8b `unit-install-review` — one review for every arrival of code

The single surface behind workspace creation, template install, template update, and
"a part in your workspace changed"
(`docs/template-install-unit-approval-ux-plan.md` §7). Same components, same rows,
same copy; the mode decides the heading, whether there is a *Not now*, and whether
the list is differential.

- **Heading** by mode: `Welcome — here's what's in your workspace` (`adopt-root`) ·
  `Add {template}` (`install`) · `Update {template}` (`update`) ·
  `{part} changed` (`part-changed`).
- **Body:** one row per part — title, kind label (**Panel** / **Agent** / **Service**
  / **Client App** / **Extension**), one sentence of purpose, and a *notable line*
  carrying at most two headline facts. A part with nothing headline states its
  ordinary footprint rather than claiming innocence:
  `Nothing unusual · 9 everyday permissions`.
- **Detail** per part: **Worth knowing** (every headline row plus every behavioural
  fact — never truncated; folds past five, auto-expanded when any always-confirms),
  then `Plus N everyday permissions`, then origin and version.
- **Checkboxes appear only on rows a decision here can grant.** Contextual and
  critical rows are disclosures whose timing line carries the whole meaning —
  `Asks when it needs one, and you pick which.` /
  `Asks every time, showing exactly what.` A checkbox there would promise something
  the server refuses.
- **Selection withholds a grant, never a part.** Checked is *allow now*; unchecked is
  *ask when needed*. Nothing is disabled and nothing is withheld from the workspace.
- **Footer** restates the selection live: `3 parts · everything allowed now` /
  `3 parts · 1 will ask before it does 2 things`.
- **Actions:** **[Add template]** / **[Add to workspace]** / **[Update]** /
  **[Use the new version]** · [Not now] / [Keep the old version]. The creation review
  has no *Not now*: the workspace already exists, and the equivalent escape is
  unchecking everything.
- An update that changes no declared authority anywhere renders as one line —
  `Updates 12 parts. No permission changes.` — never a per-unit list.
- A notification may **open** this review and can never resolve it.

Client apps and extensions do not use this surface. They are decided at the launch
gate (§5.8c), because `apps/shell` cannot render its own approval.

### 5.8c The launch gate — whose code is this?

Organized by **origin**, not by kind and not by permission, because the only question
before the workspace exists is whose code this is and whether it may run on this
computer. There is no publisher identity in this system, so:

- the **origin URL is the identity**, rendered in full, punycode for
  internationalized domains, and never replaced by a name the code gave itself;
- **no commit id or content digest appears at any disclosure level** — a hash is
  unreadable, and printing it implies a check the user cannot perform;
- **nothing implies we reviewed, approved, or vouched for anyone**, because we
  have not; a first encounter with an origin is stated as a fact
  (`You haven't run code from github.com/acme before.`), never as a judgment.

`Extensions run outside Vibestudio's protections, with access to this computer.`
appears at the top level whenever any extension is in the set, never in a
disclosure. Declining says what it costs, and the cost differs:
`Vibestudio won't start. Nothing is installed or changed.` versus
`The News extension won't run. The rest of your workspace works normally.`

### 5.9 `confirm.critical` — critical-tier fresh confirmation

Visually distinct: red accent, no banner competition (any outside-content fact moves
into the body), never coalesced, never queued silently, never actionable from a push
notification (§7.3).

- **Title:** `Confirm: {action}?`
- **Body:** sentence 1 = the concrete irreversible consequence, named plainly:
  `This deletes the credential — apps using it will stop working.` /
  `This removes {n} permissions at once.` Sentence 2 (if from an agent):
  `Asked for by {agent}.`
- **Actions:** **[Confirm]** · [Cancel] — two only, no overflow, no "always".

### 5.10 Template composition cards

Template operations use four registered cards with plain-language consequences:

- `template.add`: **Add this template?** — “Review what it adds and any choices before
  continuing.” Actions: **[Add template]** · [Not now].
- `template.update`: **Update this template?** — “Review what changes and anything you
  changed too.” Actions: **[Update]** · [Not now].
- `template.remove`: **Remove this template?** — “Its parts stay in your workspace and
  become yours to manage.” Actions: **[Remove]** · [Cancel].
- `template.suggest`: **Suggest your changes?** — “Your workspace won't change. The
  maintainers can review what you send.” Actions: **[Send suggestion]** · [Cancel].

The executable source is `AUTHORITY_PROMPT_REGISTRY`. Capabilities
`workspace.templates.add`, `.update`, `.remove`, and `.suggest` select these cards.
The broader `workspace.templates.change` capability deliberately uses
`permission.gated`; it covers authoring publication, cancellation, resumption, and
suggestion decisions that do not share one narrower consequence.

Prepared workspace-configuration changes use `permission.gated`. The visible action
comes from the preparer's plain-language summary, while Details shows the exact
changed paths and before/after values. The approval is bound to the base digest,
result digest, and allowed path scope; approving one Git remote/upstream edit cannot
authorize a later or broader configuration change.

### 5.11 `decision.byrule` — a delegated decision happened (notification, not a prompt)

When an SA1 rule resolves an approval, the user is told, not asked:

- **Inbox line:** `Allowed automatically: {agent} to {action} — by your rule
  "{rule name}". [Undo rule] [Details]`

### 5.12 The technical block

Every Details pane ends with a collapsed `Technical details` block: raw capability id,
resource key, subject, snapshot digest, lineage chain with session ids. This is the
*only* place §2.2 words may appear. Non-technical users never need to open it; power
users and bug reports always can.

### 5.13 Dismissal

Swiping away / closing any card = **Not now**: nothing is minted, the request parks in
the approvals chip, and the fatigue cooldown applies (§6.2). Closing is never treated
as Deny — denial is always an explicit tap on "Don't allow".

## 6. Prompt-fatigue mitigation

### 6.1 Exact deduplication and concurrent bursts

An approval decision may fan out only to **exact duplicates**: caller identity,
capability, scope, invocation snapshot, available decisions, operation, and visible
details must all match. `operation.groupKey` is presentation metadata and must never
be used as consent identity; sharing a task or turn does not mean two actions share
authority. Concurrent distinct asks remain distinct, legible cards in one browsable
queue. The interruption budget below opens the first and leaves the rest in the
counted chip. A future multi-row card may present several rows together, but each row
must retain its own decision and exact snapshot; it must not recreate decision fanout.

### 6.2 Cooldown after Not-now

Dismissing a card silences that `ruleKey` for **10 minutes**. During cooldown it is
not re-presented; the agent receives the pending state (it can continue other work or
say it's waiting). Explicit "Don't allow" needs no cooldown — it minted a deny, and
re-asking is blocked by the model itself.

### 6.3 Escalation to the chip

After **two** Not-nows on the same `ruleKey` in one task, that ruleKey stops
interrupting entirely for the task's lifetime — it queues in the chip with a badge.
The chip is a persistent, calm surface: `2 waiting approvals`, tap to review as a 5.5
list. Rationale: two dismissals are an answer ("not while I'm busy"); the third
interruption is the system failing to hear it.

### 6.4 Interrupt budget

At most **1 ordinary interrupting card per principal/task in a 60-second burst**.
Additional concurrent asks go to the chip. `confirm.critical` is exempt but still never
stacks: cards present one at a time, newest queued behind, **never** two modals at
once anywhere in the product.

### 6.5 Consolidation nudge

On the **third "Just once"** for the same `ruleKey` within a task, the next card's
primary gains the subline: `You've allowed this 3 times — "Allow for this task" stops
the asking.` The primary does not change (it was already the session rule); the nudge
just explains it. Never auto-upgrade a once into a rule.

### 6.6 Fatigue telemetry

Count prompts shown / answered / dismissed per ruleKey per week (local, inspectable).
The Trust inspector surfaces the top prompt sources with the applicable one-tap
remedy: `example.com asked 14× this week — [Trust example.com for this project]`.
Fatigue is treated as a bug signal: any ruleKey crossing 10 prompts/week without a
standing answer is a scope-cutting defect (§8) by definition.

## 7. Push approvals

### 7.1 Constraints

Push = lock-screen real estate: title ≤ 40 chars, body ≤ 120, at most **two** action
buttons. Push carries the same card type, compressed; tapping the notification body
always opens the full card.

### 7.2 Compression templates

- `permission.gated` → title `{agent}: allow {short action}?` body `{action}, while
  working on {task short-name}.` actions **[Allow for task]** [Not now].
- `permission.outside` → body prefixed `Has read outside content ({short source}). `
  actions **[Review…]** [Not now] — allowing sight-unseen from the lock screen is not
  offered when outside content is in play; the primary opens the full card.
- `task.permissions` → `{agent}: approve {n} permissions for {task}?` actions
  **[Review…]** [Not now].
- `automation.changed` → `{name} changed — needs review.` single action **[Review…]**.

### 7.3 Never from push

Deny-standing, Always-allow, Trust (any form), Always-trust, unit install, and
`confirm.critical` are **never actionable from a notification** — push may announce
them (`Confirm needed: {action}`) with a single [Review…] opening the full surface.
Rationale: everything durable or irreversible deserves a screen, not a thumb reflex.

### 7.4 Multi-user delivery

Trusted-household rule: an actionable approval pushes to **the requesting user's
devices** first; if unanswered for 5 minutes it widens to all members whose settings
allow it. Any member may answer; the resolution is attributed and read back on
everyone's card/chip: `Allowed by {member} · {time}`. Quiet hours (per member) route
to the chip silently; automations that would block overnight say so in their transcript
rather than waking anyone.

## 8. Scope-cutting guidance

The gate's *scope default* decides whether users get one meaningful question or a
drizzle of petty ones. The rule: **default to the widest scope that is still an honest
answer to "where?"** — then let disclosure narrow or widen.

### 8.1 Default scope table

| Resource kind | Default offered scope | Narrower (in Details) | Wider (in overflow, marked) |
|---|---|---|---|
| Files | the enclosing project folder (or the automation's declared folder) | this file / this subfolder | anywhere in the workspace |
| Network | the site (origin): "example.com" | this exact page | any site — phrased `any site (asks a lot of trust)` |
| Credentials | the exact credential, this task only | — | (none wider; "always" only via standing where permitted) |
| Git | this repository | this branch | any repository |
| Channels/panels | this channel / this panel tree | — | all channels |
| Shell/exec | the project folder as working dir | — | whole workspace |

Never default to a single file, a single URL, or "everything". The first is a drizzle
generator; the last is not an honest question.

### 8.2 The three-strikes widening heuristic

If the last 3 approved invocations for a capability in a task fall under a common
parent scope within the table's bounds, the *next* card offers that parent as the
default (e.g. three files in `/project/src` → default `in project/src`). The heuristic
never exceeds the table's default column — crossing into the "wider" column is always
a human's explicit choice.

### 8.3 Scope renderers

`fsPath`: `in {folder name}` — always the human folder name with a hover/tap full
path; home-relative, never absolute machine paths in the body. `netOrigin`:
`on {registrable domain}` (show subdomain only when it differs meaningfully:
`api.example.com`). `credential`: `your {service} credential ({label})`. `repo`:
`in {org/name}`. Renderers live with the display metadata (§4) and are the only way
scopes reach copy.

## 9. Copy linting (CI)

A prompt-lint job runs on the registry: (1) banned-word scan (§2.2) over titles,
bodies, buttons; (2) template completeness — every card type binds actor, action,
duration; (3) length budgets — title ≤ 64 chars rendered with longest known agent
name, body ≤ 2 sentences, buttons ≤ 4 words; (4) every gated capability has display
metadata (§4); (5) every card type has a push variant or an explicit `push: "none"`
with a reason. Snapshot tests render every card type with fixture data in en-US;
translations inherit the same budgets.

## 10. Rollout

- **P3:** registry + card types 5.1, 5.5, 5.9, 5.12; chip + fatigue rules §6; push
  §7 for 5.1/5.5; display metadata fail-closed; lint in CI.
- **P4a:** 5.2, 5.3, 5.4 (banner, trust, always-trust), outside-content push rules.
- **P4b/P5:** 5.6, 5.7, 5.8, 5.10; fatigue telemetry surface in the Trust inspector.

## 11. Open questions

1. Exact cooldown/budget constants (§6.2, §6.4) — shipped as config, tuned on the
   fatigue telemetry, with the spec values as defaults.
2. ~~Duration cap on "Allow for this task"~~ **Resolved: no.** Timeouts in agentic
   settings are suspect by default — a session rule lives exactly as long as its
   session; if long-lived sessions ever need re-confirmation it should key on a
   lifecycle boundary (e.g. a new mission revision), never a clock.
3. Localization of action phrases: verb-first composition works in English; the
   renderer contract may need per-locale templates.
