---
name: memory
description: Recall established facts from past conversations or committed workspace files, or continue from the provenance attached to an exact managed-file read.
---

# Workspace memory

Use the evidence already attached to an ordinary managed-file `read` when the
question concerns the displayed lines. It includes bounded intent, request,
decision, import-boundary, and history context. Continue with its exact
`provenance({ target })` root only when deeper history can change the answer.

Use `memory_recall` when the relevant file or conversation is not known:

```text
memory_recall({
  query: "retry backoff policy",
  kinds: ["message", "file"],
  limit: 10
})
```

`query` is required; `kinds` and `limit` are optional. The tool searches
completed trajectory messages and text files at committed workspace events.
Working applications do not enter topical file recall until committed.

Treat recall as discovery, not proof. Follow important message evidence through
the trajectory inspectors and managed-source facts through
[Vibestudio VCS](../vibestudio-vcs/SKILL.md). Search indexes and read-time
summaries are rebuildable projections; their exact causal roots are the
continuation surface.

`memory_recall` is an agent tool, not a portable panel, worker, or VCS API. Code
should use the task-shaped services it is authorized to call.
