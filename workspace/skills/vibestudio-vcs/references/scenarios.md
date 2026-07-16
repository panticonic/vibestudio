# Worked scenarios

## Reorganize a managed file

Call `status`, resolve the source file and destination repository at the
working head, then use `move_file` or `vcs.move`. Continue from the returned
working head. Inspect the file root to verify the same file ID at its new path.

## Copy and edit independently

Use `copy_file` or `vcs.copy` from an exact source state. Resolve the new file
ID, edit the copy, and call `blame` on both files. New copy edits stop at their
own change; preserved regions walk through the copy edge into the original.

## Bring in another context gradually

Read the source context's committed event. Compare it with the target working
head, adopt one applicable group, run focused tests, reconcile a group already
satisfied by target behavior, and ask the user about a genuine conflict.
Continue from each returned working head. When no effective source change is
unaccounted, commit the complete chain with the source event as integration
parent.

## Undo one intention

Find the exact change in history, call `revert`, and inspect the new
counteraction. Verify unrelated later behavior still exists, run tests, and
commit the complete local chain.

## Recover stale work

If a mutation returns `RevisionChanged`, discard the failed request, call
`status`, re-read the affected file, and reformulate from the actual working
head with a new command ID. If the response was merely lost, retry the exact
same request with its original command ID.

## Import one exact external snapshot

From a real agent tool invocation, import the exact source URI, snapshot
revision, and complete repository/file source facts naming CAS bytes. Do not
assert content kind or lengths; the host observes those intrinsic facts and the
semantic workspace derives the normalized snapshot digest. Call
blame, inspect its terminal ordinary change, then inspect the owning import work
unit and its command. Report the work unit's external snapshot tuple and the
actual causal intent, while stating that pre-import coordinate authorship is
unknown. Do not invent a full Git history or per-path author evidence.

## Recover a stale managed edit

When an edit loses a working-head race, inspect status again and re-derive the
edit against the new exact state. A changed request receives a new command ID;
reuse the original only for an identical uncertain retry. Do not weaken the CAS
or rebuild a path from stale bytes.

## Publish verified work

Confirm the context is clean and its committed event includes the intended
local chain. Run the relevant explicit context checks for advisory confidence,
then call `push` with the exact committed and observed main events. Handle
ancestry, integration, authorization, approval, and atomic-ref refusals by
typed code. Inspect post-publication build and activation projections
separately; a failed activation must leave the previous runnable artifact in
place.
