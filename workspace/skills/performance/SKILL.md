---
name: performance
description: Profile and optimize Vibestudio panels, apps, workers, builds, startup, and agent workflows with behavior-preserving measurements. Use for slow UI, sluggish interactions, cold or warm panel loads, large bundles, worker or Durable Object latency, event-loop stalls, excessive rendering, slow builds, or performance regression investigations.
---

# Performance profiling

Measure one user-visible boundary at a time, keep cold and warm paths separate,
and compare equivalent states. Optimize only a bottleneck supported by the
report, then rerun the smallest measurement that can prove the change.

## Capability map

Stay inside the canonical userland surfaces below. They provide the same
process, build, lifecycle, and browser evidence used by host-side
investigations without granting shell, `/proc`, inspector-port, or artifact
content access.

| Question                                                  | Primary userland surface                          | Evidence                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| How long did a panel action or reload take?               | `profilePanelInteraction`, `profilePanelReload`   | wall time, Chromium runtime/page/network/long-task deltas                                                    |
| Which panel functions consumed CPU or retained memory?    | `profilePanel`, `heapSnapshot`                    | context-fs profile reference, never an inlined profile                                                       |
| Did server or workerd resources move during a workload?   | `profileHost`, `hostPerformanceSnapshot`          | CPU, RSS/heap deltas, retained event-loop samples, workerd RSS and occupancy                                 |
| Which startup phase was slow?                             | `readStartupProfile`                              | current-boot semantic activation, reconciliation, build discovery, and responsiveness warnings               |
| Was an exact build new or cached, and what made it large? | `profileBuild`                                    | first-run classification/timing, verified-cache timing/key proof, artifact/module bytes, panel bundle report |
| Which isolate code consumed CPU?                          | `profileWorkerd`, `profileDO`                     | bounded V8 CPU-profile reference                                                                             |
| How large/responsive is the Electron process family?      | `electronPerformanceSnapshot` from `client_eval`  | per-process and aggregate working-set bytes, CPU percentage, Electron-main event-loop samples                |
| What did a mobile source build target and emit?           | `mobile-debug.buildAndroid`                       | duration, selected ABIs, APK path and bytes                                                                  |
| Where did agent/chat latency occur?                       | managed system-test run plus panel/host profiling | model/tool trajectory, durable delivery phases, visible completion                                           |

## Panel and app profiling

Reuse one existing panel handle and acquire one page for its current runtime
incarnation. `page.profile(action, options)` records bounded browser-native
runtime, page, network, and optional JS-coverage evidence while `action` runs.
Await the real readiness condition inside `action`; the profiler never adds a
sleep or guesses when the experience is complete.

```ts
scope.target ??= panelTree.get(panelId);
scope.page ??= await scope.target.cdp.page();

return await scope.page.profile(
  async () => {
    await scope.page.getByRole("button", { name: "Open settings" }).click();
    await scope.page.getByRole("dialog", { name: "Settings" }).waitFor();
  },
  { label: "open settings" }
);
```

For a workspace panel presentation reload, keep the page connection and invoke
the panel lifecycle through its handle. The host reloads the owned page in
place, so the profile includes the real presentation navigation without
discarding the CDP session:

```ts
const handle = panelTree.get(panelId);
const page = await handle.cdp.page();

return await page.profile(
  async () => {
    await handle.reload();
    await page.waitForLoadState("networkidle");
  },
  { label: "panel presentation reload", disableCache: true }
);
```

Use `page.goto(page.url())` only when the subject is a browser page rather than
a workspace panel lifecycle. `disableCache` makes the measured navigation cold
at Chromium's HTTP-cache layer; it does not clear application memory, Durable
Object state, service workers, or server build caches. Restart or reset only
the layer the experiment actually calls cold. Query strings and fragments are
removed from retained network and coverage URLs so reports do not echo tokens.

Use `javascriptCoverage: true` in a separate attribution run. Precise coverage
adds profiler overhead, so never compare its elapsed or CPU durations with a
normal latency run.

The report is deliberately bounded and JSON-safe:

- `elapsedMs` is the exact callback boundary.
- `runtime` contains task/script/layout/style deltas, heap, DOM nodes, and
  document counts from Chromium's Performance domain.
