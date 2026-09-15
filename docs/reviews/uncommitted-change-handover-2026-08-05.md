# Uncommitted change review handover

**Review date:** 2026-08-05  
**Scope:** the complete uncommitted working tree, including staged and untracked source files  
**Status:** findings are open; no repair is claimed here

## Executive summary

The working tree contains a large approval, runtime, authority, and panel-lifecycle change. The central design issue is the boundary around `runtime.activateReservedEntity`: trusted host recovery genuinely needs to finish durable reservations, but the same public RPC is also used by ordinary panel creation and is declared available to `host`, `user`, and `code`. The implementation currently does not verify that an external caller owns the reservation.

Four additional findings remain:

1. Install-review permission selections can be consumed and lost before admission commits.
2. The terminal approval surface hides everyday permissions while keyboard navigation can still toggle them.
3. Multi-approval startup resolution can strand the remaining approvals after one partial success.
4. The current tree does not pass all release gates: userland type-checking, the service-authority golden test, lint, formatting, generated product seed, and generated agent documentation all need attention. One full-suite EvalDO timeout also needs concurrency/flakiness follow-up.

The first two items require protocol or authority design work. The terminal UI and release-gate items are comparatively direct. Startup resolution needs an idempotent or transactional API rather than a local retry loop.

## 1. Activation and cross-principal recovery

### Terminology

`reserveEntity()` creates a durable, non-executable runtime record. It assigns the entity's stable identity, context, parent/owner metadata, and state arguments, then leaves the record in `preparing` status. `activateReservedEntity()` prepares the immutable build, records its execution identity, and changes the record to `active`.

The reservation is a durable claim ticket, not a permission grant: reserve, create a durable preparing record, activate, then run the executable runtime.

### Where activation is used

There are two legitimate activation paths.

**Normal panel creation.** The panel runtime reserves an entity, commits the panel slot, and directly activates it so `openPanel()` can wait for the executable handle and return a ready panel. See [`panelRuntime.ts`](/home/werg/vibestudio/workspace/packages/runtime/src/shared/panelRuntime.ts:1220) and [`panelRuntime.ts`](/home/werg/vibestudio/workspace/packages/runtime/src/shared/panelRuntime.ts:1280). The host shell's [`panelManager.ts`](/home/werg/vibestudio/packages/shell-core/src/panelManager.ts:517) follows the same pattern.

**Crash and restart recovery.** The server watches for durable panel slots that remain `preparing`, retries them after failures, and scans them during startup. See [`panelExecutionReconciler.ts`](/home/werg/vibestudio/src/server/panelExecutionReconciler.ts:32), [`panelExecutionReconciler.ts`](/home/werg/vibestudio/src/server/panelExecutionReconciler.ts:37), and [`index.ts`](/home/werg/vibestudio/src/server/index.ts:6034). The reconciler calls the internal runtime method with no request caller at [`index.ts`](/home/werg/vibestudio/src/server/index.ts:3912) and [`runtimeService.ts`](/home/werg/vibestudio/src/server/services/runtimeService.ts:1924).

This is “cross-principal recovery”: the principal that created the reservation may be gone, while the trusted server later completes the same durable intent. It is not a requirement for arbitrary code to activate arbitrary entities.

### Boundary problem and security impact

The public service schema declares `activateReservedEntity` for `host`, `user`, and `code` principals at [`runtime.ts`](/home/werg/vibestudio/packages/service-schemas/src/runtime.ts:655). The handler receives the caller, but the implementation deliberately ignores it and checks only the supplied identity tuple at [`runtimeService.ts`](/home/werg/vibestudio/src/server/services/runtimeService.ts:684).

The identity checks prevent redirecting activation to a different source, class, or key. They do not prove that the caller owns the reservation. If an unrelated code or user principal obtains the exact reservation identity, it can trigger execution of another principal's preparing entity. This is an authorization/integrity issue, not unrestricted code injection: the trusted host completing its own recovery is safe, but the public operation does not distinguish trusted recovery from external activation.

### Recommended direction

Do not simply delete the normal activation call: the panel runtime currently depends on it for the synchronous success path. Choose one explicit design:

- Keep public activation for ordinary panel creation, but require the caller to prove ownership of the reservation. Give the server reconciler a separate internal/host-only recovery operation.
- Or make activation host-only and redesign panel creation so the server/host activates after slot commit while the panel runtime waits for an active result. This is a larger protocol change and changes readiness/error timing.

The preferred minimal boundary is caller-owned normal activation plus a distinct trusted recovery path. Do not use the deterministic identity tuple as an implicit authorization capability.

Required tests: the reservation owner can activate; an unrelated code/user caller is rejected; the internal startup reconciler can recover a reservation whose original request disappeared; recovery cannot change source, class, key, context, or durable owner.

## 2. Install-review selections can be lost

The approval queue records the user's per-permission selections, but the launch admission path consumes them before admission and grant persistence completes. See [`installReviewSelections.ts`](/home/werg/vibestudio/src/server/services/installReviewSelections.ts:45), [`index.ts`](/home/werg/vibestudio/src/server/index.ts:1092), and [`unitInstallAcceptance.ts`](/home/werg/vibestudio/src/server/services/unitInstallAcceptance.ts:99).

`prepareUnitInstallReview()` rolls back the admission ledger and clearance grants when preparation fails, but it cannot restore the already-consumed selection. A unit without an effective version also consumes the selection and is then dropped before admission.

The store distinguishes an explicit empty selection from no selection. No selection may mean the default clearable slate is carried forward or granted, so a retry after a transient failure can silently change what the user chose.

### Recommended direction

