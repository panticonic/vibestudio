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
under `/home/werg/.cache/vibestudio-performance/2026-10-01-initial`, with restrictive permissions. The initial
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

## Follow-up: template preparation and the New launcher

The follow-up removes a repeated status scan of already sealed private template
checkpoints, runs independent checkpoint and snapshot work with four concurrent
owners, and joins all started inspections before propagating a failure. Native
Git still captures visible tracked and untracked edits in private repositories;
exact snapshot admission and template validation remain mandatory. Selection
order and canonical source pins are preserved.

A controlled replay of the canonical `resolveDevelopmentTemplateSet` operation
used the same eight source pins for all six samples, fresh checkpoint roots, and
no other heavy work from this investigation. Original preparation took 8,622,
8,360, and 8,147 ms. The candidate took 4,632, 4,984, and 5,563 ms. Median
preparation fell from 8,360 to 4,984 ms, a 40.4% reduction. The redundant Base
checkpoint status walk alone had measured 2,797 ms. This is preparation before
application launch, rather than a claim about total onboarding or model time.

New previously waited for both `workspace.sourceTree()` and
`workers.listServices()` before publishing its launchable panel catalogue. In
one native operation, the source tree returned in 42 ms and service discovery in
231 ms. The launcher now publishes the catalogue as soon as its authoritative
source tree arrives. Independent, single-flight service discovery still enables
history when available; its failure retains the original diagnostic and leaves
panel launching usable. Existing history, ranking, launch links, keyboard modes,
user preferences, and permissions retain their normal behavior.

The HTTP runtime helpers now use the existing compression path with a bounded
cache shared by individual helper responses and bundle records. Negotiation,
versioned immutable caching, identity responses, and content digests remain
intact. For the exact same browser transport script, the original HTTP response
transferred 594,517 bytes despite accepting compression. The candidate transfers
79,334 bytes with Brotli (86.7% less), or 101,972 with gzip. Both decompress to
594,517 bytes with the original SHA-256 digest. Chromium resource timing also
observed 79,334 encoded bytes and 594,517 decoded bytes. Shared styles and normal
build artifacts were already compressed; their decoded sizes are not savings
from this change.

Native New profiles used fresh named instances and the same profiling options.
The initial exploratory samples overlapped template benchmarking and are not a
reliable latency baseline. A subsequent control restored the original launcher
and helper serving code, with the optimized template preparation retained. Both
control and candidate used fresh application state, derived caches, and npm
caches. Their first New build receipts were `preexisting`, so neither is a cold
compilation claim.

| New boundary | Control | Candidate |
| --- | ---: | ---: |
| First native panel open after build profiling | 1,324 ms | 1,371 ms |
| Four subsequent opens | 406 / 397 / 404 / 422 ms | 462 / 464 / 435 / 399 ms |
| Four subsequent first paints | 184 / 196 / 188 / 208 ms | 192 / 200 / 216 / 188 ms |
| Five native reloads | 125 / 164 / 113 / 101 / 92 ms | 165 / 215 / 101 / 105 / 97 ms |
| New initial emitted payload | 1,640,949 bytes | 1,641,137 bytes |
| Verified repeat build | 27 ms | 15 ms |

Each verified repeat preserved its first build key and returned no diagnostics.
Control New key was `088f7eeef51520d7c2f23aa68fdcf76d5879d0e464e2e4a95c94d1d3e0267d15`;
candidate key was `b5c53aa78ae98ce70d95e0b5deb4f7c4dcd95774e89c5cec329fb93db2bdfd0f`.
All ten observed panels initially focused the combobox. These small loopback
samples do not establish a panel-open speedup; the verified benefits are fewer
transport bytes and removal of the optional service-discovery readiness gate.
Runtime helper bytes are outside the panel's initial emitted payload above.

