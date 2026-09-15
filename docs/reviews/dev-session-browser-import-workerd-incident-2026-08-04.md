# Browser-import / workerd incident handoff

Date: 2026-08-04

Status: reviewed and structurally remediated; controlled live RSS validation still required

Audience: agent taking ownership of the runtime, durable-work, and browser-import fixes

## Review correction and implementation outcome

This report was re-checked against the runtime architecture and workerd's
`WorkerLoader` behavior before implementation. Its central observation was
valid — route attachment was mutating runtime-image generation — but its causal
story was too confident and its proposed identity was not durable enough.

The corrected invariant is:

> A userland Durable Object executes the exact build, execution digest, and
> authority recorded in its active durable entity row. Request routing only
> attaches that incarnation. Only an explicit durable entity advancement may
> change it.

The implementation now enforces that invariant:

- Gateway route preparation resolves an active sealed entity and restores its
  exact retained build. It no longer calls mutable `ensureDO()` on every request.
- The legacy `ensureDO()` entry point rejects userland objects; it remains only
  for host-owned internal DOs.
- `RuntimeImageStore.upsert()` is a no-op for the same executable identity.
  Selector/provenance-only changes preserve generation, while a genuine
  artifact or authority change advances it once.
- DO loader versions are semantic hashes of execution digest, authority, and
  object state arguments, rather than persistence-write counters.
- A missing sealed DO artifact fails closed. The runtime never rebuilds it from
  a mutable source selector.
- Host-bundled internal DOs validate the entity row directly against their
  deterministic service identity. They no longer persist a duplicate
  object-shaped runtime image alongside that service identity.
- Mutable selectors and sealed durable attachments use separate loader APIs;
  there is no boolean mode that can accidentally enable mutable rebinding for
  a durable incarnation.
- Userland object attachments are derived in-memory from the WorkspaceDO entity
  row. Once activation commits, the preparation selector is removed from the
  persistent runtime-image store, so there is no second durable copy of the
  object's execution identity to drift.
- Source publication has one required owner. It commits every affected
  main-tracking singleton row in one WorkspaceDO SQLite transaction, restores
  the resulting exact attachments, and only then refreshes mutable worker and
  class selectors. Publication remains serialized per source and one failure
  cannot poison later publications.
- Recovery readiness and lifecycle-resume failures are emitted as bounded
  incident summaries instead of one warning per owner.
- workerd diagnostics retain a ten-minute RSS sample window and report sample
  count, peak, growth, and window duration on stop/exit.
- Browser-panel creation reports timings for runtime entity creation, durable
  slot creation, title persistence, the whole import, and collection launch.
  Tabs remain ordered and serial until measurements justify a transactional
  batch API; the implementation deliberately does not add unsafe parallelism.

One important correction: `LOADER.load()` creates anonymous dynamic workers,
and workerd's own tests state that anonymous workers are not stored in the named
isolate cache. Version churn still causes facet aborts, module allocation, and
GC pressure, but permanent loader-cache retention is not established by the
incident log. A controlled live run must determine whether RSS is now bounded;
if it is not, loader/facet disposal and long-lived outbound activity remain a
separate investigation.

### Follow-up live boot finding

The first desktop run after the structural change exposed an internal identity
model mismatch: `BrowserDataDO` had a sealed service image while generic restore
also demanded a concrete entity image. The clean resolution is not another
projection. Internal restore now verifies the durable entity tuple directly
against the deterministic host-bundle service identity and creates no duplicate
object image. The real-workerd integration harness was also moved off mutable
`ensureDO()` and now constructs the same sealed entity record used by
production.

A subsequent named ephemeral boot completed without that attachment error.
Its workerd reached roughly 755 MB RSS after 39 seconds while startup builds and
extension reconciliation were still active (`11` services, `4` object images,
`15` runtime images). That is not a controlled browser-import measurement and
does not establish a leak, but it is high enough that the long-window stable
route/import experiment remains required; this report must not claim memory is
bounded yet.

