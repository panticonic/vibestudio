# Live teacher capture

## Authored task bank

`pnpm natlang:tasks --summary` counts the tasks in the configured template checkouts.
The `managedWorkspace` count is the authored bank backed by running VibeStudio workspaces
and is the count used for the scale target.
`pnpm natlang:tasks --case CASE` shows the authored task's source lineage and public request when it uses a scoped fixture.
The command reads source and makes no model calls. Managed-workspace cases have system-test fixtures.
Scoped-fixture cases use authored observations shaped by the owning template's Vibestudio contracts and have independent verifiers in that template.
They are not recorded live effects or training examples.

Use `pnpm natlang:tasks --coverage` to inspect the tracked skill documents, local
Natlang sources, mounted callables, and managed and scoped case counts for each
callable. The skill entries also show direct Markdown links to mounted Natlang
programs elsewhere in the same template. Ambiguous or unresolved assignments are listed with their possible
sources. The report shows source relationships. A co-located program or case
does not establish that every procedure in a skill is implemented or tested.

The scale target uses the baseline of 316 entries in the managed system-test catalog at System-testing revision
`eb8cc7f`. The resulting target is at least 632 independently authored cases. The baseline includes explicit-only and
qualification cases so it remains conservative and does not rise when new authored cases are registered.

The common program automatically mounts installed workflow packages under `runWorkflow.domains`. A task may refer to
workflow modules from different installed templates. The module lexically owns its types and internal calls. Each
authoritative service is both scoped to the module's exact stages and supplied by the caller for that case.

`pnpm natlang:tasks --summary` also reports `scopedRunnable`, the number of cases with a runner adapter.
The trusted harness can call `runScopedNatlangWorkflow(checkouts, caseId, natlang)` from
`scripts/run-scoped-natlang-workflow.mjs` with the `load`, `calls`, and `trace` APIs for an isolated Natlang run.
Each attempt creates fresh scoped bindings. The runner checks the authored request against the recorded root and
child inputs, and checks the reported results against the exact outputs before calling the template's independent
verifier. The verifier can also check the fixture's observed operations. Managed cases continue through the
system-test runner documented below.

The Drive fixtures use the same readiness and cursor guard as the installed skill. The local-model fixtures share the
installation and readback guard with the extension adapter. Publication runs use frozen observations from the
canonical package, panel, and publication projections. The publication fixture test recomputes those observations
as a drift check. To refresh them after an intentional fixture change, set
`VIBESTUDIO_PUBLICATION_OBSERVATIONS_OUT` to the absolute path of
`skills/publish-preflight-fixtures/observations.json` in the Base checkout and run
`node scripts/run-userland-tests.mjs --template base --filter skills/publish-preflight-fixtures/binding.test.ts`.

The shared program test can check each scoped request at its mounted Natlang argument boundary using a scripted
executor. Run it from the Vibestudio host checkout with the development templates configured.

```sh
bank=$(mktemp)
trap 'rm -f "$bank"' EXIT
pnpm --silent natlang:tasks > "$bank" &&
  VIBESTUDIO_WORKFLOW_BANK_JSONL="$bank" node scripts/run-userland-tests.mjs \
    --template base --filter packages/natlang/src/vibestudio-workflow-program.test.ts
```

Live workflow collection executes the authored Natlang root against real caller-scoped services. Policy stays in the `.nl` program. The capture, record joins, ownership checks and paged export are exact transport and durability plumbing.

## Mechanism inventory

