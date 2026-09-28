# Workspace startup parallelization — 28 September 2026

The desktop's “Opening your workspaces…” boundary includes the selected
workspace's host startup, transport, native runtime, and initial panel snapshot.
It begins after the System-hosted shell mounts; the existing native startup total
ends earlier and does not describe the full wait. The shell now records
`workspace:initial-open`, and the desktop smoke captures that UserTiming measure.

## Changes and ownership

- Interactive desktop requests the selected workspace's host through the hub as
  soon as its identity is known, alongside System host startup. Once the desktop
  session exists, the same single-flight native runtime path prepares it during
  System application mounting. Headless clients do not start an unused workspace.
- Desktop shell identity, initial focus metadata, and private workspace discovery
  overlap. Native membership lookup overlaps connection establishment. Browser
  permissions overlap runtime registration; download startup overlaps Personal
  service registration. Event-watch-before-snapshot ordering remains unchanged.
- Mobile publishes its System client owner before opening the selected workspace
  concurrently. Saved selection reads overlap private workspace discovery.
  Snapshot loading, permissions, and the panel asset facade overlap; initial
  snapshot persistence moves behind first paint into owned reconciliation, and
  event subscriptions use the existing batch operation.
- Resource-acquiring parallel prerequisites drain their siblings before failure
  cleanup. The runtime registration failure test explicitly covers a late lease.
- Filter-list fetching, parsing, compression, and serialization run in a one-shot
  worker. The main process deserializes the result for synchronous request
  matching; cache reads and writes are asynchronous. Worker success, error, and
  premature exit all await termination. The worker ships with the same immutable
  desktop generation and existing ASAR worker unpack rule.
- Build fingerprinting reads installed manifests in bounded batches of 16 and
  overlaps local-package and installed-dependency scans. Folding retains sorted
  depth-first order and the exact existing hash encoding.
- Desktop smoke pins an immutable host generation, so another checkout build
  cannot replace bootstrap HTML or preloads beneath an in-flight launch.

## Measurements

These runs use fresh application state folders with shared dependency and emitted
build caches retained. They are not fully uncached dependency installations.
The shared host experienced substantial swapping and unrelated live workloads;
the desktop samples must not be treated as an isolated speedup estimate.

| Boundary | Before | With changes |
| --- | ---: | ---: |
| Shell mount to initial workspace focus, intermediate desktop pass | 59,076 ms | 24,177 ms |
| Shell mount to initial workspace focus, final early-host pass | — | 249 ms |
| Native startup through shell mounting, final early-host pass | — | 19,580 ms |
| Root dependency fingerprint, alternating three-run median | 288.9 ms | 164.3 ms |
| Main-thread maximum delay during 60,000-rule filter fixture compilation | 533 ms | 13 ms |
| Total time for that filter fixture compilation | 670 ms | 957 ms |

The desktop intermediate sample predates the final change that starts Personal's
host alongside System. The earlier baseline ran under markedly worse memory
pressure; its full wall-time difference cannot be attributed to this patch.
The filter worker intentionally trades some total work time for main-thread
responsiveness. This synthetic fixture is not a production filter-list percentile.

Fingerprint samples were alternated in one process against the same checkout:
before 295.9, 288.9, 262.3 ms; after 166.0, 164.3, 156.0 ms. Every sample produced
`01442c0e41d7e8bc8b1342de9d2fe81345c1bc731a9f7e907d245af8c50923a0`.
The regression test independently folds nested/scoped/symlinked packages,
missing manifests, and enough siblings to cross batch boundaries.

## Verification

- 68 focused host runtime, session-directory, filter, and fingerprint tests.
- 16 hub/session tests, including System connection completing while Personal
  host preparation is blocked.
- 15 desktop workspace tests and 20 mobile directory/snapshot/profile tests.
- Host/workerd and projected System/mobile TypeScript checks.
- Three host generation tests; build artifact contracts and a compiled worker
  integration check using a local HTTP filter fixture.
- Template checkout hygiene; focused lint has warnings but no errors.
- Complete intermediate fresh-state local desktop smoke, including Personal and
  System, onboarding prompt/response, New panel/history, and workspace icons.

The final early-host desktop run also passed the full local smoke. Native phases
were bootstrap 694 ms, server spawn 15,711 ms, post-connect 103 ms, and desktop
mount 3,014 ms. Its 249 ms opening measure captures focus readiness, not the later
onboarding agent response. The desktop, hub, children, inspector connections,
and isolated secret service shut down; its temporary state root was removed.

The companion System commit is `b965ca1`. Android end-to-end verification did
not complete: the cold hosted mobile bundle exceeded the activation budget under
severe shared-host memory pressure. The user cancelled further mobile verification.
The runner had already exited and completed its cleanup when cancellation was
processed. Its hub and workspace children stopped, its temporary state was removed,
and the owned emulator was shut down. There is no Android end-to-end pass or
mobile speedup claim for this change; the focused mobile tests and typecheck passed.

The React Native provider currently emits a complete Android/iOS artifact set,
running a separate Metro process for each platform. This remains a substantial
cold-build cost. This pass does not multiply those memory-heavy processes on a
host already experiencing swapping; concurrency is bounded in fingerprint I/O
and retained at existing build-worker limits.

## Commit gate

The shared checkout's pre-commit hook could not finish: unrelated authority
changes require an explicit review of
the runtime authority census (`scripts/runtime-authority-review.json`). Expected
digest: `d2a90f404f3006a27cccd2b8459f8a41e3ca3c22be196eab8f9e1dc8f9568906`;
observed: `e79c9da1002be557cd3103a150259733411d4a687643b03dc26770544ee3144b`.
The review record was not changed. Earlier stale generated agent API documentation
and the builtin catalog were regenerated using their canonical repository
commands; those outputs remain unstaged with the concurrent work, outside the
performance change. After the blocker was reported, the user authorized proceeding
with the performance commit. The hook was bypassed for that commit; the focused
validation above remains the evidence, rather than a full pre-commit pass.