Make the selection-to-admission handoff transactional or lease-based. Keep the selection recoverable until admission commits, and discard it only after commit or explicit cancellation. Cover both persistence failures and the no-effective-version path. A narrow catch that re-records selections around one write is not sufficient; every no-admission path needs the same state-machine semantics.

## 3. Terminal approval UI hides everyday permissions

The terminal approval overlay renders a part's `notableRows`, but renders everyday permissions only as a count at [`ApprovalsOverlay.tsx`](/home/werg/vibestudio/workspace/apps/terminal-browser/src/ui/ApprovalsOverlay.tsx:206) and [`ApprovalsOverlay.tsx`](/home/werg/vibestudio/workspace/apps/terminal-browser/src/ui/ApprovalsOverlay.tsx:263).

The terminal navigation reducer nevertheless includes both notable and everyday rows and lets Tab/Space move through or toggle them at [`installReviewNav.ts`](/home/werg/vibestudio/workspace/apps/terminal-browser/src/host/installReviewNav.ts:90) and [`installReviewNav.ts`](/home/werg/vibestudio/workspace/apps/terminal-browser/src/host/installReviewNav.ts:114).

Users can therefore change the decision for a row with no visible label or description. Desktop and mobile already provide an everyday-permission disclosure and row rendering; the terminal surface is the outlier. Its current test only asserts the summary count at [`ApprovalsOverlay.test.tsx`](/home/werg/vibestudio/workspace/apps/terminal-browser/src/ui/ApprovalsOverlay.test.tsx:145).

### Recommended direction

Use the same disclosure model as desktop/mobile, or restrict terminal navigation to rows actually rendered. Prefer the former so the terminal keeps per-permission selection parity. Add tests for collapsed, expanded, focused, and toggled everyday rows.

## 4. Multi-approval startup resolution is not recoverable

`HostLaunchClient.resolveApprovals()` resolves startup approvals one at a time at [`hostLaunchClient.ts`](/home/werg/vibestudio/packages/service-schemas/src/clients/hostLaunchClient.ts:143). If approval A succeeds and approval B fails transiently, A has already been removed from the server queue. The client still retains the original list; a retry starts with A again, receives `ENOENT`, and never reaches B. See [`shellApprovalService.ts`](/home/werg/vibestudio/src/server/services/shellApprovalService.ts:160) and [`bootstrap/index.ts`](/home/werg/vibestudio/src/bootstrap/index.ts:155).

### Recommended direction

Prefer a server-side bulk resolution operation with an explicit partial-result contract, or make individual resolution idempotent and have the client refresh and continue after each success. `Promise.all()` alone is not a transaction and would still allow partial success without a recovery protocol.

Required tests: two approvals with the second resolution failing; retry completion of the second; harmless retry of an already-resolved approval; correct final state for both denial and acceptance.

## 5. Validation and generated-artifact blockers

These are mostly direct fixes or regeneration tasks, but the tree is not ready for a clean release gate.

### Userland type-check failures

`pnpm type-check:userland` currently reports:

- a tuple mock inferred with no arguments at [`test-runner.test.ts`](/home/werg/vibestudio/workspace/skills/system-testing/test-runner.test.ts:358);
- `SystemTestJsonValue` re-exported but not locally bound at [`types.ts`](/home/werg/vibestudio/workspace/skills/system-testing/types.ts:195);
- an optional content type producing `string | undefined` where `string[]` is required at [`validation-failure.ts`](/home/werg/vibestudio/workspace/skills/system-testing/validation-failure.ts:22).

### Host and generated gates

- The full host suite fails the compositional service-authority golden because the new `recoverExecution` method is absent from the expected matrix. The relevant test is [`serviceAuthorityMatrix.test.ts`](/home/werg/vibestudio/src/server/services/serviceAuthorityMatrix.test.ts:147).
- `pnpm lint` reports an unused `explicitContextId` at [`runtimeService.ts`](/home/werg/vibestudio/src/server/services/runtimeService.ts:579).
- `pnpm format:check` reports five changed files: `src/cli/systemTestCommands.test.ts`, `src/dev/runSystemTest.ts`, `src/server/rpcServer.ts`, `src/server/services/panelRuntimeService.ts`, and `src/server/vcsHost/workspaceVcs.ts`.
- Product seed records for `apps/shell` are stale in [`workspace/apps/shell/.vibestudio-seed.json`](/home/werg/vibestudio/workspace/apps/shell/.vibestudio-seed.json).
- Generated agent documentation is stale in [`skills/vibestudio-agent/API.md`](/home/werg/vibestudio/skills/vibestudio-agent/API.md).

The full host run also had one EvalDO deadline test timeout under concurrent load. The entire `EvalDO.cancel.test.ts` file passes in isolation, so this is a validation-stability issue until reproduced independently, not yet a confirmed product defect.

## Validation record

Passed:

- `pnpm type-check:host`;
- full userland tests: 416 files, 3,641 tests passed;
- browser tests: 5 files, 18 tests passed;
- mobile tests: 26 suites, 189 tests passed;
- focused approval, authority, runtime, panel, and EvalDO tests;
- unit-authority, host-boundary, no-single-user, VCS-release, runtime-docs, and execution-root-provider checks.

Failed or incomplete:

- `pnpm type-check:userland`;
- full host tests: 583 files passed, 2 failed;
- lint, formatting, product-seed, and agent-doc gates.

The tracked diff passes `git diff HEAD --check`. No source repair has been applied as part of this handover.

## Recommended repair order

1. Decide and enforce the activation boundary; add owner and trusted-recovery regressions before changing the public authority contract.
2. Make install-review selection handoff transactional.
3. Fix terminal disclosure/navigation parity.
4. Make multi-approval startup resolution idempotent or bulk-transactional.
5. Repair type errors and generated artifacts, then rerun focused tests and the full host/userland gates.
