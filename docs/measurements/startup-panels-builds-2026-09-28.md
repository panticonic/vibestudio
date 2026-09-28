# Startup, panels, and builds — 28 September 2026

**Status: profiling pass and fixes verified. Full desktop and Android smoke tests
passed; all owned test processes and instances are stopped.** The checkpoint is
a historical record of the earlier pause.

Measurements use the System template's native performance skill, `@workspace/testkit`,
managed instances, and the native mobile build extension. Values below are individual
runs or small samples, not statistically established percentiles. This is a shared
Linux development host; unrelated workloads were left running. Android evidence is
from an x86_64 emulator, not a physical phone or iOS device.

## Changes and measured effects

The Iroh reach advertisement now puts the native endpoint's selected home relay
first and retains the configured failover set. Previously the configured US relay
was tried before the endpoint's actual European home, causing a 12-second timeout.
The advertisement follows the current ingress generation. Mobile's shared endpoint
compares relay membership rather than peer-specific priority order.

| Boundary                                              |    Before |                     After |
| ----------------------------------------------------- | --------: | ------------------------: |
| Fresh desktop pairing → prepared workspace session    | 17,285 ms | 1,436 ms; repeat 1,276 ms |
| Empty chat, first five seconds: JS resources loaded   |        73 |                        43 |
| Same chat: decoded JS bytes                           | 3,862,508 |                 2,853,383 |
| Same five-second draft observation: browser task time | 135.74 ms |                  58.07 ms |
| Same observation: browser script time                 | 100.99 ms |                  43.62 ms |

The desktop pairing samples use the development executor: they do not include full
app presentation readiness. The chat change removes unconditional background
imports of optional rendering/debugging tools; existing feature-owned lazy imports
remain. This saves 30 requests and 1,009,125 decoded bytes (26%). Initial bundle size
is essentially unchanged; the improvement is avoiding unnecessary lazy downloads
and evaluation. The five-second observation includes a deliberate five-second wait.
It must not be presented as five seconds of startup latency. Host timings for these
samples included different first-use builds and concurrent workloads, and are not
an apples-to-apples startup comparison.

A separate mobile cold-launch defect was found: generic extension activation read
the runtime registry before the deferred React Native host prerequisite had been
staged, producing “Unknown extension: @workspace-extensions/react-native”. Activation
now stages the configured prerequisite through ordinary declaration reconciliation
before reading its state. Concurrent demands share the staging operation; normal
approval and build states remain in force.

Extension activation now uses the existing idempotent `ensureActivated` operation.
Launch retries reuse a running provider; explicit restart remains a separate
operation. The driver checks and the existing concurrent-activation regression pass.

Panel reload profiling now measures the canonical host operation across runtime
replacement. A CDP connection belongs to one incarnation and cannot profile both
sides of reload. The helper, documentation, and exact system-test validator were
updated together; sampled reloads verified different before/after attempt IDs.

## Empty-state host startup and internal builds

`perf-20260928-final` was provisioned into a newly created temporary state root.
There was no preexisting instance state folder. Content-addressed shared build
artifacts and installed dependencies were retained, as they are on ordinary new
workspace creation. This is cold **state**, not a claim of an empty machine cache.

| Boundary                                                                              |                        Measured |
| ------------------------------------------------------------------------------------- | ------------------------------: |
| `system-test doctor`: command start → new instance provisioned, paired, doctor passed |                       43,267 ms |
| Semantic activation lifecycle                                                         |                        1,862 ms |
| Initial snapshot import within semantic activation                                    |                        1,744 ms |
| Durable/runtime reconciliation                                                        |                           28 ms |
| Discovery of 90 build units                                                           |                            9 ms |
| Chat build report, first request with preexisting emitted artifact                    |                        9,156 ms |
| Same chat report, verified same-key cache repeat                                      |                         26.8 ms |
| Earlier chat build actually performed during profile                                  |                       12,669 ms |
| Its verified same-key cache repeat                                                    |                        120.5 ms |
| Earlier shell build report with preexisting artifact                                  |                       24,845 ms |
| Its verified same-key cache repeat                                                    |                        376.9 ms |
| Final shell first report / verified same-key repeat                                   |               16,387 / 154.7 ms |
| Android x86_64 native build receipt                                                   | 53,667 ms; APK 98,429,961 bytes |

