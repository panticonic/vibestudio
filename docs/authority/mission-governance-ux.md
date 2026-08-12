# Automation governance and supervision

Status: implemented architecture and product contract (2026-08-12)

The product calls these records **Automations**. The authority subsystem keeps
the internal `mission` name because each automation is a reviewed,
content-addressed mission closure. There is one system for periodic scripts and
periodic agent work: `MissionsDO` owns schedules, lifecycle, reviewed
closures, alarms, and the run ledger.

## Product model

An automation combines four decisions:

1. **Exact code** — one harness unit at one effective version.
2. **Execution** — a Durable Object method, or an agent action: a prompt sent
   through the ordinary turn loop or exact inline code journaled and run in the
   agent's channel-bound EvalDO without a model call.
3. **Trigger** — manual, an explicit elapsed interval with optional epoch
   anchor/jitter, or a five-field cron calendar in one reviewed IANA timezone.
   Scheduled triggers may also declare an exclusive end time and/or maximum
   lifetime run count.
4. **Authority boundary** — agent service exposure, network reach, expected
   content lineage, standing permission rows, and standing restrictions.

Agent execution has an additional conversation policy:

- `continue` reuses one exact context, channel, and agent identity.
- `fresh` creates an isolated context, channel, and agent identity for each
  run. The conversation remains addressable from that run's ledger entry.

The exact charter, permission rows, and restrictions produce a closure digest.
Display name, owner, lifecycle state, and timestamps do not. Editing behavior
lapses the reviewed closure and moves the record to `needs-reapproval`.

The v2-to-v3 migration is deliberately one-way. It rewrites the former
agent-only `prompt` field into the shared `action: { kind: "prompt" }` model,
preserves the old record in revision history, and converts any formerly armed
record into an inert revision that requires review. There is no runtime legacy
reader and no old schedule is silently continued under a newly shaped closure.
The v3-to-v4 migration rebuilds the definition and run tables into the same
constrained schema used by new workspaces, derives lifetime run numbers and
their best-known historical revisions, and retains every run. There is no
nullable or alternate legacy run path after migration.

## Lifecycle and review

```text
draft ──review──▶ active ──edit──▶ needs-reapproval ──review──▶ active
                    │  ▲                                      │
                    │  └────────── pause / resume ─────────────┘
                    ├── until / max runs / completion response ──▶ completed
                    └── retire ──▶ retired
```

Agents call `proposeDraft`; this grants nothing, schedules nothing, and cannot
open the review decision for the user. Agent sessions may edit and control
reviewed automations through the ordinary gated service surface, but
`requestReview` remains human-only. A schedule is armed only after activation.

Pause suspends the reviewed closure and disarms the next occurrence without
discarding history or cadence origin. Resume reactivates the unchanged closure
and selects the next occurrence on the same cadence. Retirement is terminal;
the record, run history, and conversations remain inspectable.

Completion is a natural terminal state rather than a pause or retirement. A
completed definition stays fully inspectable and editable. Editing it preserves
its lifetime run count, clears the completion snapshot, lapses the old reviewed
closure, and produces a new inert revision.

Method automations cannot declare agent permission rows. Their installed exact
code remains the sole authority ceiling. Agent automations execute under the
reviewed mission subject; fresh agents therefore do not require a fictional
pre-existing agent grant.

## Schedule and completion contract

Elapsed schedules use `{ kind: "schedule", everyMs, anchorAt?, jitterMs? }`.
With an anchor, the base cadence is `anchorAt + n * everyMs`; without one,
activation is the stored cadence origin. This representation is independent of
server timezone and DST and is the direct representation for “every five
minutes starting now.”

Calendar schedules use
`{ kind: "cron", expression, timezone }`. `expression` is a five-field Vixie
cron expression with minute precision; `timezone` is a canonical IANA name.
The calendar engine handles named weekdays/months, lists, ranges, steps,
standard nicknames, and advanced calendar modifiers without inheriting the
host timezone. Thus `5 5 * * THU` in `America/New_York` remains Thursday at
5:05 a.m. through daylight-saving transitions.