- `page` contains navigation/paint observations, session layout shift,
  interaction latency, and `longTasks: { count, totalDurationMs, maxDurationMs }`.
  These are lab observations for the measured session, not field Core Web
  Vitals.
- `network` contains transfer/cache/failure totals, type aggregates, and only
  the slowest requested records.
- `coverage` contains aggregate used/unused JS and the largest unused scripts.

Close the page connection when finished. After `handle.navigate()`,
`handle.rebuild()`, or a runtime replacement, discard it and acquire one fresh
page from the same handle.

## Build and bundle profiling

Use the bounded profiler for the exact semantic context. It invokes the same
build report used for validation, summarizes immutable artifacts and executable
modules on the host, and never returns their source:

```ts
import { contextId } from "@workspace/runtime";
import { profileBuild } from "@workspace/testkit";

return await profileBuild("panels/chat", {
  ref: `ctx:${contextId}`,
  verifyCache: true,
});
```

`firstRun.cacheState` is evidence-based: `built-during-profile`, `preexisting`,
or `unknown`. Never call a preexisting first run “cold.” The optional repeat is
a verified-cache observation only when `sameBuildKeys` is true. For panels,
each target's `bundleReport` separates initial, lazy, and total payloads and
lists the largest inputs. `artifactBytes` is emitted artifact size while
`executableSourceBytes` is sealed executable-module source size; do not add
them as if they were one transfer budget.

Attribute initial bytes before splitting code. Do not infer that an import is
unused from bundle size alone; confirm it with a coverage run or source
ownership. Use `services.build.getBuildMetadata(key,
{ includeExecutableModules: false })` only when the compact profiler does not
answer a provenance question. Request executable module contents only for a
separate, explicitly justified source-attribution investigation.

## Performance by construction

Treat initial code as a startup budget, not merely a packaging detail. This is
especially important for shared packages: one eager import in a panel adapter,
worker runtime, agent base class, or package barrel is multiplied across every
consumer.

For panels and apps:

- Render the usable shell and publish readiness without waiting for optional
  history, suggestions, remote data, indexing, or other secondary sections.
  Empty data is a valid initial state, not an error or a reason to block boot.
- Put expensive editors, syntax highlighters, renderers, import/migration
  flows, and diagnostics behind interaction-level dynamic imports. Keep their
  loading and error states local to the feature that requested them.
- Import narrow browser/runtime entry points. A convenient barrel is not free
  when it re-exports modules with runtime initialization or large dependency
  graphs. Confirm the initial closure in `metadata.bundleReport`.
- Do not eagerly create every validator, service client, or namespace member
  merely to expose a uniform API. A lazy namespace must still validate before
  the first real operation; defer assembly, never validation or authority.
- Keep React module evaluation and the first render pure. Start I/O from an
  owned lifecycle/effect, deduplicate it with single-flight state where
  appropriate, and do not make unrelated data sources share one blocking
  readiness promise.

For workers and Durable Objects:

- Keep entry-module evaluation and constructors small. Feature-only provider
  SDKs, document/PDF parsers, HTML extraction, syntax parsers, telemetry
  exporters, and administrative tooling belong behind dynamic imports at the
  operation that needs them.
- A dynamic import is a real boundary only if the builder, immutable artifact
  store, and workerd loader preserve the module graph. Verify both the emitted
  chunk and a real-workerd import; inspecting source syntax alone proves
  nothing.
- Distinguish eager bytes from total sealed bytes. Workerd may receive an
  immutable map containing all modules while V8 parses and evaluates only the
  entry/static closure. Report initial, lazy, and total payloads separately.
- Avoid importing broad package barrels from shared runtime code. Prefer
  side-effect-free, capability-sized entry points so a small DO does not inherit
  panel APIs, model providers, schema catalogs, or debugging machinery it never
  uses.
- Preserve one canonical implementation. Do not create a lightweight second
  runtime or skip validation for speed; split the real runtime into a small
  kernel plus lazily loaded, independently testable features.

When adding a heavy dependency, record which user operation owns its cost and
how the initial bundle report proves it is absent from startup. If no operation
boundary exists, reconsider the dependency or the package boundary.

## Host, worker, and startup profiling

