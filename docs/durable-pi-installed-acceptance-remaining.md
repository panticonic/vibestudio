# Durable Pi: installed acceptance still open

Status: 5 October 2026, through production checkpoint 105 and regression checkpoints 106–107 (published `.11`, native child and authoring acceptance). This inventory separates unresolved verdicts from tests with no completed acceptance run. It does not classify every failed verdict as a product defect. Private trajectories remain private.

The original 39-case failure inventory, all thirteen subsequently exercised workflows, and all fifteen authoring cases have passing installed receipts. Checkpoint 94 clears native image generation and task-management build/launch/debug. Checkpoint 96 clears browser click/evaluation, click profiling and panel optimization; checkpoint 97 also passes strict rebuild/reacquisition. Checkpoint 95 also clears panel state and workspace reload profiling. Android acceptance is complete. The explicitly lower-priority self-development/local-model cases remain unverified. Optional template composition acceptance is complete through checkpoint 100. Source-only repairs are not installed acceptance.

The shared checkout incorporates the concurrent 0.1.54 release without discarding pending source edits. Reconciliation passes the full build, commit gates, 99 host integration checks, 90 focused Base checks, and System-testing composition types. Fresh installed checkpoint 92 completes fourteen cases: seven passes, four failures, three errors, eight unexpected tool faults, 1,025.470 seconds. Its instance and desktop executor are retired, including both temporary roots. Source checks are not counted as installed acceptance.

## Expanded regression coverage — checkpoints 106–107

After the cutover commit `c0ad4d123` was pushed, three new installed scenarios
were added and accepted on fresh isolated instances:

- `eval-cell-local-imports-retained-handle`: `st_2190d3c8d1b141209eabc4d9d1f196bd`.
  Static imports stay cell-local; an explicitly retained imported function remains
  callable across turns, with one native kernel incarnation throughout.
- `eval-rejected-cell-preserves-live-scope`: `st_f7706ae3a52f46e4bcfad6be013bc7cd`.
  A deliberate guest exception preserves the original callable and counter for
  the next turn. Exactly one invocation increments the counter in each successful cell.
- `scratch-file-handle-survives-rename`: `st_b5e952a4c1984f0f9960b2f163d8b51e`.
  The retained descriptor and renamed path both read the updated bytes, followed
  by explicit close and scratch cleanup.

Each final run has one pass and zero failures, errors or unexpected tool faults.
The initial counter failure came from an ambiguous test instruction that caused
two increments per cell; the strict validator was retained and the instruction
clarified. The initial descriptor run exposed a live-help gap: it described the
raw RPC handle without the portable facade and still claimed idle expiry. Live
help now states the actual supported methods and `{ bytesRead, buffer }` return.
The test consults that public help instead of being supplied a bespoke implementation.

The expansion also exposed actual host lifecycle defects. Filesystem handles no
longer expire after five idle minutes. Admission tracks real runtime owners
separately from logical access keys, including both the extension and delegated
caller. Retirement at both IPC ends joins admitted operations before closing,
so a late open cannot escape cleanup. Failed closes retain ownership and report
the original error; another explicit retirement can resume cleanup. RPC and
worker retirement await cleanup, drain remaining resources, and propagate failures.
There is no cleanup timeout, background retry loop, or compatibility path.

Verification passes: all 337 focused host filesystem, RPC, runtime-cleanup, native
receiver, worker and schema tests; 70 scenario-validator tests; host/workerd and
System-testing composition types.
Validators reject invented success, reconstructed state, changed/missing kernel
identity, unrelated failures and stale descriptor content. Both managed instances
and their temporary roots are retired. Private failure trajectories remain private.
The suite expansion is committed and pushed as System-testing `be29725`.
The nine explicitly lower-priority self-development/local-model cases remain
unverified and are not counted as passing acceptance.

## Quickfire native consumer regression checkpoint — 10 October 2026

Quickfire now projects native tool invocations independently of turn IDs and
receives live model signals. Running native invocations keep Stop available;
model work is distinct from tool work and model failures remain visible. Channel
turn status follows explicit lifecycle events rather than being reactivated by
unrelated invocation/message traffic. Failed closed turns remain visible even
when no invocation was admitted. Native run turn IDs themselves are intentional
product lifecycle identities, not a remaining legacy execution engine.

Stop uses actual channel agent presence and awaits native cancellation. Dismissal
retains the shell-owned subscription/transcript, so reopening the same live panel
does not require another join. Panel destruction releases that binding. Reasoning
starts compact and collapsed; duplicate model/timestamp details are removed.
Session discovery no longer reads replay history for the resume chip or rewrites
launch-installed resource grants to retrofit older conversations.

Focused verification passes 306 tests across native lifecycle/publication,
protocol, chat merge, Quickfire session/projection/cards, owner and DOM behavior.
This is source verification, not fresh installed acceptance.

Native host profiling records warm finite resident lookup at 88–110 ms and join
at 309–337 ms, with first-use setup at 7,721 ms. A real chat renderer records warm
lookup at 411–784 ms and streaming subscription/replay at 833–1,353 ms with only
2–6 durable events. These are separate boundaries and must not be combined.
After the native consumer repairs, the same rendered boundary records lookup at
102–310 ms and streaming subscription/replay at 352–643 ms. These measurements
do not establish fresh-agent execution readiness or a completed cutover.

