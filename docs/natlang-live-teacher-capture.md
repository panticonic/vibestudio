# Live teacher capture

Live workflow collection executes the authored Natlang root against real caller-scoped services. Policy stays in the `.nl` program. The capture, record joins, ownership checks and paged export are exact transport and durability plumbing.

## Mechanism inventory

- `packages/natlang/src/driver.ts` is the shared Natlang gateway boundary for generation and decision scoring. Capture therefore applies to every gateway provider without changing its serving protocol. Requests are snapshotted before dispatch; replies and errors are actual returned values.
- `models.ts` resolves the executor role for root and child calls. A capture-scoped executor selection resolves that role to the explicit teacher throughout the tree. Explicit named model selections retain their own identity. `.on({model})` keeps its ordinary non-inheriting semantics.
- `recordsStore.ts` joins exchanges by their actual invocation ID into the completed call record. Existing record retention and flush semantics apply. Capture does not create permanent annotations.
- `evalNatlang.ts` exposes `natlang.captureModelTurns({executorModel})` before the first Natlang call in the current eval run. Capture and executor selection reset for the next run. Ordinary runs retain no raw model contexts.
- The gateway's Pi request context and original assistant response are retained only when capture is enabled. Original tool-call IDs are preserved alongside the normalized Natlang reply. Gateway attribution describes the authenticated transport caller; call-summary owner and run fields identify the eval owner.
- The system-testing runner invokes `skills/vibestudio-workflows/runWorkflow.nl` in a seeded, caller-owned context. The shared lambda calls a typed skill tree with that scenario's assigned input and live service bindings. Panel repair uses real browser, VCS and build ports. Workspace integration uses actual conflict and decision history. Worker repair uses real compiler reports and the original manifest-declared workerd suite through Testbench. A finite EvalDO retains the run, skill calls and nested records before scope disposal.
- Training admission and effect verification consume these records separately. A live browser/workspace episode is observed evidence, not a claim that external effects can be exactly replayed as a portable fixture. The independent system-test oracle remains separate from the teacher's report.

## Use

List the available cases, then select workflows from the Vibestudio host checkout with the development templates configured. Use a new output directory and a model enabled on the collection machine.

```sh
pnpm natlang:teacher --list
pnpm natlang:teacher --case panel-draft-unmount --out /path/to/new-run
```

The catalog includes browser-driven panel repair, workspace VCS integration, worker diagnosis and repair,
grounded document projects, and stateful incident and release handoffs. Worker worlds cover behavior such
as routing precedence, event ordering and queue admission. Content worlds include access offboarding,
inventory migration, consent, event logistics, and dataset release and recall. Operations worlds vary
restoration and recovery readiness, approval changes, rejected gates, and continuation from durable state.
Messaging worlds exercise addressed local delivery and holding an ambiguous recipient in synthetic owned channels.
The release-readiness dossier joins two skill trees in one call. It requires observed recovery after a real worker restart
and verified cleanup before the project skill can prepare and commit the evidence dossier.
The authored inventory comes from the configured system-testing template, which supplies
the same worlds to the explicit system-test runner. `--list` prints each case's source groups for split hygiene.
Repeat `--case` to run selected cases sequentially in one managed
workspace. Each case gets its own system-test run, owned fixture context, source receipt and output under `cases/<case>/`.
The final status indicates whether every selected case succeeded. Successful cases remain available when a later one fails. The collector starts one isolated managed Vibestudio
instance, checks the vendored Natlang build, pins the host and templates, and retains the full
system-test trajectory. A new workspace can ask for access to the selected model's credential.
The approval identifies the model gateway and provider for that workspace.

Content cases and the release-readiness dossier need `--review-model PROVIDER:MODEL` with a model distinct from the executor. The independent judge
reads the actual committed document bytes against the test's original goal and facts. It uses the built Natlang Node host
in `$NATLANG_REPO` (default `~/natlang`) and its configured provider login. The artifact retains the review separately from
executor targets.

On success, `verified/manifest.json` binds the original call tree and the independent effect checks. For shared-program
runs the exporter requires the common root, the assigned skill as its direct child, and that skill's own nested stages.
The verified
manifest is the input to Natlang's [shared SFT pipeline](https://github.com/werg/natlang/blob/main/plans/neuralese/LIVE_WORKFLOW_SFT_20261118.md).
Failed runs retain diagnostic artifacts.

## Capture API

Enable capture before executing the program:

```ts
natlang.captureModelTurns({ executorModel: "provider:model" });
const program = await natlang.load("skills/example/root.nl", {
  services: { world: callerOwnedWorld },
});
await program(actualInput);
```

Use the completed run's actual root IDs and raw traces. Export rejects incomplete records, a different run, missing parents or mixed owners. The teacher capture rejects any captured generation whose actual returned model differs from the chosen teacher. If a call is missing, treat the episode as incomplete and rerun it in a fresh owned fixture; do not synthesize a request or reply.

## Console history provider parity

The first direct live teacher reached the real panel service, then failed because the headless console store returned the pre-pagination result while `panelCdp.consoleHistory` requires a `page` object. The schema and panel observation contracts already describe a stable sequence cursor. Desktop's CDP provider implements that cursor and every advertised source/text/time filter; headless previously implemented only level filtering and limits.

The mechanism inventory covers the headless `ConsoleHistoryStore` and its `HeadlessHost` dispatcher, desktop `CdpHostProvider` (including its durable runtime-diagnostics-backed history), the shared panel observation contract, and the validating `panelCdp` RPC schema. Mobile-held panels do not provide CDP (`src/server/panelRuntimeRegistration.ts`); they do not implement a third console-history store. Shared filtering/paging is exact observation plumbing, not a model policy. Both providers use the same filter/page functions, while each retains its own ingestion and storage. The desktop durable diagnostic store keeps its existing filtering before shared pagination.
