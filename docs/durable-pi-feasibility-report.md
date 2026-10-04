# Durable Pi feasibility and design evidence

Date: 2026-10-01. **The requested three-step component packet passes; product
cutover acceptance remains open.** Pi storage works without rewriting its async SQL core. The
initial shared-Session and native-facet-alarm assumptions were falsified. The
[design record](durable-pi-design-decisions.md) now selects separate executable
owners, versioned host wake publication, existing wait safeguards and one
composed schema lifecycle, with explicit operation/product contracts.

This report accompanies the [behavior ledger](durable-pi-behavior-ledger.md) and
[migration plan](durable-pi-migration-plan.md). The first work package produced
counterexamples; the second pass added native placement/schema specifications
and bounded protocol models. The current packet implements the production base
lifecycle, Pi kernel wait changes and host wake relay, and proves real EvalDO
recovery. The [affected-caller audit](durable-pi-implementation-audit.md) records
implementation scope and remaining release gates. No product engine was replaced.

## Evaluated source and artifacts

- Pi repository: `https://github.com/earendil-works/pi`, exact revision
  `0f8740bb65638180403a225ad7ec4d0cc1f8dedf`.
- Source checkout retaining upstream history/license:
  `/home/werg/vibestudio-pi-durable-fork`, branch
  `vibestudio/durable-workerd-feasibility`. The pinned HEAD now has a local
  implementation delta (native adapter, scoped migrations, commit preparation,
  typed waits, intrinsic phases and durable tool/output continuation). No source
  commits/pushes were made; four immutable fork libraries are now published. Dependencies were hydrated using the existing
  lockfile with `npm ci --ignore-scripts` in this owned fork, not in a configured
  template checkout.
- Pi durable, Pi AI, Chord and telemetry come from that same source checkout.
  Four published libraries use distinct `@panticonic/pi-*` identities and exact
  version `0.99.2-vibestudio.1`, under tag `durable-pi`. Registry archive bytes,
  SRI and source digest match reviewed artifacts; ordinary registry installation
  verifies the transitive closure and excludes a second upstream Pi library.
  Native bundling consumes installed exports without source aliases. See
  publication evidence (`publication-evidence.json`, private verification evidence).
- Installed embedded runtime: `workerd 2026-07-24`. Tests run actual native SQL,
  WorkerLoader and SQLite facets through the current host's
  `src/server/workerdPrograms/universalDo.ts`.
- Native evidence (`evidence.json`, private verification evidence) records lockfile,
  bundle and source-input SHA-256 hashes, the host UniversalDO source/bundle
  identity, each observation, gate outcomes and cleanup. The scripted bundle is
  measured in that evidence, including portable conformance cases; it does not bundle the live OpenAI/Anthropic/Bedrock API
  implementations. Bundle size is a fixture fact, not a product performance
  budget or release artifact.
- Caller inventory (`inventory.json`, private verification evidence) records the host
  and configured Base, Personal, System, System-testing, Examples, Gmail, News
  and Spectrolite source identities and selected declarations/tests.

The fork library release is published and verified. The experiment remains a
review fixture, not an installed-template product release or complete runtime
integration.

## What passed