Shared agent initialization now returns a launch receipt only after history,
instructions, model policy and executable tools are committed. The native task
retains the original intent and owns bootstrap effects independently of the
opening RPC. Configuration preparation runs independent instruction/tool work
concurrently. Workspace instructions and skills are read together from one exact
semantic snapshot, with cancellation propagated to the owned RPC and invalidated
resource flights prevented from overwriting newer cache state.

Shared startup resolves one immutable executable for service and object binding.
Background worker preparation now admits schema evidence through the ordinary
activation gate rather than stopping after artifact construction. Durable Object
activation restores local state synchronously; network setup belongs to the
operation that uses it. Single and bulk semantic file reads share one state and
batched provenance resolution, preserving order, absence and repository ownership.
These changes apply to agent, worker and filesystem infrastructure generally.

Real provisioning exposed duplicate RPC ownership registries caused by mixed
source/compiled package resolution. Bundle owners now select one resolution
policy, and a build gate rejects mixed infrastructure module trees. Headless
panel-host calls and generated system-test checkpoint publication now use their
canonical receiver contracts.

With prepared worker executables, three fresh runtime entities record complete
initialization at 4,730–5,239 ms and retained lookup at 76–98 ms. Before batched
native provenance resolution, the same boundary measured 5,475–5,859 ms; prompt
resources fell from 1,711–1,756 ms to 1,033–1,081 ms. These are complete-readiness
measurements, replacing the earlier admission-only boundary that concealed a
further 2,100–2,197 ms configuration wait. Fresh startup still has substantial
remaining cost; these samples do not establish unprepared-artifact or rendered
first-response latency.

A subsequent CPU attribution found exception-based ArrayBuffer detection in the
shared RPC JSON encoder. Node and Node-compatible workerd now use a nonthrowing
internal-slot predicate; browser and control-worker detection retains its exact
cross-realm behavior. Tag-free envelopes also use native JSON parsing without a
property-by-property reviver. Focused comparisons record 77–92 ms versus under
1 ms per 10,000 ordinary brand checks, and 23–32 ms versus about 3 ms for a
519 KB tag-free JSON envelope. These are codec measurements, not per-agent
startup savings. The full RPC and related lifecycle set passes 349 tests.

Default workspace automation provisioning now admits independent member jobs
concurrently and joins admitted jobs before shared runtime teardown. Executable
transfer, decoding, registration, first activation, and host initialization
phases are logged separately. Native build profiles validate the agent and
channel with matching cache-repeat keys; a missing declared channel dependency
on its imported agent RPC contract is repaired without changing executable
artifact or source byte counts. Sealed source attribution and emitted artifacts
include lazy modules and are not initial-evaluation byte measurements.

Later fresh-entity samples with both codec changes record 5,882–11,957 ms and
retained lookup at 83–537 ms while other host investigations build and typecheck.
Prompt-resource preparation alone remains 1,536–2,831 ms. These busy-host samples
are retained for diagnosis and do not establish an end-to-end improvement over
the earlier isolated baseline. Fresh startup remains an open performance item;
artifact preparation does not guarantee that a new object's isolate is warm.
The later exact `turn-no-silent-stall-after-tool` canary passes with zero tool
failures (`st_f52d4752499b4a4aa19a97f3b55d9c19`, 28,924 ms) against the captured
source snapshot with the shared codec and provisioning changes.

Focused host/native/semantic/headless/checkpoint regressions pass. The isolated
full build, host and headless typechecks, Base composition and template hygiene
checks pass. The exact `turn-no-silent-stall-after-tool` run completes with one
pass and zero tool failures (`st_e0dbf88981244a1b92355c262ca3e0cc`, 30,586 ms),
including retained terminal checkpoint. This verifies the combined source
snapshot; it does not establish the remaining installed Pi acceptance matrix.

Owned profiling instances and their temporary roots are retired. Private bounded
logs, measurements and validation receipts are retained under the disk-backed
performance evidence directory; owned review worktrees and scratch caches are
removed after their workloads are joined.

## Android checkpoints 102–103 — acceptance complete

Fresh run `st_cc400c6f339b4d6caddb9364d34ec867` completes with one pass, one failure, zero errors and zero unexpected tool faults. `mobile-extension-install-android` passes, including the native source install. Onboarding installs and pairs the phone, but its public readiness remains `opening`; it is not accepted. The eval binding error from checkpoint 101 is absent after the cell-local binding contract was clarified.

The attempted account-pipe exposure change did not repair readiness. Review establishes that `phoneNativeEndpoint` is dispatched by the workspace host, while the account control server deliberately rejects workspace runtime relay. Presentation methods therefore belong to the System workspace connection; their original placement is restored and its account/workspace distinction is retained in the regression fixture. Fresh checkpoint 103 (`st_976b7e638a434a9d9c0b9f34e56f71c0`) passes Android onboarding: one pass, zero failures, errors or unexpected tool faults, 254.715 seconds. It exercises restored workspace routing, upstream mobile lifecycle changes and cancellable readiness observation together; it does not isolate one change as the cause. Phone setup observes actual readiness without an elapsed-time cutoff, preserves original RPC failures and cancels owned observation when its panel closes. Six focused helper/UI tests and all 465 mobile tests pass.

