# Agentic developer ergonomics — architectural follow-up plan

**Status:** proposed implementation plan, 2026-08-12  
**Scope:** completion contracts, exact verification identity, panel-runtime
cleanup ownership, panel lifecycle evidence, and provenance continuation
ergonomics  
**Supersedes:** no existing design document. This plan closes findings from the
agentic system-test review and narrows follow-up work already adjacent to
[WS1](ws1-agent-loop-spec.md), the
[panel presentation lifecycle](panel-presentation-lifecycle-plan.md), and
[intent-aware provenance](intent-provenance-follow-up.md).

## 1. Outcome

Five related defects remain after the low-risk system-test improvements:

1. A managed source-repair turn can publish a polished final response even
   when its edit has not been verified, committed, or left clean.
2. Verification receipts identify a context and unit, but do not all bind the
   exact semantic working state they observed.
3. Panel navigation commits a new slot incarnation and then asks the caller to
   retire the displaced incarnation as a separate destructive operation. That
   cleanup can become foreign to the caller that performed the navigation.
4. Before/after panel-tree snapshots cannot account for temporary creation,
   navigation, archival, or cleanup churn during a turn.
5. Provenance pagination still makes the model reconstruct a continuation from
   more than one independently editable field. Exact cursors are now compact,
   but copying any opaque or composite continuation remains the wrong agent
   interface.

The target is not five patches. It is five small contracts with one owner each:

| Contract                                | Owner                          | Consumer                                  |
| --------------------------------------- | ------------------------------ | ----------------------------------------- |
| Exact source-state verification receipt | build/test boundary            | tools, completion reducer, tests          |
| Task-scoped completion contract         | agent loop                     | task origins, trajectory/UI, system tests |
| Durable displaced-runtime cleanup       | workspace-state topology owner | host cleanup supervisor                   |
| Durable panel lifecycle ledger          | workspace-state topology owner | diagnostics, eval footer, system tests    |
| Self-contained provenance continuation  | provenance tool                | agents and model-facing renderers         |

The implementation order is deliberate:

```text
exact verification identity
          │
          ▼
completion evidence projection ──► task-scoped terminal gate

durable navigation cleanup ───────► panel lifecycle ledger

self-contained provenance continuation (independent)
```

### 1.1 Implementation map

The first implementation pass should stay inside these existing ownership
boundaries:

| Workstream                  | Primary code owners                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact verification identity | `src/server/buildV2/index.ts`, `src/server/services/buildService.ts`, `workspace/extensions/test-runner/index.ts`, `packages/service-schemas/src/build.ts`, `workspace/packages/harness/src/tools/verify.ts`                                                  |
| Completion contract         | `workspace/packages/agent-loop/src/{state,fold,effects,step}.ts`, a new `agent-loop/src/completion/` package boundary, `workspace/packages/agentic-do/src/effect-executors/index.ts`, canonical mutation/verify/VCS tools                                     |
| Panel cleanup ownership     | `packages/builtin/src/workspace-state/WorkspaceDO.ts`, `packages/service-schemas/src/workspaceState.ts`, `packages/shell-core/src/{workspaceStateClient,panelNavigationTransaction,panelManager}.ts`, `workspace/packages/runtime/src/shared/panelRuntime.ts` |
| Panel lifecycle ledger      | WorkspaceDO and workspace-state schema above, `workspace/packages/eval/src/sandbox.ts`, `workspace/packages/runtime/src/shared/journal.ts`, `workspace/skills/system-testing/tests/_panel-tree-invariant.ts`                                                  |
| Provenance continuation     | `workspace/packages/harness/src/tools/{provenance,provenance-format}.ts`, the bounded agent-pagination helper, and `workspace/workers/workspace-source/semanticWorkspace.ts` for the exact service cursor beneath it                                          |

Generated service catalogs and runtime API documents are regenerated from their
canonical schemas after each boundary change; they are not edited as a second
source.

