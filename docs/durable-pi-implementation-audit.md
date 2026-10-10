# Durable Pi implementation and affected-caller audit

Date: 2026-10-05. Scope: implementation toward the user-authorized product cutover.
This records completed boundaries and their limits. Product cutover is published
and verified on fresh production state; lower-priority acceptance remains unverified. See the [plan](durable-pi-migration-plan.md#17-current-implementation-outcome-and-cutover-scope),
[design](durable-pi-design-decisions.md), [ledger](durable-pi-behavior-ledger.md) and
native evidence (`evidence.json`, private verification evidence).

Cutover scope clarification: this remains a pre-release system. The product
starts with fresh state and requires no backward compatibility or migration of
any existing state. Historical upgrade/import proofs below record work already
done; they do not make that machinery a shipping requirement. Remove old-state
imports and compatibility code whose sole purpose is preserving pre-release
data. Recovery and retention of new-system work remain required; future
released-data upgrades are separate work. See the [cutover contract](durable-pi-migration-plan.md#131-no-compatibility-execution-path).

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

## Current acceptance boundary — 5 October 2026

The maintained fork `.11` is published and the product source uses Durable Pi.
All default browser/rebuild/profile/optimization repairs have installed passing
receipts. Personal-plus-Examples acceptance passes browser import, all four
adventure cases and Svelte scaffolding. The reconciled 0.1.55 host passes commit
gates; 1,875 affected Base chat/harness/native-owner/pubsub/CDP/worker tests and
Base, System-testing and composed Personal types pass.

Checkpoint 98 verifies bounded channel inspection and exposes a real cold-child
inspection defect during follow-up. Retained conversation lookup now initializes
and validates the same native Session before inspecting committed work; it does
not submit input or dispatch a turn. Focused cold-admission tests preserve task
and input state and original failure propagation. The two onboarding validators
now select canonical native invocations rather than preceding transport echoes;
the actual opening and stable-ID handoff already completed successfully. Checkpoint 99 clears
onboarding opening and same-collaborator follow-up with no tool faults. Routing
then exposes a separate preservation gap: public UI selection metadata is absent
from model content despite being retained in product provenance. The same native
input now includes only its four public selection fields; private transport and
authority metadata remain excluded. All 85 focused product intake, child and
settlement tests pass. Checkpoint 100 freshly passes stable-ID routing with no errors or tool faults;
all previously open Personal-plus-Examples verdicts are cleared.

Checkpoint 101 completes real rendered chat verification, with exact first and
warm responses and owned CDP/panel/context cleanup. Warm submit-to-completion
takes 3,233 ms; the first measurement includes credential approval and is not a
cold latency baseline. Checkpoint 102 passes the native Android source install.
Fresh checkpoint 103 (`st_976b7e638a434a9d9c0b9f34e56f71c0`) also passes Android
onboarding: one pass, zero failures, errors or unexpected tool faults, 254.715
seconds. Correct workspace-owned endpoint exposure, upstream mobile lifecycle
changes and cancellable readiness observation are verified together; this run
does not isolate one change as the cause. Phone setup no longer declares failure
merely because three minutes elapsed. It observes actual readiness, propagates
original RPC failures and joins cancellation when its panel closes. Six focused
helper/UI regressions and all 465 mobile tests pass. Native process diagnostics
preserve bounded original output and join output streams.

The reviewed source is committed and pushed: host `f1b4187c`, Base `7353fb64`,
System `bd5bb9a4`, System-testing `ac4db305`, Personal `d7114210`, Examples
`6f8c8259`, Google Workspace `0ee91451` and News `85f71c6e`. Complete host commit
gates pass. Review worktrees and Android executors/emulators are retired.
Canonical template publication and release-pin adoption are complete:
Base `v0.3.62` at `8d8e0377`, Personal `v0.3.57` at `9bfe0649` and System
`v0.3.75` at `0cb3f836`. Each went through the ordinary inspected/reviewed
publisher. Personal and System preserve all authored runtime configuration and
exactly their own repository inventories; neither ships the development-only
System-testing dependency. The host release artifact adopts the three verified
publication receipts. Production checkpoint 105 boots these exact pins and
passes real rendered first/follow-up chat responses without console errors.
Warm submit-to-completion takes 3,494 ms; the 21,086 ms first turn includes
credential approval and is not a cold latency baseline.
The production Personal workspace installs its exact published pin and retains
its onboarding startup configuration. Native panel/CDP cleanup, CLI session and
context retirement, desktop executor shutdown and server shutdown complete;
all owned publication/production temporary roots are absent. This completes the
product cutover boundary for the exercised workflows. Lower-priority unverified
cases remain separately recorded; they are not represented as passing tests.

Publication inspection also caught and repaired a preservation defect: authored
runtime configuration referencing inherited units was filtered out of releases.
Personal's onboarding `initPanels` remains declared while Base supplies the chat
panel. Projection distinguishes owned files from available units; regression
coverage checks retained startup arguments without copying inherited code.
Base tests and composition types pass. Base 0.3.61 remains immutable; 0.3.62
includes the fix and regenerated agent-facing contract. Exact Git pins now
reject ambiguous refs at admission, before workspace registration, using the
existing canonical-ref contract (77 focused host tests pass). Follow-up host
source `cc0e9b65` is committed and pushed with complete commit gates passing.
Self-development and local-model acceptance remain explicitly lower priority
and unverified. Expanded tricky-case coverage is accepted at checkpoints 106–107.
The [installed acceptance inventory](durable-pi-installed-acceptance-remaining.md)
records the exact remaining tests and evidence. Published fork packages and source
checks alone do not establish a published product cutover.

## Current cutover checkpoint

The maintained fork selectively adopts upstream 1.0.2 through `20038712`,
including the overnight provider conversation identity and sampling changes.
Source `6c440118` and tag `vibestudio-pi-0.99.2-vibestudio.11` are pushed.
All four `.11` archives are published; registry bytes, exact dependency closure,
ordinary installation, public imports and Harness commit/close are verified.
Product and 15 template manifests pin `.11`. Static fork checks pass; the
four library suites pass 1,273 AI, 995 Durable, 346 Chord and 15 telemetry cases.
The AI warning failures on the host's early Node 24 disappear under the available
Node 24.19 runtime without changing their assertions. The broader upstream
CLI/client/TUI run still exposes unrelated built-package, old `fd`, and native
clipboard compilation requirements; no overall upstream-monorepo pass is claimed.

Four permanent host checks pass against installed `.11`: actual protected
WebSocket completion and cancellation, joined alarm retirement after HTTP
disconnect, and larger-than-limit SQLite transcript/document retention across
process replacement. Their owned processes and scratch are retired. The 83
focused Base model/session checks and complete Base, System and System-testing
composition typechecks pass. The transport now consumes only provider/API/
endpoint routing identity; Pi owns model metadata and JSON persistence. This
removes the brittle manual test conversion that upstream's new sampling fields
exposed. The first focused runner reported a shutdown handle warning; an exact
rerun with the hanging-process reporter passes and exits cleanly, with no retained
handle reported. These are
library/product boundary checks, not completion of the outstanding installed
agentic acceptance catalog. Focused installed checkpoints through 79 now pass
exact authority and live service description against fresh `.11` source;
suite expansion still follows completion and push of the current work.

The latest broad installed selection (`st_c35648b9c76949b79c2b53a04d078746`)
was explicitly ended at a shared attribution repair checkpoint: 79 selected cases
completed, with 40 passing, 34 failing and five errors; 127 selected cases remained
untested. Nine lower-priority local-model/self-development cases and eight cases
requiring other template compositions remain separate. This is not a complete
catalog verdict. Failure evidence was retained privately and the owned instance
was stopped. Subsequent focused acceptance is recorded below.

The next checkpoint repairs the observed shared boundaries: native task
ownership derives from the authenticated runtime owner while retaining the
nonhuman initiating actor; continuing automation uses its original admitted
task without requiring a separate executor nonce; stateful tools run sequentially
within a Pi tool batch while explicitly parallel reads overlap. Canonical native
invocation starts publish the exact retained originating-input coordinates.
VCS memory, inspection, public queries and bidirectional causality use those
coordinates directly, including cross-channel inputs and visibility boundaries.
There is no synthetic native turn or old-state fallback. Strict causal validators
join the actual task, invocation, command and input identities and reject foreign
commands, owners and messages.

Worker fixtures now use the build contract's canonical package names. Prepared
builds recognize a transitive workspace source only through the owning installed
package's explicit dependency; undeclared ambient links remain rejected. Native
failure reporting retains aggregate invocation/storage causes, which Workerd's
uncaught-error headline alone had hidden. Focused host, template and validator
checks pass; broader checks exposed incomplete SQLite fixtures and an old
diagnostic assertion, whose exact repaired checks also pass. Fresh installed
retries remain required, including the captured image-read commit/cleanup failure
and browser orchestration stalls. No commit, push or new installed scenario is
claimed at this checkpoint. Suite expansion follows completion and push of the
existing work, as requested.

The fresh seven-case checkpoint (`st_ce95e07f86814e6380e370f3dad73920`)
was explicitly ended after an authoritative storage failure: one passed, five
failed and one errored. The move/copy case passes with sequential mutations.
Automation launch succeeds but its validator imposed unrequested execution
choices; continuing automation exposed a cold Session admission-order defect.
The exact retained originating input includes the fixture's resource context,
so the harness now records the actual submitted input for exact provenance joins.
Focused cold-admission and validator checks pass (15 and 67 cases respectively);
fresh installed retries remain pending. Extension typecheck reaches execution
but cannot resolve its declared Svelte type assets from the native job bundle.
Worker persistence reaches cleanup, where an undefined entity ID is an actual
unexpected tool failure. These are not accepted passes.

Native image read reveals the underlying `SQLITE_TOOBIG` commit failure, after
which the Session is correctly poisoned and incident/cleanup commits also fail.
The SQLite implementation now stores every JSON record and revision in bounded
UTF-8 BLOB chunks, with indexed metadata separate and all replacement, history
and reclamation in the same transaction. Reads hydrate an indexed selection in
one SQL statement without concatenating a large SQLite row or issuing a query
per payload. The new fresh-state baseline rejects pre-release inline storage;
it performs no state conversion. All 76 focused SQLite cases and the fork's
static checks pass. An actual Workerd probe persists a larger-than-limit image
record, replaces the process, reads exact model content and historical document
revisions, and commits further work. The installed `.9` package reproduces
`SQLITE_TOOBIG` in the permanent host regression; next-release installed
verification and the original image scenario remain pending. Both checkpoint
instances, the earlier client and all probe processes/scratch are retired.

The additional isolated upstream monorepo run passes all 992 durable cases, but
is not green overall: four AI model-catalog cases reject this Node version's
type-stripping startup warning, and separate CLI/client cases require built
packages or a newer host `fd`. Those failures are retained separately from the
four-library storage verification; no full-monorepo pass is claimed.

All four `.10` archives are now published and their exact-version registry
metadata, bytes, source digest and dependency closure verified. An ordinary
registry install outside both repositories and public Harness commit/close pass;
authentication/install scratch is retired. Product and 15 template manifests
pin that release. The permanent host regression now passes against the
published package, including a transcript record over 10 MB, exact model
content, historical revisions and successful work after process replacement.
The SQL.js native test adapters now accept the actual ArrayBuffer binding
contract; 75 focused Base/native cases and 14 host/schema/native cases pass.
The complete System-testing composition typecheck passes. The prior failed
projected checkpoint remains recorded; it is not a product Workerd failure.
Typechecker runtime assets still require a package-ownership-preserving repair:
externalizing all dependencies would collapse distinct compiler versions and
is not retained as the solution.

Fresh installed `native-imagegen-save-read`
(`st_73514842b4264f23af1039fcc2a4693b`) passes on `.10` in 78.1 seconds,
with zero tool failures, invocation errors or missing composition units.
This verifies the original image-read/Session-commit defect through the actual
hosted model, generated image and installed product path. It is one exact case,
not a full-catalog or whole-product release verdict.

Installed `automation-native-launch` also passes
(`st_dbc07cb1be4c4aa599436c41a291dce8`), in 22 seconds with zero tool failures.
The scheduled notification run (`st_97017f2b64284956ac8c1ff80e659390`)
completes two successful durable runs, two distinct owner notifications and
automation completion, without tool failures. Its reported failure is the generic
final-chat-report gate. The scheduled and watch proofs now explicitly use their
existing durable-outcome validators; those continue rejecting missing/failed
runs, wrong conversation routing, duplicate notifications and invitation leaks.
The new regression accepts complete durable outcomes without a final chat report.
All 55 focused automation-validator and runner cases pass; installed retries
remain pending.

Native typechecking now packages the compiler-owned declaration files as library
data rather than resolving implicit files beside a native job bundle. The exact
dependency version and license accompany the generated data, and the build
checks it against the installed compiler. A standalone bundled-artifact test
with no dependency tree, five Svelte cases, 25 other compiler/typechecker cases
and complete host/Workerd-program typechecks pass. Compiler versions retain their
separate dependency ownership. The provenance retry
(`st_109a70a3073f4af38313a34198297d1a`) encountered two push failures because
source exports changed before their infrastructure package was rebuilt; this is
an invalid mixed-build checkpoint, not acceptance. That build is repaired.
Checkpoint 26 and its temporary state are retired; checkpoint 27 must verify
these boundaries from fresh installed source.

Checkpoint 27 verifies scheduled notifications
(`st_b252cbbcc175491b93a4287abba2224a`, 145.7 seconds) and walkable VCS
causality/blame (`st_86cb90f8f6d340528c6f2f110422bab8`, 68.2 seconds), both
with zero failed tools. The installed typecheck retry
(`st_3b17069c6297470995eb5bc266d1cc20`) passes declaration initialization but
fails native executable resolution: a generated bundle has no compiler-package
directory, and the isolated workspace correctly does not inherit the host's
compiler environment. The native workspace owner now admits the installed
compiler executable and its adjacent standard libraries as immutable runtime
resources and supplies their exact path to its children. A real isolated bundled
job returns the expected type diagnostic without missing global types; both
native workspace integration cases and full host/Workerd-program types pass.
A fresh installed retry is still required.

The published `.10` fork source is committed and pushed at
[`8cd2bd42`](https://github.com/werg/pi-harness/commit/8cd2bd42dbde5cdf1586e7886e43cf4f8cd0549a),
with the release source tag `vibestudio-pi-0.99.2-vibestudio.10`.
All 2,234 recorded source input hashes match the published build receipt.
The [sanitized package receipt](durable-pi-package-release.json) records package
integrity, dependency closure and source identity without private trajectories.
This completes the fork-source push, not the product/template release or its
remaining acceptance checks.

Checkpoint 28 verifies worker persistence and owned cleanup
(`st_7aeec7bcb5464936a8325ff4a76de4e4`, 100.8 seconds), with zero failed
tools. Its diagnostics-service case (`st_2dfab359810146ee91348064804e564c`)
has zero failed tools but correctly fails: a successful candidate build does not
prove invocation of the installed service. The goal now explicitly requests
diagnostics from that service, without prescribing its RPC or tool sequence;
a regression rejects build receipts as substitute evidence. All 56 focused
semantic validator cases pass.

The browser case (`st_aec06bebcf774622be09c5721fdadcb5`) reaches the existing
600-second test deadline. Direct native-task inspection identifies its active
eval cell: a heading locator followed by navigation. A separate owned, rendered
document probe proves the current example.com page has no `h1`; CDP acquisition
and immediate evaluation both succeed. The test's assumed heading is therefore
invalid. Its two documents are now owned HTML data URLs through the ordinary
browser-panel path, with unchanged exact same-panel navigation requirements.
The 13 panel/tree checks, complete System-testing composition types and template
checkout hygiene pass; fresh installed browser and diagnostics-service retries
remain required. No new catalog scenario was added.

The deadline's generic failure packet omits the active agent history despite
actual model/tool work. Native task and Eval checkpoint evidence were captured
separately before retirement; this diagnostic gap remains an outstanding harness
repair. Cancellation settles the eval cell, but the cancelled orchestration's
headless cleanup calls encounter invalidated execution admission. Retain those
original cleanup errors rather than treating the deadline as product recovery.
Checkpoint 28's diagnostic panel/session, managed instance and temporary root
are retired. Product/template commits and pushes remain outstanding.

Checkpoint 29's owned-page browser test observes both headings and successful
same-panel navigation, but correctly fails on a preceding unexpected tool error
(`st_651568e129e743feb5b2e6f12973bb4a`). A synchronous lazy slot handle carries
an initial workspace hint; CDP had retained that hint after acquiring a real
browser generation. Both direct page and fenced-session acquisition now derive
navigation policy from the authoritative ready observation. Workspace navigation
restrictions remain enforced, including when the initial hint says browser.
All 91 affected CDP/handle/runtime checks and Base composition types pass across
the focused checkpoints. The initial incomplete unit mocks and their failures
remain recorded; they now provide actual slot/readiness and abort contracts.

Fresh installed `browser-panel` passes
(`st_aa29eb346a6c45fe9961b1e663bb1c5c`, 40.3 seconds) with zero failed
tools. The Typecheck Service goal first produced a build instead of an extension
call (`st_20bf8cd89bb54f06886323bbcad77073`), then the extension goal exposed
a guessed invalid identifier (`st_865dbf2d36074f1da470e6c945d7aac2`). Neither
is acceptance. The published invocation contract now explains canonical identity
discovery through `build.listUnits` and cold `onInvoke` activation. Workspace
guidance no longer recommends the removed `extensions.list` or rejects a cold
extension for lacking a running process. No guessed alias or invocation fallback
was introduced. A fresh installed retry remains required.

The deadline diagnostic defect is now repaired in the harness. Its existing
test-scoped deadline signals cancellation and joins the owned promise before
reporting failure, keeping the original eval admission valid through orchestration
cleanup. Agent observation and authoritative interruption also settle before the
turn exits. Failure capture retains the actual active orchestrated session without
transferring its cleanup ownership from the orchestrator. Forty focused runner/
panel tests, complete System-testing composition types, 44 docs/catalog checks,
infrastructure rebuild and template checkout hygiene pass. Existing timeout mocks
now implement the real cancellable observation contract; the regression holds
terminal reporting behind both orchestration finally and owned-session cleanup.
Checkpoints 29 and 30 and their temporary roots are retired. No new installed
catalog scenario was added; that phase follows completion and push.

Work resumed at the user's request on 2026-10-02 from the saved implementation
checkpoint, not completed product acceptance. Resume with the full installed
agentic catalog and current-source integration checks, remaining active-operation
cancellation/replacement proofs, native
performance evidence and immutable template/product publication. Local models
and self-development remain lower priority.

Current priority: normal hosted-provider chat, tool continuation, reconnect and
truthful shutdown take precedence. Local-model acceptance and self-development
coverage remain recorded at lower priority; they do not block work on ordinary
agent/chat behavior. No new subagent work is delegated; the root owns remaining
implementation and verification.

The resumed checkpoint repairs invalid extension candidate classification in
the existing unit registry. New or inactive declarations retain `status: error`
and the original manifest diagnostic; ordinary and provider invocation propagate
it as `ENOTREADY`. Invalid updates retain the approved running image and record
the rejected candidate's diagnostic. Correcting the source still follows normal
approval and activation. All 110 UnitHost/ExtensionHost cases and complete host
and Workerd-program typechecks pass. The
declaration receipt (`native-invalid-declaration12-evidence.json`, private verification evidence)
records the exact source, initial assertion failure and repaired checks. This
does not attest unresolvable graph nodes or the installed agentic catalog.

The fresh installed `post-tool-followup-turn` run
(`st_7d892b31fc1b49dd9c236c7abee09aa6`) passes doctor but fails before model
execution. Its canonical journal classifies the headless input client's verified
DO ID as an agent, despite `type: headless`; directed conversation policy then
correctly rejects the unaddressed agent message. The shared participant-role
derivation now recognizes programmatic input clients independently of runtime
principal identity. Wire and headless-session converters use that same
derivation. Canonical publisher regressions retain genuine agents' directed
addressing rules. The first correction used the human `user` role; the installed
retry (`st_5cdf6910034c429dba198797a4d11dbc`) admitted the input but correctly
refused model invocation because the DO sender was not a canonical human.
The final mapping uses the existing `external` nonhuman role, retains
`type: headless` and the exact DO ID, and leaves the human-authority verifier
unchanged. All 318 affected protocol/channel/native-chat cases, 51 headless-
session cases and 27 host attribution cases pass; the latter proves no human
authority is minted for programmatic input. Full host/Workerd-program,
Base/integration and System-testing types pass. Both failed instances and their
ephemeral roots are retired. The installed retry after the publication-order
repair below passes; neither role nor publication changes mint human authority. See the
role receipt (`native-headless-role12-evidence.json`, private verification evidence).

The final-role installed retry (`st_b7795e1cc0264be89b06d9c3dc002dd6`)
completes three hosted-model requests, the read-only tool and both genuine
assistant responses without invocation errors. It still fails acceptance:
the captured transcript sees the last model invocation as pending because the
answer is published before its matching terminal. The canonical journal later
contains the terminal; cleanup reports no errors. A gated native publication
regression reproduces that ordering failure. Invocation-terminal debt now
precedes same-commit assistant-answer debt in the existing ordered publication
chain, so the answer-acceptance barrier joins terminal acceptance as well.
All 31 publication/boundary/input-settlement cases pass, including delayed
acceptance and existing recovery/cancellation checks. The failed instance and
its root are retired. This is a publication-order repair, with no second queue,
observation delay or weakened validator. The fresh installed retry
(`st_030da8402788443d83777317575e7337`) passes in 14.9 seconds, with no failed
tools, invocation errors or cleanup failures. Complete Base/integration types
also pass. That instance and its root were subsequently retired after the exact runtime
and resilience cohort; see the
publication receipt (`native-publication-order12-evidence.json`, private verification evidence).

The affected installed runtime/resilience cohort
(`st_854fdcad942c4b4e91339573228ff2dd`) finishes with two passes and ten
failures. Normal tool completion and runtime VCS access pass. Canonical native
tool starts omit their committed arguments, while successful terminals expose
an internal journal entry instead of structured tool output. The producer now
retains exact execution arguments alongside the existing publication obligation,
checks their source digest, and publishes the committed content/details through
the existing protocol. All 33 affected publication/boundary/settlement cases and
complete Base/integration types pass; direct and model-originated tools are both
covered, including failure. Fresh installed retries of the ten failed cases are
pending at that source checkpoint. Its fresh retry
(`st_bfaefdec216c470e9605e6b83dd19ddf`) passes five of those ten cases, including
large returns, scoped test execution and atomic multi-file edit/build. Five
failures remain: explicit deadline discovery, linked validation rejection,
status metrics, bounded channel inspection and self debug inspection. All five
bounded packets and the three necessary full trajectories were captured before
that instance and its root were retired. Additional detailed packets for the
earlier run were requested after the ephemeral instance
had been retired, so only the original bounded packet and summary survive;
the accidentally reprovisioned diagnostic instance is also stopped and joined.
Keep the next instance live until all necessary diagnostic capture is complete.
See the tool projection receipt (`native-tool-projection12-evidence.json`, private verification evidence).

The next repair retains the physical invocation/transport identity in the
already-consumed native method receipt. Resilience validation counts one
causally linked tool execution rather than treating propagation to its owning
task as a second execution, while requiring all physical and native invocations
to settle. Both exact injected failure publications are declared intentional;
unrelated faults, mismatched requests and missing recovery still fail. The
deadline scenario now asks explicitly for its 100 ms deadline. The status
validator accepts the documented workspace-source `getStatus` call. Malformed
eval participant-method calls reject before JSON serialization or dispatch;
self-inspection and method-call help describe the current native contract.
All 72 affected native method/chat cases, 50 validator cases, full
Base/integration, System-testing/integration and host/Workerd-program types
pass. The installed retry (`st_539a3016f13e46d192df2ab3a46531c9`)
passes explicit deadline, linked validation recovery and self-debug inspection;
two cases remain. All failure packets and the necessary history trajectory were
captured before the instance and its root were retired. See the
recovery-contract receipt (`native-recovery-contract12-evidence.json`, private verification evidence).

The two remaining failures concern metrics validation and capability discovery.
The metrics answer correctly reported an observed value but the validator required
unnecessary phrasing. Acceptance now matches a reported metric/value pair against
the actual completed result; wrong names and values fail. Channel discovery
selected low-level delivery replay instead of the existing bounded inspector.
Catalog descriptions now explain that wrapper surfaces differ from backing-service
partitions, and replay documentation points to the bounded inspector. No search
filter or runtime routing changes. All 50 validator and 121 documentation/channel
cases, full Base and System-testing composition types, and checkout hygiene pass.
The fresh installed retry (`st_bc6a4d718431442bbf5e2c8430d9f212`) passes
both cases in 65.8 seconds with no unexpected tool failures; see the
discovery receipt (`native-discovery-evidence12-evidence.json`, private verification evidence).

The next installed lifecycle/delivery cohort
(`st_a15480e839d64946ab9c0fb240efda4b`) completes with eight passes, five
failures and three errors across sixteen cases. Replay, persistence, cancellation,
first connection and wake storage have distinct actual verdicts in the retained
packets; this is not a complete catalog run. All eight failure packets and full
trajectories were captured before retiring the exact instance and its root.
Failures expose absent-recipient substitution, an untargeted completed child
answer, truncated child identifiers, duplicate observation of one physical/native
execution, authority discovery/fixture assumptions and activation-pinned settlement
RPCs. Recipient guidance, retained supervisor addressing, canonical child IDs,
native activity counts and causal execution counting are repaired. The 173
unique affected Base cases pass across focused repairs, 37 validator cases pass,
and full Base/System-testing composition types and checkout hygiene pass.
The fresh three-case retry (`st_9829f6536fa7409da3797b62fc9343f6`) passes
transient claim recovery. Recipient behavior is now correct but its validator
omits the canonical error message. Child addressing wakes the parent, exposing
that suspension terminates the original input before a visible answer. Both
failure trajectories were captured before retiring the instance. See the
child/method receipt (`native-child-method12-evidence.json`, private verification evidence).

The next source checkpoint resumes a suspended native request at its post-tools
boundary and admits the child report as steering. A regression requires the
original input and report to settle to the same actual assistant answer.
Native invocation effects enter an owner-scoped async context on every outbound
call/peer/stream, retaining separately admitted provenance and cancellation;
they cannot borrow a transient inbound authority nonce. Receipt consumers and
request wake publication join before SQLite closes, repairing a deterministic
retirement race found by the focused checks. Messaging reads canonical refusal
messages and rejects any substitute audience. Authority scenarios now express
real constraints instead of pretending configured workspace grants are absent;
exact allowlists derive from the existing preflight contract. Restart probes
observe the same original input after acknowledged activation destruction,
without resubmitting work or retrying an invalidated RPC. All 78 Base, 90
session/validator, 60 RPC and 26 help/catalog cases, host/System-testing types,
the full host build and checkout hygiene pass. Fresh installed verification is
pending; see the
context/suspension receipt (`native-context-suspend12-evidence.json`, private verification evidence).

The seven-case installed retry (`st_9c36d28ae83e417b81907aadf3f58f3f`)
passes absent-recipient handling, steering a running child through the original
input's visible answer, and terminal delivery after vessel replacement. Exact
authority and preauthorization wait in failure state, pregranted denial fails
wire validation, and eval replay loses causal verification in a cold activation.
All four failure packets and required trajectories were captured before the
owned instance was stopped; the full catalog remains unverified.

Subsequent exact diagnostics preserve live packets and explicit cancellation
receipts. They show that host preauthorization **returns** the original empty-
allowlist refusal, discards its admission, and never waits for a human approval.
The actual Pi tool parks that thrown operational refusal in its failure
rendezvous, leaving the generation waiting. A confirmed structured refusal of
**the first eval admission** now becomes a failed tool result carrying the
original code and recovery data. A resumed or ambiguous admission may already
own work, so it retains the original failure and continuation for recovery or
cancellation. Protocol, transport, internal faults and cancellation also retain
Pi's actual lifecycle. The eval details type distinguishes an admission failure
from a genuine run result; no eval result receipt or successful admission is
manufactured. Full failure/cleanup behavior remains observable to the installed
validators.

The wire schema now derives every authority refusal/remediation discriminator
from the RPC contract, including review metadata, instead of maintaining a stale
copy. Omitted eval approval mode correctly means `prompt`, including exact
preauthorization. Preauthorization retains the owning signal; its regression
preserves the original cancellation error and frees the scope for a later run.
Service/method and allowlist constraints are documented at the tool boundary.
Causal inspection restores the same host-bound Session to read retained tasks;
a cold activation is not evidence of absent durable work. A regression verifies
the original pending tool before any wake opens its replacement and proves an
unknown lookup submits no tasks. Pi's reopen dispatches no new work.

At this checkpoint 83 affected Base cases and 59 host contract cases pass.
The final admission-details refinement also passes all 36 focused eval cases
and the full System-testing composition typecheck. Complete host/Worker types,
the current full host build and checkout hygiene pass at the preceding host
checkpoint. Installed authority/replay retries remain required. Diagnostic
probes have been removed. All diagnostic runs and instances were explicitly
cancelled/joined and stopped before provisioning that retry. These focused
counts overlap earlier baselines and are not a release total.

The four-case installed retry (`st_9bd24cc6116b4df4a7f075baa7cc0b1d`)
passes eval replay across activation replacement. The three authority cases now
finish with no session/cleanup errors, but still fail: conflicting empty
allowlists, a denial validator requiring a returned value, and a guessed
preauthorization method. All bounded packets/full trajectories are retained and
the instance/root are retired. Guidance now distinguishes a capability ceiling
from operation preparation; the general prompt permits discovery when the user
explicitly asks for an exact restriction or authorization before execution.

The denial validator requires the exact typed `run-manifest-denied` result for
`permissions.read` under an empty read-only pregranted-only allowlist. Exactly
one matching induced `ERUNMANIFEST` tool failure is declared; different scopes,
widened manifests and unrelated failures still fail. Permissions inventories
may use the actual bounded large-result contract. Preauthorization may prepare
one cell before executing in another; a read before preparation still fails.
All 50 affected validators, 42 harness guidance/eval cases and full composition
types pass. The next installed three-case run
(`st_302824b6dbfc4ea0967be0aa29b95b30`) passes the denial case with zero
unexpected tool failures and no cleanup errors. Exact authority still lacks its
requested access ceiling; preparation works but encounters an overly strict
validator condition added during this repair. That extra condition is removed,
while exact ceiling enforcement remains unchanged. Both needed trajectories
are retained; the exact instance and its root are retired.

The broader installed catalog checkpoint (`st_f390b2abf96d454a933ad3a831867c5e`)
selects 218 cases with a paired client executor. It is explicitly cancelled for
repair after 15 passes, ten failures and four errors; three active cases are
interrupted by that cancellation. This is not a complete suite verdict. Every
needed failure/cancellation packet and full trajectory is retained, and its
instance, client and owned scratch are stopped/joined and retired. Nine
lower-priority local-model/self-development cases remain explicitly deferred;
missing units remain untested composition coverage.

The actual agent completes model/tool work, but `getModelExecutionEvidence`
returns an activation-local `not-loaded` result after replacement. That retained-
truth endpoint now restores the same bound Session, while ordinary activation-
health inspection remains passive. An actual SQLite close/reopen regression
reproduces the old failure and proves the original model call is read without
another dispatch. All 110 affected owner/chat/model-evidence cases pass.

Other captured failures expose validators expecting private comparison graph
fields or unrequested ID/field formatting, and agent mistakes in scratch paths,
argument lists and runtime discovery. Acceptance now uses the current compact
compare receipt and exact canonical commit/publish joins; an explicitly named
wrong event still fails. Actual symlink mode and truthful empty-upstream
reporting are accepted without synthetic fields. Runtime package inspection
requires an actual load, and exact-authority wording states the restriction
rather than requesting API mechanics. Scratch/binding documentation addresses
the concrete mistakes. All 87 affected validators/helpers, 35 harness/producer
cases, complete composition types and checkout hygiene pass. The eleven-case
installed retry (`st_4e78e3d30ea7452da44c3c44c10adc42`) passes runtime package
loading, file metadata, file handles, local comparison and publication. Six
cases fail, with three unexpected tool errors; all sessions and cleanup finish
without errors. All six needed packets and trajectories are retained before
stopping the exact instance. Cold model-evidence reads work in this checkpoint.

The next repair selects the actual permissions read after deny-all discovery,
checks every cell's access ceiling, recognizes ordinary TypeScript receiver
assertions, and validates abbreviated display IDs against exact canonical
receipts. Incorrect references and widened access still fail. Git help lacked
schemas after moving execution out of the host dispatcher: its public runtime
catalog now derives from the canonical Git contract, and help renders positional
overloads faithfully. Authority field descriptions distinguish access restriction
from preparation without weakening an empty allowlist. Focused checks pass:
79 validators, 59 host catalog/help cases, 27 eval-tool cases, complete composition
and host types, generated-doc consistency and checkout hygiene. Installed retries
then run on the fresh source. The six-case installed retry
(`st_695dc2c2543240659b813f447aac4ad3`) passes Git discovery, symlinks and
whole-chain commit; the two authority cases retain four unexpected tool errors,
and status orientation rejects another valid natural report. All sessions and
cleanup complete, and all three needed trajectories are captured before retiring
the exact instance and root. The next repair preserves a method's declared
capability through service and generated-runtime catalog serialization and renders
it in service docs; argument-dependent resource keys still come from real
preflight. Status validation accepts a factual shared-main report while rejecting
contradictory relation claims. All 72 affected host discovery cases, 14 Base docs
cases, six VCS cases and composition/host/Worker types pass. The next installed
three-case retry (`st_86622049fd7740e3b411cc03134930c6`) passes status orientation,
records no unexpected tool errors, and completes all sessions/cleanup. Both
authority validators fail. Retained replay identifies a preauthorization validator
comparing object identity across two separate canonical evidence projections;
it now uses one set. Exact-resource validation now distinguishes a literal
nonmatching key from a broader scope: it admits no permission-list operation,
while the actual protected read still requires its exact matching key and every
cell excludes broader scopes or other capabilities. All 55 scenario regressions
and full composition types pass. Both needed trajectories are retained, the
diagnostic source is removed, and the exact instance/root are retired. Installed
authority retry (`st_7ffa7a7ace0e4403b475dca652a98864`) completes both sessions
and cleanup but fails both cases, with one unexpected unknown-method invocation
in preparation. Exact discovery uses ordinary read-only access before deriving
the correct protected-read ceiling. The earlier repair had added an overly broad
requirement to attenuate every discovery/computation cell; that requires knowing
the permission before discovering it and exceeds this per-eval probe. Validation
now checks every actual protected read's exact ceiling, including negative
coverage for a later wider or unrestricted read. The original failures remain
unchanged. Further default-route model mistakes are retained while coverage
continues; no expected-fault exemption is added. See the bounded
catalog receipt (`native-catalog20-evidence.json`, private verification evidence).
Scoped commit/push and new suite authoring remain after existing acceptance.

Latest verification: the canonical Base run passes 3,462 cases with two existing
skips; its only two manifest-preflight failures are repaired and all four exact
preflight cases pass. The complete system-test framework passes 759 cases with
one existing skip. Actual CPU inference passes both native tool/model-switch
cases without skips and all owned engines/profile data are retired. Desktop
overlay coverage passes eight cases. The latest retained-device desktop scenario
passes, including hosted-provider onboarding and reconnect; the separate native
approvals scenario remains open. No complete installed agentic-catalog
or immutable product/template release verdict is claimed. The paragraphs below
retain earlier checkpoints and failures; see the latest
canonical protocol receipt (`native-canonical-protocol9-evidence.json`, private verification evidence)
and CPU receipt (`native-local-models9-cpu-retry-assets.json`, private verification evidence).

The subsequent retained-device desktop run (`16037`) failed after the real
provider accepted the attributed WebSocket upgrade with HTTP 101. Both narrow
credential reviews were resolved through their visible **Use once** cards; no
pending review remained, but the original native generation produced no recorded
response or terminal outcome. The test deadline initiated cleanup. Personal's
native lifecycle preparation then failed at the host's existing lifecycle
timeout, so graceful native release is unproven. All owned processes are gone and
the private scratch root is removed. Preserve this failure while repairing
transport observability, cancellation/release ownership and reproducible test
review handling; do not replace the provider or extend deadlines to obtain a pass.

The follow-up real Workerd/SQLite/native Harness probe identified and repaired an
upgrade ownership bug: normal connection closure aborted the fetch signal still
attached to its accepted WebSocket, converting a completed provider response
into `Model invocation closed`. Cancellation now belongs to the pending upgrade
until its response arrives; the accepted socket then owns communication and
joined closure. Both real completion/cancellation cases and all 47 focused
transport/provider cases pass. Content-free diagnostics retain the actual
task, send, provider-event and close milestones. See the
transport receipt (`native-model-websocket9-evidence.json`, private verification evidence).

Shutdown now joins actual eval cancellation and lifecycle release instead of
abandoning them at invented deadlines. The supervisor joins the server's actual
exit; repeated graceful signals remain graceful, while explicit force and actual
owner death retire the exact owned groups. All 52 shutdown and 27 supervisor
cases pass. Activation-recovery failures also reach the restart caller after
independent hooks join, without retrying an already-ready process as a startup
failure; all 73 manager cases and two real Workerd lifecycle cases pass. The
desktop harness has 28 accepted focused cases for exact visible review matching,
owned observations and cancellation during directory acquisition. These counts
overlap earlier evidence. Real desktop retries and the installed agentic catalog
remain necessary.

The subsequent two-case desktop retry (`48601`) reaches the hosted shell, but
both chats remain queued because model discovery reports `Extension is not
installed @workspace-extensions/local-models`. The corrected test provider is
declared and admitted, yet absent from the active extension registry. Preserve
the original error and repair that installation/readiness boundary; do not
substitute an empty model list or another provider. Both cases failed before
native submission, and all owned processes and scratch are retired. A separate
retained-device run (`15606`) submits the actual onboarding prompt, then fails
before consent because the test helper cannot classify its sole credential
review. Its existing failure packet omits the compared identity fields; add
bounded mismatch diagnostics before making any change to the match contract.
All workspace servers and the Hub report ordered shutdown complete, and the
owned processes and scratch are retired. An original Workerd `Harness is closed`
exception during retirement remains under investigation; this is not an accepted
generation or full graceful-native-release verdict.

The diagnostic retry (`66832`) identifies only an identity-domain mismatch:
the channel's original human actor is `user:ACCOUNT`, while the review reports
the account ID `ACCOUNT`. Every other review field matches. The test now compares
the original participant ID with the host's canonical human principal constructed
from that account, without stripping prefixes or accepting aliases; 14 focused
review/command cases pass. The retry's original failure, bounded comparison packet
and joined cleanup remain recorded. The alarm investigation also repaired two
host boundaries: async wake publication now joins inside its original RPC
authority lifetime, and alarm/lifecycle rejections reach the existing structured
HTTP error response. All 18 alarm cases pass, including the actual published
`.9` Harness closing during a running pass. Fresh desktop acceptance is still
required.

Initial extension classification now has an explicit startup owner before its
RPC service is exposed. Invocation also joins the current declaration pass, so
later changes cannot reuse a completed startup barrier. An already-approved
target remains usable during unrelated initial planning while still respecting
current classification and its own activation. The 107 UnitHost/ExtensionHost
cases, complete host/Workers types and ordinary development build pass. Counts
overlap earlier readiness tests. The exact desktop replay remains necessary to
attribute the observed registry failure; see the
classification receipt (`native-current-extension-classification9-evidence.json`, private verification evidence).

The actual two-case replay (`83640`) still reports the original registry-absent
`ENOEXT` before either submission. Its processes and scratch are retired. The
107 classification cases therefore establish their narrow ownership contracts,
not a repair verdict for that desktop failure. The subsequent first-case run
(`28770`) confirms that each owning workspace declares the provider and selects
the fixture model, while the invocation still reports it unavailable. Public
supervision lists running extensions and does not by itself attest all inactive
installed declarations. Both original packets and joined cleanup are retained;
trace declaration/classification/invocation before changing that boundary.

The cloud desktop run (`4073`) provides a separate discriminator: the
actual chat DOM contains the full original prompt with `data-message-role="player"`,
and the native generation is waiting behind a visible credential review. The
harness's last observation still says the prompt is absent. Its generic button
scan includes an empty, unpresented WebContents, so the scan does not follow the
compositor's document-readiness contract. The test repair selects only presented,
loaded documents and preserves their original errors. Its test deadline ends the run; all owned processes and scratch are retired.
The five presented-document cases and 19 existing observation/review/command cases
pass, as do scoped types. This is a harness repair under actual verification,
not evidence of a native wake-publication cycle or accepted cloud completion.
Ordered server shutdown completes, while the original Workerd `Harness is closed`
retirement exception remains recorded and full graceful-native release is still
unproven. Retain the original run before replay.

Ordinary desktop close now owns the graceful-stop request. Physical process
ownership joins the actual original leader exit, then retires surviving exact
orphans and joins producer close. A slow live leader no longer triggers an
elapsed-time kill; explicit force can preempt a pending graceful stop. The E2E
owner also preserves close failures instead of racing and suppressing them.
All 29 focused cleanup/fixture-manifest checks, complete host/Workers types,
final scoped E2E types, source hygiene and ordinary build pass. A real Workerd
case separately confirms the original alarm error reaches HTTP500 after its
consumer disconnects, while native/provider cleanup joins. Its first attempt
lacked an actual alarm-admission barrier and is retained as a fixture failure.
The corrected case does not reproduce or attribute the older C++ uncaught
exception. Actual cloud desktop replay remains open; see the
cleanup receipt (`native-physical-close10-evidence.json`, private verification evidence).

The next desktop run (`93741`) observes the submitted prompt and matches the
exact credential review, then exposes another harness assumption: it requires
a minimized review pill even when the native approval card is already expanded.
The helper now follows either actual presentation and examines only loaded,
presented documents. All 24 affected review/document/command cases and scoped
types pass; identity and approval restrictions remain unchanged.

The subsequent actual run (`90354`) passes those visible approval interactions.
Hosted generation, `read`, `set_title`, `docs_search`, and their follow-up rounds
complete and a final reply appears in the chat. It also establishes a product
gap: the human subscription advertises `inline_ui`, `client_eval`, and other
interactive methods, but the model's committed tool list contains none of them.
The agent therefore returns a plain-text onboarding fallback, and the required
overview never renders. Current native tool assembly includes local tools and
`ask_user`, without adapting the other advertised channel methods. Separately,
canonical public participant metadata retains method names rather than their
executable descriptions and schemas. Both discovery and native execution binding
must be designed together; adding a name-only tool or rewriting the onboarding
prompt would not repair the contract.

Root explicitly cancels the remaining observation after retaining this completed
conversation, so its zero exit is **not a passing scenario**. Reconnect remains
unverified. Desktop, all three workspace servers, Hub, diagnostic inspector
connections, and private scratch/caches are joined and retired. This completed
generation shuts down without the older uncaught `Harness is closed` exception;
that does not explain the earlier release of an active generation. The exact
run receipt (`native-iroh-retained-desktop14-launch.json`, private verification evidence)
records this distinction. Restore the full client-method discovery/execution
contract before repeating this scenario or claiming product acceptance.

The client-method contract is now implemented for fresh state. The canonical
subscription revision retains complete `methodOffers` outside public identity
metadata, and each delivered event carries its own offer snapshot. Standard
native tools derive executable schemas and exact targets from those offers;
name-only summaries cannot create tools. Colliding peer/local names receive
distinct deterministic tool bindings, each addressed to one participant. The
existing native method receipt and cancellation owner executes those bindings.
Prepared calls retain their original target and definition across later roster
changes, SQLite replacement and executable refresh. Product tool selection also
remains authoritative: configured chat tools are selectable, and the System
agent does not gain ambient client tools.

The five-file offer/producer/projection/native cohort passes 141 cases; the
seven-file client/chat integration cohort passes 157. After preserving product
selection, the affected five-file native/chat cohort passes 82, overlapping the
earlier cohorts, and all three exact System agent cases pass. Its first attempt
exposed a stale generic fixture without the required loaded-image descriptor;
the repair uses the existing production descriptor fixture. Complete Base and
host integration types and source hygiene pass. No existing state is migrated.
The actual retained-device replay (`70559`) passes with exit zero: Personal
onboarding renders its inline overview, native title/menu/icon assertions pass,
and the desktop reconnects after a server restart without pairing again. System
and Personal trees remain present and focused System New succeeds. Desktop,
workspace servers and Hub complete shutdown; the owned process census is empty
and all private scratch/build caches are removed. This proves the scenario, not
the full installed catalog, immutable release or every active-generation
cancellation interleaving. See the
desktop result (`native-iroh-retained-desktop15-result.json`, private verification evidence) and
current offer receipt (`native-client-method-offers11-evidence.json`, private verification evidence).

The current immutable library closure is `0.99.2-vibestudio.9`, with source digest
`d6ee828953367b064fa0a560e88837c40c606af1c396b988b114330973461d62`.
All four registry archives, SRI, source identity and exact dependencies were
verified, followed by ordinary registry installation outside both repositories,
all four public ESM entrypoints and actual Harness commit/close. All thirteen
native dependency manifests in Base, Examples, Personal, News and Gmail now pin `.9`. The
publication receipt (`releases/0.99.2-vibestudio.9/publication.json`, private verification evidence)
records completed publication and owned authentication/install scratch cleanup.

The `.9` kernel repair is evidence-driven: after SQLite reopen an authoritative
abort mark now supersedes a previous run-mode failure for waiters, allowing them
to join the actual cleanup. Abort-mode failures still reject and require exact
incident repair; the original diagnostic history remains. Ordinary tool failure
also preserves the original structured error and recursive cause through durable
settlement. Seven affected files passed 33 tests and the prescribed full fork
check passed. Four coherent archives were built from that source. These are
library receipts, not a product verdict.

Installed `.8` preservation evidence remains relevant: the five-file channel
cohort passed 162; subsequent exact source observation passed 32, answer
publication 21, diagnostics five, method cancellation four, product model policy
five, prepared helpers five, automation 12, and provider reset four. System's
76 affected cases passed across their initial run and exact corrected-fixture
rerun. Two native child-launch tests and two exact conversation-cancellation
tests prove retained original scope through SQLite reopen and response loss;
the latter preserve a later assignment when the original cancellation is replayed.
Automation UI passed ten cases with actual native/provider effect coordinates.
These are historical installed `.8` checkpoints, incorporated into `.9`; counts
overlap and must not be added into a product acceptance total. The subsequent
`.9` worker/resource results are recorded below.

The installed `.9` resource checks now cover artist seven, Scene seven, image-tool
four, World 27 and Examples Images 13 cases across their original run and exact
corrected-fixture rerun; System's identical Images implementation separately
passed 13. Original provider jobs, canonical publication debt, withdrawal and
resource cleanup are joined. These are component receipts, not product acceptance.
News's 38 affected worker cases pass across the changed-readiness run and exact
repairs. Required product preparation uses the original bootstrap Context for UI
and setup-card operations. Its ready briefing and original delivery survive failed
card/notification acknowledgement; retries preserve the original summary. Gmail's
54 affected worker cases pass across its full run and exact fixture repairs;
complete Gmail and Examples composition typechecks pass. These are component
receipts, not isolated shipping-product acceptance.

The three displaced engine packages (`agent-loop`, `pi-core`, `pi-ai`), unused
driver/fold/outbox/effect executors, their public compatibility exports and
implementation-specific tests are removed from the working source. Canonical
template inventories and remaining caller manifests were updated. The
retirement inventory (`retired-engine-invariants.json`, private verification evidence)
retains source hashes, old invariant names, replacement boundaries and the open
product gates; bounded original source is retained outside the product.
Cloud model materialization and the generated catalog now use the installed
native `.9` registry (41 providers, 1,527 models), with no second upstream Pi
package in the closure. The unused local stream-idle watchdog descriptor and
`say-only` compatibility spelling are removed.

Native bootstrap now retains original agent/domain configuration with exported
knowledge, restores it before offering tools, and owns required product readiness
and post-ready activation debt. Forks retain user preferences while starting
execution fresh. Child-start publication uses its original timestamp. Terminal
publication retains original bytes and resources before dispatch; distinct actual
cancellation operations remain distinct facts, so a retained collaborator can be
cancelled again after a new assignment. Their focused child/report/terminal and
knowledge checks pass; no installed product verdict is claimed.

The complete Base composition passed against installed `.9` at the recorded
source checkpoint (`experiments/durable-pi/native-cutover-composition9-fourth.log`,
joined handle 83017, exit 0). The later channel cancellation/provider-admission
delta requires its own affected verification. Earlier failing checkpoints remain
diagnostic evidence. Template
checkout hygiene also passes; all verification ran through the host-owned source
projection, never from the external template checkout.

The actual native chat/child/configuration/knowledge cohort passed 233 of 244
cases initially. An exact 24-case repair run resolves those eleven failures and
adds one resource-scope regression; the runs overlap. Fixtures enter ordinary
native admission and execution. Original child-start and terminal facts survive
lost replies, later assignments can be cancelled independently, and configured
knowledge transfer uses the selected canonical source frontier. Evidence is in
`experiments/durable-pi/native-legacy-fixture-transfer.md`.

Native streaming passed six observer and four UI cases, including disk-backed
SQLite replacement. Actual committed partials carry the original task/attempt
and transcript frontier; cancellation joins the observer before provider close.
The final native transcript entry remains the answer authority. These are
component proofs, not an isolated shipping-product verdict.

Readiness verification exposed a cached readiness promise that could await its
own bootstrap task during product activation. Readiness now observes its actual
committed fact independently of post-ready activation debt, while an owned task
observer preserves pre-ready failure propagation. Its new regression and the
changed source-bound stream client pass their focused checks. The 48 applicable
readiness/method/evidence/stream/client cases pass across the initial run and
exact cached-promise fixture repair. AiChat's 11 cases also pass, including actual
committed native prompt instructions and same-image sealed-storage reopen.
These receipts precede the in-progress channel provider-generation admission
fence; its affected direct-call fixtures require that genuine new boundary.

Passive vessel inspection
now observes an already admitted Session and reports `not-loaded` without opening
execution. Child cleanup records supervisor receipts in the surviving parent
channel, and explicit cancellation owns a finite native task over the original
captured work rather than the old SQL wake queue. Native input-settlement
notifications replace the old child `turn.closed` dependency. These vessel
integrations still need their actual product preservation tests.

Retirement is now ordered: join native aborts, retained child work and resulting
delivery debt while membership is still present; unsubscribe only after those
obligations settle. Old parent-card reconstruction of execution scope is removed:
a retained child must have its original durable owner/context index. The first isolated native product doctor failed: workerd repeatedly exited with
SIGTRAP during AiChatWorker activation and SystemTestRunner startup. The actual
core points to V8 SourceTextModule::GatherAvailableAncestors. The original
supervisor log and bounded native backtrace are retained privately under
`experiments/durable-pi/native-product-crash9/`. The upstream root cause and fix
are recorded below; no product retry timer or alternate engine was introduced. The exact
managed instance `durable-pi-cutover9-20261002` is stopped and its ephemeral root
removed; core extraction scratch is retired.

The crash is reproduced by upstream's own nested-module regression on the old
binary. Cloudflare's depth-scoped evaluation fix is present in the first fixed
`1.20260807.2` and current `1.20261002.1`; both pass all six upstream cases with
verified registry SRI. Host now uses current workerd and native Pi `.9` for
provider authentication and its complete startup dependency realm. Complete
host types and four actual provider-renewal cases pass. The new isolated doctor
passes all checks. The first actual two-turn tool workflow failed during setup,
before model execution: the fresh native owner did not receive its trusted
schema descriptor. Publication had been the only descriptor-admission path;
first activation now probes the exact sealed executable and caches its immutable
schema evidence before returning the entity binding. Restoration uses the same
admission boundary. The schema check remains required. All 83 affected host and
real-workerd cases and complete host/workerd-program types pass; a fresh
installed-product retry remains required. See the
platform receipt (`native-product-crash9/upstream-module-depth-evidence.json`, private verification evidence).

The setup wrapper also concealed that original error. Its existing structured
error packet now preserves bounded, redacted original and cleanup error trees;
disconnect and context reclamation are independently attempted and joined.
All 40 affected System headless/serializer tests pass
(`experiments/durable-pi/native-headless-setup-diagnostics9-final.log`). The
failed managed instance has been stopped and its ephemeral root retired.

The subsequent host schema-admission cohort passes 83 cases and host types pass.
A fresh installed-product retry remains pending; that source proof does not
turn the earlier setup failure into a passed agent workflow.

Complete System and Personal compositions now pass through host-owned projections,
including mobile source. System’s 76 affected cases and Personal Browser’s 13
cases pass. The local-model supervisor now joins actual child exit and cleanup
before withdrawing its lease. The host extension shutdown protocol awaits real
in-flight work and registered asynchronous disposers, retains failed cleanup for
an explicit retry, and requires both cleanup acknowledgement and physical child
exit before reporting success. Actual child-process integration and affected
manager/service tests pass; the live model resource proof remains pending.

The source switch and obsolete-engine deletion are completed work. The final cancellation/provider claim fence and finite Eval relay pass 39
affected cases, including genuine provider duplicate and canonical terminal
readback. Complete Base and GoogleWorkspace composition checks pass after that
delta. News’s 40 cases pass across the full run and exact fixture repair; Gmail’s
real claimed-network cancellation and the four affected Ai method cases pass on
the final owner. The concrete remaining gates are the live local-provider resource
proof, a fresh installed-product retry, evidence-directed replacement/resource/performance
acceptance, and exact product/template release. The recorded Examples composition
remains valid for its unchanged source. The final affected Base/GoogleWorkspace
checks attest the cancellation delta. No old engine, state migration or compatibility
path is needed.

### Expanded acceptance requested before cutover

The user requires the entire live agentic system-test catalog, including
self-development, and the other chat/protocol/agent integration coverage.
Provision its own managed instance with self-development adoption and an owned
paired client. Conventional builds/tests run before agentic latency measurement.
Inspect every failure, repair its owning boundary, and rerun the affected cases;
the completed source cutover does not substitute for that product verdict.

The expanded Base conventional baseline ran 389 files: 380 passed, eight failed
and one skipped; 3,402 cases passed, 20 failed and two skipped. The targeted host
baseline ran 113 files: 111 passed and two failed; 1,459 cases passed and three
failed. Their failures exposed obsolete fixture admission/export expectations,
current model-catalog expectations, stale WebSocket cancellation fixtures and
plain Node code unnecessarily loading Electron. Focused repairs retain genuine
native schema/provider admission, exact terminal audience and joined cancellation.
The affected Base channel cohort passes 120 cases, native chat discovery passes
13, root guard/build/catalog passes 14 and transport/encryption passes 34.
These runs overlap; they are not additive totals. Host types and template hygiene
pass at this checkpoint.

Real Chromium chat coverage passes all six files and 16 cases. The expanded
real-workerd integration run passed 12 cases and exposed one Eval fixture missing
the host alarm callback. The repaired fixture routes that callback to the real
WorkspaceDO and preserves the original terminal failure through reset. The loader
fixture also forwards its exact object key, so native schema probes and sealed
runtime selection are exercised. Two opt-in diagnostic probes were skipped by
their existing gates; this is not acceptance of those probes.

The conventional system-test framework baseline passes 745 cases; its two failing
TestAgent fixtures now pass after genuine trusted-schema initialization, with owned
SQL databases closed. The full rerun passes 747 cases in 66 files, with one existing
opt-in native-CDP skip. That opt-in case subsequently passes against installed
Playwright Chromium, covering uploads, network response bytes, same-/cross-origin
and nested frames, actual downloads and popups; its owned resources are retired.
Eleven additional transport/integration files pass 38 cases,
including real native workspace startup/cleanup, isolation, Iroh/CDP channels and
the relay seam. Counts retain their individual receipts and overlap earlier runs.

Actual desktop and server startup then exposed a production schema identity bug:
bundling changed the JS constructor label to `_GadWorkspaceDO`, whereas the exact
loaded export is `GadWorkspaceDO`. Schema probe, installation and descriptor checks
now use the required host-bound class identity, as do lifecycle and fetch identity.
There is no constructor alias admission or fallback. The 226-case affected host
cohort passes, including real-workerd integration and exact exported-owner reopen,
wrong-export rejection before writes, and missing-binding refusal. The complete
Base rerun passes all 3,422 cases in 388 passing files, with one skipped file and
two existing skipped cases (389 files total). All twenty initial failures are
resolved. Host/workerd-program types also pass after the identity repair.

Both real Electron DX cases pass with no skips, covering directory reads, bounded
causal diagnostics, hosted-panel pixels, blob round trips and console history.
The real extension and headless-panel integrations each pass. Their owned child
processes, displays, connections, workspace roots and private caches are retired.
Cleanup fixtures now join actual process/socket closure and preserve original
and cleanup failures; the obsolete foreign hub-lease release is removed.

Live local inference and the complete agentic catalog remain pending. The local
runtime-config cohort passes its eighty cases across initial and exact repaired
runs, plus configured reimport of the same record. Configuration now governs
installation validation and utility/chat serving. Review exposed stale shared-
profile caches and read/modify/write races in JSON metadata. Replace that sole
store with atomic SQLite records and fence both validation and benchmark commits
to their captured configuration, with no old-state import or second store, before
claiming the supported CPU/tool/model-switch path.

The first complete SQLite local-model cohort caught an omitted production import:
94 cases passed, 12 failed at `modelRecordStore`, and three existing live cases
were skipped. The first self-development checkpoint captured the same incomplete
source and failed extension activation before any model ran. That owned generation
was stopped and joined; its ephemeral root and self-development mirrors were
removed. Both original failures are retained. The repaired complete local-model
cohort passes 106 cases, with the same three explicit live skips. An additional
actual SQLite regression preserves operation and close failures together; complete
System/mobile strict checks pass on the final source. The next immutable checkpoint
uses that verified source. Live inference and the complete agentic catalog still
require their actual verdicts.

The dedicated Iroh coverage also passes: 28 protocol files contain 146 passing
cases, and the gated native/Electron end-to-end suite passes all twelve cases.
Neither run has skips. Owned native endpoints, displays, Electron processes and
private caches are retired. The live Personal catalog reports 227 declared cases;
eight cases require Personal or Examples units absent from System. Cover these in
their supported compositions rather than counting `notInstalled` as acceptance.

Actual self-development adoption then caught two stale TestAgent references to
the removed `processChannelEvent` method. The synthetic transcript fixture now
uses the existing `onChannelEvent` hook; ordinary subscriptions and non-message
events continue through native intake. Its three focused cases and the complete
System-testing composition typecheck pass. This fixture proves chat transcript
presentation, not native model execution. The failed generation was stopped and
joined before another snapshot. Examples now acquires System-testing through the
existing development-only dependency declaration. Nineteen public-registry,
projection and checkpoint checks and full host types pass. The ordinary host
build includes the corrected public registry schema; published-template source
remains unchanged.

The focused mobile chat/protocol projection passes nine Jest files and 139 cases,
covering Quickfire, approval surfaces, workspace session effects and RPC/WebView
bridges. This is host-owned conventional coverage, not device acceptance.

Actual desktop warm startup exposed contention when a second workspace owner
opened the installation's reporting database. The existing SQLite busy policy is
now established before canonical schema admission; its duration is unchanged.
Twenty-one reporting and canonical-SQLite cases, host types and the ordinary host
build pass. Actual same-workspace warm relaunch passes (51.3 seconds); the native startup and network-approval cases still await their repaired causal-boundary retry.
The E2E root-template helper also uses the current public pin/sealing contract;
its unused old receipt writer is removed. Genuine layered materialization and
scoped E2E fixture types pass; the bootstrap remains the receipt authority.

The actual two-model CPU run failed both cases after real engine readiness. The
first native submission ended with `Provider is not configured: local`: the
shipping local auth resolver discarded the protected model credential sentinel.
The corrected resolver accepts only that canonical sentinel, retains cancellation
and refuses raw or ambient credentials. The controlled native tool round trip
and complete Base and System/mobile composition types pass. This does not turn
the failed actual CPU run into a pass. The second model's broad GGUF template
heuristic claimed tools that the observed runtime capabilities could not admit.
Observed capability and exact runtime-recipe admission are corrected: 90 affected component cases and complete System/mobile types pass. The actual CPU retry now passes both native cases: a real tool round trip and a real model switch, with no live skips. Runtime validation reports the 2.6B model as tool-capable and the 350M model as text-only. All engines were joined and the private 1.9 GB profile removed. This controlled Node-host proof does not attest production host authentication, mailbox delivery or the standard public installer; those remain installed-product checks. Both original failures remain recorded.

### Canonical chat journal and exact native attribution

The actual desktop run exposed a causal authorization failure before provider
execution. Native publication named an invented `branch:channel:*` log, while
ChannelLog wrote the actual channel ID with head `main`. It also stored an agentic
wrapper that the invocation projection did not read. The current contract uses
one canonical channel journal, with typed event kinds and payloads, hash-covered
causality and transactional projections. The existing channel transport presents
a wire view of those records. There is no second trajectory, state conversion,
namespace alias or compatibility reader. Eighty identity/caller checks pass.

Native invocation attribution is now the typed `invocation.started.payload.nativeSource`,
independently readable from variable request blobs. Publisher, schemas, channel
view, knowledge transfer, host authorization, desktop evidence and headless
settlement use that one field. The focused protocol/native/journal cohort passes
244 cases; host attribution and dependency policy pass 30 cases, host types and
an ordinary build pass. Canonical pagination selects the stored event kinds
before windowing; channel health excludes unrelated logs that share `main`.

Human initiation comes from the actual native task's retained original placed
input and its exact source envelope. Authorization verifies the original
conversation/submission/entry, channel, sequence, envelope/message IDs and
receiver, then reads the authoritative outer user actor. Later steering,
agent-authored text and the old turn-derived user column cannot manufacture that
provenance. Inspection observes an already admitted Harness and does not open
execution. Forty-two source/session/inspection component cases pass. The native
grant-reuse validator joins completed child model evidence to its published answer
instead of requiring a fabricated `turn.closed`; its headless/shared-helper
cohort passes 50 cases.

The comprehensive Base rerun found raw-journal assumptions in pending-call,
policy and fork reconstruction, as well as a schema-refinement error in this
change. Those defects are repaired against the canonical representation while
retaining their behavior assertions. The original 393-file run (59 failures,
3,402 passes, two skips) remains recorded in
its log (`native-base-entire-suite9-canonical-protocol.log`, private verification evidence).
The subsequent full run passes 3,462 cases with two existing skips. Its only two
failures were repository preflight for concurrently edited mission-control
manifests. Four narrow metadata corrections restore package privacy, the panel
entry point and a production dependency declaration; all four exact preflight
cases now pass. Feature implementation remains with the other task.

The canonical ChannelDO cohort passes all 106 cases, including bounded replay
across 501 opaque entries. Complete Base/host, System/mobile and System-testing
composition types pass. The final full system-test framework run passes 759
cases with one existing skip. Its grant-reuse fixture now uses actual completed
child evidence. These conventional results do not establish installed agentic
catalog acceptance.

The actual desktop retry passes all eight overlay cases and fails the two native
approval cases. Canonical causal authorization succeeds, but the initial native
task selects a cloud model because the test provider's directory disagrees with
its package identity and the package graph excludes it. The fixture now uses
canonical `extensions/local-models`; the exact native approval retry remains
open. Separately, production discovery must distinguish an absent optional
extension from activation, approval, transport or protocol failure, and propagate
the latter through model selection. That repair passes all 44 discovery/lifecycle
cases and complete Base/integration types. Canonical metadata establishes
optional absence; declared missing sources and malformed inventories fail
truthfully. Disconnect and unmount cancel and join the original read without
clock-based abort, periodic failure retry or catch-to-cloud behavior.
The failed desktop run's processes and scratch are retired.

The entire installed agentic catalog and immutable product/template release
remain open. The local extension's normal native home supplies an isolated model
profile; a shell environment override is not forwarded into that runtime. Use
its observed public storage root and public CPU configuration, and retire its
owned generation and model assets. Controlled providers and conventional mobile
tests do not establish installed model or device acceptance.

### Historical component checkpoints

The following receipts explain the primitives incorporated into the current
source. Their older package pins and open integration statements describe their
historical checkpoint, not work to repeat after the completed source cutover.

The new transactional Harness preparation hook admits native channel delivery
tasks atomically with the canonical entries and terminal outcomes they project.
Seven hook regressions and a structured terminal-error regression pass within
a 47-case focused fork cohort; the prescribed full fork check passes. SQLite
proofs cover rejected commits, lost delivery bindings, reopening and retained
original/cleanup error details. See the fork evidence (`fork-publication-evidence.json`, private verification evidence).

Base's `native-invocation-boundary.ts` now binds real native sources, publishes
their canonical start before protected execution, retains ambiguous publication
debt and transfers terminal delivery into the same native transaction. Three
installed-package tests pass for exact identity across a native wait, failed
channel acceptance and atomic delivery-admission rollback. The latest exact
withdrawal/owner checkpoint has 41 passing cases; host withdrawal checks preserve
sibling prompts and join only the original ask.

`AgentVesselBase` now inherits `NativeChannelOwner` in the working source, so
`AiChatWorker` and the standard vessel subclasses select the native owner.
The old driver construction, wake/effect claim RPCs, execution tables and
separate deferred-Eval recovery loop have been removed from that composition.
Canonical delivery admission now uses the native Session rather than an agent
SQL delivery queue. Subscription bootstrap, canonical history replay, knowledge import/export,
automation admission and native inspection are wired in the working vessel.
Native child launch/cancellation and model policy are wired. Subsequent worker,
knowledge, streaming and resource component checks are recorded above. A passing
source switch still does not establish installed product acceptance.

Standard and AiChat tools now use native tool registrations and frozen,
invocation-bound capabilities. Their focused authoring cohort passed 337 cases;
a corrected affected cohort passed 42 cases, including publication and the
native invocation boundary. Counts overlap and do not constitute product
acceptance. Executable definitions are rebuilt before Harness reopen; native
provider definitions come from the installed Pi registry.

The preceding closure, `0.99.2-vibestudio.7`, added two necessary native contracts:
committing a tool's continuation and original domain binding before uncertain
external dispatch, and revising/withdrawing the actual queued input with the
native read-wins cutoff. Frozen staged submission records let read-acknowledgement
debt commit with actual UserEntry placement. The affected fork cohort passed
335 cases and the full prescribed fork check passed. All four registry archives, SRI, dependency closure and source identity were
verified. Ordinary registry installation outside both repositories passed all
four public ESM entrypoints and actual Harness commit/close; owned authentication
and install scratch were removed. That receipt is historical; Base now pins `.9`. The current checkpoint above
records the later channel lifecycle, invocation and installed-package proofs.

The current gates are listed above and in [plan section 17](durable-pi-migration-plan.md#17-current-implementation-outcome-and-cutover-scope).
Do not reinterpret these historical receipts as a request to switch the native
owner again, replace already migrated consumers or restore deleted engines.
The remaining product checks must exercise supported user behavior and the final
lifecycle delta on the exact installed source. Earlier component/typecheck
receipts below remain historical evidence.

## Changed boundaries and preservation evidence

| Boundary / ledger obligations                  | Implementation and affected callers                                                                                                                                                                                                                                                                                                         | Evidence / limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema lifecycle, L27                          | Both DurableObjectBase variants await one initialization flight before RPC, alarm and lifecycle work. Synchronous ensureReady asserts readiness. Pi exposes its existing scoped migration body; SqliteStorage accepts the same initializer.                                                                                                 | Schema rollback/upgrade/refusal tests, host DurableObjectBase native fresh failure/retry/reopen, complete-shape drift refusal. Generic bare DOs retain their existing descriptor policy; shipping Pi activation must require a trusted artifact descriptor.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Constructor writes, L27/L39                    | Agent vessel constructor preparation removed. FeedbackIngest/CardManager DDL moved into the owning schema lifecycle. Test helpers, BrowserVault and WorkspacePresentation await readiness. AgentDirectory/channel admission reviewed.                                                                                                       | Base lifecycle 33, feedback 1, card manager 10, presentation 9, directory/channel 107 tests passed in focused cohorts. Existing chat-operation 151 tests passed. These preserve current Base behavior, not a Pi product cutover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Artifact identity, L22/L27/L44                 | WorkerdManager stages schema evidence by source + execution digest + class; getDoCode selects the loaded image's evidence. Server candidate passes its digest. Conflicting evidence refuses atomically.                                                                                                                                     | 237 host tests across eight affected files pass, including two recipes with one source version. Obsolete descriptor cache is reproducible probe evidence and is invalidated; application data is not reset. Full process replacement of a shipping Pi agent remains later acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Commit preparation, L01/L02/L19/L21            | Session prepares schedules before its one commit and detects outstanding callback work before asynchronous preparation. Transaction can read an optional existing document without creating it. Wake metadata remains lazy.                                                                                                                 | 170 focused fork tests across seven files: session documents, dormant waits, conversations, structured output and three SQLite suites. Conversation tests pass unchanged after an initially detected extra-commit regression. No generic parallel participant engine added.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Wait/checkpoint consumers, L19/L21/L23–L26/L40 | Scheduler, task graph, generation, compaction, tools, output buffer, TUI and examples consume typed task/time/receipt/input/registry conditions. Abort cleanup has its own persisted wait mode. Tools store continuation and bounded output before releasing their invocation.                                                              | Final consumer cohort: 265 passing tests across nine generation, compaction, tool, output, task, ownership and registry files; dedicated dormant tests cover receipts, output, abort and 301-task bounded continuation. Deferred-provider absence is detected at the due poll after replacement; this timing change is intentional and tested. Custom runtime.sleep remains a resident extension API and requires an explicit port when dormancy is promised.                                                                                                                                                                                                                                                          |
| Host wake ownership, L19/L21/L22/L25           | WorkspaceDO registration/publication metadata owns incarnation/revision/null-watermark/claim counters. AlarmDriver schedules opportunities. Own-lifecycle service handlers authenticate register/publish; rotation/list remain host-only. Startup adoption scans all active registered sources, including those with no delivered schedule. | Native quiet timer and total-publication-loss recovery through actual driver/WorkspaceDO implementation; five relay unit tests and WorkspaceDO/service/driver regressions pass. WorkspaceDO fixture SQL.js and completion transport are declared limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| External operation, L18/L23/L26/L40            | Native tool commits receipt binding and execution intent, calls real EvalDO with stable incarnation/task identity, parks, consumes actual result. Replay-safe recovery attaches after acceptance before continuation commit.                                                                                                                | Native injected admission-gap test calls admission twice but SQL applies once. Late result, duplicate result and replacement resume a model that validates actual tool output. The Base receipt consumer reads authenticated canonical domain truth, validates the retained route/admission digest, commits the actual result and then acknowledges its exact digest. Nine installed-package fault checks cover absent/foreign receipt, rebinding refusal, local commit failure, lost acknowledgement/reopen and conflicting replay. Native real-Eval proof uses this consumer. Completion transport is still fixture-controlled; live provider, full reclamation and production domain-event routing are not claimed. |
| Product consumers, L28–L39/L41–L43             | Background assignment, child identity, feedback/card and mission policies retained in the selected design. Existing source inventory and baseline tests remain audit inputs.                                                                                                                                                                | 24 current-product preservation tests pass separately. Full custom hook/override census, replacement behavior and old-symbol deletion remain M4 obligations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Test cohorts overlap; their counts are not a single total. Fork checks include
formatting, source graphs, dependencies, TypeScript and browser smoke. Earlier host/installed declaration typechecks and template hygiene passed;
these historical receipts do not attest the current full composition.
The user selected `@panticonic/pi-*` with the existing `panticonic` account.
At the earlier `.4` checkpoint, all four packages were published at exact version `0.99.2-vibestudio.4`, under
tag `durable-pi`. Registry metadata, downloaded archive bytes, SRI and source
identity match the reviewed release. An ordinary registry installation passes
all four ESM entrypoints and a real Harness commit/close. The current complete
Base composition typecheck passed with those exact registry dependencies.
Publication evidence (`releases/0.99.2-vibestudio.4/publication.json`, private verification evidence)
records the immutable library release; product cutover remains incomplete. The host authority catalog and
userland RPC contracts are checked. Source hashes in native evidence include
both the source delta and loaded input files; the fork's pinned HEAD alone is
not the artifact identity.

## Installed closure and Base owner components

Four exact fork libraries are built, packed and installed through ordinary npm
resolution with source, toolchain, archive and transitive integrity evidence.
Native bundling uses installed exports and excludes a second upstream Pi copy.
All four exact versions are published under `@panticonic/pi-*`; ordinary registry
installation verifies the reviewed archive integrity and source identity. The earlier `.4` installed composition typecheck passed without local-file
dependencies. The current selected-native-vessel composition is not yet green;
see the current checkpoint above.

Base now contains `native-agent-session.ts` and `native-eval-receipts.ts`.
The Session factory validates host runtime/context/incarnation before Harness
reconciliation, refuses unbound legacy execution namespaces, and releases the
connection on refusal. Its platform opener validates the active entity and exact
loaded image through host service calls, then registers the host incarnation
before creating the connection. Nine checks also prove foreign/retired image
refusal before connection/registration and changed-context refusal. Native identity refusal leaves task/document/metadata
records unchanged. The receipt module retains immutable routes and authenticated
admission digests, reads domain truth, commits before exact acknowledgement, and
retains pending/cleanup semantics through replacement. Their actual Base source
is bundled against registry-installed Pi in the proof.

`native-agent-owner.ts` now composes those components with Base's actual
RPC/lifecycle foundation. Twenty-four owner tests cover mandatory descriptors on all
routes, probe isolation, atomic product/Pi bootstrap, concurrent activation,
lease-before-admission, synchronous sealing, in-flight activation joining,
retained-history reopen, host-incarnation refusal without record mutation,
uncertain-close refusal, release retries, foreign/early completion hints and
lost-ack replacement. The receiver authenticates the exact retained Eval scope;
payload result fields cannot supply execution results. During release it permits
settlement on the existing Session while refusing new admission. A mandatory
product domain-release port joins resource cleanup before Session close and
lease removal; failure keeps the lease inspectable. These are SQL.js/controlled
host component tests, not full workerd product routing. Protected ports,
complete terminal cleanup, custom composition and the default switch remain.

Provider source preservation now passes 84 tests covering explicit credential
type, prompt progress, invocation-owned Codex sockets, abort/late connection,
request identity, retry diagnostics, terminal refusals and fast-tier accounting.
Full fork prescribed checks pass. Production egress/model provenance and all
custom provider hooks remain acceptance work.

## Risk dispositions and remaining release gates

| Risk                                                 | Selected resolution                                                                                                                                                                                                                  | Status / acceptance needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two schema installers or partial bootstrap           | One outer native transaction; extracted dependency runner is a component; only the parent lifecycle admits work.                                                                                                                     | Implemented and native-tested. Existing schema-spec remains historical fault evidence, not a shipping second runner.                                                                                                                                                                                                                                                                                                                                                                                            |
| Same-version shape drift / forged metadata           | Validate persisted and trusted source shapes, contiguous supported upgrades and trusted final descriptor; complete Pi composition attests the whole store.                                                                           | Implemented. Every shipping Pi route, including unpublished/context builds, must obtain its exact contained probe or refuse before activation. Do not silently accept a missing descriptor.                                                                                                                                                                                                                                                                                                                     |
| Lost first publication / quiet owner                 | Register before admission, atomically derive local schedule, acknowledge exact revision, scan active registrations at host generation adoption.                                                                                      | Implemented and fault-tested. Host incarnation journal wiring is implemented; shipping installation/activation and full process reset/restore proofs remain mandatory.                                                                                                                                                                                                                                                                                                                                          |
| Null clear reordered with old wakes / claim ABA      | Retain revision watermark and persistent claim counter; exact replay repairs derived scheduling without replacing a live claim.                                                                                                      | Implemented and tested across clear/reinsert/rotation.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reset or restore reuses an old receipt/wake identity | Rotate the host incarnation after exclusion/drain as an idempotent recorded stage of the existing maintenance journal; on retry recover the recorded identity. Restoring data never restores authority to a retired incarnation.     | Implemented: UUID/generation rotation and the existing replacement cursor commit atomically in the host maintenance journal; retry is idempotent. A 200-test host cohort covers journal/relay/WorkspaceDO/service behavior. Full process reset/restore and physical retirement acceptance remain. A post-reset callback is insufficient because it introduces an unjournaled crash gap.                                                                                                                         |
| Domain accepted before continuation committed        | Commit stable intent/binding first; only replay-safe stored and current definitions may reattach; domain deduplicates stable operation identity. Unsafe uncertainty blocks visibly.                                                  | Real safe EvalDO gap proved. Shipping unsafe and pinned-definition failure paths remain operation acceptance work.                                                                                                                                                                                                                                                                                                                                                                                              |
| Lost completion / duplicate result                   | Domain owns canonical terminal receipt; authenticate event binding, admit it durably and re-drive delivery until exact acknowledgement. Duplicate equal values are harmless; conflicting results reject.                             | Canonical EvalDO receipt/exact acknowledgement and the Base consumer are implemented and prove late/duplicate results, durable-before-ack ordering, commit failure and lost-ack reopen. EvalDO now retains/redelivers hints until exact ack, with absolute deadlines, capped backoff, a finite due batch and activation reconstruction. The owner receiver has authenticated component tests; production operation admission/routing and reclamation remain M3. No parallel semantic completion queue selected. |
| Cancellation appears done while resources execute    | Persist cancel intent, close new admission, request domain cancellation, park cleanup until authoritative settlement, then acknowledge/reclaim.                                                                                      | Kernel abort/continuation tests pass. Real executor death, cancellation-loss and cleanup proof remain M3; fixture cancel handler alone is not evidence.                                                                                                                                                                                                                                                                                                                                                         |
| Reclaimed payload reopens execution                  | Keep immutable canonical closed identity through the executor's retained life; retire finite executor incarnation before discarding identity.                                                                                        | Finite Eval disposal now uses canonical host retirement, seals new admission before cleanup awaits and retains closed identity/payload. Retired scopes refuse old/new runs, including cache misses; control reads cannot create or rebind an owner. The 128-test retirement/receipt cohort and 41 control service tests pass. Actual physical resource/payload collection and other operation families remain; range compaction is deferred.                                                                    |
| Checkpoint or tool binding changes semantics         | Prepared requests pin semantic version, provider-wire schema and execution contract. Preserve stored operation identity and cleanup debt; incompatible bindings park on registry publication until a compatible handler is restored. | 164 source tests cover recovery, ordered waves and incompatible execution/cancel binding without losing receipts/checkpoints/output. Shipping artifact/source/authority pins and the complete custom-definition compatibility matrix remain M3/M4. Fresh execution namespaces for old-engine cutover; no legacy executor.                                                                                                                                                                                       |
| Unbounded local scheduling / starving inspection     | Finite starts/phases, tail rotation, host continuation and separate service handlers; external operations return typed waits.                                                                                                        | 301-task fairness/budget test passes. Real multi-owner fairness/resource/performance evidence remains release work; no latency claim from a shared test host.                                                                                                                                                                                                                                                                                                                                                   |
| Lost fine-grained product behavior                   | Close ledger rows per custom declaration and historical failure, then delete displaced symbols. Keep receipts/provenance distinct from execution status.                                                                             | Affected boundary audit recorded for the implemented delta. Full product/custom provider review and replacement preservation remains M0/M4.                                                                                                                                                                                                                                                                                                                                                                     |

These are settled architectural choices and explicit proof obligations. No open
question is answered by a timeout, a second scheduler, a status mirror, or
pretending component tests constitute full product acceptance.

## Domain-side delivery closure

EvalDO schema v5 commits the delivery obligation with run admission before
execution. Successful RPC delivery never closes that obligation. Exact digest
acknowledgement closes the derived index atomically; the result and closed
identity remain canonical. Each pass claims at most 64 due slots, advances an
absolute deadline before external awaits, caps backoff at five minutes, and
never exhausts retry opportunities. Reopening reconstructs missing indexes from
unacknowledged domain admissions without postponing existing deadlines. Pending
and cancelling rows cannot supply terminal receipts. Canonical cancellation
without a stored payload remains deliverable after authoritative settlement.

The exact supported v4-to-v5 schema upgrade rebuilds only the derived delivery
index; it preserves operation rows, payloads and acknowledgements. The shared
schema installer now permits an upgrade-bearing fresh probe to generate its
fingerprint, while requiring the trusted target before any persisted upgrade.
This removes a bootstrap dependency without weakening upgrade admission.

105 tests across schema, delivery, receipts, cancellation and result-resource
files pass, including failed admission commit, repeated hint failures, successful
unacknowledged delivery, lost index/reopen, exact-ack races and bounded due-work
fairness. Host/workerd program types pass. The installed native fixture still
passes 23 portable cases and 24 aggregate assertions; seven component gates close
and the product gate remains open. Its completion route is fixture-controlled;
it does not prove the complete shipping Pi receiver or all domain-loss boundaries.
The registry-installed run stopped its owned `durable-pi-registry-20261001`
instance. The shipping NativeAgentOwner has separate component evidence; this
fixture continues to use the host schema foundation and controlled transport.

## Committed model request inputs

The maintained fork now stores the complete selected model descriptor, rather
than resolving the same provider/model name again during execution. Generation
has a `bind` phase that reads its committed cutoff, runs `beforeRequest`, validates
and copies the actual messages, then commits the `request` checkpoint before
dispatch. Recovery of that checkpoint resends the committed input without rerunning
the hook. Recovery before binding commits reruns binding, while retaining the
prepared descriptor, options, tool bindings and cutoff.

Compaction stores its actual summary messages and timestamps during selection;
replacement and retries preserve them. Deferred generation retains the descriptor,
messages and request settings through polling and cancellation. A catalog change
or removal cannot silently retarget an admitted request. A missing provider before
new dispatch produces the established refusal; admitted deferred work retains its
handle and visible failure as described below. Both built-in task definitions use checkpoint
version 2; prior live version-1 work blocks through the existing compatibility
boundary instead of being guessed or converted.

Nine new tests cover changed hooks/catalog/settings, catalog removal, interrupted
binding, deferred poll/cancel, exact summary replay after history/clock changes,
rejected input commit, non-JSON descriptors and prior-checkpoint refusal. The
affected eight-file cohort passes 209 tests and the full prescribed fork check
passes. Counts overlap earlier cohorts. Source evidence (`model-binding-evidence.json`, private verification evidence)
records the exact files, commands and limits.

The original binding evidence predates packaging; the resulting source boundary is now included in the verified `.2` release below. Protected credential,
authority and trajectory binding, validation of auth-applied endpoints, joined
transport ownership and truthful deferred-cancellation failure settlement remain
required. These source tests do not close production provider or cutover gates.

## Invocation-scoped model request ownership

The fork now exposes a request capability port over Pi's existing Models service.
The scheduler stamps task, conversation and definition identity onto a detached
JSON copy of the committed request. Generation, compaction, deferred polling and
deferred cancellation acquire live authentication, transport and observer
capabilities through that same boundary. These capabilities are not checkpointed.
Pending access parks on the existing durable input, receipt or registry contract.

Every acquired connection closes with an uncancelled cleanup context before
response classification. Shutdown joins acquisition, dispatch and cleanup;
late acquisition after cancellation closes without dispatch. The scheduler also
retains invocation ownership for an unawaited model request and refuses task
settlement or suspension until its requests join. Dispatch and cleanup failures
preserve their original error objects at the port boundary.

Eleven new tests cover identity/capability forwarding through Models, generation
and summary cleanup ordering, abort/shutdown joining, late acquisition, cleanup
failure, unawaited ownership, ended-invocation refusal, SQLite access-wait recovery
and deferred poll/cancel access. Pending cancellation access retains its handle,
abort intent and abort-mode wait. The affected eleven-file cohort passes 283 tests;
the full prescribed fork check passes. Source evidence (`model-request-port-evidence.json`, private verification evidence)
records the exact source hashes, commands and limits. Counts overlap prior cohorts.

The four immutable `.2` libraries are published and verified through registry
metadata, exact archive bytes/SRI, ordinary installation and ESM/Harness smoke.
NativeAgentOwner now requires an explicit model request port in its option type
and refuses a missing port before host or connection admission. Base pins `.2`;
all 23 owner tests pass, including missing-port refusal, cleanup before lease
release and refusal after failed/late model cleanup. Installed declarations and complete Base composition types pass.
Admission evidence (`model-port-product-admission-evidence.json`, private verification evidence)
records the exact source and release receipts. Native workerd revalidation of `.2`
now passes all seven component gates, with 23 portable cases and 24 aggregate
assertions; fixture cleanup and managed-instance stop are confirmed. The scripted
model does not prove live provider ownership. See the
native revalidation receipt (`native-model-port-evidence.json`, private verification evidence).
The actual protected port must still bind host-verified
authority/trajectory identity and validate auth-applied endpoints. An uncertain close still belongs to the embedding resource
owner and requires physical cleanup proof. This immutable `.2` evidence predates
the cancellation ownership repair below; it does not attest the changed kernel.
These tests do not close those product gates.

## Exact credential binding at host egress

The host-attributed HTTP and WebSocket paths now accept one explicit credential
selector. A selector does not grant authority: the existing host checks caller
identity, sealed source, credential lifecycle, audience and credential-use grants
before injecting a secret. A missing, revoked, expired, foreign-audience or
ungranted selected credential refuses without choosing another matching account.
Empty/repeated selectors refuse. Internal credential/routing headers are stripped
before forwarding, including authenticated platform callbacks.

Twenty-one new real HTTP/WebSocket transport tests and all 65 existing egress tests
pass. Host/workerd types, focused lint, dependency graphs and template hygiene
pass. Egress evidence (`egress-model-binding-evidence.json`, private verification evidence)
records the exact source and verification. Loopback network authorization is a
fixture; it does not bypass the credential checks being tested.

This closes a transport prerequisite for keeping HTTP and WebSocket calls on the
same acquired account. The shipping Pi provider port still needs invocation-bound
authority/trajectory admission and joined physical resource cleanup. Concrete
endpoint validation is now implemented in the Base transport component below;
product endpoint materialization must still precede request pinning. The old global provider adapter and current product default
remain until that full replacement is accepted.

## Base provider transport and retained release failures

Base now exposes `createCredentialedModelConnection` for an already admitted
invocation. It snapshots the exact credential/account and concrete endpoint,
rejects credential retargeting and origin/path/query escape, and supplies local
HTTP/WebSocket callbacks without changing global fetch. HTTP uses the existing
credential RPC; upgrades name the same exact credential at attributed egress.
Codex account/originator headers and explicit Anthropic OAuth selection survive.
Pure sentinel/header helpers are shared with the existing adapter.

The connection owns original request/response readers and late upgrades. Close
seals dispatch, joins in-flight acquisition, and joins actual reader cancellation
and socket close. A regression exposed `Request(existingRequest)` reporting body
proxy cancellation before its original source finished; serialization now owns
that source directly. Errors remain original and cleanup failures remain sticky.
Twenty-three transport tests and six existing adapter tests pass, including the
installed Codex provider, query override refusal and FormData serialization.

A second regression demonstrated NativeAgentOwner clearing its lifecycle lease
after model cleanup failed and Pi recorded a task fault. The owner now retains
each failed connection with its committed request, seals further admission,
joins remaining kernel work and refuses a successful release. Domain cleanup
can inspect those exact retained resources. Twenty-three owner tests pass, including
late acquisition during cancellation and unchanged refusal on repeated release.
Complete Base types, focused lint, dependency ownership/reuse checks and template
hygiene pass. The dependency policy records why the exact three fork pins are
required: independent version resolution could mix the reviewed Pi kernel,
Chord context and provider contracts. Other dependency/reuse checks remain intact.
Source evidence (`base-model-transport-evidence.json`, private verification evidence)
records the failures, fixes, exact source hashes and verification.

These are controlled component tests. They do not prove host-bound product
admission, durable approval/reconnect handover, native provider socket behavior,
physical resource retirement or cleanup retention across process loss. The
existing native `.2` fixture predates this Base revision. Shipping composition,
truthful deferred cancellation settlement and the full product cutover remain
required; no default engine switch or old adapter deletion has occurred.

## Owner RPC scope and durable authority readiness

Base now exposes the host's existing `InvocationContext.runDetached` boundary.
NativeAgentOwner uses it for activation, model acquisition/close and lifecycle
release. Its owner RPC view uses the same client and independently evaluated
owner identity, preserves separately admitted execution proof and provenance,
and returns unary EACQUIRE for durable suspension. It never borrows the inbound
call's transient nonce. A held model admission does not hold the foreground
input acceptance reply open. Actual loopback unary and framed streaming tests
cover these boundaries. All 23 owner tests, the existing 33 runtime tests,
complete Base types, focused lint, dependency gates and template hygiene pass.
Scope evidence (`owner-rpc-scope-evidence.json`, private verification evidence) records
exact source hashes and the controlled-fixture limits. It does not attest live
host admission or a new native workerd run.

Authority delivery now follows live observers in both ordinary acquisitions and
target joins. A disconnected or already-aborted waiter does not permanently
suppress owner redrive. If another waiter receives the outcome, delivery stays
in-band; if all observers depart before receiving a committed decision, the
existing owner callback runs once. The decision/disconnect race checks the
observer's signal before handing over the outcome. Departing observers remove
their exact callback and abort listener, without leaving reactions attached to a
shared pending promise. Synchronous notification failures use wake diagnostics
and cannot masquerade as approval-presentation failure. Fourteen new regressions
and the affected 71-test host cohort pass, with complete host/workerd types,
focused lint/format and template hygiene. The
handover evidence (`acquisition-handover-evidence.json`, private verification evidence)
records failures, source hashes and cleanup. This is a process-local ownership
repair; the preceding `.3` native run does not attest this later host change.

The authority source needs more than an owner wake callback. Invocation asks
now retain their requests and terminal receipts in the canonical grant database;
standing target joins still have process-local delivery ownership. Both ordinary
and target-join callbacks remain best-effort, and unavailable routing can drop a
hint. Before removing the old redrive machinery, the authority owner must
reconcile host/owner replacement and retain delivery until authenticated owner
acknowledgement. No second approval channel, fabricated input fact or polling
watchdog closes that gate.

### Canonical invocation approval recovery

The coordinator now admits ordinary and source-delta asks through the grant
owner's existing SQLite connection and transaction before presentation. Its
maps own live presentation and observers; they no longer own request or terminal
truth. The expiring completion buffer is removed. Startup and late waits can
reproject retained pending asks, and old decisions remain readable after restart
or arbitrary clock changes. Distinct acquisition cycles preserve old receipts.
Fresh asks use their complete sealed inputs to find the exact current cycle;
there is no per-invocation scan of receipt history. Session identity participates
in grouping even when snapshot hashes coincide. Reusable installed-code asks
still coalesce without replacing the original snapshot.

The stored request format preserves every installation-review Map and Set,
origins, identity keys, repair sections, original installation provenance and
landing binding. Unsupported live data refuses admission rather than disappearing
through JSON serialization. Signals remain live lifecycle facts; restored mutable
subject requests consult the existing execution registry and current generation.
Node SQLite truncates returned NUL-containing text, so persisted request keys
use canonical JSON rather than the former NUL-separated in-memory representation.

Human grant writes, source-delta revocation/replacement and decision receipts
commit together. Composed test-policy grants are also atomic. A failed outcome
write rolls back grants and propagates the original failure plus any failure to
commit it; the canonical ask remains pending. Current observers receive their
original failure, while recovered failures retain the structured RPC category,
code and payload. A late conflicting presentation receives the first canonical
decision without minting another grant. Dismissal cooldown is retained through
restart; only a later attempt starts another cycle. Explicit session retirement
closes its known owners atomically without traversing receipt history.

Live withdrawal notifications and execution aborts also belong to the grant
transaction. Nested work uses savepoints; rollback discards its pending effects,
and only the outer commit releases them. Separate-connection tests prove that
listeners see committed grants and receipts. SQLite COMMIT failure leaves live
authority intact. Listener failure attempts all remaining effects, reports the
original causes and cannot roll back or replace an already-committed approval.
Install-clearance rollback now notifies withdrawal of its newly issued grants
after restoring the outgoing consent in the same transaction. This is commit
ordering for existing listeners, not a durable resource-retirement receipt;
process-loss cleanup remains acceptance work.

Recovery tests exposed a pre-existing grant defect: `lineageAtConsent` was issued
but never stored. The grant schema is now v13, with a supported v12-to-v13 upgrade
and explicit lineage read/write validation. The v11-to-v12 acquisition upgrade
remains supported. Existing grants and acquisition records survive these upgrades;
unknown historical lineage is not invented. A complete constraint round-trip
test checks every declared authority constraint after reopen.

Fourteen coordinator recovery tests include actual Node process exit before
presentation settlement. Fourteen storage tests cover exact bindings, atomic
settlement/retirement, upgrades, acknowledgement loss and corruption refusal.
Nine commit-effect tests cover rollback, committed visibility, nested ownership,
subject lifetimes, listener failures and install rollback. The complete affected
22-file cohort passes 566 tests, with complete host/workerd
types, focused lint/format, dependency gates and template hygiene. One existing
framed relay readiness assertion failed during concurrent verification; its exact
isolated case and the full cohort passed with other verification work stopped.
No relay code or deadline was changed. Coordinator evidence (`authority-acquisition-coordinator-evidence.json`, private verification evidence)
retains the failed and successful reports, source hashes and cleanup. The
earlier v12 storage receipt (`authority-acquisition-storage-evidence.json`, private verification evidence)
is a historical foundation checkpoint.

The v13 checkpoint above preceded the standing approval consolidation below.
Standing invocation joins still need canonical retention. Exact acknowledgement
exists at the storage boundary but is not yet consumed by shipping Pi owners.
Protected owner reconciliation, reconnect readiness, immutable source/artifact/
context/authority pins and actual provider/operation admission remain M3 work.
The earlier `.3` native run does not attest these later host changes. This source
proof does not close L14 or authorize deleting the old redrive path.

### Standing approvals share grant ownership

Grant schema v14 incorporates target requests, their plan links and target
registration/retirement. `TargetAuthorityRequestStore` is now a view over the
grant owner's connection and transaction; its separate connection, initializer
and close contract are removed. The production coordinator obtains this view
from the grant owner rather than accepting an independently owned store.

Target settlement accepts grant work inside that transaction. First-answer
arbitration reads the retained target decision before issuing consent, so a late
conflicting presentation receives the original outcome without another grant.
A multi-row task-rules answer settles all selected and unselected rows atomically.
Rejected outcome writes or a later grant failure leave the entire decision pending
and roll back issued consent. Existing live joiners receive the original failure;
it no longer disappears into a presentation log. Retired registered targets cannot
admit fresh requests. Rejected semantic replays cannot leave a new plan link.

Supported v13-to-v14 upgrades preserve existing grants and invocation receipts.
Existing target approval records are user consent/history, not disposable
old-engine execution state. A one-time owner transaction imports the exact
historical v5 source through a read-only snapshot, preserves all plan associations
and terminal/retired facts, and seals its content digest. Missing sources are also
sealed as absent; a file appearing later cannot become authority. The historical
file remains unchanged and is never reopened as a writable execution owner.
Unknown shapes, corrupt review/resource facts, invalid ownership, missing plan
bindings and unreadable NUL-containing identities refuse owner startup without
partial approval records or an import seal. Supported schema installation precedes
the import; a failed import can leave the new empty schema installed, but cannot
expose the owner or alter existing consent.

Fifteen new tests cover atomic target/compound decisions, first-answer replay,
retirement, supported upgrade, exact historical adoption and failure refusal.
The affected 23-file cohort passes 581 tests; host/workerd types, focused
lint/format, dependency gates and template hygiene pass.
Standing approval evidence (`target-authority-ownership-evidence.json`, private verification evidence)
records exact sources, verification and cleanup. This removes the cross-database
decision gap. At that checkpoint canonical invocation joins, authenticated
acknowledgement/reconnect, durable delivery and full shipping Pi composition
remained open; the historical native `.3` proof does not attest this host delta.

## Canonical standing invocation joins

Standing task/mission approvals now admit each runtime/session join in the same
canonical acquisition store used by ordinary requests. The join has its own
acquisition identity and immutable invocation/presentation facts; the shared
human request retains its separate identity. Recovery and late waits read those
records. The process-local target join map and its separate wait/closure paths
are removed. Live observers use the existing acquisition presentation and
handover contract, rather than acting as the authority for an outcome.

A target decision commits its grant, standing request and all pending joined
receipts in one grant-owner transaction. The derived pending-join index is added
by the supported v14-to-v15 upgrade. Settlement scans bounded 64-row pages within
that transaction; a failure beyond the first page rolls back the entire answer.
A late admitted join reconciles the retained target outcome without issuing new
consent. Restoration can consume that outcome immediately; a direct wait then
reads the committed receipt even though no live projection remains.

Presentation failure persists each pending join's structured failure and gives
live observers the original error. The standing human request remains pending;
an explicit fresh invocation cycle retains the old receipt. Closing one known
session closes its joins without cancelling another session or the shared
standing request. Registered target retirement commits closed joined receipts
before cancelling the actual individual or grouped approval card.

Individual and grouped cards share one live presentation claim per standing
request. Group identity binds the selected plan and exactly the displayed
facets; overlapping groups cannot answer rows displayed by another card. Prompt
claims are acquired after title preparation and canonical pending-state checks,
so retirement or an intervening invocation cannot create a stale/duplicate card.
Cleanup releases only its own claim, including when an immediate retry starts
before an older failure's cleanup finishes. These claims are UI ownership, not a
second durable execution store or a persisted group presentation protocol.

Sixteen recovery regressions cover actual Node process exit, supported upgrade,
late/direct receipt consumption, runtime/session isolation, immutable coalescing,
synchronous/asynchronous presentation failures, immediate retry, multi-page
rollback, session/target retirement and overlapping/multi-plan presentations.
The affected 24-file cohort passes 597 tests; the final typed-fixture check passes
all sixteen tests. Host/workerd types, focused lint/format, dependency declarations
and template hygiene pass. Join recovery evidence (`target-acquisition-recovery-evidence.json`, private verification evidence)
records exact sources, reports, the direct-wait failure investigation and cleanup.

At that checkpoint authenticated shipping-owner acknowledgement/reconnect,
durable delivery, protected admission and full shipping Pi composition remained
incomplete. Its runtime-only wait API and best-effort wake hints did not prove
those contracts. These Node/host source tests do not attest the earlier published
`.3` native snapshot or close L14/product acceptance.

## Authenticated acquisition receipt boundary

The authority service now exposes canonical acquisition reads, bounded outstanding
pages and exact terminal acknowledgement. Runtime and session come from the
verified context installed by the dispatcher after live authority resolution;
no argument selects another owner. Missing authenticated context refuses access.
`awaitDecision` now uses that same exact runtime/session pair for live observers
and retained receipts. The store's runtime-only lookup is removed, and internal
wait callers pass their already sealed invocation session. Composed acquisition
leaves must also have the same runtime owner before admission or presentation.

`acquisitionReceipt` returns immutable admission facts and their binding digest,
with canonical pending/terminal state, outcome and terminal digest.
`outstandingAcquisitions` returns at most 64 unacknowledged records with a stable
created-at/identity cursor. Reading or waiting does not acknowledge consumption.
`acknowledgeAcquisition` accepts only the exact retained terminal digest for the
verified owner; pending, foreign and conflicting acknowledgements refuse. Failed
writes leave delivery due. A lost acknowledgement response can retry safely after
reopen without altering the original receipt or first acknowledgement.

Thirteen service regressions use the actual dispatcher, authority resolver,
service schemas and Node SQLite store. They cover forged inbound authorization,
foreign runtime/session reads/waits/acks, caller-selected scope arguments,
read-only containment, failed writes, reopen/retry, corruption and more than two
same-clock pages while earlier rows are acknowledged. Two additional coordinator
regressions refuse another session's ordinary and standing live/recovered waits
without disturbing their legitimate owner. A further regression refuses mixed
runtime owners in a composed ask before it admits any row, grant or prompt. The
affected 26-file cohort passes 615 tests. Host/workerd types, focused lint/format,
generated authority catalogs, dependency declarations and template hygiene pass.
Authenticated receipt evidence (`authority-session-receipt-evidence.json`, private verification evidence)
records exact sources, reports, generated census changes and fixture cleanup.

This is the host boundary, not completed shipping Pi consumption or redelivery.
The protected model port must use the invoking task's commit boundary to bind its
readiness receipt before returning a receipt wait; recursively opening the Session
from that port would create an ownership/dependency cycle. The receiver must read
host truth, verify its retained binding, commit consumption and then acknowledge.
Actual owner/incarnation admission, reconnect readiness, host/owner replacement
redelivery and full shipping composition remain gates. Best-effort wake hints
cannot substitute for these protocols. No external template or fork was changed
by this host checkpoint, and the published `.3` native proof does not attest it.

## Model-port transactions and explicit execution completion

`ModelRequestPort(request, api, context)` now receives a narrow
`ModelRequestApi.commit` capability through the invoking task's existing mutation
gate. It can bind readiness before returning a receipt wait without reopening
the Session from inside the port. Transaction writes retain the kernel-stamped
conversation/task attribution. Request completion, invocation termination and
cancellation close admission to this capability; a queued commit rechecks the
request on the mutation line. Already admitted transactions retain the ordinary
Session settlement contract.

Five new kernel tests cover receipt-wait SQLite replacement, a terminal outcome
before parking, commit failure/rollback with the original error, conflicting
admission and a queued commit after request completion. Existing ownership tests
also assert retained capability refusal while the task is still running and
after cancellation. The affected 13-file cohort passes 306 tests and the full
fork check passes. The complete four-library `.4` closure is published; registry
metadata, archive bytes, ordinary installation and ESM commit/close match its
immutable source identity.

Base pins `.4` and forwards the same capability through NativeAgentOwner's
detached protected port. Its new installed-package component test parks a
generation on a bound approval receipt, replaces the owner, consumes a controlled
terminal outcome and dispatches the original committed request once. All 24
owner and 23 transport tests pass, as do complete Base types, dependency ownership,
template hygiene and nine registry-installed receipt checks. These component
tests do not establish shipping host-backed approval consumption or delivery.

The source audit also found an explicit execution-completion gap. Generic
`authority.finishExecution` now authenticates the exact retained controller,
closes its canonical acquisition session synchronously, and only then removes
the live execution fact. A failed SQL closure preserves actionable prompts,
canonical pending receipts and controller retry authority, and propagates the
original error. Duplicate finish closes once; a foreign controller cannot close
another session. Eval cell completion still releases only its cell slot and
preserves notebook-history authority and approvals for subsequent cells.
Thirty registry/service tests pass, including actual SQLite/coordinator/approval
queue faults, with host/workerd types and focused lint/format checks.

Transaction and completion evidence (`model-request-commit-evidence.json`, private verification evidence)
records sources, commands, published artifacts and cleanup. The `.3` native
workerd proof remains historical and does not attest this new delta. Production
receipt binding/consumption, reconnect readiness, runtime-wide retirement and
incarnation-bound approval admission remain open. The audit confirms an actual
wake gap: startup can notify before routing is ready, and a healthy idle owner
has no guaranteed recovery from a lost hint. An ordinary host alarm nudge can
also be erased by Pi's legitimate null publication. Repair that existing
scheduling/delivery ownership before claiming loss-safe approval readiness;
another semantic operation queue or watchdog is not warranted.

## Host wake requests, original invocation projection, and fresh-state cleanup

The host wake store now retains an incarnation-bound request generation separately
from Pi's source schedule watermark, in the existing WorkspaceDO state/alarm
store. A legitimate null publication cannot erase it. Alarm claims capture the
request generation; the host-only `alarmComplete` transaction acknowledges a
successful pass and retains events arriving after the claim. Failed dispatch
rearming does not acknowledge requests. Old dispatch/incarnation tokens cannot
consume new requests. Completion returns the actual remaining wake so diagnostic
events do not report a clear while a later request remains pending. No timer,
expiry, semantic task queue or pre-release schema migration was introduced.

Nine wake-store tests, eleven driver tests and 88 WorkspaceDO tests cover null
publication, early/late events, replacement/adoption, stale claims, SQL rollback,
exact retry and entity retirement. Public/engine schema and direct-authority
tests keep requests and successful-pass acknowledgement host-only. The affected
ten-file cohort passed 166 tests before the final added SQL-completion rollback
case; the final WorkspaceDO cohort then passed all 88 tests. These are source
component proofs, not native process-loss or shipping approval delivery proof.

Canonical authority receipts expose a typed `invocations` projection of the
host-sealed original code/runtime/session, operation, snapshot and approval
facets. The host validates the stored inputs and snapshot digests; Base does not
parse private persistence formats. The actual public receipt fixtures now seal
real invocations, retaining the security, pagination, failed-acknowledgement and
corruption assertions. The 53-test affected authority cohort passes.

Configured Base now binds that public projection through the original model
request's transaction capability. NativeAgentOwner authenticates receipt hints,
reconciles outstanding canonical receipts before alarm/restart execution, and
commits consumption before exact acknowledgement. A single post-binding reread
closes settlement racing initial read/commit; retained terminal metadata rejects
changed state/digest/timestamp even when result content matches. Unknown IDs
remain unbound and unacknowledged. The owner/session cohort passes 39 tests and
complete Base composition/host integration types pass. These are controlled
components; the actual credential/provider model port and production subclass
are still absent.

The fresh-state cutover removes the historical target-approval importer, its
legacy v5 schema, import-seal table and dead historical database layout path.
Current target-approval DDL belongs directly to the grant owner. Five focused
files pass 29 tests for current approval transactions and recovery. Existing
owner migration machinery remains; historical upgrade support is not a cutover
gate. Earlier import evidence above records superseded work, not shipping scope.

Receipt and wake component evidence (`approval-receipt-wake-evidence.json`, private verification evidence)
records exact source hashes, verification witnesses and limits. Canonical
in-band/owner-redrive delivery ownership and presentation shutdown are being
repaired separately; this packet does not attest that unfinished host work.

## Concrete shipping composition gaps

The host lifetime boundary now has an implemented component contract. WorkspaceDO
assigns a canonical `authoritySessionId`, retains it across activation replacement,
and renews it only after exact-lifetime retirement cleanup completes. Stale
completion cannot clear a later lifetime. Ordinary DO authority resolves this
canonical active record; retained SQLite identity is a separate storage fact.
One cleanup owner joins resource and credential release before completion, and
shutdown joins its flights. The 511-case, 22-file
host lifetime checkpoint (`entity-lifetime-owner-evidence.json`, private verification evidence)
records the original fixture failure and its exact repaired rerun. One exact
real-workerd entity round-trip also passes retirement/reattach and stale-completion
fencing; the isolated startup doctor passed and its managed instance was stopped.
This does not prove shipping native-task retirement or whole-context destruction
concurrency. Finite-session presentation joins have a subsequent checkpoint below.

Canonical approval delivery now distinguishes in-band observation from durable
owner redrive. A dedicated terminal-debt index supports recovery, native owners
receive durable wake requests, and exact-owner closure joins its presentations.
The checkpoint above attests those components; the older receipt/wake checkpoint
does not attest the later delivery changes. The later
terminal presentation checkpoint (`terminal-presentation-ownership-evidence.json`, private verification evidence)
closes the finite-session gap: owner, runtime, session, agent and global closure
share cancellation/finish/join ownership; execution-finish and permission handlers
await it. Repeated closure joins the same flight and failures propagate after
owned work joins. Its 172 cases across ten files pass, including late title
preparation. It does not establish native task/domain teardown or product cutover.

The fork also implements atomic submission payload factories, knowledge-only
history export/import, and task-owned model endpoint preparation. The affected
24-file cohort passes 490 tests and the full prescribed fork check passes. These
primitives close kernel API gaps. All four `.5` archives are now registry-byte
verified, install together outside either repository, and pass ordinary ESM and
Harness commit/close smoke checks. Base pins the three direct libraries exactly
to `.5`; projected behavior/type checks and product integration remain separate
gates. The immutable publication receipt (`releases/0.99.2-vibestudio.5/publication.json`, private verification evidence)
records the source digest and scratch cleanup. History import here means
forking knowledge created by the new system, never migrating pre-release state.

The installed `.5` Base cohort passes 93 tests across provider, transport, owner,
session and native channel admission. It includes real SQLite lifetime handover:
active lifetime changes refuse, clean logical retirement permits a new canonical
authority lifetime, and context/storage identities and history remain unchanged.
Live tasks and queued inputs require cancellation and joining first. This is
new-system lifecycle behavior, not backward compatibility. Native channel
admission atomically binds the channel/context/conversation and consumes feedback
with the genuine native submission; product event classification and publication
still need shipping integration.

Native invocation provenance also has source component proof: one task-owned
immutable fact derives from actual committed model/tool intent, existing channel
publication supplies the source coordinate, and the host verifies the current
owner/image/lifetime and native task before Eval/VCS admission. The affected host
cohort passes 298 tests; four real-kernel Base source tests pass. Exact per-task
approval withdrawal and full shipping caller composition remain work in progress.

RuntimeService retirement invokes the lifecycle phases across the whole affected
context before canonical retirement: quiesce every owner and drain admitted alarm
RPCs, settle every peer-facing obligation while peer services remain available,
then close local resources before relay sealing and durable row retirement. Peer
obligations include terminal publication and unsubscribe; the final release phase
does not begin until all owners have settled them. Quiescence seals new input,
but restoration of the same host-bound Session remains available for retained
peer obligations, invocation inspection, and authority/Eval receipts. A fresh
activation must restore its durable owner during peer preparation; an empty
connection cache is not evidence that its obligations are settled. Settlement
admission seals only at final release. Single-entity retirement and
planned suspend/restart use the same phase order. This prevents an early resource
owner from closing a peer-facing service while another entity still uses it. The
separate transition gap is concurrent create/recover/retire using different
serialization owners, not a missing normal release hook.

At this historical review checkpoint NativeAgentOwner had no production
subclass and AgentVessel/AgentWorker still selected the old engine. The current
shipping source now selects NativeChannelOwner. This earlier review required
carrying product behavior through native ownership, rather than treating an
unused native base as cutover. The following are
actual integration gaps exposed by that review:

- Bind the shipping native owner to the canonical authority lifetime described
  above. Logical retirement must cancel and join its domain tasks and receipt
  waits before retained storage can reopen under a new lifetime. Component host
  fencing alone does not establish that product teardown contract.
- Protected model admission uses the real `credentials.resolveCredential`
  invocation. Credential consent, credential reconnect and endpoint preparation
  have distinct authoritative owners. Resolve provider-configured or loopback
  endpoints before committing the model request; retain activation-local keys
  and owned extension teardown. A factory that rejects supported reconnect or
  loopback paths does not fulfill product cutover.
- Tool Eval and VCS calls require canonical channel/source causality and stable
  command identity. Native task/call IDs alone are not host-verified provenance.
  Bind or publish the source invocation before domain admission and retain its
  exact provenance through receipt recovery and cancellation.
- Wire the new knowledge-only history transfer into authenticated cross-entity
  product forks, at the exact selected source frontier. Copying the ExecutionOwner
  or raw database cannot create an independent native owner.
- Product input admission must consume delivery/feedback obligations atomically
  with native submissions. Customized tools, hooks, status/cards, method calls,
  automations and domain alarms must use that same native authority. In
  particular, Gmail's domain scheduling and direct model calls, Adventure's
  old-driver queue inspection, News's old turn IDs/closure metadata and Explorer's
  visible narration policy need explicit replacements.

These remain implementation/design work under the outcome-first plan. Component
tests and published libraries do not close these shipping gates.

## Invocation failures retain ownership

Failed observation or cancellation of an admitted operation retains its handle,
request, checkpoint, memos and cancellation intent. The scheduler records an
immutable failure incident and parks in the existing run/abort wait mode.
Ordinary owners and placed inputs remain unfinished. Task/idle callers receive
the original activation-local error; replacement exposes the persisted diagnostic.
Unrelated scopes and background boundaries remain independently serviceable.

`retryTask` accepts the exact incident identity. Duplicate/stale repair cannot
retry a newer failure or cross a changed cancellation intent. No timer, automatic
retry or second failure channel is involved. Missing/incompatible cleanup code
retains its checkpoint on a registry wait until compatible publication; absence
of code cannot retire owned documents or settle the run.

Generation always attempts deferred cancellation through the same request port
and Models service. Provider/access/poll/connection-close failures retain the
committed handle through SQLite replacement; repair polls that operation and user
cancellation cancels it. Neither path resubmits generation. Ambiguous error/aborted
poll messages and observed usage commit with the incident rather than activating
model retry policy. An `AssistantMessage` error alone is insufficient evidence
that the remote operation ended; shipping provider integration still needs an
authoritative terminal-outcome contract.

Tools apply the same boundary to committed continuations. Selection, environment,
execution and rejected result-commit failures retain the admitted operation.
Failed execution/cancellation commits the latest bounded output counters, details,
diagnostics and checkpoint atomically with the incident. Pending details updates
receive the original failure. Repair reattaches to the same operation with the
same arguments; explicit cancellation invokes its cleanup contract. The owning
generation cannot settle or append a tool result before successful resolution.
Restored diagnostics are not appended again by resumed progress publication.
Ordinary first-invocation errors retain their existing tool-error behavior;
unsafe interrupted work without a continuation does not become replayable.

`parkFailure` can stage document writes and return an updated checkpoint in the
single failure transaction. A rejected transaction rolls back those writes,
seals dispatch and joins invocations; waiting callers/pass drivers receive both
the invocation and storage errors. The last committed checkpoint remains the
authority. No terminal outcome is manufactured from failed persistence.

Nine tool-continuation/progress regressions, nine cleanup regressions, seven
polling regressions and the affected nineteen-file, 381-test cohort pass; the
full prescribed fork check passes. Recovery, ownership, structured-task and
compaction tests prove cleanup precedes input/live-status/document retirement.
Blocked compaction survives SQLite replacement and completes under compatible
code without sending a summary request. Two resident-timer regressions prove an
early or platform-capped callback rearms the original durable deadline; this is
deadline scheduling, not failure recovery by timeout.

Current evidence (`tool-failure-evidence.json`, private verification evidence) records
source hashes, commands, reproduced failures and limits. The earlier
polling (`poll-failure-evidence.json`, private verification evidence) and
cleanup (`cleanup-failure-evidence.json`, private verification evidence) receipts are
historical source checkpoints, not attestations of this changed kernel.

At the historical `.3` checkpoint, all four immutable libraries were verified published and Base pinned `.3`.
The release receipt (`releases/0.99.2-vibestudio.3/verification.json`, private verification evidence)
records registry bytes/installation, installed declarations, complete Base types,
46 owner/transport tests, nine receipt fault checks and native revalidation.
All seven native component gates pass; the product gate remains open. The fixture
and managed instance were retired. The new failure regressions use controlled
handlers and Node SQLite; the native run revalidates the installed foundation,
not every failure interleaving through shipping services. Physical remote
release, cleanup retention across process loss, durable approval readiness and
full product cutover remain. Initial remote-admission uncertainty, protected
operation pins and authoritative provider outcomes still require product proof.

### Exact dependency resources for the installed typecheck extension

Checkpoint 31's existing `extension-typecheck-unit` case reached the canonical
extension and its public `check` method. It failed because the extension tried
to run the host npm installer inside its sealed native process and required
`VIBESTUDIO_APP_ROOT`. The original failed invocation remains evidence; this was
an ownership defect, not an argument for inheriting host environment or granting
the checkout. Checkpoint 31 was stopped and its temporary instance root removed.

The duplicated extension installer, dependency-version comparator and private
cache have been removed. `build.prepareTypecheck` resolves one unit at an
exact semantic state through the canonical closure/override/patch resolver and
existing script-disabled host installer. Native admission holds the acquisition
lease through immutable projection and exposes only the acquired environment
read-only. Host installed roots never become guest grants. Build shutdown joins
preparations; native retirement joins projection and removes its owned resources.
The source revision and explicit dependency paths participate in compiler reuse.
The authority row is explicitly reviewed, website callers are closed, and the
catalog/runtime documents are regenerated from the schema.

Focused verification passes: all 37 extension cases (including changed-context
dependency declarations), all 16 affected host/template build cases (including
exact transitive dependency selection and joined shutdown), two real native
runtime cases (third-party declarations, denied source-host reads and guest
writes, compiler diagnostics and owned retirement), 18 service/census cases,
and host/Workerd and complete System composition typechecks. The larger focused
host cohort has 89 passes and one artifact-read failure caused by concurrent
rebuilding of `extension-host`; the isolated native rerun passes both cases.
The first new compiler fixture also emitted an unused-variable info diagnostic;
exporting its value repaired the fixture without weakening assertions. Two stale
local-model test imports now use the already canonical protected provider-auth
function; the deferred live local-model scope is unchanged.

Checkpoint 32 doctor passes with the 227-case installed catalog and the repaired
composition. Its existing installed extension case is being revalidated. Full
catalog acceptance, immutable template release, product cutover evidence and
root/template commits and pushes remain. No new installed expansion scenarios
have been added ahead of the user's requested commit/push boundary.

Checkpoint 32 completed `extension-typecheck-unit` without failed tool calls,
but the validator failed on missing diagnostics in the oversized return. The
extension actually checked `panels/chat` and reported 1,347 errors, including
missing SDK modules and React/JSX declarations; its approximately 710 KB result
was correctly bounded by eval. This exposed a genuinely incomplete compiler
environment. It is not accepted as a pass or repaired by exempting truncation.
The full exact trajectory was retained, then the instance was stopped and its
temporary root removed.

The preparation contract is now `build.prepareTypecheck`. Compiler source graphs
include declared development dependencies and selected installed SDK packages,
while executable runtime composition retains its smaller graph. Both use the
canonical external dependency resolver. Native admission copies only SDK public
export roots, excludes package-manager workspaces, and makes independent copies
that do not change when host source changes. Exact module conditions accompany
the resources. Native checks now exercise an SDK declaration importing a
third-party declaration, denial of source-host reads and guest writes, omission
of a package-manager file, concurrent admission reuse and owned retirement.
Twenty-one native/materializer/service checks, 61 graph/dependency checks, all 37
extension checks, the exact-context preparation/shutdown regression, and host/
Workerd and System composition typechecks pass. The authority row and generated
documents have been reconciled to the compiler-specific contract. Checkpoint 33
is being provisioned for a deterministic service probe before spending another
agentic acceptance turn. No new installed expansion scenarios were introduced.

Checkpoint 33's deterministic canonical `checkPanel("panels/chat")` invocation
completed and reduced the 1,347 errors to five stylesheet-import errors (nine
informational suggestions were also returned). This exposed the extension's
missing bundler asset contract, which exact-state build reports already use.
The extension now loads those same shared declarations as compiler overlays,
along with authored workspace ambient declarations. It does not write generated
files or suppress diagnostic codes. Two conventional regressions prove assets
under a restrictive source tsconfig, unsupported imports and real type errors,
and authored declarations outside the unit. All 39 extension checks and complete
System composition typechecks pass. The probe session was explicitly detached
and its context removed; checkpoint 33 was stopped and its root is absent. Fresh
installed service proof and agentic acceptance follow in checkpoint 34.

Checkpoint 34 doctor passes against the 227-case installed catalog. The same
canonical installed `checkPanel("panels/chat")` probe now completes with zero
errors, zero warnings and nine informational suggestions. Its probe session
and context were explicitly removed before agentic verification. This proves
the missing dependency and asset environment repair in the actual sealed native
service; the existing `extension-typecheck-unit` agentic case is now running.

Checkpoint 34's existing installed `extension-typecheck-unit` case passes:
`st_9e11d22aa87647c0b1fc0da421363b82`, 63.983 seconds, zero failed tools. The
missing compiler environment is now closed through both deterministic installed
service proof and ordinary agent discovery/invocation/diagnostics acceptance.
The original failed runs remain evidence. Existing cancellation, explicit eval
deadline and agent-vessel crash/replay checks are next; these do not add installed
coverage before the requested commit/push boundary.

Checkpoint 34's existing `eval-cancel-run`, `eval-timeout-error-visible` and
`eval-agent-replay` cases all pass (`st_8d86f79d672446ec8b2c0f160ce1a7b9`, 51.277
seconds, zero failed tools). The remaining 206 installed cases are running at
concurrency three on the otherwise idle host. The selection keeps four current
passes, nine explicitly lower-priority local-model/self-development cases and
eight cases needing another supported composition separate; it does not count
exclusions as passes or repeat the four current proofs without cause.

Checkpoint 34's broad selection was explicitly cancelled once a canonical card
projection defect was established: native source/originating-input attribution
was retained in channel events but dropped from derived chat cards. Multi-session
orchestrations retained author messages but only the reader's diagnostic snapshot,
so the dropped identities could not be independently joined. The final repair
checkpoint is `st_c35648b9c76949b79c2b53a04d078746`: 79 completed cases, 40 passes,
34 failures and five errors, eight unexpected failed tools across seven cases.
Cancellation outcomes must be distinguished from preceding failures. The other
127 selected cases are untested. All 39 failure/error trajectories are retained
privately with a bounded classification index; the cancelled run joined, the
managed instance was stopped and its root is absent.

The canonical card now retains attribution in both structured and serialized
forms. Headless snapshots consume it directly, eliminating the lookup through
another view. All 71 chat-projection checks pass. The existing injected-memory
validator is being strengthened to join the actual retained author request and
native operation independently, with exact hash/path/range and typed roots. An
agent-supplied `stated` intent is distinct from the original trigger; preserving
that distinction must not cause rejection when the original request is retained
and independently joined. Consumer and composition checks and fresh installed
proof remain. This shared repair does not excuse the other failures, including
a genuinely wrong automation stop timestamp, incomplete inspections and
incidental failed API calls. No new installed scenarios have been added.

The attribution consumer checkpoint passes all 70 helper, memory-validator and
headless-session checks, and the complete System-testing composition typecheck.
The validator joins native author identity and the original retained input while
preserving the separate meaning of agent-supplied stated intent.

The captured `load-headless-sessions` cleanup error reported queued inputs, but
the retirement predicate actually rejected every inbox item. Pi's public abort
contract deliberately withdraws executable inputs and preserves passive history
writes for later placement. The owning source now uses that distinction both at
retirement and at a subsequent canonical-owner admission. Cleanup also finds
queued prompts through the retained conversation inventory, including an input
left after a failed run with no live channel subscription. It uses public Pi
conversation cancellation and joins reached work; it neither edits away inboxes
nor fabricates a boundary to flush history. A SQLite reopen regression proves
that passive writes remain queued across retirement and settle at the next
ordinary submission boundary. All 17 focused lifetime, cancellation and child
settlement checks pass. The initial draft deliberately failed on passive-history
admission and was corrected at the same ownership contract before installed
verification. Checkpoint 35 Base composition and fresh installed acceptance are
next; this is not a full-suite or release verdict.

Checkpoint 35 doctor, Base composition typecheck and template-checkout hygiene
pass. The two-case installed checkpoint completed without tool failures
(`st_0582bbcdf1654e1693131b0f91294714`, 52.496 seconds), but both validators
rejected legitimate results. The child fixture now closes without queued-input
or other cleanup errors. The memory case independently joins native author
identity and original request, with exact hash/path/UTF-16 range and typed roots;
its agent-authored intent paraphrases the original request rather than copying
it verbatim. The old intent substring and final-word-distance predicates rejected
that legitimate evidence. Those prose constraints are removed while identity,
range, nonempty recorded intent and a discriminating final observation remain.

The child diagnostic fixture represented an in-progress assignment, not an
actually withheld tool result (`tool` was null). Its label now states the real
fixture. The validator joins a successful bounded `read_subagent` page to the
exact retained child identity and checks the agent's observed state, rather than
requiring arbitrary “bounded” or “recent” wording. Foreign-child and prose-only
claims are rejected by conventional regression checks. All 43 related validators
and the complete System-testing composition typecheck pass. Both private full
trajectories were captured before stopping checkpoint 35; its root is absent.
Fresh installed acceptance follows in checkpoint 36. No installed cases were
added, and the remaining catalog/release obligations are unchanged.

Checkpoint 36's fresh installed injected-memory case passes (78.739 seconds)
with native author/original-input joins, exact range/hash roots and paraphrased
recorded intent. The four-case run completed with one pass and three validator
failures, zero failed tools (`st_abd9bcb98cab4017a39903e3ec6a574d`, 231.826
seconds). Both notification workflows completed two successful durable runs and
two owner notifications. The scheduled proof captured pending terminal cards
before ordered publication had finished. Tool-terminated answers may have been
published before the terminating tool completes; a durable ledger receipt does
not establish that the headless peer has consumed every terminal event. The
watch prompt also did not require a deterministic check, and the agent chose a
valid prompt executor for its stated request instead of the watch mechanism the
validator intended to exercise. The child inspection was correctly identity-bound
and bounded, with clean retirement, but another legitimate paraphrase failed the
status-word predicate. All three private failure trajectories were captured;
checkpoint 36 was stopped and its root is absent.

The owning harness now exposes `waitForInvocation` as an event-driven presentation
barrier for an already retained identity. Scheduled proof joins its exact pending
terminal-card obligations before capturing final evidence; the no-incomplete-call
assertion remains. This neither synthesizes success nor waits by elapsed time.
Native session observations are owned operations: close/dispose cancel their
lifetime, explicit disconnect cancels current observations, and cleanup joins
them before releasing the connection or remote session. Conventional checks
cover exact identity, authoritative disconnect and joining an aborted native RPC
before remote retirement. The watch user goal now explicitly requires checking
without AI and waking an agent only for an available update, without naming tools
or protocol recipes. Child diagnosis checks the observed assignment rather than
status synonyms. The first 75 focused checks pass; the delivery-before-capture
regression, complete composition and fresh installed proof follow in checkpoint 37. No new installed scenarios have been added.

Checkpoint 37 doctor passes. Its installed `load-headless-sessions`,
`automation-scheduled-notification` and `automation-watch-notification` cases
all pass with zero failed tools (`st_4597aaa9787a476687137e1ef5ddd863`, 185.195
seconds). The watch validator verifies the actual watch executor; both notification
proofs verify two successful durable runs, two owner notifications and no
incomplete terminal cards. Together with checkpoint 36's injected-memory pass,
this closes the focused attribution, retained-child retirement and publication
readiness defects. All 64 session/notification checks, the delivery-before-capture
regression, complete System-testing typechecking and checkout hygiene pass. The
managed instance was stopped and its root is absent. Counts overlap and are not
a full-catalog or release verdict.

The next captured filesystem mismatches expose underspecified fixture data and
shape-based grading: append assumed two newline-separated pieces; recursive
listing assumed exactly two bare strings; metadata demanded modification time
that the prompt did not ask for. The existing user goals now carry concrete
log entries and file identities, and explicitly request size/modification time
for known five-byte content. These are ordinary task data, not tool recipes or
receipt markers. Append accepts the ordinary handle route and validates retained
content order; directory inspection accepts recursive Dirent names including
its directory without treating that as an extra file. Outcome data is restricted
to completed calls that exercised the filesystem operations, so unrelated help
output cannot supply proof. Existing unexpected-tool-failure accounting remains
unchanged, including the original invalid handle-read attempt. Conventional
positive/negative regressions and fresh installed acceptance follow in checkpoint 38. This repairs existing cases; post-push suite expansion remains deferred.

Checkpoint 38 conventional filesystem validators pass all 61 cases, including
focused write/read around a real handle append. Complete System-testing and
host/Workerd typechecks pass. Desktop startup/approval coverage completed with
two failures and one warm-trust pass. The shell was ready; chat was blocked by
model inventory because the approval test's real HTTP model fixture failed its
extension build smoke. The production local-model extension passed an isolated
native reproduction. The actual fixture registers an HTTP server disposer, but
the smoke driver activated it without ever running disposal. This left the child
alive until its existing watchdog rejected. The run's cleanup ledger confirms
retirement; its temporary root and owned display process are absent.

Checkpoint 39 smoke now exercises import, activation and the installed shutdown
contract: every registered subscription and module deactivation is joined even
when activation fails. Original activation and cleanup failures are preserved,
and one failing disposer cannot prevent other resources from retiring. Five
focused native smoke/builder checks pass, including the exact approval fixture's
real HTTP server, failed activation with multiple cleanup failures and a failed
disposer after successful activation. The production extension and reproduction
runtime were stopped and their scratch root removed. The two affected desktop
cases are being revalidated; no installed cases have been added. The existing
native job watchdog itself has not been extended or substituted for cleanup.

Checkpoint 39 closes the extension smoke failure in actual desktop launches.
Both cases progressed into native agent execution. Onboarding's evidence reader
incorrectly required native task metadata on nested channel-transport invocations;
that schema error aborted the test and began teardown while the agent was still
running. The subsequent authority-parent failures were captured during teardown,
not established as the initial defect. The reader now distinguishes the declared
channel transport while retaining exact native source/owner/channel/identity
checks. The HTTP fixture now uses the eval runtime's credential-aware fetch API
instead of an absent global. All seven fixture/evidence/native-smoke checks and
host/Workerd typechecks pass. Checkpoint 39 cleanup completed; its root and owned
display process are absent.

Checkpoint 40 delivered and completed the real onboarding turn, read its shipped
skill and rendered the setup overview. Its obsolete UI predicate searched for a
stable ID in text instead of the actual `data-inline-ui-id`, then expected a
removed link label. The predicate now selects the stable component identity and
its current Add workspace link. The network case exposed a product contract gap:
`InvocationSnapshot` and its digest retain `nativeInvocation` and `causalParent`,
but the strict pending-approval wire schema rejected those fields. The wire schema
now preserves the typed native identity and exact causal coordinate. Eval admission,
authority receipts and approvals share the same strict causal-parent schema;
malformed and unknown fields remain rejected. All 36 affected contract, snapshot,
approval-service and evidence checks pass. Checkpoint 40 cleanup completed; its
root and display process are absent. Current desktop acceptance follows in
checkpoint 41. These are repairs to existing coverage, not the deferred installed
suite expansion, and not a full catalog or release verdict.

Checkpoints 41–43 establish a genuine channel-publication lifetime defect, beyond
checkpoint 39's teardown-only evidence. A failed model terminal publication left
later durable publication tasks waiting behind it. The safe RPC diagnostic
identified `workspace-state.alarmSet`: Base's runtime drained causal operations
before starting its derived wake publication, then retired the invocation's
transient authority. The host runtime already joined wake publication inside the
same scope. Base now follows that ordering, and a held-write regression verifies
that the request remains open with its exact authority parent until the write
settles. All 37 Base runtime tests pass. Fresh desktop network acceptance remains
in progress; the change is not yet a completed release gate.

The successful inline UI now exposes the same stable component and message
identity as its error presentation. All four inline UI component tests pass,
including stable identity after recovery. Desktop assertions now reflect the
current Add workspace/Create workspace route and task-scoped network grant
choices; they do not require a website-session grant on an agent task. Checkpoint
43 reached the network approval and then stalled on the publication defect before
that source repair. Checkpoints 41–43 cleanup completed with owned temporary roots
and display processes absent. No installed agentic cases were added.

Checkpoint 44 passes the actual desktop scoped-network approval flow (one case,
1.1 minutes): the user decision unblocks the credential-aware request and the
same native agent turn completes. Its owned temporary root and display process
are absent. This closes that exact publication/approval acceptance boundary;
full catalog, onboarding routing, release publication and pushes remain open.

Checkpoint 45 confirms completed onboarding with no reproduced inactive-parent
failure after the Base repair. Its remaining failure was the test's navigation
assertion: captured desktop evidence shows the Create a workspace dialog open,
while the test queried a retained launch page for a later-stage submission button.
The test now identifies the actual visible chooser dialog and closes it through
its own named control. It does not require catalog retrieval or creation to prove
this navigation goal. The owned root and display process were retired. Fresh
onboarding acceptance follows in checkpoint 46.

Checkpoint 46 passes actual desktop onboarding (one case, 1.0 minutes): shipped
skill read, completed native turn, stable overview rendering, Add workspace
navigation to the visible Create a workspace dialog, and explicit chooser close.
Its temporary root and display process are absent. Both repaired desktop cases
now have current-source passing evidence. Full installed catalog and immutable
release gates still remain; no installed cases were added.

Checkpoint 47 passes host/Workerd and Base composition typechecks and external
checkout hygiene. Checkpoint 48's fresh managed doctor passed all seven gates;
the catalog remains 227 cases. Installed file-stats passed. Append-file completed
without tool failures and returned the exact preserved prefix plus appended entry,
but the validator rejected its ordinary focused edit path. The applied scratch
mutation receipts and later read of the same path prove the goal; the validator
now accepts this proof while rejecting replacement of the first entry, a foreign
read path, a conflicted edit, missing initialization or missing readback. All 62
semantic-validator tests and System-testing typechecks pass. Directory-ops created
and inspected the requested tree after a generated-code quoting error, so it
correctly remains failed under the unexpected-tool-failure gate; no exemption or
prompt recipe was introduced. Full failure captures were retained privately and
checkpoint 48's exact instance/root were stopped/removed. Fresh installed
append/directory acceptance follows in checkpoint 49.

Checkpoint 49 passes installed append-file and directory-ops (two cases, 25.365
seconds, zero failed tool calls). Together with checkpoint 48's file-stats pass,
this closes all three filesystem acceptance repairs. The fresh instance passed
all doctor gates and was stopped; its temporary root is absent. The catalog stays
at 227 cases. These are repairs to existing validators and coverage, preceding
the requested post-push suite expansion.

Checkpoint 50 passes all 37 Base runtime checks with a stronger wake-continuation
regression. A negative control restoring the old ordering fails that exact case:
the RPC after the alarm write settles has no authority parent. The fixed source
was restored in a finally block and Base composition typechecks pass. This is
proof of the lifetime ordering, beyond merely holding the HTTP response open.

Checkpoint 51 selected 130 cases: 127 previously untested cases plus three
unidentified passing receipts from the cancelled broad checkpoint. It completed
89 cases: 48 passed, 39 failed and two errored, with 15 failed tool calls. The
remaining 41 selected cases are unverified. All 41 failed/error full captures
were retained privately without capture errors. This is not a green acceptance
verdict.

The checkpoint was explicitly cancelled to repair confirmed source and fixture
defects. A performance case had an active provider generation without an
authoritative terminal outcome; elapsed time does not establish a provider
failure. That case remains unverified. Cancellation completed, the owned
Electron client was interrupted and joined, and the managed instance was
stopped. Its exact instance root and client root, and the client parent process,
were verified absent.

Checkpoint 52 repairs the shell's default cwd: use the admitted caller context's
materialized folder, or the canonical workspace folder for a contextless caller,
rather than potentially nonexistent extension-private storage. Thirty focused
shell checks and Base composition typechecks pass. Three real child-process
regressions cover contextless, inherited-context and explicit-context execution
with absent private storage. The terminal scenario now requires actual returned
output and exit code zero; final prose alone cannot establish execution.

Scope projection and intentional malformed-request/package-import failure
declarations were repaired against the observed canonical results. Focused
validator checks pass; fresh installed acceptance is still pending. The
disposable DO fixture's unsupported per-object environment assumption and
cross-eval lifecycle evidence remain open.

Checkpoint 52 fresh installed acceptance passes all four targeted cases:
`concurrent-scope`, `eval-extra-argument`, `invalid-import`, and
`terminal-extension-capability-acquisition`. Run
`st_c39c688b0996499883b3a78f1fad1459` completed with four passes, zero failures,
zero errors, zero failed tool calls, in 92.838 seconds. The managed instance was
stopped and its exact temporary root verified absent. The remaining catalog
failures and queued cases are still open.

The worker lifecycle repair observes the canonical `runtime.listEntities`
inventory for the exact unique fixture source before validation and before
fixture cleanup. Cleanup cannot pass merely because creation and destruction
were written in one evaluation, or because agent-authored result keys claim
retirement. A live instance fails independently; separate evals are allowed.
Observation errors propagate as failures. The disposable DO fixture now reads
its probe from canonical initial `STATE_ARGS`; unsupported creation options
are rejected instead of silently stripped. Fresh installed worker acceptance
is pending. The installed catalog remains at 227 cases.

Checkpoint 53 passes 147 runtime contract/service checks, 85 focused
worker/runner/fixture checks, System-testing composition types, and template
checkout hygiene. Fresh installed run `st_160ee7e566e4499aa81482d47064064c`
passes the disposable DO probe; SQL persistence initially fails its validator
with zero failed tool calls. Its full capture proves matching initial/later
row counts and content comparisons plus empty fixture runtime inventory. The
validator demanded returned row arrays; bounded comparisons are now supported
with negative checks for inconsistent counts and false comparisons. Fresh
verification of that repair is pending. Checkpoint 53 was stopped and its exact
root verified absent.

Current title/custom-message/extension invocation repairs replace unrequested
marker phrases and mandatory discovery choreography with actual applied title
receipts, canonical custom transcript/update events, and returned extension
results. They do not add installed scenarios or count the broad catalog green.

Checkpoint 54 passes 115 focused worker/chat/extension validator checks and
System-testing types. Its preparatory instance was retired after the last
source correction, before any agentic run. Checkpoint 55 reprovisioned the
corrected source and passes title setting, custom-message publication and
in-place custom-message updates. Run `st_a8881c8431e14ec994fa41ce6c01e2a1`
completed five cases with three passes, one failure, one error and two failed
tool calls. Its failure captures were inspected and retained privately.

SQL persistence chose shared resolution rather than owned creation and tried
to retire a borrowed instance; the authority boundary correctly required a
critical approval, which the test does not grant. Extension invocation called
runtime help and incorrectly described it as an extension; no actual extension
invocation occurred. Both remain failures. No blanket approval or validator
exemption was added. The managed instance is stopped and its exact root is
verified absent.

Further inspection identifies a concrete live-help defect behind the borrowed
DO choice: a nonempty raw workers service catalog suppresses fallback to the
canonical injected runtime method contracts. `help("workers")` can therefore
list owned creation without its signature/options/ownership guidance, while
raw resolution looks better specified. Help now prioritizes the canonical
portable runtime member catalog and supplements it with usage guidance instead
of replacing its contract. It preserves the original ownership boundary and
adds no critical test approval. Focused and fresh installed verification of
this discovery repair are pending.

Checkpoint 56 passes the 27 live-help checks and Host/Workerd types. Fresh
installed SQL persistence passes with zero failed tool calls in run
`st_930e59d2f3134fa08e88f4b4133de57d` (133.258 seconds), after canonical runtime
help restored the owned-creation contract. The instance was stopped and its
exact root verified absent.

The inline-UI investigation establishes a missing author read boundary:
resident delivery suppresses ordinary self-publications because they are
assumed locally known, but publication returned only a sequence number.
Publication now acknowledges the exact committed canonical event. The client
reads it through the common durable-event projection as a replay/read, without
executing methods again or changing the recipient self-wake filter. Concurrent
and deduplicated acknowledgements preserve the original committed fact. No
local UI substitute, second channel, or timeout was added. Inline UI validation
now joins the successful native method receipt to its actual transcript card;
action-bar validation checks successful load/clear receipts without private
marker phrases. Fresh installed UI acceptance is pending.

Checkpoint 57 passes all 171 focused channel/client checks, 30 UI validator
checks, and Base/System-testing types. Fresh installed run
`st_0877d89d44494e46bd52547672b0b987` passes both inline-UI transcript delivery
and action-bar load/clear with zero failed tool calls (40.804 seconds). The
managed instance was stopped and its exact root verified absent. This brings
the focused repairs in checkpoints 52–57 to eleven distinct installed passes;
it does not clear the remaining broad-catalog failures or untested selection.

Checkpoint 58 (3 October 2026) passes `turn-no-silent-stall-after-tool`,
with the publication repair installed. The catalog overview still fails: its
final answer correctly reports 51 registered services and representative names,
but the validator misses the raw RPC observation and a prior guessed named
`docs` import produces `guest_type_error`. Neither failure is waived. The owned
instance is retired and full failure evidence is retained privately.

The subsequent repair joins service totals to the enumeration's `.length`
rather than unrelated documentation-surface counts, accepts the canonical raw
RPC route, and retains negative checks for invented names and mismatched totals.
Live service documentation now clarifies that registered service names need
not be named exports of `@workspace/runtime`; raw RPC remains the canonical
method address. Conventional checks pass (32 semantic validators, 15 docs-tool
checks and 10 host catalog checks), as does the System-testing typecheck.
Fresh installed verification is pending. The remaining acceptance cases,
coherent publication and scoped commits/pushes remain open.

Checkpoint 59 freshly passes `extension-invoke-roundtrip`; all three selected
cases finish with zero tool failures. Automatic conversation titling remains
a genuine delivery miss (no title operation and no durable title), not an
accepted result. The catalog overview reads the canonical service-surface count
and reports observed service-method examples, but the validator still wrongly
expects a registered-service enumeration or search-result length. Acceptance
now recognizes either canonical observation, preserving the distinction between
service documentation entries and registered RPC services and joining examples
to actual bounded service hits. Negative checks reject other-surface counts,
invented names and counts without observed examples. All 33 semantic-validator
checks, the System-testing typecheck and template-checkout hygiene pass.
The checkpoint 59 instance is stopped and its temporary root removed.

The remaining UI-orchestration ownership gap is recorded: locally closing an
orchestration session before the shared runner captures diagnostics loses live
channel-delivery evidence. The eventual repair must put evidence collection
before owned teardown for orchestrated sessions as well as ordinary sessions;
a special UI-only bypass or fabricated projection is not acceptance evidence.
Fresh catalog acceptance is pending at checkpoint 60. The focused repaired
cases now include twelve distinct previously failing installed scenarios, but
the full catalog, publication and scoped commit/push gates remain open.

Checkpoint 60 freshly passes the bounded catalog overview with zero tool
failures (`st_84f102f13b4c4ba5bda9114ffede35d7`), clearing the thirteenth distinct
formerly failing installed case. The stronger-model title diagnostic
(`st_4772b1ebd7cd490a9153b4388536d718`) actually applies "Sunny Windowsill Herb
Garden" through a completed native title receipt, and the snapshot contains
that same durable title. The validator alone rejects relevant basil/thyme/chive
advice because it omits the exact word "herb". That requirement is removed;
the revised validator requires receipt/snapshot identity and relevant growing
advice, with negative controls for missing/unapplied titles. Its 34 conventional
checks and System-testing typecheck pass. Luna's earlier no-title delivery
remains recorded separately. Preparatory checkpoint 61 was retired and its
root removed before a fresh installed-source checkpoint; no test acceptance is
claimed for its doctor result. Checkpoint 60 is likewise stopped/root absent.

Checkpoint 62 freshly verifies the revised automatic-title case with the
explicit stronger-model diagnostic (`st_84dac525d4e94c6f9d2003b8462c51ea`):
one pass, zero failures/errors/tool faults, 20.195 seconds. This proves applied
receipt/snapshot identity and relevant advice; it does not claim default Luna
titling reliability. Its owned instance is stopped/root absent.

Checkpoint 63 repairs a real eval transport mismatch: `gatewayFetch` was
configured for direct authenticated HTTP although its evaluated runtime module
has no ambient `fetch`. It now selects the existing authenticated RPC stream
transport using the active execution-bound RPC client. No global fetch grant,
extra bearer path or timeout is introduced. All 66 eval lifecycle checks and
10 runtime gateway checks pass, as do Host/Workerd types. The regression checks
streamed gateway work after an old run retires still belongs to the replacement
run's causal parent and abort signal. Restoring the previous configuration fails
with the original missing-RPC transport error. The regression's readiness wait
now also observes actual early run completion, so that error propagates instead
of waiting for the unit runner's deadline.

Fresh installed consumer acceptance (`st_b5dfd0fca6d14964b55e77f4fd69ae44`)
still fails. It successfully builds and invokes the installed worker, obtains
`{ok:true,sessions:0}` from the real testkit service, and retires the worker, but
first guesses a bare `fetch` call, which fails. That tool fault is not waived.
The harness also misclassifies reading the published
`skills/system-testing/SKILL.md` guide as implementation inspection: its current
boundary matches every path under that skill, although ordinary agent routing
explicitly directs agents to available skill guides. That documentation/source
boundary needs repair without permitting validator or fixture implementation
reads. Compact server-log observations are another remaining false-negative
class: observed count/newest severity are valid bounded evidence even when raw
rows are omitted. These remaining repairs are not claimed complete. The full
consumer capture is retained privately, and checkpoint 63 is stopped/root absent.

Checkpoint 64 conventional checks repair the guidance/source boundary:
public Markdown skill/API guidance and metadata-only discovery are not reads
of test implementation. Reads and scans of executable harness source are
still detected, including fixture/validator source and eval filesystem reads.
The runner suite (36) and System-testing typecheck pass; checkout hygiene is
clean. The unchanged confined-eval networking contract is now stated in live
help as well as the existing sandbox guide: no ambient fetch, gateway-relative
HTTP through gatewayFetch, external HTTP through credentials.fetch. Gateway
routing/service and eval lifecycle checks pass together (89).
Fresh installed service-consumer acceptance is pending; prior guessed-fetch
faults remain recorded and are not granted an expected-failure exemption.

Checkpoint 64 freshly clears the installed workspace-service consumer
(`st_afc06d3dd7244cdeab1efb6a106a4467`): one pass, zero failures/errors/tool
faults, 209.033 seconds. The built disposable worker performs the real service
call and is retired; the owned instance is stopped/root absent. Fourteen distinct
formerly failing scenarios now clear on the default model route; the separate
stronger-model automatic-title diagnostic is reported independently.

Checkpoint 65 has zero tool faults but both log cases fail
(`st_ac14a14e2fed4980bc9f9428c920ddfb`). Tail returns the true count/severity via
destructuring, exposing the same shape-guessing flaw as earlier projections.
Query also reports 377 as the earlier statistics total although its real
statistics snapshot contains 367; that reporting error remains a failure. Both
full captures are private and the instance is stopped/root absent.

The repeated shape wall leads to a structural repair at checkpoint 66, rather
than another parser alternative. Native eval RPC dispatch now records a bounded
`server-log-observation.v1` fact in the existing per-execution operation journal
for successful tail/query/stats reads, before guest mutation or summarization.
It preserves the actual count, level histogram/newest severity, limits, boot
identity and sequence coordinates; statistics retain their own exact captured
total. It omits log text, fields and tag payloads. Sealed journals cannot accept
late completions, and the ordinary bounded journal owns storage/transport.
All three log validators consume these typed native facts; return-shape and
source-code inference is removed from their read verification. No legacy-evidence
fallback is added. Statistics totals are joined to the clause reporting the
overall count, so a later tail sequence does not establish that count.
Seven native-journal checks, 36 semantic-validator checks, Host/Workerd and
System-testing typechecks, and checkout hygiene pass. Fresh installed acceptance
for all three affected log scenarios is pending.

Checkpoint 66 freshly passes all three affected installed log scenarios
(`st_ab2ea4ae4e3f4fd7841db069f76f5c7d`): three passes, zero failures/errors/tool
faults, 145.852 seconds. This clears two further former failures and verifies
startup diagnosis through the same native-observation path. The owned instance
is stopped/root absent. Sixteen distinct formerly failing installed scenarios
now clear on the default model route; automatic title remains a separately
reported stronger-model diagnostic rather than an erased Luna miss.

Checkpoint 67 repairs the session-diagnostics retirement boundary. A generic
session-owner retirement observer runs inside the one idempotent close operation:
unsubscribe closes effect admission, model evidence is captured, the owner
observes native diagnostics, then the participant disconnects and its entity or
owned context is retired. A held observer prevents destruction; synchronous and
asynchronous observer failures retain their original cause while teardown still
joins. The scoped runner retains that exact observation promise, including a
failure, so later report collection does not retry an already retired service.
Ordinary runner cleanup now consumes the sealed diagnostic artifact after its
session closes; orchestrations use their existing session owner and gain the
same pre-retirement observation. No second close owner, retry, timeout or legacy
projection is introduced. All 80 headless-session/runner checks and the
System-testing typecheck pass; checkout hygiene is clean. Fresh installed UI
acceptance and inspection of the retained native delivery diagnostics are pending.

Checkpoint 67 freshly passes `inline-ui-transcript-event` and
`load-action-bar-transcript-event` (`st_51835321f5e34c128cbb6237d7203065`):
two passes, zero failures/errors/tool faults, 57.517 seconds. Both private full
captures contain native `execution.diagnostics.channelDelivery`, with neither
channel-delivery failure nor diagnostic-collection failure. This closes the
retirement-evidence acceptance gap. The managed instance is stopped and its
root absent; its ownership ledger records completed cleanup.

The 3 October upstream fetch advances `origin/main` from baseline `0f8740bb`
to `83692682`, including releases 1.0.0 and 1.0.1. Review finds relevant provider
replay, Anthropic tool-definition, capacity classification, OAuth failure,
model catalog/identifier and recursive readonly Chord fixes. No durable-engine
source change appears in this interval. No merge, new fork publication or
product repin is yet claimed by this review. The exact installed acceptance
inventory is in `durable-pi-installed-acceptance-remaining.md`.

Follow-up comparison against the fork's `UPSTREAM-ADOPTIONS.json` distinguishes
baseline divergence from missing fixes: OpenAI grammar-tool replay, Chord readonly
JSON and durable export conditions are already adopted in `.10`. Newly missing
changes are the later 1.0.1 provider/tool-definition/OAuth/catalog changes. A
baseline three-dot diff alone would incorrectly label the already-adopted fixes
as pending; compare current file contents and the adoption ledger.

Checkpoint 68 blob verification rederives acceptance from native operations,
using the existing bounded execution journal rather than named guest booleans.
Native put/get facts retain digest, independently computed UTF-8 content digest,
size and line count; range facts retain requested byte coordinates and decoded
size; grep facts retain bounded match counts. No document body or search pattern
is retained in this journal. This handles summary-only returns and UTF-8 partial
codepoint replacement without treating decoded byte size as requested span size.
The validator joins all four operations to one digest and requires exact full
read identity/size, a smaller in-bounds nonempty range and actual search hits.
Guest-only claims, wrong addresses/content hashes/sizes, whole-document ranges,
empty searches and truncated journals fail conventional regressions.

All 75 native journal/Eval lifecycle checks, 37 semantic validators, Host/Workerd
and System-testing typechecks and external-checkout hygiene pass. One first build
was invalidated because source formatting changed while inputs were captured;
the next build from stable sources passes. Fresh installed
`blob-text-roundtrip-grep` passes (`st_5313edab7a4b442da648a9cbff1a3ce3`):
one pass, zero failures/errors/tool faults, 30.188 seconds. Its private full
capture contains native putText/getText/getRange/grep observations. This clears
seventeen distinct checkpoint-51 failures on the default route. The existing
blob-tree case is being rechecked separately; it previously recovered from a
genuine object-versus-hash argument mistake, not a product storage failure.

Checkpoint 68's fresh blob-tree run (`st_20a8d40d8de84c4b8cea79e988535b7e`)
completes with one validator failure and zero tool faults (92.301 seconds).
Bounded inspection was followed by a private full capture: the agent created two
tree roots, listed the first complete tree, read a listed file's exact content
digest directly, diffed one changed file, and materialized/recursively listed
three files. The validator incorrectly prescribed `getTree/readFileAtTree` as
an extra traversal. No storage/product failure is attributed to that result.
The run and its diagnostics are retained; checkpoint 68 is stopped and its root
absent, with completed ownership ledger.

Tree acceptance now consumes typed native putTree/listTree/diffTrees/materializeTree
observations in the same bounded journal, preserving addresses, listing basis
and file metadata/diff but no file bodies. It joins a created root to a complete
listing and independently hashed actual file read, a distinct created version
with exactly one changed file and no additions/removals, and completed
materialization of either version. Guest mutation cannot change captured facts;
missing operations, wrong content identities and unrelated materializations fail
regressions. All 76 native journal/Eval lifecycle cases, 38 semantic validators,
Host/Workerd and System-testing typechecks and checkout hygiene pass. A regression
initially called listTree without its required request object; the test invocation
was corrected to the actual public contract, without changing production defaults.
Fresh installed tree acceptance is pending at checkpoint 69.

Checkpoint 69 (`st_792ec7dbb3a541a58a2356d1bd872290`) retains one tree-validator
failure, zero tool faults, 56.484 seconds. Native listing/read/diff facts all
join correctly. The missing materialization fact exposed an instrumentation
boundary mistake: the portable userland client composes CAS reads with scoped
filesystem writes and never invokes the admin-only host materializer. The
physical writes/readbacks completed correctly. Bounded inspection and private
full capture precede retirement; instance/root are gone and ownership cleanup
is recorded.

The materialization receipt now belongs to the actual shared portable operation,
after all pages, writes and mode changes settle. Its existing journal recorder
port is passed through the common hosted-runtime assembly and bound to Eval's
invoking execution, using the same callback as panel observations. No alternate
execution route or extra authority is added. Warm-cell regression verifies both
assemblies receive the same owner-bound recorder; scoped runtime regression
holds a filesystem write, verifies no premature receipt, then preserves the
original write failure without publishing completion. Ordinary paged copy also
retains exact written/unchanged counts. All 23 shared blobstore/assembly cases,
two journal cases and 76 native journal/lifecycle cases pass. Base composition
and Host/Workerd typechecks and hygiene pass. The panel journal test now asserts
complete reload entries rather than assuming every operation type has a panel ID.
Fresh installed verification is pending at checkpoint 70.

Checkpoint 70 freshly passes `blob-tree-lifecycle`
(`st_ef82857f5dc1479cbd117211e0a17403`): one pass, zero failures/errors/tool
faults, 62.318 seconds. Private full capture includes canonical created trees,
listing, independently hashed file read, diff and the scoped runtime's completed
materialization receipt. This clears eighteen distinct checkpoint-51 failures
on the default route; the default titling miss remains separately open.

Checkpoint 70 cleanup is complete: managed instance stopped, root absent, ledger
updated and private artifacts mode 0600. The plan's current assessment is
consolidated through checkpoint 70 rather than leaving superseded pending
paragraphs mixed with later acceptance. The next focused review is webhook
listing/lifecycle: the old listing returned an actual zero count that its
array-only validator rejected, and the lifecycle recovered from passing an
object to the ergonomic string-ID rotation helper. Live help/catalog ownership
and native redacted lifecycle facts require review before fresh acceptance.

Checkpoint 71 preparation repairs webhook contract projection and grading.
The ordinary docs generator now derives `WebhookIngressClient` signatures and
referenced public types directly from the configured Base source plus shared
types, using the existing runtime-client catalog generator. Public rotation and
revocation take string IDs; the object-shaped wire contract remains internal.
Live-help regression ensures raw wire schemas cannot override these source
contracts. The existing runtime-doc generation check passes; it writes no build
state into external checkouts.

Native webhook facts record created/rotated/revoked identities and listing
membership, without verifier configuration, secret values or secret fingerprints.
The list validator uses actual native counts even when the guest returns only a
summary. Lifecycle acceptance joins creation, active listing, rotation,
revocation and final absence by identity and actual operation order. The user
prompt now explicitly requests retiring the temporary subscription afterwards;
it does not prescribe methods or proof fields. No broad guessed-error
unavailability pass remains. Failures still require investigation and original
unexpected tool failures are not waived.

All 49 focused journal/help/surface checks, 39 semantic validators, Host/Workerd
and System-testing typechecks, generated-doc consistency and external-checkout
hygiene pass. Native regression proves list mutation cannot alter captured
membership and neither original nor rotated secrets/header configuration enter
the journal. Missing operations, foreign rotation IDs, secret-bearing guest
returns, invented counts and guest-only summaries fail validator regressions.
Fresh installed webhook verification is pending on owned checkpoint 71.

Checkpoint 71 freshly passes `webhook-list-bounded`
(`st_cd7ab72e7b9c43e69fe01f6ad0d6b508`): one pass, zero failures/errors/tool
faults, 27.077 seconds. Full evidence is retained privately. The instance is
stopped and its root absent; artifacts are mode 0600 and ledger cleanup complete.
Nineteen distinct checkpoint-51 failures now pass on the default route.

The source-derived webhook signatures now additionally retain their receiver's
ownership guidance and sensitivity/capability metadata. Only behavior/access
metadata is composed from the receiver; object-shaped wire arguments never
replace the public source signature. Regression requires create help to describe
`agent.describe().identity` and the actual `webhooks.manage` write capability.
Zero-count prose recognizes an actual absence of subscriptions without treating
an unrelated “no errors” statement as evidence of a zero count.
Fresh lifecycle acceptance follows in checkpoint 72; no lifecycle pass is yet
claimed by the list result.

Checkpoint 72 (`st_3cb0b7e49b6b4e7e8a42466f5a1e4d8c`) fails the webhook
lifecycle with one tool fault. Creation, active listing and rotation succeed;
revocation takes effect and follow-up history verifies cleanup. The native
recorder incorrectly validates the JSON transport response (`null`) against
the source return schema (`void`), turning successful completion into a
guest error and suppressing its receipt. The HTTP RPC handler already encodes
undefined results as null. For a void operation, no result payload exists to
validate: the recorder now derives the receipt from successful completion and
the validated subscription argument. This removes redundant payload validation
rather than adding a null/undefined conversion or changing the public facade.
The exact dispatch regression uses the real decoded null value. All 77 journal
and execution-lifecycle cases pass. Fresh installed verification is running on
checkpoint 73. Checkpoint 72 is stopped and its root absent.

Checkpoint 73 (`st_619ffe626fbd427fba3e5a1cdb3fb1d9`) fails before creation
with a guest type error. Source and trajectory show a documentation defect,
not missing identity: `agent.describe()` returns a Promise, but the webhook
receiver guide advertised `agent.describe().identity`. The model read a Promise
property and serialized the Promise as `{}`. The owning agent implements and
returns identity normally. Correct receiver guidance now explicitly uses
`(await agent.describe()).identity`; generated SDK help inherits the canonical
receiver description and its regression checks the awaited form. No runtime
compatibility, sync wrapper or prompt-specific recipe is added. Checkpoint 73
is stopped and its root absent. Fresh acceptance follows on checkpoint 74.

The upstream review recommends selective adoption into the next immutable
four-library release, not a monorepo rebase. Exact newly missing candidates:

| Upstream commit | Shipping behavior                                                                                       | Verification before publication                                              |
| --------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `69f0be6f`      | Drop stale Bedrock thinking bindings only for supported Claude models, excluding GovCloud               | Bedrock thinking payload regressions                                         |
| `b271b0a5`      | Inline Anthropic mid-conversation tool definitions, including same-name replacements; exact SDK 0.129.0 | Transcript/tool-change tests plus our retained explicit-auth transport tests |
| `3874b3e9`      | Recognize provider model-capacity errors in the existing retry classification                           | Retry/provider classification tests; no new retry policy                     |
| `eeac84ca`      | Fail an occupied ChatGPT OAuth callback port before opening the browser                                 | OAuth callback ownership/error/cleanup regressions                           |
| `c10bfb0d`      | Correct dashed Claude IDs in Cloudflare AI Gateway model generation                                     | Regenerate catalog, validate model metadata and archive inputs               |
| `28eaccb8`      | Correct Together DeepSeek V4 Pro model identity                                                         | Together model generation checks                                             |
| `4665fafb`      | Preserve Bedrock context pricing tiers                                                                  | Bedrock catalog/usage cost checks                                            |

Cloudflare Clef classifier additions (`4812cb26`) require a separate check
against our supported provider/model policy; they are not required to repair
these current provider defects. CLI/TUI/Nix and unrelated applications remain
outside the four-package closure. The fork worktree remains unchanged by this
review; candidate listing is not adoption, publication or product acceptance.

Checkpoint 74 (`st_9e7341cb6f7c443bb687cea476d150ef`) completes all requested
webhook operations with zero tool faults, but the validator still rejects the
run. Native capture joins creation, active listing, rotation and completed
revocation to one subscription. The validator unnecessarily requires a second
listing after revocation. The service awaits `store.replace` of the revoked
tombstone before resolving; success is authoritative cleanup evidence. The
validator now requires the actual completed revocation, without prescribing
a redundant read. Any later active listing for that same identity rejects
cleanup, even if another later listing was empty. Missing creation/listing/
rotation/revocation and mismatched identities remain failures. This is a
rederived lifecycle criterion, not acceptance of guest booleans. Fresh installed
verification is pending at checkpoint 75. Checkpoint 74 is stopped/root absent.

Checkpoint 75 (`st_8f6c1a22ea4b47ab9a73adf1506a9943`) freshly passes the
webhook lifecycle on the default route: one pass, zero failures/errors/tool
faults, 55.614 seconds. The private full snapshot retains native creation,
active listing, rotation and successful revocation evidence. Its instance is
stopped and root absent. Twenty distinct checkpoint-51 failures now have a
fresh default-route pass, leaving twenty unresolved latest failures and the
interrupted performance case. Older/never-started/composition coverage remains
open; no overall catalog pass is claimed.

The affected discovery/storage conventional tests expose five stale fixtures
that supplied only guest booleans or returned log envelopes after native
evidence became authoritative. Fixtures now retain independent operation
journals alongside the same guest projections. Removing the journals still
fails blob, log-statistics and webhook acceptance. Real result identity,
coordinate, count and cleanup assertions are retained; no production fallback
to obsolete guest shapes is introduced. All 47 affected semantic/discovery checks pass, along with the refreshed
System-testing typecheck and external-checkout hygiene.

The complete System-testing conventional suite initially passes 651/652 tests
across 56 files. Its one remaining failure is the existing temporary-resource
prompt policy: the SQL persistence prompt explicitly says to retire the DO,
coaching behavior intended to follow from product guidance. The SQL prompt is
restored to its natural persistence request. The webhook prompt likewise drops
its added explicit removal sentence. Cleanup validation is retained. The full
conventional suite then passes all 652 cases in 56 files. Fresh installed SQL
and webhook verification on these uncoached prompts follows in checkpoint 76;
prior passing receipts remain historical evidence for their then-current prompts.

Checkpoint 76 (`st_0617e113bf684e15839f8dd5f320a98f`) freshly passes both
`worker-do-sql-persistence` and `webhook-subscription-lifecycle` with their
uncoached natural prompts: two passes, zero failures/errors/tool faults,
188.179 seconds. Cleanup follows product guidance rather than a test prompt
recipe. This closes the fresh verification gap introduced by restoring those
prompts. The same owned instance next checks the remaining extension-list
case; retirement is pending until that exact run is captured.

Checkpoint 76 extension listing (`st_2efd4b5c18214585bab94cde2c463870`)
remains unresolved: one validator failure, zero tool faults, 15.789 seconds.
The full trajectory contains one `docs_search` restricted to the workspace
partition. It returns GAD/workspace list-method documentation, not an extension
inventory. The final answer names five extensions without an actual registry
observation. This is a discovery/evidence miss, not a failed native extension
operation. Do not waive the evidence requirement merely because some names
look plausible. The current live docs already advise omitting an unknown
partition and discovering extensions through `build.listUnits`; further repair
needs an actual discovery contract improvement or model-quality diagnosis,
not a test-specific prompt recipe. Checkpoint 76 is stopped and root absent.

Checkpoint 77 (`st_acfe108eec2644ceb8bf0838f0978e2b`) runs against the
published `.11` composition: `eval-exact-authority` passes; `extension-list`
and `eval-pregranted-only` remain unresolved. Extension discovery now reads
the eleven live source directories rather than guessing, but does not inspect
registry availability. The denied permissions read correctly retains
`ERUNMANIFEST` and its structured authority remediation. A preceding invented
`authority.status` call causes the unexpected `guest_execution_failed`; this
is not a lost denial code. The bounded conversation tail omits that earlier call, but the packet
records it in `toolFailures`; the full private trajectory confirms it. Neither validator is relaxed. The
latest unresolved count is nineteen plus the interrupted performance case.

Checkpoint 77 documentation selection (`st_85369742b97449b1aa119f1eda90291a`)
completes three cases with no tool faults, but no passing verdicts. The service
description reads live blobstore documentation and accurately names observed
methods; its validator mistakenly requires case-sensitive service spelling and
fully qualified method names in prose. The comparison now joins the observed
service and exact member identifiers, accepting capitalization and unqualified
methods while rejecting foreign qualifiers, invented methods, substrings and
unobserved documentation. All 40 focused semantic validator checks pass.
External checkout hygiene passes. Fresh installed verification follows. RPC mismatch
and operating-policy guidance remain unresolved; neither receives a waiver.
The owned checkpoint 77 instance is stopped and its temporary root is absent.

Checkpoint 78 (`st_337d555a42ab43bcb1d78d9b3c15b74f`) completes the exact
service-description retry without tool faults. The accurate answer now opens
identity-joined `blobstore.putText` and `blobstore.getText` method documents.
The validator exposes a second unjustified restriction: it requires the parent
service page rather than recognizing those explicit method-parent identities.
Its evidence model now derives service/member observations from catalog
identities rather than prescribing which page the agent opens. Foreign parents
and unobserved methods remain rejected. This checkpoint remains a historical
failure; fresh verification is required. Checkpoint 78 is stopped.

Checkpoint 79 (`st_a5185078940143cebe9048b2e89010fa`) freshly passes
`docs-describe-service` on the default route against `.11`: one pass, zero
failures/errors/tool faults, 15.614 seconds. This closes the installed
verification gap for the service/member evidence repair. Twenty-two former
broad-run failures now pass; eighteen latest failures plus the interrupted
performance case remain unresolved. Older, never-started and other composition
coverage remain open. No overall catalog completion is claimed.

All owned instances through checkpoint 79 are stopped and their temporary
roots are absent. External checkout hygiene remains clean.
The refreshed System-testing composition typecheck passes after the
service/member evidence change.

Checkpoint 80 (`st_092c4b9f17af45938743ac7e269a4d7a`) completes fifteen
unresolved cases: two passes, thirteen failures, zero errors, one unexpected
tool fault, 607.185 seconds. Read-only terminal discovery and browser-import
safety now pass on the default route. The remaining failures are investigated
through their full private trajectories. Qualified service help incorrectly
looks up `authority.preflight` as a service name; named help now resolves the
exact canonical method entry while preserving hidden ergonomic-method refusal.
Its 31 host checks pass. Native terminal projection now uses canonical failure
kind for contained tool errors; 28 native publication checks pass for both
direct and model-issued tools. Provenance orientation now validates the public
compact graph and identity-bound refs, rather than requiring backend composite
IDs deliberately absent from the public contract. Worker preview gains the
missing exact disposable worker fixture. Phone readiness authority matches the
receiver-declared `mobile-device` resource. Fifty-five focused validator/fixture
checks pass; host and Base typechecks pass. A System-testing typecheck first hits
ENOSPC in its owned npm utility cleanup; that exact abandoned utility is retired
through native cleanup without deleting shared caches. The next typecheck finds
a compact-reference collection inference error, which is repaired. Fresh
typecheck and installed verification continue. Checkpoint 80 is stopped.

Checkpoint 81 (`st_74d2020a16c743a7b4e77b14d9a22c79`) completes five repaired cases on the default route: five passes, zero failures/errors/tool faults, 207.746 seconds. Pregranted-only authority, compact provenance orientation, automatic conversation title, fixture-backed worker fork preview and same-turn infrastructure-error recovery now pass. The exact owned instance is stopped. Qualified service help additionally uses the existing compact method renderer to expose the actual `services.authority.preflight` callable and canonical argument type; all 31 host help checks pass after that refinement. System-testing composition typecheck remains open after another dependency-preparation ENOSPC. Its type inference defect is repaired, but no completed fresh typecheck is claimed. The shared filesystem has about 1 GB free; the user has been asked to release space from other tasks' data. Owned failed dependency utilities have been retired without deleting inherited caches.

Documentation probes now name the actual Vibestudio context and ask an answerable operating-policy question or an explicit diagnostic plan when no target session is supplied. RPC guidance accepts the documented candidate/publication distinction; app triage checks native source-authoring actions instead of demanding a disclaimer; extension trust planning recognizes scoped authorization without an exact prose token. Fifty-one focused validator checks pass, including absent-documentation and source-edit rejection. An older service-catalog fixture now uses actual fully qualified member identities. The obsolete GAD branch-file/SQL probe and its five synthetic guest-summary checks are retired: those APIs are absent from the public contract, and source history belongs to semantic VCS. This reduces the installed catalog by one; no passing receipt is claimed for that historical failure. Existing GAD integrity and VCS coverage is retained.

The refreshed System-testing composition typecheck now completes successfully. The full conventional System-testing projection passes 813 tests across 67 files, with one native-CDP integration skipped; it includes host-owned workspace integration coverage. Host typecheck, Workerd-program typecheck, qualified-help checks and external-checkout hygiene pass. The task-owned fork dependency install is retired after published-package verification, retaining source, release artifacts and receipts. No inherited/shared cache was deleted. Android provisioning remains gated on sufficient free space.

Private verification captures and disposable early proof artifacts under `experiments/durable-pi/` are excluded from version control and restricted to the owning user. Historical evidence references name those local captures without publishing raw trajectories or broken repository links. Shipping regression tests and the published-package receipt remain reviewable source artifacts.

Checkpoint 82 (`st_1f04fdf1847f40e6a46418ec0d0aa82b`) completes seventeen cases: six passes, eleven failures, zero errors, three unexpected tool faults, 579.984 seconds. RPC mismatch, app triage, extension trust planning, operating-policy guidance, account identity and API-integration discovery pass. All failure packets and needed trajectories are captured privately before stopping the exact instance. Pregranted-only reopens after an invented authority method; its expected ERUNMANIFEST denial still passes. Source inventory and conversation addressees remain insufficient for live availability/presence. Version inspection did not discover the runtime catalog. Automation retries an invalid limit; its successful count report does not erase that fault. Membership exposes a natural singleton-count comparison defect; the repaired validator additionally checks observed member identities/roles, with wrong-role/count regressions.

Permission inventory completed correctly and was summarized from retained large-return text, but the validator required the entire transport-bounded guest return to remain an array. A bounded native observation now validates actual canonical permissions.list rows before guest access and records only total/kind counts in the existing execution journal; identities, labels and reasons are not retained. Guest-shaped claims, mismatched totals and permission mutations are rejected. A failed follow-up dependency preparation hits ENOSPC; its exact npm utility is retired normally. The integrated, clean, unused system-test review worktree is retired. No inherited cache is deleted. Disk availability later improves to about 8 GB.

Dynamic import exposes a genuine confined-global defect: lodash-es reflects on Function.prototype, but the facade omitted Function even after dynamic code generation was disabled. Function reflection is now retained under the existing codegen-free realm admission. Security regression tests expose and repair host-realm inert constructor/error objects and Object-prototype facade wrappers: replacements/errors belong to the tamed realm, and wrapper prototype chains no longer inherit the host compiler. All 24 confinement/native-journal checks and host/Workerd typechecks pass. Sixty-four focused System-testing checks pass for bounded inventory evidence and natural membership reports. Fresh installed import/inventory/membership verification follows.

The harness policy now uses already supplied guidance for policy/workflow explanations, while discovering exact method names, shapes and bounds before specialized operations. Two explanation-only probes apply that supplied policy rather than prescribing an unnecessary documentation read. Live workspace facts still need canonical observations; conversation participants do not establish workspace-wide presence. No live-state or authority requirement is relaxed.

The Base agentic-core, agentic-do, agentic-chat, eval-engine and harness projection passes all 1,286 tests in 141 files. After the supplied-policy probe adjustment, 73 focused System-testing checks pass. The automation limit fault exposes an actual discovery defect: workspace docs carried only the method's TypeScript signature, omitting the manifest-bound receiver schema that enforces limit 1..50. Reviewed receiver metadata now uses the existing canonical service serializer before crossing the build-worker boundary; exact provider method catalogs and live workspace docs retain argument/return schemas and parameter names. Argument validation participates in the sealed input-contract digest, and the analyzer version advances to v5 for derived catalog identity. Numeric bounds use one portable formatter shared by docs_open and compact eval help, preserving both OpenAPI boolean exclusions and independent numeric JSON Schema bounds. No authored-method special case or compatibility reader is introduced.

Checkpoint 83 (`st_71e13e6b25ce4d31ba01502ad85ec35b`) completes eleven affected cases: eight passes, three failures, zero errors or unexpected tool faults, 373.185 seconds. The eight passing receipts cover dynamic imports, native permission inventory, workspace membership/presence, unit versions, pregranted-only authority, interaction choice and headless diagnostic guidance. The installed CLI separately verifies actual lodash-es import/reflection with code generation blocked. Private captures precede retirement of the exact session and managed instance.

Automation's remaining validator required an invented flat return shape and a removed `stats.failedLast24Hours` property. The canonical ledger instead aggregates `total`, `active`, `running`, `issueRunsLast24Hours` and `completed`, independently of item pagination. Its shared statistics schema now drives acceptance of numeric summaries and exact final counts, while raw records, mutation and page-derived substitute counts remain rejected. Workspace settings likewise accepts the actual config read surface and rejects arbitrary metadata. Extension availability asks explicitly for registered readiness and requires observed extension readiness, retaining rejection of a directory-only answer. These changes need fresh installed receipts; historical failures remain recorded.

The latest catalog/help suite passes 79 checks. Base documentation rendering passes sixteen checks, and Base/System-testing composition typechecks pass before the latest count-validator refinement.

### Checkpoint 84 diagnosis and checkpoint 85 source boundary (4 October)

Checkpoint 84 (`st_e31e5c2c1d174476808817373e8fe713`) completes 29 cases: six passes, 21 failures, two errors, three tool faults. Default-route passes cover automation overview, configuration, unstated-constraint and set-shaped provenance recovery, native automation launch and cautious phone readiness. Actual Android install/pair/readiness succeeds, although the explicit-install validators reject redundant debugging-call and exact-package-prose expectations. Retained private captures precede retirement of the instance, desktop executor and emulator; the owned AVD directory is removed after its process exits.

The image failure is a real harness defect: an artifact reader used blobstore.getText on PNG bytes. Native eval now reads images through its bound blobstore.getBase64 RPC; malformed encoded data becomes a contained infrastructure failure before reaching the provider. The now-unused vessel text cache is removed. Both affected Base files pass 38 focused tests; Base composition typechecks pass.

Grouped runtime methods were callable but invisible to help and runtime documentation. Runtime is now a typed namespace linked to its canonical service schema; generic live-method reflection discovers grouped methods and help supports grouped indexes/exact methods. Fifty-four host help/catalog/parity checks pass. A native credential-resolution journal retains only an exact request digest and found flag, independent of guest summary names; it retains no audience or credential data. Host/Workerd typechecks pass.

Permission reuse is measured from native child completion and host-owned before/after task-grant snapshots. Integration uses public merge completion plus both origin commits retained by exact fresh reads. Import evidence uses the current typed intent; cause walks accept identity-linked continuation to an intact message. Focused validator checks pass, including negative cases. Source-side tree navigation now explicitly requests moving the same view.

The stale/idempotency scenarios previously required agents to submit low-level VCS commands through eval, contradicting focused authoring ownership. They now run controlled public-protocol probes in the exact task fixture: identical immutable request replay must return one terminal identity and one application; stale refusal must leave native head/counts unchanged, followed by a newly observed basis and exact final bytes. Six probe regressions reject duplication, state-changing refusal, missing evidence and unrelated failures. These are harness protocol verdicts, not simulated agent acceptance or waived faults. Installed receipts remain pending at freshly provisioned checkpoint 85.

### Checkpoint 85 installed result and follow-up investigation (4 October)

Checkpoint 85 (`st_dc72f63b5fa742a1b80c40eaec959ce9`) completes 13 cases: six passes, five failures, two errors and two unexpected tool faults. Extension discovery, semantic stale-basis recovery, command replay, honest import boundaries, embedded workspace guidance and panel-tree navigation pass. Its exact managed instance and desktop executor are stopped; captured trajectories remain private.

The integration orchestrator placed fresh reader messages before the merge phase despite running the reader afterward. Correcting phase order preserves the existing proof requirements. A typographic apostrophe/read-only credential report was wrongly rejected. Unit-health evaluation returned a truthful compact summary; native bounded health evidence now retains the exact identity, buffer counts and bounds independently of guest serialization, without duplicating diagnostic prose. An external client's originating request was rendered as an incidental excerpt; causal walks now carry prose independently of sender kind while retaining the actual origin boundary.

Browser `snapshot()` attempted workspace-only `_agent.snapshot` RPC against a browser target. The canonical snapshot operation now captures browser DOM through the native page and retains exact runtime-generation evidence. The panel-runtime regression suite passes all 48 checks; causal prose regressions pass 35 checks; native health journal checks pass 16; System-testing unit-health/integration validators pass 33. Latest host/Workerd, Base and System-testing typechecks pass at this boundary.

The child permission-reuse case also exposed ambiguous closed-socket dispatch and inactive authority-parent errors during channel delivery/lifecycle retirement. The existing parent-retention and causal RPC tests pass, but the installed failure remains open; checkpoint 86 isolates this operation rather than adding a deadline or transport replay. Memory recall also has a source repair pending verification: all-term matching could return only the current question and suppress historical evidence because widening occurred only for empty pages. The proposed single ranked term-retrieval query removes that contingent fallback instead of filtering by a guessed current-message identity.

### Checkpoint 86 installed result and checkpoint 87 source boundary (4 October)

The isolated permission-reuse run (`st_acb1310a598b46ada94f37d617bffc48`) completes with one validator failure and no error or tool fault. Its native parent and child protected-log reads reuse the same task grant; the validator incorrectly required the parent to use stats rather than another canonical read. It now accepts a validated native log-read receipt and still requires the identical before/after grant, actual child completion and no new approval. The inactive-parent/closed-socket failure from checkpoint 85 does not recur, but this single result does not establish its root cause or closure.

The seven-case run (`st_77340079c4a34f5d851adf767413e914`) passes incremental integration, browser capture, originating-request recovery and both notification lifecycles, with two failures and no errors or unexpected tool faults. Credential selection genuinely bypasses the canonical resolver in favor of inventory matching; resolver guidance is clarified without accepting substitute evidence. Unit diagnostics carries the correct native bounded receipt and a truthful zero-count report; its validator now understands a shared negative quantifier.

The next source boundary reuses the existing bounded DOM snapshot producer for native browser capture, uses one ranked term-retrieval query for memory recall, and requires live roster observations rather than inferred participants. The rejected-retry scenario's content-only fixture and validator concern historical review; its prompt now states that review goal explicitly and its validator rejects mutation, rather than requesting authoring the fixture cannot support. These changes require fresh installed receipts.

Desktop retirement encounters an incomplete unrelated /proc identity while scanning group membership. Group discovery now requires process state and group ID; owned-leader identity checks still require the birth coordinate. Twenty-eight ownership/journal regressions pass. All checkpoint-86 owned processes and retained scratch are verified retired; fresh desktop retirement is still needed to establish installed cleanup. Latest focused checks pass: Base 72, System-testing diagnostics/credentials 46, permission/capability 32, and provenance/diagnostics/permissions 55, with host/Workerd, Base and System-testing typechecks. These counts are overlapping focused checks, not a full-suite total.

### Checkpoint 87 installed result and retained provenance repair (4 October)

Run `st_a7cf6bc4ad414dc99e709d79bea0fd77` completes eleven cases: eight passes, three failures and no errors or unexpected tool faults, 567.111 seconds. Credentials, roster, memory recall, sizable edited-file context, edited import, reusable templates, rejection review and bounded browser capture freshly pass. The exact instance and desktop executor retire cleanly, including both scratch roots.

The remaining child verdict exposes a real lifecycle mismatch: task-scoped product context is retired by Pi before retained model evidence reads it. The provenance now shares the session lifetime of actual native task/submission records, keyed by the real task ID; it adds no scheduler, execution owner or compatibility reader. Thirty-five focused model-evidence, product policy, automation and invocation regressions pass. Canonical health/log descriptions now distinguish the separate error buffer from log-only output. Revert's actual counteraction and restored bytes were correctly captured, but opaque agent references were compared directly with canonical change IDs; acceptance now joins the exact native request/relationship instead. Sixteen focused validator checks pass with foreign-reference and unrelated-target rejection. Source repairs still need fresh installed acceptance.

### Checkpoint 88 workflow coverage and checkpoint 89 repair boundary (4 October)

The three-case repair run (`st_325dfe861d4b4d81a41bd4f51026196e`) passes native child settlement/grant reuse and bounded unit diagnostics. Default-route revert fails after inventing a change identity from an event hash, then recovers; that fault is not waived. The unchanged stronger-model diagnostic (`st_cb4113e9f7e64e30a4e9c2a7942c8889`, openai-codex:gpt-6-sol/high) passes with no fault. Revert's argument schema now explicitly describes the real change-selector contract. Default-route acceptance remains open.

The thirteen previously unstarted workflows (`st_849079dc7e144de486e3cfc1a16c6700`) finish with nine passes, four failures, zero errors and two classified unexpected faults in 1,134.675 seconds. Successful receipts cover package build, Workerd worker tests, browser panel tests, atomic patch/build, deliberate unintegrated child diff, app edit/test/build, unified matching provenance, stale-edit recovery and workspace-dev change-loop guidance.

The follow-up validator mistakes an extra post-merge inspection for the second pre-merge review; it now selects review phases and rejects early integration. Ordinary child integration was incorrectly required to have a separate diff preflight contrary to product guidance; canonical non-empty merge receipts and complete semantic resolution establish integration, while deliberate unintegrated comparison still requires the bounded diff. The extension repair itself succeeds; subsequent unnecessary reporting misclassifies an authored-code issue and invents a reference kind. Reporting guidance explicitly preserves the platform/authored-code boundary and explicit reporting requests. The intended bounded-build failure is correctly retained with 55 diagnostics and a later clean build, but the classifier misses agent-tool-failure.v1.code; it now validates the canonical schema before extracting code and rejects incomplete objects.

Focused runner/classifier/orchestration checks pass 52, followed by 41 runner/orchestration checks with malformed-failure rejection. Base VCS, verification and prompt checks pass 47. These are overlapping focused suites, not a full-suite total. All checkpoint-88 owned processes and scratch roots retire cleanly. Fresh acceptance is still required for four workflow repairs and default-route revert. Twenty-eight previously unstarted cases remain, alongside separate composition, mobile and performance coverage. No new installed scenarios have been introduced before current-work completion/commits/pushes.

### Checkpoint 89: remaining workflow identity ergonomics

Four of five installed repairs pass, including default-route revert. Follow-up task outcome succeeds but four long-ID transcription faults remain. Exact compact references now derive from the native launch task retained on the existing supervisor row; both notify and inspection share exact identity semantics and parent scope. Canonical runtime IDs remain unchanged. No reference-cache expiry, fuzzy recovery, second owner or compatibility migration is introduced. Base focused checks pass 121 and Base/System-testing composition typechecks pass; fresh installed verification follows. Checkpoint 89 instance/executor and owned scratch retire cleanly.

Checkpoint 90 installed child acceptance (`st_55acad1a6ef247b2848390b341ed4080`): four passes, zero failures/errors/tool faults, 450.427 seconds. Short exact native selectors work for two-commit follow-up, direct integration, deliberately unintegrated diff review, and settled task-grant reuse. Fifteen outstanding authoring/scaffold cases follow on the same isolated instance.

Authoring checkpoint 90 source repairs now pass focused checks: 38 Base tests,
108 System-testing tests across five files (the three initially failing fixture/
goal snapshots were repaired), Base and System-testing composition typechecks,
and external-checkout hygiene. Installed acceptance remains open for ten cases;
a fresh checkpoint 91 is being provisioned from these source inputs. Five
already passing authoring cases are not repeated without affected behavior.

## Concurrent release reconciliation (4 October 2026)

The host source now includes upstream repository release 0.1.54 through
`1b447a9da29ef501267a4f343d6df66486b68e17`, merged with the existing committed
native runtime work. Pending source edits were reconciled separately and kept
unstaged; they were not included in the committed-history merge. Six overlapping
source/generated conflicts were resolved against the current canonical APIs.
The moved eval result-tree helper uses its canonical `eval/resultTree` path,
and native browser lifecycle changes retain explicit completion/error ownership.
The canonical authority projection contains 811 rows; all sixteen additions
match reviewed pending contracts, and the retired EvalDO disposal row is absent.

Verification passes the full build, complete commit gates, 99 host integration
checks, 90 focused Base native tests and System-testing composition types. The
shared checkout also passes its full build after dependency installation. The
private reconciliation worktree is retired; bounded receipts and source backups
remain private. Installed acceptance resumes on a fresh checkpoint 92 rather
than assuming that source checks prove release behavior.

## Checkpoint 92 lifecycle repair

Run `st_3de133d41f8f4604b5031396f1758488` completes fourteen cases: seven
passes, four failures, three errors. Fork publication and native worker
testbench acceptance pass. The complete run inventory remains in the linked
installed acceptance document; the instance and executor are retired.

A native model socket error with CLOSED state was incorrectly retained as a
resource-release failure even after the actual Codex provider completed HTTP
fallback. CLOSED now proves retirement; provider listeners still receive the
original error, and explicit cancellation/Close failures remain failures.
Focused tests include the installed fork's real provider fallback and retained
cleanup failures. The headless connection's blanket replay/resolution deadline
is removed: actual readiness, service/transport failure and cancellation settle
the owning attempt. Regression checks prove a slow replay stays owned and an
original service failure is propagated.

The typed workerd SQL facade now exposes native cursor accounting that it
already passes through at runtime. Worker guidance requires literal website
exposure decisions at each decorator. Native browser guidance documents its
actual page methods. Console validation accepts empty-document observations
without demanding one particular word, while still requiring executed evidence.
These source repairs require fresh installed acceptance; the previous failed
verdicts are retained.

## Checkpoint 93 ownership and evidence repair

Seven installed cases complete with two passes, two failures and three errors.
Image-panel generation/reference editing and console inspection freshly pass.
Native-image continuation still has a provider fetch failure, but its native
socket and agent cleanup now join cleanly. That transport issue remains open.
All exact failure packets are captured; the instance, executor and scratch roots
are retired.

Browser creation previously manufactured a context id without recording lifecycle
ownership. Both native portable creation and shell browser creation now establish
their fresh context through the existing runtime context contract before entity
attachment. Explicitly selected contexts remain explicit and are not claimed.
No harness-wide cleanup grant, alternative execution owner or watchdog is added.
The rebuild validator uses native generation replacement receipts and actual
interaction order rather than guest-manufactured generations or method spelling.
Launch-state inspection accepts the documented getter path with a native mutation
receipt. Documentation covers complete data-URL encoding, exact label matching,
actual postconditions and semantic role selection.

Focused validator and native panel tests pass; installed acceptance is still
required for the changed paths. The linked acceptance inventory retains each
failure and the provider investigation separately.

### Checkpoint 94 follow-up

Native image save/read and task-management build/launch/debug pass on the installed default route. Six browser/performance verdicts remain open; the authoritative inventory is `durable-pi-installed-acceptance-remaining.md`. Source repairs address numeric native evaluation evidence, portable Base examples, bounded native click-profile receipts, atomic commit cleanliness proof, and awaited asynchronous Base alarm/lifecycle error propagation. The real Workerd retirement regression now loads the shipped Base and verifies a late closed-Harness alarm returns its original structured error. The original closed Gad read dispatch remains under investigation. Source checks do not close installed acceptance.

### Checkpoint 96 acceptance and source completion

Browser click/evaluation, click profiling and panel optimization pass on the installed default route. The four-case run has three passes, one rebuild verdict failure, zero errors or unexpected tool faults, and clean retirement. The rebuild outcome contains a genuine changed generation and working controls; its prompt omitted the initial automation interaction and retained-session lifecycle that its validator demands. The request now asks for that lifecycle explicitly, preserving strict native replacement checks. Focused fresh acceptance and the supported optional compositions remain open.

Broader source verification covers all 639 Base agentic tests and 7,951 host tests. Three affected host files pass all 51 checks after exact fixture permissions and generated-source build ownership are repaired; full commit gates pass. Source checks are not a substitute for installed acceptance or immutable publication.
