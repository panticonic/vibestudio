# Agentic bundles and self-contained workspaces

> Isolation planning (2026-09-06): [Native execution and isolation](isolation-plan.md) is canonical for platform execution, trust assumptions and release acceptance. This document owns product and RPC protocol requirements, including workspace ownership, Base extraction, template simplification and website behavior. Its application authority rules do not establish stronger native containment than the platform contract.

Status: implementation in progress, 2026-09-08. The user accepted rules 1–5 below.
The full runtime, cross-workspace integration, client UX, and verification work is
not complete. The existing filename remains so hand-off links continue to work.

## Current workspace-source decision (2026-09-08)

The user approved removing the template catalog/registry subsystem, with no
backward compatibility. This decision supersedes earlier catalog revision,
cache, promotion and onboarding catalog requirements in the historical progress
entries below. Service discovery and the agentic test catalog are unrelated and
remain necessary.

**Add workspace** opens creation directly; existing workspaces remain in the
sidebar. Source choices are a host folder or a Git URL, with ordinary example
source addresses where useful. Browser panels can offer an Add workspace link
through the existing shell-surface protocol with a `source` URL parameter. Links
prefill review; they do not create or approve a workspace. Desktop and mobile
use the same source semantics. A host-picked folder is checkpointed from its
visible bytes and acquired through the existing exact-source owner, including
uncommitted files; it must not silently fall back to cloning remote Git.

Root Base commit `a40f14d` implements the direct UI, source-session ownership,
mobile URL review, native picker handoff, and template skill migration. Base
`5b82d4d` removes onboarding catalog state/routing; `7c1d3dc` removes remaining
active catalog guidance and updates RPC examples with explicit website policy.
Current focused evidence: 18 desktop/folder review tests, 10 mobile creation
tests, 28 Host protocol/panel-link tests, and all three Base type projections.
The folder-source Host owner has 74 focused passing tests. Native folder run
`20260908T095652908Z-3153492-3a1f0a14` passed the actual picker, dirty-source
checkpoint, hub registration, exact review and created panel flow, with owned
runtime cleanup confirmed. Browser-link/onboarding native replay and the updated
creation-card visual acceptance remain outstanding.

Base `cfe46e9` documents the shared creation workflow and removes stale skill
routing. The latest UI uses selectable **Start fresh** (configured Base),
**Folder**, and **Git URL** cards; desktop offers matching secret-free connected
account summaries instead of a raw credential-name field. Desktop focused tests
18/18, mobile tests 10/10, and all three Base type projections pass. The UI was independently reviewed and committed as Base `9789427`. Native
folder replay `20260908T100402915Z-3167632-facba606` passes with the new controls;
root inspected its clear post-picker review screenshot. Source-launch/candidate
ownership is still being simplified before complete native acceptance.

Base `711c456` repairs four additional multiline worker RPC documentation examples
that omitted mandatory website decisions. A new Host test validates all fenced
receiver declarations across the actual skills through the production build
parser; it passes and has been independently reviewed.

The broad agentic slate recorded 51 distinct tests. Four initial nonpasses need
resolution: binary input, a retired catalog test to replace, worker SQL with stale
RPC documentation, and an atomic panel/store fixture missing an explicit website
decision. Fresh exact reruns are active; this is not yet a passing 50-test gate.

Remote template source publication remains unfinished: old released source
revisions still contain `meta/template.yml`. Removing the registry does not
publish the migrated source repositories. Validate and publish the current
standalone sources before claiming remote URL creation works end to end.

Latest regression audit (September 7): evaluate failures against the user's working
workflow, then inspect every caller of the owning mechanism. A successful build or
an agent's completion message does not prove that a panel can use its backing service.
The catalog now includes `atomic-panel-store-install-clearance`, which jointly creates
a panel, its store and service declaration, publishes them, and drives a persistent UI
effect without unexpected approval. The scenario has run, but its final publication
and store-UI verdict remains outstanding; separate service and app-building tests do
not close this gap. The reported task-board panel contains the exact declared store
request. The owning defect was confirmed: candidate publication used the live capability
presentation resolver, which could not describe a service introduced by the same
transaction. Host `9ed904d35`, `38fb3ace0` and `2d11204b9` carry exact candidate
service facts through review rendering and grant issuance, including direct requests
without a protocol. Missing dynamic services remain explicit negative facts; actual
product services come from the generated builtin catalog. The UI-to-grant regression
passes (18 tests), as does the subsequent candidate classification coverage (52).
A passing atomic generated-app acceptance run remains required.

Regression reviews must distinguish declarations, granted authority, and observed
effects. The generated-app harness must inspect the actual installed version and
structured saved grant before opening the panel, then write through its UI and read
the same value after reload. An agent-authored receipt, source-code substring, or
human-readable permission label cannot establish those facts. Keep negative cases
for stale versions, same-named replacement services, denied/session-only grants and
unexpected prompts. Existing app-building tests remain useful and are retained;
this joint publication/installation/use scenario supplements them.

The wider audit found two related update defects: previous/candidate authority hashes
used different fields, and admission deduplication omitted exact service review facts.
It also found that replacing grants by rescanning their code subject after minting
could revoke the replacement grants when the consumer's effective version stayed the
same. Host `12625a2ec` uses one service-authority identity and retires the exact outgoing
grant records captured by the transaction; it does not invent a different code identity.
Unchanged publication, changed service facts, same-version replacement and
failed-publication rollback pass together (57 focused tests and normal host checks).
Legacy admission records are validated before migration. Template/upstream protected
publication converges on the same acceptance path. Native generated-app acceptance
remains outstanding before closing this audit.

The reported missing `@workspace/test-runtime` was not an undeclared app dependency:
the captured failing worker manifest already declared it. Distribution dependency
closure omitted the package because the workspace scaffolder did not declare its
own generated-code requirement. Base `af919cb` fixes that ownership; host `a81f643e6`
checks the distribution closure and reports missing internal dependencies at graph
validation instead of silently dropping the edge and emitting misleading resolver
advice. Focused graph/distribution tests (25), scaffolder tests (29), host checks and
all userland type configurations pass. Fresh agentic test execution remains necessary.

Private tree simplification now changes actual ownership, not only section headings:
host `1f4658630` normalizes persisted and seeded Personal/System panel slots to the
immutable private owner, preserves order and leaves shared ownership unchanged.
The initial implementation passed local tests but sent an undefined tuple element
which JSON encoded as null for shared workspaces. A real profiling bootstrap caught
this; `648475e7e` uses the proper one-argument shared invocation and verifies the wire
contract (84 schema/workspace tests). This is evidence that direct handler tests alone
are insufficient for serialized RPC contracts.

The latest desktop native replay on host `2fcecd5f6` preserved the same original
onboarding panel and setup card across server restart, with full-width title bar,
no private owner bands and clean renderer diagnostics. Base `d7a9c7a` fixed the
previous cold-recovery warning: shared object identity in the onboarding catalog
made its cached scope value non-serializable. The exact serializer and setup tests
pass (20), and the native replay now verifies recovery. This native fixture uses a
deterministic model; it does not prove live-provider one-time credential approval.
The full suite still failed later in its shared-member phase because the new harness
read `invitation.user.id` instead of the existing API's `userId`. Correct the harness
without weakening its membership/revocation assertions and rerun that phase. The owned
native applications, hub and temporary state were cleaned up after the failure. Read-only
CDP coverage (`8be57b927`, 24 tests) proves bounded screenshots remain available while
raw mutable endpoint acquisition is rejected. The debug workflow documents that
distinction; this does not establish an unrestricted read-only DOM automation API.

The owned agentic sweep has completed 50 distinct scenarios: 44 clean passes,
five failures and one semantic pass with an unexpected recovered tool failure.
Fresh repaired directory-operation and worker-environment cases pass; the remaining
failed cases and atomic generated-app/store acceptance are still being repaired and
verified. Directory failures exposed missing discoverability of scoped runtime
filesystem operations. The remove scenario asks only for a temporary tree; the agent
invented an OS `/tmp` path after reading terminal guidance. Repair that owning guidance
and preserve the scoped filesystem validator, rather than granting native shell access.
The sweep's owned instance has been stopped and cleaned up. Fresh runs must provision
an owned instance from the current Host and Base sources.

A wider notification audit found that the multi-workspace refactor retained the old
Personal-only bridge lifecycle. Every browser page exposes the notification API, but
its sole native handler started only when Personal cookie projection became ready,
and attributed every request through Personal's permission controller. Thus other
workspaces could not use their own granted website notifications, and a Personal
browser-data outage disabled the unrelated feature. Single-workspace document tests
missed the integration defect. The bridge now belongs to the application window and
resolves the actual native view's workspace through the existing workspace-service
registry. Permissions, event delivery, panel IDs, actions and tag replacement stay
with that captured owner; workspace detach and window close retire their notifications.
Focused tests cover System/ordinary workspaces without Personal, identical panel IDs
and tags, session replacement, cross-workspace actions and window recreation, retaining
the prior document-lifetime cases. All 42 focused tests and host typechecks pass;
native acceptance of workspace routing remains outstanding. The shared document
compatibility script subsequently passes 27 focused tests across adapter, document API
and host bridge; a hidden Electron check under `script-src 'none'` verifies main-world
installation, remembered permission, accepted show and close. The owned Electron process
exited and its temporary profile was removed. This uses Electron's explicit
`webFrame.executeJavaScript` source-injection API, not function construction or a new
page-visible evaluator. Shared lifecycle tests also fix lost close events and premature
service-worker `showNotification` success. Mobile has no completed website
Notification bridge yet; its app/server notifications are a different feature, so
this desktop correction does not establish mobile website-notification parity.

The latest native replay on host `9f7258c79` / Base `37efea3` passes cold onboarding,
reconnect and strict renderer diagnostics, but fails at the bounded wait for the
owner's member-removal approval card. The harness used ambient workspace selection
for browser creation and removal; captured workspace/panel targeting is being repaired.
GC retention failures also lacked their already-captured provider identity/error in
logs; diagnostics must preserve that evidence without suppressing failure. The failed
run's owned applications, hub and temporary state were cleaned up. No shared-member
revocation acceptance is claimed yet.

The subsequent replay on host `a27aa1530` reached the same approval failure and was
interrupted after invalid setup was identified; it is not a pass. Its processes and
owned temporary root have now been removed. The existing test API's default receiver
is System: supplying a shared panel as parent does not retarget that receiver. Use
its existing `forWorkspace(id)` binding for shared browser creation, while keeping
the host-local membership operation in System. Preserve structured acquisition
errors and separately observe challenge, queued request and visible card; a string
containing `approval-required` is not evidence that the approval UI received a request.

That distinction exposed a product defect, not only a harness defect: the Electron
main dispatcher previously resolved authority without acquiring it, returning
`EACQUIRE` with `pending: false`. Canonical acquisition and explicit native UI owner
routing now use the existing coordinator, approval queue and grant store; Host
`60cd127e7` covers native UI session ownership. This does not establish acceptance
for every gated main-local method. Native tests must still prove that the request
reaches the review UI and the original operation completes after approval.

The improved GC diagnostics exposed another retained integrated-workspace assumption:
the mandatory development-run root census depended on an optional service distributed
only with System. Host `b9d921d75` replaces that dependency with durable native run
markers and publication-journal ownership. Artifacts are reserved before asynchronous
owner writes; migration, publication and retirement serialize around the same owner.
An empty workspace now has an authoritative empty census without the optional service.
Collection previously failed closed; there is no evidence that retained data was deleted.

The sibling retention audit also found that runtime entities and panel history
resolved only the current metadata for a build key, ignoring their recorded exact
execution digest. Shared bytes do not imply shared execution/source identity. These
owners now use the existing retained-execution lookup, and the common build-key
provider rejects a resolver that substitutes another build or requested execution.
The focused provider, retained-build/restart and GC tests pass together (35). This
correction does not resolve the optional development-service dependency above.
Tracing the complete collection path then exposed a second loss of identity:
the build collector reduced provider roots to build keys before semantic source
preflight. It now carries every authoritative execution's source content roots
alongside quarantine roots in preparation and commit reports. Distinct executions
sharing bytes therefore retain both source histories. Missing artifacts still make
the census incomplete, and product-seed roots stay outside workspace collection.
The startup/retention and semantic-preflight tests pass together (28).

The broad sweep also exposed host rebuild cleanup deleting the Node executable and
MXC launcher used by already-running instances. Host `7a5d36dc8` and `71a6d1fde`
preserve those publisher-owned runtime inputs while removing compiler outputs; the
existing publisher verifies their integrity and owns atomic replacement. The runtime
survival tests pass (4). This is not proof that every other lazy host artifact remains
available across a concurrent rebuild.

Startup profiling identified avoidable instance-local derived caches. Host `40cd51852`
reuses verified profile-shared build payloads while resealing workspace-owned execution
metadata. A fresh same-source instance measured 8,541 ms versus 11,639 ms for its
first cold profile; this is repeat-instance reuse, not first-ever startup acceleration.
Host `2fcecd5f6` then removes duplicate metadata parsing/copying and artifact checks
after successful atomic hydration. The non-typecheck remainder fell from 1,313 to
910 ms, but total profile time rose from typecheck variance, so no overall improvement
is claimed for that second measurement. Focused tests pass (38) and every owned
profiling instance has been stopped.

The retained startup-approval E2E previously approved extra model/channel service
prompts, concealing lost installation clearance. Host `30744cc98` removes that
substitution and asserts no unexpected service prompts while preserving explicit
credential/network decisions and the original automatic onboarding. The original
launch-gate scenario passes in a native desktop (45 seconds), with its setup-card
screenshot inspected and fixture cleanup complete. The broader acceptance matrix
and remaining original startup scenarios are not thereby declared passing.

Credential audit remains open: `resolveCredential` authorizes access to a private
credential summary, then actual egress separately authorizes use. Choosing "once"
at the first step does not authorize the second. Model calls and `forAudience`
follow this sequence; direct fetch/Git already let egress own the concrete operation.
The model path also consumes account claims before its SDK sends a request, so simply
removing the first check would expose private metadata. Re-derive selection, metadata
access and actual-operation consent together, using the existing operation identity
where appropriate; do not hide the second prompt or issue a broader persistent grant.
There is no end-to-end passing one-time model-operation test yet.

Implementation evidence so far includes a real isolated standalone System bootstrap
passing all system-test doctor checks, followed by `build-service` passing with no
tool failures (`st_396c9699b31e44b284f798138ac481a3`). Its owned instance was stopped.
The retained snapshot-authoring flow also passed a real-agent preparation-only
scenario with no tool failures (`st_cfb4de05e5b64b1e99aa21ed0ed45c9d`), after
successful doctor checks; that separate managed instance was stopped as well.
Native npm lifecycle code was separately verified compiling/linking C++ inside MXC
while a private host-file read was denied. These checks are evidence for those
specific paths, not completion of the acceptance matrix below.

The desktop client has also passed an actual Electron launch using its designated
System workspace, with Personal and System available in the sidebar. Native browser
storage is scoped to the authenticated hub/device namespace and workspace identity;
identical workspace IDs on different servers cannot share a profile. The native
Personal → System → Personal switch check passed while preserving the same app
WebContents; its owned Electron, display and hub processes were cleaned up. Template browsing and
exact-source review have been visually checked at desktop and phone widths.

Base, Personal and System have separate positive source inventories. Examples,
Google, News and Spectrolite have been converted to self-contained source snapshots.
Their closures also validate from clean Git archives, independently of local
untracked files. After restoring Personal onboarding and the desktop/mobile
ownership fixes, all three were rechecked from the clean committed Base archive
`6c6c7b0`: Base contains 61 repositories and 1,287 files, Personal 79 and 1,393,
and System 99 and 1,917. Personal declares the initial chat; Base and System
declare New Panel. The four optional templates' earlier checks contain
76/66/64/63 repositories. All include local template instructions and the Base
testing companion. Packaged startup now needs exact publication receipts for
the three runtime distributions; the old single-Base release artifact does not
supply those coordinates. No publication has been performed and no updater or
release-recovery subsystem is being added.

Approval visibility is an account boundary inside shared workspaces: a request
attributed to a user is visible and actionable only by that current member. Browser
permission ownership and requesting-user attribution must agree. Unowned source
admission reviews belong to current workspace administrators. Preparing operations
remain visible progress, but do not increase the actionable approval count. The
same rule controls queue decisions, snapshots, events, push notifications and the
per-user counts shown for all workspaces in navigation; clients do not connect every
workspace session merely to discover attention. Both clients expose the same
multi-workspace navigation and workspace-owned panel trees. A session that has not
connected yet is a loading detail, not a separate category of workspace. Opening
the global approval queue connects listed workspaces with pending requests through
the existing session directory, without changing the current workspace or opening
their panels. Loading failures remain visible and retryable in the queue.
Ready workspace-creation reviews are included in that count. Native App units
are admitted and hosted only in the user's designated System workspace; app
source in an ordinary workspace remains source and does not create an orphan
native-launch review. The identity schema now supports account-only pairing without fabricating a project.
The 14-to-15 migration preserves already-used developer profiles, existing pairing
invitations and membership, alongside the earlier 11-to-13-to-14 migration chain.

The development startup contract is an ephemeral **instance**, containing the
authenticated user's Personal and System workspaces. An explicitly requested project
remains optional; default startup does not invent a third `dev` workspace. Desktop
and mobile must read the same workspace-owned initial panel tree. Distribution
`initPanels` are initialization data, not commands each connecting client repeats:
WorkspaceDO reserves entities and creates slots in one durable transaction, with
normal runtime recovery handling activation. Completed initialization does not
recreate panels the user deleted. Existing durable panel history is preserved.
Desktop native startup and seeded-panel lease checks pass; final mobile acceptance
remains outstanding.

The latest `pnpm dev` report exposed desktop layout and shared ownership defects.
The active panel must fill the available viewport, while the entire workspace
sidebar scrolls as one content-height list with shared-scroll virtualization.
Layout persistence and focus use the panel's workspace client. Desktop and mobile
present one shared approval queue across workspaces, with each item keyed by both
workspace and approval identity. New requests open the shared review surface without
changing the active workspace; an in-progress review keeps its selection. Cards,
icons, payload reads and decisions retain their original workspace client, and
revoked membership removes that workspace's items. Sidebar counts remain useful
entry points into this queue. This replaces separate background-workspace review
banners. Notifications appear in visible application chrome with their workspace
name and captured actions; they do not become permission decisions. Mobile reuses
its existing account-level toast host for notification visibility.
Source browsing should lead to an existing setup review when one is pending.
The shared queue passed focused desktop/mobile tests, all three userland typechecks,
and an independent review of owner restoration, withdrawn requests and delayed
selection. The viewer bound to a hosted panel is now its authenticated user under
the exact current presentation lease; shared panel creation does not lend its
creator's browser data to later viewers. Focused RPC, HTTP, real-QUIC, gateway and
live-caller tests passed (182 tests), including lease takeover and revocation.
Restart fixes keep shared build metadata independent between workspaces, wait for
workspace startup before admitting persisted peers, and install a reconnected
session before awaiting recovery callbacks that use it. Focused regressions pass.
These fixes are being validated natively, not yet recorded as a full native pass.
An earlier local Electron smoke passed on host `257594f01` and Base
`faf70e2`: exactly Personal and System, Personal initially focused, New Panel
filling all 927 available content pixels, and its real history-provider request
succeeding with zero rows. Both workspace icons decode without switching focus.
Strict native diagnostics pass. Normal ephemeral shutdown stops both service
containers and the hub; all 30 captured processes and temporary instance state
are gone. The initializer reuses the ordinary panel ID producer, with 127 focused
regressions including real seeded-panel lease acquisition. The smoke launches the
actual app package, with its version metadata and canonical ephemeral instance
lifecycle.

That smoke incorrectly accepted New Panel as Personal's initial experience. It
did not prove the required automatic onboarding. Personal's distribution had
omitted both the onboarding chat declaration and its skill, while the existing
template test still read the aggregate root manifest that retained them. The
existing test now materializes Personal and preserves its original prompt and
behavior assertions; it failed against the regression and passes with the
original chat options and local setup dependencies restored. Existing chat
lifecycle tests and onboarding catalog, routing, status and setup-card tests
also pass. Desktop and mobile native checks now require automatic Personal
onboarding. Explicit New/manual-chat
flows are separate behavior, not a substitute for this startup contract.

The existing desktop startup-approval E2E was then run with the restored Personal
fixture. The automatic prompt was delivered and the real onboarding skill read
completed, but its original completion assertion failed: deterministic inference
repeatedly read the skill because it compared stored tool-argument references to
argument values. Base `4a8d3d6` makes deterministic and normal inference consume
the same hydrated model history. All 30 executor tests pass, including canonical
stored-argument encoding; all three userland typechecks pass. The failed native
run had no panel-initialization or main-process errors, and its 34 captured
processes and temporary instance state were cleaned up. The next run passed the
original automatic-prompt, skill-read and completed-turn assertions, but exposed
another deterministic-inference mismatch: `activeToolNames` lists local tools;
the panel advertises `inline_ui` through its channel. Base `1a88c51` makes both
inference routes consume the same published tool schemas. The retained desktop
startup-approval E2E then passed in 52 seconds on host `6004aac5d`, including the
visible setup overview and Refresh control. Its native screenshot was inspected;
the owned instance, display and temporary state were cleaned up. Full Android
onboarding and the remaining native recovery journeys still require verification.

Host `6004aac5d` also adapts existing desktop lifecycle, navigation, terminal,
contextual-chat and phone-width tests to one captured workspace-owner helper
contract. Ordinary fixtures now use actual Personal; System and project fixtures
are explicit. Custom source changes edit the authored template manifest. All E2E
and setup sources typecheck, seven fixture/owner tests pass, and the three existing
approval-flow tests pass with an isolated temporary SQLite database.