## 2. Design laws

### 2.1 Evidence, not prose

Neither system prompts nor final-response wording may decide whether work is
complete. Completion is derived from typed, causally ordered receipts. Prompts
continue to teach the workflow, and skill-following tests separately assert
that the agent completed it without a runtime correction.

### 2.2 Task contracts come from trusted origins

The runtime must not infer a completion policy from arbitrary user prose and
must not parse tool result text. A trusted product/task origin attaches a typed
contract to the turn. Ordinary untyped chat retains ordinary natural closure
until a product surface deliberately opts into a contract.

This is intentionally narrower than a generic dirty-worktree guard. Dirty
contexts are valid for design drafts, exploratory edits, and explicit
local-only workflows.

### 2.3 Consequences belong to the authorized transaction

Once a slot transition is authorized and durably committed, retiring the
displaced runtime is a topology-owner consequence. It is not a second
caller-owned destructive action and must not require the navigating caller to
own the old incarnation.

### 2.4 One durable fact, many projections

The panel lifecycle ledger is the fact source. Agent diagnostics, eval
footers, and system-test invariants are bounded projections of it. A second
in-memory lifecycle history must not survive beside it.

### 2.5 One continuation scalar

A continuation call supplies one opaque scalar and nothing else. The scalar
contains all basis needed to resume exactly. No model must copy a cursor,
reconstruct a typed root, or combine a target with a separate page selector.

### 2.6 Replacement contracts replace

These changes are internal to this self-contained codebase. Do not add legacy
receipt readers, raw-cursor fallbacks, numbered-page compatibility, parallel
cleanup APIs, or dual panel journals. Migrate all callers and delete the old
surface in the same work package.

## 3. Workstream A — exact semantic verification identity

### 3.1 Current boundary

`verify` builds with `build.getBuildReport(target, ctx:<contextId>)` and tests
through the test-runner extension. The build metadata already carries a
`sourceState`; this gap was closed by `unit-verification-receipt.v1`. Test results carry
the context and counts but no equivalent exact semantic state.

Consequently, a validator can prove that a build or test ran in a context, but
not that it observed the final application produced by the edit chain. Ordering
is currently the strongest approximation.

### 3.2 Decision: one receipt for build and test

Replace the build-only receipt with one strict receipt emitted by the owning
execution boundary:

```ts
type VcsStateNodeRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };

interface UnitVerificationReceiptV1 {
  protocol: "unit-verification-receipt.v1";
  operation: "build" | "test";
  target: string; // canonical repo path of the exact unit
  contextId: string;
  observedWorkingHead: VcsStateNodeRef;
  unit: {
    repoPath: string;
    unitName?: string;
    kind: string;
  };
  status: "passed" | "failed" | "skipped" | "no-tests";
  reportDigest: string; // digest of the complete unbounded report
  request: {
    service: string;
    method: string;
    args: unknown[];
  };
}
```

Build- and test-specific bounded details remain beside the receipt; they do not
change its identity semantics.

The receipt is valid only if:

- the execution boundary resolved `ctx:<contextId>` once;
- materialization, execution, and the returned `observedWorkingHead` refer to
  that same resolved state;
- every build artifact in a multi-build unit reports the same source state;
- the canonical target resolves to exactly one unit;
- the full report is digested before model-facing truncation.

The harness must not reconstruct `observedWorkingHead` with a later
`vcs.status` call. A later status is a different observation.

### 3.3 Producing boundaries

Build:

1. Resolve the context ref to an exact `VcsStateNodeRef` in the build service.
2. Use that state for source closure/materialization.
3. Return it on `UnitBuildReportWire` and in the receipt.
4. Reject mixed-state build collections instead of choosing one state.

Test:

1. Resolve the context once in the test-runner extension before checkout.
2. Materialize the exact resolved state.
3. Return `observedWorkingHead` and canonical unit identity with the unbounded
   test report.