| Check                         | Actual evidence                                                                                                                                                                                                                                                          | Limit                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable storage conformance  | All 23 upstream runner-independent cases pass inside actual SQLite facets using the native adapter. They exercise IDs, detached records, queries/cursors, atomic rejection, history/forks, tasks/submissions and documents.                                              | Fresh connection per case; backend-specific disk/resource budgets and exhaustive crash/reopen placement are separate checks.                                                                |
| Async SQL transactions        | Pi's existing async facade runs SQL in native `storage.transaction()`. A callback writes, yields and throws; its changes roll back and the original error is preserved. Root operations queue outside the transaction; stale transaction handles reject.                 | No model or network effects are executed inside these transactions.                                                                                                                         |
| Uncertain acceptance          | A controlled acknowledgement loss after native commit poisons the Pi Session, publishes no speculative commit and rejects further admission. Reopen finds the accepted entry and recomputes IDs above it.                                                                | Simulated acknowledgement loss after real SQL commit; not physical disk-failure testing.                                                                                                    |
| Dependency migrations         | Fresh and repeated bootstrap succeed. A failed version-2 migration rolls back its table and version. Retry succeeds; older code rejects the newer database.                                                                                                              | Dependency unit proof; the production composition is tested separately below.                                                                                                               |
| Native schema inspection      | The actual host fingerprint function detects deletion of a Pi index while the schema version remains unchanged. Pi's version-only migration check accepts that drift.                                                                                                    | An admission guard must actually enforce the expected shape; inspection alone does not do so.                                                                                               |
| Persistent history            | Pi opens native SQLite in an actual UniversalDO facet, commits model history, is restarted, and reads that history from a fresh activation.                                                                                                                              | Full document/fork/compaction conformance remains open.                                                                                                                                     |
| Platform alarm primitive      | A standalone SQLite DO commits SQL and an alarm together. Throwing rolls both back. After native owner replacement and a quiet interval, the alarm alone activates the owner and updates the row.                                                                        | **This does not apply to SQLite facets in this embedded runtime.**                                                                                                                          |
| Host facet exclusion          | Actual UniversalDO restart excludes a deliberately noncooperative old writer. Advancing the mocked immutable image version exercises the actual loader's facet-abort-before-load path; only the new activation remains writable.                                         | Code/version gateway and egress are controlled fixtures. Whole WorkerdManager process replacement, production sealed image admission and domain process/socket cleanup are not tested here. |
| Active history fork           | A parent with an active task forks at a committed user entry. The child sees the knowledge and has no copied tasks; the parent remains active.                                                                                                                           | Pending approval, admitted mutation, compaction, document-policy and full context-copy cases remain open.                                                                                   |
| Unsupported definition        | A task with no installed definition remains visibly blocked in native inspection.                                                                                                                                                                                        | The full older/newer/migration-failure compatibility matrix remains open.                                                                                                                   |
| Scripted model path           | Pi's actual generation path runs a faux provider, settles a submission and reattaches duplicate input identity over native SQLite.                                                                                                                                       | Faux provider only; the separate real EvalDO cycle below validates actual tool-result consumption. No live model/provider transport proof is claimed.                                       |
| Independent executable owners | Two actual facets install same-named tasks with distinct immutable binding modules and attributed fixture egress. A and B execute their own code; each is denied the other's port. A replacement and A-only image update leave B's code and activation unchanged.        | Placement primitive only: protected production ports, real permission policy, distributed supervision/fairness and manager/process replacement remain open.                                 |
| Composed schema specification | One native transaction installs platform/Pi/domain tables. Injected fresh/upgrade failure rolls back the whole composition; successful upgrade retains domain data. Trusted source/target fingerprints reject downgrade and same-version drift without further mutation. | Historical executable specification. The current production-base proof uses the actual extracted runner, not this second specification installer.                                           |

| Production composition | Actual Base awaits platform/Pi/domain installation in one native transaction; injected failure leaves an empty store, retry succeeds, replacement reopens retained history, unknown application object refuses unchanged. | Shipping Pi class/packaging and manager process/reset integration still required. |
| Quiet typed timer | Typed wait releases the invocation. Native replacement occurs before its due time; actual AlarmDriver resumes it without client traffic during the due interval. | Host WorkspaceDO fixture uses SQL.js; not a performance measurement. |
| Real EvalDO result | Scripted generation calls a real EvalDO in an owned instance, parks on a bound receipt, survives replacement and validates the actual result. Every publication is dropped, including the first; host generation adoption recovers from registration. Late/duplicate result survives replacement. | Exact canonical acknowledgement and finite retirement/refusal also pass. Completion delivery is fixture-authenticated; shipping Pi receiver routing, reclamation and full cancellation remain gates; domain-side exact-ack redelivery is implemented. |
| Admission gap | Hold the real domain admission response after acceptance, replace Pi before continuation commit, then recover and reattach the same run. Two admission calls leave one SQL application. | Replay-safe operation with stable identity; not an exactly-once guarantee for arbitrary external effects. |

Alongside the 23 native portable conformance cases, the focused upstream Node
baseline passed **142 tests in 7 files**: SQLite
storage/facade/migrations, task recovery, ownership, conversations and registry.
Those tests validate the evaluated source baseline. They do not turn the native
component checks into full product acceptance.

## Initial counterexamples and selected responses

### 1. A shared Session does not retain independent executable bindings

The fixture creates child A with one implementation of `custom.same-name`, then
installs child B's implementation with the same extension/task name and version.
Each child selects its own extension object and has a distinct cwd. Both tasks
nevertheless complete with `code-B`; expected results were `code-A`, `code-B`.

Pi stores extension names in agent documents and resolves task definitions
globally by name from one registry. Per-conversation settings and environments
are real supported features, but they do not bind a task to an immutable source
artifact or isolate customized executable code.