The earlier source APK packaging failure did not recur. Native command failures now join output streams, propagate bounded original diagnostics and request Gradle stack traces. Six focused native-service tests pass. The earlier opaque packaging exception has no established root cause; its successful subsequent install is evidence of current acceptance, not a proved explanation of that exception.

Real rendered chat verification passes with exact first and warm responses. Warm submit-to-completion measures 3,233 ms; the first measures 75,774 ms including credential approval and is not a cold latency baseline. CDP session closure, panel archival and CLI context removal complete. Checkpoint 101's desktop executor, managed instance, emulator and temporary AVD directory are retired. Checkpoint 102 is retired. Checkpoint 103’s emulator, desktop executor and temporary AVD are retired; its managed instance is also retired. Publication checkpoint 104 is also retired. Reviewed source is committed and pushed across host and templates. Base 0.3.62, Personal 0.3.57 and System 0.3.75 are published through the normal authoring flow and adopted by exact receipts. Production checkpoint 105 boots the published pins and passes real rendered first/follow-up chat without console errors (3,494 ms warm; 21,086 ms first including credential approval). Personal’s installed 0.3.57 pin and onboarding startup configuration are also verified. All owned publication/production instances, executors, CLI contexts and temporary roots are retired. The release-pin commit and expanded tricky-case coverage follow this completed cutover checkpoint.

## Current checkpoint and next verification

Checkpoint 95 (`st_4908c1f84c0746f19bb478c1d19fa398`) completes six
cases: two passes, one failure and three errors. Panel state and workspace reload
profiling pass. Rebuild executes cleanly but its validator rejects a separate
DOM read after a dispatched click. The native CDP client now journals those
completed locator reads, and validation accepts that evidence without requiring
an assertion embedded inside `click()`.

Browser click/evaluation and click profiling author raw data URLs containing
`#`; live native DOM snapshots prove the delivered documents lose the button or
handler. Both operations were explicitly interrupted with original failure
evidence retained. The browser automation guide actually read by the agent and
the performance guide now put an encoded disposable-page example near the
relevant workflow. The last optimization attempt retains a live provider
request with no terminal failure; the diagnostic run was explicitly cancelled
to apply the next source checkpoint. This remains interrupted acceptance, not
a provider failure or a manufactured timeout verdict.

Host transport ownership is also repaired: each workerd endpoint has its own
pool, and retiring one process cannot close another workspace's requests. A
real two-endpoint regression verifies isolated retirement, original error
propagation and fresh pools for subsequent generations. This fixes a concrete
ownership defect without claiming it explains checkpoint 94's ambiguous socket.
That fault does not recur in checkpoint 95's clean rebuild execution.

The managed instance, executor and diagnostic session are retired, including
both temporary roots. All failure packets and required deeper evidence are
retained privately. Latest source checks pass: 146 Base tests, 65 validator
tests, 113 host lifecycle/dispatch tests, host/Workerd and Base/System-testing
types, documentation gates and checkout hygiene. The real Workerd fixture
consumes its control request bodies before responding and rejects every
unexpected uncaught diagnostic. Fresh acceptance remains required for rebuild,
browser click/evaluation, browser click profiling and optimization.

Broader source verification covers all 639 Base agentic-core, agentic-do and
agent-worker tests. The only stale fixture omitted the now-required module list
in its typed build receipt; its focused repair passes. The full host run covers
7,951 tests (7,929 pass, 20 skip, two fixture/build-contract failures subsequently
repaired). All 51 tests in the affected files now pass, and the complete commit
gates pass. Exact source permissions remain enforced independently of the test
caller's umask. Svelte declaration freshness is checked before the host build and
in commit gates, while package compilation retains the standard build profile.

Checkpoint 96 (`st_60510103c54c4759a3fbfbabbfd5ed29`) completes four cases:
three pass, one fails, zero errors or unexpected tool faults, 401.427 seconds.
Browser click/evaluation, browser click profiling and panel optimization pass.
The rebuild case proves a real changed panel generation and working improved
controls, but it first acquires its automation session after editing. Its prompt
never requested the pre-edit interaction and retained session required by the
validator. The request now explicitly exercises that lifecycle; the strict native
replacement and interaction checks remain unchanged. Fresh acceptance is still
required for that focused case. All exact failure evidence is retained privately;
the instance, executor and both scratch roots are retired.

Checkpoint 97 (`st_61346cf38c794acc92767a848e92e731`) exercises the ordinary
Personal-plus-Examples composition: six passes, two failures, one error, one
unexpected tool fault, 1,139.378 seconds. Rebuild/reacquisition, browser import
lifecycle and all four adventure cases pass. Opening onboarding rejects the
documented empty props; its validator now checks the completed native card
acknowledgement instead of an unrequested final-response sentinel. Stable routing
exposes an undeclared `interaction` variable in client code; the guide now
requires copying the complete supplied metadata object into client evaluation.
The stable-target check remains strict. Svelte scaffolding reaches a genuine
panel-state operation absent from the test policy; panel scaffold cases now carry
the existing constrained panel-control authority and scheduler resource.
All failure packets and deeper evidence are retained privately. The instance,
executor and both temporary roots are retired. The owned composition worktree
remains only for the immediate focused repair checkpoint.