The later single-owner cleanup deliberately made userland entity attachments
derived rather than persisted. Fresh-boot validation then exposed two callers
that had relied on the old persistent preparation record: the semantic source
provider and ordinary `runtime.createEntity()` DO activation. Both now cross
the same explicit boundary—commit the WorkspaceDO entity, materialize its exact
attachment, and only then invoke the object. Bootstrap singleton reconciliation
also shares one canonical context-id function with early semantic attachment,
removing a previously hidden dual identity. A fresh ephemeral server then
reached readiness, and `system-test doctor` passed the catalog, server,
system-testing build, agent-worker, and model checks; it stopped only at the
expected extension approval gate. That run again reached about 751 MB during
startup and doctor-triggered builds, so it remains evidence of successful
lifecycle wiring, not evidence that RSS is bounded.

The desktop log also exposed an independent presentation race. Electron's
`vibestudio:focusPanel` IPC handler converted the typed `preparing` focus result
into an exception. `PanelHandle.focus()` is designed to keep observing after
that result, but the exception instead caused the shell to clear its native
slot; the eventual readiness update then targeted an unknown slot. The IPC
boundary now returns the complete `PanelFocusResult` unchanged, matching the
RPC service boundary and allowing the existing readiness observer to finish.

The first approved chat launch exposed the last remaining activation-owner
bypass. `workers.resolveService` committed a new `PubSubChannel` entity and
immediately called `durableWorkCapabilities`, while exact attachment was still
only performed by some activation callers. UniversalDO consequently returned
410 (`code fetch failed`) and the gateway surfaced it as an opaque 500. Runtime
materialization now belongs to `WorkspaceEntityStore`, the sole entity mutation
boundary: every activation or execution advance durably commits, mirrors the
cache, attaches the exact sealed DO image, and only then returns to callers that
may invoke it. On-demand service resolution, runtime creation, VCS bootstrap,
source publication, and singleton reconciliation all use this boundary; the
last direct singleton write path was removed.

That activation repair was necessary but not sufficient to make the invariant
structural. A subsequent ingress audit found that host `DODispatch` and client
RPC relay (unary, stream, and event) could still reach UniversalDO on the
assumption that some earlier lifecycle owner had warmed it. The system now has
one `DurableObjectExecutionReadiness` boundary. It resolves the exact active
WorkspaceDO row (repairing a lost hot-cache mirror), rejects retired,
incomplete, or mismatched identities, and restores only that sealed execution.
Entity publication uses it eagerly; every userland invocation uses it again
before authority resolution and transport. `DODispatch`, `RpcServer`, and
`WorkspaceEntityStore` require that boundary in their constructors, so an
invocation-capable host cannot be assembled without it. The
unused raw `/_u/` gateway passthrough was removed rather than preserved as a
second unguarded ingress. Restoration remains idempotent and a readiness
failure never replays the semantic call.

A later Browser Migration launch exposed a separate split in panel creation.
Host-shell creation explicitly performed the complete `reserve entity → commit
slot → activate sealed execution` protocol, but the portable runtime stopped
after the slot commit and depended on `PanelExecutionReconciler` noticing the
slot notification. If that handoff was delayed or missed, the durable panel
remained `preparing`; no panel URL was served or navigated, and the caller's
90-second readiness observation merely reported the permanent intermediate
state. Portable creation now drives the same explicit protocol as the host.
The reconciler remains an idempotent crash-recovery mechanism, not a required
success-path message consumer. Post-commit activation failures keep the
reservation available for recovery and surface as typed committed failures.

The first version of that repair also introduced a presentation projection
which treated every executable `current-entity` slot notification as a request
for a default CDP host. That conflated two independent facts: a runtime entity
being sealed and executable, and a user/automation consumer asking for a
renderer. It defeated `createPanelSlot()`'s unloaded contract and caused an
imported browser collection to navigate every URL at least once.

Presentation reconciliation is now residency-preserving rather than
residency-creating. A current-entity change atomically advances an existing
slot lease to the replacement immutable entity, so navigation of a visible
panel remains seamless, but an unleased slot remains unloaded. First residency
has only explicit demand sources: `openPanel()`/`panelRuntime.ensureSlot`, a
visible native pane, or a CDP operation. Runtime activation remains explicit;
removing it would restore the original permanent `preparing` failure.

