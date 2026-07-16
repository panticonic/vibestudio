---
name: memory
description: Search workspace memory—past conversations and committed file content—with provenance before re-deriving established facts.
---

# Workspace memory

Use the built-in `memory_recall` tool before re-deriving facts that may already
have been established in another conversation or committed to the workspace.

```text
memory_recall({
  query: "retry backoff policy",
  kinds: ["message", "file"],
  limit: 10
})
```

`query` is required. `kinds` and `limit` are optional; the maximum limit is 50.

The index covers:

- completed chat and trajectory messages;
- text files at committed workspace events.

Each result includes the evidence available for its kind, such as a trajectory
event, timestamp, file path, or content hash. The recall tool result is itself
journaled as the terminal result of its exact invocation.

Treat recall as discovery, not proof. Follow important message evidence through
the GAD inspectors. Follow workspace facts through the canonical
[`vibestudio-vcs`](../vibestudio-vcs/SKILL.md) methods: `inspect`, `neighbors`,
`history`, and `blame`.

Working applications are not committed file memory until `vcs.commit` creates
an event containing the complete local chain. Search indexes are rebuildable
projections; semantic facts and their causal edges remain authoritative.

`memory_recall` is an in-loop agent tool, not a public VCS method or portable
panel/worker API. Panels and workers should use the task-shaped GAD and VCS
surfaces they are authorized to call rather than inventing another recall
facade.
