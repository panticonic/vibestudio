---
name: vibestudio-vcs
description: Operate Vibestudio's semantic workspace VCS for managed authoring, net-effect merges, provenance, commit, revert, external snapshots, and protected-main publication. Use for managed workspace changes and for reviewing or merging another event or external delta. Do not use it for context-local scratch files or unrelated Git repositories.
---

# Vibestudio semantic VCS

Managed workspace state is semantic history, not a Git worktree. Use the agent-facing `edit`, `write`, `move_file`, and `copy_file` tools for ordinary authoring. Use the compact `vcs` tool for status, provenance, compare, merge, revert, commit, discard, blame, and push.

## Non-negotiable rules

- Treat every event, application, repository, file, change, work unit, and decision ID as opaque. Copy returned identities exactly.
- Carry the newest returned `workingHead` into the next mutation. On `RevisionChanged`, read status again and re-plan; do not rewrite the expected basis.
- Managed edits remain local applications until one deliberate whole-chain commit. Never emulate a move or copy with read/write.
- Add optional `intent` to an authoring call when the purpose is not already clear from the trigger. Good intent explains why, such as `intent: "Remove the cache because it hides the request race"`. Omit it when it would merely restate the request. Absence is honest and remains absent.
- A source is merged by stable coordinate and net effect. Operations remain provenance; they are not replay steps.
- `resolution.complete && resolution.concluded` is the only finished merge signal.
- Push only an exact clean committed event after focused verification.

## Core workflow

1. Run `vcs({ operation: "status" })` and keep the exact `workingHead`.
2. Inspect or read the smallest relevant surface. Managed reads may include a bounded memory attachment with intent and causality.
3. Author with `edit`, `write`, `move_file`, or `copy_file`. Give `intent` only when it adds purpose beyond the request.
4. For incoming work, compare the exact target with the event:

   ```js
   vcs({ operation: "compare", sourceEventId: "event:...", limit: 500 })
   ```

5. Review both views in the result:

   - `coordinates` is the mechanical surface: `adopt`, `convergent`, `composed`, `conflict`, or `resolved`, with aspect values and full attribution.
   - `intents` is the semantic surface. Its visible tier is `stated`, `trigger`, or `mechanical`; `split` and `contested` are prompts to inspect more deeply, never machine gates.

6. Merge a clean page. Omitting `coordinates` selects the first bounded mergeable page and never selects a conflict implicitly:

   ```js
   vcs({
     operation: "merge",
     sourceEventId: "event:...",
     intent: "Bring the reviewed child implementation into the parent"
   })
   ```

7. Review every returned `composed` entry. Deterministic non-overlapping text composition is mechanically safe, not a semantic approval.
8. Resolve conflicts per coordinate:

   - `theirs`: accept the source coordinate;
   - `ours`: keep ours and explicitly decline the source coordinate;
   - `current`: accept the current head after you author the truthful combined result with ordinary edit tools.

   ```js
   vcs({
     operation: "merge",
     sourceEventId: "event:...",
     resolutions: [{
       coordinate: { kind: "file", id: "file:..." },
       resolution: "current",
       rationale: "The current file combines the retry contract with the local validation"
     }],
     intent: "Conclude the reviewed hand merge"
   })
   ```

9. Compare again. Continue only until `complete` and `concluded` are both true. A convergent or net-zero source still needs one decision-only merge call to establish conclusion and ancestry.
10. Run focused tests, commit the complete application chain, verify clean status, then push if requested.

## Commit and publication

`vcs({ operation: "commit", message, intent? })` commits the complete local chain. Merge decisions are the sole source of merge parents, including decision-only convergent and net-zero merges.

`vcs({ operation: "push" })` publishes the exact committed event. Push revalidates every merge parent by coordinate and runs the protected candidate checks. It never includes uncommitted work.

## Recovery

- `ConflictPresent`: an explicitly selected coordinate conflicts and lacks a resolution. Read its aspects, attributions, closed resolution list, and both intents.
- `CoupledGroupIncomplete`: the selection split one structural group. Select the entire named group or omit `coordinates` and let the planner select a valid page.
- `ScopeTooLarge`: narrow the compare page or coordinate selection; never split a coupled group.
- `IntegrityFailure`: stop. The state cannot be fully explained by reachable provenance; do not route around it.
- `IntegrationIncomplete`: compare every named source again and finish coordinate accounting before commit/finalization.
- `NoEffect`: inspect current state. Report success only when the requested semantic outcome is already true.

## Reference map

- [Authoring basics](references/authoring-basics.md)
- [Contexts and exact state](references/contexts-and-state.md)
- [Compare and merge](references/compare-and-merge.md)
- [File move and copy](references/file-move-copy.md)
- [Revert and counteractions](references/revert-counteractions.md)
- [Semantic commit](references/semantic-commit.md)
- [Provenance, intent, and blame](references/provenance-and-blame.md)
- [External snapshot import](references/external-snapshot-import.md)
- [Checks and publication](references/checks-and-publication.md)
- [Typed recovery](references/typed-recovery.md)
- [Scenarios](references/scenarios.md)
- [Generated public contract](references/public-contract.md)

Use `help("vcs")` for the method index and `help("vcs.merge")` for an exact live method contract.

The canonical service roster is `vcs.edit`, `vcs.move`, `vcs.copy`,
`vcs.merge`, `vcs.revert`, `vcs.commit`, `vcs.discard`, `vcs.importSnapshot`,
`vcs.registerExternalDelta`, `vcs.supersedeExternalDelta`,
`vcs.finalizeExternalDelta`, `vcs.push`, `vcs.status`, `vcs.compare`,
`vcs.inspect`, `vcs.neighbors`, `vcs.history`, `vcs.blame`, `vcs.readMemory`,
`vcs.resolveRepository`, `vcs.readFile`, `vcs.listDirectory`, and
`vcs.listFiles`. Agent tools expose the common subset; direct runtime callers
use the same contracts for lifecycle operations.

## Completion checklist

- The latest exact working head was used for every mutation.
- Managed writes carry meaningful `intent` where it adds information, never filler.
- Incoming work is `complete && concluded`; composed coordinates were semantically reviewed.
- Conflicts were resolved per coordinate with explicit rationale where useful.
- Focused verification passed.
- The whole local chain was committed, status is clean, and any requested push names the exact committed event.
