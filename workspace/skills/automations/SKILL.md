---
name: automations
description: Schedule recurring scripts or agent prompts, propose reviewable automation drafts, and supervise runs, conversations, results, and errors.
---

# Automations

Use this skill when a user asks to run work repeatedly or later: “every hour,”
“each morning,” “weekly,” “periodically,” “on a schedule,” or similar language.
It covers deterministic scripts and unattended agent turns. The user does not
need to know which form they need.

Use the `vibestudio.missions.v1` service for every recurring or manually
triggered unattended task. It is the only scheduling system: express calendar
cadence with its `cron` trigger rather than adding worker-level cron
configuration, heartbeat loops, timers, a second alarm owner, or an independent
run log.

An automation draft is inert. An agent may propose one with `proposeDraft`, but
only the user can review its exact code, schedule, reach, and standing authority
in the **Automations** panel. Never imply that a proposal is already scheduled.

Read [API.md](API.md) before authoring a draft. Use one of two execution forms,
with two first-class actions on the agent form:

- **Method** runs one RPC method on an exact Durable Object build. Package a
  periodic script as a narrow exported method and use this form for deterministic
  jobs that do not need an agent conversation.
- **Agent** sends a prompt through the ordinary agent turn loop. It can continue
  one existing conversation or create an isolated agent, context, and
  conversation for each run. Its reviewed action is either a normal model
  `prompt` or exact inline `eval` code executed without a model call. Eval is the
  light-weight script path: it uses the selected agent's channel-bound EvalDO,
  so it needs no newly published worker.

Typical choices are:

| User intent                                                  | Execution                                                       | Conversation                     |
| ------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------- |
| “Refresh these figures every hour.”                          | Agent eval for a small inline job; method for a reusable worker | Fresh or continuing              |
| “Review project changes every Friday.”                       | Agent                                                           | Fresh run each time              |
| “Revisit the open risks in this conversation every morning.” | Agent                                                           | Continue this exact conversation |

## Turn an intent into a reviewable draft

1. Confirm only details that materially change the work: what should run, the
   cadence and timezone, optional end time or maximum total runs, and—only for
   agent work—whether runs should be fresh or continue one exact conversation.
   Also establish what outcome, if any, should naturally complete the recurring
   goal. Prefer an explicit recommendation over a questionnaire.
2. Reuse an existing suitable worker or agent target. A small exact script can
   target an existing agent with the `eval` action and does not require a new
   worker. If no suitable agent/worker exists, use
   [Workspace development](../workspace-dev/SKILL.md) to create and verify one.
   Do not put meaningful task code inside the scheduler.
3. Resolve the target's exact effective version, then call `proposeDraft` with
   the complete charter and least authority needed.
4. Tell the user what will run and when, and that the inert draft is waiting in
   **Automations** for review. Do not say it is scheduled until the user approves
   it there.

One user request produces one automation definition. Do not split scheduling,
execution, history, or approval across parallel mechanisms.

## Propose an automation

Resolve the target's current exact effective version and the missions service
in the same eval. The harness unit and execution source must be the same
canonical workspace repo path.

```ts
import { rpc, workers } from "@workspace/runtime";

const unit = "workers/daily-report";
const ev = await rpc.call<string | null>("main", "build.getEffectiveVersion", [unit]);
if (!ev) throw new Error(`Build ${unit} before proposing its automation`);

const missions = await workers.resolveService("vibestudio.missions.v1");
if (missions.kind !== "durable-object") {
  throw new Error("The automations service is unavailable");
}

return rpc.call(missions.targetId, "proposeDraft", [
  {
    name: "Daily report",
    charter: {
      summary: "Collect the daily figures and store a concise report.",
      harness: { unit, ev },
      execution: {
        kind: "method",
        target: {
          source: unit,
          className: "DailyReportDO",
          objectKey: "daily-report",
        },
        method: "buildReport",
        args: [],
      },
      trigger: {
        kind: "cron",
        expression: "0 7 * * *",
        timezone: "America/New_York",
        maxRuns: 30,
      },
    },
    permissions: [],
  },
]);
```

After a successful proposal, tell the user its name and that it is waiting in
Automations. The panel shows the exact target, schedule, conversation behavior,
reach, and standing authority before activation. Do not call `requestReview`
for them.

