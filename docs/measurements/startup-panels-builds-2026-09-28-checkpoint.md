# Historical performance investigation checkpoint

This records the earlier restart pause. The session resumed with unrestricted
filesystem/network access and approvals disabled. See the adjacent measurement
report for current findings and validation; the status below is historical.

Paused on 2026-09-28 at the user's request so they can restart the session and
repair the sandbox setting. User explicitly grants full permission to continue
autonomously. Do not ask task-level confirmations. Tool sandbox restrictions may
still require the mandated escalation mechanism.

Read the adjacent measurement report first. Original scope: profile and optimize
host, desktop, mobile, and their panels across startup/reconnect, panel opening
and switching, and chat response/streaming; include the host-internal builder and
cold startup with **no existing state folder**. This is ongoing work, not complete.

## Instructions and ownership

- Read root AGENTS.md and exact System performance skill at
  `/home/werg/vibestudio-release-work/templates/system/skills/performance/SKILL.md`.
  Do not use generic web-perf. No subagents requested/allowed.
- External templates are source inputs. Run their tests/typechecks through this
  host checkout's projection commands, never inside the template directories.
- Shared checkout has concurrent unrelated changes. Preserve them. No commits
  have been made for this task.
- At pause, all owned processes are stopped. Managed instances
  `perf-20260928-startup`, `perf-20260928-after`, and `perf-20260928-final` were
  stopped. Final instance state root `/tmp/vibestudio-perf-20260928-final-kyCyS3`
  is removed. Executor PID 51934 was verified and terminated. Full desktop smoke
  exited 0 and cleaned up. Android emulator-5586 and the last smoke's children
  are gone; privileged /proc inspection reported `remainingOwnedProcesses: []`.
- Do not reuse or restart anyone else's instance. New measurements need a new
  uniquely named managed instance, with finally-equivalent cleanup.

## Our changes

Host checkout:

- `packages/iroh-transport/src/nodePhysical.ts` and test: advertise native home
  relay first, retaining the configured relay set.
- `src/server/irohIngress.ts` and test: expose the currently owned endpoint across
  rebinds; hub and workspace reach advertisements derive from that endpoint.
- `src/server/hubServer.ts`, transport-related hunks of `src/server/index.ts`.
- `packages/mobile-iroh/src/connect.ts` and new test: shared endpoint compatibility
  compares relay membership, allowing peers to prioritize different homes.
- `src/server/services/extensionUnitDriver.ts` and new test: stage a deferred
  host-target prerequisite before reading the extension registry. Wiring in
  `index.ts` uses ordinary declaration reconciliation, with a per-target pending
  staging promise and retry after failure. Original Android failure was
  `Unknown extension: @workspace-extensions/react-native`.
- `scripts/cli/mobile-smoke.mjs`: wait only while submitted approval count exceeds
  resolved count. The old historical `hasPhase(submitted)` guard blocked every
  later review forever. Corrected rerun passed both launch reviews.
- Adjacent measurement report and this checkpoint.

Base template:

- `packages/agentic-chat/components/AgenticChat.tsx`: remove unconditional optional
  capability warmup effect and now-unused useEffect import.
- Delete `utils/chatCapabilityWarmup.ts`; remove unused
  `scheduleBackgroundStages` from `utils/scheduleBackgroundWork.ts`; delete its
  stage-only test. Keep scheduleBackgroundWork, used elsewhere.
- `packages/testkit/src/performance.ts` and tests: profilePanelReload measures
  canonical reload with host profiling across replacement attempts, instead of
  retaining a stale CDP page. Options now label/eventLoopLimit; removed misleading
  cache-disable option and old same-page metrics.
- Update testkit SKILL.md and examples.

System template: performance SKILL.md reload contract/example updated.
System-testing template: exact reload performance test prompt/validator and its
unit test updated for host span + replacement identities.

## Concurrent edits that are not ours

Do not overwrite or claim as this task's implementation:

- `src/server/services/runtimeService.ts` and test; associated index.ts
  `testPolicyForContext` wiring.
- `packages/service-schemas/src/vcs.ts`.
- Later changes in `src/server/buildV2/builder.ts`, `builder.app.test.ts`,
  `buildV2/index.ts`, index.ts `ensureBuildProvider` wiring, and exposing
  `ExtensionHost.ensureActivated` in `packages/extension-host/src/service.ts`.
  These appeared during the session and concern lazy native build providers.
- Base provenance/harness/workspace-source edits and System-testing
  approvals-permissions/capability-resilience changes also appeared concurrently.