The retained browser-startup and restart-persistence journeys then exposed two
real integration defects. Native test actions wrongly required an app in Personal,
and panel creation attributed admitted interactive shell actions to parent panel
code. Host `f03136c0c` uses the existing native shell route with a captured live
workspace owner and live System chrome; `f9d7611ea` reuses the canonical interactive
chrome predicate for authority attribution. Ordinary app actions remain scoped.
A separate review found no regression in either change and traced a pre-existing
unresolved-parent authority bypass: headless root creation into an existing context
skipped the boundary. Host `070dabc7d` retains the authenticated caller when no
anchor exists, allowing the normal authority evaluator to decide. No new host
exemption was added. All 16 focused tests and host/workerd typechecks pass.

Persistence also revealed that local Help was omitted from Base and Personal's
positive source inventories. Base `946c56d` includes that existing panel locally;
there is no cross-workspace sourcing. On host `f9d7611ea` / Base `946c56d`, the
original browser startup without optional browser-data and panel persistence
across restart both pass (31 and 46 seconds). The existing panel rebuild test also
passed in the earlier run. Each owned native run completed process, display and
temporary-state cleanup. Focused authority/state tests (59), distribution and
onboarding tests (10), and host/workerd typechecks pass. Base `7746210` also updates
the rendered onboarding card to explain that catalog choices create separate
workspaces; all 11 existing setup-card tests pass.

The full Android run on host `f9d7611ea` / Base `946c56d` rendered the automatic
Personal prompt and completed its first turn. Camera approval attribution, native
cookie isolation, retained workspace focus, and persisted app cold-start with zero
panel-asset pipe misses passed. Server restart then failed on a retained inline UI
source-loading error, `Iroh pipe closed`. All owned emulator/server processes exited;
restricted diagnostic state is retained at `/tmp/vibestudio-mobile-smoke-nFgxvg`.
This is not a completed Android acceptance run.

Investigation found that pipe close emitted an untyped error and inline UI retained
its failed source read across channel reconnection. Host `ed5af7f93` now emits the
canonical connection-loss error. Base `cdaf3f1` invalidates source attempts on channel
reconnection while preserving compiled components whose source is unchanged; 12
existing source-hook tests and all userland typechecks pass. Native visual inspection
also caught System About using a desktop-only service; Base `de377ae` serves the
canonical app-info contract in the authenticated mobile bridge (26 tests pass).
The smoke now requires the visible Personal chat, since a retained offscreen chat
must not satisfy its screenshot assertion. That stricter replay caught a success
toast covering the approval button: the approval tap instead opened About in System.
Base `3da9db9` places transient notifications below the toolbar in normal layout.
The next native run kept Personal focused and rendered the actual setup overview;
its screenshot was inspected, and browser/cold-start checks passed again.

Server restart then exposed both lost error identity in dependency resolution and
a missing mobile bridge event. Base `4d02f94` preserves structured transport/access
errors through source candidate resolution and compilation (63 eval tests and 13
source-hook tests pass; existing renderer consumer tests also pass). Base `b571799`
wires the panel runtime's existing recovery contract into mobile, using one
current-owner selection for both recovery kinds (3 focused tests and all userland
typechecks pass). The native assertion also requires the compiled setup overview,
so a silently missing inline card cannot count as recovered. Native replay remains
required. A subsequent replay passed the strengthened onboarding assertion but
failed exact retained Personal document URL equality after the System cookie-clear
journey, before server restart. No Personal reload event was captured. The test now
records its target, exact before/after URLs, document identity and time origin;
JavaScript evaluation exceptions also propagate directly. The original retention
assertion remains intact. The next clean build exposed a stale native-import policy:
it still named the obsolete workspace-selection module instead of the workspace
directory that owns Iroh account/session lifetime. Base `dd4af9e` updates that owner
declaration and removes the obsolete one, with a regression at the Metro boundary.
Every failed run retired its owned emulator/server processes.

The latest desktop native run completed automatic onboarding, reconnected without
pairing, retained both workspace trees, and created System New in the correct owner.
Its strict diagnostics still failed on outage errors, before membership revocation.
Base `fe26167` preserves profile attribution during transport loss and verifies refresh
after recovery while retaining genuine error diagnostics. Host `8aeb6199f` fixes the
native IPC boundary stripping error identity (36 dispatcher tests), and `214a886e3`
classifies typed subscription wrappers (18 focused RPC tests). The next desktop run
removed all shell warnings but exposed chat resubscription exhausting while the server
was still unavailable, then cold recovery losing live UI scope. This remains under
investigation; functional results do not count as a full desktop native pass.

Android's complete native replay passed at host `a3e07451c` / Base `06acdb6`: original
automatic onboarding and compiled setup card, camera denial, cookie isolation, same
Personal URL/document UUID/time origin, app restart and server restart. Both restart
checks reported zero panel-asset pipe misses; the recovered card screenshot was
inspected. The earlier exact URL mismatch was not reproduced, and its assertion
remains strengthened. All owned emulator/server processes exited. Evidence and the
source/artifact receipt are retained privately under
`/tmp/workspace-native-evidence-20260907-vtnh4bi7/`.

Base `0c4523b` subsequently carries icon version and source-state through mobile's
existing toolbar/drawer paths. It fixes an initial failed image request remaining on
a placeholder after decoration became ready. Ten focused mobile tests (including
late icon arrival after an image failure) and all three userland typechecks pass.
This small presentation change postdates the complete Android native replay.

The user-reported hamburger rejection is fixed in `4eeec3e02`: native menu calls
from host-attributed workspace chrome now reach the existing live-view capability
check. Unbound host callers still deny (2 focused dispatcher tests; full host hooks).
No menu-specific trust exception was added.

Desktop recovery inspection then located the actual lease dependency: renderer
resubscription ran before the owning workspace restored its panel leases, and the
native relay hid an underlying terminal session from its existing recycling rule.
Host `bca927c87` restores leases first and exposes terminal session state. The attempted
transport-wide barrier was removed. Focused lifecycle tests and host hooks pass;
`03579d94f` now also requires the same completed onboarding panel and card after restart.
Native replay remains in progress.

The live report of indefinite onboarding typing exposed incorrect attribution at
host-driven DO invocation. Native stage tracing proved that the panel caller, agent
creation initiator, durable owner, and credential caller all carried the same real
user. `RpcServer.withAuthorityParent` nevertheless installed a synthetic
`server/system` authorizer. The credential service preferred that authorizer and
queued a private approval for `system`; the real user's shell correctly could not
see it. This is not an entity-ownership or overlay-rendering failure.

The wrapper predates this workspace work (July 24, `8f23c2d31`); the fabricated
authorizer was added August 7 in `3a4160192`. Host `2b1a3f066` removes it.
Host-driven invocations now retain the authenticated DO subject for nested effects
while preserving the exact receiver nonce, capability constraints, context integrity,
and invocation lifetime. Actual delegated calls still retain their verified
initiator. The regression exercises the wrapper and nested credential RPC dispatcher;
all 122 RPC server tests pass. Earlier `11d3b0996` and `f72f0e202` made approval reads,
decisions, and event audiences consistent with verified initiators, but did not fix
the host wrapper's fabricated attribution.

Host `ed8351977` rejects private approvals without an eligible workspace member
before persistence. Base `bcb2581` terminates model execution on structured user
refusal or receiver rejection, rather than retrying an unanswerable request.
Administrative workspace-unit admission remains supported. Existing queue fixtures
retain their behavior assertions with explicit private request owners. Focused host
checks (78 tests), model executor checks (32 tests), host commit checks, and all three
userland typechecks pass. The existing loop and chat projection suites also pass
(150 tests), including terminal credential failure closing the interactive turn and
rendering the failure reason as a visible diagnostic. Real credential prompt
presentation now passes native acceptance: the real Personal credential card remained
visible across a six-second refresh interval and accepted a one-time decision.
The same automatic turn passed credential resolution, then hit a second local
credential check in network egress. That caller lacked user attribution; the queue
correctly rejected it, but the proxy reduced the structured rejection to HTTP 502
and the model eventually reported no progress. This is not evidence of an external
provider failure. Host `140791f9b` now resolves egress accounts through the same
live user-subject source as RPC, instead of retaining the subject-less image registration. Focused
identity tests pass (11 tests) and normal host checks pass. Host `cf22d9d1a` preserves
structured authority rejection through the existing egress error path: access
failures become terminal 403 responses and retain code/details for RPC proxy
callers. All 63 egress tests and normal host checks pass. Combined native
real-credential replay remains required. Deterministic model fixtures do not prove
this real-credential path.

The subsequent user report of failed onboarding reads reproduces in the existing
`onboarding-opening-overview` system test: its validator passed despite five
unexpected tool failures, including read and provenance. This is an inadequate
acceptance assertion as well as a runtime defect. Repair must retain the original
onboarding flow and require successful onboarding skill access; rendering an inline
card after failed tools is insufficient.

Live tracing identifies the rejected node as the command for the current tool,
with the correct channel but no causal parent. Base AgentVessel's mutation replay
probe uses unscoped `this.rpc`, losing the invocation identity before any tool can
execute; post-cancellation recovery likewise discards its scoped RPC client.
Base `5449384` carries the scoped client into both paths; host `b04302fb0` extends existing
caller-owned trajectory recognition to the exact command derived from the verified
current invocation. Either change alone is insufficient. RpcServer verifies that
invocation before service dispatch; foreign command references retain graph checks.
The strengthened original `onboarding-opening-overview` now passes with zero tool
failures (run `st_adeb422b0cbb4c06bc0f176273dbccf2`), including the required successful
onboarding skill read. Host VCS tests pass (29), validator tests pass (26), all
userland types pass, and normal host commit checks pass. No prompt workaround
or manual chat substitution is used.

Base `f037db2` also removes PubSub's competing transport-recovery trigger. Typed
connection loss waits for the host's recovery signal; resource-only subscription
closure still self-recovers. All 57 existing PubSub tests plus the focused host-signal
regression pass, as do all userland typechecks. Base `e4d861e` reasserts current dialog
overlay state on reconnection. Complete desktop native replay remains required.
The next native replay retained the original onboarding panel and compiled card,
but revealed that the shared binary/base64 stream bridge discarded structured RPC
failure codes. Host `13e868c77` preserves those codes and details before and after
response headers (35 focused tests and host checks pass; all userland types pass).
The subsequent replay removed the repeated per-attempt errors, but a resource
closure racing server shutdown still exhausted recovery while the transport was
offline. The coordinator now defers an interrupted generation to the next host
signal; it does not mark the generation complete or retry without a usable pipe.
Ordinary resource-failure retries remain covered. Full native replay is still due.

The System placeholder icons exposed a deeper startup split. Both workspaces
served their exact icon bytes successfully, but System published its late icon
refresh through an unscoped IPC event that workspace clients discarded. Every
workspace now uses the same desktop runtime construction, startup, event
projection, native view ownership, recovery, diagnostics and shutdown. System
adds app/account host services to that runtime's container. Personal adds its
browser providers. Native app navigation also belongs to the common runtime;
only app hosting/account management retains a System owner. The obsolete startup
browser-readiness wrapper is removed.
Direct user notifications retain the existing admitted UI-session route rather
than being copied through a second host forwarding path.

The related singleton audit includes workspace-owned command execution and
failure notifications, OS approval attention keyed by workspace and request,
and mobile effects attached to their owning connected session rather than to
whichever screen has been visited. Addressed OAuth handoffs and ordinary external
links feed the same captured mobile callback. Desktop command handlers now receive the
same captured client as their panel/Quickfire UI. Focused ownership and lifecycle
regressions pass, as do normal host commit checks and all three userland
typechecks. Desktop local startup passes as recorded above. A remote outage run
restored both workspaces' identities and panel trees using the same Electron
process and paired device credential. Its strict diagnostics check still failed
on connection-loss warnings, so it is not a native acceptance pass and did not
reach the shared-member revocation phase. That owned run's 32 captured processes
and temporary state were cleaned up. Recovery repairs and final mobile acceptance
remain in progress.

Desktop and mobile now expose selected-file copying through their template/source
settings. Preview reads the exact protected-main event through `vcs.mainState()`;
it creates no observation context and discloses no bytes to the destination. The
confirmed operation creates a destination review context, rechecks access and its
captured head, and uses existing snapshot import or external-delta comparison and
merge. It transfers at most 200 selected files and 4 MiB, preserves unselected
destination paths, and does not publish main or import source history or grants.
The shared client has eight tests against two independent semantic workspace stores,
including revoked access, corrupt content and stale destination state. Client tests
cover captured destinations, duplicate actions, route retries, interrupted delivery
and a lost branch-creation acknowledgement. Native Electron acceptance passed
(`20260907T025807683Z-1319711-7c6ea456`): Personal's New panel mounted, the UI copied
only `Welcome.mdx` into System's new review repository, matching bytes and digest,
and protected main remained unchanged. Ordinary/Personal queues contained no
native App reviews. Its owned processes were cleaned up. These checks do not
establish application RPC forwarding, which remains closed pending the
receiver-trust decision below.

Mobile browser storage requires native profiles as well as workspace-scoped RPC
and UI stores. The implementation raises the iOS minimum to 17 for persistent
isolated WebView data stores, and requires Android WebView's multi-profile feature.
An unsupported Android WebView must request an update rather than fall back to a
shared browser profile. Native Android compilation has passed; iOS runtime
verification remains outstanding.
Android acceptance passed the ordinary agent lifecycle, workspace-owned camera
denial, and a selected System cookie clear that preserved Personal cookies. That
run needed a manual Android Back action because Settings scrolled its navigation
header out of view; the header now stays visible while its sections scroll. A
subsequent unattended run still failed after intermittent System panel activation
delays, so full unattended mobile acceptance remains outstanding. Its 45-second
deadline covered the whole materialization attempt, including authorization and
session readiness; it does not identify a slow RPC or establish a network cause.

A bounded 90-second warm-state probe then mounted System successfully. Four
instrumented host requests settled in 0–16 ms; the selected direct paths reported
zero packet loss, MTU 1452 and RTT at most 4 ms. This successful probe does not
explain the intermittent failure. Existing connection diagnostics now expose native
path counters without adding a separate polling or logging subsystem. The canonical
mobile readiness reader was also corrected to consume the current shell-ready event
and honor indented Android epoch timestamps. Both diagnostic changes have focused
regression coverage. A separate bounded native Settings check passed after the
header fix: Back remained visible while scrolling, System cookie clearing succeeded,
and Back returned to the workspace. It did not repeat the earlier Personal-cookie
preservation check. All owned probe processes were cleaned up.

A separate raw-binding experiment proved that the pinned native Iroh receive lock prevents
`stop()` from interrupting a pending read. A rebuilt binding from the exact pinned
upstream source now passes native cancellation checks and the existing real-QUIC
RPC client tests, including response-head timeout and upload cancellation without
closing sibling sessions. The final Iroh suite passes 97 tests across 22 files.
[Reproducible native source/build inputs](../packages/iroh-transport/native/README.md)
retain the exact upstream commit, reviewed patch and lock hashes. A fresh build
passes seven upstream endpoint tests and seven cancellation regressions; stock
1.1.0 fails all seven cancellation regressions. Production npm/Maven/Swift pins
remain unchanged, so the passing runs explicitly select the repaired local
artifact. A coherent native dependency release is still required. This defect
is not established as the cause of the intermittent mobile activation delay.

The full host suite passed 6,382 tests across 742 files using that repaired native
binding, with five opt-in suites skipped. The workspace suite passed 4,501 tests;
one 35-test fixture timed out loading modules during concurrent builds, then all
35 passed in a focused rerun without changing the test or timeout. Two workspace
tests remained skipped. Subsequent ownership fixes passed their focused tests,
and repository commit checks, types, generated contracts and formatting passed.
Subsequent review repaired desktop icon/focus ownership and mobile retained-view lease
ordering. Lease acquisitions now carry the coordinator version already used by events
and snapshots; clients do not invent another causal clock. Mobile's final lifecycle
change passed 40 focused tests and all three userland typechecks. A subsequent
unattended Android run used that committed lease source and verified repaired Node
and Android binaries. Personal panel navigation, chat rendering and workspace-owned
camera denial passed. System initialization and lease acquisition took 124 ms and
167 ms, and its HTML arrived in 130 ms; subsequent asset prewarming and subscription
requests timed out. System gateway activity appeared later in a burst, with handler replies in
7–76 ms. Gateway timestamps alone do not establish when Iroh bytes reached the host.
This reproduces the loading failure without the former
lease delay; it does not establish a cause, and unattended mobile acceptance remains
open. Host acquisition/schema/orchestration checks passed,
including exact event-version ordering when a listener releases a just-acquired lease.
The typed gateway extraction passed 46 schema/handler tests plus the two typed-client
guards without adding a method-specific exemption. Four native panel-method authority
overrides were aligned with the existing native view service host contract; 47 focused
tests retained rejection of unrelated hosts and ordinary apps. Concurrent icon streams
also exposed one native IPC listener per stream; the preload now shares one listener,
retaining operation-ID isolation and per-stream cancellation. Its 27 focused tests
include 24 concurrent streams, foreign frames, terminal cleanup and surviving siblings.

Native visual review also found a website permission requester displayed as an opaque
panel runtime ID and “workspace.” Shared presentation now identifies browser permissions
by their verified website origin before considering mediator titles or icons. Desktop
and mobile use the existing globe icon and retain the exact owning panel for navigation.
The change passed 32 shared copy, 44 desktop card and 47 mobile sheet tests, all three
userland typechecks, and independent review. It changes presentation, not authority.

The final native Electron smoke passed fresh remote pairing over Iroh with the
explicit repaired local binding. It exercised the host launch approval and two
workspace source reviews, waited for System's focused presentation, verified
native panel readiness and workspace-owned image decoding, then created a panel
through the visible focused New action and checked native title projection and
Settings. Strict diagnostics passed with no stream-listener warnings. All three
workspace children exited cleanly, the hub shut down, and owned processes and
temporary state were removed. The test now waits for actual workspace focus and
all cleanup callers await the same teardown; retained hidden controls cannot
satisfy its action lookup.

These results do not establish stock-binding, iOS runtime, public application
RPC, or website-to-agent/tool acceptance. Native desktop reconnect and
shared-member revocation during an open native approval still require separate
acceptance evidence; fresh pairing does not establish them.

Implementation is recorded in targeted local commits; nothing has been published:

| Checkout           | Commits                                            | Scope                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host               | `f5286e222`, `2c80d8dc0`                           | Native build containment, ownership/identity, standalone bootstrap and authority.                                                                                                                                                                                                            |
| Host               | `b445eda44`, `18c72ed69`                           | Desktop and mobile native clients.                                                                                                                                                                                                                                                           |
| Host               | `15b8decc5`                                        | Request lifecycle and reproducible native cancellation repair inputs; production binding unchanged.                                                                                                                                                                                          |
| Host               | `40e4c054b`, `7113aefc8`, `8a4641d52`              | Exact private-workspace smoke label, native QUIC path diagnostics and current mobile readiness detection.                                                                                                                                                                                    |
| Host               | `6555a57`, `b8bcfc93f`, `367149dca`                | Shared streamed gateway contract, authoritative lease outcome versions and verified native view authority.                                                                                                                                                                                   |
| Host               | `57657347d`, `ffd8e0c70`                           | One native IPC stream listener with independent response lifetimes; native pairing smoke with settled workspace focus and complete cleanup.                                                                                                                                                  |
| Host               | `3dfa1f2f2`, `4c6bd9484`                           | Shared approval selection, exact pending source reviews, account-only development startup, durable initial panels, viewer-bound panel grants and reconnect fixes.                                                                                                                            |
| Host               | `179bdcf73`                                        | Canonical panel IDs for distribution seeds, verified through real runtime lease acquisition.                                                                                                                                                                                                 |
| Host               | `4fee76409`, `257594f01`                           | Common desktop workspace runtime, scoped events and native ownership, with document-owned website notifications.                                                                                                                                                                             |
| Host               | `01cd923ac`, `f3d00c40d`                           | Preserve typed connection loss across carriers; capture exact runtime owners for native navigation, readiness, attention and the shared desktop test API.                                                                                                                                    |
| Host               | `8b1f26ed7`                                        | Restore automatic Personal onboarding requirements in existing template, desktop startup and mobile smoke tests; derive exact per-workspace fixtures and retain separate New Panel coverage. Desktop automatic startup is verified; Android and remaining recovery journeys are outstanding. |
| Host               | `ed5af7f93`                                        | Canonical Iroh close error identity and strict visible-Personal onboarding screenshot assertion; native replay outstanding.                                                                                                                                                                  |
| Host               | `6004aac5d`, `f03136c0c`, `f9d7611ea`, `070dabc7d` | Retain existing workspace-owned E2E journeys, align native test actions with admitted chrome, and preserve interactive identity in panel authority.                                                                                                                                          |
| Base               | `1461b9a`, `391cc98`                               | Standalone source inventories, retained source integration and System-test ownership.                                                                                                                                                                                                        |
| Base               | `0d801e2`, `731f20f`, `08ecf0e`                    | Desktop and mobile workspace UI, including persistent mobile Settings navigation.                                                                                                                                                                                                            |
| Base               | `c572456`, `5dbcd61`                               | Workspace-owned desktop imagery/focus and mobile retained-view lease lifetime.                                                                                                                                                                                                               |
| Base               | `c88bc3b`                                          | Shared approval presentation and visible notifications across workspaces, compact desktop navigation, full panel viewport, and server-owned initial panel consumption.                                                                                                                       |
| Base               | `faf70e2`                                          | Workspace-owned command execution and connected-session effects on desktop and mobile.                                                                                                                                                                                                       |
| Base               | `cfe498d`, `23cd6cd`, `6c6c7b0`                    | Restored Personal onboarding and its local setup dependencies; real opening-tool execution in deterministic E2E; shared client recovery ownership and scoped native navigation.                                                                                                              |
| Base               | `4a8d3d6`, `1a88c51`                               | Share hydrated model history and advertised schemas with deterministic inference; existing automatic-onboarding E2E passes with the rendered setup overview.                                                                                                                                 |
| Base               | `3da9db9`, `4d02f94`, `b571799`                    | Keep toast actions clear of navigation; preserve import error identity and deliver the existing panel recovery signal on mobile. Native replay outstanding.                                                                                                                                  |
| Base               | `de377ae`, `cdaf3f1`, `e73496f`                    | Mobile app-info contract and inline-source recovery on channel reconnection; native replay outstanding.                                                                                                                                                                                      |
| Base               | `7746210`, `946c56d`                               | Explain separate workspace creation in onboarding and include local Help in Base and Personal.                                                                                                                                                                                               |
| Host / Base        | `0322ca4ed` / `6bfd508`                            | Website approval requester identity from verified origin and native globe presentation.                                                                                                                                                                                                      |
| Examples / Google  | `662dc22` / `30e8d16`                              | Complete standalone source snapshots.                                                                                                                                                                                                                                                        |
| News / Spectrolite | `74200f3` / `2b48cc2`                              | Complete standalone source snapshots; unrelated local edits preserved.                                                                                                                                                                                                                       |