The exact managed `build-performance-profile` test passed in 66,261 ms with no
tool failures. Its agent used ten model calls totaling 26,098 ms and chose a
cold Terminal build. This differs from the earlier agent's target and workflow;
it does not establish an agent-inference speedup. Deterministic real chat-panel
responses completed in 3,088, 519, and 604 ms, with no browser long tasks and no
failed requests. Compiler validation, required patched provider SDK installs,
semantic snapshot admission, and model inference remain substantial cold costs.
Required peers, styles, compiler checks, and provider behavior were preserved.


### Follow-up cold desktop verification and limits

The final successful desktop run used an isolated host review worktree containing
only this pass's host changes, fresh application state, and unique empty derived
and npm caches. Its native shell startup was 24,303 ms; command-to-shell was
33,171 ms. Onboarding rendered in 63,909 ms from the local launch phase, or
72,062 ms from the command. The complete smoke, including separately opening New,
reading history, filtering `@Help`, launching Help with Enter, and cleanup, passed
in 84,282 ms. Installed host dependencies and verified host outputs remained
available, as defined in the cold-state boundary above. This individual run does
not establish a total-startup improvement over the earlier 71,816 ms onboarding
observation.

A fresh-application repeat with the same derived/npm caches also passed the full
smoke in 64,652 ms, reaching onboarding at 51,826 ms from the command. This is
warm-derived evidence, not another completely cold run. A further empty-cache
repeat reached its native shell boundary in 31,777 ms, then reported that the
shell renderer was `killed` and failed with `Hosted desktop chrome is unavailable`.
Its owned processes and temporary state were retired. The cause of that renderer
termination was not established; it is retained as a failed observation rather
than folded into successful timing claims.

Earlier cold investigations twice blocked workspace admission behind a generic
reporting-preference failure banner, including once in the isolated host candidate.
This intermittent failure has not been diagnosed or claimed fixed. The reporting
UI now preserves the original save error in its banner, and the smoke propagates
a visible reporting failure before continuing to wait for admission. The latest
successful cold run and fresh-application repeat did not reproduce that failure.
Consent revisions, trusted UI checks, explicit retry, and admission gates remain
intact. The investigation did not add automatic recovery or production deadlines.

Verification passed 60 focused host tests, 21 New launcher tests, and 15 reporting
UI tests, plus Base and System composition typechecks. The isolated host commit
gate checks host/workerd types, lint, format, template hygiene, documentation,
authority, and dependency boundaries. Native profiling instances
`perf-new-20261001-baseline`, `perf-new-20261001-final`, and
`perf-new-20261001-control` were stopped; opened panels and inspector connections
were closed. Logs, native profiles, failed observations, and screenshots remain
private under `/home/werg/.cache/vibestudio-performance/2026-10-01-follow-up`.


The retained benchmarking caches initially occupied approximately 9.7 GB on this
host's RAM-backed `/tmp`. They contributed materially to memory pressure and
should have been retired sooner. All completed runs' derived caches were removed;
retained evidence and the review worktree were moved to the disk-backed private
cache directory above. `/tmp` usage fell from 11 GB to 1.1 GB, and available memory
rose to approximately 20 GB. No owned profiling process remained live. The other
active instance, `trello-import-20261001`, was left running. This resource evidence
does not by itself establish the cause of the earlier renderer termination.
Future cold experiments should allocate their fresh caches on disk and remove
owned caches after inspection rather than accumulate them on a RAM filesystem.

### Cold critical-path follow-up

This pass used host base `09c25ffec` in an isolated review worktree and eight clean
source-template worktrees. Base was `b12cabd020c161b4cd15358417828fc6fd0c2486`,
Personal `482d45f`, and System `b4e1896`. Development composition produced the same
Personal and System checkpoint commits before and after
(`ed0c83723d69f0d0d7efdb1f78458bd6eb7bcd0b` and
`8674dae7bcd11dee3dca828aebe09fe457846395`). Every cold run began with fresh
application state and unique empty derived/npm caches on disk. Installed host
binaries and dependencies, OS caches, and registry/network infrastructure were
retained. This measures completely cold application and derived state; it does
not measure a fresh OS installation. An unrelated Trello import instance remained
active and was neither reused nor stopped, so host contention was not controlled.