4. Create the same receipt shape in the service result, not later in the agent
   tool.

### 3.4 Consumer migration

Update these consumers together:

- `workspace/packages/harness/src/tools/verify.ts` and its tests;
- the build and test service schemas;
- the test-runner extension contract and tests;
- `workspace/skills/system-testing/tests/_managed-unit-evidence.ts`;
- app, extension, performance, and scaffold validators;
- skill documentation for `unit-verification-receipt.v1`.

The former build-only receipt and its renderer assumptions were deleted; every
consumer checks the common protocol. There is no period in which both receipts
are accepted.

### 3.5 Acceptance gates

- A verification against application `A2` rejects when a validator expects
  `A1`, even in the same context and unit.
- A test and build against the same final application produce matching
  `observedWorkingHead` values.
- Context mutation during materialization either leaves the receipt bound to
  the already resolved state or aborts; it never silently advances the receipt.
- Model-facing truncation does not change `reportDigest`.
- Conventional unit tests cover event-state verification as well as dirty
  application-state verification.

## 4. Workstream B — task-scoped completion contracts

### 4.1 Scope

The first contract is `managed-executable-repair`. It applies only when a
trusted task origin asks an agent to repair a managed app, extension, panel,
worker, or other executable unit and supplies the required disposition.

It does not apply automatically to:

- ordinary untyped chat;
- read-only review or diagnosis;
- an explicit local draft;
- changes whose task contract requires no durable commit;
- publication to protected main, which remains a separate requested action.

### 4.2 Turn contract

Extend `AgentTurnMetadata` with a strict contract:

```ts
interface ManagedExecutableRepairContractV1 {
  protocol: "agent-task-contract.v1";
  kind: "managed-executable-repair";
  target: {
    contextId: string;
    units: string[]; // canonical repo paths; non-empty and unique
  };
  disposition:
    | { kind: "durable-local-commit" }
    | { kind: "local-draft"; requestedByMessageId: string };
  requiredVerification: Array<"test" | "build">;
}
```

Only trusted host/product command construction may attach this field. Channel
event metadata received from an untrusted participant is stripped before it
becomes a command. System tests use the same headless task-origin API as product
repair cards; they do not inject a prompt sentence describing the workflow.

`local-draft` is an explicit contract chosen by the task origin. The agent
cannot waive a durable contract after editing, and the runtime does not decide
that a phrase merely resembles “do not commit.” Product surfaces that cannot
state a reliable disposition must omit the completion contract.

### 4.3 Normalized evidence

Agent-loop must not know `apply_patch`, `verify`, or `vcs` result schemas.
Relevant tools instead return a hidden execution projection alongside their
ordinary model/UI result:

```ts
type CompletionEvidenceV1 =
  | {
      kind: "managed-mutation";
      contextId: string;
      unit: string;
      applicationId: string;
      resultingWorkingHead: { kind: "application"; applicationId: string };
      changedPaths: string[];
    }
  | {
      kind: "unit-verification";
      contextId: string;
      unit: string;
      operation: "test" | "build";
      observedWorkingHead: VcsStateNodeRef;
      status: "passed";
      reportDigest: string;
    }
  | {
      kind: "workspace-commit";
      contextId: string;
      eventId: string;
      committedApplicationIds: string[];
      resultingWorkingHead: { kind: "event"; eventId: string };
    }
  | {
      kind: "workspace-status";
      contextId: string;
      workingHead: VcsStateNodeRef;
      clean: boolean;
      workingCounts: { applications: number; workUnits: number; changes: number };
    }
  | {
      kind: "blocking-failure";
      invocationId: string;
      code: string;
      category: "authority" | "credential" | "infrastructure" | "domain";
      retry: "none" | "after-state-change";
    };
```

The local-tool executor carries this projection on `EffectOutcome`; the pure
outcome mapper journals it in the exact `invocation.completed` or
`invocation.failed` event. The ordinary result can be artifact-backed or
truncated without affecting completion evidence.

