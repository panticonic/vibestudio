---
name: provenance-tuning
description: Diagnose slow, incomplete, stale, or confusing provenance reads; repair graph recording, indexes, content mappings, or presentation.
---

# Provenance read review

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) and [provenance
orientation](../provenance-orientation/SKILL.md) first. The system stores
normalized immediate edges and derives views by walking them.

## Reproduce one exact read

Capture:

- the precise typed root or file state/range
- the method: `readMemory`, `inspect`, `neighbors`, `history`, or `blame`
- cursor, direction, and limit
- every returned node, edge, span, and typed refusal
- timing and the agent invocation that issued the read

Re-run the smallest focused call. Follow one cursor without changing its root.
Never compare results from different event/application states as one read.

For automatic read-time memory, capture the full bytes hash and exact displayed
UTF-16 range from the `read` details. Confirm the attachment is `stale`
(semantic state no longer names those bytes) rather than present, and confirm
this diagnostic adds no warning prose to the file content. Inspect
blame-selected roots instead of comparing rendered prose. Then inspect the
model-visible block: it should answer why the lines exist with tier-labeled
intent and bounded, reusable continuations.

## Classify the ownership problem

| Symptom | Root cause |
| --- | --- |
| Wrong or missing relationship | Graph-recording or edge-projection bug |
| Wrong copied span | Content-coordinate mapping bug |
| Missing source change | Integration decision or reachability bug |
| Sibling-context data | Authorization failure — stop, don't filter |
| Slow bounded page | Index/query-plan problem on the exact edge kind |
| Confusing result | Typed summary or UI navigation problem |

Fix the owning abstraction. `readMemory` is the one narrow task projection for
ordinary reads: exact context + path + bytes hash + displayed range → bounded
blame-backed episodes and reusable typed roots. Keep the service projection rich
and default rendering small; structured tool details are the lossless machine
surface. Never turn it into an all-purpose provenance endpoint or add a
persisted traversal session, ranking layer, claims store, raw SQL route, or
opaque node-handle shortcut.

## Validate the repair

Use deterministic generated fixtures with many relevant immediate edges. Assert
direction, stable ordering, pagination, exact state isolation, range selection,
content-hash staleness, bounded rendering, and restart behavior. For content
history, include edits, counteractions, moves, copies, imports, and integration
decisions; verify same moved identity plus new copied identity. For UX changes,
add a fresh vague agentic scenario that learns the recorded reason from an
ordinary read without being prompted to call a provenance method.

Report the exact symptom, owner, semantic change, focused tests, and measured
before/after behavior. Never widen global page limits to hide an indexing or
query-plan defect.
