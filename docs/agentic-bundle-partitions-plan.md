# Agentic bundles and self-contained workspaces

> Isolation planning (2026-09-06): [Native execution and isolation](isolation-plan.md) is canonical for platform execution, trust assumptions and release acceptance. This document owns product and RPC protocol requirements, including workspace ownership, Base extraction, template simplification and website behavior. Its application authority rules do not establish stronger native containment than the platform contract.

Status: implementation in progress, 2026-09-07. The user accepted rules 1–5 below.
The full runtime, cross-workspace integration, client UX, and verification work is
not complete. The existing filename remains so hand-off links continue to work.

Latest regression audit (September 7): evaluate failures against the user's working
workflow, then inspect every caller of the owning mechanism. A successful build or
an agent's completion message does not prove that a panel can use its backing service.
The current catalog has no scenario that jointly creates a panel, its store and service
declaration, publishes them, and drives a persistent UI effect without unexpected
approval. Add that exact acceptance case; separate service and app-building tests do
not close this gap. The reported task-board panel contains the exact declared store
request. The owning defect was confirmed: candidate publication used the live capability
presentation resolver, which could not describe a service introduced by the same
transaction. Host `9ed904d35`, `38fb3ace0` and `2d11204b9` carry exact candidate
service facts through review rendering and grant issuance, including direct requests
without a protocol. Missing dynamic services remain explicit negative facts; actual
product services come from the generated builtin catalog. The UI-to-grant regression
passes (18 tests), as does the subsequent candidate classification coverage (52).
The atomic generated-app acceptance case remains required.

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
The sweep's owned instance remains active; final cleanup is required.

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
native acceptance of this change remains outstanding. Mobile has no website
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

| Checkout | Commits | Scope |
| --- | --- | --- |
| Host | `f5286e222`, `2c80d8dc0` | Native build containment, ownership/identity, standalone bootstrap and authority. |
| Host | `b445eda44`, `18c72ed69` | Desktop and mobile native clients. |
| Host | `15b8decc5` | Request lifecycle and reproducible native cancellation repair inputs; production binding unchanged. |
| Host | `40e4c054b`, `7113aefc8`, `8a4641d52` | Exact private-workspace smoke label, native QUIC path diagnostics and current mobile readiness detection. |
| Host | `6555a57`, `b8bcfc93f`, `367149dca` | Shared streamed gateway contract, authoritative lease outcome versions and verified native view authority. |
| Host | `57657347d`, `ffd8e0c70` | One native IPC stream listener with independent response lifetimes; native pairing smoke with settled workspace focus and complete cleanup. |
| Host | `3dfa1f2f2`, `4c6bd9484` | Shared approval selection, exact pending source reviews, account-only development startup, durable initial panels, viewer-bound panel grants and reconnect fixes. |
| Host | `179bdcf73` | Canonical panel IDs for distribution seeds, verified through real runtime lease acquisition. |
| Host | `4fee76409`, `257594f01` | Common desktop workspace runtime, scoped events and native ownership, with document-owned website notifications. |
| Host | `01cd923ac`, `f3d00c40d` | Preserve typed connection loss across carriers; capture exact runtime owners for native navigation, readiness, attention and the shared desktop test API. |
| Host | `8b1f26ed7` | Restore automatic Personal onboarding requirements in existing template, desktop startup and mobile smoke tests; derive exact per-workspace fixtures and retain separate New Panel coverage. Desktop automatic startup is verified; Android and remaining recovery journeys are outstanding. |
| Host | `ed5af7f93` | Canonical Iroh close error identity and strict visible-Personal onboarding screenshot assertion; native replay outstanding. |
| Host | `6004aac5d`, `f03136c0c`, `f9d7611ea`, `070dabc7d` | Retain existing workspace-owned E2E journeys, align native test actions with admitted chrome, and preserve interactive identity in panel authority. |
| Base | `1461b9a`, `391cc98` | Standalone source inventories, retained source integration and System-test ownership. |
| Base | `0d801e2`, `731f20f`, `08ecf0e` | Desktop and mobile workspace UI, including persistent mobile Settings navigation. |
| Base | `c572456`, `5dbcd61` | Workspace-owned desktop imagery/focus and mobile retained-view lease lifetime. |
| Base | `c88bc3b` | Shared approval presentation and visible notifications across workspaces, compact desktop navigation, full panel viewport, and server-owned initial panel consumption. |
| Base | `faf70e2` | Workspace-owned command execution and connected-session effects on desktop and mobile. |
| Base | `cfe498d`, `23cd6cd`, `6c6c7b0` | Restored Personal onboarding and its local setup dependencies; real opening-tool execution in deterministic E2E; shared client recovery ownership and scoped native navigation. |
| Base | `4a8d3d6`, `1a88c51` | Share hydrated model history and advertised schemas with deterministic inference; existing automatic-onboarding E2E passes with the rendered setup overview. |
| Base | `3da9db9`, `4d02f94`, `b571799` | Keep toast actions clear of navigation; preserve import error identity and deliver the existing panel recovery signal on mobile. Native replay outstanding. |
| Base | `de377ae`, `cdaf3f1`, `e73496f` | Mobile app-info contract and inline-source recovery on channel reconnection; native replay outstanding. |
| Base | `7746210`, `946c56d` | Explain separate workspace creation in onboarding and include local Help in Base and Personal. |
| Host / Base | `0322ca4ed` / `6bfd508` | Website approval requester identity from verified origin and native globe presentation. |
| Examples / Google | `662dc22` / `30e8d16` | Complete standalone source snapshots. |
| News / Spectrolite | `74200f3` / `2b48cc2` | Complete standalone source snapshots; unrelated local edits preserved. |

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