Evidence projection belongs to the canonical tool implementation:

- write/edit/apply-patch/file-transfer project managed mutation facts;
- verify projects the service-produced receipt;
- VCS commit projects both the commit and the post-commit clean status it
  already checks;
- VCS status projects a status fact;
- canonical failures project a blocking fact only when their retry contract
  truly requires an external state change.

No generic executor parses protocol text or arbitrary `details` objects.

### 4.4 Pure completion reducer

Add a pure package under `workspace/packages/agent-loop/src/completion/`:

```text
completion/
  contract.ts       strict contract and evidence types
  fold.ts           evidence events -> CompletionLedger
  assess.ts         contract + ledger -> CompletionAssessment
  prompt.ts         bounded missing-requirements diagnostic
```

`CompletionLedger` is a projection in `AgentState`, rebuilt from the trajectory
and included in the fold-cache projection version. It is never a second stored
authority.

For each affected `{contextId, unit}`, assessment requires:

1. one or more managed mutation applications after contract activation;
2. successful required verification receipts after the final mutation;
3. every verification receipt observing the final application head;
4. a later commit whose `committedApplicationIds` covers the complete mutation
   application chain;
5. a clean status at that exact committed event with zero working counts.

A new mutation invalidates earlier verification and commit satisfaction. A
verification of another unit or context is irrelevant. A commit that consumes
only part of the application chain is not completion.

For `local-draft`, the reducer requires the requested verification but no
commit or clean predicate. This is a distinct task contract, not an exception
inside the durable policy.

### 4.5 Terminal gate

Each model request on a contracted turn snapshots one assessment:

```ts
type CompletionAssessment =
  | { status: "satisfied" }
  | { status: "open"; missing: CompletionRequirement[] }
  | { status: "blocked"; blocker: BlockingFailure; missing: CompletionRequirement[] };
```

This snapshot is part of the durable `message.started.modelRequest`. Evidence
cannot change while that model call is running.

When the model returns a text-only candidate:

- `satisfied`: publish the ordinary assistant completion and close the turn;
- `blocked`: publish the response and close with reason `task_blocked`, retaining
  the blocker and missing predicates in `turn.closed`;
- `open`: journal the assistant completion trajectory-only, append one bounded
  `completion.requirements_missing` system event, and start another model call
  in the same turn.

The missing-requirements event names predicates, not tool choreography. Example:

```text
This managed repair is not complete: extensions/example was changed at
application A2, but no successful build observed A2 and no commit consumed A1–A2.
Continue the task or report an authoritative blocker.
```

The candidate remains in model context so the continuation does not discard
its reasoning, but it is not published as the user's final answer.

After two rejected candidates with no new evidence, close as a structured
agent-execution failure `completion_contract_stalled`; do not misreport the
task as completed or blocked. This bound prevents an infinite model loop while
keeping model failure distinct from a real external blocker.

### 4.6 Skill-behavior tests remain honest

Completion enforcement must not turn workflow tests into “eventually the
runtime coached the model” tests. Managed system-test results therefore expose:

- final `CompletionAssessment`;
- count and missing predicates of rejected completion candidates;
- exact evidence facts and source invocation IDs.

App/extension workflow scenarios use vague prompts and require:

- satisfied causal completion evidence; and
- zero `completion.requirements_missing` events when the scenario is intended
  to test skill/system-prompt behavior.

Separate recovery scenarios deliberately omit a step and assert that the
runtime continues once, then converges. The prompt never names the omitted
step.

### 4.7 Migration and deletion

1. Land exact receipts from Workstream A.
2. Land evidence types and projections with no terminal behavior change.
3. Add contracted task-origin support to headless/product repair entry points.
4. Add the terminal gate and UI projection for rejected candidates.
5. Migrate managed system-test validators to the canonical assessment.
6. Delete duplicated causal decoders in
   `_managed-unit-evidence.ts` once no scenario needs them.