The minimum interval is one minute. Jitter must be smaller than the interval.
Only one run per automation may be starting or running. A competing trigger is
recorded as `skipped`, with the active run named in its error field. It is never
silently dropped and never creates an overlapping execution path.

Both scheduled trigger forms accept `untilAt` and `maxRuns`. No run starts at
or after `untilAt`. `maxRuns` counts admitted executions across the definition's
lifetime—including failures but excluding overlap skips—and is not reset by a
revision. If an in-flight run crosses its time boundary, the scheduler disarms
future occurrences and the ordinary terminalization path completes the
definition when that run ends.

A prompt tick can call the automation-only `complete_automation` tool. A method
or inline eval returns
`{ protocol: "automation-completion.v1", response: string }`. All three feed the
same terminalization path, store the response on the run and definition, and
transition the definition to `completed`. Completion suspends the reviewed
closure before committing that terminal state. A completion response wins over
a time/count condition reached on the same terminal run so the human-meaningful
outcome is preserved.

## Run ledger

Every manual or scheduled trigger creates a durable run record with:

- closure digest, exact definition revision, lifetime run number, and trigger
  source;
- starting, running, succeeded, failed, or skipped status;
- start/finish timestamps and exact executor;
- reviewed-closure session id;
- agent channel/context coordinates where applicable;
- bounded natural-completion response, terminal message, or error.

Method results are summarized after the method returns. Agent runs carry a
bounded immutable automation/tick snapshot in turn metadata. The exact terminal
turn closes the ledger record and stores its final assistant message or eval
result. Conversation content is not copied into the ledger beyond that bounded
summary.

Historical reads are deliberately bounded. `overview` returns one cursor page
of visible definitions, at most five recent runs per definition, aggregate
total/active/completed/recent-failure counts, and at most eight failures from
the last 24 hours.
`listRuns` provides cursor pagination for older history; `getRun` addresses one
tick directly for a chat-history inspector.

## Shared supervision UI

The Automations panel and the scheduled-activity pill in chat share the same
definition/tick inspector and controls. Collapsed chat pills render entirely
from durable turn metadata and issue no RPCs; opening one lazily reads exactly
one definition and one run. The dashboard remains a supervision surface, not a
draft prototype:

- top-level counts distinguish active and completed definitions, live runs,
  failures in the last 24 hours, and inert definitions waiting for review;
- a dedicated needs-attention region collects recent failures without hiding
  the owning automation;
- search and state filters keep large registries scannable;
- each automation shows interval or cron/timezone schedule, next occurrence,
  end policy, run progress, action/conversation policy, reviewed authority,
  lifecycle controls, and paged run history;
- run rows show trigger, run number, duration, completion response/final
  message/error, and a direct link to the exact conversation;
- both surfaces show cadence, end policy, first activation, exact tick
  provenance, and edit plus stop/resume controls; edits stop execution and
  require review;
- retirement requires confirmation and explains what remains available;
- empty, loading, no-match, error, running, and healthy states all have explicit
  copy and accessible live status;
- the panel loads one overview packet, never an N+1 history fan-out, and polls
  only while runs are active and the document is visible.

Primary vocabulary is plain language. Exact EVs, source/class/object identity,
network details, and full prompts live under an explicit developer disclosure.

## Invariants

- `MissionsDO` is the sole alarm and schedule owner for automations.
- There is one run ledger and one terminalization path.
- Agent prompts use `AgentVesselBase.runAutomationTurn`; exact inline scripts
  use `runAutomationEval`, which journals one ordinary eval invocation through
  the same agent loop and EvalDO. There is no heartbeat loop, alternate PubSub
  identity, scheduler-owned eval engine, or special model-call path.
- A draft is inert and cannot grant or execute anything.
- A behavior change requires a new reviewed closure.
- Interval and calendar triggers share one alarm owner, admission gate, overlap
  rule, terminalization path, and run ledger.
- Time, count, and response completion all produce the same durable `completed`
  lifecycle state.
- Run/conversation coordinates are durable and directly navigable.
- Unbounded run-history reads and per-automation polling are not allowed.
- Workspace config does not contain recurring or heartbeat declarations.

Agent-facing authoring instructions and exact examples live in
`workspace/skills/automations/`.