| Retain and simplify | Remove or disentangle |
| --- | --- |
| Normalized upstream URLs, exact commit/snapshot pins, safe names/descriptions | Treating a template name, ancestry or manifest as execution authority |
| Exact source acquisition and workspace creation from snapshots | Installing unrelated applications as composed layers in an existing workspace |
| Source provenance and baselines used by ordinary explicit compare/merge | Composition graphs, precedence, contribution ownership and automatic recomposition |
| Manifests, APIs, CLI/UI and tests serving those retained responsibilities | Entry points and generated metadata whose only purpose is removed composition behavior |

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

| Area | Starting point and implication |
| --- | --- |
| Workspaces | [hubServer.ts](../src/server/hubServer.ts) already tracks workspace identity, membership, and child runtimes. Reuse this container and route several workspaces to the same client. |
| Client selection | [appHost.ts](../src/server/appHost.ts) resolves workspace `hostTargets`. Restrict client-app activation to the admitted System source instead of accepting client ownership from whichever workspace is selected. |
| System-page namespace | [aboutNamespace.ts](../packages/workspace-contracts/src/aboutNamespace.ts) currently describes path-derived privilege for `about/*`; [runtimeResourceBindings.ts](../src/server/services/runtimeResourceBindings.ts) consumes it. Replace path-based privilege with ordinary navigation to a local page, verified caller identity and explicit operation authority; no page-role registry is required. |
| Contexts | [runtime.ts](../packages/service-schemas/src/runtime.ts) defines context creation and cloning. Base's semantic store has a workspace-local main; contexts branch within it. An unrelated bundle needs fresh workspace creation, not a personal-context fork. |
| Template identity and acquisition | [templateCoordinates.ts](../packages/workspace/src/templateCoordinates.ts) supplies normalized identities; [acquireRootTemplateSnapshot.ts](../src/server/acquireRootTemplateSnapshot.ts) acquires exact immutable snapshots. Retain these mechanisms and useful names/contracts for upstream templates. |
| Root creation and relationship state | [rootTemplate.ts](../packages/workspace/src/rootTemplate.ts) prepares a standalone source snapshot. Composer relationship state and `templateState.ts` have been removed; exact upstream identity and ordinary semantic source baselines remain. |
| External Base | [External Base cutover](external-base-cutover-and-self-development-plan.md) records host/Base separation and source acquisition. Preserve the useful source boundary, not the template composition system. |
| Semantic integration | Base's `workers/workspace-source` owns semantic operations; [workspaceVcs.ts](../src/server/vcsHost/workspaceVcs.ts) supplies host projections/publication. Inventory and reuse actual copy/compare/merge behavior. Do not make new selective-history merge machinery a prerequisite for source adoption. |
| Panel ownership | [treeIndex.ts](../packages/shared/src/panel/treeIndex.ts) and [workspaceStateService.ts](../src/server/services/workspaceStateService.ts) retain user-owned root groups. Stacked sections preserve these and hub membership filtering. |
| Browser storage | [contextIdToPartition.ts](../packages/shared/src/contextIdToPartition.ts) maps contexts to Electron session partitions. Electron terminology is an implementation detail; preserve required browser/context isolation. |
| Authority | [authority.ts](../packages/rpc/src/authority.ts) and [contextBoundary.ts](../src/server/services/contextBoundary.ts) carry current identity and boundary rules. Workspace location, tree placement, or source equality must not become implicit website authority. |
| Context-aware RPC reuse | [runtime.ts](../packages/service-schemas/src/runtime.ts) binds entity context/source identity; [runtimeService.ts](../src/server/services/runtimeService.ts) preserves those bindings; [rpcServer.ts](../src/server/rpcServer.ts) dispatches existing targets and explicitly permits supported cross-context DO calls. Extend workspace qualification and authority around that routing, with no main-only restriction. |
| RPC and provider capabilities | [rpcServer.ts](../src/server/rpcServer.ts) and [workspace-owned capabilities](permission-system.md#workspace-owned-capabilities) are starting points for dispatch and protected provider methods. Extend their identity, routing and authority path; do not add a second integration bus or permission engine. Existing local handles are not portable across workspaces. |
| Retention | [Execution retention](runtime-foundations/execution-retention.md) records owned artifact lifetimes. Shared immutable objects remain readable only through authorized owned references. |

The configured development Base at inspection was
`/home/werg/vibestudio-release-work/base`. Resolve the current selection through the
repository's development configuration; this path is not a portable dependency.
Inspect its `meta/template.yml`, `meta/vibestudio.yml`, `workers/workspace-source`,
agent harness/resource loader, shell/mobile clients, and template-composer packages.

Preserve existing membership, provenance, authority, and residency responsibilities.
Product orchestration remains replaceable userland code where appropriate; enforcement
belongs below the untrusted code. The canonical isolation plan owns that implementation.

## 4. Personal, System, Base, and about-page contracts

### Three default distributions; a private Personal/System pair per user

A distribution is a ready-to-create workspace snapshot. The three default distributions
are self-contained, with ordinary source ancestry; there is no
composition DAG, installed contribution state, or live Base dependency. Retained template
identity/acquisition describes their upstream source without composing runtime layers. A collaboration-oriented distribution may be added later as
another ordinary snapshot, not another execution or permission model.

| Distribution | Purpose | Presence in the default environment |
| --- | --- | --- |
| Personal | The user's normal home/root workspace: personal agent, collections, browsing/personal workflows, and ordinary projects. Includes the minimal common source it needs. | One per user on the selected server/hub, ensured by the client. Exclusively owned by that user; workspace sharing and additional members are prohibited. |
| System | Client applications and system-relevant functionality: desktop/mobile/system CLI, device/environment management, and most host-known management pages. Includes its own required runtime source. | One per user on the selected server/hub, ensured by installed bootstrap/client startup. Exclusively owned by that user; sharing and additional members are prohibited. |
| Base | The stripped-down common agentic source and required workspace-local page implementations, suitable for deriving an ordinary app workspace. | Available as an exact source snapshot/upstream. No running Base workspace is required; authoring it may create an ordinary workspace deliberately. |

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

| Page or command | Panel and source workspace | Resource behavior |
| --- | --- | --- |
| New (`about/new`) | Current workspace; minimal implementation supplied by Base | Lists and launches content locally. Personal may have a richer local implementation. |
| Help, shortcuts, product about, device/system management | Acting user's System | Open/focus a System panel. Device/account/host effects require their normal authorization. |
| Permissions and credential management | Acting user's System | Explicitly select the workspace/account being managed, initially the initiating workspace where appropriate. Approval remains host-controlled. |
| Workspace files/history and local diagnostics | Current workspace | Inspect local resources under ordinary access checks. Distinct system-management roles open in System. |
| Browser history, bookmarks, downloads and personal import UI | Acting user's Personal | Open/focus Personal panels; device-level operations retain protected host checks. |
| Collections and app-specific about pages | Owning workspace | Ordinary local content and authority. |

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

| Responsibility | Owner |
| --- | --- |
| Essential agent harness, local source/runtime tools, common protocols, and essential instructions | Minimal Base source, included in each app's distributable workspace closure. |
| Desktop/mobile clients, provisioning, system settings, environment management, and System-owned about pages | Acting user's designated System workspace; shared host administration retains separate operator authority. Never inherited by every app workspace. |
| Personal browsing/import workflows, collections, ordinary projects, and personal assistant memory | Personal distribution/workspace; device-level effects use the existing bounded System/native mechanisms. Other app workspaces receive only deliberately disclosed resources. |
| Development, diagnostics, onboarding, and optional product features | Their appropriate owning workspace/system application, outside common Base unless they are cohesive generic runtime functionality. |

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

| Use case | User action | Boundary contract |
| --- | --- | --- |
| Personal research into a shared project | Send selected documents to Project | Copy the reviewed selection with provenance and receiving-audience disclosure. |
| Personal calendar from a project | Ask Personal for meeting-time suggestions | Send a bounded request; return permitted slots, not credentials or private event details. Creating an event is a separate effect. |
| Another workspace's agent helps | Ask Research to investigate a question | Start a bounded task there with selected context and an attributed result; do not migrate the sender's live agent or memory. |
| Personal dashboard follows project progress | Follow selected milestones | Establish an authorized subscription; disclose selected events while its authority remains valid. |
| Personalize an app workspace | Apply selected agent setup | Review and copy or use a supported merge locally; do not copy governing state or grants. |
| Open a referenced document elsewhere | Open in its owning workspace | Explicit client navigation under access checks; no panel reparenting, agent relocation or automatic connection. |

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

| Boundary result | Ordinary operation authority | Outcome |
| --- | --- | --- |
| Either side blocks | Any, including a prior grant | Deny before method entry; no approval prompt. |
| Both sides permit | Missing but acquirable | Ask the appropriate authorized approver. |
| Both sides permit | Already granted | Execute within that grant. |
| Both sides permit | Independently prohibited | Deny without an approval escape. |

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

**Implementation design decision pending:** the existing sandbox isolates a whole workspace,
and RPC receivers are long-lived workers with ordinary workspace authority. A receiving
worker can omit an optional invocation-parent nonce and start an independent call; native
workspace code can also use its workspace filesystem outside the causal RPC chain. Therefore
invocation attribution or an additional grant constraint cannot enforce the paragraph above
against a malicious receiving implementation. The proposed simpler contract trusts deliberately
exported, reviewed receiver methods to enforce the selected resource use and disclosure, while
retaining hard workspace ingress/egress and ordinary receiver authorization. A stronger
per-invocation guarantee requires separate execution and credential isolation. This choice
has been presented to the user; cross-workspace forwarding remains closed pending resolution.

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

| Intent | Interaction | Completion and return behavior |
| --- | --- | --- |
| Create a panel | New in the current workspace, or New on a workspace heading | Open that workspace's local `about/new`; show New in Project. No workspace picker for an already known destination. |
| Open a template/bundle link | Existing Open workspace flow shows source, name and Create workspace | Create an ordinary workspace using retained template acquisition; focus its local landing/New panel. No transfer of the previous workspace's data or grants. |
| Start an empty workspace | Existing creation command with the appropriate Base source | Focus the new workspace; preserve the previous workspace as a return destination. No setup tour or required agent conversation. |
| Open settings for Project | Settings command captures Project as its managed resource | Open/focus a local System settings panel. Header says System / Settings and Managing Project. Back returns to the initiating panel when it still exists. |
| Open personal browser history | Existing browser-history command | Open/focus a Personal panel. Do not load Personal source into the current workspace. |
| Return to recent work | Select its workspace heading or a labeled command result | Restore its existing view. If the target was deleted or access changed, explain and offer the remaining workspace list; never act on a same-named replacement. |

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

| State | UI treatment |
| --- | --- |
| Workspace opening | Keep its name/tree position visible; show progress in that section and a content placeholder. Other workspaces remain navigable. Do not display a permission request as loading. |
| No panels | Local New page offers existing create/open actions with the workspace name. No invented activity dashboard. |
| Disconnected server/workspace | Retain identifiable view state with a clear disconnected label. Existing reconnect behavior applies; disable effects that require live validation rather than promising an offline queue. |
| Access removed or panel deleted | Remove inaccessible content/metadata through existing revocation paths, clear its active target, explain the change and let the user select an accessible workspace. Never silently redirect a pending action to Personal. |
| Workspace stopped | Distinguish stopped from closed/collapsed. Existing Open/Start behavior resumes it under current authority; no new install/uninstall state. |
| Shared result or background completion | Quiet workspace-attributed badge/toast; explicit Open action. No automatic workspace switch. |

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

| Existing area | Required change | Preserve/reuse |
| --- | --- | --- |
| Workspace registry and client | Ensure each user's private Personal/System IDs; implement section 6's stacked desktop trees, mobile drawer, captured actions and workspace-attributed approval UI without relaunch on selection. | Existing creation, membership, runtime and lifecycle; no installed-app object or special System principal. |
| Base/template source | Extract personal/system coupling so ordinary app workspaces run independently; retain upstream identity/acquisition and remove composition-driven installation. | Cohesive common packages and existing source operations; no dependency-minimization project, update, release recovery or selective-history merger. |
| Page navigation | Adjust existing commands to open local routes in their owning workspace; System panels select explicit target resources. | Existing navigation, panel/context ownership and host authorization; no page-role registry or cross-workspace source resolver. |
| RPC addressing and discovery | Qualify the destination workspace and resolve its existing target; filter the existing catalog by deliberate exposure and disclosure policy. | Existing method definitions, schemas, contexts, calls, streams, events, origin facts and transport behavior. |
| RPC authority and settings | Apply source egress/destination ingress as hard ceilings before ordinary approval. System ingress stays closed. Present connections as views over those policies/grants. | Existing authority records, acquisition and management paths; no second connection or export registry. |
| Website requests | Carry verified website/workspace identity through the existing local capability and agent/tool paths. | Existing document/bridge and host resource checks; no inherited grants or parallel approval engine. |

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

Current completion gates are explicit:

| Gate | Current state |
| --- | --- |
| Receiver authority contract | User choice pending between trusted reviewed exports and separate per-invocation isolation; public forwarding remains closed. |
| Website → agent/tool effects | End-to-end authority propagation and acceptance remain incomplete. |
| Desktop | Restored automatic onboarding including completed first turn and visible setup overview passes in the existing E2E. Existing browser startup, panel rebuild and restart persistence also pass. Strict reconnect diagnostics and open-approval membership revocation remain outstanding. |
| Mobile | Full Android native onboarding, exact document retention, browser isolation, app restart and server restart pass at host `a3e07451c` / Base `06acdb6`, with recovered setup card visually inspected. Subsequent icon metadata propagation has focused mobile/type-check coverage. iOS runtime acceptance needs an Apple environment. |
| Native dependency | Repaired local Linux/Android artifacts are verified; production platform pins still select upstream 1.1.0 and need a coherent dependency release. |
| Distribution | Clean source closures pass; exact Base/Personal/System publication receipts are required for packaged startup. Nothing has been published. |

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