Startup logs confirm reuse of 12 verified infrastructure package builds, fresh
headless-host prerequisite construction, semantic import, and runtime build work.
Exact template snapshot reads recorded 1,156 + 339 + 144 + 917 ms. The shell runtime
build logged about four seconds, including 659 ms of materialization. These phases
can overlap; do not add them to derive the full launch time.

A preexisting artifact does **not** imply a cheap first diagnostic report. The chat
report's typecheck log attributes 52 ms to source load, 5,231 ms to TypeScript, and
3,736 ms to authority analysis (9,019 ms total). This is the main observed first-report
cost, rather than graph discovery. Warm reports reuse exact-state validation.
Validation was not removed or weakened to improve a timing number.

A resumed fresh Android run exposed a fatal shared-cache hydration error while
linking `executable-modules.json.gz`. Hydration copied an entire directory containing
mutable metadata and writer scratch files, even though it then reconstructed its
own metadata. It now materializes only verified manifest-listed artifacts, with
metadata and execution records written from the captured snapshot. Publication and
new builds share the same record writer. Reads no longer schedule sidecar
recompression/migration; the previous condition also matched already-compressed
records after expansion. This removes redundant work and excludes metadata mutation
from artifact copying. Regression tests cover compressed and inline metadata,
concurrent sidecar replacement, scratch-file exclusion, and workspace provenance.

The final shell report attributed 93 ms to source load, 8,708 ms to TypeScript,
and 6,864 ms to authority analysis. These first-report costs remain a measured
optimization opportunity; this change does not claim to have eliminated them.

Chat initial delivery remains approximately 1.95 MB across 28 artifacts, including
747 KB CSS. The static bundle report keeps roughly 5.90 MB lazy. Radix theme CSS is
a large remaining initial contributor. Total emitted artifacts and sealed source
bytes are different quantities and are not summed here.

## Panel interaction and response evidence

Three post-change warm chat samples recorded:

| Operation                                     | Samples (ms)      |
| --------------------------------------------- | ----------------- |
| Canonical panel open → boot readiness         | 1,088 / 628 / 607 |
| Composer readiness after CDP attachment       | 534 / 90 / 73     |
| Draft typing                                  | 28 / 17 / 18      |
| Canonical reload → replacement boot readiness | 435 / 461 / 426   |

CDP attachment time is outside the composer measurements, so these are not complete
open-to-composer latency values. No browser long tasks were observed in the draft
samples.

A deterministic agent response test measured 3,626 ms from submit to visible rendered
bold response plus completed tool bead, including two deliberate 500 ms agent waits.
Browser task time was 516 ms, script time 230 ms, and no long tasks were recorded.
This verifies lazy rendering and delivery through the real panel, but excludes model
inference and is not evidence of improved provider latency. An earlier probe used
`strong` incorrectly: the renderer uses a styled span. Its timeout was diagnosed
from the rendered panel and the selector corrected. A separate real-model attempt
waited for credential consent and was excluded from latency conclusions.

The exact managed `testkit:chat-transcript` test passed in 14,694 ms
(`st_acce45d6e6354b0da3a2c074d9be935a`), covering prompt/tool/result rendering and
fork/parent navigation.

## Full desktop and mobile verification

The full desktop Iroh smoke passed: fresh pairing, mounted hosted shell, Personal
onboarding, System/Personal switching, workspace-owned icon/title projection,
settings, and a new panel. It then restarted its owned server while retaining the
desktop and device credential, recovered both workspace trees and onboarding, and
opened a new System panel without re-pairing. The smoke cleaned up its processes.