## Choose conversation behavior deliberately

For an isolated agent and conversation on every run:

```ts
execution: {
  kind: "agent",
  target: {
    source: "workers/research-agent",
    className: "ResearchAgent",
    objectKey: "weekly-research",
  },
  action: {
    kind: "prompt",
    text: "Review this week's project changes and finish with the three most important risks.",
  },
  conversation: { mode: "fresh" },
  toolExposure: {
    services: ["build.listUnits", "vcs.status"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  declaredLineageClasses: ["none"],
}
```

For a specific existing agent conversation, use its exact runtime identity and
channel context:

```ts
execution: {
  kind: "agent",
  target: {
    source: "workers/research-agent",
    className: "ResearchAgent",
    objectKey: "project-researcher",
  },
  action: { kind: "prompt", text: "Revisit the open risks and report what changed." },
  conversation: {
    mode: "continue",
    channelId: "project-research",
    contextId: "ctx-project-research",
  },
  toolExposure: {
    services: ["build.listUnits", "vcs.status"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  declaredLineageClasses: ["none"],
}
```

For an exact small script, keep the code inline and let it run as the selected
agent in that conversation:

```ts
execution: {
  kind: "agent",
  target: {
    source: "workers/agent-worker",
    className: "AiChatWorker",
    objectKey: "project-health",
  },
  action: {
    kind: "eval",
    code: `
      const status = await services.vcs.status({ contextId: ctx.contextId });
      const result = { workingHead: status.workingHead, checkedAt: Date.now() };
      await chat.publish("project.health.checked", result, {
        idempotencyKey: "health:" + result.checkedAt,
      });
      if (status.clean) {
        return {
          protocol: "automation-completion.v1",
          response: "The project is clean; recurring checks are no longer needed.",
        };
      }
      return result;
    `,
    syntax: "typescript",
    timeoutMs: 30_000,
  },
  conversation: { mode: "fresh" },
  toolExposure: {
    services: ["vcs.status"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  declaredLineageClasses: ["none"],
}
```

Scheduled eval is not an alternate sandbox or message path. The agent loop
journals the exact source as a normal `eval` tool invocation, EvalDO executes
it with `approvals: "pregranted-only"` under the reviewed mission closure, and
the invocation result closes the exact run. Ambient `chat` can publish typed or
custom channel messages with the agent's identity. Do not use `chat.send` for
status: it is user-intent ingress and can begin another agent turn.

Use `fresh` when runs should be independent, easily audited, and unaffected by
old conversation state. Use `continue` when accumulated conversation context is
part of the task. Do not emulate either mode by generating channel ids or
submitting messages yourself; the automation owner performs the full lifecycle.

## Authority and reach

`toolExposure` is the structural addressability bound for an agent run:

- `services` contains exact `service.method` names or a service-local `name.*`.
  Global `*` is invalid.
- `userlandServices` contains resolved provider bindings, never an unresolved
  display name. Prefer an exact provider EV and `upgradePolicy: "pinned"`.
- `workspaceServiceDiscovery: "bound"` uses only reviewed bindings.
  `"live-declarations"` cannot be combined with pinned bindings.
- `evalNetwork` is `none`, `declared-origins`, or `unrestricted`.
  Declared origins must be canonical origins such as `https://example.com`.
- `declaredLineageClasses` states the outside-content classes expected by the
  work. It must be non-empty and contain no duplicates.

`permissions` contains the standing gated/critical capability rows shown in
review. A method automation must use `permissions: []`: its installed code
authority remains the only authority for that method. Do not widen exposure or
permissions to make a denial disappear; revise the draft to describe the real
task and let the user evaluate the change.

## Scheduling semantics

Use `{ kind: "manual" }` for reviewable run-on-demand work. A periodic schedule
is:

```ts
{
  kind: "schedule",
  everyMs: 3_600_000,
  anchorAt: Date.UTC(2026, 7, 12, 6, 0), // optional epoch cadence origin
  jitterMs: 300_000,                    // optional, always less than everyMs
  untilAt: Date.UTC(2026, 8, 1),        // optional exclusive start boundary
  maxRuns: 100,                         // optional total admitted executions
}
```

