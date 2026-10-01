# Startup build panel and chat performance on 1 October 2026

This pass measured fresh application startup, runtime builds, panel loading and
reloads, deterministic chat responses, and real model-driven agent work. The
implemented optimization removes repeated whole-source scans from authority
checking. Controlled replay reduced chat validation by 32% and shell validation
by 25%, while preserving compiler work and capability inference. Cold startup
still spends most of its time provisioning templates, dependencies, and runtimes.
There is no established startup or model-inference speedup from this change.

## State and measurement boundaries

Measurements used the native performance skill from the configured System
checkout, `@workspace/testkit`, and separately owned instances. Baseline,
attribution, and final instances were named `perf-20261001-baseline`,
`perf-20261001-attribution`, and `perf-20261001-final`. No existing developer
instance was restarted or stopped. This is a shared Linux host; unrelated
workloads and concurrent repository edits remained in place. These are individual
runs and small samples, not percentiles.

Every cold startup used new application state and a unique, initially empty
`VIBESTUDIO_SHARED_DERIVED_CACHE_DIR` and `npm_config_cache`. That removes
template checkpoints, runtime build artifacts/results, extension runtime
dependencies, and downloaded dependency caches from the application experiment.
Installed host dependencies, receipt-verified infrastructure outputs, Electron,
and the OS file cache remained available. This is fully cold application state
and derived caches on an installed development checkout; it is not a bare-machine
installation or a cold disk/page-cache benchmark. System-wide caches were not
flushed because this host is shared.

The managed doctor boundary includes provisioning, pairing, startup preparation,
and a passing doctor. Desktop native `startup:total` ends at shell mounting; it
does not establish that onboarding or workspace admission has completed. The
desktop launch measurement also waits for the initial configured prompt to be
submitted and its setup overview rendered. The command boundary additionally
includes source-template checkpointing before Electron launches.

## Implemented change and controlled attribution

Authority inference previously tested every host method in three quote styles
against each source file. The reviewed catalog has 599 methods. Both the source
closure prefilter and transport inference repeatedly scanned the same large
strings. V8 profiling attributed about 2.24 seconds of chat validation to the
prefilter and another 1.12 seconds to transport inference.

The shared inference package now scans quoted literals once and checks catalog
membership. The closure prefilter uses the same implementation. Catalog iteration
still determines capability ordering. Overlapping quote delimiters preserve the
original raw substring contract, including matches in comments; the optimizer
does not substitute a different semantic recognition rule. Native TypeScript and
authority analysis still run normally, with their original diagnostics.

The controlled replay fed the same immutable captured requests to the canonical
typecheck worker before and after the change. Both measured versions included
the same temporary CPU/timing instrumentation, which was removed afterward.

| Exact validation boundary | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Chat complete typecheck and authority fold | 10,663 ms | 7,207 ms | 32.4% |
| Chat authority phase | 4,827 ms | 1,477 ms | 69.4% |
| Shell complete typecheck and authority fold | 15,693 ms | 11,755 ms | 25.1% |
| Shell authority phase | 9,571 ms | 5,622 ms | 41.3% |

Chat retained 1,342 compiler requests, 300 fetched source files, 538,355 fetched
nodes, and 26,250 materialized nodes. Shell retained 4,581 requests, 251 files,
543,853 fetched nodes, and 127,676 materialized nodes. All three replayed units,
including `about/new`, returned no diagnostics. A final uninstrumented replay
also returned no diagnostics: chat authority 1,515 ms and shell authority
5,933 ms. Its compiler intervals overlapped focused test execution, so use the
instrumented comparison above for attribution.

## Runtime builds and payloads

Native `profileBuild` used `ref: ctx:<contextId>` and `verifyCache: true` for chat,
New, and shell, in sequence. Both chat receipts prove a build occurred during
profiling. New and shell already had emitted artifacts and their first report
included fresh validation; those rows are not cold compilation claims.

| Native build report | Initial run | Final run | Final same-key repeat |
| --- | ---: | ---: | ---: |
| Chat, built during profile | 14,752 ms | 10,734 ms | 87 ms |
| New, preexisting artifact | 4,058 ms | 3,446 ms | 21 ms |
| Shell, preexisting artifact | 16,591 ms | 12,528 ms | 14 ms |

