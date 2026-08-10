---
name: performance
description: Profile and optimize Vibestudio panels, apps, workers, builds, startup, and agent workflows with behavior-preserving measurements. Use for slow UI, sluggish interactions, cold or warm panel loads, large bundles, worker or Durable Object latency, event-loop stalls, excessive rendering, slow builds, or performance regression investigations.
---

# Performance profiling

Measure one user-visible boundary at a time, keep cold and warm paths separate,
and compare equivalent states. Optimize only a bottleneck supported by the
report, then rerun the smallest measurement that can prove the change.

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

Build the exact context under investigation, then inspect immutable metadata
for every returned build key:

```ts
const report = await services.build.getBuildReport(source, `ctx:${ctx.contextId}`);
const metadata = await Promise.all(
  report.builds
    .filter((build) => build.buildKey)
    .map((build) =>
      services.build.getBuildMetadata(build.buildKey!, {
        includeExecutableModules: false,
      })
    )
);
return { report, metadata };
```

For panels, `metadata.bundleReport` separates initial, lazy, and total payloads
and lists their largest inputs. Worker metadata can contain megabytes of sealed
executable source, so keep `includeExecutableModules: false` unless source-level
provenance is the measurement. Attribute initial bytes before splitting code.
Do not infer that an import is unused from bundle size alone; confirm it with a
coverage run or source ownership. Measure cache-cold and verified-cache build
paths separately.

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

- Query `services.serverLog` for the exact time window around startup, builds,
  routing, workerd supervision, and event-loop budget warnings.
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