Remote repository release 0.1.55 and newer Base changes require reconciliation
before publication. Private review checkpoints preserve all pending source and
merge the release without restoring retired execution owners. Canonical
publication returns the original sealed committed fact; transcript projection
failure is reported through the existing client error lifecycle rather than
turning an accepted mutation into a failed send. Joined subscription retirement
and upstream connection/ready regressions are retained. The complete commit
gates pass on the reconciled 0.1.55 host. All 1,875 tests across the affected Base
chat, harness, native agent, pubsub, CDP and worker packages pass, as do Base,
System-testing and Personal-plus-Examples composition typechecks. The 55 focused
validator checks pass. These are source checks, not a published cutover.

Checkpoint 98 (`st_abf8cfc2ff564ab48c2b41dc73d6a7d2`) completes five cases:
two passes, three failures, zero errors, two unexpected tool faults, 450.494
seconds. Svelte scaffolding and bounded channel inspection pass. The instance,
executor and their scratch roots are retired. Its two onboarding verdicts
expose a validator selection defect: each transcript contains a raw transport
response followed by the canonical native invocation, but the validators select
the first record. Both canonical invocations completed successfully with matching
stable IDs and exact receiver acknowledgements. Source now selects the native
record; regression fixtures include both records in the observed order. Fresh
installed verification of that selection repair is still required.

Subagent follow-up exposes an actual cold-owner inspection defect. The parent
checks retained children through `readSubagentExecutionActivity`; the child
conversation lookup assumes an already-open Session. A reactivated completed
child has committed state but no admitted heap Session. Retained conversation
lookup now opens and validates that same native owner before reading, without
creating input or scheduling a turn, while using an existing Session during
settlement. Two cold-admission regressions verify unchanged tasks/submissions
and original admission-error propagation. All 27 focused child/suspension tests
pass. Wider owner checks and fresh installed follow-up acceptance remain pending.

Checkpoint 99 (`st_cb9f1b45ead849ceb720407179c4f815`) completes three cases:
two passes, one failure, zero errors or unexpected tool faults, 174.962 seconds.
Onboarding opening and strict same-collaborator follow-up pass. Stable routing
exposes a true preservation gap: public UI selection metadata is retained in
product input provenance but absent from the model's input content. The agent
explicitly reports that it cannot see the selection. Source now renders only
`source`, `kind`, `action` and `targetId` from that same admitted message into
native model history; it excludes transport controls and authority metadata.
Exact-selection, private-field exclusion, ordinary text and malformed-selection
regressions are being checked. Fresh installed routing acceptance remains open.
All evidence is retained privately; the exact checkpoint-99 instance is retired.

### Historical checkpoint 94

Checkpoint 94 (`st_3423758b5f0943f18860cdad72cd57de`) completes eight cases:
two passes, five failures and one error, with two unexpected tool faults.
`native-imagegen-save-read` and `task-management-build-launch-debug` pass.
All failure packets and required deeper trajectories are retained privately.
The owned executor and managed instance are stopped and both scratch roots are absent.

The six remaining verdicts are:

- Rebuild/reacquire: initial skill loading encounters an ambiguous closed local
  `GadWorkspaceDO.vcsReadFile` dispatch socket. The process remains alive; a
  separate alarm release rejection escapes the shipped Base asynchronous error
  boundary. The latter is repaired and covered by real Workerd retirement plus
  alarm/lifecycle regression tests; the original socket failure needs focused investigation.
- Browser click/evaluate: native click, screenshot inspection and evaluated value
  `1` all complete cleanly. The validator omitted numeric/boolean page values;
  exact token matching and negative substring cases now cover them.
- Panel state and workspace reload profiling: canonical examples select
  Personal-only panels absent from the Base composition. Examples now use the
  portable Base `about/new` panel; genuine failed calls remain failed verdicts.
- Browser click profiling: actual bounded profiling succeeds with final state
  `On`; old validation requires literal `State: clicked` and “elapsed.” The
  existing native operation journal now records bounded completed profile
  aggregates and the enclosing click boundary; validation checks that evidence.
- Panel optimization: native initial payload falls from 1,599,181 to 1,598,861
  bytes; the complete three-application commit supplies matching clean-state
  proof. Validation now accepts that atomic receipt without an unnecessary
  additional status call, while retaining exact context/event/chain checks.

Focused source checks pass: 51 System-testing validator tests, 62 Base boundary
and CDP tests, the real native Workerd alarm retirement test, both composition
typechecks, build contracts and checkout hygiene. Fresh installed acceptance is
still required for the repaired verdicts.

### Historical checkpoint 93

Checkpoint 93 (`st_510089ad2e0a4cc19d51fb41c7da0747`) completes seven exact
cases: two passes, two failures and three errors. Image-panel generation,
durable reopening and reference editing pass. Live/retained console inspection
passes. The managed instance and desktop executor are stopped and both scratch
roots are absent; all exact failure packets were captured before retirement.

The five open verdicts have distinct evidence:

- `native-imagegen-save-read`: image generation and the native image read
  complete, but model continuation fails with `fetch failed`. Four provider
  errors remain errors. Cleanup is now clean; the socket lifecycle repair is
  confirmed without claiming the provider transport problem is solved.
