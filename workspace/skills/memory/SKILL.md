---
name: memory
description: Search workspace memory—past conversations and committed file content—with provenance before re-deriving established facts.
---

# Workspace memory

Workspace memory has two complementary entry points:

- ordinary `read` returns the file content followed by a compact **workspace
  memory** explanation of why the exact displayed lines exist;
- `memory_recall` searches topically across past messages and committed files
  when you do not yet know which exact file or root matters.

Do not call `memory_recall` merely to reconstruct why the lines already in
front of you exist. Read the file and use its attached intent, original
request, decision, import-boundary, and history evidence. Do not repeat an
`inspect`/`neighbors` walk merely to confirm the same facts. Use the copyable
`provenance({ target })` continuation when the bounded attachment raises a
deeper question; every root remains available in the structured read details.

Use the built-in `memory_recall` tool before re-deriving facts that may already
have been established elsewhere and no exact managed file read supplies the
answer.

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

Working applications are not committed topical file memory until `vcs.commit`
creates an event containing the complete local chain. Search indexes are
rebuildable projections; semantic facts and their causal edges remain
authoritative.

Read-time memory is also a rebuildable projection. Its hash/range binding and
blame roots come from the current semantic working head, so it cannot become a
parallel source of truth and it can explain uncommitted managed work.

`memory_recall` is an in-loop agent tool, not a public VCS method or portable
panel/worker API. Panels and workers should use the task-shaped GAD and VCS
surfaces they are authorized to call rather than inventing another recall
facade.