That launch also showed an unhandled `review-pending` rejection from the chat
panel's initial `channelName` write. The rejection is an expected typed state
while the creation review is open, but the panel had fired the persistence
promise without observing it. Chat now retains one provisional channel
identity, retries that exact write on the shared approval-change event, and has
a quiet reconciliation retry for a missed event. It neither bypasses the
authority gate nor invents a second channel after approval.

### Follow-up capacity feedback-loop finding

A large collection launch later reproduced unbounded native-view churn without
any runtime-image rebinding (`runtimeImageRebinds=0`). The desktop was the only
available default CDP host and had a finite resident-panel cap. When the cap
evicted a default-assigned panel, `panelRuntime.release()` interpreted that
intentional relinquishment as demand for immediate recovery and assigned the
same panel straight back to the same desktop. Loading it evicted another panel,
forming a closed feedback loop. The stable panel ids and ever-increasing CDP
tab ids in the log were the distinguishing evidence; workerd eventually reached
roughly 3.7 GB RSS as a consequence of the presentation churn.

Default-host reassignment now excludes the host that deliberately released the
lease. Durable programmatic demand may move to another eligible host (for
example, a headless host that became available), but a capacity decision can no
longer be immediately reversed onto the same host. A coupled coordinator/cap
regression test creates more assignments than one host can retain and proves
that the system converges at the cap instead of recursively reassigning.

The same run exposed an independent RPC-addressing error behind the repeated
`BrowserDataDO ... Unknown service` warnings. `createBrowserDataClient()` had
separate semantic paths for main services and its resolved durable target, but
its transport type represented both as one ambiguous `call(service, ...)`
method. Desktop, shell, hosted-runtime, and mobile adapters consequently routed
the resolved `do:...` id through the main service dispatcher. The transport
contract now distinguishes `callService` from `callTarget`; each platform maps
those operations to `main/service.method` and direct target RPC respectively.
This makes the invalid route unrepresentable at the browser-data boundary.

## Executive summary

The supplied development-session log contains both normal diagnostic noise and a real runtime failure.

The concrete failure is repeated `workerd` JavaScript heap exhaustion. The process reaches multiple gigabytes of RSS, aborts, restarts, and then emits a recovery storm while every affected Durable Object resumes. That explains why otherwise short operations can become minute-scale operations.

There is also a concrete idempotence defect in the userland Durable Object runtime path that can plausibly create the memory pressure:

```text
/_r/w request
  -> gateway.ensureDORoute()
  -> WorkerdManager.ensureDO()
  -> ensureDOClass(..., objectKey)
  -> bindRuntimeImage()
  -> RuntimeImageStore.upsert()
  -> generation increments even when the image is unchanged
  -> UniversalDO sees a new version
  -> aborts the current facet and calls LOADER.load() again
```

`ensure` is therefore not actually idempotent. The host-side maps remain at the same counts while workerd can retain loader/facet generations. This is a design defect, not a logging workaround.

The browser-import path has already been moved to `createPanelSlot`, and the current tests confirm that it does not wait for external browser-document readiness. It does, however, create each tab serially and still awaits the server-side entity/slot persistence RPC for each tab. When the server is unhealthy or recovering workerd, that serial path magnifies the outage. The correct order is to repair runtime idempotence and establish timing instrumentation before choosing whether the panel API needs a batch creation primitive.

## Evidence from the supplied log

### Repeated workerd OOM

The process aborts three times in the excerpt:

| Time     | Last sampled RSS | Uptime | Host registry counts                                     | Consequence                                                  |
| -------- | ---------------: | -----: | -------------------------------------------------------- | ------------------------------------------------------------ |
| 17:20:43 |         ~2.69 GB | ~820 s | `runtimeImages=29`, `doServices=12`, `doObjectBuilds=17` | workerd aborts; readiness scans fail; workerd restarts       |
| 17:24:45 |         ~3.79 GB | ~241 s | same counts                                              | workerd aborts again; readiness scans fail; workerd restarts |
| 17:29:15 |         ~2.53 GB | ~271 s | same counts                                              | workerd aborts again; workerd restarts                       |

The flat host-side counts do not prove that runtime memory is stable. They only show that the owning Node maps are not growing in the same way as RSS. `runtimeImageRebinds=0` is also not a useful test for this defect: that counter tracks pending scheduled rebind flights, not every synchronous `bindRuntimeImage()` call.