This is a reproducible counterexample to using the current registry unchanged
for independently updated workers. It does **not** prove that every possible
shared-owner design is impossible. A coherent shared-owner design would need
artifact-bound definitions, phase compatibility rules and capability isolation,
including a way to execute independently loaded worker code. Renaming definitions
in an adapter or relying on cwd/model instructions would leave the underlying
ownership problem unresolved.

The selected response is **one Pi Session per independently bound agent
entity**, reusing the existing source/context/egress/facet boundary. The new
native check establishes that placement primitive. Remote children use local
owned operation tasks and canonical child receipts; they do not share registry
installation or mutable execution status. Actual supervision, cancellation,
fairness and authority tests remain required.

The shared-owner alternative would need artifact-aware task identity, code
loading and capability execution inside Pi, recreating an existing host boundary.
It is not selected. Independent customization is preserved rather than renamed
or constrained to make the original assumption pass.

### 2. Native alarms are unavailable in actual SQLite facets

The same wake-registration call that works in a standalone DO fails inside the
actual UniversalDO facet with:

> alarms are not yet implemented for SQLite-backed Durable Objects

The existing host `AlarmDriver` and Base `DurableObjectBase` already document and
accommodate this hosting limitation. The experiment confirms it on the exact
installed binary. It does not establish the behavior of a newer binary, and
changing the binary alone would require the native host compatibility suite.

For the current host, wake-up must use durable `WorkspaceDO.do_alarms` and the
host driver. A relay call after a Pi commit is insufficient: owner loss between
those commits leaves quiet work asleep indefinitely. Existing ordinary-fetch
alarm draining does not cover every activation-owned scheduler commit.

D04 selects this wake contract; its production implementation must prove all of the following:

1. Register the execution owner durably before it can admit dormant work, so a
   host recovery scan can discover it without a client request.
2. Commit the Pi continuation/condition and its outstanding wake-publication
   obligation together in the owner's native transaction. The wake obligation
   is delivery bookkeeping, not a second scheduler or copy of task status.
3. Let the host relay that versioned schedule to the alarm owner and acknowledge
   only the schedule it accepted. A late relay/clear cannot overwrite a newer
   or earlier required wake. One owner's multiple alarm sources share one
   complete scheduling decision.
4. Recover the outstanding obligation through the registered owner after caller,
   facet, workerd and host loss. Request-local hints improve latency only.
5. When the alarm fires, Pi reevaluates its committed conditions. Duplicate
   alarms are harmless; the host never chooses task phase or semantic outcome.

`createDurableWorkOwnerScanner` and existing durable readiness/delivery machinery
are source inputs for this contract. Their presence is not proof that a new Pi
commit participates in them correctly. Before writing a scheduling adapter,
test crashes before/after owner registration, local wait commit, host schedule
acceptance and local acknowledgement, with no user traffic during recovery.

### 3. Timers retain invocations; general sibling cycles are accepted

`runtime.sleep()` leaves the task `running`, keeps a timer/invocation and arms no
durable alarm. The timer target exists in this fixture's input, but the scheduler
does not expose it as a dormant wake condition. At the initial upstream baseline, generation and compaction used
the same heap sleep path. Their intrinsic waits now use durable typed conditions;
custom runtime.sleep remains a resident extension API. Intercepting this promise with an adapter cannot add
the missing phase and condition atomically.

The sibling-cycle fixture commits two conversation-owned tasks whose normal
phase handlers each wait for the other. Both become `waiting`; neither is
rejected. The scheduler's self/ancestor checks do not close this general cycle.
No timeout was used to turn this into a successful or failed task outcome.

D03 selects one kernel wait representation for task dependencies, due times and
external operation receipts, including generation, compaction and abort cleanup.
D05 retains upstream self/ancestor wait checks and proven Vibestudio
serviceability safeguards. General sibling-cycle detection is deferred and is
not a production gate: the fixture is synthetic and neither implementation
provides that general guarantee today.

A prompt to check progress or carry on is input admission, not a completion wait.
Source inspection finds that child send/read/inspect and standard direct method
handling support independent messaging/inspection while foreground work waits.
Only the synthetic local sibling cycle has been reproduced. Existing tests
protect self-inspection and current-tool progress against queued work; preserve
those actual behaviors. No new local graph validator or host-wide coordinator
is selected. Arbitrary task/eval programs are not promised deadlock freedom.

### 4. Initially, schema runner and native guard were separate

At the initial baseline the host installer expected an empty database or its exact
current metadata/shape and had synchronous creation hooks. Pi bootstrap is async and
owns its own migration history. Running both installers independently would
create competing lifecycle ownership.

