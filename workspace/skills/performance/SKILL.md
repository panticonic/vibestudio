---
name: performance
description: Measure and optimize panel, app, worker, DO, build, startup, Electron, mobile, or agent performance with native profiling surfaces.
---

# Performance profiling

Measure one user-visible boundary at a time. Keep cold/warm states explicit,
optimize only measured bottlenecks, and repeat the same experiment afterward.

## Choose the evidence surface

| Question | Surface |
| --- | --- |
| Panel action/reload latency | `profilePanelInteraction`, `profilePanelReload` |
| Panel CPU or retained objects | `profilePanel`, `heapSnapshot` |
| Build time, cache, or bundle size | `profileBuild` |
| Server/workerd resources | `profileHost` |
| Startup phases | `readStartupProfile` |
| Worker or DO isolate CPU | `profileWorkerd`, `profileDO` |
| Electron process resources | `electronPerformanceSnapshot` via `client_eval` |
| Android build and readiness | `mobile-debug.buildAndroid`, `verifyWorkspaceReady` |
| Agent/chat e2e latency | system-test evidence + panel/host profiling |

These helpers come from `@workspace/testkit`. Use its public exports and live
docs for exact signatures. They return bounded summaries or artifact references,
not raw profiles over RPC.

## Panel and app measurements

Reuse one panel handle and one CDP page per runtime incarnation. Measure the
real action and await semantic completion inside the callback:

```ts
const handle = panelTree.get(panelId);
const page = await handle.cdp.page();
try {
  return await page.profile(async () => {
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
  }, { label: "open settings" });
} finally {
  await page.close();
}
```

Use the lifecycle handle for workspace-panel reloads, `page.goto` only for
browser pages. Cache disabling affects Chromium's HTTP cache, not application
state, service workers, DOs, or server build caches — reset only the layer the
experiment calls cold.

Run JS coverage separately from latency (coverage changes profiler overhead).
After navigation, rebuild, or runtime replacement, discard the stale page and
acquire one for the active incarnation.

## Build measurements

Profile the exact semantic context:

```ts
import { contextId } from "@workspace/runtime";
import { profileBuild } from "@workspace/testkit";

return profileBuild("panels/chat", {
  ref: `ctx:${contextId}`,
  verifyCache: true,
});
```

Call a run cold only when the receipt proves it built during the profile. Treat
a repeat as verified-cache evidence only when build keys match. Keep initial,
lazy, and total bytes distinct — don't add emitted artifact bytes to sealed
source bytes as one total.

Use bundle attribution before splitting code. Confirm allegedly unused imports
with coverage or ownership evidence. Request executable module contents only in
a separate, justified source-attribution investigation.

## Host, worker, and startup measurements

Wrap the canonical operation with `profileHost`; don't create a profiling-only
path. CPU, RSS, heap, and event-loop deltas describe the bounded interval, not
retained allocation by themselves. Use a heap snapshot only when object
attribution is required.

Read the startup profile before raw server logs. Use supervision health and logs
for one exact runtime identity. Use durable-work diagnostics for queue, claim,
execution, settlement, and recovery timing.

For isolate CPU, inspect available targets and run the real workload inside
`profileWorkerd` or `profileDO`. Regular workers may share a host target; DOs
usually provide narrower attribution. Pair CPU evidence with wall time, build
metadata, supervision, and durable-work timing — a CPU profile doesn't explain
time spent in storage, RPC, queues, or another process.

Raw CDP or V8 inspector sessions are a last resort. Close them in `finally`,
disable profiling after the bounded operation, and store large artifacts by
reference.

## Electron and mobile

Electron metrics are client-affine. Capture before/after
`electronPerformanceSnapshot()` in the same desktop client and use panel CDP for
panel attribution. Report Electron, server, and workerd resources separately.

Mobile builds are extension-owned. Select the attached device or explicit
architectures, then pair the build receipt with `verifyWorkspaceReady` from the
same start time. Process liveness ≠ app readiness. Use native or WebView tooling
only for attribution the extension doesn't provide.

## Agent and chat latency

Measure two boundaries:

1. In the real chat panel, profile submit → first visible completed response.
2. Run the smallest exact managed system test and inspect its bounded model,
   tool, suspension, delivery, and cleanup evidence.

If trajectory work completes promptly but the panel is slow, investigate
delivery, projection, or rendering. If model/tool phases dominate without
browser long tasks, investigate the workflow. Compare recorded durations or
shared durable coordinates; don't subtract unrelated monotonic clocks.

## Repository-managed instances

No running server? Create one uniquely named managed instance:

```bash
pnpm system-test --instance <id> doctor
```

Use that instance ID for every CLI/test call and stop it in cleanup:

```bash
pnpm system-test --instance <id> stop
```

When a direct server is required, own a named `pnpm server:live --instance <id>
--ephemeral` process, wait for readiness, use only the matching CLI instance,
then terminate and await it after closing inspectors and pages. Never reuse,
restart, or stop another person's instance.

Inspect the supervisor log if isolated bootstrap fails before reporting a
blocker.

## Performance by construction

- Publish usable readiness before optional history, suggestions, indexing, or
  diagnostics.
- Put expensive operation-specific code behind the operation that needs it.
- Keep shared entry points, package barrels, React module evaluation, worker
  constructors, and DO entry modules small and side-effect-free.
- Run independent I/O concurrently when semantics allow; own deduplication at
  the data boundary.
- Use bounded collections, logs, queues, caches, and diagnostics.
- Verify lazy boundaries survive the builder and runtime loader — source syntax
  alone isn't evidence.
- Preserve one implementation. Split into a small kernel and lazy features
  rather than adding a lightweight parallel path.

Turn static suspicions — eager imports, serialized independent work, repeated
builds, polling, unstable React effects, unbounded data, optional startup work —
into a focused measurement before claiming a result.

## Optimization workflow

1. Define the top-level behavior and completion condition.
2. Capture comparable baselines; include cold and warm only when both are real
   user paths.
3. Rank contributors: CPU, serialized dependencies, I/O, bytes, render churn,
   queueing, unnecessary work.
4. Remove or move work at its owner. Prefer batching, single-flight, narrow
   subscriptions, lazy evaluation, and async/coalesced persistence when
   invariants fit.
5. Run focused tests and repeat the same profile. Expand only across the
   plausible blast radius.

Close every raw page/inspector, opened panel/entity, managed test instance, and
owned ephemeral server. Report before/after values, exact boundary, state, and
remaining bottlenecks. A faster internal phase isn't a win unless the
user-visible completion boundary improves without changing behavior.
