# Typed recovery

Treat the structured error code and fields as authoritative. Messages are explanation, not a protocol to parse.

## Basis and identity

- `RevisionChanged`: call status, compare the new exact state, and retry with a fresh command ID. Reuse the old ID only when retrying the identical uncertain request.
- `CommandIdReuse`: the command ID was attached to different content. Generate a new ID for the new request.
- `InvalidReference`: refresh the relevant typed identity through status, inspect, list, or resolve. Do not reconstruct opaque IDs.
- `Unauthorized`: stop and obtain the missing authority; changing the payload is not recovery.

## Merge

- `ConflictPresent`: one or more explicitly selected coordinates are conflicted. Read every returned aspect, attribution chain, resolution list, and both intent projections. Choose `theirs` or `ours`, or author the truthful combined state and choose `current`.
- `CoupledGroupIncomplete`: use the returned group and coordinates. Select all members together or omit the explicit list so the planner chooses a valid bounded page.
- `ScopeTooLarge`: page compare or narrow the coordinate selection. A structural group is indivisible; never trim its members to fit.
- `IntegrationIncomplete`: a commit, finalization, or publication revalidation found source coordinates without reachable accounting. Compare the named source against the exact current head, merge or resolve the remaining coordinates, verify `complete && concluded`, and commit again.
- `IntegrityFailure`: stop. The fact difference cannot be fully attributed or a durable edge is inconsistent. Capture the typed handle and exact coordinate; do not create a compensating write or broaden a prompt.

## Authoring and lifecycle

- `DestinationOccupied`: inspect the current stable identity at the destination. Choose a genuinely free path or deliberately edit/move the existing identity.
- `NoEffect`: inspect current state. Treat it as success only when the intended semantic result already holds; otherwise the planned operation was wrong.
- `WorkingChangesPresent`: finish, commit, or discard the exact local chain before the requested clean-state operation.
- `ConflictPresent` from revert: newer live state makes the counteraction untruthful. Inspect the coordinate and author a deliberate current result rather than forcing old bytes.

## Host effects and publication

- `ExternalEffectFailed`: the semantic mutation or read is waiting on an exact host effect. Preserve the command ID for an identical retry and inspect the effect diagnostics.
- `BuildGateFailed`: repair the returned exact-candidate diagnostics, commit a new event, and push that new event. Never bypass the candidate gate.

## Safe retry rule

An uncertain response may be retried with the same command ID only when method, arguments, expected basis, cause, and intent are byte-equivalent. A changed basis, coordinate list, resolution, rationale, or intent is a new semantic request and needs a new command ID.
