---
name: provenance-orientation
description: Trace origin, causation, incorporation, copy lineage, integration decisions, or external import boundaries from an exact managed path, session, event, application, work unit, change, decision, command, invocation, or typed semantic root.
---

# Provenance orientation

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) first. Provenance is the
adjacency of semantic VCS and trajectory records, not a parallel memory store.

## Start at the decision boundary

An ordinary managed-text `read` already attaches a bounded explanation for the
displayed lines. Stop when it answers the question. Continue only when history
can change the next action: unfamiliar code, integration, ambiguous intent,
copy attribution, or an import boundary.

Use the friendly tool for a session, managed path, or returned semantic root:

```ts
provenance({ target: "session" });
provenance({ target: "packages/example/src/index.ts" });
provenance({ target: "change:…" });
```

Pass roots and edge endpoints back unchanged. Event, application, work-unit,
change, decision, and command shorthands are accepted. Trajectory invocations,
turns, and messages require their complete typed coordinates because their
local IDs are not globally unique.

## Choose the smallest read

- `vcs.inspect` returns one exact node, its reusable root, and a bounded edge
  preview.
- `vcs.neighbors` pages immediate edges.
- `vcs.history` pages committed event ancestry or changes to one stable file
  identity.
- `vcs.blame` traces an exact file range through content mappings.

Continue a page with the same target and returned cursor. Start a separate read
when the question changes. Use live schemas for edge kinds and node shapes; do
not parse IDs, construct private roots, query semantic tables, or cache a client
graph.

## Interpret evidence narrowly

Keep actor, executor, cause, intent, authorization, and content origin
separate. An edge records a relationship, not the truth of every upstream
claim. Walk to the exact change, work unit, decision, command, event, or
trajectory record needed for a consequential conclusion.

Intent tiers are not interchangeable: `stated` is explicit purpose, `trigger`
is durable assignment evidence, and `mechanical` describes only the effect. Do
not invent private reasoning or authorship from a turn summary.

A copy should reach its immediate source coordinate. An integration explanation
should reach the decision and source changes it accounted for. At an external
import boundary, report the recorded source kind, credential-free URI,
revision, digest, and target repositories as snapshot facts. Importer intent
explains why bytes entered Vibestudio; it does not identify the earlier file
author or external committer.