Every final report had status `ok`, no diagnostics, and equal keys between its
first and repeated requests. Concurrent host/RPC changes altered keys between
the initial and final instances, so these end-to-end rows are supporting
observations rather than an isolated estimate of this patch's effect. Controlled
worker replay provides the causal comparison.

| Target | Initial build key | Final build key |
| --- | --- | --- |
| Chat | `f970057cf1e8f8ff968a2bdaca7ed102ad989e1ce3dff530da0a07a6ae6a58f8` | `119be994960f0a73f13a2815ff8a3fdfbc03013befd4a9ed74684a281c00736f` |
| New | `1ac60bb61aea7ca934af14b4bcebaa6fe7350a663ff174b1b09487d1de31a4b0` | `48e56408fda84f3b8d812b28744e4eb6229d0b289c82b30b7808e23660871dc4` |
| Shell | `f342f8291ac194a559b865e5bff2bcee171875544b62d334cc02e83762df7ee4` | `7d4c3b150362d9345fbec54ec4af742f4f62a416603fb30dea9d5f0ac1b484a6` |

Final initial payloads were chat 2,027,747 bytes over 30 requests, New 1,640,949
bytes over 16 requests, and shell 2,874,125 bytes over 27 requests. Each increased
148 bytes from the initial run. Chat's initial CSS is 750,061 bytes and its lazy
payload was about 5.9 MB. Radix and workspace runtime inputs account for much of
the initial payload. This pass did not establish that their peers/styles were
unused and did not remove required dependencies to reduce the reported size.

The canonical development host build command, `node scripts/ensure-host-build.mjs`,
measured 3,654 ms initially and 3,587 ms finally. These are incremental host
builds with installed dependencies and validated infrastructure reuse, not full
compilation from an empty host checkout.

## Cold startup

| Boundary | Measured |
| --- | ---: |
| First empty-cache managed doctor | 75,141 ms |
| Final empty-cache managed doctor | 66,631 ms |
| Initial System semantic activation | 4,087 ms |
| Final System semantic activation | 3,843 ms |
| Final snapshot import within activation | 3,709 ms |
| Final durable/runtime reconciliation | 39 ms |
| Final discovery of 91 build units | 13 ms |
| First desktop native shell startup | 16,974 ms |
| First complete post-change desktop smoke native shell startup | 22,287 ms |
| That smoke's local launch phase to rendered onboarding | 51,363 ms |
| Final desktop native shell startup | 26,445 ms |
| Final command start to native shell startup | 38,177 ms |
| Final local launch phase to admitted workspace and rendered onboarding | 60,659 ms |
| Final command start to admitted workspace and rendered onboarding | 71,816 ms |
| Final complete desktop smoke including history checks and cleanup | 82,828 ms |

The first managed startup installed fresh agent-worker dependencies in 18.3
seconds and system-test-runner dependencies in 23.2 seconds. Final installations
measured 8.6 and 13.2 seconds. These include external package download variability;
the faster doctor is not attributable solely to authority scanning. Native
TypeScript validation, dependency installation, snapshot import, and template
preparation remain the principal cold contributors.

Cold desktop testing exposed two harness readiness assumptions. First-run
reporting consent was not being resolved, leaving a valid shell overlay visible.
The smoke now chooses **Keep automatic reports off** through the ordinary UI.
Second, a mounted New panel could precede completion of its workspace creation
review. A repeat reached onboarding after 59,290 ms from command start but failed
its later history acceptance with the original pending-review error. The driver
now reads `shellApproval.getWorkspaceCreationReviewState`, resolves the visible
review through the existing UI flow, and proceeds only on `resolved` or
`not-required`. `failed` and `unresolved` propagate as failures. No timeout,
permission bypass, or history-query retry was added.

The final fresh-cache desktop run passed the complete smoke after that repair:
one initial onboarding conversation, its completed setup UI, a separately opened
New panel and successful history read, decoded workspace icons, and clean desktop
diagnostics. Its 71.8-second command-to-readiness result includes the authoritative
admission boundary. Earlier onboarding timings did not explicitly verify that
boundary and must not be presented as the same readiness measurement. Native
shell startup varied from 17 to 26 seconds across these runs; this pass establishes
cold costs and correctness, not a statistically supported startup improvement.

## Panel and chat behavior

Panels were opened through `openPanel`, profiled through their native CDP handles,
and reloaded through `profilePanelReload`. Pages were closed and panels archived
in `finally`. Reload preserved each runtime attempt, as required by the current
canonical lifecycle contract.

