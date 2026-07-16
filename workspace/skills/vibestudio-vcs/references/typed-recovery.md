# Typed recovery

## Preserve idempotency

Generate one globally unique command ID for each intended mutation. Focused
agent tools derive it from their exact invocation. Retain the complete request
until the response is known.

- Retry the identical request with the same command ID after a timeout,
  disconnect, or uncertain host effect.
- Use a new command ID after changing any payload field or expected state.
- Treat `CommandIdReuse` as evidence that the ID was paired with different
  intent. Stop and inspect rather than guessing which request won.

## Recover by error code

- `RevisionChanged`: call `status`, re-read affected facts, and re-plan from
  `actual`. Use a new command ID for the revised request.
- `InvalidReference`: inspect the typed reference at the exact state; do not
  substitute a similarly named path or ID.
- `NoEffect`: inspect current state. Report success only if it already matches
  the requested intent; otherwise reformulate with a new command ID.
- `DestinationOccupied`: read the destination and ask whether to replace,
  move, or choose another path.
- `ConflictPresent`: inspect the cited changes and take an explicit edit or
  integration decision.
- `DependencyBlocked`: inspect `blockingChangeIds`, handle those live changes
  first, then compare or revert again. This ordering is derived from the exact
  current state; it is not a stored dependency list.
- `IntegrationIncomplete`: compare again and finish local decisions before
  committing an integration event.
- `WorkingChangesPresent`: commit or discard the complete local chain before
  import or push.
- `ScopeTooLarge`: narrow the requested range, page, or change group without
  changing semantic intent.
- `Unauthorized`: distinguish missing authorization from an agent-bound relay that
  dropped its causal invocation. Use the declared grant/approval flow for
  authorization; restore the real invocation edge for an agent path, never a
  wrapper or synthetic invocation.
- `ExternalEffectFailed`: preserve diagnostics; retry with the same command ID
  only when the original response remains uncertain and the request is exact.
- `IntegrityFailure`: stop mutation, preserve evidence, and escalate.

Known refusals stay structured across RPC, CLI, UI, and agent tools. Never use
message text as a control-flow protocol.
