# Problem reporting: first-use choice, settings, and agent assistance

Status: implementation specification, 2026-09-29. Companion to
[the implementation plan](error-reporting-and-improvement-plan.md) and
[the data contract](problem-reporting-data-contract.md).

## 1. Mandatory first-use choice

Use one shell-owned first-start dialog backed by the host consent API, before the unit audit. Users make one reporting choice covering app/browser capture and workspace/agent capture. If either already has a saved choice, carry it over to the undecided capture location without showing another consent prompt. Reconnect follows the same rule. Failed propagation offers retry without asking the question again.

The complete user-facing explanation is two sentences:

> Share automatic error reports and anonymous usage statistics to help improve Vibestudio. Reports use a random device identifier; chat, code, and screenshots are excluded, and you can turn sharing off anytime.

Actions: **Enable automatic reports** and **Keep automatic reports off**, with equal prominence. There is no expanded technical disclosure block or separate server-reporting section. Either answer permits ordinary use; Escape/backdrop does not choose on or off, and quitting undecided leaves reporting off.

Reporting requires no account, login, enrollment, or submission-key configuration. A local sharing choice remains usable offline; connection state is distinct from consent.

The dialog belongs to System shell presentation; host-side consent gating is
authoritative even if presentation fails. The approval coordinator waits until
the first-start decision is complete, then loads canonical consent before
showing the unit audit. This prevents stacked dialogs and stale audit defaults.

Every subsequent unit audit includes an improvement-reporting option with the
saved choice already selected. Accepting the audit saves an explicit edit;
cancelling or closing it does not. Unchanged saved device/server choices require
no writes. If those choices differ, display a mixed checkbox and preserve both
unless the user edits it. The preference remains per installation/user across
workspaces; the audit must clearly state this shared scope.

Headless setup can record the current user's choice through trusted CLI access. A desktop inherits that saved choice without another dialog. A saved desktop choice similarly initializes an undecided connected server. Agents and environment variables cannot invent a reporting choice.

## 2. Settings and reporting status

Add **Problem reporting** to existing settings, opening the user's current
capture-installation settings rather than a workspace-wide shared preference.
Show:

- One **Share improvement information** control applying the choice to all connected capture locations.
- The same two-sentence explanation used at first start.
- Connection state separately: online, offline, paused, or waiting to retry; no user setup.
- Current local queue counts, last receipt time, and capture/suppression counts.
- **Report a problem**, **View my reports**, **Clear local report data**, and
  received-report deletion actions with their actual scope.

Off takes effect after the host transaction succeeds. Show “Automatic reports
are off; queued automatic reports were cancelled. An upload already received
may finish.” Do not cancel independently sent manual reports. On affects future
failures and does not silently send historical local evidence. Local queue
counts/status update after disconnect/reconnect from the canonical store;
events are invalidation hints, not an alternate source of truth.

The client cannot change another user's reporting choice. Capture stores remain scoped to the installation and authenticated user on the connected server; these are internal collection boundaries rather than separate user choices. One settings action updates both, and a saved choice initializes an undecided store. Legacy different choices remain untouched until an explicit edit, represented by the single mixed checkbox. The full collection, storage, and retention contract belongs in developer documentation rather than the consent dialog.

## 3. An obvious manual reporting path

Use **Report a problem** as the consistent actionable label in the shell Help
menu and command palette. Keep **Help vibestudio improve** as explanatory copy and
a quality-feedback entry point, not a different report system.

Add the same action to:

- persistent error notifications and panel/chat error boundaries;
- selected chat message actions, including wrong/incomplete results;
- stalled-task/status surfaces once the owner identifies a real wait failure;
- startup recovery, where local failure evidence is already available;
- Problem reporting settings and local report history.

Manual reporting is available when automatic reporting is off. It never forces
the user to enable automatic reports and never tries to reproduce a failure as
a prerequisite for saving the report.

Reporting actions open the existing command-agent conversation through typed `app.openShellSurface` calls. Selected messages and errors become persisted drafts; `problemReports.forConversation` copies a device draft to the connected server where the agent executes, or returns the existing ID when already there. Full evidence and narrative stay in the draft service; the small launch prompt carries only its ID and revision. It never truncates a report to fit the prompt limit.