D06 keeps Pi's migration history and selects one native initialization lifecycle that
owns supported upgrade, expected-shape probing/validation and admission refusal.
It must validate the migration result before execution and leave unsupported
state unchanged. This changes a helper contract, not the user's clarified
policy: dependency migrations are permitted, and supported upgrade policy must
be ready for release. The new native composition specification proves the
transaction/shape primitive. The current production base now composes async
creation/upgrades and admission with the extracted Pi runner; complete shipping
Pi activation and all product schema compositions remain release work.

## Revised implementation boundary

Do not perform the originally proposed synchronous SQL-core rewrite. Current
Cloudflare documentation explicitly supports SQL inside async storage
transactions, and the embedded facet test proves it for this source/binary.
See the [native transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction).
The adapter queues root operations, scopes transaction handles, consumes cursors
before yielding, and confirms writes before Pi adopts/publishes acceptance.

Keep the native adapter isolated until the schema owner and remaining native
crash/reopen/retention checks are complete. Portable storage conformance passes.
The remaining justified fork delta is in scheduler wait
representation, built-in generation/compaction/tool phases, finite fair passes,
schedule commit preparation, local product
participants, schema lifecycle composition and provider transport. This is a
substantial integration, not a drop-in adapter. The current packet changes the pinned fork and production host/Base schema and
wake protocol. It does not switch product agent execution to Pi.

The behavior ledger identifies additional product mismatches to cover before
cutover. Ordered parallel waves and provider authentication/progress/owned-transport
source deltas now have focused implementation tests. Feedback admission,
outside-content reset failure, shipping operation receipt delivery/reclamation,
customized workers and actual native provider egress remain product obligations. None can be hidden by a
passing scripted model turn.

## Evidence scope and current gate accounting

The native fixture completes **23 portable storage cases and 24 aggregate
assertions**. Seven component gates close: installed package composition, async SQL, owner invalidation,
independent placement, production schema composition, host wake recovery and
dormant wait representation. One product-boundary gate remains open, so a
successful run still exits `2`. Its detailed limits remain in the evidence.
Rejected shared placement and facet alarms remain counterexamples; the synthetic
sibling cycle remains characterization, not a new release requirement. Typed
wait implementation does not change that unsupported upstream graph guarantee.

The bounded protocol models (`design-contracts.mjs`, private verification evidence)
pass five checks: wake revisions under loss/reordering (177 states, 880
transitions), local graph admission under six transition orders, fenced operation
admission decisions, early/late retained receipts, and an exploratory closed-range optimization across a long-lived gap. Model evidence (`design-evidence.json`, private verification evidence)
records source hash and assumptions. These checks run independently of Pi and
the host. The local graph and range-compaction models are exploratory and are
not selected migration requirements. None is a native implementation or full liveness proof.

## Focused existing-product preservation review

Two host-owned projection runs pass **24 existing tests across three Base files**:
13 collaborator/report/follow-up/suspension checks in `chat-op.test.ts`, four
suspension/after-turn/current-tool checks in `agent-loop.test.ts`, and seven
mission overlap/missed-occurrence/pause/revision/recovery checks in `MissionsDO.test.ts`.
Preservation evidence (`preservation-evidence.json`, private verification evidence)
records exact commands, audited source hashes, selected cases and scope.
Configured checkouts have concurrent local changes; recorded HEADs alone are
not the complete source identity. No tests ran with a template checkout as cwd.

This review corrects the plan's unsupported subagent foreground-join assumption.
Existing spawn launches a background collaborator; reports, actual idleness,
follow-up usability and source integration are separate. Native suspension must
preserve the open response while consuming eligible later input, not join all
children or resume from its own suspension result. Mission schedule policy stays
with its domain owner: missed opportunities do not catch up, overlaps skip, and
revision replacement precedes old execution/authority cleanup.

General graph detection and receipt-range compaction are deferred enhancements.
Keep existing wait safeguards and canonical admission identity after payload
reclamation; those are correctness obligations. These baseline passes do not
prove the replacement or close the full declaration/consumer audit.

## Reproduction and remaining work

See the experiment instructions (`README.md`, private verification evidence). The native
runner intentionally exits `2` when assertions describing the observed source
pass but product gates remain open. Exit `1` means the fixture itself failed.
Changing an assertion to permit the current faulty behavior would not close a
gate; gate acceptance and baseline characterization are recorded separately.