### Recovery cascade after each crash

Immediately after an exit, the log contains:

- one `readiness scan failed` warning per registered agent/channel owner;
- a workerd restart;
- `__lifecycle/resume` calls reporting `state=slow` after 10 seconds for many objects;
- renewed durable-work hints as owners become reachable again.

These are secondary effects of the crash. They should still be made easier to operate, but suppressing them would not fix the outage.

### Durable-work trace volume

The log contains a full transition record for each hint, claim, execution, and settlement:

- `hint.received`
- `claim.started`
- `claim.completed`
- `execution.started`
- `execution.completed`
- `settlement.completed`
- continuation hints after runner completion

This produces many lines for one agent turn. The current checkout already changed `DurableWorkDriver.trace()` to `log.verbose()` in `src/server/services/durableWorkDriver.ts:544`, and its test asserts that normal `info` logging does not emit the transition stream. Therefore, the pasted session either had verbose logging enabled or was running an older bundle.

The log viewer labels `console.log()` output as `info`, so the displayed `info` label does not prove that the application considered the record operational `info`. `VIBESTUDIO_LOG_LEVEL=verbose` enables both the durable-work traces and model-call traces.

### Model-call timing

The shown model call took approximately 8.3 seconds total, with approximately 7.7 seconds spent streaming. It reported `toolCount=37`, but `toolArgumentBytes=0` and the event counts contain no tool-call events. The 37 value is the number of available tool definitions, not 37 executed tools.

This call is not itself a minute-long browser-tab import. It is background agent work associated with the collection/conductor flow and can nevertheless add durable-work and workerd load.

### Long-held eval lease

`holdKernelLease (held) has been active for 300s` is expected behavior. The kernel lease intentionally keeps an eval DO resident for a long period and reports coarse liveness. It is not, by itself, evidence of a deadlock or leaked request.

### WebSocket bridge close

`[EgressProxy] long-lived WebSocket bridge closed` is emitted for bridges that lived longer than 30 seconds. It is intended diagnostic attribution for long-lived model streams. It is not the root cause, although repeated long-lived streams become more concerning once workerd is under memory pressure.

## Problem 1 — non-idempotent userland DO ensuring

Severity: critical

Confidence: high that the code defect exists; medium-high that it contributes to the observed OOM; the excerpt alone does not prove that every browser-import request exercised this route.

### Current behavior

`Gateway` invokes `ensureDORoute()` before every routed userland DO HTTP or WebSocket request:

- `src/server/gateway.ts:1133`
- `src/server/gateway.ts:1206`

The server wires that callback to `WorkerdManager.ensureDO()` in `src/server/index.ts:5627`.

`ensureDO()` calls `ensureDOClass()` with an object key in `src/server/workerdManager.ts:2680`. Once the class exists, the object-key branch still calls `bindRuntimeImage()` at `src/server/workerdManager.ts:2632-2636`.

`RuntimeImageStore.upsert()` always assigns:

```ts
generation: (previous?.generation ?? 0) + 1;
```

even when the new artifact, authority, source, unit, and scope are semantically unchanged. See `src/server/runtimeImageStore.ts:167-180`.

`getDoVersion()` exposes that generation as the object version in `src/server/workerdManager.ts:1526-1535`. `UniversalDO` treats a version change as executable replacement, aborts the current facet, and calls `LOADER.load()` again in `src/server/workerdPrograms/universalDo.ts:63-70`.

### Why this is harmful

The operation named “ensure” mutates executable identity. A request that should be a no-op can:

1. rebuild or rebind the runtime image;
2. advance the version seen by the UniversalDO host;
3. abort a live facet and its active work;
4. load a new module graph into workerd;
5. retain loader/runtime state across many generations.

The registry counts can remain fixed while the underlying workerd loader accumulates expensive state. This matches the log’s combination of flat `runtimeImages`/`doServices`/`doObjectBuilds` counts and rising RSS.

### Scope boundary

This defect is specifically in the routed `/_r/w/...` path. Internal `DODispatch` calls normally target `/_u/...` directly and bypass the Gateway’s `ensureDORoute()` callback. The agent must verify which transport the slow browser-import-adjacent operations actually use instead of attributing every log line to this one path.