- `panel-rebuild-reacquire-and-interact`: ambiguous `Count` label matching and
  an unchanged-visible-output postcondition cause three genuine CDP faults.
  Guidance now requires exact labels and actual changed outcomes. The validator
  now verifies native initial/replacement generation receipts, exact previous
  lease identity, changed build/runtime/attempt, source editing, and subsequent
  interaction; it no longer requires particular method names or guest summaries.
- `cdp-page-click-type-evaluate`: unescaped `#` in an authored data URL truncates
  the script; a success-only predicate cannot settle. Explicit interruption is
  recorded. Harness retirement then reaches a real context-boundary approval,
  and the runner deadline remains an error. Browser creation now establishes
  lifecycle ownership through the existing `runtime.createContext` contract;
  it does not widen test authority. Encoded document URLs are documented.
- `panel-stateargs-cdp-roundtrip`: state changes from `{}` to `{ "launch": "x" }`
  and is observed through `stateArgs.get()`, with no tool faults or cleanup errors.
  The old validator incorrectly demands “snapshot.” Its replacement requires
  executed inspection and a completed native state-mutation receipt.
- `task-management-build-launch-debug`: the authored application builds and
  opens; a locator asks for `searchbox` while its input has ordinary textbox
  semantics. The exact DOM, tool request and explicit interruption are retained;
  the verdict is an error and cleanup is clean. Role-selection guidance now
  distinguishes an accessible label from a control's actual role.

Latest source checks pass 35 System-testing validator tests, 49 Base panel-runtime
tests, the full host build and host/Workerd typechecks. Further host integration
and composition checks, then fresh installed acceptance, are required. None of
these source repairs retroactively changes a failed installed verdict.

## Latest broad-run unresolved failures/errors (2)

Checkpoint 81 (`st_74d2020a16c743a7b4e77b14d9a22c79`) freshly passes pregranted-only authority, compact provenance orientation, automatic conversation naming, worker fork preview and same-turn infrastructure-error recovery on the default route: five passes, zero failures/errors/tool faults. These close the corresponding checkpoint-80 failures at that checkpoint. Checkpoint 82 (`st_1f04fdf1847f40e6a46418ec0d0aa82b`) completes 17 cases: six passes, eleven failures, zero errors and three tool faults. RPC catalog mismatch, app triage, extension risk planning and operating-policy probes freshly pass. Pregranted-only reopens after an invented `authority.permissions` call, although the canonical denial itself passes. Extension listing still does not verify declared availability through the registry. Documentation and GAD probes remain under evidence-directed repair. Android acceptance still needs an owned device/emulator; no device is currently attached. Disk space has improved after owned cleanup and a change in external disk use.

Checkpoint 83 (`st_71e13e6b25ce4d31ba01502ad85ec35b`) completes eleven affected cases: eight pass, three fail, zero errors or unexpected tool faults. Imports, permission inventory, membership, presence, version inspection, pregranted-only authority and both policy/GAD explanation probes pass. Automation and workspace settings failures are validator mismatches under repair; extension availability still needs a registry-backed answer. A separate installed CLI proof imports `lodash-es@4.17.21`, obtains sum 6, verifies reflection and verifies dynamic code generation remains blocked. The owned session and instance are retired.

- `onboarding-desktop-mobile-install-android`
- `mobile-extension-install-android`

Checkpoint 84 (`st_e31e5c2c1d174476808817373e8fe713`) completes 29 cases: six pass, 21 fail, two error, three unexpected tool faults. Default-route passes clear automation overview, workspace settings, both question-shaped provenance cases, native automation launch and cautious phone readiness. Android installation, pairing and public workspace readiness completed; the two explicit-install verdicts still fail obsolete call-sequence/exact-package-prose constraints and await repaired installed acceptance. The screenshot case exposed a real UTF-8/base64 attachment defect. All captured evidence is private; its managed instance, desktop executor and owned emulator/AVD have been retired.

Source repairs now cover canonical extension projection, native child permission-reuse evidence, public merge/origin receipts, import intent, provenance reference continuation, image bytes, nested runtime discovery, credential-miss observation and controlled semantic command probes. Focused tests and Base/System-testing/host/Workerd typechecks pass. Checkpoint 85 (`st_dc72f63b5fa742a1b80c40eaec959ce9`) completes 13 cases: six pass, five fail, two error, two unexpected tool faults. Extension listing, stale-basis recovery, command replay, honest import boundaries, workspace guidance and panel-tree navigation pass. Its instance and desktop executor are retired. The remaining cases are under investigation rather than accepted: child permission reuse encountered a closed dispatch socket and inactive authority-parent errors; browser capture exposed workspace-only snapshot dispatch; originating-request recovery abbreviated external-client request prose; credential, integration and unit-health verdicts exposed punctuation, phase-ordering and guest-summary dependence; the roster answer was not backed by a live read.

Subsequent source repairs preserve causal request prose independently of sender classification, order multi-session integration evidence by actual phases, record native bounded health counts independently of guest summaries, and capture browser DOM snapshots through the native page with generation evidence. Focused regressions and typechecks pass at the recorded checkpoints. Checkpoints 86 and 87 retain subsequent installed results below. No source-only repair is counted as installed success.

