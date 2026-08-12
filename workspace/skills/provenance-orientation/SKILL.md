---
name: provenance-orientation
description: Trace origin, causation, lineage, integration decisions, or import boundaries from a managed path, session, event, or semantic root.
---

# Provenance orientation

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) first. Provenance is the
adjacency of semantic VCS and trajectory records, not a parallel store.

## Start at the decision boundary

A managed-text `read` already attaches a bounded explanation for the displayed
lines. Stop when it answers the question. Continue only when history changes the
next action: unfamiliar code, integration, ambiguous intent, copy attribution,
or an import boundary.

```ts
provenance({ target: "session" });
provenance({ target: "packages/example/src/index.ts" });
provenance({ target: "change:…" });
```

`target` is the sole selector: start with a friendly target, then pass every
returned compact `@ref` through the same field. Trusted state retains exact
typed roots; do not repeat long content-addressed identities. Event,
application, work-unit, change, decision, and command string shorthands remain
accepted through `target`.

## Choose the smallest read

- `provenance({ target })` — resolve a managed path/identity or follow one `@ref`.
- `provenance({ target: ref })` — follow an endpoint or continue the advertised stream.
- `vcs({ operation: "blame", ... })` — trace an exact file range through content
  mappings.

Continue by copying the advertised `provenance({ target: ref })` call unchanged.
The channel-scoped ref durably retains the exact root, stream, page, query, and
opaque service cursor inside trusted code. Never add a page or cursor. Start a separate read when the
question changes. Use live schemas for edge kinds and node shapes; never parse
IDs, construct private roots, query semantic tables, or cache a client graph.

## Interpret evidence narrowly

Keep actor, executor, cause, intent, authorization, and content origin separate.
An edge records a relationship, not the truth of every upstream claim. Walk to
the exact change, work unit, decision, command, event, or trajectory record
needed for a consequential conclusion.

Intent tiers are not interchangeable: `stated` is explicit purpose, `trigger` is
durable assignment evidence, `mechanical` describes only the effect. Never
invent private reasoning or authorship from a turn summary.

A copy should reach its immediate source coordinate. An integration explanation
should reach the decision and source changes it accounted for. At an external
import boundary, report the recorded source kind, credential-free URI, revision,
digest, and target repositories as snapshot facts. Importer intent explains why
bytes entered Vibestudio — it does not identify the earlier file author or
external committer.