- `packages/natlang/src/driver.ts` is the shared Natlang gateway boundary for generation and decision scoring. Capture therefore applies to every gateway provider without changing its serving protocol. Requests are snapshotted before dispatch; replies and errors are actual returned values.
- `models.ts` resolves the executor role for root and child calls. A capture-scoped executor selection resolves that role to the explicit teacher throughout the tree. Explicit named model selections retain their own identity. `.on({model})` keeps its ordinary non-inheriting semantics.
- `recordsStore.ts` joins exchanges by their actual invocation ID into the completed call record. Existing record retention and flush semantics apply. Capture does not create permanent annotations.
- `evalNatlang.ts` exposes `natlang.captureModelTurns({executorModel})` before the first Natlang call in the current eval run. Capture and executor selection reset for the next run. Ordinary runs retain no raw model contexts.
- The gateway's Pi request context and original assistant response are retained only when capture is enabled. Original tool-call IDs are preserved alongside the normalized Natlang reply. Gateway attribution describes the authenticated transport caller; call-summary owner and run fields identify the eval owner.
- The system-testing runner invokes `skills/vibestudio-workflows/runWorkflow.nl` in a seeded, caller-owned context. The shared lambda calls a typed skill tree with that scenario's assigned input and live service bindings. Panel repair uses real browser, VCS and build ports. Workspace integration uses actual conflict and decision history. Worker repair uses real compiler reports and the original manifest-declared workerd suite through Testbench. A finite EvalDO retains the run, skill calls and nested records before scope disposal.
- Domain capture resolves every assigned callable on the loaded shared program before dispatch. The problem-draft, authority, extension, agentic-change and client-admission qualifications use the same selectors as teacher capture.
- Training admission and effect verification consume these records separately. A live browser/workspace episode is observed evidence, not a claim that external effects can be exactly replayed as a portable fixture. The independent system-test oracle remains separate from the teacher's report.

## Use

List the available cases, then select workflows from the Vibestudio host checkout with the development templates configured. Use a new output directory and a model enabled on the collection machine.

```sh
pnpm natlang:teacher --list
pnpm natlang:teacher --case panel-draft-unmount --out /path/to/new-run
```

The catalog includes browser-driven panel repair, workspace VCS integration, worker diagnosis and repair,
grounded document projects, and stateful incident and release handoffs. Worker worlds cover behavior such
as routing precedence, event ordering and queue admission. Content worlds include access offboarding,
inventory migration, consent, event logistics, and dataset release and recall. Operations worlds vary
restoration and recovery readiness, approval changes, rejected gates, and continuation from durable state.
Messaging worlds exercise addressed local delivery and holding an ambiguous recipient in synthetic owned channels.
Personal Browser library cases recover a visited link, organize persisted bookmarks and retire
an exact duplicate while keeping its assigned copy. The harness uses a fresh browser-data
namespace and checks surviving bookmark metadata, visit history and an out-of-scope record.

Channel roster cases use two owned VibeStudio channels with the same handles where appropriate.
The program reuses the channel membership skill for each step, checks holds after conflicting
identity evidence, and records the exact final rosters across both channels.

Panel health cases inspect an owned workspace renderer through CDP. The outcome records the
exact ordered DOM markers and retained console sequence. Recovery requires fresh evidence from
the same panel after the assigned state change.

Presentation cases build a managed VibeStudio preview and compare its browser output with
the assigned source facts. Interactive cases also switch charts to their accessible data
tables, toggle checklist items or exercise selection controls. The exporter checks the
browser's resulting state against the assigned values and selections.

Personal Mission planning cases reconcile dependencies, relocate cards and prepare Inbox work
for Ready in an assigned Mission Control store. The verifier compares each revision and
confirms stable card IDs, preserved fields and unchanged unrelated records.

Personal Browser handoffs compose Browser library and Collection conductor in one shared
workflow. Collection writes require a live readback of the retained bookmark. The exporter
checks skill order and binds the exact bookmark URL to the persisted note on the assigned panel.

Personal Collection conductor cases organize real panel subtrees. The shared workflow resolves
references against the latest tree, applies each accepted change, and verifies live titles,
notes, parentage and sibling order. The outcome checks also cover ambiguous references,
invalid destinations and preservation of an unrelated panel.