The agent asks conversationally for missing context, investigates authorized evidence, and writes substantial narrative through `create`, `get`, `appendNarrative`, `patchNarrative`, `update`, `collect`, and `prepare` on the `problemReports` runtime client (an eval global). Users do not fill out a submission form. Settings keep consent, local incident/history, cancellation, remote deletion, and receipt controls. The settings reporting button begins a conversation; incident and history actions continue selected evidence.

For an explicit reporting request, the agent summarizes the report and calls `send(id, revision, digest)`. The host requests a one-time approval showing destination, symptom, expected result, narrative, diagnostics, attachment metadata and disclosure, exact digest, and retention. Approval is bound to that report, not future reports or automatic reporting. Rejection, dismissal, cancellation, or a changed revision prevents queuing. After approval the existing signed outbox delivers the exact prepared bundle. A save-only request leaves a draft without requesting submission. A proactive draft during unrelated work is recommended to the user without opening a report form or launching another agent.

## 4. Base template `problem-reporting` skill

Author Base `skills/problem-reporting/SKILL.md` and focused references alongside
the reporting API implementation. This is user assistance, separate from
`vibestudio-dev`'s developer investigation skill and SQL/admin capabilities.
Every ordinary Base agent can discover it when a user asks to report a bug,
send feedback, document a confusing result, or help describe a problem.

Frontmatter intent:

```yaml
name: problem-reporting
description: Help a user document and report a vibestudio failure or disappointing result, collect permitted evidence, write a grounded narrative, and request approval to submit the prepared report through the reporting API.
```

Skill resources:

- `references/api.md`: live service discovery, draft/revision operations,
  collection/section contracts, typed shell target, and availability outcomes.
- `references/narrative.md`: report-writing structure, provenance and evidence
  references, observed versus inferred findings, and substantial examples.
- `references/privacy-and-delivery.md`: automatic/manual distinction, selections,
  redaction, exact-byte review, queue/receipt/delete meanings.

Define these skill instructions concretely:

1. Treat the user's report request as authorization to prepare a report. Resolve
   live `problemReport` methods and their schema; do not guess API signatures.
   Reuse the current draft/task if present, or create one associated with the
   initiating human's verified scope. Never impersonate an arbitrary owner.
2. Capture the user's goal, symptom, and expected behavior from context. Ask only
   for essential missing reproduction/impact details, while collecting permitted
   technical evidence independently. Do not demand an error stack from the user.
3. Collect exact incident/message/invocation/build evidence with bounded APIs.
   Access to a chat doesn't authorize sharing the entire chat; select relevant
   messages and show the selection. If a source is missing/expired/denied, record
   the gap honestly and continue with available evidence.
4. Write a substantial narrative when useful: context/goal, observed and expected
   behavior, reproduction, chronology, impact, attempted recovery, findings,
   hypotheses, verification, and unanswered questions. Link findings to evidence
   section IDs. Separate observed facts from inference and unverified claims.
   Report concise rationale and findings, never private chain-of-thought.
5. Record agent-authored sections in the draft with provenance and expected
   revision. Preserve the user's own words and concurrent edits. Don't replace
   them with a model summary or flatten everything into exception prose.
6. Do not start a costly repair, deploy a candidate, change SQL/schema, extract
   credentials, or change reporting preferences merely to report the problem.
   A small existing reproduction check is useful when authorized; reporting
   remains deliverable if reproduction fails or model/credentials are unavailable.
7. Prepare the exact revision and explain what evidence and narrative will be included; `prepare` returns the frozen revision and digest that `send` takes. Call `send` when the user wants to share it; the host pauses for targeted approval. The agent cannot grant consent or approve its own upload. Do not open a form or invent a second confirmation after host approval.
8. If asked about delivery, inspect canonical status and report queued/received/
   paused/rejected accurately. Preserve report and receipt IDs. Never claim a
   developer saw or fixed the issue simply because intake accepted it.

The public Base runtime client is a typed wrapper over the existing host
`problemReports` service, with a report-shell opener through `app`. It is not a
second store or upload path. Skill examples use discovered schemas until those
clients ship. Test ordinary agents' ability to prepare reports without any
developer key, SQL access, or extra workspace dependency. Offline intake still allows drafting, local export, and review.