Native desktop startup spans were 16,140 ms total, with 633 ms bootstrap-window,
12,243 ms server-spawn/provisioning, 113 ms post-connect, and 2,953 ms desktop-mount.
Unlike the executor connection samples, this includes creating workspace state and
mounting the app. Onboarding and recovery assertions continue after that span.

The Android rerun also exposed a harness bug: after one launch review resolved,
the driver kept treating the historical submitted phase as an in-flight decision
and never handled the next review. It now compares submitted and resolved counts,
preventing duplicate taps while allowing subsequent reviews.

The resumed Android run handled both reviews and activated the hosted bundle,
then exposed a dependency mismatch during the first navigation render. The System
mobile-navigation package allowed newer navigators while forcing core 7.21.13,
which does not return their required `render` function. Native 7.4.1, stack 7.11.2,
and drawer 7.14.2 now resolve a compatible core through Native's dependency.
Core 7.22.1 no longer uses query-string, so the obsolete core override and import
patch were removed in both the host and System template rather than extending them.
The corrected full Android smoke passed (exit 0): fresh pairing, automatic Personal
onboarding, a completed deterministic agent turn, rendered chat, workspace launcher
interaction, camera permission enforcement, workspace cookie isolation, and retained
panel focus. App relaunch reused persisted credentials, and server restart recovered
the still-live panel. Both recovery checks recorded zero panel-asset pipe misses.
The screenshot was visually checked as well as tested for nonblank content.

The corrected Android run recorded 65,469 ms from embedded pairing start to
completion, including fresh workspace provisioning; 247 seconds in the hosted app
build, including 87,248 ms installing its new dependency environment; 2,791 ms from
bundle activation start to completion; and 14,978 ms from Personal chat activation
to panel-ready. These boundaries are sequential observations from a cold run,
not before/after speedup claims. The hosted build emits Android and iOS artifacts;
this run only executes Android. The native APK build receipt above is a different
operation from this hosted JavaScript build.

The host was under heavy memory pressure (76 MB available, load average 19.36 at
one sample); Android runs here should not be used as a clean latency comparison.

## Validation and evidence handling

- Relay/ingress/hub focused tests: 63 passed; added ingress-generation checks: 8 passed.
- Mobile relay-pool regression: 1 passed; deferred extension driver: 4 passed.
- Build-store tests: 24 passed; canonical concurrent extension activation: 1 passed.
- Base chat tests: 317 passed across 52 files.
- Native profiling helper tests: 2 passed; system-test validator tests: 23 passed.
- Host, Base, and System composition typechecks passed, including System mobile integration.
- Template checkout hygiene and focused formatting checks passed.

Changes span this host checkout and the configured Base, System, and System-testing
source checkouts. Unrelated concurrent edits were preserved. Raw profiles and logs
are local under `/tmp/vibestudio-perf-*`; full system-test evidence remains under the
private system-test artifact directory. Pairing links, credentials, and full
trajectories are deliberately not copied into this report.

## Remaining limits and cleanup

First-use TypeScript/authority validation, cold dependency installation, and the
mobile bundle build remain substantial costs. Cold-state measurements retain the
shared artifact cache; device coverage is Android x86_64, not iOS or a physical
phone. Deterministic chat tests establish delivery/rendering behavior, not provider
inference latency. No claim is made that every panel or every slow path is now fast.

A background System build-retention GC warning (`build retention commit did not
complete cleanly`) appeared during Android verification. The bounded log does not
identify which retention condition failed; this pass does not claim to resolve it.
The complete foreground smoke nevertheless passed, including recovery.

Managed profiling instances, desktop executors, mobile smoke servers, page/inspector
connections, and the owned Android emulator were retired. The final Android state
root was removed, a process-environment scan found no remaining owned processes,
and adb listed no devices. Temporary state left by the interrupted pre-restart
runs was also removed. Unrelated user processes were left running.
