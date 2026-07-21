# Compare and integrate

## Compare exact states

Call `vcs.compare` with the target event/application state and one exact
committed source event. Start with `view: "overview"`; request the paged
`changes` view when choosing action.

In the standard workspace agent, this is `vcs({ operation: "compare",
sourceEventId: "event:..." })`. Take one result group with `vcs({ operation:
"integrate", sourceEventId: "event:...", decision: ... })`, then compare
again from the newly returned working head. The tool resolves and CAS-checks
the current context state; causally bound direct service clients pass that state
explicitly. An authorized direct CLI may integrate without fabricating an
agent invocation; its causal walk ends honestly at the semantic command.
The compact tool's result details are already the canonical compare result,
including `target`, `changes`, `resolution`, and counts. Use those details;
do not guess a second lower-level `vcs.compare` call. A direct service call is a
different contract and requires the exact `target`, `view`, and `limit` shown by
`docs_open("runtime:workerRuntime.vcs.compare")`.

Each source change is classified as shared, already satisfied, actionable,
accounted, or historical. An actionable change may be applicable, conflicting,
or blocked. These are semantic classifications, not file-selection rows.

Blocked is a live, target-relative result. The service derives it from the
change's exact predecessor, destination repository, and destination vacancy.
Its `prerequisiteChangeIds` name earlier source changes whose results establish
the missing conditions. They are not stored dependency metadata and may change
after any local step.

Keep the source event fixed while resolving one comparison. Refresh the target
from each successful local mutation.

## Take a small local decision

Call `vcs.integrate` for one bounded group of source change IDs:

- choose `adopted` when the source change can be applied as intended;
- choose `reconciled` when exact target-state evidence already or newly
  satisfies the source intent, and record a clear rationale;
- choose `declined` when the source intent should not enter the target, and
  record why.

One call creates one integration decision, work unit, and local application.
It does not commit or publish. Keep its returned working head, run focused
tests, then compare again or take the next decision.

Do not treat `already-satisfied` as automatic consent. Validate that the target
evidence truthfully satisfies the intent before reconciling it. Do not decline
a source change whose effect remains live through another unaccounted path.

The compact agent tool accepts path-based evidence and resolves its stable
identities and hashes at the exact current working state. For example, after
authoring a truthful merged file for a conflicting text change:

```json
{
  "operation": "integrate",
  "sourceEventId": "workspace-event:...",
  "decision": {
    "kind": "reconciled",
    "sourceChangeIds": ["change:..."],
    "evidence": [
      {
        "kind": "file-content",
        "path": "projects/example/src/file.ts"
      }
    ],
    "rationale": "The merged file retains both collaborators' intended behavior."
  }
}
```

Use `file-placement` with a workspace file path when placement is the relevant
fact, or `repository-present` with a workspace repository path when repository
presence is the relevant fact. Absence evidence necessarily names the stable
`fileId` or `repositoryId` that is absent. Direct service clients use the
canonical ID/hash evidence contract instead of these agent-path inputs.

## Handle conflicts and dependencies

When compare classifies a change as `actionable/conflicting`, do not attempt to
adopt it. Inspect the cited source changes and their immediate neighbors. Author
a truthful target edit first when reconciliation requires a new result, then
reconcile against exact state evidence. On
`DependencyBlocked`, inspect `blockingChangeIds`, adopt or otherwise account for
those changes in earlier local steps, and compare again. Do not batch a blocked
change with its prerequisite or invent a dependency override.

Ask the user when the choice changes behavior or policy. Present the source
change, relevant target facts, and consequences without inventing marker files.

## Commit the integrated result

When comparison shows no unaccounted effective source changes, call
`vcs.commit` with the current working head and `integratesEventId` set to the
same source event. Commit derives that source from the local decisions and
rejects a chain whose decisions mix sources or disagree with the supplied
event. A zero-decision integration supplies the source explicitly. The commit
consumes the entire local chain and creates an event with the prior committed
event and source event as parents.

If work must remain independently committable, integrate it in another context
instead of trying to split the local chain.
