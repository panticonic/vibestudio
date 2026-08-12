# Automations API

Resolve protocol `vibestudio.missions.v1` with `workers.resolveService(...)`,
then call the returned Durable Object target with `rpc.call(targetId, method,
args)`. The service is context-aware and user-scoped.

This service owns the complete automation lifecycle: definition and human
review, schedule delivery, non-overlapping execution, durable run history,
terminal summaries and errors, and agent-conversation identity. Callers must
not create a second timer, queue, conversation loop, or run ledger around it.

## Charter

```ts
type Charter = {
  summary: string;
  harness: { unit: string; ev: string }; // exact 64-hex EV
  execution:
    | {
        kind: "method";
        target: { source: string; className: string; objectKey: string };
        method: string;
        args: unknown[];
      }
    | {
        kind: "agent";
        target: { source: string; className: string; objectKey: string };
        action:
          | { kind: "prompt"; text: string }
          | {
              kind: "eval";
              code: string;
              syntax?: "javascript" | "typescript" | "jsx" | "tsx";
              timeoutMs?: number;
              reset?: boolean;
            };
        conversation:
          | { mode: "fresh" }
          | { mode: "continue"; channelId: string; contextId: string };
        toolExposure: {
          services: string[];
          userlandServices: Array<{
            name: string;
            provider: string;
            providerEv: string;
            upgradePolicy: "pinned" | "follow-head";
          }>;
          workspaceServiceDiscovery: "bound" | "live-declarations";
          evalNetwork: "none" | "declared-origins" | "unrestricted";
          declaredOrigins: string[];
        };
        declaredLineageClasses: Array<"none" | "web" | "email" | "channel-external" | "external">;
      };
  trigger:
    | { kind: "manual" }
    | {
        kind: "schedule";
        everyMs: number;
        anchorAt?: number;
        jitterMs?: number;
        untilAt?: number;
        maxRuns?: number;
      }
    | {
        kind: "cron";
        expression: string; // five-field Vixie cron
        timezone: string;   // canonical IANA timezone
        untilAt?: number;
        maxRuns?: number;
      };
};
```

The harness unit must equal the execution target source. Every behavior-bearing
field participates in the reviewed closure digest. `agent/eval` stores exact
inline EvalDO source in that closure and is the happy path for a small script
that should run as an existing agent/channel participant. It deliberately does
not accept a mutable context-file path or npm import map. Use ambient runtime
bindings and automatically resolved workspace APIs; move a multi-file or
dependency-heavy job into a reviewed method worker.

The eval action is model-free. AgentDO journals `message.completed` with the
tool call, `invocation.started`, the terminal eval result, and `turn.closed` in
the ordinary channel trajectory. EvalDO receives `approvals:
"pregranted-only"`; the run cannot stall on an unattended approval card. Code
may use ambient `chat` to publish typed/custom messages with the agent's
identity. The mission service remains the only schedule and run-ledger owner.

Interval schedules are elapsed-time cadences with an optional alignment anchor
and jitter. Cron schedules are wall-clock cadences evaluated in the reviewed
IANA timezone, including daylight-saving transitions. Both accept `untilAt`
(no new run starts at or after the boundary) and `maxRuns` (total admitted runs;
failures count and overlap skips do not). The count survives revisions.

A prompt tick can end its recurring goal by calling
`complete_automation({ response })`. Eval and method executions return the same
signal as data:

```ts
return {
  protocol: "automation-completion.v1",
  response: "All rollout targets are healthy; monitoring is complete.",
};
```

Ordinary successful results continue the schedule. The explicit completion
response transitions the definition to `completed`, is retained on the run and
definition, and wins over a count/time boundary reached on that same run.

## Methods

| Method          | Arguments                                               | Result                                                     | Use                                         |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `overview`      | `{ limit?, cursor?, filter?, query? }`                  | paged definitions, global counts, recent runs and failures | supervision dashboards and quick inspection |
| `list`          | none                                                    | all visible definitions                                    | definition tooling                          |
| `get`           | `missionId`                                             | definition or `null`                                       | addressed inspection                        |
| `listRuns`      | `missionId`, `{ limit?, cursor? }`                      | `{ items, nextCursor? }`                                   | paged historical ledger                     |
| `getRun`        | `runId`                                                 | exact run or `null`                                        | chat tick inspection                        |
| `proposeDraft`  | `{ name, charter, permissions, standingRestrictions? }` | inert draft                                                | agent proposals                             |
| `createDraft`   | same as `proposeDraft`                                  | inert draft                                                | trusted user/code tooling                   |
| `edit`          | `missionId`, changed fields                             | new inert revision                                         | behavior changes                            |
| `requestReview` | `missionId`                                             | active definition after approval                           | human review surfaces only                  |
| `runNow`        | `missionId`                                             | new run record                                             | explicit manual execution                   |
| `pause`         | `missionId`                                             | paused definition                                          | stop future triggers                        |
| `resume`        | `missionId`                                             | active definition                                          | resume unchanged reviewed closure           |
| `retire`        | `missionId`                                             | retired definition                                         | permanent shutdown                          |

`overview` defaults to 30 definitions and accepts at most 50. Its `stats`
contains global `total`, `active`, `running`, `failedLast24Hours`, and
`awaitingReview`, and `completed` counts regardless of the page or filter.
Filters are `all`, `attention`, `active`, `paused`, `completed`, and `drafts`;
`query` searches names and
summaries on the server. Pass its exact `nextCursor` to fetch another page.

`listRuns` defaults to 20 and accepts at most 100. Pass the exact
`nextCursor` returned by the preceding page.

Ordinary agent sessions can discover and call `edit`, `runNow`, `pause`,
`resume`, and `retire` through the live service catalog, subject to their normal
gated/critical authority. `requestReview` is intentionally not agent-facing;
only a human review surface may activate a draft or edited revision.

## Run record

```ts
type Run = {
  runId: string;
  missionId: string;
  closureDigest: string;
  revision: number;
  trigger: "manual" | "scheduled";
  status: "starting" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: number;
  runNumber?: number; // absent only for visible overlap skips and old history
  finishedAt?: number;
  channelId?: string;
  contextId?: string;
  finalMessage?: string;
  completionResponse?: string;
  error?: string;
};
```

Agent runs close from the exact terminal turn. Method runs close after their RPC
returns or throws. Stored final messages and errors are bounded; full agent
detail remains in the linked conversation. `channelId` and `contextId` are the
canonical deep-link identity for that conversation; do not derive a link from
names or run order.

Mission records also include lifetime `runCount`, `activatedAt` after first
human activation, and—when naturally ended—`completedAt`, `completionReason`
(`until`, `max-runs`, or `response`), and optional `completionResponse`. Chat
turn metadata carries a bounded immutable tick snapshot—mission/run ids, run
number, name, revision, action, trigger, schedule, creation/activation times—so
collapsed history pills render without network reads. Opening a pill lazily
calls `get` and `getRun` for current controls and full bounded details.
