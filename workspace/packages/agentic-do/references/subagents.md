# Subagents

Subagents are supervised child agents with their own task channel and semantic workspace context. They are not repository branches and they do not publish directly into the parent.

## Parent workflow

1. `spawn_subagent` with one bounded task and a useful label. Use `fresh` for independent work and `fork` when the child needs the current trajectory context.
2. Keep doing useful foreground work. Child progress is pushed to the parent; do not poll an empty transcript. Every terminal child result resumes the supervisor so that run can be integrated and closed immediately. If sibling runs remain live afterward, continue useful foreground work or suspend again; do not finalize the user's goal while supervised runs remain live.
3. Use `send_to_subagent` only for new instructions. The spawn invocation completes after launch and the child continues on a durable task card. The child must commit its semantic work and call `complete` with a concise result; that report arrives through the terminal task notification. Uncommitted child work cannot merge.
4. After terminal delivery, call `merge_subagent({ runId })` directly. No status, diff, log, or transcript preflight is required. The helper derives both exact states and invokes the same shared merge driver as ordinary VCS and protected-main integration, without a wrapper compare loop.
5. Review the model-visible resolution, `intents`, and every `composed` entry. A mechanically composed coordinate still needs semantic review.
6. If the helper returns `source-uncommitted` or `needs-decision`, use the returned evidence first. Inspect only the child state needed to resolve a concrete ambiguity, author any truthful combined state with ordinary parent edit tools, then call `merge_subagent` again with coordinate resolutions.
7. Close only after the helper reports completion. `close_subagent` reads the engine-owned integration projection and requires semantic completion. Lifecycle disposition and semantic integration are separate axes.

## Inspecting child state

Inspection is an exceptional diagnostic surface, not a merge preflight.
`inspect_subagent({ runId, query: "diff", limit: 50 })` returns a bounded
semantic comparison of the parent's current working head against the child's
committed event. The tool derives both exact VCS references; callers do not
provide source or target identifiers. If the child has additional uncommitted
work, the comparison still covers only its committed event and the result's
`workingCounts` and note make that distinction explicit. Continue a large
comparison with the returned opaque `nextCursor`.

Use `query: "status"` for lifecycle and clean/dirty state, `query: "log"` for
bounded committed history, an exact repo-prefixed path for one child file, and
`query: "runtime"` only for external-engine process diagnostics. Use
`read_subagent` for deliberate conversation debugging rather than normal
completion: the child's final report is already delivered as the terminal
`spawn_subagent` result. Inspection never exposes the child's private model
context window. After an empty transcript read, further reads are durably
blocked until a pushed child-channel event arrives.

## Merge protocol

The helper returns `protocol: "vibestudio.subagent-merge.v1"`. Its bounded status union includes:

- `working`: at least one merge page changed the parent working head and the source is complete and concluded;
- `unchanged`: the source was already complete and concluded;
- `needs-decision`: clean pages landed, but one or more coordinates remain unresolved;
- `source-uncommitted`: the child's committed event does not include its current work;
- `closed`: the retained lifecycle receipt is available but the child context is gone.

The model-visible result includes bounded intents, mechanically composed coordinates, conflicts, and global resolution. Structured details additionally include the source event, initial and current parent heads, every landed merge result in `merges`, and the final review packet. Multi-page work uses stable idempotent command IDs. If a later page fails, the typed driver error retains every completed page and the last review.

The helper always performs the decision-establishing merge when a source is not concluded, even if it is convergent, net-zero, or conflict-only. Conflict-only work therefore returns a concluded decision plus unresolved coordinates instead of failing with an implicit conflict selection.

## Resolve a conflict

```js
merge_subagent({
  runId,
  resolutions: [{
    coordinate: { kind: "file", id: "file:..." },
    resolution: "current",
    rationale: "The parent-authored current value combines both reviewed intents"
  }]
})
```

- `theirs` accepts the child's coordinate.
- `ours` explicitly declines it.
- `current` accepts the parent head after you author the combined value with `edit` or `write` and a meaningful `intent` when the purpose is not obvious from the request.

To finish every remaining coordinate explicitly, use either:

```js
merge_subagent({ runId, resolutions: { allRemaining: { resolution: "ours" } } })
merge_subagent({ runId, resolutions: { allRemaining: {
  resolution: "current",
  rationale: "The reviewed parent state combines or supersedes the child result"
} } })
```

`allRemaining` is literal: it applies to conflicts and clean coordinates alike, so abandoning a remainder cannot accidentally adopt unseen source work.

Do not resolve at aspect granularity, fabricate evidence, or order source operations. Coordinates are the decision surface; aspects and attribution explain the conflict.

## Run lifecycle

The run receipt owns lifecycle disposition; the semantic axis is derived from the engine projection as `unattempted`, `integrating`, `needs-decision`, or `complete`. A clean child source event is retained durably for recovery after teardown.

`close_subagent({ discard: true })` is legal only before the source has entered the parent working chain. Once integration begins, close refuses without mutating the workspace and names the two explicit `allRemaining` finishes above. This prevents a lifecycle label from hiding integration debt that commit will reject.

An unavailable or closed child runtime does not erase its committed semantic event. A closed run retains a bounded lifecycle receipt while releasing the task subscription and child context.

## Child behavior

The child owns only its delegated task. It should inspect exact status, author managed changes with ordinary tools and meaningful optional `intent`, run focused verification, commit the complete local chain, and call `complete` once with the result. It should not push protected main, mutate the parent context, or ask the parent to replay its edits manually.