| Boundary | Initial samples | Final samples |
| --- | --- | --- |
| Chat host open | 567 / 516 / 427 ms | 553 / 469 / 411 ms |
| Chat CDP attachment after open | 579 / 349 / 265 ms | 249 / 214 / 193 ms |
| Composer visibility after attachment | 8 / 19 / 363 ms | 26 / 18 / 13 ms |
| Chat reload through boot readiness | 202 / 182 / 248 ms | 160 / 171 / 139 ms |
| Draft edit | 17 / 11 / 24 ms | 18 / 15 / 17 ms |
| First New host open | 2,479 ms | 1,393 ms |
| Help host open | 1,009 ms | 998 ms |

These boundaries are separate; a host-open receipt alone is not composer-visible
readiness. The first New also pays first headless-host use. Samples are too small
and the host too variable to claim a general renderer speedup.

The real chat panel used `TestAgentWorker` with zero artificial delay, fixed
Markdown response, and an actual `1+1` eval. Profiling awaited both visible reply
completion and the completed eval card. Initial submit-to-completion samples were
2,947 / 483 / 505 ms; final samples were 2,876 / 528 / 536 ms. There were no browser
long tasks or failed network requests. First use included lazy runtime/rendering
work; warm delivery is about half a second. This measures product overhead and
excludes provider inference.

The real `build-performance-profile` agent test passed in 53,494 ms of agent
execution, with 12 model calls occupying 34,375 ms in total, zero tool failures,
and awaited remote cleanup. Delivery histograms recorded maximum publish-to-
execution latency 1,452 ms over 54 samples and result-to-caller settlement
1,088 ms over 11 samples. The run passed its delivery validators. Model turns
and workflow/tool work dominate this task; browser rendering is not evidence of
that model latency.

An initial `build-service` run failed validation after 43,528 ms: the model read
package sources but never executed the runtime import required by the test.
Inspection and full trajectory showed no tool errors, stuck ownership, or quota
fallback failure. Its delivery maxima were 985 and 342 ms. This was an agent
behavior/validation mismatch, not a startup infrastructure failure. The test or
prompt was not weakened to conceal it. The later passing build-profile test is a
different task and is not a before/after agent-latency comparison.

## Verification and evidence

The authority inference suite passed 24 tests, including quote styles, malformed
and overlapping delimiters, false-positive boundaries, and inferred ordering.
Focused host authority-fold, typecheck-fold, and worker-client suites passed
31 tests. Host and workerd-program typechecks passed. Template checkout hygiene,
JavaScript syntax, and patch whitespace checks passed. The exact managed
`build-performance-profile` test passed, and `testkit:chat-transcript` passed both
of its constituent checks in a 12,349 ms managed run. No broad suite ran alongside
the agent latency experiment.

Private logs, native profiles, captured immutable requests, and trajectories are
under `/tmp/vibestudio-perf-20261001`, with restrictive permissions. The initial
agent run is `st_f41267655fa643c58a3f8ce97c07edc8`, passing build-profile run
`st_ac297457b82741ada34b2a1b320d4037`, and passing chat run
`st_88599bf83a5c46f3bdf6fb4da5d3a7ea`. Raw trajectories are not published here.
Temporary worker inspector/timing instrumentation has been removed. Concurrent
extension-host and RPC edits were preserved and are outside this patch.
All three managed instances were stopped through their exact instance IDs. Every
desktop smoke joined its owned processes and removed its temporary application
state, including the failed investigation runs. No owned inspector or panel
connection remains live. Changes are in the working tree for review.

To repeat build measurements, provision an owned managed instance with a fresh
derived-cache and npm-cache path, run doctor, attach a CLI session to its selected
System workspace, and evaluate `profileBuild(source, { ref: 'ctx:' + contextId,
verifyCache: true })` from `@workspace/testkit`. Read `readStartupProfile()` before
raw logs. Stop that exact managed instance afterward.

For the local desktop smoke, use a fresh derived-cache and npm-cache path with
`NODE_ENV=development NODE_OPTIONS='--import tsx' xvfb-run -a node
scripts/desktop-pairing-smoke.mjs --local`. On this Linux host the isolated display
also required removing inherited `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE`. Xvfb
was extracted into the private temporary directory rather than installed into
the host. The smoke owns and cleans its desktop, hub, workspace processes, secret
service, and application state.
