---
name: provenance-tuning
description: Diagnose and improve Vibestudio semantic provenance reads when inspect, neighbors, history, or blame are slow, incomplete, confusing, or suspected of crossing scope. Use exact typed roots and fixtures; repair graph semantics, indexes, or presentation without adding traversal services, caches, or opaque handles.
---

# Provenance read review

Read the canonical [Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) and
[provenance orientation](../provenance-orientation/SKILL.md) first. The system
stores normalized immediate edges and derives views by walking them.

## Reproduce one exact read

Capture:

- the precise typed root or file state/range;
- the method: `inspect`, `neighbors`, `history`, or `blame`;
- cursor, direction, and limit;
- every returned node, edge, span, and typed refusal;
- timing and the captured agent invocation that issued the read.

Re-run the smallest focused call. Follow one cursor without changing its root.
Do not compare results from different event/application states as if they were
one read.

## Classify the ownership problem

- A wrong or missing relationship is a graph-recording or edge-projection bug.
- A wrong copied span is a content-coordinate mapping bug.
- A missing source change is an integration decision or reachability bug.
- Sibling-context data is an authorization failure; stop rather than filter it.
- A slow bounded page is usually an index/query-plan problem on the exact edge
  kind, not a reason for a cache or traversal daemon.
- A confusing result is a typed summary or UI navigation problem; preserve the
  normalized nodes and edges.

Fix the owning abstraction. Never add an all-purpose provenance endpoint,
persisted traversal session, ranking layer, raw SQL route, or opaque node-handle
shortcut.

## Validate the repair

Use a small deterministic fixture containing the relevant immediate edges.
Assert direction, stable ordering, pagination, exact state isolation, and
restart behavior. For content history, include moves and copies and verify the
same moved identity plus a new copied identity. For UX changes, add a fresh
vague agentic scenario that must discover the canonical skill and choose the
right focused read without naming methods in its prompt.

Report the exact symptom, owner, semantic change, focused tests, and measured
before/after behavior. Seek approval before widening global page limits; an
ordinary semantic or index correction needs no parallel compatibility path.