### RPC owner routing verification follow-up (2026-09-07)

The committed routing migration uses a typed destination instead of a workspace ID
for every transport owner. A hub destination cannot be confused with a workspace
named `hub`. The RPC contract version advances to 4 so mixed-version endpoints
reject admission instead of silently ignoring an address. The retained desktop
copy E2E now sends the typed destination and checks the responding workspace.
This is address and presentation plumbing, not a change to grant semantics.

Host/workerd and all three userland type projections pass. Focused routing and
transport/server checks passed 258 tests; subsequent IPC rejection coverage passes
39 tests, including a real client settling both unary and streaming hub rejections.
The shell acquisition repair has focused scoped-client and real extension-child
coverage; actual browser-import approval presentation and resumed import remain
native acceptance work.

Host commits `7e310414a` and `60cd127e7` connect the hub queue to its live
account audience and extend the existing native UI session owner to typed hub
and workspace destinations. Revocation or replacement settles pending unary and
streaming calls with `CONNECTION_LOST`, including replacement first discovered
by an arriving response. Duplex ownership lasts until both directions finish;
failure cancels an unfinished upload without closing sibling workspace sessions.
Independent review and 57 focused native IPC/session/extension tests passed,
along with the normal repository commit checks. Commit `c5b5a4621` retains
extension-child acquisition wait/retry coverage in Node and native-workspace
modes. These checks do not establish visible browser-import acceptance.

Base commit `9d8323c` distinguishes the RPC owner from workspace display context
in desktop and mobile approval selection and decisions. It retains the shared
queue, represents account-owned requests directly, and displays queue failures
with owner-specific retry. Focused desktop coverage passes 60 tests, mobile
coverage passes 43 tests, and all three userland type projections pass. Actual
mobile native presentation remains unverified.

Host `7419fd2f4` binds approval presentation keys to typed RPC owners and ignores
obsolete refresh failures. Host `0fdc0c7f3` binds native session lifetime to the
authenticated catalog and makes accepted panel snapshots own native focus. The
final lifecycle suite passes 288 tests; earlier combined approval/lifecycle
coverage passed 311 before the catalog-admission race tests were added.

An intermediate native acceptance run failed with
`[hubControl.listWorkspaces] Unknown service`, before exercising browser import.
Investigation confirmed that the smoke harness defaulted an omitted destination
to the current workspace even for hub calls. The harness now requires explicit
typed destinations and checks reply ownership (three behavioral tests pass).
This failure did not establish a production hub registration defect.

The next native run reached Browser Migration but failed to present an approval:
the queue rejected its requester's scope membership. Live checks confirmed both
the canonical workspace ID and the panel owner's membership; hypotheses based on
the directory name or TestApi panel ownership were disproven. Source inspection
then found a lost verified parent subject on extension-to-service calls, while
the corresponding extension-to-DO route already carried that subject. The repair
preserves the extension's executing/code principal and attaches only the verified
parent's human subject (Host `318804356`). Host `7b3040b16` returns presentation
failures through the existing owner wait as RPC errors rather than ordinary
closed requests that lose the cause. The fixes pass 134 RPC server tests and 47
acquisition/service tests respectively, plus normal commit checks. The next native
attempt opened Personal's launcher but stopped on an undefined polling helper in
the harness; it did not exercise the repaired approval. The helper and an obsolete
category-selection assumption are corrected. The user subsequently verified browser
import successfully in the running UI. This is manual acceptance of the reported
workflow; the automated native regression run remains outstanding. Terminated
harness runs cleaned up their owned instances.

The user confirmed browser import works in the running UI. A subsequent automated
native attempt ended before import on Iroh connection loss; it supplies no import
verdict. Its owned process and temporary profile were removed. A fresh managed doctor
also caught a separate strict RPC schema omission in the new host-platform approval
copy: the queue emitted `executionPlatform`, but `shellApproval.listPending` rejected
it. The platform-specific copy commit (`8a9dc5663`) therefore requires a contract
follow-up before further acceptance; focused copy/type tests did not cover that wire
boundary. The failed doctor instance was stopped, and neither catalog nor atomic
acceptance ran on it.

Artifact reconciliation found 50 distinct named tests in the original agentic slate.
Fresh cached-catalog acceptance now passes as `st_bb755a831b7b48229216e5ad63cda7f8`
(1/1, zero unexpected tool failures) after a successful managed doctor on the fixed
approval schema. Together with the other 49 latest valid passing results, every
original slate test has passing evidence. This is a per-test historical ledger,
not a claim that all 50 were rerun on today's source. The separate atomic
panel/store regression remains in progress.

Fresh `remove` acceptance passes as `st_43c12ae66bd340408e7ce1e07ca9c52e`.
The remaining cached-catalog test exposed explicit `null` loss in eval serialization.
Base `a5718bf` preserves null and only uses the default export for undefined;
48 sandbox tests and all userland type projections pass. The original catalog
validator then rejected an authentic wrapped null result. Base `0e9afcb` replaces
return-field guessing with independent catalog observation through the existing public
RPC and verifies the agent report against it (14 focused tests pass). The fresh
agentic acceptance above confirms the corrected flow. Atomic panel/store acceptance is also still unproven;
unit results do not substitute for that workflow.

The later atomic run `st_5a6616d442a14ac29db77027ce60e29c` was cancelled after
repeated failed publications. Its generated panel requested a service protocol absent
from the exact meta binding; this was not evidence of the collection dependency defect.
The run also exposed a harness problem: its scaffold helper publishes before subsequent
agent customization, so that setup cannot prove one atomic panel/store/meta publication.
A deterministic fixture using the existing snapshot-import and ordinary push paths is
being prepared; agent-authored task-management coverage remains separate and retained.
The cancelled instance and all its child processes and temporary data were removed.

The user's collection/browser-data publication diagnostics exposed a different mismatch:
the workspace authority index already carries library service declarations, but the exact
unit fold checked dependency-origin calls against the executable consumer's declarations.
Host commit `4fbfc5402` selects declarations by source package and keeps dependency capability effects
charged to the executable consumer. The two collection-orchestration consumers additionally
receive exact dependency-scoped channel request rows in Base commit `9d8eba9`.
An independent review found no widened grant or source-attribution regression.
Generic fold tests pass 23 cases.
Fresh real Personal validation on `collection-validation-20260907` confirmed both exact
units in the inventory, then obtained `status: ok` and empty diagnostics for
`about/collection` and `extensions/browser-data`. The managed instance was stopped and
its processes removed. Empty/skipped default Base reports were excluded from this evidence.
CLI commit `05f9ef6d5` exposes the existing idempotent private-workspace preparation
operation as `remote ensure-user-workspaces`, followed by explicit workspace selection;
this uses the same authenticated hub control path as the clients.

Host commit `614e3d874` preserves TypeScript's configured program roots and adds
sealed first-party executable modules as required roots. This addresses the
unrelated mobile test helpers previously pulled into protected publication
checking, without allowing configuration to hide executable code. Its focused
coverage passes 28 tests; fresh atomic publication acceptance is still required.

The integrated browser-import diagnostic with the local repaired Iroh addon reached
and clicked the store approval, but its harness read the same approval ID before the
asynchronous decision settled. This did not prove a repeated product acquisition.
The harness now awaits removal of that exact ID before checking for a new request
with the same operation identity; six focused harness tests pass. Approval screenshots
now capture the exact visible card rather than an unrelated app page. The failed run's
owned processes, temporary root, and ready record were removed. A complete replay
remains required; the local addon cannot establish production Iroh acceptance.

A subsequent live-user rebuild stall was inspected without restarting or mutating the
user's workspace. The runtime build completed in 49 ms; the deferred eval remained
parked while the replacement panel connected, was superseded, and stayed pending with
an unreachable route. The periodic effect-outbox wake checks the deferred eval rather
than rerunning it. Host commit `b8c3fe3e5` targets exact lease-connection identity in
native presentation reuse and separates execution readiness from presentation
demand. Independent review and 103 focused orchestrator/event-bridge tests pass, as do
host and workerd type checks. The real atomic fixture now additionally rebuilds the
saved panel, takes its snapshot, and checks persisted DOM state; that acceptance is running. A proposed server-side reorder was rejected because it could publish a lease
before failed activation or return a stale lease after revocation. No timeout is being
added to conceal the ownership failure. Focused regressions pass; real rebuild
acceptance remains required before claiming end-to-end repair.

Committed-object history places execution-before-assignment in `7072e86eb` and
`94458a911`, and connection-insensitive presentation reuse in `e7746e462`. The old
activation path also unconditionally requested presentation. These findings establish
older interacting assumptions; they do not prove that the recent workspace split
introduced every part of the failure. A reviewer initially claimed a committed demand
guard existed; checking HEAD and history disproved that claim. The committed guard
is new work, not a restoration of a previously committed guard.

The sibling mobile audit found that the native WebView key omitted connection identity.
Replacing a same-URL connection could also retain the retired document's error and
bridge state. Base commit `60300aa` remounts the inner native document while preserving
outer lease ownership. An opaque document owner fences delayed native callbacks and
bridge replies, including A→B→A navigation and unmount; URL navigation retains queued
envelopes, while connection replacement retires the old queue. Five focused mobile
lifecycle tests, the complete userland type projection, seed checks, and independent
review pass. Actual native device acceptance remains separate.

The broader host audit found another ownerless wait: load-on-assignment refreshed
panel metadata before entering the presentation attempt's failure/report/release path.
A refresh rejection was only logged by the event bridge, leaving the assigned runtime
attempt pending with no renderer. Both event and snapshot assignment paths contain
this gap (`e7746e462` in committed history). Host commit `1c5203f8e` moves preparation under the same
presentation owner; failure settles the exact attempt without affecting a replacement.
Its 87 orchestrator regressions, 75 coordinator/service/event-bridge tests, host/workerd
type checks and normal commit checks pass. This is an event-driven lifecycle repair,
not a timeout.

Atomic fixture run `st_130a3e77845542cca787809aa6b6d3a1` stopped at the build gate
before publication/open because its appended authority declaration omitted required
`evidence`. The fixture now calls the canonical authority parser before importing,
and its 11 focused tests pass. This failure is a fixture defect, not a verdict on runtime grant or rebuild behavior.
The subsequent run `st_dfc353adfc3e4cd598fe36aea8b4f758` built both atomic units but
failed the broader full-Base `dev` candidate gate after the mobile build. Personal was
then selected and verified in a fresh managed instance, but its distribution correctly
omits `workers/system-test-runner`; that runner cannot execute there unchanged. The
existing native desktop rebuild test already provisions Personal and is the faithful
client acceptance path. No test runner was installed into Personal to bypass this gap.

Shared-runtime run `st_0ba0e29c89474b60bc8192bb5d86dd6a` reproduced the broader gate
failure. Before cleanup, `build.getBuildReport` recovered 53 exact mobile diagnostics:
52 concern the runtime compiler's library/type environment, and one reports an absent
direct `browser-import` capability declaration. Both atomic units built successfully.
These mobile defects remain under repair; the owned managed instances are stopped.
Investigation locates the compiler mismatch in the source mobile tsconfig (ES2020
versus the ES2022/types environment used by the normal mobile projection), exposed
by exact configured-program enforcement in Host `614e3d874`. Base `ba1e9e4` aligns
that source environment and declares the existing browser-import capability. Host
`f449b0c1f` adds the configured-library regression and makes launcher logs report the
actual selected workspace. Focused tests, type checks and independent review pass;
live acceptance subsequently exposed missing review vocabulary for browser-import.

The missing postmortem diagnostic was a separate test-harness defect: atomic orchestration
caught `RemoteRpcError` and returned only its message, bypassing the runner's typed error
serializer. It now retains the existing bounded/redacting `systemTestFailure` result,
including candidate, affected units and diagnostic handles. Focused coverage proves
credential-like fields remain redacted. Base `30071bc` applies the same existing
contract to eval, template, and self-development orchestration catches and cleanup
failures. Its 84 focused scenario tests and all userland type configurations pass.

The production Iroh check passed 39 of 40 tests but timed out in the streaming
upload/cancellation case and reported an unhandled connection-close rejection.
The same four-test client suite passes with the reproducibly rebuilt local native
binding. That experiment does not establish production Iroh acceptance: the
production dependency still needs the native repair. Hub approval presentation,
remaining agentic cases, and the other outstanding acceptance requirements above
are not complete.

## 1. The five rules

### 1. A workspace is a complete working environment

A workspace contains the workspace source needed to run its panels, workers, and
agents, plus its own data and contexts. Its execution does not depend on another
workspace being available. It still uses the installed host contracts and
explicitly authorized external resources; self-contained does not mean that every
application must work offline or embed the host/toolchain.

The desktop/mobile client displays several workspace sections, each with its own
panel tree. Contexts remain branches or task environments inside a workspace.
Workspace is the single ownership/isolation concept; there is no extra partition
layer. Every user has a private Personal workspace for normal work and a private
System workspace for that user's client/system functionality, including on shared
servers. Other workspaces may have multiple members. Personal is the user's home
in the UI; System has a protected, user-scoped operational role. Neither role
implies server administration or inherited source, state, or grants.

### 2. A bundle is a publishable workspace snapshot

A bundle contains selected distributable source and initial assets, including the
Base source the application needs. Opening it creates a fresh workspace with
fresh runtime state and no inherited grants. Each created workspace has its own identity.
A bundle adds no separate installed-app record, execution lifecycle or uninstall state.

Use the existing exact source acquisition, content storage, build, and workspace
creation mechanisms. Declared external package dependencies use the existing
reproducible build mechanism; they are not dependencies on running workspaces.
Retain existing template identity, acquisition and descriptive metadata where they fit.
Do not create another composition engine or duplicate template metadata model.

### 3. Base is an ordinary source upstream

Base is a minimal source distribution: a notional workspace snapshot containing
common agentic implementation. Minimal means independent of personal/system functionality,
not the smallest possible package or dependency set. It need not run as a workspace in the instance.
Other workspaces derive from its source and can explicitly merge selected changes
from it. Each consuming workspace owns its adopted source version and runs independently.
Identical immutable bytes and build artifacts can be physically deduplicated without
sharing private state or authority.

Adopting selected Base source, personalizing it and contributing changes back use
ordinary source comparison and integration. There is no live Base-provider binding,
read-only source mount into another workspace, service-provider selector, or automatic
propagation when an upstream changes. Ordinary source baselines explain ancestry;
they are not a second installed-layer ledger.

### 4. Agents execute where their work belongs

Quickfire belongs to the workspace of its target panel. An app's agents use that
workspace's source, instructions, state, and granted capabilities. Personalizing
an agent means integrating its implementation into the target workspace, where it
executes locally under the target's authority.

An agent does not execute in a remote Base workspace. There is no Base-interface
choice between local code and a remote service. Existing finer context and authority
restrictions remain in force within a workspace.

An `about/*` page loads source only from its panel's own workspace, and Quickfire
stays there. System pages open in System; workspace-local pages such as `about/new`
open locally. A System management page may select another workspace as its resource,
without moving code or granting authority through the `about/` name.

### 5. Cross-workspace effects are explicit

Support copying selected artifacts, merging selected source changes, and controlled
communication between explicitly selected workspaces. Communication sends a bounded
message/request and returns attributed results; it does not merge memory, add workspace
members, or lend the recipient the sender's private grants. Extend existing RPC with
explicit workspace addressing, gated discovery and hard ingress/egress policy before
ordinary capability approval. Unrestricted discovery, live Base linking, and implicit
agent delegation remain out of scope. Existing host/native capabilities continue
through the canonical scoped authority system.

Agentic websites remain external-code panels in the workspace where they are visited.
They start without inherited workspace grants. Their requests use ordinary authority
evaluation with verified website and workspace attribution.

## 2. Why this replaces the previous design

The initial proposal combined independent workspaces, live Base selection, source
adoption, remote services, per-user personalization, and multiple execution locations.
Those relationships made simple actions difficult to define and introduced lifecycle,
compatibility, and authority choices before a concrete application needed them.

The accepted simplification removes live linking and makes source integration the
one mechanism for adopting another implementation. The deliberate tradeoff is that
personalization does not propagate automatically. Users review and integrate changes,
and resolve incompatibilities in ordinary source when necessary.

For example, “apply my preferred agent implementation to Trip Planner” uses existing
selected-source copy or merge operations. After review and publication, Trip Planner
runs the result itself. In a shared workspace this is an ordinary shared source change under
existing editing/publication authority, not a new per-user Base preference system.

Retain and simplify the existing template system for upstream source identity, metadata,
exact acquisition and source-baseline handling. A template is an upstream workspace source;
a bundle is a publishable snapshot of source and initial assets. Personal, System, Base
and third-party applications can use the same existing template mechanisms.

Opening an unrelated application creates a workspace. Incorporating source into an existing
workspace uses explicit source operations. Remove composition-driven installation, automatic
recomposition, installed-layer precedence and bookkeeping needed solely for those behaviors.
Keep useful existing names, manifests, APIs, CLI commands, UI and tests when their semantics
fit the retained responsibilities. Do not delete or rename them merely because they say
"template", or retain obsolete composition behind compatibility flags or wrappers. This
supersedes the earlier blanket requirement to eliminate the template system.

### Retained upstream contract

A workspace can record which upstream template and exact source revision it adopted, with
its snapshot identity and the source baseline needed by existing comparison/merge operations.
Use existing coordinate, pin and semantic VCS representations rather than another ledger.
Descriptive ancestry does not install runtime layers, select a live Base provider, or confer
access to an upstream's private history, credentials or grants. A moving repository ref is
not an exact adopted revision. Each workspace owns its materialized source and runs without
the upstream being available.

| Retain and simplify                                                           | Remove or disentangle                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Normalized upstream URLs, exact commit/snapshot pins, safe names/descriptions | Treating a template name, ancestry or manifest as execution authority                  |
| Exact source acquisition and workspace creation from snapshots                | Installing unrelated applications as composed layers in an existing workspace          |
| Source provenance and baselines used by ordinary explicit compare/merge       | Composition graphs, precedence, contribution ownership and automatic recomposition     |
| Manifests, APIs, CLI/UI and tests serving those retained responsibilities     | Entry points and generated metadata whose only purpose is removed composition behavior |

The current root-template path prepares Composer metadata even for creation. Separate its
source acquisition/initialization from that composition contract; do not keep an entire
composition subsystem just to read a root pin. Audit relationship-state fields by purpose:
keep actual source ancestry/baselines and discard composition-only parents, overrides or
fragments. Provider/trust suggestions must not be applied as inherited configuration or
grants. Reuse existing explicit configuration and authorization if those features remain.
No release recovery or update workflow is added by retaining upstream metadata.

### Build on the existing workspace sandbox

The ownership, ingress/egress, grant and no-sharing rules below are application protocol
requirements. They protect access through authenticated receivers; they do not establish
universal native secrecy between workspaces. The current canonical architecture trusts the
installed application/hub/receivers, uses MXC resource admission on Unix, and runs Windows
native workspace code directly with the host OS user's permissions. Native networking is
not universally mediated on any platform. Shared commands also share the resources exposed
to their workspace; per-user RPC attribution does not make a credential supplied to a
shared command private from its sibling commands.

In particular, Windows native code can access host-user-readable sibling state, credentials
and authority files despite RPC denial or Personal/System non-shareability. MXC's Unix
contract also has the preview and device limitations stated in the canonical plan. Browser
and workerd origin/runtime protections retain their own contracts. Admission, UI wording
and acceptance evidence must identify the actual execution surface and platform.

Use the existing workspace sandbox as the native execution foundation. Verify the concrete
files, credentials, policy state and service interfaces this design needs; do not introduce
a second sandbox or abandon the existing boundary because it does not promise universal
containment. Keep all reachable RPC receivers authenticated even with normal native networking.

Verification on this Linux checkout: the two existing real tests in
[workspace.integration.test.ts](../packages/process-adapter/src/isolation/workspace.integration.test.ts)
passed with `pnpm vitest run --config packages/process-adapter/vitest.native.config.ts packages/process-adapter/src/isolation/workspace.integration.test.ts`.
They exercise the production native child/launcher with PTY input/resize, host and sibling
file denial, read-only input protection, symlink/hardlink attempts, shared commands, normal
network connectivity and independent cancellation. The fixtures stopped their owned runtimes
and cleaned their temporary resources. This supports reuse of the Linux sandbox for workspace
filesystem separation; it is not macOS/Windows evidence or proof of every RPC/credential path.

For implementation, extend the smallest relevant existing fixture where actual ownership
changes expose a new resource, and run platform acceptance on each supported target. Windows
native execution currently lacks the corresponding OS boundary; admitting hostile native
bundles there remains a product decision under the accepted platform contract. Browser/workerd
surfaces retain their own boundaries. No approval prompt substitutes for absent containment.

## 3. Existing implementation to reuse and inspect

These are inspected starting points, not a completed boundary audit. Recheck current
source before implementing; other work is in progress and older plans contain
superseded contracts.

