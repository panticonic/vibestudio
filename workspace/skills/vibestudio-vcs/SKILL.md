---
name: vibestudio-vcs
description: Operate Vibestudio's semantic workspace VCS for managed authoring, net-effect merges, provenance, commit, revert, external snapshots, and protected-main publication. Use for managed workspace changes and for reviewing or merging another event or external delta. Do not use it for context-local scratch files or unrelated Git repositories.
---

# Vibestudio semantic VCS

Managed workspace state is semantic history, not a Git worktree. Use the agent-facing `apply_patch` tool for atomic multi-file text/binary writes, exact replacements, deletes, and mode changes; use `edit` or `write` for a single simple text change and `move_file`/`copy_file` for identity-preserving transfers. Use the compact `vcs` tool for status, provenance, compare, merge, revert, commit, discard, blame, and push.

## Non-negotiable rules

- Treat every event, application, repository, file, change, work unit, and decision ID as opaque. Copy returned identities exactly.
- Carry the newest returned `workingHead` into the next mutation. On `RevisionChanged`, read status again and re-plan; do not rewrite the expected basis.
- Managed edits remain local applications until one deliberate whole-chain commit. Never emulate a move or copy with read/write.
- Add optional `intent` to an authoring call when the purpose is not already clear from the trigger. Good intent explains why, such as `intent: "Remove the cache because it hides the request race"`. Omit it when it would merely restate the request. Absence is honest and remains absent.
- A source is merged by stable coordinate and net effect. Operations remain provenance; they are not replay steps.
- `resolution.complete && resolution.concluded` is the only finished merge signal.
- Push only an exact clean committed event after focused verification.

## Core workflow

1. Run `vcs({ operation: "status" })` when you need to orient to the current chain. Agent-facing mutations derive and bind the exact live `workingHead`; a separate status preflight is not required for every call.
2. Inspect or read the smallest relevant surface. Managed reads may include a bounded memory attachment with intent and causality.
3. Author coherent multi-file changes with `apply_patch`; use `edit` or `write` for one simple text file and `move_file`/`copy_file` for transfers. Give `intent` only when it adds purpose beyond the request.
4. To inspect everything currently changed in this context, including uncommitted applications, use the local comparison directly. It resolves the complete working head as source and protected main as target; no status or history preflight is needed:

   ```js
   vcs({ operation: "compare", view: "local" })
   ```

   Compare is read-only and has no `intent` field. Pass only the selector and optional paging fields. Do not pass main as `sourceEventId` for this job. `sourceEventId` always means incoming source, so naming main reverses the comparison and can truthfully show no changes.

5. For incoming committed work, call merge directly in the normal case. The agent-facing tool drains every clean page in one call, never selects a conflict implicitly, and returns final global resolution, counts, intents, composed-review evidence, and a bounded conflict page. Use compare first only when you deliberately need a read-only preview:

   ```js
   vcs({ operation: "compare", sourceEventId: "event:...", limit: 500 })
   ```

6. When you compare, review both views in the result:
   - `coordinates` is the mechanical surface: `adopt`, `convergent`, `composed`, `conflict`, or `resolved`, with aspect values and full attribution.
   - `intents` is the semantic surface. Its visible tier is `stated`, `trigger`, or `mechanical`; `split` and `contested` are prompts to inspect more deeply, never machine gates.

7. Merge clean work. Omitting `coordinates` lets the shared driver drain bounded engine pages; explicit `coordinates` deliberately performs one selected page only:

   ```js
   vcs({
     operation: "merge",
     sourceEventId: "event:...",
     intent: "Bring the reviewed child implementation into the parent"
   })
   ```

8. Review every returned `composed` entry. Deterministic non-overlapping text composition is mechanically safe, not a semantic approval.
9. Resolve conflicts per coordinate:
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

   To explicitly decline every unseen remainder, including clean coordinates, use `resolutions: { allRemaining: { resolution: "ours" } }`. After authoring and reviewing a combined parent result, use `current` with a required rationale. The blanket is repeated safely across whole-group pages and never accepts source content implicitly.

10. Use the merge result as the normal completion receipt. `status: "unchanged"` is an idempotent structured receipt, not an error; still inspect `resolution.complete`. If conflicts exceed the bounded result, continue only the filtered sequence with the returned cursor. A convergent or net-zero source still gets one decision-only merge call to establish conclusion and ancestry.
11. Run focused tests and commit the complete application chain. The compact commit operation verifies that the context is clean at the committed event; request status separately only when you need additional orientation, then push if requested.

## Commit and publication

`vcs({ operation: "commit", message, intent? })` commits the complete local chain. Merge decisions are the sole source of merge parents, including decision-only convergent and net-zero merges.

`vcs({ operation: "push" })` publishes the exact committed event. Push revalidates every merge parent by coordinate and runs the protected candidate checks. It never includes uncommitted work.

## Recovery

- `ConflictPresent`: an explicitly selected coordinate conflicts and lacks a resolution. Read its aspects, attributions, closed resolution list, and both intents.
- `CoupledGroupIncomplete`: the selection split one structural group. Select the entire named group or omit `coordinates` and let the planner select a valid page.
- `ScopeTooLarge`: narrow the compare page or coordinate selection; never split a coupled group.
- `IntegrityFailure`: stop. The state cannot be fully explained by reachable provenance; do not route around it.
- `IntegrationIncomplete`: follow the returned exact merge recipe. Use `allRemaining: ours` to decline the source remainder, or `current` with a rationale after reviewing a truthful combined parent state.
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

The generated public contract and `help` output own the method roster. Agent
tools expose the common workflow; direct runtime callers use the same semantic
contracts with explicit service fields.