The defect is still independently valid and must be fixed even if a reproduction shows that the particular import used direct `/_u` dispatch.

### Principled fix

Make runtime-image binding and runtime-image versioning obey an explicit identity contract:

1. Define the semantic identity of a runtime image. At minimum this must include the immutable artifact identity and any authority/scope fields whose change requires a new executable incarnation.
2. Make an upsert of the same identity return the existing record without changing `generation` or `updatedAt` unnecessarily.
3. Make `ensureDOClass()` reuse the object’s existing sealed image when it is already registered and compatible. It should not call the workspace build provider on every routed request.
4. Preserve an explicit operation for intentional rebuild/rebind. Do not overload `ensure` with rebuild semantics.
5. Keep generation advancement for a genuine executable, authority, or scope change.
6. Ensure concurrent first-time ensures for the same class/object are serialized by the canonical identity and share one binding flight.

Do not fix this by adding a “skip on route” flag, reducing the reload timeout, or bypassing version checks. Those would leave the identity contract broken.

### Required tests

Add tests that fail before the fix and pass after it:

- Calling `ensureDO()` twice for the same userland source/class/object does not call `bindRuntimeImage()` twice, or at minimum does not advance the image generation on the second call.
- `getDoVersion()` remains stable across repeated idempotent ensures.
- Repeated Gateway HTTP requests for one object do not cause repeated runtime-image generation.
- Repeated Gateway WebSocket upgrades for one object do not cause repeated generation.
- A genuine artifact change advances generation exactly once.
- A genuine authority/scope change advances generation if the contract says it changes the executable incarnation.
- Concurrent first ensures produce one stable image and one object build record.

## Problem 2 — possible loader/facet retention under version churn

Severity: critical if confirmed; currently a likely consequence of Problem 1 rather than independently proven.

### Relevant code

`UniversalDO` caches one loaded facet and one in-flight load per object. When the version changes it calls `this.ctx.facets.abort("do", ...)`, clears the cached facet, fetches code, and calls `this.env.LOADER.load(...)` in `src/server/workerdPrograms/universalDo.ts:63-100`.

The host-side `WorkerdManager` diagnostic reports counts of image records and object-build metadata, not the memory retained by workerd’s loader or its previously loaded module graphs.

### Required investigation

After fixing idempotent ensuring, run a controlled test that:

1. registers one userland DO;
2. sends repeated requests through the same route;
3. records the runtime-image generation before and after each request;
4. records facet load count and `Runtime image advanced` events;
5. samples workerd RSS over time;
6. repeats with a deliberate rebuild between requests.

Expected result: stable requests perform no facet reload and have bounded memory; deliberate rebuilds reload once and retire the prior facet. If RSS still grows without version churn, continue investigation in loader disposal, wasm/module retention, and facet abort semantics rather than weakening the version contract.

Do not treat increasing heap allowance as a fix.

## Problem 3 — browser-import slot creation is serialized and server-coupled

Severity: high for user-visible latency; root cause not yet established for the exact one-minute symptom.

### Current behavior

`workspace/extensions/browser-data/index.ts:648-671` creates each selected browser tab with a sequential `await panelRuntime.createPanelSlot(...)` loop.

The current `createPanelSlot()` implementation in `workspace/packages/runtime/src/shared/panelRuntime.ts:976-1110`:

- recognizes an external URL;
- creates a runtime external entity;
- creates a durable workspace slot;
- updates the title;
- returns a handle;
- does not call `focus()`;
- does not call `waitUntilReady()` for the external page.
- does not allocate a presentation lease or navigate the external page.

The browser-import tests explicitly verify that deferred browser tabs do not wait for document readiness. The relevant tests currently pass.

### What this means

The import path is not serializing on page load and imported tabs remain
unloaded until a visible pane or an explicit programmatic operation requests
residency. It is serializing on server-side entity and slot creation. Under a
healthy server this should be short. During workerd restart/recovery, every tab
waits for the same unhealthy control plane and the serial loop multiplies the
delay.

The collection conductor is launched only after all slots are created. It is background work and should not be mistaken for a per-tab readiness wait, but it does create an additional resident agent/model workload after import.

### Principled next step

First repair and measure the control plane. Then decide whether the API needs a batch operation such as “create these external slots in one durable transaction” or bounded parallelism with explicit ordering/rollback semantics.