## Retired obsolete scenario (1)

`gad-branch-file-diff-probe` required removed GAD source-file/SQL interfaces and guest-manufactured `branchFiles`, `stateProbe` and `controlledErrors` summaries. GAD owns trajectory/channel diagnostics; managed file history belongs to semantic VCS. This is retired rather than counted as a pass. Current GAD integrity and semantic VCS scenarios remain installed.

## Interrupted acceptance

- `panel-performance-optimize`: explicitly cancelled while its provider operation had no authoritative terminal outcome. This is unverified performance acceptance, not an established provider failure.
- `task-management-build-launch-debug`: checkpoint 90 was explicitly interrupted
  after proving a hidden-option locator wait. Its fixture cleanup also hit the
  missing protected-ref publication grant; that grant is now repaired in source.
  Fresh acceptance and successful fixture cleanup remain required.

## Earlier checkpoint-34 failures (cleared)

All 39 earlier failures have subsequent default-route passing receipts.
`vcs-revert-preserves-history` closes the last one at checkpoint 89; the
historical checkpoints below retain the investigation evidence.

## Browser/image checkpoint 92 requiring repaired acceptance (6)

- `native-imagegen-save-read`: generation and exact file read complete, but a model socket error poisons owner cleanup after the provider completes its HTTP fallback. Source retirement now distinguishes an original provider failure from failure to release a resource already proven closed.
- `image-panel-live-generation`: initial generation and durable reopen complete; reference generation reports `fetch failed`. Fresh bounded failure evidence is required if this recurs.
- `panel-rebuild-reacquire-and-interact`: failed verdict remains open; obtain its exact bounded packet at the next run before instance retirement.
- `cdp-page-click-type-evaluate`: unsupported `page.setContent()` call; canonical native-page authoring guidance is corrected. No API alias or fault exemption is added.
- `cdp-page-console-dom-inspection`: actual empty document and live/retained console reads succeed; validator rejected the wording rather than the observation. Synonyms now preserve the same executed-evidence requirement.
- `panel-stateargs-cdp-roundtrip`: the existing blanket 15-second channel replay deadline aborts active initialization. Readiness now follows actual completion, original failure or explicit cancellation rather than elapsed time.

## Previously unstarted cases (now exercised at checkpoint 94)

- `workspace-panel-reload-performance-profile`
- `cdp-page-performance-profile`

## Supported compositions: cleared through checkpoint 103

Checkpoint 97 passes `browser-import-panel-lifecycle`, `adventure-campaign-play`,
`adventure-turn-profile`, `adventure-ui-review` and
`adventure-programmed-interaction`. Checkpoint 98 passes Svelte scaffolding and bounded channel inspection;
checkpoint 99 passes onboarding opening and same-collaborator follow-up.
Checkpoint 100 (`st_ddcbe4029cdf4f16bb6687e9d09c807c`) passes stable-ID routing
with zero errors or unexpected tool faults, 31.179 seconds. This verifies the
public selection fields now reach the model and the exact request receives its
native client acknowledgement. All previously open composition verdicts are
cleared. This synthetic routing test establishes the handoff contract, not a
completed external account sign-in. The private composition worktree, links and final
managed instance are retired; all owned scratch roots are absent.

## Lower-priority self-development/local-model acceptance (9)

These remain unverified; their priority was explicitly reduced by the user.

- `self-development-current-client`
- `self-development-isolated-host`
- `self-development-dirty-semantic-state`
- `self-development-native-checkpoint`
- `self-development-build-failure-recovery`
- `self-development-child-eval`
- `self-development-child-approval`
- `self-development-owned-cleanup`
- `local-model-download-and-task`

Suite expansion followed the committed and pushed cutover. Three additional installed scenarios now pass; see checkpoints 106–107 above. These nine lower-priority cases remain separate from that completed regression work.

Checkpoint 86 isolates child task-grant reuse (`st_acb1310a598b46ada94f37d617bffc48`): the parent and child perform native log reads under the same task grant, with zero tool faults or lifecycle errors, but the old validator requires stats instead of accepting canonical query/tail evidence. The source validator now uses native read receipts. Its seven-case repair checkpoint (`st_77340079c4a34f5d851adf767413e914`) passes integration, browser navigation, originating-request recovery and both notification scenarios; credential resolution and unit-health reporting still fail. Credential lookup reconstructed audience matching from inventory metadata; canonical resolver guidance is clarified. Health inspection proves native zero buffer counts, while ordinary shared-quantifier prose was rejected. Follow-up source regressions pass.

Checkpoint 86's instance is stopped. Executor retirement reported an unrelated incomplete process identity during a global process scan; group inspection now requires only membership facts, while exact leader identity remains strict. Native ownership regressions pass, and the retained executor scratch directory is removed only after verifying no process references it. No owned checkpoint-86 process or scratch root remains live.

Checkpoint 87 (`st_a7cf6bc4ad414dc99e709d79bea0fd77`) completes eleven cases: eight passes, three failures, zero errors or unexpected tool faults, 567.111 seconds. Fresh passes cover canonical credential resolution, live roster, ranked memory recall, sizable edited-file context, edited-import boundaries, reusable template authoring, rejection-history review and native bounded browser capture. Its exact instance and desktop executor are stopped and their scratch roots retired without cleanup errors.