Tendril board cases present the assigned panel on an online headless VibeStudio device. Their
Natlang stages apply a sequence of shared-state changes and exposed page calls. The evidence joins
the actual slot and device, rendered fields, durable revisions, and each nested verification.
The system-test oracle checks the same surfaces without a model. Build journeys edit the panel
source only in the assigned context. They join the candidate or restored page to VibeStudio's
proven and failed build history and verify that the same durable values remain visible.
News cases review reader setup, saved and archive views, and polling and briefing cadence.
Cadence reconciliation cases also authorize one bounded schedule intent. The program checks the
current state, decides whether to apply the intent, then reads both exact Missions owners again.
The oracle and exporter check the write receipt, owner identities, and untouched schedule settings.
Each case joins the installed News worker on its own channel and checks its readback against the exact Missions
schedule records. The `news-managed-oracle-qualification` system test exercises the installed worker and
readback without a model.
Google Workspace setup cases join Drive readiness to the installed welcome panel. They verify the
account and permission owner links, the Gmail launch gate across reload, and layout at the assigned widths.
The smoke runs in a fresh workspace before external Google account setup. The choice journeys use
the installed panel to switch app scope and browser preference, reload, and check the rendered
guidance. The nested comparison checks the choice that changed, the choice that carried forward,
and the disabled Connect Google and Open Gmail controls.
Local model comparison cases query the installed local-model extension twice. The workflow assesses the
assigned candidates against tool and context requirements and offers a fresh or fork handoff only for a
qualifying local model. The comparison has only inventory access.
Host log audits emit controlled incident lines from an owned test worker and read them from the real
server log service. The Natlang investigation checks recovery, unrelated events, old bookmarks, and
exclusive cursors. Each audit sees only its assigned tagged records.
Incident continuation cases combine the two skills. The first completed investigation unlocks
the live inventory for the local-model comparison. The exporter requires both nested skill reports,
their actual call order and the read journal, and records both source groups for split hygiene.
PDF cases use the installed extraction extension and preserve the exact page order and citation
geometry. Interruption cases deliver a controlled read error or mismatched digest after a real
extraction. The report keeps only the verified prefix, names the unread pages, and stops requesting
batches at the interruption.
PDF handoffs join intake and scratch staging in one workflow. The scratch input files are
created from the installed extension's verified page receipts. They remain unavailable before
intake, and the handoff holds its artifact if the resulting files leave a required answer open.
Terminal checklist target-state cases begin with an existing state in the owned PTY. They ask
Natlang to choose the necessary toggles in the requested order and preserve unassigned items.
The oracle checks the exact keys and screens, including cases that need no edits before restart
or reattachment.
Examples garden tasks compare visits and elapsed time against the persisted world. Clock cases
use the panel's quiet observation action in an estate without storyteller seats. The oracle verifies the exact action
sequence, elapsed phases, and attachment gains on distinct days.
Spectrolite navigation reviews retain the browser-observed source and destination of each
wiki-link hop. The navigation finding binds the whole route to the final canonical document,
and any preview finding refers to that same editor and revision. Draft reviews compare the
editor's working document against the same file at the committed vault reference. The checks
distinguish changed notes from unchanged notes in a dirty vault. The exporter requires the
nested revision-review calls and rejects stale editor text or a different committed reference.
Personal memory comparisons call the existing verified recall skill once for each assigned
revision. They retain both original quotations and independently observed endpoint outcomes,
including when one revision has no recall lead or no source. The exporter requires both nested
recall calls and the comparison judgment.
Headless session cases reconnect to owned channels and compare the fresh client transcript
with the durable message log. They check preserved order, accepted retry identities,
first-write-wins content, distinct submissions, and wrong-channel continuations. Each
checkpoint is inspected by the shared workflow's nested replay-review stages.
The runtime catalog retains the method allowlist for explicitly supplied workflow services.
Their generated model declarations come from the owning template's TypeScript signatures.
The generation check verifies catalog membership for every configured skill's service scopes.
The `remoteAccess/deployRemoteServer` workflow accepts a caller-sealed deployment assignment
from `bindRemoteDeployment` in `scripts/cli/remote-deployment-workflow.mjs`. It invokes the
same managed installer as the CLI and independently checks the protected ready record against
the running hub and workspace. An update must advance the hub boot while retaining the same
server and workspace identities. The host keeps pairing material outside the workflow.
The remote workspace workflow is available under `remoteAccess/openRemoteWorkspace`. A
trusted host caller creates the assignment with `bindRemoteWorkspaceAccess` in
`src/cli/remoteAccessWorkflow.ts`. Pass its request as the input of a domain work item and
its services as the explicit bindings when loading the shared workflow. The profile path,
invite, and target remain with the host. The workflow sees only status receipts and the
verified workspace identity. The local smoke tests a fresh pairing and an existing-profile continuation on a disposable
managed server. The harness retires the entire instance and its test device.
To deploy or update and then open that workspace in one call, use
`remoteAccess/commissionRemoteWorkspace` with `bindRemoteCommission` in
`src/cli/remoteCommissionWorkflow.ts`. Pass the binding's request and mount its services
as above. The host consumes the final successful deployment receipt and rechecks the live
identity before assigning the device route. The caller can supply invite material through
`pairingFor`. The already-running path uses the same handoff and can create a new device
profile or reopen a previously paired profile.
The Examples integration readiness cases compare a live catalog fetch binding with
an optional path outside its audience or a required publication transport on the same URL.
The managed launcher seeds a synthetic binding on a reserved hostname inside the disposable
instance. The Natlang workflow receives only destination descriptions and lifecycle receipts.
Export joins each lookup and its interpretation to the coverage decision.
Run `integration-readiness-oracle-qualification` for the model-free live check.

