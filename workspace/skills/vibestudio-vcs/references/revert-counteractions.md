# Revert intent

## Name the change to counteract

Use `history`, `inspect`, and `neighbors` to locate the exact change IDs that
introduced the unwanted intent. Prefer semantic identity over guessing from
the current bytes.

Call `vcs.revert` with those change IDs, the current context, exact working
head, and a fresh command ID. Revert authors a new work unit and application;
it does not erase or rewrite the original record.

## Preserve unrelated work

Revert computes explicit counteractions against the current basis. It may
restore content, placement, mode, or repository presence while leaving later
unrelated changes intact. Inspect the returned change IDs and run focused tests
before committing.

Use `discard` instead when the whole uncommitted local chain is unwanted. Use a
new edit when the desired behavior is not the inverse of a named prior change.

On `ConflictPresent`, inspect the cited changes and current state. Author a
deliberate reconciliation rather than forcing old bytes over new intent. On
`DependencyBlocked`, inspect `blockingChangeIds`: they are later live changes
on the same semantic coordinate or live files contained by a repository whose
creation is being counteracted. Counteract those first or include the exact
file-creation changes when they belong to the same intended reversal. A
repository-create counteraction never hides or absorbs an unselected later
file. Ask the user which behavior should survive rather than forcing the older
inverse through it.

Commit the complete local chain when the revert is verified. Blame and history
will then show both the original change and its counteraction.
