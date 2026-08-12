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
        prompt: string;
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
    | { kind: "schedule"; everyMs: number; anchorAt?: number; jitterMs?: number };
};
```

The harness unit must equal the execution target source. Every behavior-bearing
field participates in the reviewed closure digest. For a periodic script, the
script's entry point is the method target above; arbitrary shell commands and
source snippets are not stored in the charter.

## Methods

| Method          | Arguments                                               | Result                                                     | Use                                         |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `overview`      | `{ limit?, cursor?, filter?, query? }`                  | paged definitions, global counts, recent runs and failures | supervision dashboards and quick inspection |
| `list`          | none                                                    | all visible definitions                                    | definition tooling                          |
| `get`           | `missionId`                                             | definition or `null`                                       | addressed inspection                        |
| `listRuns`      | `missionId`, `{ limit?, cursor? }`                      | `{ items, nextCursor? }`                                   | paged historical ledger                     |
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
`awaitingReview` counts regardless of the page or filter. Filters are `all`,
`attention`, `active`, `paused`, and `drafts`; `query` searches names and
summaries on the server. Pass its exact `nextCursor` to fetch another page.

`listRuns` defaults to 20 and accepts at most 100. Pass the exact
`nextCursor` returned by the preceding page.

## Run record

```ts
type Run = {
  runId: string;
  missionId: string;
  closureDigest: string;
  trigger: "manual" | "scheduled";
  status: "starting" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: number;
  finishedAt?: number;
  channelId?: string;
  contextId?: string;
  finalMessage?: string;
  error?: string;
};
```

Agent runs close from the exact terminal turn. Method runs close after their RPC
returns or throws. Stored final messages and errors are bounded; full agent
detail remains in the linked conversation. `channelId` and `contextId` are the
canonical deep-link identity for that conversation; do not derive a link from
names or run order.