The Examples terminal cases execute exact caller-assigned process plans through the
native shell extension. They cover literal argv, an intentional pipeline, unsuccessful
exit status, output truncation, and held dependent checks. Export joins each bounded
result to the exact selection, execution, and classification calls. Run
`terminal-check-oracle-qualification` for a model-free live check.

The Examples GAD cases run `gad/reviewChannel` against owned live conversations.
Triage separates sound durable integrity from an empty roster and checks the exact
roster follow-up. Recap waits for both assigned headless messages to be published,
then binds the interpretation to the latest user message's ID, sequence, and text.
The exporter checks the nested calls and their exact readbacks. The model-free
qualification is `gad-review-oracle-qualification`.

Client admission cases run in the System template. They compare the assigned
working and published client manifests, published trust and live build catalog
with the selected platform's current contract. They cover a compatible terminal
client, a mobile variant on the wrong runtime and a local incompatible ABI.
Run `client-admission-oracle-qualification` for model-free verification. The
workflow inspects the platform contract without launching a device client.

Workspace unit identity combines the existing Natlang icon chooser with
the catalog and semantic VCS. The cases prepare a new icon, retain an
exact match, or review a design without editing. The edit case checks its
working-state manifest and artwork while retaining protected main. Run
`unit-identity-oracle-qualification` for the live model-free check.

Gmail compose history reviews native events from an isolated Google Workspace
channel. Cases cover retained draft identity, conflicting identity, and a
delivery awaiting reconciliation. The runner publishes synthetic compose
history inside the test workspace and the workflow reads it back. The check
does not call Gmail. Run `gmail-compose-history-oracle-qualification` for the
model-free check.

Explorer text probes compare the Personal workspace blobstore with bytes
read from an owned scratch file. The cases check byte counts, CRLF
preservation, and repeat-store identity. The runner verifies scratch cleanup.
Run `explorer-text-oracle-qualification` for the live model-free check.

Tour rehearsal drives a disposable instance of the Personal template's tour.
It maps requested topics to authorized scenes, confirms the persisted scene
and rendered frame, and verifies restoration where requested. The held case
covers a route containing an unauthorized topic. Run
`tour-rehearsal-oracle-qualification` for the live model-free check.

Build performance review profiles a disposable System workspace panel with
the native build service. Its cases interpret same-key repeat evidence and
review initial payload against an assigned budget. Run
`build-performance-oracle-qualification` for a live model-free check.

Saved log cursor review runs in the System template. It checks the observed
boot and retained sequence before classifying a bounded window with the
server-log skill. The cases cover a repeated failure, an earlier boot, and
an overflowed window. Run `log-cursor-oracle-qualification` for the live
model-free check.

Eval recovery reviews a finite EvalDO result and its native journal. The
cases cover an effect completed before a later exception, a journal-only
confirmation, and a success-looking value with an absent store. The binding
can verify an authorized content digest with independent readback.
Run `eval-recovery-oracle-qualification` for the model-free check.

PDF layout review runs the installed PDF extension over an assigned document
snapshot. The cases distinguish row-major tables, column-major narratives,
and a single sequence, then check exact fragment coordinates and text. Run
`pdf-layout-oracle-qualification` to check the original page geometry without
model calls.

Offline dictation review observes the installed local speech worker and checks
the caller's assigned recording. The managed cases cover absent audio, a
sample outside the normalized range, and a 31-second multi-window recording.
Run `offline-dictation-oracle-qualification` for the live readiness check.