7. Keep the system-prompt workflow paragraph as guidance; remove any test-only
   completion reminders.

### 4.8 Acceptance gates

- Edit + final response does not publish or close a contracted durable repair.
- Edit + stale verification does not close.
- Edit + exact test/build + partial-chain commit does not close.
- Exact test/build + whole-chain commit + embedded clean status closes once.
- An explicit typed local-draft task closes without a commit after its required
  verification.
- An authority denial with no allowed recovery closes as `task_blocked`, not
  `completed`.
- Two evidence-free completion attempts become a typed execution failure.
- Replay and fold-cache eviction produce the same assessment and publication.

## 5. Workstream C — topology-owned displaced-runtime cleanup

### 5.1 Current split transaction

`slot.commitPreparedNavigation` atomically changes durable slot history and the
current entity. `commitPreparedPanelNavigation` then calls
`runtime.retireEntity(previousEntityId)` using the navigating caller's
authority. The commit succeeds even if retirement fails.

This creates an ownership inversion:

- the old incarnation may belong to the harness or another panel context;
- the replacement belongs to the navigating agent;
- navigating the stable slot is authorized;
- retiring the old incarnation becomes a separate critical foreign-context
  operation.

Expanding unattended critical authority would conceal the inversion.

### 5.2 Decision: enqueue cleanup in the slot transaction

The WorkspaceDO transaction that commits navigation must also enqueue the
displaced entity for host-owned cleanup. The caller receives the committed
transition and never calls `runtime.retireEntity` for the old incarnation.

Replace the close-specific queue with one queue:

```sql
CREATE TABLE panel_runtime_cleanup (
  cleanup_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('slot-close', 'navigation-displaced')),
  enqueued_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

The navigation transaction inserts a deterministic cleanup row for
`previousEntityId` when it differs from `currentEntityId`. Slot close inserts
one row per retired slot/entity in the same table. A single bounded supervisor
API pages, attempts, and acknowledges both reasons.

`cleanup_id` is derived from the committed semantic transition, not random
retry state. Replaying the same navigation commit cannot enqueue duplicate
work.

### 5.3 One supervisor path

Replace:

- `slot.closeCleanupPage`;
- `slot.acknowledgeCloseCleanup`;
- direct post-navigation retirement in `panelNavigationTransaction.ts`.

with:

```ts
workspace-state.panelRuntimeCleanup.page({ cursor?, limit? })
workspace-state.panelRuntimeCleanup.ack({ cleanupIds: string[] })
workspace-state.panelRuntimeCleanup.fail({ cleanupId, error })
```

These methods are host/supervisor-only and do not use the initiating caller's
prepared `context.boundary` leaf. The supervisor performs the exact runtime
retirement as a consequence of topology state it owns.

`commitPreparedPanelNavigation` becomes only the semantic commit wrapper. Its
result no longer contains `retirement.status`; callers do not warn and continue
on a cleanup failure. Cleanup state is observable through the queue and panel
diagnostics.

### 5.4 Failure and recovery

- A semantic commit failure enqueues nothing.
- A lost commit response is reconciled by rereading the slot; deterministic
  queue identity makes replay safe.
- Runtime retirement failure retains the queue row with bounded error metadata
  and schedules normal supervisor retry.
- Presentation follows the durable current entity immediately; cleanup lag
  cannot roll the slot back.
- Cleanup never retires the current entity. The supervisor rechecks the slot's
  current entity immediately before retirement and treats a matching entity as
  an integrity error.
- Startup reconciliation drains pending cleanup; no initiating session must
  remain alive.

### 5.5 Acceptance gates

- A caller can navigate a slot whose old incarnation it does not own without a
  critical authority prompt.
- Navigation commit and cleanup enqueue are atomic under failure injection.
- Killing the caller after commit but before cleanup still retires the old
  incarnation.
- Replayed commits enqueue one cleanup item.
- Close and navigation use the same page/ack/failure supervisor path.
- No code outside the supervisor retires a displaced incarnation.

## 6. Workstream D — durable panel lifecycle evidence

### 6.1 Purpose

The ledger answers factual questions that snapshots cannot:

- Did this turn create a child and archive it before the final snapshot?
- Which stable slot was navigated, and which incarnation was displaced?
- Was cleanup enqueued, attempted, completed, or left pending?
- Did an agent remove a panel that predated its turn?
- Which operation caused a panel generation change seen in diagnostics?

It is an audit/projection source, not an event-sourced replacement for the
WorkspaceDO's slot, history, entity, or cleanup tables.

### 6.2 Canonical ledger

Append one event inside each successful WorkspaceDO mutation transaction:

```ts
interface PanelLifecycleEventV1 {
  protocol: "panel-lifecycle-event.v1";
  seq: number; // monotonic per workspace
  occurredAt: number;
  operationScopeId: string | null; // exact eval/tool/request scope
  actor: {
    principalId: string;
    contextId?: string;
    participantId?: string;
  };
  fact:
    | { kind: "slot-created"; slotId: string; parentSlotId: string | null; entityId: string }
    | { kind: "slot-moved"; slotId: string; fromParentId: string | null; toParentId: string | null }
    | {
        kind: "navigation-committed";
        slotId: string;
        previousEntityId: string;
        currentEntityId: string;
        entryKey: string;
      }
    | { kind: "slot-closed"; slotId: string; entityId: string | null; closeId: string }
    | {
        kind: "cleanup-enqueued";
        cleanupId: string;
        slotId: string;
        entityId: string | null;
        reason: string;
      }
    | { kind: "cleanup-completed"; cleanupId: string; entityId: string | null }
    | { kind: "cleanup-failed"; cleanupId: string; entityId: string | null; code: string };
}
```

The RPC/session layer propagates `operationScopeId` as call metadata. It is not
another public argument that every panel API caller must remember. Agent eval
uses the exact invocation ID; a direct product action uses its request/command
ID. Actor identity comes from authenticated dispatcher context, never input.

### 6.3 Read surfaces

One host/harness read API provides bounded pages:

```ts
panelLifecycle.read({
  afterSeq,
  throughSeq?,
  operationScopeId?,
  slotId?,
  limit
})
```

Rules:

- ascending sequence order;
- maximum page size 200;
- exact cursor/sequence continuation;
- no raw SQL or broad unbounded export;
- caller-specific access control identical to panel-tree visibility;
- retention is a bounded audit policy, initially 50,000 events per workspace;
  pruning never changes topology or cleanup authority.

Agent-facing `panelTree.diagnose(slotId)` includes the last bounded relevant
events as a projection. Do not expose a second general-purpose lifecycle tool
until an agent task demonstrates that exact need.

### 6.4 Replace the in-memory journal

The current `runtime.journal` records only `open`, `reload`, `close`, and
`stateArgs.set` in process-local arrays so eval can render a footer. It cannot
see cross-runtime cleanup, does not carry actor identity, and disappears at the
end of the scope.

After the durable ledger lands:

1. Eval records its `operationScopeId` and lifecycle start sequence.
2. After tracked work settles, eval reads the matching ledger range.
3. The existing concise footer becomes a renderer over those durable facts.
4. Delete `shared/journal.ts`, the `journal` runtime namespace, `currentJournal`
   hooks, its generated runtime-surface entry, and associated skill docs.

There is one lifecycle record. The footer remains a presentation, not a second
journal.

### 6.5 System-test invariant

At turn start, the harness records both:

- a visible-tree snapshot; and
- a lifecycle sequence boundary.

At turn end it reads through a fixed terminal sequence before harness cleanup.
The invariant then joins events and snapshots:

- every `slot-created` by the agent is either still visible (a leak) or has a
  later matching `slot-closed` by the agent;
- every agent-created slot that survives the turn is archived by harness
  cleanup and recorded separately as test cleanup, never mistaken for agent
  behavior;
- a pre-turn slot may be navigated but must not be closed by the agent unless
  the user requested removal;
- every displaced entity has one cleanup enqueue and eventually one completion;
- parent/child relationships come from the exact creation event, so transient
  children cannot disappear between snapshots unnoticed.

Creating and correctly closing a temporary panel is not automatically a test
failure. The event record makes that behavior explicit so each scenario can
state whether temporary work was necessary while the global invariant enforces
ownership and cleanup.

### 6.6 Acceptance gates

- Create-then-close within one turn is present in the ledger even though both
  snapshots are identical.
- Concurrent evals from one agent are separated by `operationScopeId`.
- Actor fields cannot be forged through method arguments.
- Navigation, queueing, and cleanup facts share exact entity IDs.
- Eval footer output is unchanged or more informative after its in-memory
  journal is deleted.
- A managed panel system test proves no agent-owned cleanup remains pending at
  terminal and then stops its instance cleanly.

## 7. Workstream E — self-contained provenance continuations

### 7.1 Failure to remove

The historical-file test first exposed a 1,096-character cursor that the model
mutated while copying. Compact exact-basis service cursors fixed that service
boundary. A later agent-facing numbered-page prototype kept raw cursors inside
trusted code but still asked the model to combine a long typed target with a
separate `{kind, page}` object. The model produced both page `1` and a
continuation accidentally nested inside `target`.

The remaining defect is the public continuation shape, not cursor validation
and not a need for looser parsing.

### 7.2 Flat schema

Keep the provider-facing schema as one flat object, avoiding top-level
`oneOf`/`allOf` composition that small local models handle poorly:

```ts
Type.Object(
  {
    target: Type.Optional(ProvenanceInitialTargetSchema),
    continuation: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
```

Runtime validation enforces:

- `{}` means initial session orientation;
- `{ target }` means one initial query;
- `{ continuation }` means one continuation query;
- `target` and `continuation` together reject;
- all other fields reject.

There is no raw cursor input and no `{kind,page}` input.

### 7.3 Token

The first result mints one token per available stream:

```text
prov-page-v1.<base64url(canonical-json)>.<sha256>
```

Canonical payload:

```ts
interface ProvenanceContinuationPayloadV1 {
  version: 1;
  root: VcsSemanticNodeRef; // exact typed root, never friendly path
  stream: "adjacency" | "file-history";
  page: number; // 2..20
}
```

The checksum detects copying/canonicalization corruption. It is not an
authorization token: callers can already submit semantic roots, and normal
service authority remains decisive. Decoder requirements:

- exact prefix and segment count;
- canonical base64url encoding;
- strict payload schema and version;
- canonical JSON byte equality;
- matching checksum using a domain-separated hash;
- page within the bounded agent-page range.

The tool replays service pages from the exact embedded root, forwarding each
service-produced exact cursor byte-for-byte internally until it reaches the
requested page. Friendly paths are never re-resolved during continuation.

This is stateless and works after tool-factory recreation. A short digest-only
handle would require durable lookup state and is deliberately not introduced.

### 7.4 Rendering

Text and structured details expose the same complete token:

```text
more file history → provenance({"continuation":"prov-page-v1.…"})
```

```ts
details.continuations = [{ stream: "file-history", continuation: "prov-page-v1.…" }];
```

At page 20, do not advertise page 21 even if the underlying service has more
data. Render that the bounded agent walk reached its cap and suggest narrowing
the target or using commit-anchored memory recall. A page beyond the stream
returns a typed `page-unavailable` diagnostic; it never falls back to page 1.

### 7.5 Replacement and tests

Replace the public continuation schema outright. Retain the useful internal
bounded replay helper, but delete:

- model-facing raw cursor inputs;
- model-facing numbered-page objects;
- formatter functions that repeat the typed target;
- any compatibility decoder for older shapes.

Required regressions:

- a continuation token is the sole input for page 2;
- a fresh tool instance decodes the same token;
- path/head mutation between calls cannot change the embedded basis;
- tampered, noncanonical, wrong-version, and out-of-range tokens fail before a
  VCS call;
- text and details contain byte-identical tokens;
- raw VCS cursors never appear in model content or details;
- page 20 never advertises page 21;
- full bounded paging returns the same results as direct service paging.

The sizable-history agentic scenario is rerun only after these conventional
tests pass. Its validator continues to require current-file evidence and the
buried historical decision; the prompt remains unchanged.

## 8. Delivery sequence

### Phase 1 — evidence foundations

1. Land `unit-verification-receipt.v1` and migrate every caller.
2. Add completion evidence projection to tool execution outcomes.
3. Add the pure ledger and assessment reducer with replay tests.

No terminal behavior changes in this phase.

### Phase 2 — contracted completion

1. Add trusted task-contract construction and metadata stripping.
2. Snapshot assessment into model requests.
3. Add publication gating, bounded continuation, blocked closure, and stalled
   execution failure.
4. Migrate managed authoring tests and delete their receipt decoders.

### Phase 3 — panel consequence ownership

1. Replace close-specific cleanup storage/API with the general cleanup queue.
2. Enqueue displaced runtime cleanup inside navigation commit.
3. Move all draining to the host supervisor.
4. Delete direct displaced retirement and `retirement.status` handling.

### Phase 4 — panel lifecycle evidence

1. Add ledger schema, transaction appends, and bounded reads.
2. Propagate authenticated operation-scope metadata.
3. Move diagnostics, eval footer, and system-test invariants to ledger
   projections.
4. Delete the in-memory runtime journal.

### Phase 5 — provenance continuation replacement

This phase is independent and may land in parallel with phases 1–4 once the
existing provenance files have a single owner. Replace the public contract in
one commit series and rerun the exact historical scenario on a fresh managed
instance.

## 9. Cross-workstream verification matrix

| Scenario                 | Required proof                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| Extension repair         | zero completion corrections; final app head tested, built, committed, clean      |
| Explicit local draft     | exact test/build state; no commit requirement; typed draft contract              |
| Stale verification       | completion remains open after a later edit                                       |
| Partial commit           | completion remains open until the full application chain is committed            |
| Blocked authority        | turn closes as blocked with exact failed invocation, never completed             |
| Foreign panel navigation | slot commits; no critical prompt; displaced cleanup completes after caller exits |
| Transient panel child    | lifecycle ledger records create and close despite equal snapshots                |
| Panel cleanup crash      | queued work survives restart and is drained once                                 |
| Historical file context  | continuation reaches buried history without target/cursor reconstruction         |
| Local-model schema smoke | flat continuation call validates without composed top-level schema               |

For agentic system tests, follow the managed-instance lifecycle in
`workspace/skills/system-testing/SKILL.md`: doctor, one exact scenario,
evidence-led inspection on failure, focused repair, fresh workspace when source
changed, and exact instance stop. Category or smoke expansion needs evidence of
a wider blast radius.

## 10. Definition of done

This plan is complete only when:

- contracted managed repairs cannot publish success without exact causal
  evidence;
- build and test receipts identify the exact semantic state observed;
- explicit typed draft and authoritative blocked outcomes remain truthful;
- displaced panel cleanup is topology-owned, durable, and uses one supervisor
  path;
- panel churn is durably attributable to an actor and operation scope;
- the in-memory panel journal and close-specific cleanup API are deleted;
- provenance continuation uses one stateless scalar with no legacy input path;
- vague system-test prompts contain no cleanup, test, build, commit, paging, or
  tool choreography;
- focused conventional tests and the smallest exact managed scenarios pass;
- every managed test instance and panel/inspector resource is stopped before
  handoff.