The changes remove work at existing owners:

- Development checkpoints fetch the captured commit and its complete tree,
  without transferring unrelated history, branches, or tags. Dirty-file capture,
  detached/linked checkout support, and private object ownership remain intact.
- Root-template acquisition copies only Git metadata into its immutable Git
  cache. The named-commit reader still verifies and materializes every required
  source file; it does not need a second copy of the checkout's worktree.
- Bootstrap sealing reads, hashes, and mirrors files with 16 bounded workers.
  Indexed results preserve the source identity and order. A failure stops new
  assignments, joins every started operation, and propagates the original error
  before any tree publication.
- Executable-module inventory computes package-root ordering once and reads each
  external package manifest once per build. It retains all source contents,
  module identities, package digests, required peers, and compiler checks.

Native `readStartupProfile` and `profileBuild('panels/chat', {ref:
'ctx:<contextId>', verifyCache: true})` were captured on separate owned managed
instances, with the same source pins and profiling options. Structured host logs
provided additional phase attribution after the startup profile was read.

| Boundary                                    |   Control | Candidate before download-cache change |
| ------------------------------------------- | --------: | -------------------------------------: |
| Root-template preparation                   |  3,769 ms |                               2,580 ms |
| Base Git metadata copy                      |    936 ms |                                  32 ms |
| Prepared source → sealed bootstrap snapshot |  1,521 ms |                               1,167 ms |
| Semantic snapshot import                    |  5,042 ms |                               4,322 ms |
| Service container ready, host uptime        | 22,432 ms |                              18,957 ms |
| Cold chat build during native profile       | 13,779 ms |                              12,292 ms |
| Verified repeat chat build                  |    135 ms |                                 151 ms |

Semantic import itself was not modified; its lower observation is not proof of
an import-algorithm improvement. Chat retained the exact build key
`3944d73130781f8aeb2b154706ba6ae586511bc5b9ab71e53c85ed5490548345`, source
state `state:48cbcfa87c69f6e472eef7ae3ff58837585c4e2b6801488314a5814cf6e05ff7`,
3,284 sealed executable modules, 17,615,055 source bytes, and a 2,027,599-byte
initial emitted payload. Both verified repeats had no diagnostics. Three full
checkpoint samples had medians of 4,629 ms before and 4,626 ms after: no checkpoint
latency improvement was established, although obsolete history is no longer
retained in each temporary checkpoint.

The original reporting banner was reproduced with its now-visible error:
`Consent changed; refresh your choice`. Personal and System can both read the
installation's initial consent revision and then save the same preference.
Reporting consent is now an idempotent desired-state operation: repeating the
established On or Off choice returns the existing revision and pseudonym. A stale
request to change the current choice still fails. Tests use two independent
store handles to the same database and cover both choices, stale opposing writes,
and user isolation. This repairs the admission race without automatic retries,
suppressed failures, altered policy versions, or UI bypasses.

### Registry downloads shared across dependency graphs

Direct Git/local dependency specifiers were already rejected by the external
build-dependency boundary. The installer now verifies transitive sources too.
Script-disabled installs first resolve a complete lockfile in a private native
execution domain. After checking that the requested manifest is unchanged, that
package paths stay inside the installation, and that the complete graph uses
registry sources, `npm ci --ignore-scripts` downloads it through a profile-owned
npm cache. Registry aliases and peer ranges remain supported. Git/local links,
Git dependency declarations including optional/peer declarations, and arbitrary
remote tarball sources produce a concrete refusal before shared-cache access.
Installs that run native lifecycle scripts retain their private cache. The
existing installation attempt budget spans both phases. Cache-corruption recovery
uses an independent private cache and leaves other owners' shared data intact.