Declared test-suite review resolves the manifest route in the assigned
context. The cases cover native declaration inspection, a focused native
adapter child-process check, and a workerd suite. Both execution cases use the ordinary
verification entry point. Run `native-suite-oracle-qualification` for the
model-free check.

Git Bridge review joins the installed provider's upstream status with the
working and protected-main repository identities. The managed cases exercise
an unconfigured upstream with a protected source, a local draft that needs
semantic publication, and an absent project assigned for import. Run
`git-bridge-review-oracle-qualification` for the model-free check.

Semantic VCS delivery reviews a caller-assigned file at the live working head,
committed event and protected main. The tasks cover a draft, a clean commit
ahead of main, and an unchanged assigned file in a dirty context. Run
`vcs-delivery-oracle-qualification` to check the revisions and assignments
without invoking a model.

The assigned web brief uses live public Chromium fetches and verifies the
cleaned source bytes by reading the host's cached digest. The cases cover
two-source citation, the registry's scope and an unsupported question. Run
`web-brief-oracle-qualification` for the model-free public-fetch check.

Architecture boundary cases trace the actual local RPC provider to its
authored declaration at the assigned semantic revision. They cover semantic
history, an owned creator-scoped conversation, and durable mission records.
Run `architecture-boundary-oracle-qualification` for the model-free check.

Release review handoffs compose extension review, authority preflight and scratch
handoff in one Examples context. The scratch sources are materialized only once
the upstream reads establish the release and scope findings. The artifact must
quote the exact source lines. Run `release-review-handoff-oracle-qualification`
for model-free verification of the dependency gates and persisted artifact.

Extension review cases reconcile the working and protected-main repository
trees and manifests with the real host status and exposed methods. Two cases
stage a manifest change or an implementation-only change in a disposable
context and require the published source and active runtime to remain
unchanged. Run
`extension-release-oracle-qualification` for the model-free check.

The authority review cases call the real host preflight without invoking
the reviewed operations. They check an open read, exact-origin consolidation
across distinct URLs and refusal to extend the caller's scope. Run
`authority-review-oracle-qualification` for the model-free live check.

Local problem report cases exercise the workspace's real manual report store.
The shared workflow classifies the account, authors a local narrative,
appends at the observed revision and verifies the saved sections. Cases cover
a new report, continuation preserving an existing symptom and a stale revision
that must remain untouched. Run `problem-draft-oracle-qualification` for the
model-free write, readback and scope checks.

Agentic change planning cases read installed source guides at the managed workspace's
immutable working head. The shared Natlang workflow delegates ownership, retained
history, builds and canary planning to separate functions. The cases cover a chat
boot change and a coordinated replay-contract change. The model-free
`agentic-change-oracle-qualification` test checks the live source binding and rejects
foreign contexts and wrong revisions.

