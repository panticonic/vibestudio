# Compare and merge

One engine handles child events, cross-context work, external deltas, and publication revalidation. It compares fact state at stable file and repository identities. Recorded operations explain the state and remain traversable provenance; the engine never replays them as ordered merge instructions.

## Read the coordinate view

Compare returns a primary common base, any additional maximal bases, global counts and resolution, a bounded coordinate page, and a bounded intent projection. Page boundaries never change global classification or intent state.

File aspects are presence, content, placement, and mode. Repository aspects are presence and path. Each aspect includes `base`, `ours`, `theirs`, attribution on both sides, and one classification:

- `adopt`: only the source changed it;
- `ours`: only the target changed it;
- `convergent`: both sides independently reached the same value;
- `composed`: orthogonal aspects or non-overlapping text hunks combine deterministically;
- `conflict`: a decision is required.

Presence dominates edit and move. Structural conflicts name every involved coordinate. A `group` means the coordinates form one structural unit, such as a file placed in a source-created repository or a path-vacancy chain.

When maximal common bases disagree on an aspect, that aspect is a conflict and includes `baseValues`. The engine never silently chooses one base's interpretation.

## Read the intent view

The `intents` list groups attribution by work unit. Evidence degrades without invention:

1. `stated`: explicit authoring intent or a recorded work-unit summary;
2. `trigger`: a sender-attributed excerpt of the request;
3. `mechanical`: a labeled effect summary when no intent evidence exists.

Source intent states mean:

- `merged`: all touched coordinates are mechanically incorporated or convergent;
- `settled`: all are resolved, with at least one explicitly kept or superseded;
- `split`: its coordinates have heterogeneous clean and contested dispositions;
- `contested`: all are conflicts;
- `pending`: cleanly mergeable but not concluded.

Treat `split` as the highest-priority semantic review signal. These states guide attention; they never block a mechanically valid merge.

## Merge clean coordinates

A merge call acts on at most one normalized result per coordinate and persists one decision even when it changes no facts. With no explicit coordinate list, it selects the first mergeable bounded page. Conflicts are never selected implicitly.

For the agent-facing tool, direct merge is the normal happy path: it derives the exact live target, drains every clean bounded page through the shared driver, and returns a self-sufficient review packet. Do not compare before or after a clean merge. Compare is for a read-only preview or for paging deeper conflict evidence.

```js
vcs({
  operation: "merge",
  sourceEventId: "event:source",
  intent: "Bring the reviewed source behavior into this context",
});
```

For direct service callers, the source is `{ kind: "event", eventId }` or `{ kind: "external-delta", deltaId }`. The compact tool exposes `sourceEventId` and maps it to the event source.

Always inspect the merge result's model-visible `composed` entries. Each item names the coordinate and both resolved intents; the full packet also remains in structured details. Hunk-composed content is a new authored merge change with exact mapped content lineage to both parents.

The result is discriminated by `status`. `working` carries mutation identities;
`unchanged` honestly carries none. Both carry final global `resolution`,
`counts`, `intents`, `intentsTruncated`, a bounded conflict-only page, and
`nextConflictCursor`. Continue that cursor only with `compare` using the same
target, source, and `statusFilter: "conflict"`; filtered and unfiltered cursors
are intentionally not interchangeable.

## Resolve a coordinate

Resolutions apply to the whole unresolved coordinate; aspects are diagnosis, not a second decision surface.

- `composed` accepts the deterministic combined result reported for a `composed` coordinate.
- `theirs` accepts the source result.
- `ours` keeps the target result and records an explicit decline.
- `current` accepts the current head. First author the truthful combined result with `edit` or `write`; the resolution persists only the decision link and does not fabricate an unchanged change.

```js
vcs({
  operation: "merge",
  sourceEventId: "event:source",
  resolutions: [
    {
      coordinate: { kind: "file", id: "file:config" },
      resolution: "current",
      rationale: "The current value combines the source retry policy with local schema validation",
    },
  ],
  intent: "Conclude the reviewed config merge",
});
```

`ours` is also how to take only part of a clean source: resolve unwanted clean coordinates as `ours`; omitting them leaves them pending.

For one reviewed decision over the literal whole remainder, use
`resolutions: { allRemaining: { resolution: "ours" } }`, or `current` with a
required rationale. The driver repeats this bounded blanket decision until the
source concludes. It applies to clean coordinates as well as conflicts and
cannot be combined with an explicit coordinate page. There is no blanket
`theirs`; adopting unseen source state remains coordinate-specific.

## Completion and ancestry

`complete` means every source-touched coordinate is mechanically satisfied or has a reachable decision. `concluded` means a reachable decision names the source, or the source is already an ancestor. Compare alone never concludes.

An all-convergent, conflict-only, or net-zero source can therefore need a merge call that persists a decision-only application. Stop only at:

```text
resolution.complete === true && resolution.concluded === true
```

Commit then derives the source parent from the recorded decisions. Repeating the merge after completion is unchanged and must not create another semantic path.

## Typed refusals

- `ConflictPresent`: you explicitly selected a conflicted coordinate without resolving it.
- `CoupledGroupIncomplete`: the coordinate subset splits the returned group.
- `RevisionChanged`: the target head advanced; rerun merge from the fresh live head.
- `IntegrityFailure`: reachable operations cannot cover the state difference; stop and diagnose the graph.
