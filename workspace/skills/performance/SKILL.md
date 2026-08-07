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

For a cold HTTP-cache load, navigate the existing page to its current URL and
disable Chromium's cache only for the measured operation:

```ts
return await scope.page.profile(
  async () => {
    await scope.page.goto(scope.page.url());
    await scope.page.waitForLoadState("networkidle");
  },
  { label: "cold panel load", disableCache: true }
);
```

`disableCache` does not clear application memory, Durable Object state, service
workers, or server build caches. Restart or reset only the layer the experiment
actually calls cold. Query strings and fragments are removed from retained
network and coverage URLs so reports do not echo tokens.

Use `javascriptCoverage: true` in a separate attribution run. Precise coverage
adds profiler overhead, so never compare its elapsed or CPU durations with a
normal latency run.

The report is deliberately bounded and JSON-safe:

- `elapsedMs` is the exact callback boundary.
- `runtime` contains task/script/layout/style deltas, heap, DOM nodes, and
  document counts from Chromium's Performance domain.
- `page` contains navigation/paint observations, session layout shift,
  interaction latency, and long tasks. These are lab observations for the
  measured session, not field Core Web Vitals.
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
    .map((build) => services.build.getBuildMetadata(build.buildKey!))
);
return { report, metadata };
```

For panels, `metadata.bundleReport` separates initial, lazy, and total payloads
and lists their largest inputs. Attribute initial bytes before splitting code.
Do not infer that an import is unused from bundle size alone; confirm it with a
coverage run or source ownership. Measure cache-cold and verified-cache build
paths separately.

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