The System phone case `phone-setup-live-desktop-unavailable` asks the shared
`phoneSetup/setUpPhone` workflow to check the owned account for a compatible desktop.
It binds the live public phone service with read authority and checks that the workflow
stops before preparation or pairing. Export requires the exact provider receipt on the
nested desktop decision and the absence of device effects. Its model-free qualification is
`phone-setup-oracle-qualification`. The case runs without a connected desktop.
Testkit cleanup cases open real scratch directories, workers, panels, and CDP clients in an
owned workspace. They retain deferred registration order and probe the remaining resources
after Testkit finishes. The Natlang review reports test outcome, cleanup acknowledgements, and
actual inventory separately.
Natlang authoring cases compile the candidate and baseline in the workspace. Service-scope
reviews compare exact callable selectors, call-chain selectors, and explicit empty grants.
The exporter binds the compiler scope readbacks to the inspected revisions and requires the
nested authority-review calls.
Runtime program reviews compile caller-owned scratch source through the installed Natlang loader.
When a task includes execution, a separate EvalDO run loads and calls the exact typed program.
The review distinguishes checked output, unchecked output, failure and a receipt from an older
source revision. The exporter checks source fingerprints and the original execution run ID.
Provenance history cases read cause, cohort, and rejection walks from a disposable semantic
repository. The fixture records an actual counteraction. Reports cite compact refs tied to
the exact file, scope, and immutable workspace head.
Proposal reviews also run the existing Natlang constraint judgment over the collected walks.
Repeated views of the same reason count once, and a recorded counteraction can reject an
equivalent change. The exporter verifies the decision and the cited live evidence.
The release-readiness dossier joins two skill trees in one call. It requires observed recovery after a real worker restart
and verified cleanup before the project skill can prepare and commit the evidence dossier.
Publication preflight uses a locally built website and a real preview panel capture. It checks
approval for the exact destination, provider, and environment, and distinguishes audience labels
present only in the website package from labels observed in the reviewed panel. Controlled delivery
faults exercise missing HTML and changed manifests. The checks cover review and publication status.
Automation lifecycle cases use manual-only Missions. The test context can install a new revision
around a pause or resume, or interrupt the receipt at the service boundary. The workflow uses
at most one scheduling attempt and reports the actual installed state and revision. The oracle checks controller receipts
and confirms that the automation did not start a run.
Integration handoffs combine the workspace integration and scratch evidence skills. The scratch
binding opens only after the VCS oracle verifies the integration. Some questions require
citations from multiple resulting files. If those files lack a required decision, such as a
signed approval, the case requires a hold with the precise unanswered questions and no artifact.
The authored inventory comes from the configured system-testing template, which supplies
the same worlds to the explicit system-test runner. `--list` prints each case's source groups for split hygiene.
Repeat `--case` to run selected cases in the managed workspace composition each case declares.
Cases with the same composition share an instance. The collector retires that instance before starting the next composition.
The managed runner can provision a private System or Personal workspace, or a workspace
from a registered catalog template listed as a consumer of the development test harness.
For example, `pnpm system-test --instance examples-smoke --workspace examples doctor` provisions
the actual Examples composition and pairs to its workspace ID. Use the same instance and workspace
for the test and stop commands.
Each case gets its own system-test run, owned fixture context, source receipt and output under `cases/<case>/`.
The final status indicates whether every selected case succeeded. Successful cases remain available when a later one fails. The collector checks the vendored Natlang build, pins the host and templates, and retains the full
system-test trajectory. A new workspace can ask for access to the selected model's credential.
The approval identifies the model gateway and provider for that workspace.

Content cases and the release-readiness dossier need `--review-model PROVIDER:MODEL` with a model distinct from the executor. The independent judge
reads the actual committed document bytes against the test's original goal and facts. It uses the built Natlang Node host
in `$NATLANG_REPO` (default `~/natlang`) and its configured provider login. The artifact retains the review separately from
executor targets.

On success, `verified/manifest.json` binds the original call tree and the independent effect checks. For shared-program
runs the exporter requires the common root, the assigned skill as its direct child, and that skill's own nested stages.
The verified
manifest is the input to Natlang's [shared SFT pipeline](https://github.com/werg/natlang/blob/main/plans/neuralese/LIVE_WORKFLOW_SFT_20261118.md).
Failed runs retain diagnostic artifacts.

## Capture API

Enable capture before executing the program:

```ts
natlang.captureModelTurns({ executorModel: "provider:model" });
const program = await natlang.load("skills/example/root.nl", {
  services: { world: callerOwnedWorld },
});
await program(actualInput);
```

Use the completed run's actual root IDs and raw traces. Export rejects incomplete records, a different run, missing parents or mixed owners. The teacher capture rejects any captured generation whose actual returned model differs from the chosen teacher. If a call is missing, treat the episode as incomplete and rerun it in a fresh owned fixture; do not synthesize a request or reply.

## Console history provider parity

The first direct live teacher reached the real panel service, then failed because the headless console store returned the pre-pagination result while `panelCdp.consoleHistory` requires a `page` object. The schema and panel observation contracts already describe a stable sequence cursor. Desktop's CDP provider implements that cursor and every advertised source/text/time filter; headless previously implemented only level filtering and limits.

The mechanism inventory covers the headless `ConsoleHistoryStore` and its `HeadlessHost` dispatcher, desktop `CdpHostProvider` (including its durable runtime-diagnostics-backed history), the shared panel observation contract, and the validating `panelCdp` RPC schema. Mobile-held panels do not provide CDP (`src/server/panelRuntimeRegistration.ts`); they do not implement a third console-history store. Shared filtering/paging is exact observation plumbing, not a model policy. Both providers use the same filter/page functions, while each retains its own ingestion and storage. The desktop durable diagnostic store keeps its existing filtering before shared pagination.