- Wrap one canonical operation with `profileHost`; do not reproduce it through
  a profiling-only path:

  ```ts
  import { profileBuild, profileHost } from "@workspace/testkit";

  return await profileHost(() => profileBuild("workers/example", { verifyCache: true }), {
    label: "exact worker build",
  });
  ```

  The summary contains server CPU/RSS/heap deltas, current workerd RSS and
  occupancy, and event-loop maxima whose completed sample windows intersected
  the workload. `sampleCount: 0` means no five-second monitor interval closed;
  it does not prove zero delay. RSS and heap deltas are endpoints, not retained
  allocation proof. Repeat equivalent states and use a heap snapshot only when
  object attribution is required.

- Use `readStartupProfile()` for the current server boot before querying raw
  logs. It extracts the structured semantic-activation and reconciliation
  phases, build discovery, and event-loop warnings. Query `services.serverLog`
  only when that bounded projection identifies a phase that needs deeper
  evidence.
- Use `runtime.supervision.health(identity)` and
  `runtime.supervision.logs(identity)` for one exact panel, extension, app, or
  worker incarnation. Do not substitute a new build for an observation read.
- Use payload-free durable-work diagnostics when queue or scheduler latency is
  in scope. Keep durable execution time separate from UI delivery time.
- For end-to-end agent workflows, use the managed system-test instance. Its
  per-test authority policy plus approval level 2 is the supported unattended
  auto-approve path; remote pairing is not.

No live instance is a prerequisite. Create a unique managed instance with
`pnpm system-test --instance ID doctor`, use its paired CLI for the experiment,
and stop that exact instance with `pnpm system-test --instance ID stop` in the
cleanup path. When the experiment specifically needs a direct server rather
than the managed harness, own a named `pnpm server:live --instance ID
--ephemeral` process and terminate and await it after closing all inspector
connections. Never borrow or stop an unrelated instance.

### Worker and Durable Object CPU profiling

Workerd exposes an approval-gated, loopback-only V8 inspector through the
runtime bridge. Profile the real bounded workload with `@workspace/testkit`:

```ts
import { listWorkerdTargets, profileDO, profileWorkerd } from "@workspace/testkit";

const targets = await listWorkerdTargets();
const workerProfile = await profileWorkerd("worker-host", async () => {
  await runWorkerWorkload();
});
const doProfile = await profileDO("example.protocol.v1", async () => {
  await runDurableObjectWorkload();
});
```

Both helpers close their inspector connections and store a standard bounded V8
`.cpuprofile` in context storage; only its compact reference crosses RPC. Await
the workload's real semantic completion inside the callback. Inspect targets
before selecting one: regular workers share the `worker-host` service, so that
profile can include sibling work, while source-specific Durable Object services
usually provide precise attribution. Use a quiet isolated instance when shared
worker-host attribution matters.

Pair CPU evidence with the owning system layers:

- use build metadata for sealed worker size, module composition, and cold versus
  verified-cache build time;
- use supervision health/logs for the exact worker or DO entity and incarnation;
- use `durableWork.inspect` for payload-free claim, execution, settlement,
  recovery, and queue timing;
- measure the enclosing RPC call or workflow boundary for wall time. The V8 CPU
  profile explains active isolate work but does not by itself attribute time
  spent awaiting storage, RPC, queues, or another process.

For lower-level experiments, `workerdInspectorSession()` provides the raw V8
inspector protocol. Always close it in `finally`; do not return heap snapshots or
full profiles through RPC, and do not leave profiling enabled after the bounded
operation.

Correlate across processes with durable or runtime identity and locally
measured durations. Do not subtract raw timestamps from different monotonic
clocks.

### Electron process resources

Electron metrics are client-affine. Run this through `client_eval`, not ordinary
server-side `eval`:

```ts
import { electronPerformanceSnapshot } from "@workspace/testkit";
return await electronPerformanceSnapshot();
```

The result contains only Electron's aggregate process-family working set,
per-process PID/type/working-set/CPU counters, and retained Electron-main
event-loop summaries—no URLs, titles, DOM, or panel content. Capture before and
after snapshots in the same inviting desktop client. Chromium renderers may
share or move between panels, so use a panel CDP profile for panel attribution
and Electron metrics for family-level resource movement. An empty event-loop
sample set has the same interval semantics as `profileHost`. Do not combine
Electron, workspace-server, and workerd RSS if the question is a single
process; report the three owners separately.