The interval is at least one minute. Without `anchorAt`, activation becomes the
cadence origin. With it, occurrences align to `anchorAt + n * everyMs`. This is
timezone- and DST-independent; compute a local-time anchor explicitly when the
human request is expressed in local time and state the chosen timezone in the
summary. Jitter delays an occurrence within the declared bound. Use this form
for “every five minutes starting now” and other elapsed-time cadences.

For a wall-clock calendar cadence, use a five-field Vixie cron expression and
an explicit canonical IANA timezone:

```ts
{
  kind: "cron",
  expression: "5 5 * * THU",       // minute hour day-of-month month weekday
  timezone: "America/New_York",
  untilAt: Date.UTC(2026, 11, 31),  // optional
  maxRuns: 20,                      // optional
}
```

This means every Thursday at 5:05 a.m. New York time. Expressions support
lists, ranges, steps, month/weekday names, and the calendar modifiers accepted
by the service (`L`, `W`, `#`, and `+`), plus standard nicknames such as
`@daily`. Calendar evaluation follows the declared timezone across daylight
saving changes; it never inherits the host timezone. The five-field contract
has minute precision and the same one-minute minimum as interval schedules.

`untilAt` means no run begins at or after that epoch-millisecond boundary.
`maxRuns` is the lifetime total for the automation, not a per-revision counter:
admitted successful and failed runs count, while visible overlap skips do not.
When both are present, the first boundary reached ends the automation. Editing
a completed automation can raise the maximum or move the boundary, but creates
an inert revision that must be reviewed before it runs again.

Runs never overlap. If a trigger arrives while the previous run is starting or
running, the ledger records a visible `skipped` run instead of creating hidden
parallel work.

## Complete a recurring goal naturally

A successful tick normally leaves the schedule active. End it only when the
recurring goal itself is finished:

- A prompt automation calls the built-in `complete_automation` tool with a
  concise `response`. The tool is valid only during an automation turn and
  closes that turn successfully.
- An inline eval or method returns
  `{ protocol: "automation-completion.v1", response: "…" }`.

The response is stored on both the terminal run and the completed automation,
shown prominently in chat history and Automations, and prevents future ticks.
Do not use the completion protocol merely to report that one periodic check
succeeded. A completion response wins over a time or count boundary reached by
that same terminal run, preserving the automation's meaningful final result.

## Supervise and diagnose

Use `overview` for a bounded snapshot. It returns a cursor-paged definition
view, global supervision counts, at most five recent runs per returned
automation, and a capped list of failures from the last 24 hours. Use its
server-side `filter` and `query` options instead of fetching every definition.
Use `listRuns` with its returned cursor for older history; never fetch an
unbounded ledger or poll every automation.

The **Automations** panel and each scheduled tick's chat-history pill share the
same supervision surface. The overview calls out
running work, naturally completed definitions, drafts awaiting review, and
failures from the last 24 hours.
Calendar schedules are presented as plain-language rules such as “Every
Thursday at 5:05 AM in New York time.” Editing common hourly, daily, weekly,
and monthly rules uses time controls, weekday choices, and timezone search.
Advanced cron stays lossless behind an Advanced control with a field legend,
live validation, a human interpretation, and five concrete upcoming runs; the
raw expression is never the only explanation shown to the user.
Search and server-side filters keep large collections responsive. Each
definition exposes bounded recent runs and paged history; each run shows its
terminal message or error and links to the exact conversation when it has one.
Opening a history pill lazily loads only that definition and tick, showing the
cadence and timezone, end policy, lifetime run progress, first activation,
exact revision, duration, completion response or result/error, and reviewed
execution. It also offers edit, stop/resume, review, and run-now controls.
Collapsed transcript pills perform no service reads. The panel auto-refreshes
only while a run is active. `starting` and `running`
are live states; `succeeded`, `failed`, and `skipped` are terminal.

Agents can use the agent-facing `edit`, `runNow`, `pause`, `resume`, and
`retire` methods when the user explicitly asks for that lifecycle action.
`requestReview` remains human-only: an agent may prepare the exact revision,
but the user activates it from the shared inspector or Automations panel.
Retirement is terminal. Editing any behavior-bearing field stops the schedule,
lapses the reviewed closure, and returns the automation to review.
Natural completion is not retirement: history remains inspectable and the
definition can be edited into a new reviewable revision.