The real native installer was measured on two fresh installation directories,
using the actual 20-package SDK closure followed by an overlapping 19-package
closure with React removed. Both sides used a fresh derived root. This is an
installer sharing experiment, not a panel or total-startup measurement.

| Native npm operation                | Private-cache control | Shared registry downloads |
| ----------------------------------- | --------------------: | ------------------------: |
| First install, empty download cache |              8,071 ms |                  9,145 ms |
| Second graph, empty node_modules    |              7,571 ms |                  6,533 ms |
| Combined two-install interval       |             15,641 ms |                 15,677 ms |

All 194 and 193 resolved package identities, versions, URLs, and integrity hashes
matched respectively. The first install pays for a separate resolution process;
the second benefits from shared downloads. These samples do not establish a
combined cold-start gain. Completed dependency trees remain independently keyed,
patched, verified, and reused through the existing immutable environment cache.
There is no new trust distinction between Base, Personal, and System.

### Desktop completion boundary and remaining costs

| Fresh application + empty derived/download caches | Native shell startup | Local launch → onboarding | Command → onboarding |
| ------------------------------------------------- | -------------------: | ------------------------: | -------------------: |
| Control                                           |            27,904 ms |                 70,515 ms |            78,308 ms |
| Candidate with consent fix                        |            30,758 ms |                137,512 ms |           145,312 ms |
| Additional candidate diagnostic                   |            29,326 ms |                 76,694 ms |            83,936 ms |
| Candidate including registry sharing              |            26,788 ms |                124,939 ms |           131,869 ms |

The control, consent-fixed candidate, and registry-sharing candidate passed the
complete desktop smoke. The additional diagnostic reached onboarding, then
failed the smoke's full-width New-panel assertion on a wider X11 viewport where
a half-width New pane was observed. It is retained as a failed complete
smoke, not counted as a pass. The final fixture used a bounded window width and
passed initial onboarding geometry, exactly one configured auto-submitted
conversation, separately opened New/history, launcher search, Enter-to-Help,
workspace icon decoding, clean renderer diagnostics, and owned cleanup.

The final empty-cache New open/history interval was 5,142 ms. It includes a real
first New build and native mounting, rather than only a warm renderer interaction.
The earlier warm New-panel observations remain applicable; this pass did not
change New's source or payload.

In the two instrumented desktop observations, submitted-prompt → visible setup
was approximately 17.2 and 78.3 seconds. In the latter, the Personal agent-worker
build finished at 33.1 seconds of server uptime, well before setup appeared.
Its native build profile was 12,039 ms versus 19,850 ms in the preceding diagnostic,
with environment acquisition 10,291 ms versus 16,824 ms. These observations locate
substantial remaining variance after worker compilation, but do not separate
model time from tool/workflow time. No reliable total-onboarding improvement is
claimed. Dependency resolution, first SDK/native installs, compiler validation,
semantic admission, and agent workflow/model latency remain measurable costs.

The focused original changes passed 138 tests. The installer changes passed 22
focused tests plus a real native C++ lifecycle test that confirms host-file access
is denied. The host commit gate checks types, lint, format, template hygiene,
documentation, authority, and dependency boundaries. The exact managed
`build-performance-profile` run before the download-cache addition passed in
104,068 ms with zero tool failures (`st_fd85018fe86143979a4e41b8ae8f8e6e`).
The final exact run after registry sharing also passed with zero failures and
zero tool failures in 117,357 ms (`st_f4d82654e22d4ad1b3cade43282fc4cb`),
after a successful managed doctor and native startup profile. The different
agent durations do not establish an inference speedup. Both instances were
stopped and their private scratch caches removed.

Bounded private evidence is retained under
`/home/werg/.cache/vibestudio-performance/2026-10-01-cold-critical/evidence`.
Each experiment's processes, connections, derived caches, npm scratch, temporary
state, and template checkpoints are retired before the next cold experiment.
Review/template worktrees are removed after integration. No owned profiling
instance is reported complete while still live, and unrelated instances remain
untouched.
