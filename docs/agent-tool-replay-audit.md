# Agent Tool Replay Audit

This document records the safety classification required before enabling replay of
interrupted `starting` or `running_model` turns after a workerd restart. The
machine-checkable source of truth is
[`agent-tool-replay-classification.json`](./agent-tool-replay-classification.json).

## Replay Gate

`TrajectoryVesselBase.canReplayInterruptedModelTurn()` defaults to `false`.
Subclasses must override it only after every reachable tool for that agent is
classified as safe below. Until then, recovery keeps the conservative behavior:
proactive resume wakes the DO, clears stuck UI state, and marks interrupted model
turns terminal with one diagnostic instead of replaying them.

## Invariant

Model-turn replay is safe only when every durable-resumable external effect
writes an intent or suspension row before dispatching the side effect. Replay
then finds the existing journal/result and skips or reconciles rather than
dispatching twice.

## Current Classification

| Tool surface | Classification | Evidence / Required follow-up |
| --- | --- | --- |
| Built-in set_title | Unsafe by default | Mutates display title through runtime state. Replay-enabled subclasses must filter it out or explicitly reclassify it after proving idempotency. |
| Channel method calls | Journal-before-dispatch safe | Suspension rows are written before `channel.callMethod`; replay must continue checking `transport_call_id` before re-issuing. |
| Built-in approval gate | Journal-before-dispatch safe when routed through agent suspension ledger | Requires regression coverage that approval dispatch is not reachable outside the suspension path for replay-enabled agents. |
| Built-in ask-user / UI prompt flows | Journal-before-dispatch safe when routed through agent suspension ledger | Requires explicit fixture proving replay observes the existing suspension/result. |
| Read-only filesystem tools | Pure read | Safe to re-run, but replay should still prefer committed transcript/suspension results when present. |
| Filesystem mutation tools | Unsafe until wrapped | These perform external side effects and need journal-before-dispatch or agent-level replay opt-out. |
| Web/search providers | Unsafe until classified per provider | Reads may be nondeterministic and can consume quota; replay-enabled agents need provider-specific idempotency or opt-out. |
| MCP or arbitrary extension tools | Unsafe by default | Tool authors must declare journal-before-dispatch or idempotent-by-key semantics before replay can be enabled. |

## Required Before Enabling Replay

1. Add machine-checkable metadata for every tool exposed to an agent:
   `journal-before-dispatch`, `idempotent-by-key`, `pure-read`, or `unsafe`.
2. Reject `canReplayInterruptedModelTurn() === true` unless all reachable tools
   are in a replay-safe class.
3. Add regression tests with one deliberately unsafe tool proving interrupted
   model turns do not replay.
4. Add replay tests proving existing suspension rows and committed GAD entries
   suppress duplicate tool dispatch.