| Area                                 | Starting point and implication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspaces                           | [hubServer.ts](../src/server/hubServer.ts) already tracks workspace identity, membership, and child runtimes. Reuse this container and route several workspaces to the same client.                                                                                                                                                                                                                                                                                                                                                                                |
| Client selection                     | [appHost.ts](../src/server/appHost.ts) resolves workspace `hostTargets`. Restrict client-app activation to the admitted System source instead of accepting client ownership from whichever workspace is selected.                                                                                                                                                                                                                                                                                                                                                  |
| System-page namespace                | [aboutNamespace.ts](../packages/workspace-contracts/src/aboutNamespace.ts) currently describes path-derived privilege for `about/*`; [runtimeResourceBindings.ts](../src/server/services/runtimeResourceBindings.ts) consumes it. Replace path-based privilege with ordinary navigation to a local page, verified caller identity and explicit operation authority; no page-role registry is required.                                                                                                                                                             |
| Contexts                             | [runtime.ts](../packages/service-schemas/src/runtime.ts) defines context creation and cloning. Base's semantic store has a workspace-local main; contexts branch within it. An unrelated bundle needs fresh workspace creation, not a personal-context fork.                                                                                                                                                                                                                                                                                                       |
| Template identity and acquisition    | [templateCoordinates.ts](../packages/workspace/src/templateCoordinates.ts) supplies normalized identities; [acquireRootTemplateSnapshot.ts](../src/server/acquireRootTemplateSnapshot.ts) acquires exact immutable snapshots. Retain these mechanisms and useful names/contracts for upstream templates.                                                                                                                                                                                                                                                           |
| Root creation and relationship state | [rootTemplate.ts](../packages/workspace/src/rootTemplate.ts) prepares a standalone source snapshot. Composer relationship state and `templateState.ts` have been removed; exact upstream identity and ordinary semantic source baselines remain.                                                                                                                                                                                                                                                                                                                   |
| External Base                        | [External Base cutover](external-base-cutover-and-self-development-plan.md) records host/Base separation and source acquisition. Preserve the useful source boundary, not the template composition system.                                                                                                                                                                                                                                                                                                                                                         |
| Semantic integration                 | Base's `workers/workspace-source` owns semantic operations; [workspaceVcs.ts](../src/server/vcsHost/workspaceVcs.ts) supplies host projections/publication. Inventory and reuse actual copy/compare/merge behavior. Do not make new selective-history merge machinery a prerequisite for source adoption.                                                                                                                                                                                                                                                          |
| Panel ownership                      | [treeIndex.ts](../packages/shared/src/panel/treeIndex.ts) and [workspaceStateService.ts](../src/server/services/workspaceStateService.ts) retain user-owned root groups. Stacked sections preserve these and hub membership filtering.                                                                                                                                                                                                                                                                                                                             |
| Browser storage                      | [contextIdToPartition.ts](../packages/shared/src/contextIdToPartition.ts) maps contexts to Electron session partitions. Electron terminology is an implementation detail; preserve required browser/context isolation.                                                                                                                                                                                                                                                                                                                                             |
| Authority                            | [authority.ts](../packages/rpc/src/authority.ts) and [contextBoundary.ts](../src/server/services/contextBoundary.ts) carry current identity and boundary rules. Workspace location, tree placement, or source equality must not become implicit website authority.                                                                                                                                                                                                                                                                                                 |
| Context-aware RPC reuse              | [runtime.ts](../packages/service-schemas/src/runtime.ts) binds entity context/source identity; [runtimeService.ts](../src/server/services/runtimeService.ts) preserves those bindings; [rpcServer.ts](../src/server/rpcServer.ts) dispatches existing targets and explicitly permits supported cross-context DO calls. Preserve existing branch/context selectors. Typed workspace qualification currently addresses authenticated native UI sessions; public cross-workspace application forwarding remains closed until the accepted reviewed-receiver contract below is implemented and verified. |
| RPC and provider capabilities        | [rpcServer.ts](../src/server/rpcServer.ts) and [workspace-owned capabilities](permission-system.md#workspace-owned-capabilities) are starting points for dispatch and protected provider methods. Extend their identity, routing and authority path; do not add a second integration bus or permission engine. Existing local handles are not portable across workspaces.                                                                                                                                                                                          |
| Retention                            | [Execution retention](runtime-foundations/execution-retention.md) records owned artifact lifetimes. Shared immutable objects remain readable only through authorized owned references.                                                                                                                                                                                                                                                                                                                                                                             |

The configured development Base at inspection was
`/home/werg/vibestudio-release-work/base`. Resolve the current selection through the
repository's development configuration; this path is not a portable dependency.
Inspect its `meta/template.yml`, `meta/vibestudio.yml`, `workers/workspace-source`,
agent harness/resource loader, shell/mobile clients, and template-composer packages.

Preserve existing membership, provenance, authority, and residency responsibilities.
Product orchestration remains replaceable userland code where appropriate; enforcement
belongs below the untrusted code. The canonical isolation plan owns that implementation.

## 4. Personal, System, Base, and about-page contracts

### Personal and System distributions plus Base upstream source

A distribution is a ready-to-create workspace snapshot. Personal and System are the
two default running workspaces; Base is an exact source upstream for ordinary
workspaces. Each snapshot is self-contained, with ordinary source ancestry; there is no
composition DAG, installed contribution state, or live Base dependency. Retained template
identity/acquisition describes their upstream source without composing runtime layers. A collaboration-oriented distribution may be added later as
another ordinary snapshot, not another execution or permission model.

| Distribution | Purpose                                                                                                                                                                                          | Presence in the default environment                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal     | The user's normal home/root workspace: personal agent, collections, browsing/personal workflows, and ordinary projects. Includes the minimal common source it needs.                             | One per user on the selected server/hub, ensured by the client. Exclusively owned by that user; workspace sharing and additional members are prohibited.               |
| System       | Client applications and system-relevant functionality: desktop/mobile/system CLI, device/environment management, and most host-known management pages. Includes its own required runtime source. | One per user on the selected server/hub, ensured by installed bootstrap/client startup. Exclusively owned by that user; sharing and additional members are prohibited. |
| Base         | The stripped-down common agentic source and required workspace-local page implementations, suitable for deriving an ordinary app workspace.                                                      | Available as an exact source snapshot/upstream. No running Base workspace is required; authoring it may create an ordinary workspace deliberately.                     |

Personal and System are private by contract, not merely created with private defaults.
The receiver must reject invitations, membership additions, transfers to a shared role,
and other routes that make either workspace multi-user. Hiding a Share button is not
sufficient. Users share selected information by integration/communication with an ordinary
shared workspace, not by opening membership to their Personal or System workspace.

Role designation binds workspace identity to the authenticated user: each server/hub has
at most one designated Personal and one designated System workspace per user. Names,
email addresses supplied by the caller, and display labels cannot select another user's
pair. Source/build bytes may be deduplicated, but mutable state, credentials, grants,
client selection and role lifecycle remain independently owned.

Other workspaces use explicit membership and roles. Reuse useful existing mechanisms,
but treat the host's lightly exercised multi-user behavior as code to validate and simplify,
not a compatibility constraint. Do not preserve an old administrator/membership shortcut
that would expose another user's private pair. An optional collaboration distribution
can provide shared projects, conversations and member-oriented UI on the same substrate.

For example, one server can host Alice's Personal/System, Bob's Personal/System, and
Project with Alice and Bob as members. Alice's client uses Alice's System implementation
and shows Alice's Personal plus Project; Bob's client uses Bob's System and shows Bob's
Personal plus Project. Entering Project does not expose either private pair to the other
member or to Project's code. Personal home, private System ownership, shared membership,
and Base source ancestry are separate facts; none requires a recursive hierarchy.

Ensure each user's pair idempotently through existing creation/registry mechanisms.
Reconnect and concurrent startup reuse existing state; missing readiness does not justify
replacing data. The client selects the authenticated user's System workspace by its ordinary
workspace ID. Use the existing workspace lifecycle for both roles. There is no new release
recovery, last-known-good selection, repair workflow or update work in this plan.

### System uses ordinary workspace machinery

System uses the same storage, contexts, execution runtime, RPC, source operations and
lifecycle as other workspaces. Its differences are its per-user designation, non-sharing
policy, client source selection and blanket rejection of cross-workspace application RPC.
These are configuration and authorization rules on an ordinary workspace, not a separate
execution principal or privileged runtime subsystem.

Protect the user-to-System-workspace-ID association through existing authenticated host
management. A bundle name, manifest, fork or source merge cannot replace that association.
For a host operation that actually needs a System restriction, compare the authenticated
caller workspace ID with that user's designated System ID, then apply ordinary code,
resource, user and grant checks. Inventory these concrete operations, starting with client
activation; do not invent a broad system-only category or a new identity type.

System source carries no approval or host-policy-writing authority merely by location.
The trusted host owns capability enforcement and authentic approval. A System page is a
management interface using that authority path. Server administration and shared resources
retain their actual operator/resource checks; one's private System is not server admin.
Native execution retains section 2's platform contract. Websites in System inherit no grants.

### About pages always load locally

About denotes a host-known or system-oriented page. Every about panel loads its
implementation from the workspace that owns that panel. The `about/<page>` source
classification does not grant host capabilities; it is used for stronger panel-control
protection and severe Quickfire approval handling, so that protection must not be removed
casually. Existing client commands
open ordinary local routes: New here, Settings in System, browser history in Personal.
The page names and destinations below describe navigation behavior, not a new page-role
registry, ownership manifest or routing framework. Reuse existing navigation; add shared
routing code only if a concrete need in that code warrants it. There is no cross-workspace
source resolver, System fallback, borrowed implementation, or cross-workspace source cache.
Unknown/custom about pages are ordinary local pages with no implicit host integration.

The client can open/focus a page in its owning workspace. Opening System settings from
Project therefore opens a panel in the acting user's System section. Project can be captured
as the explicit resource to manage; the panel and its Quickfire remain in System. Resource
selection does not authorize an action, lend Project's grants, or turn the navigation into
an application RPC into System. Decisions stay at protected host receivers with initiating
user/workspace/website attribution. Later focus changes cannot retarget a pending decision.

| Page or command                                              | Panel and source workspace                                 | Resource behavior                                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| New (`about/new`)                                            | Current workspace; minimal implementation supplied by Base | Lists and launches content locally. Personal may have a richer local implementation.                                                           |
| Help, shortcuts, product about, device/system management     | Acting user's System                                       | Open/focus a System panel. Device/account/host effects require their normal authorization.                                                     |
| Permissions and credential management                        | Acting user's System                                       | Explicitly select the workspace/account being managed, initially the initiating workspace where appropriate. Approval remains host-controlled. |
| Workspace files/history and local diagnostics                | Current workspace                                          | Inspect local resources under ordinary access checks. Distinct system-management roles open in System.                                         |
| Browser history, bookmarks, downloads and personal import UI | Acting user's Personal                                     | Open/focus Personal panels; device-level operations retain protected host checks.                                                              |
| Collections and app-specific about pages                     | Owning workspace                                           | Ordinary local content and authority.                                                                                                          |

Adjust existing commands to open the appropriate workspace and local route during extraction.
A required local page missing from a bundle is a contract error, not a reason to fetch it
from System or introduce another route-resolution mechanism.
A custom local about file cannot claim the host's management command or authority. A shared
Project panel must never contain Alice's System/Personal implementation or private workspace
reference as shared configuration; a global command resolves the acting user's own workspace.

New-panel creation captures the initiating/focused panel's workspace and opens its local
`about/new`. Panel-local New uses its own panel scope despite focus elsewhere. With no focused
panel, use the visibly selected workspace; if neither exists, ask for a target. An explicit
Open system settings command is navigation to System, not a change to ordinary New behavior.

Discovery, ranking, open-panel matching, chat creation and caches use the owning workspace,
acting user and existing panel/context scope. Personal suggestions require explicit resource
disclosure. Remove path-derived `about/*` privilege and keep sensitive page data and bridge
handles protected by existing document/receiver checks. Apply identical ownership and
navigation rules on desktop and mobile.

### Extract the distribution by responsibility

Today's Base is a complete personal/system distribution. Extract actual personal/system
coupling across source dependencies, startup/service registrations, skills, initial state
and existing build inputs. The result must let an ordinary app workspace run independently.

This is responsibility separation, not a dependency-size optimization project. Preserve
cohesive existing packages and their useful common helpers where they fit. Split a package
when actual personal/system coupling requires it, not merely because some generic code is
unused by one app. No byte-count target, exhaustive minimality proof or package-by-package
pruning is required. Personal/system workflows and private state must still be extracted.

| Responsibility                                                                                              | Owner                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Essential agent harness, local source/runtime tools, common protocols, and essential instructions           | Minimal Base source, included in each app's distributable workspace closure.                                                                                                 |
| Desktop/mobile clients, provisioning, system settings, environment management, and System-owned about pages | Acting user's designated System workspace; shared host administration retains separate operator authority. Never inherited by every app workspace.                           |
| Personal browsing/import workflows, collections, ordinary projects, and personal assistant memory           | Personal distribution/workspace; device-level effects use the existing bounded System/native mechanisms. Other app workspaces receive only deliberately disclosed resources. |
| Development, diagnostics, onboarding, and optional product features                                         | Their appropriate owning workspace/system application, outside common Base unless they are cohesive generic runtime functionality.                                           |

Trace real dependencies. If a generic runtime package imports personal/system product
code, separate the generic responsibility from that implementation. Hiding a panel,
turning off startup with a flag, or importing the full distribution and deleting parts
later is not extraction.

A small app must start its agent without a personal assistant, browser-import worker,
or environment-wide system agent instantiated in its workspace. Host-mediated provider
use can remain available without exposing credentials or private personal state.

Select client source from the user's designated System workspace independently of the
focused app workspace, using existing startup and workspace machinery. This extraction
adds no release recovery or update mechanisms.

## 5. Snapshots, personalization, and integration

### Distribution

Publish selected source and intended initial assets from one workspace. The snapshot
includes its complete workspace-code closure, including adopted Base code, relative
to installed host contracts and declared external build dependencies. It must not
include private runtime databases, conversations, credentials, grants, approval receipts,
or unrelated personal history merely because they exist in the author's workspace.

Start with a URL resolving to an exact snapshot. A later catalog supplies discovery and
publisher information over that same admission path. Content integrity identifies bytes;
publisher authenticity is a separate fact. Neither grants authority.

Snapshot admission validates the source closure and builds under the canonical isolation
rules. New workspace identity, data ownership, and runtime state are created explicitly.
Selected initial data is ordinary application content, not a serialized live installation.
Update work is out of scope: no update checking, scheduling, propagation, update UI or
release management. Existing explicit source comparison/merge remains ordinary editing;
this plan does not add an update workflow around it.

### Reuse existing source operations

Inventory the actual source copy, comparison, merge and publication operations in the
existing semantic VCS and retained template machinery. Use those operations for selected
source adoption and personalization. Record existing pins/provenance and source baselines
where supported; do not add a bundle merger, contribution ledger or history-redaction system.

A selected copy and a history-aware merge are different operations. Copying selected source
must not be described as preserving merge ancestry. Use an existing merge when the necessary
baseline/history is available and authorized. If the available merge would require disclosing
private history beyond the user's selection, use an explicit selected copy when that meets
the task, or report that the requested merge is unsupported. Do not silently broaden disclosure
or construct a new selective-history representation to satisfy this product cut.

Source disclosure and destination incorporation both require authority. Review identifies
what crosses the boundary, where it goes and whether this is a copy or a supported merge.
A preview shown to the destination is already disclosure. Reuse existing operation contexts,
publication receipts, conflict handling, stale-selection checks and retries. Candidate
execution must not inherit ambient production secrets or grants. An unresolved source
conflict is repaired through ordinary editing, not a provider fallback or runtime adapter.

The implemented selected-file path is the ordinary `@workspace/workspace-transfer`
client shared by desktop and mobile. It reads source metadata and bytes under the
source workspace's existing authority, and writes through the destination's existing
blobstore/VCS methods after confirmation. A new repository uses snapshot import;
an existing repository uses selected external-delta comparison and merge. The review
context is reserved in the preview and created only on confirmation. Copied content
follows the destination's current and future membership policy. Delivered bytes cannot
be recalled by revoking access, and an interrupted operation must not imply that no
bytes reached the destination. Review with an agent is a separate, explicit action
in that destination context; publishing remains the ordinary reviewed VCS operation.

Copying or merging source never copies grants. Local adopted code executes under destination
authority and retains its origin. Knowing an upstream hash or ancestry edge supplies no
read authority. Acceptance must cover an existing supported integration path, not require
new history-preserving selective merge semantics.

### Limits of state integration

Begin with files/source already supported by semantic VCS and explicit artifact copies.
Application-record merging requires real identities and conflict semantics; arbitrary
worker/SQLite stores do not have a universal meaningful merge. Do not implement a generic
database merger or label a database copy as a merge.

The first proof uses schema-stable data. Database migration and code/data rollback tooling
are outside this work; ordinary source merging must not be represented as undoing data effects.

### Controlled communication: extend RPC, not the workspace environment

Use workspace-scoped RPC as the common communication mechanism for buttons, agents,
automation, streams and events. Connections permit explicit interaction, not remote
source mounts, shared memory, automatic membership, pooled credentials or live Base
execution. A live shared document has one owning workspace and authorized operations;
a copied artifact becomes independently owned by its destination. Source personalization
uses the existing reviewed source operations above.

| Use case                                    | User action                               | Boundary contract                                                                                                                 |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Personal research into a shared project     | Send selected documents to Project        | Copy the reviewed selection with provenance and receiving-audience disclosure.                                                    |
| Personal calendar from a project            | Ask Personal for meeting-time suggestions | Send a bounded request; return permitted slots, not credentials or private event details. Creating an event is a separate effect. |
| Another workspace's agent helps             | Ask Research to investigate a question    | Start a bounded task there with selected context and an attributed result; do not migrate the sender's live agent or memory.      |
| Personal dashboard follows project progress | Follow selected milestones                | Establish an authorized subscription; disclose selected events while its authority remains valid.                                 |
| Personalize an app workspace                | Apply selected agent setup                | Review and copy or use a supported merge locally; do not copy governing state or grants.                                          |
| Open a referenced document elsewhere        | Open in its owning workspace              | Explicit client navigation under access checks; no panel reparenting, agent relocation or automatic connection.                   |

### Addressing, exports and discovery

A cross-workspace destination identifies an exact workspace, service/object and method.
An omitted workspace means the current workspace, with no cross-workspace fallback search.
Names are presentation; routing uses verified stable identities. The receiver derives the
calling user, workspace and execution identity from authenticated facts, not caller-supplied
labels. A known address is not authority.

Reuse existing entity/context routing, including supported cross-context calls; do not add
a main-only export restriction. The current `runtime.createEntity` contract binds an entity's
context/source identity, and RPC dispatch targets that entity. Context selection is not a
new arbitrary branch-selector field on every RPC call. Cross-workspace admission resolves
the destination's existing target and its context before checking export eligibility and
authority. Caller-context inheritance, where used in local entity creation, does not imply
that a same-named context exists in another workspace.

Discovery, review, dispatch and resumed work must agree on the existing target/context,
admitted implementation and provider-state binding. Keep current version/incarnation and
context-boundary checks. No focus-based retargeting, additional branch-routing layer or
parallel simplified dispatcher. A connection may select a main-context target through the
same mechanism, without making that a new protocol restriction.

Only deliberately exposed operations are eligible for external calls. Express that exposure
through existing RPC method/capability definitions and boundary policy, adding only missing
policy information. Reuse the same inputs, resource derivation and sealed implementation
identity. There is no separate export manifest, duplicated schema, integration service
registry or parallel registration lifecycle. Exposure does not grant invocation authority.
Discovery filters the existing catalog under the applicable disclosure policy.

The application operation defines its semantics using existing RPC contracts. Calendar and
research examples illustrate authority/disclosure; they prescribe neither a platform API nor
new application work. Request text remains input, not governing instructions, and receiving
a call cannot authorize undeclared agent execution, model spending or tools.

Discovery is a separate metadata disclosure evaluated through the same authority machinery.
Agents see only the workspace/operation descriptions and schemas they are authorized to
discover. No global private-workspace registry or enumeration-triggered prompt storm.
Discovery permission does not confer call permission; guessing an undisclosed address
cannot bypass call checks. A trusted human picker can show the workspaces its user may
manage without exposing that whole inventory to the requesting app or agent.

### Hard ingress/egress policy before approval

For A calling B, require A's egress policy and B's ingress policy to permit the selected
cross-workspace operation, followed by its ordinary capability/resource checks. Use one
canonical evaluator/acquisition system, with boundary policy as a non-overridable ceiling.
Existing grants, open-tier local methods and ordinary allow prompts cannot cross a hard deny.
Here ingress/egress means incoming/outgoing application-call initiation. A permitted call
includes its explicitly authorized bounded return; that return does not require a reverse
application-call export. Result disclosure still has its own resource/audience checks.
Use labels such as Incoming calls and Outgoing calls in settings: outgoing calls blocked
must not imply that replies or all other data egress are blocked.

Start with default deny and explicit permitted scopes, not parallel allowlist/blocklist
modes or rule-order precedence. Scopes select the other workspace, authenticated user or
authorized role, and exported operation, with discovery separately scoped. New services
remain closed unless deliberately included. Resource-specific consent stays in the existing
capability model; the boundary being open is never a resource grant.

| Boundary result    | Ordinary operation authority | Outcome                                       |
| ------------------ | ---------------------------- | --------------------------------------------- |
| Either side blocks | Any, including a prior grant | Deny before method entry; no approval prompt. |
| Both sides permit  | Missing but acquirable       | Ask the appropriate authorized approver.      |
| Both sides permit  | Already granted              | Execute within that grant.                    |
| Both sides permit  | Independently prohibited     | Deny without an approval escape.              |

Manage boundary settings through the user's System UI, but store and enforce governing
policy below mutable workspace code. Imports, source merges and System edits cannot change
it. The owner controls a private workspace's policy; authorized shared-workspace
administrators control the shared policy. A member's System is their interface, not an
administrator of every displayed workspace. Shared policy cannot consent to a member's
personal account use. Changes to boundary policy require a deliberate authorized management
operation, not an Allow anyway button on a rejected RPC.

System has a protected blanket denial of incoming cross-workspace application RPC and
exports no such operations. The restriction is not promptable or relaxable through ordinary
workspace settings. Replies to System-initiated permitted calls are bounded returns on
those calls, not incoming method invocations or permission for callbacks. System's outgoing
calls still pass its egress, destination ingress and ordinary capability checks. Protected
host capability receivers remain host-owned, even when their approvals are displayed in
System; they are not a second route to otherwise forbidden System methods.

These policies regulate RPC. Artifact transfer and network/native routes retain their
applicable protected checks; raw sockets, alternate transports or host forwarding must not
bypass the cross-workspace RPC gate. Do not label an RPC-only restriction as a guarantee
against all information egress through independently authorized channels.

### Connections, approvals and shared ownership

A connection is a UI view over source/destination boundary policies and applicable capability
grants. Those records remain the only authority for access. A saved name or grouping may be
presentation metadata; do not add a separate authoritative connection record, activation bit,
lease, approval store or installation lifecycle. Derive eligibility from current policy and
pending status from existing approval requests. Disconnect edits/revokes the selected policy
or grants under their actual owners' authority, making its scope explicit; it is not a second
revocation path. Editing a display label cannot change access.

Present that view concretely, for example:

> Project may ask Personal for meeting-time suggestions. Only your requests are accepted.
> Responses contain available slots, not event details, and are disclosed to Project's
> authorized audience. Calendar access requires your consent.

The UI composes source egress, destination ingress and operation approval into one readable
view without merging their authority. Show who controls each side, which policy blocks a
request where disclosure is permitted, the actual personal account used, recent activity,
and disconnect. One user controlling both sides can configure them together; otherwise
collect the distinct administrators' decisions. Do not reveal hidden destination details
through denial explanations.

Implement connection setup through the existing protected host authority/management path,
authenticated as its managing user. The trusted picker/settings UI does not call a blocked destination to
negotiate access and does not invoke System through cross-workspace application RPC. If only
one side's administrator has consented, derive the pending/ineligible display from existing
requests and policies; no calls are eligible until both policies permit them. Reuse existing
approval coordination. This grants no target-resource access and needs no new negotiation
protocol, connection state machine or authority exception.

After a concrete first request, reuse existing once/session/version grant choices where
the operation supports them. A persistent operation grant remains bounded by both policies;
changing eligibility never creates that grant. Avoid prompting on every harmless repeat,
but do not use convenience to widen the operation, caller or resource selection. Capture
source, destination and inputs before presenting approval; later focus changes cannot
retarget them. Rate-limit/deduplicate repeated requests using existing mechanisms so code
cannot overwhelm the receiving user with approval cards.

Permission to ask is distinct from permission to perform and disclose a result. The receiver
executes the exported operation under an explicitly authorized receiver-owned resource
scope for this request and returns only the permitted result. This is not limited to the
caller's pre-existing resource grants: Project can receive approved meeting slots without
itself receiving calendar access. It is also not permission to run under all of Personal's
ambient grants. Bind consent to the selected operation, receiving implementation, inputs,
resource use and result disclosure, preserving the initiating user's/workspace's/website's
applicable restrictions. Shared agents cannot pool members' private grants or select
whichever user's System/account has broader access. A member must explicitly consent to
use of their personal resources; membership or administrator approval alone is insufficient.

**Accepted implementation design:** trust deliberately exported, reviewed receiver
implementations to stay within their intended authority: the approved operation's selected
resource use and result disclosure. Retain hard workspace ingress/egress checks and ordinary
receiver authorization. Separate per-invocation execution and credential isolation is not
required by this contract.

The existing sandbox isolates a whole workspace, and RPC receivers are long-lived workers
with ordinary workspace authority. A receiving
worker can omit an optional invocation-parent nonce and start an independent call; native
workspace code can also use its workspace filesystem outside the causal RPC chain. Therefore
invocation attribution or an additional grant constraint cannot enforce the paragraph above
against a malicious receiving implementation. Staying within the approved operation is a
reviewed receiver obligation, not a claim of confinement against malicious receiver code.
Cross-workspace forwarding may proceed under this trust contract once its required boundary
checks and authority propagation are implemented and verified.

### Transfers, results and calls through other workspaces

RPC may initiate an artifact transfer or source merge, but selection, provenance, audience
and conflict semantics remain explicit operations. Dragging a document to another workspace
opens a transfer preview before destination disclosure. A preview is itself a disclosure
if shown to a destination agent. A file reference must not reveal its containing directory,
unselected attachments or private source history.

Audience disclosure applies to request inputs, replies, streams, events, error details
and retained task records as well as copied artifacts. Returning data to shared Project code
is a disclosure to Project's authorized audience even if only Alice may initiate the call.
User attribution is not a private storage boundary inside a shared workspace. A result that
must remain Alice-private stays in her Personal workspace and is viewed there; return only
the explicitly shared selection to Project.

Review names each receiving workspace and its audience. Shared content follows that
workspace's membership policy: future authorized members may see retained content. Revoking
a connection does not recall delivered copies. Never copy private membership, credentials
or governing state into the destination.

Distinguish copied values from references to owner-held resources. Returning a reference
or hash does not grant future access. Existing workspace-local handles stay local; later
reads use an authenticated operation at the owner and recheck current authority. Do not
make them portable by stripping their workspace binding. Streams and results belong to the
specific authorized call and selected disclosure; they cannot introduce arbitrary reverse
RPC, expose a service catalog or deliver authority-bearing callbacks.

Preserve the initiating user/workspace, immediate caller, operation and any website origin
through each hop, response and final effect. Project calling Personal calling Calendar must
not turn into an unrestricted Personal request. Each boundary evaluates the next operation
and its resources against the bounded receiver-owned authorization and the originating
request's applicable restrictions. An explicitly approved service operation may use its
owner's resources; a hop cannot widen that operation or erase website/initiator restrictions.
Receiver authority is never copied back to the caller. A receiving agent treats external
inputs with their provenance, even if processed by locally adopted Base code.

### Existing RPC features, work ownership and revocation

Preserve existing calls, streams, events, context routing, caller/origin attribution and
transport reconnect behavior. The [RPC SDK](../packages/rpc/README.md#core-concepts) already
exposes these features. Apply workspace addressing and boundary/resource checks consistently
to their existing delivery paths; do not create a unary-only cross-workspace protocol and
later rebuild streaming or event support. A bounded request/result is the first verification
example, not a restriction on the existing RPC feature set.

Application jobs and subscriptions keep their existing owners, identifiers, status,
cancellation and retention semantics. Adapt those paths only where crossing a workspace
boundary requires identity, authority or disclosure checks. Add no universal task API,
new inbox lifecycle, subscription framework or message bus. A disconnected UI does not
change job ownership or extend authority. Recheck delivery/disclosure authority on existing
event and stream paths, including after reconnect; subscription setup is not permanent consent.
Reuse effectful-request identities/retries without promising exactly-once external effects.

Policy tightening, grant revocation, membership removal, workspace stop/deletion and changes
to the executing source apply to pending work and future effects. Recheck live authority before dispatch,
protected effects, resumed work and result/event delivery. Retire affected handles,
subscriptions and mediated streams; reconnect cannot restore stale access. Cancellation
requests cleanup under the canonical lifecycle contract, not rollback of completed effects
or a guarantee that hostile computation has terminated.

When a member leaves, deny future calls under that membership. Independently authorized
workspace-owned jobs may continue under their actual owner; never convert a departing
member's job or personal grants into collective authority. Service contracts and exact-code
checks must prevent approval silently carrying over to a materially different replacement.
Missing/incompatible exports produce a repairable error, not fallback to another provider
or automatic permission expansion. Deletion/recreation under the same display name does
not restore a connection to a different workspace identity.

### Navigation and staged delivery

Navigation is a client action with an explicit destination workspace/panel/resource and
ordinary access checks. Opening a view does not copy content, move a conversation or its
memory/grants, invoke a pending action, or establish a connection. The trusted client may
aggregate authorized results while preserving each workspace's ownership and attribution;
individual workspace agents do not inherit that aggregate access.

The first integration example uses an existing protected RPC operation and a selected
artifact/source transfer between two users' private and shared workspaces. Use existing
fixtures or a minimal test receiver with equivalent contracts; do not build a calendar or
research application as a prerequisite. Prove policy-denied/no-prompt and eligible/approved
behavior plus filtered discovery. Cover existing stream/event/context paths with focused
checks appropriate to changed routing and authorization, retaining their transport semantics.
Source adoption uses an existing supported copy/merge path. No new selective-history merger,
unrestricted discovery, remote Base execution, source mounts or implicit delegation is added.

## 6. Client, agent, and website behavior

Each workspace section preserves its existing user-owned root forest and member roles.
Panel parent/child edges remain inside one workspace. Omit cross-workspace reparenting
initially; explicit copy/merge actions have their own review. Client ordering, expansion,
and focus are presentation state, not shared source or permission changes.
Personal home selection and the protected System role are separate from per-workspace
panel trees. About-page instances load locally in their owning workspaces. System commands
open/focus System panels with explicit resource selection, as specified in section 4.

Every panel action, Quickfire conversation, history target, notification, and approval
carries its actual workspace independent of current focus. Search may aggregate metadata
for the user without giving each app's agent the aggregate index. A pending approval cannot
switch owners when the user focuses another section. Icon and favicon retrieval and caches
also belong to the immutable workspace client. System chrome's document origin cannot
resolve another workspace's source icon. An RPC-less approval overlay receives only the
owning approval controller's bounded, already-resolved image through existing presentation
props. Initial refresh and delayed workspace opening must preserve a later explicit focus choice.

Native runtime leases belong to retained views and their runtime incarnations. A timed-out
bootstrap abandons its result without retiring a view that is still wanted. Eviction, runtime
replacement and actual screen disposal retire that owner and finish exact lease cleanup;
late acknowledgements cannot recreate it or release a newer view's route. Acquisition and
takeover replies carry the same authoritative coordinator version as lease events and
snapshots, so each retained owner rejects stale observations without a second local clock.

Quickfire remains bound to its target workspace and context relationship. Changing focus
may select another conversation; it cannot transport prior private memory or grants.
Collection agents keep existing context restrictions. Agent discovery is local source,
local skills, existing host capabilities and explicitly connected collaboration endpoints.
There is no global private-workspace agent registry or automatically shared tool catalog.
In a shared workspace, show which user or workspace task an agent represents; membership
does not make every member's instructions, memory or approvals interchangeable.

### Desktop and mobile interaction design

The experience should feel like returning to familiar rooms: each workspace keeps its place,
its panels and its conversations. Workspace boundaries stay visible in chrome and become
explicit at a transfer or permission decision. Routine navigation requires no confirmation.
Keep the existing typography, theme tokens, panel layouts, drawers, command surfaces and
approval components. This is a navigation/ownership change, not a visual-system rewrite.

#### Shared navigation contract

- Use Workspace in product copy; never expose partition, RPC or execution-principal vocabulary.
  Keep the current server/account in the account menu, separate from workspace selection.
- Each workspace has a stable name and optional icon. Personal and System retain those role
  labels if renamed. Shared workspaces show a people indicator and member count; private
  roles say Only you in their details. Privacy labels describe membership, not native sandbox
  guarantees. Show actual runtime access when native execution needs a disclosure.
- Personal is the initial home. On later visits restore the user's last accessible workspace
  and panel through existing navigation state. System is present but visually quiet until
  needed. Base is a creation source, not a mandatory running workspace in navigation.
- Selecting a workspace restores its last focused panel and existing layout; it does not
  restart the client, stop another workspace or create a new panel. Empty workspaces show
  their local New page. Collapsing a section changes presentation only.
- Focused panel ownership determines the active workspace for panel actions. Store selection,
  expansion, scroll position, drafts and return targets by the existing workspace/panel IDs
  under the authenticated user; do not use names or one globally mutable active-client pointer
  to retarget in-flight work. Per-device presentation may differ without changing shared trees.
- Reuse existing workspace ordering/pins if available. Default to Personal, ordinary workspaces,
  then System. Do not add a new ordering/synchronization service for this layout.

#### Desktop: a stable sidebar, with workspace trees stacked

Replace the chooser-as-workspace-switch with stacked workspace sections in the existing
sidebar. Each heading contains its name, collapse control, workspace-local New action,
attention indicator when needed and an overflow menu. The selected heading has a restrained
accent and a visible selected state; color alone never identifies ownership. Expanded
sections show their own existing panel trees, including existing member/root groupings.

The main area uses the selected workspace's existing panel layout. Preserve its own split
panels and geometry; the initial design adds no cross-workspace split canvas or tree edges.
Panel chrome shows the workspace name alongside the panel title/address, so a hidden sidebar
or detached view does not erase ownership. For websites, keep the verified domain visible.

The account/global area contains Open workspace, existing search/commands and the approvals
entry. Settings opens a System panel. The footer may link directly to System settings, but
must focus the same workspace/panel rather than render a second settings implementation.
System remains a normal, expandable workspace section.

A heading's New creates a panel in that heading's workspace even if another workspace was
focused. The main New action and existing keyboard command use the focused panel's workspace.
Tooltips/accessibility labels say New panel in Project. Reuse existing shortcut bindings;
workspace/panel search results show their workspace and focus an existing view when possible.
Keep ordinary search local by default, with an explicit All workspaces scope for authorized
human navigation. Searching across workspaces does not disclose that index to local agents.

#### Phone and tablet: one panel, the same workspace structure

Extend the existing mobile drawer with the same stacked workspace headings and local trees.
Keep its edge gesture and visible menu button; no gesture is the only route to a feature.
The app bar shows the active workspace and panel title; the address mode still exposes the
website address. Tapping the workspace label opens the drawer. Selecting a panel focuses it
and closes the phone drawer; selecting a heading restores that workspace's last panel.
Collapse/expand has a separate affordance so it cannot accidentally change focus.

Keep New and panel actions in the existing app bar/action sheet and reuse Quickfire,
command and approval sheets. Add workspace labels to those surfaces rather than adding
another bottom navigation system. Touch targets are at least the existing 44-point target;
use large-text layouts, safe-area insets and keyboard avoidance. Sheet content and actions
remain reachable on short screens and when the keyboard is open.

On tablet, reuse the existing permanent-drawer layout threshold; show workspace sections
in that sidebar and retain the existing content layout. Rotation changes presentation,
not workspace or conversation. Mobile and desktop share semantic commands and identifiers,
not a forced identical screen layout.

#### New, open and return: small flows with visible destinations

| Intent                        | Interaction                                                          | Completion and return behavior                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a panel                | New in the current workspace, or New on a workspace heading          | Open that workspace's local `about/new`; show New in Project. No workspace picker for an already known destination.                                            |
| Open a template/bundle link   | Existing Open workspace flow shows source, name and Create workspace | Create an ordinary workspace using retained template acquisition; focus its local landing/New panel. No transfer of the previous workspace's data or grants.   |
| Start an empty workspace      | Existing creation command with the appropriate Base source           | Focus the new workspace; preserve the previous workspace as a return destination. No setup tour or required agent conversation.                                |
| Open settings for Project     | Settings command captures Project as its managed resource            | Open/focus a local System settings panel. Header says System / Settings and Managing Project. Back returns to the initiating panel when it still exists.       |
| Open personal browser history | Existing browser-history command                                     | Open/focus a Personal panel. Do not load Personal source into the current workspace.                                                                           |
| Return to recent work         | Select its workspace heading or a labeled command result             | Restore its existing view. If the target was deleted or access changed, explain and offer the remaining workspace list; never act on a same-named replacement. |

Opening a bundle link presents source information and the existing creation action; it is
not a new permission gate or a promise that publisher identity makes native code safe.
Network/native behavior follows existing platform disclosure and approval. A failed creation
stays in the existing creation flow with its error; it does not discard the current workspace
or introduce release recovery/update work.

#### Quickfire: always visibly about the right panel

Use the existing desktop overlay and mobile sheet. Its header names both target panel and
workspace, for example Quickfire · Project / Research notes. Opening Quickfire from a panel
captures that target. Switching workspaces may show the new target's existing conversation;
it never moves the previous conversation, draft or permissions. While a sheet is open, it
keeps its captured target until explicitly dismissed or switched through existing navigation.

On an external website, show the verified domain with the target. A webpage requesting its
own action remains website-attributed; reading the page with Quickfire is not permission for
the site to use Quickfire's account access. Background work does not steal focus. Existing
completion indicators/notifications identify the originating workspace and open that target.

#### Approvals: visible ownership without interrupting every switch

Reuse the existing approval queue, chip, desktop surfaces and mobile sheet, including
the [shared approval copy](../packages/shared/src/approvalCopy.ts) and existing actions. Add workspace
attribution to those components; do not create a separate queue or approval page per workspace.
The global entry shows the pending total and the list groups by workspace. A workspace heading
shows only its own pending count. Counts exclude requests already answered on another device.

The card's first read answers who, what and where. Display the originating workspace, target
workspace/resource and acting account where relevant. For a website, include a persistent
Website label plus verified domain, visually distinct from local code without alarm colors
for every ordinary web page. Keep trust-origin detail separate from membership labels.

Example copy: Allow Research Agent in Project to read “Research notes” from Personal?
The body names what Project will receive and, if shared, who can see it. Personal-resource
consent is addressed to its owner; Project administration cannot substitute. Use existing
action/duration choices, not new UX-only grant lifetimes. A multi-part action can use existing
review grouping, while each policy and resource decision keeps its actual owner.

A pending card never changes workspace as focus moves. Preserve the visible card and offer
Open Project as an explicit navigation action. New actionable requests open the shared review
surface without navigating the active workspace; further arrivals do not replace a card being
answered. Workspace switching itself never opens another modal. Minimize, previous and next
operate on this one presentation queue. Queue identity and delayed UI intents include both
workspace ID and approval ID, and delayed callbacks remain bound to the exact retained
client lifetime, so removal/restoration cannot retarget an old answer. The owning clients
retain subscriptions, authority, blob/icon reads and decisions; the shared queue owns only
presentation selection. Routine notifications use visible shared chrome with the same
workspace attribution, while keeping their existing notification actions and lifetimes. If policy hard-denies,
show a plain explanation in the originating task, with Open settings only when the user may
manage that policy. There is no Allow anyway button and no prompt generated by discovery.

Mobile pushes and lock-screen previews use existing privacy preferences and omit private
resource details by default. A deep link resolves current user/workspace/request identity
before showing or deciding anything. If another device resolved it, show Already handled
and return normally; do not resurrect the request or apply its action to the new focus.

#### Sharing and connections: concrete actions, short reviews

Send a copy… belongs in existing document/panel action menus. On desktop, dragging between
workspace sections may invoke the same flow; it must never reparent or silently share a panel.
On mobile, the action sheet opens a destination picker and then the same review. The picker
lists only authorized destinations, identifies shared audiences and disambiguates equal names
using their server/owner metadata when needed. Keep the selected source stable throughout.

The review shows source → destination, the selected items and the receiving audience.
For example: Personal → Project; Research notes; Visible to Project members. Additional
selection/history details are expandable. Use Copy to Project as the concrete action.
After confirmed completion, keep the source in place and show Copied to Project with Open
copy. Do not show Undo unless the existing operation can genuinely reverse its effects;
delivered information cannot be recalled by removing a permission.

Source adoption uses the existing source review and explicitly labels Copy or Merge according
to the actual operation. No new merge wizard, history-redaction feature or example application
is required for this UI. Reuse existing errors/conflict review rather than silently broadening
what is sent.

In System settings, Managing Project / Connections displays human-readable allowed interactions,
for example Project can read selected notes from Personal. It is a projection of existing
policies and permissions. Use Incoming calls / Outgoing calls only in the advanced settings;
ordinary action text names what another workspace can do. Show who controls a blocked side
when the user may see it, and Pending approval based on the real request state. A Remove
permission action explains the underlying rule/grant affected, including other uses of a broad
rule; it does not toggle an independent connection state. System's incoming calls are shown
as Blocked by system policy with no enable toggle.

Shared workspaces use their existing member management UI. Personal/System omit invitation
controls and explain Only you when membership is inspected; receivers still enforce the
restriction. Do not add a special collaboration setup wizard.

#### Calm state changes and accessible polish

| State                                  | UI treatment                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace opening                      | Keep its name/tree position visible; show progress in that section and a content placeholder. Other workspaces remain navigable. Do not display a permission request as loading.                                           |
| No panels                              | Local New page offers existing create/open actions with the workspace name. No invented activity dashboard.                                                                                                                |
| Disconnected server/workspace          | Retain identifiable view state with a clear disconnected label. Existing reconnect behavior applies; disable effects that require live validation rather than promising an offline queue.                                  |
| Access removed or panel deleted        | Remove inaccessible content/metadata through existing revocation paths, clear its active target, explain the change and let the user select an accessible workspace. Never silently redirect a pending action to Personal. |
| Workspace stopped                      | Distinguish stopped from closed/collapsed. Existing Open/Start behavior resumes it under current authority; no new install/uninstall state.                                                                                |
| Shared result or background completion | Quiet workspace-attributed badge/toast; explicit Open action. No automatic workspace switch.                                                                                                                               |

Reuse theme tokens and restrained active accents. Preserve sidebar position during status
changes; avoid reshuffling workspaces by live activity. Use text/icon plus color for shared,
selected, waiting and disconnected states. Motion only reinforces an actual navigation or
sheet transition, honors reduced motion and never delays input. Mobile haptics follow existing
platform conventions and are optional, not a new interaction dependency.

Keyboard and screen-reader navigation must distinguish heading selection, expansion and New;
labels include the destination workspace. Sheets return focus to their invoker. Long names,
large type, duplicate workspace names and narrow windows must preserve the actionable identity
without hiding primary controls. Do not introduce new keyboard bindings that conflict with
existing commands; expose workspace/panel destinations through the existing command UI.

#### Implementation fit and UX acceptance

Inspection of the selected Base shows desktop `apps/shell/components/WorkspaceChooser.tsx`
and `state/appModeAtoms.ts` selecting a workspace through a client relaunch. Replace that
presentation switch with focus within the already-open per-user System client. Keep server
selection/authentication distinct. Audit singleton `shell/client` consumers so each action
uses the captured workspace's existing client/runtime handle; reuse current factories and
registries rather than inventing another broker or rebinding in-flight calls globally.

Mobile already has `MainNavigator`, `PanelDrawer`, `AppBar`, `CommandSheet`, `QuickfireSheet`
and `ApprovalSheet`, including a permanent tablet drawer. Extend those surfaces with workspace
sections and explicit target labels. Desktop already has panel-tree, Quickfire and approval
surfaces to reuse. Workspace status/approval counts use existing event subscriptions and
lifecycle owners, not one polling loop or new activity service per section. Displaying a
section must not eagerly build every panel or start all its agents; preserve current demand-
driven materialization and retention behavior.

The written design is authoritative; the companion in-conversation mockup explores navigation,
local New, System settings, a selected copy and an attributed approval using sample content.
Its local interactions grant no real permissions or perform real transfers. The editable
preview is `docs/mockups/workspace-client-navigation.html`.

Acceptance adds these focused user journeys to existing desktop/mobile checks:

1. Switch Personal → shared Project → Personal without a client relaunch, lost panel position
   or draft. Phone drawer and tablet sidebar preserve the same ownership semantics.
2. Create via global New and a different workspace heading's New. Each creates exactly where
   its label says, including after focus changes. Open System settings for Project and return
   to its invoking panel; no source crosses workspaces.
3. Start Quickfire in Project, switch elsewhere, and receive an approval/completion for Project.
   Its card/conversation stays correctly attributed; answering on another device retires it.
4. Send selected content Personal → Project on desktop and phone. Audience is clear before
   disclosure, cancellation transfers nothing, success keeps the source and opens the actual
   destination only on request. A hard policy denial produces no approval override.
5. Open a bundle through existing creation, navigate a website, and inspect a website-attributed
   request. Verify metadata-only discovery does not prompt and does not expose another user's
   private workspaces. No calendar app, task framework or update/recovery work is required.
6. Exercise empty, stopped, disconnected and access-removed states with long/duplicate names,
   keyboard/screen reader navigation, large mobile type, reduced motion and narrow layouts.
   Pending actions never inherit a fallback destination; inaccessible content is not retained
   in a visible supposedly-private preview.

### Websites

An agentic website is a panel in the workspace where it is visited. Visiting or bookmarking
it creates no new workspace and grants no Vibestudio capability. Normal web loading and
browser-origin/session behavior are distinct from workspace grants.

Trusted client approvals identify the verified website origin, operation, selected resource,
and workspace. The special website treatment comes from host-derived identity and actual
enforcement, not just a badge or website-provided title. A site cannot gain local source,
skills, other panels, conversations, or paid model use through same-context/open-tier or
fresh-context shortcuts.

Quickfire is the local workspace assistant working about the page. Reading page content
retains external provenance. A website requesting its own agent must receive a bounded
local execution attributed to that site, without borrowing Quickfire's grants. The same
restriction persists through local tools and later effects; code from Base cannot erase
the originating website's authority ceiling.

Bind bridge handles to verified frame/document, origin, and workspace. Navigation,
reconnection, revocation, and queued work follow current authority lifetimes and cannot
silently reuse stale access. Identical origins visited in different workspaces do not
share workspace grants. Installing a site's bundle is a separate fresh-workspace admission;
transferring page/workspace data into it requires explicit copying.

### Existing workspace lifecycle

Opening a bundle creates an ordinary workspace. Use its existing close, stop, delete and
retention/garbage-collection behavior; there is no independent application installation,
uninstalled-but-runnable state or reinstall protocol. If the UI uses Uninstall, it invokes
the ordinary workspace deletion flow and accurately describes its existing data effects.

Closing/collapsing a view affects presentation. Workspace stop and resource revocation use
the existing owners and canonical cleanup contract; neither promises rollback of delivered
copies or termination of every hostile descendant. Existing restart and authority-lifetime
rules continue to apply. Preserve other workspaces' owned resources during deletion/GC.
Retain data only through existing workspace retention mechanisms, not a new uninstall store.

## 7. Implementation hand-off

Coordinate this product work with [canonical platform release acceptance](isolation-plan.md#release-acceptance)
and its [application authority contract](isolation-plan.md#application-authority-and-resources).
The former U0–U6 isolation roadmap has been superseded. The sequence below describes product
prerequisites, without recreating a competing platform implementation plan. Record product
and platform evidence separately; a passing RPC fixture cannot authorize hostile native
execution. Keep coordinated source changes, not parallel old/new runtime paths.

The implementation hand-off is a change to existing machinery. Keep existing RPC features,
authority storage, lifecycle and source semantics unless a demonstrated incompatibility
requires a concrete change. A narrower new interface is not automatically simpler.

| Existing area                 | Required change                                                                                                                                                                                  | Preserve/reuse                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace registry and client | Ensure each user's private Personal/System IDs; implement section 6's stacked desktop trees, mobile drawer, captured actions and workspace-attributed approval UI without relaunch on selection. | Existing creation, membership, runtime and lifecycle; no installed-app object or special System principal.                                         |
| Base/template source          | Extract personal/system coupling so ordinary app workspaces run independently; retain upstream identity/acquisition and remove composition-driven installation.                                  | Cohesive common packages and existing source operations; no dependency-minimization project, update, release recovery or selective-history merger. |
| Page navigation               | Adjust existing commands to open local routes in their owning workspace; System panels select explicit target resources.                                                                         | Existing navigation, panel/context ownership and host authorization; no page-role registry or cross-workspace source resolver.                     |
| RPC addressing and discovery  | Qualify the destination workspace and resolve its existing target; filter the existing catalog by deliberate exposure and disclosure policy.                                                     | Existing method definitions, schemas, contexts, calls, streams, events, origin facts and transport behavior.                                       |
| RPC authority and settings    | Apply source egress/destination ingress as hard ceilings before ordinary approval. System ingress stays closed. Present connections as views over those policies/grants.                         | Existing authority records, acquisition and management paths; no second connection or export registry.                                             |
| Website requests              | Carry verified website/workspace identity through the existing local capability and agent/tool paths.                                                                                            | Existing document/bridge and host resource checks; no inherited grants or parallel approval engine.                                                |

The first product milestone uses two users on one server, each with a private
Personal/System pair, and an ordinary workspace shared by both. Run local Quickfire,
adopt selected source through an existing supported copy/merge operation, copy an artifact
into the shared workspace, discover an eligible existing RPC operation, exchange an authorized
request/result, and approve a bounded website operation. No example application needs to be
built; fixtures exercise existing stream/event behavior where routing or policy changes. Prove that either boundary policy
can deny a call without a prompt, and System cannot receive cross-workspace application RPC.
Base exists as source only. Each client uses its user's System;
`about/new` is local; opening system settings creates/focuses a System panel, with no
cross-workspace about-page source loading. There is no app-store
UI, live Base linking, remote Base execution, or unrestricted discovery/delegation.
A specialized collaboration distribution is optional follow-on UX, not a prerequisite
for shared membership or another source/authority architecture.

Removal of composition-driven installation is required for completion, alongside working
retained upstream-template behavior. Align active documentation and installed skills with
that distinction. Historical plans may remain marked superseded. Determine actual
user-data preservation needs before a cutover; this plan change authorizes no deletion,
publication, deployment, or obsolete-state compatibility framework.

## 8. Verification and remaining concrete decisions

Captured checkpoint evidence (2026-09-08): Host/workerd type-checking and
all three Base type-check projects passed together. The authorization,
authority runtime, durable grant store and acquisition coordinator suites pass
98 tests. These cover the existing website authority foundations, not live
website admission or downstream agent effects.

Base `7f725ae` fixes a pre-existing panel-runtime subscription leak: teardown
now removes its shell state-args listener. All 12 initialization tests pass,
including live state delivery followed by listener removal and no post-destroy
delivery. Independent review found no issues. This is not evidence that the
separate Android activation stall or native process shutdown gaps are resolved.

Current completion gates are explicit:

Current-tree audit (2026-09-08): the numbered requirements below remain the
completion contract. Passing template typechecks does not close runtime,
multi-user, cross-workspace, website, mobile, or native dependency acceptance.
The requested **at least 50 distinct agentic system tests** also require a
consolidated run ledger with exact results; conventional test totals are not a
substitute. A dedicated agent is executing a 51-name slate on its own managed
instance. `tests/e2e/flows/crossWorkspaceRpc.spec.ts` now retains the recovered
scenario, including a permitted call and outgoing-policy removal. Its generated
receiver and panel mounting contracts have been updated, but current native
acceptance still needs to pass. That one-user scenario does not cover the full
two-user contract. Existing failed native runs remain failed evidence.

| Gate                         | Current state                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Receiver authority contract  | Reviewed receiver implementations are the accepted trust contract; per-invocation isolation is not required. Public forwarding still needs boundary checks, authority propagation, and acceptance.                                                                                                                                                                                                        |
| Website → agent/tool effects | Current source now includes the document-bound website workspace provider and native bridge (`src/preload/websiteWorkspaceProvider.ts`, `src/main/websiteWorkspaceBridge.ts`). The older claim that no production entry point exists is superseded. Complete website → agent/tool → effect, revocation and positive/negative native acceptance remains unproven; active website source is still changing.                                                                                                                                                                                                                                                                   |
| Desktop                      | Restored automatic onboarding including completed first turn and visible setup overview passes in the existing E2E. Existing browser startup, panel rebuild and restart persistence also pass. Strict reconnect diagnostics and open-approval membership revocation remain outstanding.                                              |
| Mobile | Android r4 passes automatic onboarding, document/focus retention, browser isolation, cold-start and server-restart recovery, and visibly correct Chat icons after Host `e1acfc82b` / Base `544a51a`. The intermittent five-minute System activation stall remains unresolved; this replay initialized in ~0.2–0.3 seconds. Tree-row alignment is changed but awaits native visual verification. iOS runtime acceptance needs an Apple environment. |
| Native dependency            | Repaired local Linux/Android artifacts are verified. The retained pending-read cancellation regression fails against pinned upstream 1.1.0 and passes with the repaired Linux artifact. Production platform pins need a coherent dependency release; a loader override does not close this gate.                                                                                                                                                                                    |
| Distribution                 | Examples, Google, News and Spectrolite have coherent standalone closures and pass current focused typechecks. News/Spectrolite initial renders pass, but settled functional readiness remains under test. Product seed receipts must be regenerated from the final source; concurrent edits invalidate older receipts. Packaged startup still requires exact pins and receipts. Base remains source-only.                                                                                                           |

Record the smallest relevant product evidence alongside canonical platform acceptance.
The following denials concern authenticated application paths; record native host access
and platform limitations separately rather than reporting them as denied:

1. An admitted bundle has its complete workspace-code closure and fresh runtime state.
   It runs when the authoring/Base workspace is stopped or unavailable.
2. The ordinary app source/build closure and loaded instructions exclude desktop/mobile
   implementations, browser-import workflows, personal memory and unrelated system code.
   The app runs independently using cohesive common packages; acceptance does not require
   proving that every remaining dependency/helper is indispensable or minimizing bundle size.
3. Two workspaces with identical unit names and code bytes keep independent data and
   grants. Their local Quickfire conversations and pending approvals survive focus changes
   without switching ownership. Preserve membership and user-root attribution for two users.
4. Existing source copy and supported merge operations change only the selected target and
   identify which operation occurred. Personalization executes locally without importing
   authority. Reuse their existing denial, conflict, stale-selection and retry tests. Private
   history stays undisclosed; unsupported selective-history merges remain explicit limitations,
   not a requirement to build another merge representation.
5. An authorized artifact/source transfer delivers only its selection and explains the
   shared audience. A controlled request/result preserves sender, recipient and operation
   scope; other cross-workspace reads/effects fail. Test revocation and membership removal
   without erasing provenance or falsely recalling already shared content.
6. A visited website stays in the visited workspace, has no ambient local capabilities,
   and can perform one positively approved operation. Test denied requests, origin/document
   changes, queued work, revocation, and website → local agent/tool → final effect attribution.
7. Stopping/restarting preserves intended data/configuration without stale live access.
   Existing workspace deletion, retention/GC and explicit grant revocation keep their semantics.
   A bundle introduces no independent uninstall state or installation lifecycle.
   Stopping an app does not intentionally stop the user's System or sibling workspace views;
   this is a lifecycle check, not release recovery or a native denial-of-service guarantee.
8. Existing template identity, metadata, exact acquisition and source-baseline handling work
   for Personal/System/Base and third-party snapshots. Root creation does not depend on
   Composer. No supported entry point recomposes installed template layers or inherits
   grants/configuration from ancestry. Preserve meaningful tests of retained behavior;
   no update or release-recovery subsystem is introduced.
9. Any inventoried System-restricted host operation checks the caller's ordinary workspace
   ID against that user's designation plus normal code/resource/user authority. No new
   principal kind, manifest/name spoofing or about-path privilege; System websites inherit
   no workspace grants.
10. New opens in the initiating/focused panel's workspace with local source. System settings
    opens a System panel, optionally targeting the initiating workspace as its resource.
    Existing commands use ordinary local routes without a new page-role registry. No about
    page loads source across workspaces; no focus retargeting, path-derived grants, private
    references in shared panel configuration or unauthorized sibling inspection.
11. Two users on one server each obtain exactly their own designated Personal/System pair,
    without duplicate creation or replacement of private state. Sharing/inviting additional
    members to either role fails at every receiver. Their System state, browser data,
    client selection and grants stay independent. No running Base workspace is required.
12. Both users can join one ordinary workspace and collaborate under explicit roles.
    Each user's settings command opens their own System panel; neither private source nor
    private state is loaded into a shared Project panel. A hosted panel session uses its
    authenticated viewer, validated against its exact host lease and current membership;
    the panel creator does not supply another viewer's browser data or account permissions.
    Background agent/worker lineage keeps its existing owner attribution. A shared agent cannot borrow
    the creator's, approver's, or another member's personal account grants automatically.
13. System-only effects validate which user's System is acting and which resource is owned.
    Another user's System or a forged role cannot substitute. Server-operator actions
    retain their separate authority. Reconnect, user removal, outstanding approvals and
    queued communication preserve these boundaries.

14. Local RPC resolves only locally; identical service names cannot select another workspace.
    Cross-workspace calls require exact addressing and deliberate exports. Either boundary's
    hard deny wins over old grants and produces no prompt, including direct-address attempts.
    Eligible calls reuse ordinary grants or acquire bounded approval without another engine.
    A connection UI derives eligibility/pending status from existing policies and approval
    requests; labels carry no authority. One-sided permission cannot authorize a call.
    Disconnect changes the selected underlying policy/grants; no stale connection record
    can override them. Host management need not call a blocked destination or System ingress.
15. System rejects cross-workspace application ingress, callback/forwarding bypasses and
    ordinary attempts to relax that invariant. Bounded replies to its authorized outgoing
    calls and genuine protected host capability requests still work under their own checks.
16. Discovery discloses only authorized metadata and does not grant invocation authority.
    Enumeration and denial messages expose no private catalog or prompt storm. System UI
    edits/source merges cannot change protected policy; shared administrators cannot consent
    to another member's personal account use.
17. Replies, streams, returned references and multi-hop calls preserve disclosure scope and
    user/workspace/website origins. References grant no access; workspace-local handles cannot
    be transplanted. Inputs, results, errors and retained task records have explicit audiences,
    including Alice-initiated calls whose results reach shared Project code. An existing
    protected operation may use an approved receiver-owned resource without granting it to
    Project; requests outside that scope fail. Use an existing fixture/minimal test receiver,
    not a required calendar API. Private results stay in Personal.
18. Tightening policy while approval is pending or a stream is active stops subsequent mediated
    access; reconnect, changed code/contracts and same-name replacement do not restore it.
    Existing entity/context/source binding agrees across discovery, review, dispatch and
    resumed work. Authorized non-main targets remain routable; foreign-context checks still
    apply. Focus changes and new branches cannot silently select another implementation.
    Navigation opens only the selected view without executing actions, transferring authority
    or relocating private agent memory.
19. Existing RPC calls, streams and events use the same workspace boundary and authority
    checks, including delivery after reconnect. Reuse existing job/subscription lifecycle
    checks where affected; member departure cannot convert private ownership/grants into
    collective authority. No new task API or subscription framework is required.
20. Discovery and invocation refer to the same existing method/capability definitions and
    schemas, filtered by applicable policy. There is no second export manifest/catalog or
    registration lifecycle that can drift from actual dispatch.

Run focused conventional tests and type checks for the changed contracts. For agentic
verification, follow [AGENTS.md](../AGENTS.md): provision one uniquely named managed instance
with `pnpm system-test --instance ID doctor`, run the smallest exact test, inspect and repair
failures, and stop that exact owned instance in a finally-equivalent cleanup path. Base
changes require stopping/reprovisioning so the managed workspace acquires current source.
Never reuse or stop somebody else's instance. These are proposed scenarios, not claims that
corresponding named tests already exist. Keep captured evidence restrictive and secret-safe.

Performance work uses the exact selected Base's `skills/performance/SKILL.md` and its owned
instance/inspector cleanup. The isolation plan owns platform and adversarial acceptance;
a passing UI test cannot establish containment. Documentation edits need link and consistency checks. The requested sandbox verification
uses existing real native fixtures; record their actual platform coverage separately.

Resolve the remaining concrete implementation and product questions:

- Which execution surfaces/platforms can admit hostile bundles under the accepted native
  contract? Explicitly resolve Windows native trust and shared-command credential exposure;
  no RPC approval or passing protocol test establishes missing OS containment.

- Which source units and startup registrations actually couple ordinary apps to personal
  or system functionality, and which cohesive common packages can remain intact?
- Which existing template fields/APIs represent upstream identity, exact acquisition and
  source baselines, and which exist only for composition? Retain the former and disentangle
  root creation from the latter. Which existing source operations support the selected copy
  or merge without disclosing private history? Record unsupported cases instead of adding
  new selective-history merge semantics.
- Which browser/runtime state follows a context branch versus a persistent workspace?
- How does existing workspace creation/registry ensure each user's non-shareable pair
  and handle account/pair deletion without replacing data? Reuse existing startup; add no
  release recovery or update work.
- In which workspace should each concrete about-page command open its locally sourced
  panel, and which actual host operations require a check against the user's System ID?
- Which existing RPC export/authority contracts express discovery and each side's hard
  policy scopes without a parallel registry or permission engine? Inventory host-owned
  versus System-owned receivers before assigning system operations.
- Which existing protected operation/fixture supplies the first cross-workspace proof, and
  which existing stream/event/job paths are actually affected by the routing changes?
- What actual user data must survive the coordinated cutover?

Base remains adopted local source, with no provider-selection or remote execution
mechanism. Controlled collaboration and gated discovery do not change that. Unrestricted
discovery and implicit agent delegation remain outside the selected communication
and integration operations; do not rebuild a dependency/service framework preemptively.


### Latest native rebuild verification (2026-09-08)

The unchanged exact test `visible desktop rebuild replaces the exact attempt and
reaches ready` ran once in Personal under E2E run
`panel-rebuild-personal-20260908-root`. It failed before rebuild during System startup:
`build.listUnits` reported that `browser-import` had no reviewed authority presentation.
The screenshot and attached server log agree. The visible startup error was obscured
by the E2E helper trying to resolve a workspace before reading initialization failure,
which surfaced as a generic automation timeout. Both the missing capability review
metadata and startup failure observation are under repair. The owned application,
Xvfb, and temporary root were cleaned up. This run is not rebuild acceptance.

After repairing the requested native capability presentation census in Host
`826fbc778` and recording host-launch failures in the existing startup ledger in
`f4232939f`, the unchanged test passed in Personal under
`panel-rebuild-personal-20260908-review-fixed`: one test passed, none skipped.
It verified ready presentation before and after rebuild, a new runtime entity and
presentation attempt, and the same panel identity. The owned Electron process,
display, and temporary root were cleaned up. This establishes native Personal
rebuild acceptance; it does not establish the separate atomic publication/store
persistence scenario or mobile device acceptance.

### Quickfire conversation identity repair (2026-09-08, verification ongoing)

Quickfire's userland service creates the channel using the panel's resource binding,
but its session result omitted the exact channel target. The client then discovered
the creator-scoped channel again through the observing shell, which has no creator
context. This is an identity propagation defect, not a missing user approval. The
existing PubSub `channelTargetId` contract already avoids that redundant lookup.
The slot repair returns the created target and requires desktop/mobile shared
Quickfire to preserve it; malformed results fail before attempting discovery.

The relevant recent semantic change is Host `b445eda44` (September 7): hosted app
RPC previously used `sendAs` and the workspace app's scoped connection. Retained
System chrome instead opens an authenticated `openHostUiSession`, stamps a shell
caller, and routes to the selected workspace as the user. That changes context
resolution and authorizing origin, not merely the destination address. Existing
Quickfire consumers and channel receivers were not adapted together. Older code
annotations or omitted target fields alone do not explain a previously working
flow regressing; the new routing/identity boundary exposed their incompatibility.

The same omission exists in notification-opened conversations: notification data,
conversation description, opening, and connection carried only a channel ID. The
repair must carry the producer-owned exact target through that whole path, using
the existing channel client and RPC contract. Do not derive provider identity in
clients, supply a default creator context, or introduce a second authority path.
This sibling repair and native conversation acceptance remain in progress. The
initial review missed this sibling and was withdrawn; focused slot tests alone do
not establish that all conversation entry points work.

The exact native command-overlay test then failed in
`quickfire-personal-20260908-root` after creation/subscription: the visible error
was `publish: no authority branch admits the user origin (receiver-rejected)`.
The channel admitted a host-verified human subscriber but declared message
publication code-only. Repair the human participant operations as one coherent
receiver contract, retaining participant ownership and provider-only settlement
checks. The E2E still requires an actual rendered transcript, and now observes a
visible terminal failure rather than waiting the full transcript polling budget.
No model response is required by this test. The failed run's Electron, owned
Xvfb, and temporary root were verified cleaned up; no native Quickfire pass is
claimed yet.


### Quickfire native acceptance and current regression follow-up (2026-09-08)

The repaired native run `quickfire-conversation-20260908-repaired` passed all four
selected existing command-overlay cases: typed prose reaches the actual channel
transcript, conversation exits appear, reopening resumes the same conversation,
and promotion opens that conversation in a ready chat panel. Results record four
expected, zero unexpected, zero skipped. Owned Electron, Xvfb, and temporary state
were verified removed. Channel receiver coverage passed 98 tests; the human
publication regression crosses actual receiver dispatch and verifies durable
message content, rather than replacing dispatch with a no-op. Host notification
contracts were committed in `32abd5a2b`; paired Base source changes remain pending
review/commit. This supersedes the earlier “no native Quickfire pass” status above,
not the remaining mobile-device or full-plan acceptance requirements.

The local-checkout template flag seals and validates visible worktree bytes, but
the standalone workspace migration retained acquisition without reconnecting
candidate discovery. The host now exposes sanitized exact snapshot reviews via
`hubControl.listTemplateCandidates`; desktop and mobile select those reviews and
create a new workspace using the existing exact root pin contract. No local path
is exposed, and an unpublished checkpoint must not be sent to remote Git for
inspection. Desktop settings hands off to the canonical workspace chooser rather
than duplicating creation. Host tests cover source changes after review (creation
still acquires the reviewed bytes), path-free candidate discovery, and existing hub
behavior. Native examples-checkout acceptance and the one-manifest migration are
still outstanding. The user explicitly requires no backward compatibility and
updated onboarding instructions/behavior.

The running desktop supplied two further regression families. Panel lifecycle
commit `867603061` (August 7, not the recent workspace migration) let a host view
report establish RPC reachability before the panel socket existed. Repair must
separate presented view, boot state, and authenticated route connection, including
waiter notifications and supervision. Separately, live logs contain a missing
`dist/panelPreload.cjs`: normal builds clean dist while existing desktops lazily
load preloads there. Exact missing-preload causation for the latest panel is not
yet proven. Do not call a readiness-only fix a blank-page fix, preserve individual
artifacts as a workaround, or mix live build generations. Preload errors also need
to terminate the exact panel attempt visibly.

Read-only inspection of the live semantic database established a compare/merge
failure involving sibling integration commits sharing a post-base application.
Comparison subtracted shared applications without regard to the selected base,
leaving an uncovered file-content transition. The integrity guard is correct;
repair history attribution and test the actual integration shape. These live
instances must remain untouched while isolated verification proceeds.

### Follow-up verification and onboarding handoff (2026-09-08)

Personal onboarding now links directly to the host workspace chooser. The skill
and getting-started recipe distinguish exact local checkout candidates from
optional, user-initiated registry browsing. Creating a workspace preserves the
Personal conversation. Base commit `9241a22` contains this change; 12 focused
onboarding tests pass.

Native Examples acceptance found that desktop creation only routed a server
connection without opening its retained client owner. The chooser now invokes
the same workspace-opening action as the sidebar, including authoritative catalog
refresh for a newly created ID, owner opening, routing, and focus. All failures
are presented by the owner and propagated to the chooser. Exact local pins use
the host's validated inspection instead of remote Git inspection. Component
coverage passed 21 tests before an additional catalog-failure case; the desktop
owner suite now passes 9 tests, and all userland type projections pass.

The isolated native replay `template-examples-checkout-20260908-r4` verified a
separate workspace, unchanged existing IDs, the exact reviewed root pin, and a
populated panel tree. Its final navigation assertion was hidden by the new
workspace's startup-unit review. The test now completes that visible review and
requires the new workspace to be focused; a full passing replay remains pending.

That replay subsequently passed as `template-examples-checkout-20260908-r5`.
The stronger `template-examples-checkout-20260908-r7` also waits for initial
`about/new` content in the actual panel WebContents, after native view creation.
Both checks passed and their owned processes exited. The captured host-page
screenshot does not composite the separate native panel view; panel content is
verified directly rather than inferred from that screenshot. Mobile exact-pin
handoffs now consult host candidates before remote inspection; its six focused
creation tests pass. Desktop discovery failure is terminal for a supplied pin,
so an unavailable candidate list cannot redirect a local checkpoint to remote
Git; seven chooser tests pass.

Distribution closure also omitted panel build-template dependencies because they
are not workspace package dependencies. It now includes explicit template
references and the supplied default template. Examples contains the three build
templates used by its panels. Six distribution tests and standalone Examples
inventory validation pass (1,387 files). This is distinct from the removal of
the second workspace source manifest: `meta/vibestudio.yml` is the sole manifest.

Panel connection/presentation and preload-failure repairs passed 173 focused
tests and host/workerd types. Immutable host artifact generations passed focused
tests and review, but their real build/runtime acceptance remains pending. No
running user instance was rebuilt, restarted, or modified for these checks.

### Cross-workspace RPC integration audit (2026-09-08)

The transport and policy components exist, but their passing tests do not prove
an application can make an admitted cross-workspace call. The current
`RpcServer` rejects every foreign destination in both `ws:rpc` and `ws:route`
before dispatch. `WorkspaceChildHubPort.forwardWorkspaceRpc`, the hub's
authenticated internal route, and receiver export/authority checks are available
building blocks; they must be connected through the existing dispatcher with
live caller and response ownership preserved. Do not create a second application
RPC API or remove the local addressing checks without the complete boundary.

Baseline verification passes 31 tests across policy, live access, framed
transport, and the build-time export catalog. Remaining acceptance must originate
in a real source workspace, traverse source and destination policy admission,
invoke the exact exported receiver under ordinary authority, and return its
result. Include denial before prompts, System ingress denial, existing context
selection, revocation, streams/cancellation, and caller-bound result delivery.
The accepted reviewed-receiver model applies; no per-invocation sandbox is
required or implied by this integration.


### Exact-source inspection and native acceptance follow-up (2026-09-08)

Desktop and mobile now reject a response whose exact pin differs from the
selected source, and withdraw stale review UI immediately when selection
changes. Eight TemplateBrowser tests and nine mobile WorkspaceCreateSheet tests
pass, including wrong-response rejection and prevention of creation from a stale
inspection. The current mobile product seed has been regenerated.

The dirty-checkout native replay reached the new workspace but exposed version
skew in the isolated test checkout: concurrently updated Base panel transport
imports the shared `bridgeTransport` export absent from that older Host copy.
A subsequent partial Host refresh exposed coupled principal-type changes during
infrastructure compilation. Neither run proves a product failure or current
native acceptance. Refresh the complete paired Host source before replaying;
do not keep adding individual dependency patches to the test environment.
The native test now waits for the panel's canonical ready-or-failed presentation
and reports a terminal failure directly before reading content. Whole-window
capture uses the BaseWindow's exact desktop source, rather than BrowserWindow
or the shell page underneath native panel views; capture acceptance is pending.


Panel presentation/authenticated runtime readiness is committed in Host
`3a1720c49`. The targeted ten-file change passed all normal commit gates,
including host/workerd type checks, dependency and authority boundaries, lint,
and formatting; 168 focused lifecycle tests passed before commit. The native
E2E launcher now selects the same canonical immutable desktop generation as
`pnpm dev`, preserving package identity and artifact lifetime. That harness
change belongs with immutable-generation work and remains uncommitted pending
native acceptance.


The complete refreshed Host/Base dirty-checkout native replay passed as
`template-dirty-checkout-20260908-r8` (47.7s test, 1.2m total), using the immutable
desktop generation. It proves an uncommitted source with an unreachable origin
can be reviewed and opened as a separate workspace with its exact pin, tree,
focus, and initial rendered panel. Native view diagnostics confirm the initial
panel is visible and topmost. Capturing that panel's own pixels before the
owning display produces a correct composite; prior display-only captures raced
compositor delivery despite readable DOM text and animation callbacks. The
captured New Panel still shows loading suggestions, so this run does not prove
catalog/history completion. The acceptance artifacts include both pixel captures
and native presentation state; owned test processes exited.


### Single-manifest commits and distribution validation (2026-09-08)

Host `9da7f83e7` commits the single source manifest, inventory validation,
source-path diagnostics, removal of generated-manifest repair, and build-template
closure. All normal commit gates passed; 66 focused parser, bootstrap,
distribution, and repository-exchange tests passed. Base `6aa7c82` moves its
source inventory to `meta/vibestudio.yml` and updates publication/migration
instructions; eight publication tests pass. Fresh generated Base, Personal,
and System roots each passed standalone boot/inventory validation. The authoring
Base checkout also contains reference-only upstream docs outside the distribution
inventory, so validation applies to its generated roots, not a claim that every
file in the authoring repository ships as a workspace.

Examples `53baa03` commits the same single manifest plus the default, Svelte,
and vanilla build templates. A clean temporary checkout of its complete staged
index passed standalone inventory and dependency-specifier validation. Unrelated
in-progress images/adventure source was deliberately not included; its visible
worktree edits remain intact. Temporary validation directories were removed.

### Workspace creation and onboarding integration (2026-09-08)

Host `191a79465` exposes sanitized exact local checkpoint candidates through host
discovery; 69 focused tests passed. Base `d4772a7` connects desktop and mobile
creation to those candidates, rejects mismatched inspection responses, and keeps
failed activation retryable without creating a second workspace. Desktop uses
the same retained-owner activation path for the sidebar, chooser, and settings.
A delayed catalog lookup cannot override a newer workspace selection; both its
success and failure races are covered. The desktop component suites passed
29 tests in total, mobile creation passed nine tests, and all three userland
typecheck projects passed after the final change.

Personal onboarding was updated in `9241a22`: its workspace action opens the
chooser while preserving the conversation. Templates create separate workspaces;
the onboarding agent no longer directs users to import them into Personal.
The 12 focused onboarding tests passed. Native local-checkout evidence is recorded
above; current mobile native acceptance and cross-workspace RPC native acceptance
remain pending and must not be inferred from component tests.

Android acceptance was restarted from an isolated Host/Base copy at
`/tmp/vibestudio-mobile-acceptance-wsX60f`. Its full Host build passed all 29
artifact contracts and its APK built and installed. The first native run failed
before pairing: the common source-mode pairing launcher built prerequisites but
omitted `VIBESTUDIO_HOST_ARTIFACT_ROOT` when spawning the server. The launcher now
selects the prepared source generation and retains that exact root across child
restarts. Packaged mode uses the shipped server's artifact directory without
loading source-only build machinery. Four launcher tests and six packaging tests
pass; the native replay is pending. The first run's owned emulator and server
exited. Separately, 17 mobile drawer/directory tests passed against current source.

The next Android replay exposed a native WebView construction crash: the newly
added website notification listener used invalid `http://*` / `https://*`
Android origin rules. Host `a55ec5bb0` uses the supported wildcard while keeping
the existing native main-frame, HTTP(S), and same-origin admission checks. All
normal commit gates passed. The subsequent native replay renders the Personal
chat host and approval sheet beyond the previous crash; full recovery acceptance
is still in progress. The smoke observer was also changed to report the app's
AndroidRuntime crash directly rather than waiting for missing lifecycle phases;
that observer change remains uncommitted.

The outstanding `templates-cached-catalog` exact agentic test passed in run
`st_ca380236343748dab95b3487ee9ae137`, with zero failed tool calls, after Base
`dfa9813` documented the API's null result and entries array. The prompt and
validators were unchanged. The preceding run correctly answered the question
but failed on a needless missing-path search; no runtime catalog defect was
found. Its managed instance was stopped. This closes the historical 50-name
slate (50 passing names), not a claim that all 50 were rerun at the current tree.

Android replay r3 completed with exit 0. It verified automatic Personal onboarding
(three completed assistant messages), a nonblank panel capture, workspace-owned
camera denial despite OS permission, System/Personal cookie isolation, retained
Personal panel focus, and cold-start/server-restart reconnection with zero panel
asset pipe misses. Its server, emulator, and inspectors were closed.

Functional acceptance exposed an unresolved performance failure: creating a System
New Panel stalled for approximately five minutes. Manifest retrieval was fast,
prewarming failed, and multiple panel initialization attempts expired before their
pending calls settled together. This is not acceptable activation performance.
A similar stall was observed earlier with repaired native Iroh artifacts; the
cancellation defect alone does not establish its cause. No timeout was increased.

The Android drawer capture also exposed a missing Chat icon. Inspection found that
manifest icon hydration lived only in Electron's orchestrator. It is now shared
by PanelManager, and the mobile drawer reads hydrated registry decoration as the
desktop does. The 127 manager/orchestrator tests, host/workerd type checks, and 16
mobile icon/drawer/forest tests pass. Native visual verification of this change
remains pending. Five existing onboarding suites were rechecked: 27 tests pass.

Android replay r4 (`/tmp/vibestudio-mobile-acceptance-wsX60f/smoke-icons-r4.log`)
completed with exit 0 after Host `e1acfc82b` and Base `544a51a`. The new drawer
capture visibly shows Chat's SVG glyph. All prior functional assertions passed,
including onboarding, native permission ownership, workspace cookies and focus,
app cold-start and server-restart recovery with zero panel-asset pipe misses.
System initialization completed in approximately 0.2–0.3 seconds this time; the
prior five-minute stall remains an intermittent unresolved issue, not a proven
performance fix. The server, emulator and inspector connections were closed;
`adb devices` was empty after the runner exited. All three userland typecheck
projects also passed. The migration passed normal Host commit gates.

Host `1cc623967` makes native smoke failures explicit: the log observer identifies
the tested Android package's crash, retains Java exception details, and rejects
stale success phases after app/pairing failure or adb spawn/signal termination.
The observer remains the runner's single phase source. Five behavioral tests and
all normal Host commit gates passed; no timeout was increased. The preceding r4
native replay exercised successful crash-aware observation. The extracted
observer's failure paths are covered by focused tests, not a new emulator run.

### Website agentic entry point audit (2026-09-08)

Current production code defines `WebsiteAuthorityFact` and stores/revokes website
subjects in `CapabilityGrantStore`, with focused authorization and acquisition
tests. A search of non-test production call sites finds no invocation of
`ensureWebsiteSubject` and no construction of a verified caller's `website` fact.
`browserPreload.ts` exposes autofill and website notifications only; the general
RPC preload is explicitly limited to app panels. These are absent end-to-end
website capabilities, not evidence that the website agent/tool requirement passes.

The remaining implementation must use the existing RPC and authority owners:
attest document/origin/workspace at the trusted browser host, bind and invalidate
that identity through document and connection lifecycle, carry its ceiling into
agent execution and later tools, and reuse normal bounded approvals. A page must
not supply its own trusted website fact. Verify one approved real effect, a denied
effect, document replacement, revocation, and queued agent/tool work in both client
hosts before marking this gate complete. Notification and camera acceptance remain
separate evidence and cannot substitute for this route.

Host `65ef77a16` closes the adjacent mutable-ref decoration cache bug inherited
from the former Electron-only hydrator. Cache lookup and response application now
include the panel's active build key, so rebuilding under the same `latest` ref
re-observes decoration and an out-of-order old result cannot overwrite the new
icon. No new metadata API or selector was added. The 128 focused panel tests and
all normal Host commit gates passed. Base `ace4c71` aligns mobile panel rows with
their tree indentation; its existing component test passes and a native visual
replay for that alignment change remains outstanding.

Website integration boundary findings: `ConnectionGrantService` already binds
browser runtime principals to their authenticated viewer, and external panels have
host-recorded `browser:` source URLs. Those facts can establish workspace, viewer,
and origin, but the runtime principal alone is not a document identifier:
`PanelRuntimeLeaseController.handleExternalDocumentCommitted` deliberately keeps
identity on same-URL reload. Do not change ordinary panel incarnation semantics to
manufacture a website permission boundary. Reuse a document-bound transport/session
with native retirement on navigation, destruction and connection loss. The existing
website notification bridge demonstrates native sender-frame attribution and
retirement before delayed effects; permission authority still belongs to the normal
server store and dispatcher.

Synchronous RPC already carries an `authorizingCaller` through live authority-parent
nonces. That is not proof for queued agents: the current task binding records
workspace/context/channel, and `ExecutionAdmissionFact` has no website initiator
binding. Agent ingress must capture the verified initiating document/subject binding
at the existing task admission boundary, and later tools must validate its lifetime
rather than resolving it anew from whichever page is currently in the panel. This
must be tested through delayed execution and same-URL document replacement before
website-to-agent calls can be exposed.

Independent bounded review of Host `e1acfc82b`, `65ef77a16`, `1cc623967` and Base
`544a51a`, `ace4c71` found no correctness issues. The reviewer checked per-workspace
manager/registry ownership, the registry-to-mobile-directory revision path, mutable
ref build invalidation and stale replies, and crash/reader-failure precedence in all
smoke phase waits. This review does not close native cross-workspace acceptance:
run6 was killed before readiness and never dispatched RPC. Its owned processes are
stopped; the atomic merge test has the next isolated runtime window.

### Acceptance reconciliation (2026-09-08, subsequent runs)

The atomic panel/store publication scenario passed in
`st_410258ff3404429e89d9ece1eec2df3c` with zero tool failures. Its validator
distinguishes a manifest's declared authority from the independently stored,
exact-version publication grant and verifies UI storage across reload/rebuild.
It does not exercise subagent merging. The separate existing
`subagent-diff-inspection` scenario passed in
`st_c2a8303ca33349d1b24676b7b0238b57`, also with zero tool failures. The managed
instance for both runs was stopped.

Base `3cc040a` adds `subagent-reviewed-merge` without replacing inspection-only
coverage. Its validator requires the exact terminal child event, a prior bounded
diff, and a later complete, concluded merge with zero remaining coordinates.
Five validator tests and all three userland typecheck projects pass; independent
review found no issues. Its agentic run remains outstanding, so the reported
subagent merge/compare integrity failure is not yet proven resolved.

Base `97ef6d3` updates onboarding, architecture, and workspace development
guidance to the implemented explicit-destination RPC contract and distinguishes
opening a template as a workspace from editing imported template source.
Independent review found no issues. Documentation is not native acceptance.

Native cross-workspace runs 7–9 stopped during fixture preparation before the
intended RPC call. The fixture is being corrected to create an authenticated
second workspace from reviewed exact source, with its full dependency closure.
Run 9 showed that a derived test checkout's local Git origin cannot be fed to
the HTTP(S) source-selection path; review facts must come from validation of the
already selected immutable fixture source. No production origin restriction was
relaxed. Each run's owned processes were cleaned up.

The first immutable-generation replay proved that publishing a later build
did not change the running main process's artifact root and that a new panel
entered the durable tree. It did not prove that the new panel rendered; that
claim was withdrawn. A strengthened replay now checks canonical content
readiness and rendered text. That strengthened replay passed as
`20260908T040749524Z-2767037-941a4b8f` (38.2s test, 1.1m total): the newly
created Help panel reached `contentReady`, rendered Help/About/Vibestudio text,
and main retained the original artifact root. The reviewer confirmed no owned
processes remained and the test's temporary root was removed. This proves the
specific immutable-generation/new-panel lifecycle, not unrelated panel failures
or the remaining cross-workspace RPC gate.

Host `02ac6071b` commits the compiler-artifact generation ownership change with
normal commit gates passing. Launchers retain the selected artifact root and
runtime loaders resolve through that root. The generation includes a symlink to
the checkout's installed `node_modules`; the proven guarantee concerns later
compiler builds, not arbitrary dependency installation while a process runs.
Generation disk retention and publication copy cost still need review as part
of the requested startup/resource investigation.

Base `406b9a8` commits the atomic publication validator and the system-test
runner's exact dependency-attributed authority requests. The passing atomic run
above used the full current shell source and its matching generated receipt.
The shell's `workspace.gateway.access` declaration remains uncommitted with
that shell source; it must be included in the coherent shell commit, without
attesting unrelated unstaged source in a staged seed receipt.

The broader runtime audit found an older stream routing bug: raw-response reads
without a native raw hook bypassed the normal native stream/upload selection.
Host `b10cccf4c` reuses the existing stream path; `8d6b0eb2f` adds the adjacent
bridge-upload regression. All 40 RPC client tests and normal commit gates pass,
with independent review finding no issues. This is not evidence that RPC client
disposal, website document lifetime, or native process cleanup is complete.

Cross-workspace discovery audit: the current native test addresses a known
receiver directly. `workerService`'s existing `listServices` and `resolveService`
are still local methods; the catalog returns local service rows rather than a
remote-disclosure-filtered projection. `resolveService` may activate a Durable
Object, so it is not a metadata-only discovery operation. Before declaring
cross-workspace integration complete, extend the existing catalog owner to
filter by deliberate receiver exposure and governing disclosure policy without
activation or approval prompts. The shared service-client cache must also bind
resolved targets to their selected workspace instead of treating a target ID
as globally unique. Do not expose the existing unfiltered catalog merely by
adding a method flag. Known-address call acceptance cannot substitute for this
remaining requirement.

Infrastructure-cache investigation: a test-only RPC edit invalidates the whole
package tree digest and its six-package build closure. A subsequent clean
`inspectInfrastructurePackageBuilds()` took 66 ms for 12 build packages and
reported no dirty packages. No filename-based exclusion was added: TypeScript
`exclude` removes root selection but does not prohibit imports of those files.
Any narrower cache input set must come from actual compiler dependencies, not
an assumption that `.test.ts` can never contribute to output. The current warm
scan is not evidence of a material startup bottleneck.


The complete existing onboarding suite passed on the current checkout: 47 tests
across eight files, including the SetupHub chooser, registry-bound selection,
capability routing, refresh, and visible failure behavior. It retains Personal's
onboarding conversation while templates create separate workspaces. Host
`882a123e1` unifies bodyless streaming responses (204/205/304); 50 focused RPC
and codec tests and the normal commit checks passed, with two independent
reviews finding no issues.

A subsequent RPC audit reproduced loss of evaluated execution admission when
`withExecutionAdmission(withCausalParent(rpc, parent), nonce)` is composed, as
used by automation tool dispatch in `agent-vessel.ts`. The causal wrapper's
object spread omitted the non-enumerable nonce. Both wrappers also returned the
unscoped base peer, bypassing their bound options for peer calls/events. Two
regressions failed before repair. The shared option-view/peer implementation now
preserves internal facts through either wrapper order, including explicit
workspace destinations. All 59 focused client, connectionless, and internal
option tests and Host/workerd types pass. Host `24e86fe1a` commits the repair;
normal commit checks pass and independent review found no issues.
The admission wrapper and production composition date to August 24 (Host
`44dbed45aa`, Base `36ea56bc`), rather than being demonstrated consequences of
the workspace split. This evidence identifies an automation effect-binding bug;
it does not establish the cause of every reported chat or panel failure.


Base `e6034fb` and `2891fa6` commit Quickfire's exact channel targets across
worker/core and desktop/mobile clients, plus notification/invite propagation,
the Shell gateway declaration, and the reviewed install-row alignment. App seed
receipts were generated from the exact staged source projection; working-tree
receipts were regenerated separately for the remaining unstaged changes.

The first actual `subagent-reviewed-merge` run exposed a separate lifecycle
hole: a child completed successfully with dirty semantic work, so settlement
had no committed source event to merge. The implementation now rejects only
successful completion with uncommitted child work before writing the terminal
wake/fence; clean observation-only and failed/cancelled outcomes retain their
existing semantics. A regression verifies that the same child can commit then
complete with its exact source event. All 141 chat-op tests and all three
userland typecheck projections pass; root review found no issue. Fresh agentic
replay remains required before claiming this scenario passes. This is distinct
from the original compare/merge coverage-integrity error, which still requires
its own decisive evidence.


Native receive-cancellation evidence is now operation-level rather than an
unexplained test timeout. In the retained stock Iroh 1.1.0 trace, `readExact(1)`
was pending, `stop(33)` remained pending through a 500 ms observation, and a
controlled peer byte then released both. The exact patched artifact instead
settled stop and rejected the pending read with `stream locally stopped` in
approximately 0.3 ms, without the peer byte. Both experiments closed their
owned connections/endpoints. This demonstrates the specific read/stop
serialization defect and its patched behavior; it does not prove that this is
the sole cause of every intermittent mobile activation stall. Retained native
regression coverage and production release artifacts/pins remain outstanding.

Base `ddc5067` removes two remaining stale skill claims: mobile test tooling is
workspace source rather than a template installed into an existing workspace,
and explicit application RPC is distinct from selected source transfer rather
than blanket-closed. Native run14 completed its exact peer creation approval;
its subsequent navigation assertion failed because Radix's modal hides
background controls from accessibility queries. The screenshot already showed
the peer active in the title bar. There is no evidence that activation waits on
the global approval queue. The fixture now clears only exact initial-workspace
unit reviews before interacting with Settings; run15 is the next acceptance
attempt, not yet a reported pass.


2026-09-08 follow-up: native run17 confirmed that ordinary project fixtures
now derive the minimal Base source rather than accidentally inheriting System
programs. It still failed before the cross-workspace call: a visible unit review
hid the navigation control, and retained artifacts did not identify whether this
was the original creation review or a subsequent admission. The isolated helper
now observes the exact creation review state after its click. That distinction
must be established before changing approval behavior. Run17 is terminal and
its owned processes and temporary state were cleaned; native acceptance is not
claimed.

Base `4e55e98` removes the duplicate panel-handle runtime and mutable module
initialization bridge. Parent access, exported panel operations and error-debug
chats now share one factory-owned runtime. Native/RPC child-event listeners are
removed on destruction, and destroyed factories reject new subscriptions.
All existing handle tests were preserved; 36 focused tests passed, including
new cross-runtime isolation and cleanup tests, and all three userland type
projections passed. Independent review found no correctness issues. Desktop
host-command contributions still need owner-driven cleanup on document
retirement; React unmount alone is not adequate crash/navigation evidence.


2026-09-08 current follow-up evidence: Base `8503f0b` removes the unused
panel credential singleton/export while retaining its OAuth behavior test on
the shared factory; 8 credential and 16 hosted-runtime tests passed. Base
`1e68215` aligns onboarding Devices wording and the cached-template comment.
Host `32832b8b5` fixes notification retirement on same-document navigation;
18 notification tests, Host/workerd types and all normal commit hooks passed,
with independent review. None of these changes establishes website RPC
admission acceptance.

Base `7f79606` is the authoritative clean-child-completion commit. The exact
reviewed-merge test functionally passed twice, but strict runs remained failed
because the model supplied inspect limit 200 despite the published maximum
100, then corrected it. An explicit Luna diagnostic is pending; limits and
prompts were not loosened. Automation run
`st_a294fbcb82b9469fbebddd3dbcc3bc10` observed a second incomplete turn and
remains a lifecycle investigation, not a proven validator timing defect.
The r2 managed instance was stopped and its owned state cleaned.

2026-09-08 template checkout follow-up: `--workspace-checkout PATH` now
uses the existing exact development checkpoint and ordinary startup creation
intent to open a target as an additional workspace. Personal/System default
pins remain separate. Startup identity incorporates the exact source pin,
so a changed checkout does not silently reopen an older persistent workspace.
The desktop launch explicitly requests creation when missing. Base write-back
selects the root user's System workspace, never an arbitrary bootstrap project.
The parser/environment/hub checks passed 68 tests; the existing exact-checkpoint
suite passed 3 tests. Isolated native launch acceptance and template runtime
verification remain in progress. Examples, Google, News, and Spectrolite are
being audited; the latter three still contain obsolete Base copies and duplicate
manifest files that must be removed during migration. Authored local app edits
must be preserved. No compatibility format is being added.

The explicit Luna merge diagnostic `st_1a87ae262ad047279a0f9c375977f362`
completed with zero tool failures and a clean generic VCS compare/merge path,
but failed the dedicated subagent inspection validator because it did not use
`inspect_subagent`/`merge_subagent`. This does not establish dedicated-contract
acceptance. Its owned managed instance was stopped.

2026-09-08 checkout migration execution: root applied canonical minimal Base
source to Examples, Google, News, and Spectrolite. All four inventory validators
passed. App-owned directories were hashed before/after replacement and unchanged
(22 Examples, 5 Google, 3 News, 2 Spectrolite repositories). Examples intentionally
retains optional Svelte/scaffold/image units. The single manifest is now
`meta/vibestudio.yml`; the three obsolete `meta/template.yml` files are removed.
Exact second projection is `/tmp/vibestudio-template-migration-root-ajDNb9`,
Base commit `3758a8cc3bd4688be136b83eb3944554236da8c8`; original backups are in
`/tmp/vibestudio-template-migration-root-9CUd79/backups`. Application preserves
current authored app edits; subsequent explicit website receiver declarations
were added to Example game/sample workers and Google Gmail worker as required
by the current Host contract. These receivers remain for installed workspace
applications and agents.

The distributed tests had referenced an undeclared `tests/helpers/ledgerTest.ts`.
That trivial wrapper is removed from Base, with the exact same `ledger:*` test
names expressed directly through `it`. All 8 affected evidence tests pass.
`type-check-userland.ts` retains mandatory root checking and runs the existing
client integration configs where present (the full Base authoring checkout
still has all three). App-only workspaces no longer fail for nonexistent client
integration projects. Google app suites pass 118 tests in 17 files. Examples
currently has 28 passing/30 failing tests across 11 files; the main failures are
Host's newly mandatory receiver exposure-policy argument missing in the older
captured shared runtime, not yet a passing migrated runtime. A newer canonical
Base refresh is required after those concurrent source changes, followed by
focused reruns. News/Spectrolite app checks remain outstanding.

Actual isolated `pnpm dev --workspace-checkout` launch passed before the latest
refresh: Personal/System/Examples appeared separately, exact target source review
was resolved, about/new connected and the Examples catalog rendered. Screenshot
`/tmp/workspace-checkout-final-ui.png`. Its shutdown exposed orphaned descendants;
only that instance's processes/state were cleaned. A proposed supervisor repair
passed one native close and five tests, but root review rejected its permanent
100ms process-table polling and stale bare-PGID retention. It remains uncommitted
and must be replaced with sound process lifetime ownership, not counted complete.

Template migration verification, 2026-09-08 (continued):

- Refreshed all four templates from the exact captured minimal Base at
  `/tmp/vibestudio-template-migration-root-w9jkDj`; retained Examples' four
  intentional optional Base repositories and all app-owned source. Overwritten
  shared source has per-template backups beneath that capture. The subsequent
  canonical `sanitizePlacementHint` import move was copied to the same shared
  runtime file in each template after verifying it still matched the capture.
- All four root template inventories/dependency specifiers and RPC contracts
  pass. Full semantic-projection typechecks passed for Examples, Google, News
  and Spectrolite. Logs: `/tmp/template-{examples,google,news}-types-r3.log` and
  `/tmp/template-spectrolite-types-r4.log`.
- Google: 118 app tests passed. News: 82 app tests plus its repaired bootstrap
  test passed. Spectrolite: 109 tests plus 11 DOM tests passed. News and
  Spectrolite declared the missing testing-library DOM peer dependency; the
  News hook-order test now mocks only the React hooks it actually substitutes,
  avoiding accidental evaluation of unrelated image runtime components.
- Examples: all 58 conventional tests passed after the canonical runtime
  refresh. Two additional suites declare Workerd and import test-runtime; their
  Vitest collection failure was a runner mismatch, not permission to rewrite
  them. Running those through the actual workspace test runtime remains required.
- Native launcher screenshot was visually reviewed: all three workspaces and
  target app catalog render. The target display name still exposes its snapshot
  suffix; this is usable but warrants later display-name refinement.
- Shutdown review required explicit acknowledgement rejection/disconnect and
  newly spawned child cleanup. The revised identity-registration implementation
  is undergoing a new isolated native proof; do not count cleanup accepted yet.
- Spectrolite channel bootstrap integration and runtime acceptance across all
  templates remain outstanding. These results do not complete the overall plan.

Further verification and landed changes:

- Host `d2ddb9876` commits the exact-checkout additional-workspace developer
  launcher, its conflict/product guards, and System writeback ownership. Full
  normal commit gates passed (including host/workerd types, lint and format).
- Spectrolite bootstrap now reads participants through its retained connected
  PubSub client; independent contextless resolution was removed. Six focused
  bootstrap/controller tests and the final template typecheck pass. The Base
  participant regression proves the exact DO target is used without new service
  resolution; that test was copied to all four distributions.
- Explicit dev-runner child identity ownership passed normal shutdown and a
  forced Electron SIGKILL in isolated native instances. Both checks found no
  surviving owned processes, registry entries or temporary state. The agent is
  now exercising Examples' two declared Workerd test suites on an owned instance.
- Runtime API generated documentation was refreshed in Base and all templates.
  Host CLI generated API documentation and product seed records were refreshed
  to match current source. Formatter-only changes were applied to the 42 current
  source files flagged by the repository gate; they are outside launcher commit.

Template migration commits:

- Google `b56852f`: standalone Base refresh and Gmail receiver policy.
- News `14b3417`: shared Base refresh; `2a33ac0`: bootstrap test dependency/mock fix.
- Spectrolite `d178e72`: shared Base refresh; `4d86eb2`: connected channel query and DOM test dependency.
- Examples `62c91bc`: shared Base refresh; `a17f46b`: game/sample receiver declarations and template contract test. Concurrent adventure app edits were preserved and kept outside these commits.
- The Host standalone typecheck-tool commit remains uncommitted: its normal hook
  later encountered the concurrently edited websiteDocuments missing
  `connectionConsentCurrent`. No hook bypass or unrelated website repair was
  introduced to force this commit through.

Latest bounded follow-up:

- Base `7fa06a7` preserves the eight ledger evidence test names while removing
  their undistributed helper; `f4c79cd` commits the exact connected-channel
  participant API and regression. Root reviewed both commit file lists.
- Examples `9da4da6` carries the canonical template skill, retaining catalog
  invocation guidance; its contract test passes. Latest concurrently edited
  adventure world/evaluation suites pass 28 tests (18 + 10).
- App-owned string-RPC audit found no further production contextless channel
  discovery or obsolete template import calls. Remaining resolveService strings
  are test harness branches; Gmail's existing-object lookup remains deliberate.
- The typecheck-tool commit is still pending normal repository hooks: current
  external edits repeatedly change generated CLI docs and shell seed hashes.
  The successfully committed launcher already passed the full hook suite; these
  later failures must not be reported as a launcher verification failure or
  bypassed to force another commit.

Runtime acceptance currently in progress:

- News and Spectrolite manifests now start `panels/news` and
  `panels/spectrolite` respectively; both inventories validated. News native
  checks passed exact checkout review, separate workspace creation, panel
  mounting, and rendered branded content for both apps; owned cleanup completed.
  Root visual review found News still connecting and Spectrolite still scanning,
  so functional initialization is not yet proven. Follow-up checks must await
  usable controls or a settled empty/list state. News commit `98a0781` records
  its initial panel; Spectrolite's initial-panel commit remains pending.
- Examples' declared Workerd suites passed in the owned r4 instance: world
  16/16 and campaigns 17/17. That instance is stopped and cleaned up. These
  results precede the latest RPC receiver contract; current-contract replay
  remains required, and r5 did not register an instance because the concurrent
  website/RPC migration did not yet build coherently.
- Package-owned test suites exposed two generic artifact defects: runtime was
  incorrectly constrained by source unit kind, and execution metadata retained
  package kind. Both are repaired with worker/package and browser/package
  coverage. Generated test registration now uses a typed `exposeTestRunner`
  helper rather than embedding an unchecked RPC contract in generated source.
- Fresh native startup exposed React dependencies in core template management.
  The UI adapter has moved to the existing `@workspace/react/templates` entry;
  core template management is React-free. UI consumers retain mandatory React
  peer checks. Focused UI/core tests (9) and dependency audit tests (8) pass.
- The recovered native cross-workspace RPC scenario exercises both a permitted
  call and denial after outgoing policy removal, but has no passing current
  native result yet. Its generated fixture must follow current receiver and
  panel mounting contracts. It is not evidence for the full multi-user,
  streaming, or revocation acceptance matrix.
- A 51-name agentic slate is selected under
  `/tmp/agentic-slate-selected-20260908.txt`. Source selection is preparation,
  not passing evidence; managed doctor, catalog confirmation, runs, failure
  inspection, and owned-instance cleanup remain required.
- Native work uses isolated consistent snapshots. No original Host full-build
  or user-instance restart is authorized by this test work.


Native cancellation regression (2026-09-08):

- `packages/iroh-transport/src/nodeFixture.test.ts` now retains the pending-read
  cancellation regression: a peer sends no response data, local receive stop
  must settle and reject the pending read, and the peer must receive STOP_SENDING.
- The exact test fails against the currently installed production 1.1.0 binding:
  `/tmp/iroh-pending-read-regression-current.log`, bounded cancellation observation
  expires at 5 seconds. This is a test failure guard, not a runtime timeout fix.
- The same test passes against the reproducibly repaired Linux native artifact
  using the upstream loader's test override:
  `/tmp/iroh-pending-read-regression-patched.log`. Both test processes terminated
  and their fixture cleanup closed owned connections/endpoints.
- Production platform dependency release/pins remain incomplete; the passing
  override is not production acceptance and does not establish the Android
  activation stall's root cause. Do not suppress this regression or relabel the
  current production binding as passing.


Latest retained verification:

- The full native Node transport fixture passes 11/11 against the reproducibly
  repaired Linux artifact (`/tmp/iroh-native-fixture-patched-current.log`),
  including the new pending receive cancellation regression. This does not
  change the production failure recorded above.
- Base `9f437c9` commits the typed test-runner helper and its behavioral test.
  Root reviewed the exact three-file diff; current-contract native replay is
  still required independently of the helper's two passing focused tests.
- The user reproduced `desktopEvents.watch: Unknown service` during ordinary
  `pnpm dev` in the main checkout. Investigation now covers default startup
  native-service readiness and shell transport workspace identity. Existing
  EventsClient retry behavior is present; adding retries would not repair
  incorrect ownership or premature readiness. Verification must use the default
  dev path in an owned isolated copy, without restarting the user's app.


Desktop navigation and steady-state event follow-up (2026-09-08):

- The reported `vibestudio://surface?v=1&kind=workspace-chooser` failure was
  reproduced at the desktop PanelView classification boundary: installed-panel
  navigation handled panel locations but omitted shell surfaces. PanelView now
  uses the shared shell-surface parser and delegates through the originating
  workspace's existing surface callback. Both in-place links and new-window
  links are covered; ordinary website popups remain outside this installed-panel
  path. Mobile already routes these links through the same shared parser.
- PanelView/window focused tests pass 32/32; the additional workspace callback
  ownership check passes within the eight window-controller tests. Native
  onboarding-link acceptance remains pending.
- The user reports `desktopEvents.watch` errors persist well after startup. The
  premature ready-promise publication is a demonstrated defect introduced in
  Host `4fee76409`, but fixing that defect alone is not yet a sufficient causal
  explanation or verified repair of the persistent error. The native steady-state
  stream route and before/after startup timing remain required acceptance.
- Typed test-runtime copies were byte-compared to Base `9f437c9` and committed
  separately: Examples `5eeeac0`, Google `053ebcd`, News `1078976`, Spectrolite
  `5523f5f`.
- News's empty Inbox now has an actual Add a source button opening the existing
  settings dialog, disabled until reader state is available. Its focused
  typecheck passes; final frozen native interaction/screenshot remains pending.

Persistent event-routing cause and repair scope (2026-09-08):

- The System compositor's UI stream relay introduced in Host `b445eda44`
  forwarded streams to the server without checking the owning native dispatcher.
  Base's retained shell session stream bridge (`0d801e2`) exercises that route.
  `desktopEvents` belongs to the native runtime, so retries continue reaching
  the wrong receiver even after startup completes. This is separate from the
  premature readiness publication above.
- Repair both UI and installed-panel stream entry points through the same local
  dispatcher operation, preserving caller identity, authority, cancellation,
  workspace ownership, and the existing remote route. Check document retirement
  again after awaiting runtime readiness. Do not add startup sleeps or another
  event subscription channel. Native steady-state delivery and measured startup
  remain pending acceptance.
- Base `9241a22` changed onboarding to emit the chooser link without adding the
  desktop panel navigation consumer. This was an integration omission, not an
  intentional permission change. The current desktop link tests pass 32/32 on
  the working source; verify the onboarding click against the native compositor.

Onboarding selection contract regression (2026-09-08):

- Base `1461b9a` changed SetupHub's template action to `create-workspace`, while
  the independent routing helper and resolver retained `add`. Separate producer
  and resolver tests passed without exercising their connection. The user's
  exact Examples payload consequently failed before template review.
- Base `93389a3` uses the existing typed interaction constructors in SetupHub
  and makes workspace creation the sole template action. The existing UI test
  now feeds the emitted button metadata into the real resolver. All 21 focused
  onboarding UI, routing, and skill-contract tests pass. No legacy action alias
  is accepted. Native workspace creation acceptance remains outstanding.
- The same report shows `client_eval` guest failure recorded as terminal success.
  Its returned `details.success` is opaque to the advertised-method executor;
  explicit structured error result propagation is being repaired independently.

Current verification follow-up:

- Base `297d612` adds explicit final-result metadata to the existing advertised
  method execution context and uses it for client-eval failures. Structured
  failure details survive without interpreting arbitrary user payload shapes.
  All 62 focused client-eval/RPC-client tests and all three Base type projections
  pass. The audit found other advertised UI methods with the same reporting gap;
  their migration is still in progress.
- The fresh owned desktop pair at
  `/tmp/vibestudio-desktop-events-current-pair` demonstrates actual approval
  event delivery after startup: the queue progresses across System, Personal,
  and credential approvals, and both workspace counters update. Root inspected
  `/tmp/desktop-events-native-approved.png`. No `desktopEvents` unknown-service
  errors were observed. Chooser interaction and owned cleanup are still pending.
- This native run measured 29.68 seconds total, with 29.12 seconds hub startup,
  85 ms post-connect, and 428 ms desktop mount. These are measured spans, not a
  controlled before/after comparison or evidence of a performance improvement.
- The paused agentic slate scheduler and its exact managed instance have been
  stopped and their process census is empty. The retained ledger still has four
  passing tests and a binary-input failure; the append-file hang has separate
  captured evidence. Callback lifecycle repair and fresh-instance replay remain
  necessary before resuming the remaining slate.

- The real-database cross-workspace access regression now exercises Alice and
  Bob through one retained read-only identity connection: one-sided policy
  denial, Alice's permitted Personal access, denial for Bob, and immediate
  policy/membership revocation. Access plus private-workspace suites pass 10
  tests. This strengthens server integration evidence but does not substitute
  for the required native two-user stream/reconnect scenarios.
- Base `489bb1b` extends explicit failure reporting to the remaining browser and
  headless advertised methods; `890925c` retains successful attachment-result
  coverage for the shared method boundary. Focused tests and Base types pass.

- Host `5a4a4b52c` commits the real-identity-reader regression. Its normal full
  commit checks pass, including generated contracts, dependency boundaries,
  Host/workerd types, lint, and formatting.
- Base `9601353` repairs the caller side of the gated template metadata contract
  from `f93dc5b`: chat, Workspaces, desktop, and mobile request the two capability
  families on the exact templates receiver. Eight real-evaluator consumer cases
  plus three chat authority tests pass; all Base type projections and independent
  review pass. Native catalog approval/loading remains a separate open check.
- Repaired agentic `append-file` passes as
  `st_470cc0e5c3bb457db6a38a64907f69bc`. Subsequent directory, file-stat, rename/copy,
  removal, and symlink cases pass. The ledger currently records 10 passing names
  and one earlier binary-input failure; the 51-name slate is not complete.
- Root visual review of the settled News capture found horizontal overflow from
  full-width content/header boxes plus padding. Their shared style now uses
  border-box sizing. Final native capture must verify the correction; the prior
  screenshot proves the defect, not the repaired result.