Do not blindly wrap the loop in `Promise.all()`. That could create partial collections, violate ordering assumptions, amplify concurrent pressure during recovery, and make cleanup harder. The abstraction should define atomicity, partial failure, idempotency, and bounded concurrency first.

Add timing spans around:

- `browserData.openTabsAsPanels`;
- each `createPanelSlot`;
- `runtime.createEntity`;
- `workspace-state.slot.create`;
- post-import collection-agent launch.

The spans must identify whether time is spent in RPC transport, context setup, entity activation, slot persistence, or recovery waits.

## Problem 4 — durable-work transition logging is too granular for normal operations

Severity: medium operational issue; not the cause of OOM.

### Current behavior

`DurableWorkDriver` retains up to 500 recent transition records in memory for inspection and mirrors every record to logs when verbose logging is active. The source now uses `log.verbose()` at `src/server/services/durableWorkDriver.ts:544-554`, but the sink labels `console.log()` as `info`.

The durable-work driver intentionally coalesces hints by owner/queue and uses durable claim/settle operations. That means repeated hints are expected in an at-least-once system, but routine transitions should not flood normal operational logs.

### Required behavior

At the normal log level:

- retain transition details in `inspect()`;
- log only actual execution failures, failed settlements, stale-generation anomalies, and meaningful recovery summaries;
- avoid logging every no-op claim or duplicate hint.

At verbose/debug level:

- retain the detailed trace;
- use a structured logging level that the viewer can distinguish from operational `info`;
- avoid serializing large payloads into strings when structured fields are available.

Confirm that the running dev supervisor passes the intended log level into both the host and workerd environments. The current model-call trace gate also treats `VIBESTUDIO_LOG_LEVEL=verbose` as an enable switch in `workspace/packages/agentic-do/src/effect-executors/model-call.ts:252-271`.

## Problem 5 — durable-work continuation and duplicate semantics are noisy but not yet shown incorrect

Severity: medium observability issue; correctness appears intentional in the excerpt.

### Observed behavior

After a runner settles, `DurableWorkDriver` notifies the same owner/queue with trigger `continuation`. This is a deliberate re-check for work derived by settlement. The driver also coalesces pending/claiming hints and counts duplicate hints.

A later `settlement.completed` with `disposition="duplicate"` means the durable owner rejected an already-applied generation. It is the intended idempotent at-least-once boundary, not proof that the effect ran twice.

The excerpt shows one execution for the model outbox item and a later duplicate settlement. It does not show two successful executions of the same generation.

### Required validation

The fixing agent should add or retain an invariant test proving:

- duplicate hints cause at most one active lane for one owner/queue/item;
- duplicate durable delivery cannot apply an effect twice;
- continuation checks do not create an unbounded empty-claim loop;
- a stale or duplicate settlement is counted and observable without being logged as an incident-level failure.

The current durable-work tests pass, including the test that normal info logging does not emit transition traces and the tests for hint coalescing/recovery.

The current checkout also contains an optimization that only calls `adoptDurableWorkWorker` during recovery claims. Normal hints and continuations already identify a ready owner, so repeating adoption for every claim would add a serialized DO round trip. Preserve that boundary unless a correctness test demonstrates a missing recovery case.

## Problem 6 — workerd recovery produces an incident log storm

Severity: medium operational issue; secondary to the OOM.

### Current behavior

When workerd exits, the owner scanner emits one warning for each owner that cannot be reached. Then lifecycle resumption emits a slow warning per DO after 10 seconds. A single process failure therefore appears as many unrelated owner failures.

### Desired behavior

Keep the per-owner details available in structured diagnostics, but make normal logs incident-oriented:

1. emit one workerd-recovery event with process generation, exit reason, and affected-owner count;
2. aggregate owner readiness failures into a bounded summary with a sample of owner IDs;
3. emit one recovery-complete event with duration and recovered/failed counts;
4. preserve individual owner detail in debug logs or an inspection endpoint;
5. keep genuine owner-specific failures visible after the global recovery window closes.

Do not hide transport failures by downgrading them blindly. The logger needs incident grouping, not silence.

## Problem 7 — progress levels distinguish intentional residency poorly

