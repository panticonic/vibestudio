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
- Prove an identical retry from the two returned mutation terminals and
  unchanged post-first/post-second status counts. A repository creation may
  legitimately author several changes while still creating exactly one
  application and work unit. `vcs.history` is for committed event history or
  an exact file's past; an application is a working head, so observe it with
  `status` and the mutation terminal instead of passing it as a history root.

Focused mutation tools intentionally derive a fresh command identity from each
tool invocation. To exercise or recover an uncertain lower-level request, run
the canonical client inside `eval`, retain the whole request object, and submit
that object unchanged. Do not call an invented compact
`vcs({ operation: "edit" })` operation.

This complete example discovers the disposable repository instead of guessing
its path, authors one file, and proves that an identical replay does not append
history:

```ts
const before = await vcs.status({ contextId });
const projects = await vcs.listDirectory({
  state: before.workingHead,
  path: "projects",
  limit: 100,
});
const repository = projects?.entries.find(
  (entry) => entry.repositoryRoot && entry.repositoryId,
);
if (!repository?.repositoryId) {
  throw new Error("No disposable repository was present under projects");
}

const suffix = crypto.randomUUID();
const request = {
  commandId: `idempotency-${suffix}`,
  contextId,
  expectedWorkingHead: before.workingHead,
  intentSummary: "Prove exact semantic command replay",
  changes: [
    {
      kind: "file-create" as const,
      repositoryId: repository.repositoryId,
      path: `idempotency-${suffix}.txt`,
      content: { kind: "text" as const, text: "one semantic effect\n" },
      mode: 0o644,
    },
  ],
};

const first = await vcs.edit(request);
const statusAfterFirst = await vcs.status({ contextId });
const second = await vcs.edit(request);
const statusAfterSecond = await vcs.status({ contextId });

return {
  before,
  request: { commandId: request.commandId },
  first,
  statusAfterFirst,
  second,
  statusAfterSecond,
};
```

The two mutation terminals must be identical, including command, application,
work-unit, and change identities. `statusAfterFirst` and `statusAfterSecond`
must also have identical heads and working counts.

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
- `BuildGateFailed`: read `errorData.diagnostics` using the same build-report
  diagnostic shape, repair the cited files, rerun the exact-context build
  report, commit the repaired chain, and retry publication from the new event.
- `IntegrityFailure`: stop mutation, preserve evidence, and escalate.

Known refusals stay structured across RPC, CLI, UI, and agent tools. Never use
message text as a control-flow protocol.

## Prove stale-basis recovery from native results

Keep typed status objects and mutation terminals rather than reconstructing IDs
or reducing application heads through an `eventId` field. For a disposable
demonstration, create new sibling repository roots such as
`projects/stale-demo-a-<suffix>` and `projects/stale-demo-b-<suffix>`; never
nest a repository beneath an existing project.

```ts
const before = await vcs.status({ contextId });
const retainedBasis = before.workingHead;

const advance = await vcs.edit({
  commandId: `advance-${suffix}`,
  contextId,
  expectedWorkingHead: retainedBasis,
  changes: [
    {
      kind: "repository-create",
      repoPath: `projects/stale-demo-a-${suffix}`,
      files: [{ path: "a.txt", content: { kind: "text", text: "A\n" } }],
    },
  ],
});
const afterAdvance = await vcs.status({ contextId });

let refusal: unknown;
try {
  await vcs.edit({
    commandId: `stale-${suffix}`,
    contextId,
    expectedWorkingHead: retainedBasis,
    changes: [
      {
        kind: "repository-create",
        repoPath: `projects/stale-demo-b-${suffix}`,
        files: [{ path: "b.txt", content: { kind: "text", text: "B\n" } }],
      },
    ],
  });
} catch (error) {
  refusal = { code: (error as { code?: unknown }).code, message: String(error) };
}

const afterRefusal = await vcs.status({ contextId });
const retry = await vcs.edit({
  commandId: `fresh-${suffix}`,
  contextId,
  expectedWorkingHead: afterRefusal.workingHead,
  changes: [
    {
      kind: "repository-create",
      repoPath: `projects/stale-demo-b-${suffix}`,
      files: [{ path: "b.txt", content: { kind: "text", text: "B\n" } }],
    },
  ],
});
const final = await vcs.status({ contextId });

return { retainedBasis, advance, afterAdvance, refusal, afterRefusal, retry, final };
```

The proof is structural: `afterAdvance` and `afterRefusal` are identical,
`refusal.code` is `RevisionChanged`, `retry.commandId` differs from the stale
command, and `final.workingHead` equals `retry.workingHead`.

## Recover a committed scaffold whose publication failed

`createProject` and `forkProject` create one repository, commit the complete
local chain, and then call the separate protected `vcs.push` boundary. If push
fails after commit, they throw `ScaffoldPublicationError` with
`errorData.code === "scaffold_publication_failed"`. Its data includes the
created path and files, exact committed event, `published: false`, original
publication request, typed VCS cause, and retry policy.

Do not call the scaffold helper again: the repository and committed event
already exist. Call
`recoverProjectPublication(errorOrErrorData)` from
`@workspace-skills/workspace-dev`. It performs the required `vcs.status`
observation, refuses unless committed and working heads are the exact clean
`committedEventId`, validates the returned publication receipt, and never
recreates source or commits. It uses a new command ID after a known refusal and
the newly observed main, while reusing the original request only for an
identical `ExternalEffectFailed` attempt whose outcome is genuinely uncertain.
A mismatched publication receipt is `IntegrityFailure`: stop automatic
recovery and preserve the receipt evidence.
