---
name: provenance-tuning
description: Diagnose and improve Vibestudio semantic provenance reads when automatic read-time memory, inspect, neighbors, history, or blame are slow, incomplete, confusing, stale, or suspected of crossing scope. Use exact typed roots and fixtures; repair graph semantics, indexes, or presentation without adding caches, claims stores, or opaque handles.
---

# Provenance read review

Read the canonical [Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) and
[provenance orientation](../provenance-orientation/SKILL.md) first. The system
stores normalized immediate edges and derives views by walking them.

## Reproduce one exact read

Capture:

- the precise typed root or file state/range;
- the method: `readMemory`, `inspect`, `neighbors`, `history`, or `blame`;
- cursor, direction, and limit;
- every returned node, edge, span, and typed refusal;
- timing and the captured agent invocation that issued the read.

Re-run the smallest focused call. Follow one cursor without changing its root.
Do not compare results from different event/application states as if they were
one read.

For automatic read-time memory, capture the full bytes hash and exact displayed
UTF-16 range from the `read` details. Confirm the attachment is `stale` rather
than present when semantic state no longer names those bytes, and confirm that
this diagnostic does not add warning prose to the file content. Inspect the
  blame-selected roots instead of comparing rendered prose alone. Then inspect
  the model-visible block: it should plainly answer “why do these lines exist?”
  and offer one copyable deeper target without dumping every internal root.

## Classify the ownership problem

- A wrong or missing relationship is a graph-recording or edge-projection bug.
- A wrong copied span is a content-coordinate mapping bug.
- A missing source change is an integration decision or reachability bug.
- Sibling-context data is an authorization failure; stop rather than filter it.
- A slow bounded page is usually an index/query-plan problem on the exact edge
  kind, not a reason for a cache or traversal daemon.
- A confusing result is a typed summary or UI navigation problem; preserve the
  normalized nodes and edges.

Fix the owning abstraction. `readMemory` is the one narrow task projection
allowed for ordinary reads: exact context + path + bytes hash + displayed
range, returning bounded blame-backed episodes and reusable typed roots. Keep
the service projection rich and the default rendering small; structured tool
details are the lossless machine surface. Do not
turn it into an all-purpose provenance endpoint or add a persisted traversal
session, ranking layer, claims store, raw SQL route, or opaque node-handle
shortcut.

## Validate the repair

Use deterministic generated fixtures containing many relevant immediate edges.
Assert direction, stable ordering, pagination, exact state isolation, range
selection, content-hash staleness, bounded rendering, and restart behavior.
For content history, include edits, counteractions, moves, copies, imports, and
integration decisions; verify the same moved identity plus a new copied
identity. For UX changes, add a fresh vague agentic scenario that learns the
recorded reason from an ordinary read without being prompted to call a
provenance method.

Report the exact symptom, owner, semantic change, focused tests, and measured
before/after behavior. Seek approval before widening global page limits; an
ordinary semantic or index correction needs no parallel compatibility path.