## 5. End-to-end acceptance

- Fresh profile: no automatic report or detailed analytics upload before the first-use choice; either equal-prominence
  action persists; restart/second shell does not ask again unnecessarily.
- Offline/failed UI/storage: automatic admission remains off until a durable
  decision; report drafts and local exports still work.
- Settings: opt-out cancels automatic queue, race with sending is explained,
  opt-in doesn't retroactively share, and another user's/device's setting is
  unaffected.
- Ordinary user: report a panel failure or wrong message in a few visible steps,
  with automatic reports off and no model provider configured.
- Agent assistance: Base skill produces an evidence-linked multi-section
  narrative substantially larger than a notification summary, preserves edits,
  and begins the same reporting conversation. It cannot change consent or silently submit.
- Preview/export/upload: exact selected content and digest match. Sentinel
  secrets remain redacted; unselected chats/code/attachments stay absent.
- Accessibility/localization: first-use prompt and submission approval are keyboard and
  screen-reader usable; reporting is discoverable through consistent labels.

## Current anonymous submission rule

No reporting account, login, submission-key setup, or challenge is allowed. Opt-in is a local sharing decision, not enrollment. All reports are silently signed with an automatically generated machine key held in the host's external encrypted secret store. The public key links reports from that machine and supports developer joins/aggregation. First-use and settings state this explicitly. Developer SQL/dashboard access alone requires a developer key through secure host input. Local draft ownership remains isolated by the app's existing caller identity; those account/handle values are never automatically sent to intake.

## Normal workflow integration

The shipped System shell mounts one combined first-start reporting dialog outside
the main desktop error boundary. The unit audit waits for that decision, then
shows the saved preference as its default. Later audits keep this option inline
and never open a second reporting dialog. Audit acceptance persists explicit
changes or a previously undecided server choice; cancellation saves nothing.
Both device and server choices remain backed by per-installation/per-user stores
and trusted human authority. Mixed existing choices are preserved unless edited.
Server consent belongs to the authenticated user across the server's workspaces.
Reporting settings continue to expose device and server choices independently.
A temporarily unreachable server is retried on reconnect without creating a new
prompt; device consent can still be recorded while it is unavailable.

Application menus and the command palette begin a reporting conversation. Panel render failures, selected chat messages, and tool-result cards persist user-selected evidence through the Base runtime client before starting that conversation. A shell that cannot mount offers Retry and directs the user to ask an agent after recovery; it cannot start an agent while its conversation owner is unavailable.

Ordinary Base agents receive proactive reporting guidance in the default system prompt. A credible platform failure or incorrect product result leads to one saved local draft per issue, including already observed facts and attempted recovery, plus a strong recommendation to review and send it. A workaround does not erase the failure. User-code mistakes and expected refusals are distinguished from product defects. Agents preserve the original task, respect a request not to prepare reports, and cannot consent or bypass submission approval.

Service dispatch classifies untyped handler exceptions as internal failures and invalid service returns as protocol failures; explicitly typed domain errors retain their categories. Native IPC observes executed server-call failures, including their existing diagnostic identity, without reporting pre-dispatch authorization refusals as executed operations. Capture deduplicates exact diagnostic origins, retains incidents locally, and automatically queues eligible errors only after current opt-in. Runtime/build lifecycle failures use structured host-owned observations; free-text console output is not promoted into an automatic report. Reporting failures are excluded from recursive capture. Exact frozen bytes flow through machine signing, the durable outbox, and receipt verification.

Verification includes the real dispatcher-to-capture-to-signed-delivery flow, unknown/off gating, expected domain errors, diagnostic replay deduplication, native IPC forwarding, independent device/server decisions, and a headless agent scenario whose user never asks for a report. The unchanged proactive scenario passed with zero failed tool calls on 2026-09-30 (`st_29e91854d18647d98ef9d0af9ac9119a`); its managed instance was stopped. Production Cloudflare intake now accepts signed anonymous reports, serves exact bundles only to authenticated administration, and deletes submitted content. See [reporting operations](problem-reporting-operations.md) for deployed storage, checks, and the separate packaged-template release boundary.