### Mobile build and launch performance

Mobile builds remain extension-owned. Target the attached Android device's ABI
or pass an explicit ABI list so a development profile does not accidentally
measure every native architecture:

```ts
const devices = await extensions.invoke("mobile-debug", "listDevices", []);
return await extensions.invoke("mobile-debug", "buildAndroid", [
  { variant: "internal", device: devices[0]?.serial },
]);
```

The receipt reports `durationMs`, `architectures`, `apkPath`, and `apkBytes`.
Pair it with `verifyWorkspaceReady({ sinceMs: startedAt })` to measure the real
source launch through `workspace-connected`; process liveness alone is not app
readiness. Use native/WebView tooling only for attribution not represented by
the extension, and preserve one canonical build/install/activation path.

### Chat and agent-workflow latency

Measure two boundaries rather than collapsing “chat latency” into one number:

1. Profile publish/submit through the first visible completed response in the
   real chat panel with `profilePanelInteraction`. This owns browser work,
   network observations, rendering, long tasks, and interaction latency.
2. Run the smallest exact managed system test and inspect its bounded run
   packet. The trajectory owns model turns, tool calls, suspensions, durable
   channel append, recipient mailbox claim/admission, and terminal cleanup.

If the panel is slow while the trajectory completes promptly, investigate
delivery/projection/rendering. If tool or model phases dominate while the panel
has no long tasks, investigate the workflow. For subagent delivery, keep task
channel terminal append, parent mailbox commit/claim/admission, and parent run
projection as separate coordinates. Raw timestamps from different monotonic
clocks are not subtractable; compare durations or shared durable event
coordinates.

## Static performance review

Measurements find active bottlenecks; static review prevents obvious work from
entering the experiment. For each changed unit, inspect:

- eager imports and package barrels in the initial browser or isolate closure;
- serialized awaits that are independent, repeated reads/builds without
  single-flight ownership, and polling where an authoritative event exists;
- React effects/subscriptions whose dependencies recreate work or retain
  listeners, and render-time transformations that can be moved to the owning
  data boundary;
- unbounded arrays, logs, queues, caches, returned records, or diagnostic
  payloads;
- filesystem hashing/discovery that ignores the canonical graph or immutable
  manifest;
- Electron/mobile startup work that blocks readiness despite being optional;
- duplicate “fast paths,” flags, or alternate implementations instead of
  reducing the canonical path.

Turn each suspicion into a build report, runtime profile, lifecycle span, or
focused test before claiming a performance result.

## Cleanup ownership

| Acquired resource                                     | Required cleanup                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `profilePanelInteraction` / `profilePanelReload` page | automatic in `finally`                                             |
| raw `handle.cdp.page()`                               | `await page.close()`                                               |
| workerd inspector helper                              | automatic; raw inspector sessions must close in `finally`          |
| opened test panel/entity                              | close or retire the exact handle/entity                            |
| managed system-test instance                          | `pnpm system-test --instance ID stop`                              |
| owned ephemeral server                                | terminate and await the exact process after inspector/page cleanup |

## Optimization loop

1. Define the top-level behavior and completion condition.
2. Capture at least one cold and one warm baseline when both are real user
   paths. Repeat noisy runs without changing state between variants.
3. Rank measured contributors: blocking CPU, serialized dependencies, I/O,
   transfer or evaluation bytes, render churn, queueing, or unnecessary work.
4. Remove or move the work at its owning layer. Prefer batching,
   single-flight, immutable caching, narrow subscriptions, lazy evaluation, and
   asynchronous or coalesced persistence when their invariants fit.
5. Preserve one canonical path. Do not add a performance flag, duplicate
   implementation, polling fallback, or compatibility shim to hide a broken
   design.
6. Run focused tests and type checks, then repeat the same profile. Expand
   coverage only across the plausible blast radius.

Report before and after values, the exact boundary, cold or warm state, and
remaining bottlenecks. A faster internal phase is not a win if the user's
completion boundary or agentic developer ergonomics regresses.