The permission case exposes a retained-provenance lifetime defect: original-input context was in a task document, which Pi retires on settlement. It now uses a retained session family alongside native task/submission records; execution ownership stays native. Thirty-five focused model-evidence, policy, automation and invocation checks pass, including cold restored original-input evidence and actual tool handover. Diagnostics used logs alone and mistakenly inferred absence from a separate error buffer that logs does not return; canonical method descriptions now distinguish logs from the full health packet. Revert completes correctly with restored bytes and the exact recorded counteraction; its validator incorrectly compares opaque references with semantic identities. It now joins the recorded native revert request to its canonical relationship and rejects unrelated targets. Sixteen subagent-evidence/VCS validator checks pass. These three source repairs still need fresh installed acceptance. The earlier ambiguous inactive-parent/closed-socket failure has not recurred across either follow-up checkpoint; its underlying cause is not asserted solved.

Checkpoint 88's exact repair run (`st_325dfe861d4b4d81a41bd4f51026196e`) passes native settled child task-grant reuse and bounded unit diagnostics, but the default-route revert case fails with one unexpected tool fault. The agent invents a change identity by replacing a commit-event prefix, then successfully recovers through provenance; it does not retain the final exact read needed by the verdict. This fault is not waived. An unchanged stronger-model diagnostic (`st_cb4113e9f7e64e30a4e9c2a7942c8889`, openai-codex:gpt-6-sol/high) passes with zero faults, confirming canonical operation and proof availability. The revert argument schema now states its actual subject contract explicitly: reuse an issued change selector verbatim; other subject identities are not change identities. Default-route acceptance remains open. Thirteen previously unrun build/authoring/subagent workflows are next; counts change only after completion. Checkpoint 88 remains owned and live during this work.

## Newly exercised workflows requiring repaired acceptance (4)

Checkpoint 88's thirteen-case workflow run (`st_849079dc7e144de486e3cfc1a16c6700`) completes nine passes, four failures, zero errors, and two classified unexpected tool faults in 1,134.675 seconds. Passed receipts cover package build, native worker test, browser panel test, atomic patch/build, child diff inspection, app edit/test/build, unified matching provenance, stale edit recovery and workspace change-loop guidance. The thirteen names leave the never-started inventory; these four failures remain open:

- `subagent-followup-after-report`: two genuine pre-merge reviews are followed by an extra post-merge inspection, which the validator mistakes for the second review. Review phases are now distinguished, and premature integration is rejected.
- `subagent-reviewed-merge`: product guidance permits direct merge after the child report, but the validator demands a separate diff preflight. Canonical non-empty merge receipts and complete semantic resolution now establish integration; deliberate unintegrated comparison still requires a diff.
- `extension-edit-test-build`: source repair, test and build succeed; an unnecessary platform-report draft misclassifies an authored-code defect and invents a file-reference kind. Reporting guidance now explicitly preserves the authored-code/platform distinction and explicit reporting requests.
- `failed-build-bounded-diagnostics`: the intended 55-error build, bounded 40-error receipt and later clean repair all succeed. The classifier overlooks canonical agent-tool-failure.v1.code. It now validates that complete failure schema before extracting its code; incomplete objects cannot waive errors.

Focused runner/classifier/orchestration checks pass 52 tests, with a final 41-check runner/orchestration pass including malformed-failure rejection. Base VCS, verification and prompt checks pass 47. Checkpoint 88 is fully retired, including its desktop executor and both owned scratch roots. Fresh source verification continues at checkpoint 89; these source repairs are not installed passes yet.

## Checkpoint 89 and exact collaborator references

Checkpoint 89 (`st_7de54e59300249f9a81c98e327427be7`) completes five cases: four passes, one failure, zero errors, and four unexpected tool faults in 554.015 seconds. Default-route revert now passes, closing the older 39-case failure inventory. Direct reviewed merge, extension edit/test/build and bounded failed-build diagnostics also pass. The only remaining failure from the thirteen newly exercised workflows is `subagent-followup-after-report`: its task outcome succeeds, but the agent drops a character from the long native run ID and mixes commit hashes into that identity. Those faults remain failures; they are not waived as recovery.

The replacement addressing contract derives a compact exact `@s<base36 native launch task>` selector from the existing supervisor row. Native execution, authority, receipt and task-card identities remain unchanged. References are retained with the collaborator, without an evicting alias cache or separate execution owner. Both supervision and notify use exact issued selectors; abbreviated/fuzzy matching is removed. Resolution enforces the owning parent conversation for short and canonical identities. Fresh-state storage gains the native launch task coordinate; no existing-state migration is introduced.

Focused Base checks pass 121 tests and the Base composition typecheck; System-testing composition typecheck passes. Cold retained-reference, unrelated-launch, identity-collision and foreign-conversation checks are included. Obsolete tests for the removed text artifact cache retire with that helper; native binary/base64 artifact coverage remains. Fresh installed reference acceptance is next. Checkpoint 89's exact instance and desktop executor are stopped and both owned scratch roots are absent.

