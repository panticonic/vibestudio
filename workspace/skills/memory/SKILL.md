---
name: memory
description: Recall facts from past conversations or committed files, or continue from provenance attached to a managed-file read.
---

# Workspace memory

When a question concerns displayed lines, use the evidence already attached to
an ordinary managed-file `read` — it includes bounded intent, request, decision,
import-boundary, and history context. Continue with its exact `provenance({
target })` root only when deeper history can change the answer.

Use `memory_recall` when the relevant file or conversation is unknown:

```text
memory_recall({
  query: "retry backoff policy",
  kinds: ["message", "file"],
  limit: 10
})
```

`query` is required; `kinds` and `limit` are optional. Searches completed
trajectory messages and text files at committed workspace events. Working
applications don't enter topical file recall until committed.

Treat recall as discovery, not proof. Follow message evidence through trajectory
inspectors and managed-source facts through [Vibestudio
VCS](../vibestudio-vcs/SKILL.md). Search indexes and read-time summaries are
rebuildable projections; their exact causal roots are the continuation surface.

`memory_recall` is an agent tool, not a portable panel, worker, or VCS API.