## Validation already completed

- Relay/ingress/hub tests: 63 passed, then added ingress checks: 8 passed.
- Mobile pool + extension driver tests: 4 passed.
- Base agentic-chat: 317 passed / 52 files.
- Base profiling helper: 2 passed.
- System-testing reload validator: 23 passed.
- Host typecheck passed before the late concurrent native-provider changes.
- Base composition typecheck passed after removing warmup and unused import.
- Template checkout hygiene passed; git diff --check passed.
- Managed exact `testkit:chat-transcript` passed, run
  `st_acce45d6e6354b0da3a2c074d9be935a`, 14,694 ms.
- Full `xvfb-run -a node scripts/desktop-pairing-smoke.mjs` passed, including
  retained-client recovery after server restart. No need to rerun without new
  changes affecting that behavior.

## Outstanding work

1. Complete Android verification. Latest native APK was rebuilt through the
   native mobile-debug extension for x86_64 (53,667 ms, 98,429,961 bytes).
   The corrected smoke rerun got through pairing, both required launch reviews,
   React Native provider activation, and into app bundle building. User requested
   quiescence while that build was in progress. Do not label Android verified.
2. Inspect current source changes before further edits; another task is changing
   native build-provider activation. Our declaration staging fix and their
   builder provider-demand change currently coexist.
3. Rerun the smallest relevant host checks if required by additional changes.
   Final host typecheck should cover the resulting shared source state. Avoid
   heavy tests concurrently with latency measurements, especially under memory
   pressure.
4. Update report with final Android bundle/panel/chat/restart evidence. Keep real
   provider latency distinct from deterministic transcript rendering. Real-model
   chat attempt waited for credential consent and was excluded from timings.
5. Host-internal build profiling found costly first diagnostic reports despite
   cached emitted artifacts: chat 9.16 s, shell 16.39 s; repeated exact-state
   reports 26.8 ms / 154.7 ms. TypeScript and authority analysis dominate. No
   builder validation was skipped, weakened, or claimed optimized. This remains
   a measured performance opportunity; investigate rather than add unsafe cache
   shortcuts if continuing optimization there.
6. Clean all owned runtimes, connections, and emulators before final delivery.

## Useful private artifacts / reproduction

All `/tmp/vibestudio-perf-*` reports/logs were chmod 600 (some newly created logs
may need permissions rechecked). They can contain sensitive local diagnostics;
do not publish full logs or trajectories.

- `...-panels-final-summary.json`: startup and three compact panel samples.
- `...-chat-idle-before.json`, `...-chat-idle-after.json`: 73 → 43 JS requests,
  3,862,508 → 2,853,383 decoded JS bytes.
- `...-chat-rich-final.json`: successful deterministic bold-response profile,
  3,626 ms including two deliberate 500 ms waits. No browser long tasks.
- `...-cold-final-timing.json`: fresh-state doctor 43,267 ms.
- `...-build-final.json`: shell and native Android receipts.
- `...-desktop-smoke.log`: full desktop pass; native startup 16,140 ms.
- `...-mobile-final.log`: first rerun stopped on historical approval-guard bug.
- `...-mobile-retry.log`: corrected rerun, interrupted for user-requested restart.
  Owned state root was `/tmp/vibestudio-mobile-smoke-XvIZAb`.
- `...-mobile-run.sh`: wrapper starts read-only `NatStack_Test` on emulator-5586,
  waits for boot, runs `node scripts/cli/mobile-smoke.mjs --platform android
--device emulator-5586 --no-build`, and stops/awaits emulator in cleanup.
  It refuses to reuse an existing device at that serial. Reuse the wrapper only
  after inspecting it. Do not assume previous shell session IDs survive restart.
- `...-panels.ts`, `...-chat-idle.ts`, `...-chat-rich.ts`: native eval probes.
  Some earlier scripts used `timeoutMs` for CDP waits; supported key is `timeout`.
  Rich probe correctly uses visible text, not `<strong>`: renderer emits a styled
  span. Cleanup is in finally. Eval CLIs must run sequentially to avoid competing
  auto-approvers resolving the same pending request.

Native CLI flow: doctor a new instance, attach profiling session, then
`pnpm cli --instance ID eval run --session profiling --approval-level 1 FILE`.
Store full values in scope and return bounded summaries to avoid truncation.
Start `node scripts/development-client-executor.mjs --instance ID` when needed,
and terminate/await it explicitly before stopping the managed instance.