Checkpoint 90 (`st_55acad1a6ef247b2848390b341ed4080`) passes all four affected native child workflows: follow-up after report, reviewed merge, unintegrated diff inspection, and retained task-grant reuse. Zero errors or unexpected tool faults; 450.427 seconds. This closes the remaining newly exercised workflow failure. Fifteen outstanding authoring/scaffold cases are now running on the same healthy instance, with suite-managed concurrency two and no competing host builds. The exact instance and desktop executor remain owned during this run.

Checkpoint 90 authoring investigation (`st_f8e8281e2cba47fdbebeeb4a9671ab79`)
is still running. New failures remain open until a fresh installed checkpoint:

- Creation and curated-icon goals did not explicitly request publication while
  their validators require it; the existing goals now request publication.
- Created worker observation incorrectly assumes a preseeded fixture basename.
  Source repair derives exact repository ownership from native committed task
  lineage before cleanup, retaining the same creation-scope proof.
- Worker testbench used its generic operation parent as a panel-slot parent.
  Source repair delegates structural ownership to the normal host resolver.
- Scaffolds falsely advertised suites without authored test files; agentic
  starters also selected the wrong backend for their generated native test.
  Suite declarations now follow authored source and exact execution realm.
- Atomic fixture publication lacked `workspace.publish` at the protected-ref
  host boundary. Source repair grants only immutable fixture publication resources
  alongside the existing semantic publication grant; repo deletion stays separate.
- To-do preparation confused the connected-app authority envelope with a unit
  manifest. Canonical standalone examples now show the distinct unit schema.
  Unexpected schema faults are retained as failures.
- Task-management hung in an agent-authored exact text wait: the matched node
  was a hidden select option, while the visible heading includes a count.
  Read-only DOM and native operation evidence were retained. The operator
  explicitly interrupted that owned channel; native cancellation joined the
  operation and the batch continued. This is an interrupted test, not a pass.
  Locator documentation now explains document order, hidden matches and scoped
  role selection. No production timeout or locator-semantic exception was added.

These source repairs have not yet run focused checks: competing host builds are
excluded while the installed agentic batch runs. Fork dry-run authority and all
new authoring failures remain subject to default-route acceptance.

Authoring checkpoint 90 completes fifteen cases: five passes, four failures,
six errors, eight unexpected tool faults, 3,387.399 seconds. Fresh passes are
`commit-existing-project`, React panel, package, skill and content preflight.
The other ten cases remain open; the task-management error records an explicit
operator interruption after evidence capture. Icon recovery correctly reported
and recovered the intentional typo, then failed a missing panel-control test
policy; it now declares the standard panel automation authority/resource.
The managed instance, desktop executor and both temporary roots are retired.
Focused source tests pass (38 Base; 108 System-testing across five files, after
repairing fixture mocks and goal snapshots). Template typechecks are in progress.

Authoring checkpoint 90 source repairs now pass focused checks: 38 Base tests,
108 System-testing tests across five files (the three initially failing fixture/
goal snapshots were repaired), Base and System-testing composition typechecks,
and external-checkout hygiene. Installed acceptance remains open for ten cases;
a fresh checkpoint 91 is being provisioned from these source inputs. Five
already passing authoring cases are not repeated without affected behavior.

Fresh checkpoint 91 (`st_45176964760e48038b3a4d7f107a4de0`) is running the ten
outstanding authoring cases. Its doctor passes with 226 discovered tests, Base
and System-testing typechecks pass, and checkout hygiene passes. The owned
executor is attached. `panel-create-commit-open` freshly passes; nine authoring
verdicts still await this run. No competing host builds run during acceptance.

Checkpoint 91 freshly passes panel creation, curated-icon creation and worker
creation/publication (including canonical runtime observation). Fork remains
open: the agent guessed `source` rather than the typed `from` argument, recovered
and opened a working preview, but did not commit. The helper now validates path
arguments before string operations, canonical docs include the exact fork
request, and the goal explicitly requests publication. No alias or unexpected
fault exemption was added. These latest fork edits await focused checks and a
fresh installed instance after the current batch completes.

Atomic panel/store install clearance freshly passes at checkpoint 91. Task
management remains interrupted: this time an authored over-escaped validator
rejects a valid date, displays its error, and the agent waits only for the absent
success row. Exact source, UI, native tool and explicit interruption evidence are
retained. Canonical authoring/debug guidance now covers literal-source escaping
and terminal success-or-failure observation. No UI mutation, timer, production
locator exception, or passing receipt was manufactured. Fresh task-management
acceptance remains required after these documentation changes.

Checkpoint 91 (`st_45176964760e48038b3a4d7f107a4de0`) completes ten cases:
eight passes, one fork failure, one explicitly interrupted task-management error,
one unexpected tool fault, 1,683.867 seconds. Fresh passes cover panel creation,
curated icons, worker creation/publication, atomic panel/store install clearance,
To-Do debug/polish, both worker scaffold variants and invalid-icon recovery.
The instance, executor and exact scratch roots are retired. Latest fork checks
pass (27 Base tests, lifecycle goal checks and System-testing composition types).
Host commit checks also pass after regenerated documentation, one reviewed
native-resource residency classification, reporting-test cleanup propagation,
and canonical formatting. The thirteen unstarted browser/image cases and other
mobile/composition/performance inventories remain open.