Severity: low-to-medium observability issue.

`DODispatch.dispatchHeld()` reports a `working` heartbeat every 300 seconds for intentionally held requests, while ordinary dispatch and lifecycle calls report `slow` warnings every 10 seconds. This is conceptually correct, but the resulting messages do not identify whether the call is a deliberate lease, model stream, recovery resume, or suspected stall.

Improve the event shape rather than changing timeouts:

- include a reason/category such as `kernel-lease`, `model-stream`, `durable-effect`, or `lifecycle-recovery`;
- include the workerd boot generation and owner identity;
- reserve warning severity for calls whose category permits a genuine anomaly;
- keep long-lived lease heartbeats out of ordinary terminal output unless verbose/diagnostic mode is enabled.

## What is not established by this log

The following must not be asserted without a targeted reproduction:

- that every slow browser tab exercised `/_r/w` and therefore hit the runtime-image rebinding defect;
- that `openPanel()` readiness timeout caused the current import delay;
- that the 37 available model tools were invoked;
- that the kernel lease was leaked;
- that the durable-work driver executed the same effect twice;
- that the browser import provider’s local file/database reader is itself taking one minute per tab.

The current source and tests specifically support the opposite conclusion for browser-document readiness: imported external tabs use `createPanelSlot()` and do not wait for page readiness.

## Recommended implementation order

### Phase 1 — establish the invariant and stop version churn

1. Add the repeated-ensure tests described in Problem 1.
2. Implement semantic runtime-image identity and idempotent upsert/reuse.
3. Verify that intentional rebuild/rebind still advances exactly once.
4. Run the WorkerdManager and UniversalDO suites.

### Phase 2 — verify loader lifecycle and memory behavior

1. Add facet-load/version/RSS instrumentation behind a diagnostic switch.
2. Run repeated stable routed requests and deliberate rebuild requests.
3. Confirm that stable requests do not abort/reload facets.
4. If memory still grows, investigate loader/facet disposal independently.

### Phase 3 — measure browser-import latency

1. Add operation timing around entity creation, slot persistence, and collection-agent launch.
2. Reproduce with one tab, then several tabs, with a healthy workerd.
3. Repeat during a controlled workerd restart/recovery.
4. Only then choose between a batch slot API and bounded concurrency.

### Phase 4 — reduce operational noise

1. Keep transition traces in inspection/debug mode.
2. Aggregate workerd recovery warnings.
3. Add categories to long-held dispatch progress events.
4. Ensure host and workerd log-level configuration is visible in diagnostics.

### Phase 5 — regression coverage

Run, at minimum:

```bash
pnpm vitest run src/server/workerdManager.test.ts --reporter=dot
pnpm vitest run src/server/universalDoHost.test.ts --reporter=dot
pnpm vitest run src/server/routeRegistry.integration.test.ts --reporter=dot
pnpm vitest run src/server/services/durableWorkDriver.test.ts --reporter=dot
pnpm vitest run src/server/services/runtimeService.test.ts --reporter=dot
pnpm vitest run workspace/extensions/browser-data/index.test.ts workspace/packages/collection-orchestration/src/index.test.ts --reporter=dot
```

For the live system, follow the repository’s headless-test procedure: repair infrastructure first, run the smallest relevant exact test, inspect the complete trajectory on failure, and rerun the failed category plus smoke coverage after the fix. Do not restart or replace another developer instance.

## Acceptance criteria for handoff completion

The work is complete when all of the following are true:

- repeated idempotent userland DO ensures leave runtime generation and `getDoVersion()` unchanged;
- routed requests no longer trigger repeated runtime-image binding or facet reload;
- deliberate code/authority/scope changes still produce one intentional new incarnation;
- a controlled browser-import run does not cause unbounded workerd RSS growth;
- one-tab and multi-tab import timings identify their actual slow phase;
- imported browser tabs remain deferred and do not wait for external document readiness;
- normal durable-work operation no longer emits one terminal line per transition;
- duplicate durable delivery remains idempotent and covered by tests;
- workerd OOM recovery produces a bounded incident summary while preserving inspectable owner detail;
- no fix relies on increasing heap size, shortening readiness timeouts, suppressing errors, changing prompts, or blindly parallelizing the import loop.
