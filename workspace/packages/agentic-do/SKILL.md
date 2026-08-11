---
name: agentic-do
description: Work on @workspace/agentic-do agent runtime behavior, including model/provider defaults, live session tuning, and subagent delegation/supervision tools.
---

# Agentic DO

Use this skill when work is specific to the `@workspace/agentic-do` package: the
standard agent runtime, model/provider defaults, credential setup wiring, live
agent session knobs, or the subagent tool surface.

Read the local reference that matches the task before editing:

- [Agent tuning](references/agent-tuning.md) for default model/provider changes,
  model credential setup, thinking effort, approval, and response policy.
- [Subagents](references/subagents.md) for `spawn_subagent`, child task channels,
  child context inspection, semantic integration, cancellation, and retained terminal results.
- [Failures and diagnostics](references/failures-and-diagnostics.md) for the
  canonical tool-failure envelope, primary/cleanup ordering, bounded invocation
  diagnostic packets, and paged outside-lineage explanation.

Keep package boundaries explicit. Core runtime mechanics live in this package;
projection/rendering details can live in sibling packages such as
`../agentic-core` or `../agentic-protocol`, and the standard chat worker lives
under `../../workers/agent-worker`.

## Structured channel observations

A channel subscription can opt an agent into exact non-chat payload kinds:

```ts
{
  name: "Incident agent",
  observations: {
    payloadKinds: ["application.incident.v1"]
  }
}
```

Matching is exact: there are no wildcards, filters, or kind registry. Presence
and `agentic.trajectory.v1/event` are reserved for their existing infrastructure
routes and cannot be observed. A subscription only auto-wakes for observations
when its `wakePolicy` is `every-envelope`; `explicit` and `manual` suppress them.
Self-authored events are always excluded.

The model receives a readable prompt paired with a structured sidecar:

```ts
{
  role: "user",
  content: {
    message: "Channel observation: application.incident.v1",
    structuredInput: {
      kind: "channel-observation",
      version: 1,
      source: {
        channelId,
        envelopeId,
        sequence,
        payloadKind: "application.incident.v1",
        timestamp,
        sender
      },
      payload
    }
  }
}
```

The source envelope ID supplies deterministic prompt identity. Redelivery and
replay therefore do not create duplicate turns, while different envelope IDs
remain different inputs. Observations arriving during an open turn use the
normal steering path. Payloads whose canonical JSON exceeds 32,768 characters
are replaced with `payload: null` plus an 8,192-character canonical preview and
the original character count.

Observation configuration controls model delivery, not privacy. The channel
still persists and exposes events according to its own membership, delivery,
and access rules; only public participant metadata is copied into the
model-facing sender reference.
