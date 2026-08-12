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
triggered unattended task. It is the only scheduling system: do not add cron
configuration, heartbeat loops, timers, a second alarm owner, or an independent
run log.

An automation draft is inert. An agent may propose one with `proposeDraft`, but
only the user can review its exact code, schedule, reach, and standing authority
in the **Automations** panel. Never imply that a proposal is already scheduled.

Read [API.md](API.md) before authoring a draft. Use one of two execution forms:

- **Method** runs one RPC method on an exact Durable Object build. Package a
  periodic script as a narrow exported method and use this form for deterministic
  jobs that do not need an agent conversation.
- **Agent** sends a prompt through the ordinary agent turn loop. It can continue
  one existing conversation or create an isolated agent, context, and
  conversation for each run.

Typical choices are:

| User intent                                                  | Execution | Conversation                     |
| ------------------------------------------------------------ | --------- | -------------------------------- |
| “Refresh these figures every hour.”                          | Method    | None                             |
| “Review project changes every Friday.”                       | Agent     | Fresh run each time              |
| “Revisit the open risks in this conversation every morning.” | Agent     | Continue this exact conversation |

## Turn an intent into a reviewable draft

1. Confirm only details that materially change the work: what should run, the
   cadence and timezone, and—only for agent work—whether runs should be fresh or
   continue one exact conversation. Prefer an explicit recommendation over a
   questionnaire.
2. Reuse an existing suitable worker or agent target. If none exists, use
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
      trigger: { kind: "schedule", everyMs: 86_400_000 },
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
  prompt: "Review this week's project changes and finish with the three most important risks.",
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
  prompt: "Revisit the open risks and report what changed.",
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
}
```

The interval is at least one minute. Without `anchorAt`, activation becomes the
cadence origin. With it, occurrences align to `anchorAt + n * everyMs`. This is
timezone- and DST-independent; compute a local-time anchor explicitly when the
human request is expressed in local time and state the chosen timezone in the
summary. Jitter delays an occurrence within the declared bound.

Runs never overlap. If a trigger arrives while the previous run is starting or
running, the ledger records a visible `skipped` run instead of creating hidden
parallel work.

## Supervise and diagnose

Use `overview` for a bounded snapshot. It returns a cursor-paged definition
view, global supervision counts, at most five recent runs per returned
automation, and a capped list of failures from the last 24 hours. Use its
server-side `filter` and `query` options instead of fetching every definition.
Use `listRuns` with its returned cursor for older history; never fetch an
unbounded ledger or poll every automation.

The **Automations** panel is the supervision surface. Its overview calls out
running work, drafts awaiting review, and failures from the last 24 hours.
Search and server-side filters keep large collections responsive. Each
definition exposes bounded recent runs and paged history; each run shows its
terminal message or error and links to the exact conversation when it has one.
The panel auto-refreshes only while a run is active. `starting` and `running`
are live states; `succeeded`, `failed`, and `skipped` are terminal.

Use `runNow`, `pause`, `resume`, and `retire` only when the user explicitly asks
for that lifecycle action. Retirement is terminal. Editing any behavior-bearing
field lapses the reviewed closure and returns the automation to review.