The review packet contains the 44-row ledger, source inventories, provider patch
assessment, coherent source/lock identities, native adapter and production-base
proof, actual-host fixture, real EvalDO integration, focused regressions and
source-hashed evidence. The affected implementation audit is complete for this
delta; full custom/provider and replacement preservation remains open.

Next acceptance is shipping M3: instantiate the selected Pi agent composition,
require exact artifact evidence on every activation route, wire authenticated
canonical domain completion with redelivery until exact acknowledgement and
resource/payload reclamation. Host reset/restore incarnation rotation is now
implemented in the maintenance journal; full process/native integration remains
required. Prove cancellation, executor death/disposal, unsafe
uncertainty and pinned-definition refusal before expanding operation families.
Then close M4 product rows and remove the displaced engine. Current component
passes do not authorize default cutover or deletion of valuable stored facts.

All native-fixture processes are terminated and awaited and temporary databases
removed in finally. An owned paired managed instance,
`durable-pi-model-port-20261002`, was provisioned for the real EvalDO proof and stopped
when verification completed. No unrelated instance was stopped. No live model
or provider credentials were used by the scripted fixture. The source fork and
review evidence remain deliverables. Existing product execution is unchanged;
host and configured Base source changes are explicitly recorded in the audit.

## Current source preservation additions

The maintained fork passes 164 focused durable tests in nine files and 84 provider
tests in five files with their respective source configurations. These cover
prepared tool compatibility, receipt/output/checkpoint preservation, incompatible
abort cleanup, compatible restoration, ordered waves and settings applying to the
next request. Provider cases cover credential type, local prompt progress, Codex
owned sockets/abort/late upgrade, stable logical request identity, retry diagnostics,
terminal HTTP refusal, observer failure and fast-tier accounting. Full prescribed
fork checks, installed declaration checks and host types pass. These cohorts
are not native provider or full product acceptance and overlap prior cohorts.

Canonical EvalDO receipts/exact acknowledgement and finite host retirement are
implemented. Inspection/control refuses missing/retired scopes without creation,
code/lifecycle refresh or admitted-context rebinding. Host storage identities now
rotate UUID/generation atomically with the existing journal replacement cursor;
recovery is idempotent and stale wake registration/publication is fenced. Their
focused host evidence and remaining physical/process/production delivery proofs
are recorded in the implementation audit and plan section 17.

The Base bound Session preflight and canonical Eval receipt consumer now load as
actual configured product source in the installed-package native proof. Identity
refusal leaves raw records unchanged before reconciliation. The receipt consumer
retains route/admission digests, reads domain truth through an authenticated service
port, commits the actual result and acknowledges its exact digest. Nine additional
installed-package checks cover absent/foreign receipts, rejected rebindings, local
commit failure/poisoned Session reopen, lost acknowledgement and conflicting replay.
The platform opener also validates exact active source/class/key/artifact identity
before registration/storage, and refuses a changed context over retained records.
These checks use controlled service responses; full production routing remains open.
Base now also contains the tested NativeAgentOwner composition: required exact
schema evidence, activation singleflight, host-bound Session, authenticated
canonical completion and joined lifecycle release. Seventeen controlled-host/SQL.js
owner tests pass; protected ports and complete product composition remain open.
The user selected `@panticonic/pi-*` with the existing `panticonic` account.
All four packages are published at exact version `0.99.2-vibestudio.2`, under
tag `durable-pi`. Registry metadata, downloaded archive bytes, SRI and source
identity match the reviewed release. An ordinary registry installation passes
all four ESM entrypoints and a real Harness commit/close. The current complete
Base composition typecheck also passes with these exact registry dependencies.
Publication evidence (`publication-evidence.json`, private verification evidence)
records the immutable library release; product cutover remains incomplete.

EvalDO domain-side completion delivery now remains durable until exact digest
acknowledgement; successful hint transport does not settle it. Schema v5 retains
absolute deadlines, caps backoff and limits a due pass to 64 slots. Activation
reconstructs missing delivery indexes from canonical admissions; exact v4 upgrade
preserves results and acknowledgement identities. The schema probe bootstrap
cycle was repaired without allowing an untrusted persisted upgrade. The 105-test
host cohort and host/workerd typechecks pass. The refreshed native fixture now
passes all seven component gates against installed `.2`, with the product gate
open and its owned managed instance stopped. The
native revalidation receipt (`native-model-port-evidence.json`, private verification evidence)
records the exact measured artifact and cleanup. Full
shipping owner/receiver, custom preservation, physical resources, default switch
and old-engine deletion remain incomplete.
