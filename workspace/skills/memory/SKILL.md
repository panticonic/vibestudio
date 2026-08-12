---
name: memory
description: Recall facts from past conversations or committed files, or continue from provenance attached to a managed-file read.
---

# Workspace memory

When a question concerns displayed lines, use the evidence already attached to
an ordinary managed-file `read` — it includes bounded intent, request, decision,
import-boundary, and history context. Continue with its compact `provenance({
target: "@r…" })` reference only when deeper history can change the answer.

Use `memory_recall` when the relevant file or conversation is unknown:

```text
memory_recall({
  query: "retry backoff policy",
  kinds: ["message", "file", "commit"],
  limit: 10
})
```

`query` is required; `kinds` and `limit` are optional. Searches completed
trajectory messages, text files at committed workspace events, and commit
summaries. Commit recall is especially useful for decisions or names removed
from current files. Working applications don't enter topical file recall until
committed.

Treat recall as discovery, not proof. Follow message evidence through trajectory
inspectors and managed-source facts through [Vibestudio
VCS](../vibestudio-vcs/SKILL.md). Search indexes and read-time summaries are
rebuildable projections; their exact causal roots are the continuation surface.
For a file whose relevant text was later removed, reuse the exact complete
continuation ref returned by `provenance`. The durable ref retains
the file root and opaque service cursor inside trusted code.

`memory_recall` is an agent tool, not a portable panel, worker, or VCS API.
