# Website runtime and workspace installation

Status: implementation in progress, 2026-09-08. The full product contract and security
acceptance below are not yet implemented.

Implemented foundations:

- Canonical website authority subjects, durable user/workspace/origin bindings,
  revocation generations and document-bound grant constraints in the existing grant store.
  Host `1abacd79e`; 56 focused evaluator, storage, and authority-runtime tests pass.
  Host `079bfbc0e` adds installation continuity infrastructure in the same store: opaque
  host-created identities, validated live execution binding, generation revocation and
  optional requesting-version constraints. No installation lifecycle adopts it yet;
  existing approval UI and defaults are unchanged. 59 focused tests and all commit checks
  passed. See [mutable authority subjects](architecture/mutable-authority-subjects.md).
- Shared evaluator checks for connection and website grant isolation; dispatcher rejects
  disconnected documents before method/schema lookup or resource acquisition.
- Acquisition and invocation snapshots preserve subject generation/document constraints;
  page and remembered-identity decisions use the existing approval queue and grant store.
- Shared approval presentation identifies authenticated website origins and describes
  continuing access. Operation policy chooses recommendations; versioned credential use
  remains a reviewed-version default where offered. Host `7eb32c93c`; 113 focused tests
  cover shared copy, wire contracts, queue decisions, and saved permission lifetimes.
  The queue accepts persistent capability decisions only when explicitly offered.
- Ordinary panels use the shared envelope/stream bridge adapter. Native service ownership
  is resolved by the host, and gateway fetching accepts an explicit RPC transport without
  reading page globals or sending a bearer. Panel filesystem clients are created for each
  RPC runtime, removing the global initialization proxy.

Workspace skills now document the implemented browser connection, security, escalation,
and authoring contracts, with explicit limits for unfinished paths. Base `997001c` and
`6e1cf02` add linked website development/authority references and update app, worker,
and eval receiver-policy guidance. Relative links and current API signatures were checked.

Further implemented slices (2026-09-08):

- Host `ba985cd36` seals the workspace name and supplied exact template details into
  one prepared creation approval shared by hub and workspace callers. An unpinned
  request explicitly names the host-selected default. Host `08578e09a` verifies the
  visible name/source/commit in native consent. The native installation, reload,
  reconnect and receipt sequence passes, along with 79 focused tests and commit checks.

- Base `fe03585` and `017e081` add a portable conversation client for existing
  host-resolved channel targets: history, send, and cancellable NDJSON subscription.
  Panels and workers export the same client used by the website scaffold. Stream
  framing/cancellation and channel eligibility declarations have focused tests;
  the generated static scaffold passes strict type checking and builds independently.
  Workspace authoring skills document connection, grants and ordinary workspace storage.
  This is channel plumbing: connected website exchange, model launch and
  credential-backed inference acceptance remain outstanding.

- Desktop native document attestation, explicit connection approval, same-document
  reconnection with fresh execution identity, and navigation/disconnect retirement.
  Host `059d0a376`; 29 tests cover native origin/frame evidence, stale challenges,
  live caller ownership, and trusted-input consumption. Initial isolated Electron
  acceptance passed connection, ordinary RPC, closed endpoint denial, connected chrome,
  and reload retirement. Expanded isolated Electron acceptance now also passes native
  denial, refusal to reuse the consumed gesture, explicit retry and reconnection
  (20260908T131803081Z-3342039-79792d49; 48.9 seconds test, 2.7 minutes total). The
  earlier overlay response-delivery failure did not recur in this run.
- A pure complete runtime factory and portable default entry, with an installed-panel
  adapter selected by the build condition. The standalone SDK bundles the same Base
  runtime and self-contained declarations. A static React scaffold builds independently
  and has loaded under a project-path prefix in ordinary Chromium without workspace RPC.
- Mandatory website method choices in schemas, decorators, extension manifests, and
  exposure/intake APIs, with discovery filtering and dispatch ceilings. The full policy
  inventory still requires review; presence of an annotation is not that review.
  Host `d816f365b` records a [bounded endpoint review](reviews/website-endpoint-policy-review-2026-09-08.md)
  and extends the schema census (20 passing tests). Base `549c835` exposes the four
  secret-free model-settings read projections to attested website callers while keeping
  the settings write closed (22 passing tests). This is not a complete receiver-effects audit.
- Synchronous RPC delegation retains the initiating website separately from the receiver's
  own effect principal, including nested HTTP/WebSocket calls and bound RPC clients.
  Invocation snapshots retain website attribution for review/audit. Admission, grants and
  approval retirement use the actual current caller and its subject binding (Host
  `4573c344a`); an initiating
  website is not a transitive authority or lifetime ceiling on reviewed receiver work.
  Events, queued agents, cross-workspace calls, and every streaming path still need audit.
- Trusted desktop/mobile header and tree trust styling shares a race-safe inventory observer.
  Base `26678c0` and Host `5e8ab815c` record the styling slice. Host `f8d910463` and
  Base `d456174` add native Android/iOS providers, document-bound reply transport,
  shared mobile envelope/stream relay, and trusted disconnect/forget controls. Android
  compilation, 40 focused mobile tests and 21 hosting tests passed. iOS compilation,
  physical-device and accessibility-input acceptance remain outstanding. Native input
  is consumed before connection requests (Host `abe6c5062`); a page payload cannot attest
  an interaction.
- Hub creation now requires a durable operation ID and returns a minimal receipt. Registry,
  membership, receipt, and audit outbox commit atomically in the existing identity store;
  initialization advances state and deletion retains a deduplication tombstone. Fresh receipt
  reads are separate operations. Desktop/mobile retain pending input across reopening, and
  the CLI requires a retained ID. Host `4d767b83d` and Base `e7bbb3c`; 97 focused tests passed.
  Host `23d2accd8` and Base `d116a9f` add the shared `workspaces.create`/`receipt`
  runtime API for panels, workers and connected websites. Workspace hosts attest callers
  over the existing authenticated child port; the hub binds the source workspace and uses
  the same durable store. 82 Host tests and 17 portable runtime tests passed. Full native
  website-to-creation approval acceptance passed in isolated native Electron
  (20260908T141703896Z-3431952-a9fce9e4; 55.5 seconds test, 1.6 minutes total).
  The sequence denies and retries connection, inspects the template, approves creation,
  reloads the document, reconnects, and obtains the same creation receipt under fresh
  read permission. The owned instance and display were cleaned up. Native testing exposed
  and fixed authority preparation racing extension readiness (`5696de488`), the strict
  approval wire rejecting initiating-website metadata (`49df761a3`), and declaration
  application deferring an onInvoke build after invocation checked readiness
  (`5056b4084`). All 57 extension-host tests and 29 approval/schema tests pass.
  Native consent clicks now wait for approval-card animation geometry to settle.
  Receipt permission presentation is declared on the shared schema (`5a3762e54`).
  The real hub transport now contributes its own authority census so regenerating the
  catalog includes both receipt access and the existing hub-only effects.
- GitHub Pages API and permission setup reuse selected credentials with exact repository
  audiences. Read-only observation verifies the reviewed commit, manifest, and served assets.
  Base `79550e6` and `9871729` add credential-backed enable/observe helpers and a documented
  publication workflow. Git exports compare repository contents with the reviewed event,
  allowing unrelated configuration advances while rejecting changed source. 76 focused
  Git Bridge/Pages tests passed. The shared React scaffold now demonstrates retained
  creation requests, receipt recovery and exact retries; a separately installed SDK/sample
  passes strict TypeScript and produces identical manifest/assets across repeated builds.
  Host `9a5f93db4` records the scaffold and reviewed publication inputs. No public
  deployment was performed.

Still required before acceptance: mobile native/device and accessibility-input acceptance; reviewed endpoint
and resource inventory (including file handles and private template disclosure); ordinary workspace conversation storage/access integration; review of exposed operation effects and live connection/delivery boundaries; live acceptance of the documented Pages publication workflow; and the
complete desktop/mobile shared-application acceptance sequence. The shared representative
application must still exercise chat/model streaming, scoped state, callbacks and installation.
The existing tests do not establish completion of the product contract.

General installation-identity adoption is a separately scoped follow-up. The requested
mutable-identity slice delivers infrastructure without changing existing approval UX or
defaults; enabling it in production installation lifecycles is not a prerequisite for
that slice. Website subjects already have their own live-document lifecycle binding.

Extends [Agentic bundles and self-contained workspaces](agentic-bundle-partitions-plan.md),
especially its RPC and website requirements. [Isolation](isolation-plan.md) still owns
native execution guarantees. This work can change Host and Base together; compatibility
wrappers and a second website RPC stack are not required.

## 1. Product contract

A website can use the same typed RPC API as a workspace panel, starting with no
workspace authority. The host authenticates the document; the user connects it to
the workspace in which it is being viewed. Connection permits a deliberately small
baseline and makes other explicitly exposed operations eligible for normal acquisition.
It never grants the workspace's existing authority to the page.

Connection is a hard prerequisite with its own separate approval prompt. Before it
succeeds, every workspace interaction fails, including otherwise open operations and
operations with previously saved grants. An operation request cannot implicitly connect
the page, open a resource approval, or combine connection consent with operation consent.

Every callable method must explicitly choose its website policy. Authors must decide;
omitting the decision is a definition error. A closed choice needs a concrete reason.
Review the existing inventory in bulk, including userland RPC receivers, rather than
defaulting everything closed and calling the integration finished.

Websites and agents can discover structured template offers, inspect exact Git source,
and request creation of an ordinary workspace. Installation is workspace creation and
source admission, with the existing lifecycle. An app store is a consumer of this API.

## 2. Existing implementation and the actual gaps

The inspected Base is the development checkout selected by `vibestudio.baseCheckout`
in this Host's Git configuration: `/home/werg/vibestudio-release-work/base`. Resolve
that configuration again when implementing; do not assume this path on other machines.

| Existing owner                                                                                                                                                                                       | What to preserve / change                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RPC client](../packages/rpc/src/client.ts), envelopes and stream protocol                                                                                                                           | Reuse calls, replies, cancellation, streams and events. Website access changes authenticated admission, not the wire protocol.                                                                                                |
| [Panel preload](../src/preload/panelPreload.ts)                                                                                                                                                      | Currently combines envelopes with bootstrap, native dialogs, service dispatch and host events. Separate transport from these conveniences.                                                                                    |
| [Browser preload](../src/preload/browserPreload.ts)                                                                                                                                                  | Currently exposes autofill and website notifications, without the panel shell bridge. Add a document-bound runtime connection entry point. Do not expose the existing shell object wholesale.                                 |
| [Browser transport entry](../src/server/browserTransportEntry.ts)                                                                                                                                    | Its fallback serves hosted userland panels. It is not an admission mechanism for arbitrary external pages.                                                                                                                    |
| Base `packages/runtime/src/panel/transport.ts`                                                                                                                                                       | Already uses envelopes, but also selects Electron-local service routing. Move ownership routing to the host behind the common transport.                                                                                      |
| Base `packages/runtime/src/setup/createBaseRuntime.ts` and `createRuntime.ts`                                                                                                                        | Already have a transport-injected factory, but mix it with filesystem, theme, panel bootstrap and lifecycle assumptions. Extract the existing RPC core from those assumptions.                                                |
| [Service definitions](../packages/shared/src/serviceDefinition.ts), [method schemas](../packages/shared/src/typedServiceClient.ts)                                                                   | Single source for website eligibility, discovery and dispatch; extend the equivalent dynamic receiver definitions too.                                                                                                        |
| [Authority facts](../packages/rpc/src/authority.ts), acquisition coordinator                                                                                                                         | Preserve authenticated origins, attenuation, ordinary grants and approval ownership. Document identity binds website entry and live result delivery.                                                                          |
| [Templates schema](../packages/service-schemas/src/templates.ts)                                                                                                                                     | Has structured `inspect(locator)`, with exact commit/snapshot pins. Template offers belong to consumers; the configured registry was removed. Also has authoring/publishing methods that need independent exposure decisions. |
| Base `packages/template-management/src/index.ts`, `extensions/templates`                                                                                                                             | Existing userland client and implementation for exact source inspection. Consolidate their typed client derivation with the shared schema; retain source ownership.                                                           |
| [Hub control](../packages/service-schemas/src/hubControl.ts)                                                                                                                                         | Already has `createWorkspace({workspace, rootTemplate})`, gated by `workspaces.create`. Its management results and routing APIs are not automatically appropriate for websites.                                               |
| [Root acquisition](../src/server/acquireRootTemplateSnapshot.ts), [root validation](../packages/workspace/src/rootTemplate.ts), [creation review](../src/server/services/workspaceCreationReview.ts) | Reuse immutable acquisition, source validation, upstream provenance and unit review. Creation, admitted code authority and first external resource use remain distinct facts.                                                 |

This inventory establishes useful existing parts, not that ordinary panels or websites
can already reach every operation. The first implementation step traces actual callers,
receiver placement, System restrictions and result disclosure end to end.

Trust boundary clarification (2026-09-08): connection is an explicit user decision to
bring mutable website code into the workspace. The host enforces document connection,
website-exposed entry points, ordinary capability grants and result delivery. A permitted
operation runs under its receiver's reviewed contract and normal implementation authority.
Website attribution is useful for approval copy and audit history; it is not a transitive
ownership label on conversations, data, agent turns or later work. Do not claim general
confinement of downstream behavior or introduce a parallel taint-tracking system.

Cross-workspace validation needs the same distinction: a source-minted website
subject is not a record in the destination's local grant store. The existing
authenticated workspace transport must carry source-validated identity evidence;
copying subject records or grants into the destination is not an acceptable
solution. Ordinary code-caller cross-workspace acceptance proves neither website
forwarding nor this document-lifetime boundary.

Runtime lifetime review (2026-09-08): `createRpcClient` in
`packages/rpc/src/client-core.ts` currently discards the unsubscribe handles
returned by transport message/status subscriptions and the recovery hook.
`RpcClient` has no disposal contract. Base's panel runtime `destroy()` removes
its theme/focus/boot listeners but cannot retire the underlying client. Before
adding reconnectable document runtime initialization, give the owning client
factory an explicit lifetime: unsubscribe its registrations, reject pending
outbound work, cancel active inbound handlers and streams, and reject new work
after disposal. A borrowed/provenance-bound RPC view must not accidentally own
or close a shared transport. Test that replacing one client on a retained
transport cannot leave two message handlers or a permanently pending call.
This is an observed ownership gap, not yet a demonstrated cause of the reported
native process leak or intermittent System startup stall.

### General authority identity and permission UX refactor

Website support must address the broader identity model, not accumulate exceptions to
version-based permission. The current grant `scope` mixes duration (`once`, `session`),
subject (`agent`, `mission`) and revision binding (`version`). `approvalCopy.ts` starts
from version-trust wording and detects identity cases through requester categories and
sentinels such as `effectiveVersion === "internal"`. Refactor these owning contracts and
their consumers together. A website-specific label branch on that structure is insufficient.

Separate the following concepts in the canonical authorization model:

| Concept                                   | Meaning                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Authority subject                         | Who receives the permission, with a host-authenticated identity and explicit owner/namespace.                              |
| Live execution evidence                   | Which document, session, admitted code or agent execution is acting for that subject now, and how the host establishes it. |
| Capability and resource scope             | What the subject may do or receive, including the disclosure audience.                                                     |
| Lifetime and continuity constraints       | When permission ends, whether it is consumed, and which changes invalidate it.                                             |
| Reviewed implementation/contract evidence | Exact facts sealed into a particular review/invocation; revision restrictions only when meaningful and required.           |

A subject can be stable while its executing implementation changes. Stable never means
an arbitrary name, source path, panel ID or caller-asserted URL: the host owns the binding
and establishes it through the appropriate evidence. A website is bound by authenticated
user/workspace/site facts; an installed unit needs a host-owned installation/source
continuity identity if it is to retain grants across updates. An agent/task uses its
existing authenticated owner and execution binding. These subject kinds have different
proofs, but share grant matching, constraints, acquisition, revocation and presentation.
Do not erase those proof differences behind a universally trusted string ID.

Treat permission continuity as an explicit part of the decision:

- **This operation:** bounded invocation, consumed through existing once semantics.
- **This page/session/task:** bound to the actual lifetime named in the decision.
- **This reviewed revision:** only available when the host has an authoritative revision;
  valid only under its actual revision/contract constraints.
- **Remember for this identity:** explicit continuing consent within the selected resource
  scope, subject to expiry, revocation and the declared continuity/invalidation policy.

**Per-version grants remain first-class and default where sensible, not wherever a
version happens to exist.** Choose defaults according to the operation, resource and
meaningful lifetime of the permission. Model-provider credential use by versioned code
is a strong case for a per-version default; other operations may sensibly default to an
operation, task/session or clearly disclosed continuing identity scope. Approving one
version must not authorize another automatically. Stable subject identity enables bookkeeping and
explicit continuity; it does not displace version constraints. Once-only or shorter-lived
restrictions may further narrow a grant, and mandatory fresh confirmation still applies.

Approval controls derive their default from the reviewed operation policy, not solely
from whether the requester has a version. Clearly describe the selected scope, including
whether permission covers future versions; the user's approval must consent to that
scope. Never widen an existing version-bound grant or infer broader consent from unchanged
requested capabilities. Version matching binds the requesting code that receives the
permission, not merely the model provider's service implementation. Preserve existing
authoritative effective-version semantics rather than substituting build IDs or arbitrary
source changes. A changed authorizing version cannot use an old version-bound grant; it needs current
approval or another explicitly applicable grant. Provider/contract restrictions remain
independent constraints where required.

These describe semantics for the unified grant schema, not a second competing scope enum.
Normalize the overloaded fields at their owner and derive UI choices from enforceable
constraints. A receiver may restrict the choices; critical confirmation keeps its existing
fresh-decision rule. Broad persistence is never inferred just because a subject is stable.

For a website, remembering permission necessarily trusts future code served at that site.
Vibestudio cannot detect or certify that code's revision. Do not hash a fetched page to
pretend otherwise: subresources, server behavior and future navigation are mutable too.
For installed code, an authoritative reviewed revision remains useful evidence. Merely
adding a stable subject must not widen existing version-bound grants into permission for
future code. The refactor must explicitly model installation continuity, declared authority
changes, contract/provider changes, removal/replacement and source adoption before offering
remembered identity permissions for installed units. Same path/name is not continuity.
Existing grants retain their actual constraints through the coordinated cutover; never
infer persistent consent from a version decision. Unsupported/ambiguous records fail
closed with an explained review, not silent permission widening.

One-time invocation preparation remains exact even when the subject is mutable: seal the
requested operation, target, scope and available receiver evidence before approval, and
revalidate them at effect entry. A website's mutable identity is no excuse to approve a
different request or receiver after the user decides. Likewise, stable subject matching
cannot override current connection, membership, exposure, boundary or execution ceilings.

Move revocation generation, optional initiating-document binding and identity tombstone
semantics into the common subject/lifetime machinery wherever they apply. Website proof
construction and the separate connection gate remain specific to browser hosting. The
website subject described below is one consumer of this general contract, not a standalone
website permission subsystem. Durable operation ownership must likewise use stable subject
identity independently of transient execution and revocable permission.

Shared approval presentation must answer **who, what, audience, duration and continuity**
directly from the normalized decision. Replace version-first helpers and magic identity
sentinels with an authenticated subject presentation and the actual available constraints.
Names, icons and requester-authored descriptions remain untrusted context. Examples:

- “Allow example.com to read the selected conversation?” / “For this page”.
- “Remember for example.com” / “Applies to future pages and code from this site in Project.”
- “Allow Research Agent to use this account for this task?”
- A genuinely revision-bound unit decision names the app and action first, then says
  “For this reviewed version”; it does not replace the action with generic “Trust version”.

Show continuing access in the existing permission manager grouped by subject and workspace,
with resources, audience, lifetime/expiry, continuity rule and revoke action. Identify saved
but inactive access separately from live access. Use the same decision presentation on
desktop/mobile and in pending/history views. Revision details appear only when they explain
a real decision or change; websites never get a fake version, “unversioned” warning or
installed-code assurance. Website-request identity and concrete disclosure/cost warnings
from §3 still apply. Exact source review for template installation remains a separate
meaningful use of immutable revision evidence.

Implementation begins with a census of subject matching, grant issuance/storage, authority
preparation, admission/update invalidation, acquisition deduplication, revocation and all
approval/permission surfaces. Deliver the general contracts and migrate normal userland
callers along with website support. Do not declare this complete after renaming UI labels.

## 3. One runtime, explicit connection

### Compatibility is an acceptance requirement

Aim for the same application source, imports, typed service clients and runtime semantics
in a home-built panel and a Vibestudio-enabled website. Sharing only the RPC wire format
or a small website SDK subset does not meet this requirement. Refactor any existing runtime
fundamental that obstructs it, including public APIs, initialization, module ownership,
injection, routing, lifecycle, packaging and the ordinary panel callers themselves.
Preserve useful protocol semantics, not accidental implementation constraints. The proposed
extraction below is a starting point, not a restriction on that refactor.

Current obstacles are concrete: the panel entry initializes on import; initialization
requires injected panel identity, gateway configuration and other globals; panel transport
depends on the shell bridge and knows Electron service routing; package dependencies use
workspace-only resolution. None establishes a necessary website/application API split.
The existing transport-injected factories and shared hosted runtime are useful foundations,
but current compatibility is not established merely by their existence.

Use one explicit connection lifecycle for both hosting forms. An ordinary panel's existing
admission can satisfy connection without another prompt; an external document starts
unconnected. Availability, authority denial and revocation are ordinary runtime outcomes
that shared application code can handle without testing whether it is a website. Merely
constructing a service client must not perform protected operations. Do not supply dummy
panel globals, fake installed source identity or website-only conversions to run old code.

Keep true differences explicit: an external document has no installed source revision;
its native navigation and lifetime differ from a retained workspace panel; its grants are
independent. Source-editing/hot-reload and host presentation facilities belong to explicit
facilities with truthful availability. Access to files, chat, models, RPC receivers and
other grantable services uses the same API wherever eligible and authorized. Outside a
Vibestudio host, the SDK can load but cannot manufacture workspace connectivity.

Acceptance requires one representative application source built and run in both forms,
with the same imports and operation code for chat/model streaming, a scoped state operation,
RPC callbacks and template installation. Only hosting/build configuration and legitimate
connection/authority state may differ. Test denied and revoked cases through the same
application handling. Inventory every remaining incompatibility, justify its actual host
or security requirement, and remove incidental ones rather than documenting them away.

Use the existing `createHostedRuntime` assembly in Base
`packages/runtime/src/shared/hostedRuntime.ts`, already exported through
`@workspace/runtime/hosted`. It is the pure common client assembly used by panels,
workers and eval. Do not introduce a second website client assembly or duplicate
its namespaces. Its `RuntimeHost` ports must be supplied from the actual authenticated
hosting context. The panel barrel currently constructs those ports only after
global-based bootstrap; that initialization boundary, rather than the shared
client implementation, needs refactoring. `createBaseRuntime` currently serves
panel bootstrap only despite its comment claiming worker reuse.

Keep `createRpcClient` and a host-supplied envelope transport beneath this existing
assembly. Ordinary panel setup composes panel lifecycle, state and presentation
around it. A website imports the same core entry point
without triggering filesystem reads, workspace bootstrap, agent registration, theme
subscriptions or panel-global assumptions on import.

The injected surface provides protocol negotiation and connection lifecycle, then the
same envelope transport. SDK names below are illustrative, not additional RPC methods:

```ts
const runtime = await connect(); // trusted UI requests connection to this panel's workspace
const templates = runtime.templates;
const inspected = await templates.inspect({ url: offer.url });
const created = await runtime.workspaces.create({
  name: offer.name,
  template: inspected.pin,
});
```

Typed namespaces derive from the owning schemas. The creation convenience binds to the
existing creation operation after its contract is made suitable for all callers; it
must not become a second installer. Dynamic services use the existing RPC/discovery API.
SDK availability is not evidence of authority, and a fabricated client cannot change it.

Before connection, expose only protocol availability and the ability to request/cancel
connection. No workspace IDs, inventories, capability catalogs, account metadata or
private runtime configuration. Requests are deduplicated and rate bounded; trusted
chrome owns the prompt and verified origin. Page titles and requested descriptions are
untrusted presentation. The host captures the workspace and viewer, never current focus
at approval time. Denial does not create an automatic prompt loop.

Desktop and mobile adapters implement this same contract. A hosted panel's authenticated
socket remains its transport adapter; arbitrary websites do not receive a reusable hub
token, pairing credential or local socket URL. No network pairing feature is implied for
ordinary browsers outside Vibestudio. Report unsupported hosting/protocol explicitly.

The host derives sender/frame/document generation, origin, workspace and authenticated
viewer from its actual view/session. Discard page-supplied identity/authority fields.
Use existing authenticated RPC session identity; do not invent a new privileged website
principal or treat remote page bytes as an installed code version.

### Durable website identity and grant matching

Transport sessions identify live connections, not persistent grant subjects. The current
`AuthorizationOrigin`, `AuthorityGrantSubject`, `subjectsForOrigin` and grant constraints
do not express a website binding. Extend those canonical contracts, validators and context
constructors together. Reusing a panel ID, retaining transport sessions across navigation
or copying grants into fresh sessions is not the design.

Introduce an explicit, unprivileged `website:<host-minted-id>` authorization origin and
grant subject. The host owns its stable binding to exactly **authenticated user ID +
initiating workspace ID + canonical security origin**. It is shared across replacement
documents/panels for that tuple, and differs across users, workspaces and sites. The ID
is not a token: only a host-authenticated document/session can select it as its authorizing
origin. Caller-supplied IDs and origin strings cannot. This is an intentional refactor of
the single authority model, not another evaluator, grant store or session conversion.

The host-attested initiating website fact carries the binding, current access generation
and initiating document ID. The evaluator verifies that fact against the authorizing
subject and live host state. Website grants match only this subject plus the ordinary
capability, resource, provider/definition and source-workspace constraints. User, code,
panel, agent and task grants cannot substitute for the website's permission to call a
service through family fallback. This does not prohibit a reviewed service from using its
own approved implementation resources to fulfill that permitted operation; those grants
are not transferred to the website. Extend ordinary
caller-sensitive requirements to admit website origins explicitly; internal/code-only
requirements remain closed. Acting-account ownership is an independent check.

Use the common subject access-generation and initiating-document constraints in the canonical
grant schema. Do not overload the executor's `sessionId`: receiver implementations have their own sessions and ordinary authority. All website grants bind the current
generation; their lifetimes are:

| Decision                                             | Additional constraints                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Connect this page / allow an operation for this page | Exact initiating document ID; operations also name their approved capability/resource.              |
| Allow once                                           | Exact document plus existing invocation/consumption identity; unusable after replacement.           |
| Remember connection                                  | No document constraint; requires the separate connection prompt's explicit persistent choice.       |
| Remember operation access                            | No document constraint; explicit persistent consent to the selected capability/resource and expiry. |

A fresh document starts disconnected and authenticates a new transport session. Its
explicit connection handshake resolves the durable binding. A matching remembered
connection decision may satisfy the separate gate; otherwise its separate prompt is
required. Saved operation grants cannot satisfy connection. Only after connection can
they authorize new calls. Old approvals, once grants, streams and callbacks never transfer.
Persistent grants do not authorize detached continuation after the initiating document ends.

Disconnect invalidates that live document and dependent work. Revoking one permission
retires its canonical grant and stops subsequent affected access across documents.
**Forget saved access** revokes the binding's connection/operation grants, advances its
generation and disconnects all its live documents; UI names that complete user/workspace/
site scope. Membership removal also advances the generation: removal/rejoin cannot revive
old grants. Account/workspace deletion retires the binding under existing lifecycle rules.
Retain non-authorizing identity/tombstones as required for audit and operation deduplication;
forgetting permission cannot erase evidence of an already-created workspace. Reconnection
after revocation needs current consent. Recheck liveness and generation at website entry and live delivery, not only when constructing the initial authorization context.

Initially admit top-level HTTP(S) documents with verifiable origins. Subframes, opaque
origins and unsupported document schemes cannot borrow the top-level bridge. This is an
explicit document admission rule, independent of endpoint exposure. Cross-frame support
would require its own authenticated document binding, not a `postMessage` origin string.

Navigation, reload, view replacement and workspace detach invalidate the live connection,
pending approvals, callbacks and streams. Same-origin replacement is still a new document.
Reconnect establishes a new binding and re-evaluates policy. A remembered decision, if
offered, is scoped to user + workspace + origin and explicitly authorizes future documents
at that origin; it never preserves a live handle. Default connection lifetime is the
current document. Origin approval necessarily trusts all scripts executing in that page.

### Connection and panel identity UX

The first gate is access to workspace functionality at all. Visiting, bookmarking,
focusing or placing a browser panel beneath a workspace panel grants nothing. Ordinary
browser permissions such as notifications remain separate. Before connection the page
can request connection, but cannot use workspace services or inspect their metadata.
After connection only the explicitly reviewed baseline is available; further access
uses the normal approval flow. Connection is never presented as “trust everything”.

An unconnected workspace call returns the common structured connection-required failure
without resolving private target metadata, queuing the operation, or opening another
approval. Application code explicitly requests connection through the host connection
surface and waits for its separate approval to complete before submitting workspace work.
Concurrent calls cannot ride along with a pending connection. Denied, pending and revoked
connections all fail the gate. Protocol availability and requesting/canceling connection
are host handshake operations, not access to workspace functionality.

Use the existing approval queue and trusted desktop card/mobile sheet. Connection copy:

> **Connect example.com to Project?**
>
> This website wants to use features in Project.
> Connecting allows [the concrete reviewed baseline]. Files, conversations and paid
> model use require separate permission.
>
> **Not now** · **Connect for this page**

The baseline sentence is generated from the actual connection contract, not a static
promise that can drift. If it only permits discovery of eligible operations, say that.
Show the verified full site address (scheme, hostname and non-default port), the captured
workspace and requesting panel. The page's title/icon may supply context but never replace
the host-rendered website identity. Any remembered-connection option is secondary, explicitly
states its user/workspace/site scope, and explains that future pages on that site may
reconnect. Do not preselect permanence. Denial leaves browsing intact and stops this
request. A new deliberate user action can retry; background repeated requests cannot
continually reopen the prompt. Pending requests use existing badges without stealing focus.

All panel riders/header strips and panel-tree rows use the same three identities on both
desktop and mobile:

| Panel identity                  | Persistent visual treatment                                                       | Accessible wording                            |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| Workspace panel                 | Workspace-panel glyph beside its app identity                                     | “Workspace panel, [title]”                    |
| Ordinary browser panel          | Browser/globe glyph plus website identity                                         | “Website, [site], not connected to workspace” |
| Workspace-enabled browser panel | Browser/globe glyph retained, with a distinct connection mark and workspace label | “Website, [site], connected to [workspace]”   |

The connected website must remain visibly a website. Never replace its globe with the
workspace-panel glyph or use a checkmark/shield that implies code review or safety. Color
may reinforce these states but cannot be their only distinction. Favicon and page title
are page-controlled and cannot occupy the trusted status mark. In compact tree rows retain
the glyph and connection mark; expose the full site/workspace in accessible text and the
row's details action. Connection-requested and reconnecting are transient states, visually
distinct from connected. A saved permission is not evidence of a live connection.

Desktop riders show the site and compact “Connected to Project” status with an access
details action; the same identity appears in sidebar/tree rows. On mobile, preserve the
trusted mark in the visible rider/header and tree line, and open the same access details
in the existing sheet. Do not rely on hover, a desktop tooltip or opening the tree to
learn that the visible page is connected. Support screen readers, large text, high contrast
and narrow widths; truncate descriptive titles before the trusted identity. Fullscreen
presentation must retain a host-owned way to inspect connection identity and leave the
page; page-rendered UI cannot substitute for it.

Access details show the current site and workspace, document/session lifetime, remembered
connection decision if any, currently granted resource scopes and pending requests. Reuse
the existing grant manager as the data owner. Provide **Disconnect this page** and, when
applicable, **Forget saved access** with explicit scope. Disconnect closes the live bridge
and its mediated work; forgetting also removes the selected remembered decisions. Neither
claims to erase results already delivered or undo completed actions. Render updated state
from confirmed host revocation, and make failures visible rather than optimistically
claiming disconnection. Navigation immediately retires the previous live status.

### Every website-originated approval carries its attribution

Extend existing shared approval presentation rather than introducing website-specific
approval machinery. Connection, resource access, paid use, installation and publication
requests all retain a host-owned **Website request** label, verified site and captured
workspace. This treatment remains on requests made by a local agent/tool on the website's
behalf, even after the page closes. Show the local executor as secondary context, for
example “Requested by example.com · through Research Agent”. Do not relabel it as a
trusted local request because the final RPC came from installed code.

The first visible read answers:

- **Who asks:** verified website, requesting panel and originating workspace.
- **What happens:** concrete action and selected files/conversation/account/model or exact
  template/repository. Website descriptions are quoted as its request, not host claims.
- **Who receives it:** the website and any additional workspace/shared audience that will
  receive data or results; distinguish operating on data from returning it to the site.
- **How much and how long:** exact resource scope, once/session/saved lifetime and any
  enforced spending or execution limit. Do not display a budget as enforced if it is not.

Show warnings only for consequences of this particular operation, next to the relevant
decision: “This website will receive the selected conversation”, “Uses your [account] and
may incur charges”, “Publishes these files publicly”, or “Applies to future pages at
alice.github.io, including other project paths”. HTTP connection requests carry a concrete
unencrypted-site warning. Avoid generic danger banners on every website and avoid technical
terms such as principal, origin, rider, capability or delegation in approval copy.

Keep the verified site and action visible above the fold on mobile and desktop; expandable
details can contain the full URL, exact source revision, downstream executor and additional
technical evidence. Show hostname safely, using an unambiguous ASCII representation for
internationalized domains; never obscure a differing host behind a friendly title or URL
path. Shared host-derived presentation data feeds both clients and cannot be overwritten by
the page, model or receiver. Reuse canonical scope/lifetime controls and denial actions.

Panel focus changes cannot retarget an open approval. If the requesting document is gone,
invalidate any approval requiring it and explain “This page is no longer connected”.
Historical completed actions retain website attribution without displaying a live connection.
Collapsed trees and ancestor badges may summarize pending work but cannot imply that a
parent's connection or grants extend to its children. A local panel created at a website's
request retains its actual panel type; any continuing website-attributed work is identified
separately, rather than hiding its initiator or pretending the local panel is a web page.

## 4. Mandatory website policy on every method

Implementation census (2026-09-08): a syntax-tree scan of Host service schemas
and the selected Base found 774 literal method entries in 70 files, with eight
composition sites requiring further resolution. This is a partial inventory,
not a reviewed endpoint count. In particular, `view.ts` combines method tables,
`vcs.ts` passes an intermediate table, and `workspaceSource.ts` combines public
and internal wire tables. `browserVaultNative.ts` derives a host-facing table
from the browser-vault receiver schema while replacing its authority. Its
exposure decision must describe that native receiver, not inherit the public
receiver's decision accidentally. Inventory the final registered tables and
dynamic receivers as well as literal declarations; checking only calls with an
object-literal argument misses these contracts.

The current `MethodSchema` has cross-workspace eligibility but no website
exposure field, and both definition helpers currently accept methods without
one. Website connection checks alone therefore do not implement this section.
Add the decision at this existing schema owner and carry it through table
composition, discovery and dispatch together, before enabling external-page
RPC ingress. Preserve the distinction between website eligibility and the
existing cross-workspace export decision.

Extend the existing method policy with a required website-exposure decision (names proposed):

| Choice                 | Meaning                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `closed` + reason      | Website-originated calls cannot reach this method, including transparent RPC forwarding; this is not a restriction on a trusted receiver’s internal implementation calls. Ordinary consent cannot override this ceiling. |
| `eligible` + rationale | A connected website may request the operation; its single ordinary authority contract determines what this verified caller needs. Eligibility itself grants nothing.                                                     |

This policy is independent of `open/gated/critical`, execution principal and
cross-workspace export policy. An open local method is not automatically website-safe;
a website-eligible method is not automatically cross-workspace exported. Missing or
contradictory requirements fail validation. There is no separate `connected/acquire`
endpoint taxonomy. Use the existing authority contract to express caller-sensitive
requirements: a locally open operation can require a scoped grant when its verified
initiator is a website, because its effect or disclosure crosses that boundary. Do not
add another evaluator or website-only grant system. Discovery, review and dispatch at the website-facing boundary must resolve the same caller-sensitive requirement.

Connection does not override `open/gated/critical` or any resource requirement. After
connection, website-open operations can run without another prompt; missing acquirable
authority uses ordinary operation approval. Existing valid grants may satisfy it.
Discovery exposes only the eligible, disclosure-approved subset after connection;
enumerating it never acquires every listed capability. The deliberate two-stage UX is
one separate connection approval, then approvals only for genuinely missing operation
authority. Do not combine the first operation with the connection prompt.

Baseline candidates are public protocol descriptions and operations confined to data
already supplied by this connection. Workspace files, chat history, account/model
inventory, paid inference, credentials, runtime creation and workspace installation are
not baseline operations. Classify by concrete input, effect and return, not method names
such as `read` or `list`.

Each method owns a decision. Shared constants may express an intentional reviewed group,
but no service-wide implicit default silently covers future methods. Apply the requirement
to builtins, userland services, entity-exposed methods, streams and subscriptions through
their existing registration contracts. Update generators, authoring guidance, fixtures and
the checked authority census together. CI checks completeness; review checks whether a
closed reason is justified. A required enum alone cannot prevent lazy blanket denial.

Enforce eligibility at actual dispatch, not merely in discovery or SDK wrappers. Resolve
the exact receiver and implementation before evaluation. Apply membership, document
liveness, connection, website exposure, existing workspace boundary ceilings and ordinary
resource authority before entry. Revalidate affected state after pending approval and
before resumed work or further stream/event delivery. Generic invocation, direct entity
addresses and Electron-local routing must converge on the same rules.

## 5. Chat, model use and downstream authority

Expose ordinary chat/model services where their contracts can satisfy these rules.
Allow bounded inference using an approved account without disclosing its credential.
Account selection belongs in trusted UI; the website receives only the operation result
and any deliberately disclosed opaque selection reference. References are not authority.
Model results returned to a website are disclosure to that origin and its scripts; review
must describe that audience, including for private context supplied to the model.

Access to an existing conversation requires selection and disclosure approval. A new
website-initiated conversation does not inherit Quickfire history, skills, filesystem access,
tools, installed code grants or personal accounts. Paid use and tool effects retain their
own scopes. Use the existing operation identity to make one-time approval correspond to
one actual operation, including bounded retries; never solve duplicate credential prompts
by returning secret metadata or issuing a broader grant.

### Workspace conversation storage and access

Website-initiated conversations live in the workspace to which the website is connected,
using the same conversation, channel, attachment and tool-log owners as ordinary workspace
conversations. Website attribution does not introduce a separate storage location, retention
system, or privacy boundary inside that workspace.

Existing workspace sharing and retention rules apply. The ordinary operation/access review
must truthfully identify the workspace audience and the website receiving results; there is
no additional storage-location approval merely because the initiator is a website. A shared
workspace conversation must never be described as private to its initiating member. Work
started in Personal stays in Personal; work started in a shared workspace stays there.

Disconnect, document closure and revocation stop mediated access. They do not delete the
workspace's retained conversation or recall results already returned to the website. A new
document needs a live connection and current conversation-read authority. Existing workspace
conversation deletion and membership rules apply without a website-specific retention path.

The user takes trust responsibility when connecting a website and granting operations.
The connection prompt must explain that the site's code can change independently and that
its permitted actions have workspace consequences. Connection does not grant every
capability or bypass operation approval.

Review the exposed operation's actual effects and result disclosure. Once a service accepts
an authorized operation, its own contract governs execution and any durable work it starts.
It may use its normal approved implementation resources. Do not require an originating
website label to follow every agent turn, tool, queue or stored derivative as a security
guarantee. Generic agent execution deserves a correspondingly clear trust decision about
what that agent can do, rather than a promise of transitive containment. Ordinary workspace
and account boundaries still apply.

Disconnect prevents new website calls and retires its live delivery channels. It is not a
rollback and does not automatically cancel accepted durable service operations. Cancellation
of accepted work follows that operation's existing explicit cancellation contract.

For example, a website permitted to call a reviewed model service can trigger inference
using that service's approved account. The service performs the approved operation and
returns its result; the website does not need or receive the service's account grant.
The request retains website attribution and its approved scope throughout.

RPC participation includes existing calls, streams, subscriptions and explicitly exposed
callbacks. Callback registration does not create a globally discoverable service or
authorize unsolicited workspace reads. Bound callback invocation and arguments to the
initiating interaction, audience and document lifetime. Ordinary independent inbound calls
still need their own endpoint policy and authority. No automatic workspace broadcast feed.

## 6. Template offers and installation

Keep one locator/pin vocabulary: the existing template URL, exact pin and catalog-entry
coordinates. An external store can publish JSON offers containing descriptive metadata and
those coordinates, using the existing schema components. Agents can consume them through
ordinary HTTP tools. No central-store registration, HTML scraping or new template format
is required. External descriptions and catalog recommendations are untrusted claims.

`catalog()` already supplies structured verified catalog data; it need not become a
universal store crawler. An arbitrary offer URL enters `inspect()`, which resolves and
verifies an exact self-contained snapshot. Git transport, redirects, private repository
credentials, network destinations and acquisition budgets remain under existing controls.
Inspection reads source as data; it cannot execute repository hooks or template code as
part of discovery. Private inspection results themselves need disclosure authorization.

Make template inspection, workspace creation and durable receipt recovery discoverable
through the common typed runtime for ordinary panels, workers and connected websites.
Use the same contract and lifecycle owner for all three; website connection is an
additional admission gate, not an alternative installation API. Keep general inspection with cohesive ordinary userland functionality; it should
not require opening System application ingress. Creation stays with the host's existing
protected workspace lifecycle owner. If its current caller restrictions require System,
refactor the exact bounded creation contract and protected policy there. Do not forward
arbitrary website requests through a privileged System agent or add an installer proxy.

The operation flow is:

1. Read an offer and inspect/acquire its exact source. A mutable ref resolves once; the
   resulting commit and snapshot become the proposed installation identity.
2. Request creation with that exact pin and a proposed name. Trusted UI shows verified
   source coordinates, destination ownership and the concrete creation/admission effects.
   A page click initiates the request; it is not host consent.
3. Seal the source identity and arguments through the existing prepared-authority mechanism.
   Revalidate at execution. A changed ref, snapshot or request cannot substitute different
   code after review. Preserve existing unit review and version-bound grants; creation
   permission alone does not approve all installed-code requests or account use.
4. Return a minimal creation result: created workspace identity and completion state that
   the requester is authorized to see. Opening it is a trusted host action. No routing
   credentials, general workspace inventory, pending private approvals or inherited access
   to the new workspace. Refine the owning result schema and update callers together.

“One click” means one action starts this flow, with any required trusted review. Avoid
duplicate prompts for the same operation; do not merge distinct authority into a generic
Install approval. Existing authority acquisition handles any combined review presentation.
The new workspace's grants are independent of the requesting site's connection.

Make creation retry-safe at the existing lifecycle owner. Use its durable operation
identity, extending that contract if necessary. Durable ownership and live delivery
authorization are distinct:

- The durable owner is the website subject from §3 (user + initiating workspace + site),
  independent of document ID and access generation. Deduplicate by owner + client-generated
  operation ID, which the client persists before submission. Seal exact template pin, name
  and all other creation inputs into the request digest. Same key/inputs identifies the
  same operation; changed inputs conflict. Panel IDs, connection generations and workspace
  names are not durable operation keys.
- The existing creation owner reserves that operation durably before effects, serializes
  concurrent submissions and records the resulting workspace/outcome through its existing
  creation/recovery lifecycle. Reconnect cannot create another workspace for the same key.
  A pending request invalidated before effect has a terminal canceled/no-effect outcome;
  it cannot execute automatically later. A deliberate retry after reconciling that outcome
  uses a new operation ID and current operation authority.
- Delivery is an authorized invocation on a currently connected document. The old reply/
  stream ends with the old document and never delivers to its replacement. An operation ID
  or receipt is a locator, not authorization. If creation committed before document loss,
  preserve the workspace and its trusted UI status regardless of lost delivery.

A freshly connected document reconciles an uncertain submission through an explicit status
read at that same creation owner using its retained operation ID. This is a new authorized
invocation, not resumed delivery. Require the same website subject, the hard connection
gate, current membership/policy and ordinary scoped permission to read that operation's
minimal receipt. A matching saved receipt-read grant can satisfy that requirement; otherwise
obtain new operation approval. An old once-only creation approval cannot authorize it.
Return only approved state and bounded creation results, never routing credentials or
authority over the created workspace. Unknown/foreign IDs reveal no other owner's records.
Generation revocation removes reconciliation authority, not deduplication evidence; new
explicit receipt-read consent can authorize reading a pre-revocation outcome.

If a submission never reached durable reservation, status may report no record for that
owner/key. Absence is not proof of cancellation: the original submission may still be
delayed. The client may deliberately resubmit the exact inputs under the same operation ID
with current creation authority. The creation owner serializes reservation with any delayed
original submission, rechecks each submission's live authority before effects, and allows
at most one creation. An invalid delayed submission cannot cancel a valid replacement
submission's reservation. If the key already has a terminal canceled/no-effect outcome,
return it instead of reopening the operation. A status read alone never starts creation.

While submission outcome is uncertain, reconcile status instead of generating a new key.
Reconnect and timeout alone never justify creating new work. If the client loses its key,
trusted workspace UI can show the user's retained creation history and let them select a
receipt for disclosure to the site. Do not expose global creation inventory or infer
identity from matching names/pins. Keep deduplication tombstones at the lifecycle owner
when a created workspace is deleted: an old retry reports its recorded/deleted outcome
rather than reinstalling. No separate installation job store or uninstall state.

A template link can open trusted creation UI without connecting the referring page to
workspace RPC. This is navigation to the same creation flow, not a second installer or a
capability grant. It provides an appropriate path for sites that only offer installation.

## 7. Happy path: build and publish an enabled website to GitHub Pages

Deliver a supported scaffold, shared SDK distribution, typed Pages publishing helpers,
agent instructions and one end-to-end example. A user should be able to ask “build this
website with Vibestudio chat and publish it to GitHub Pages” without the agent inventing
the bridge, credential handling, build layout or deployment procedure. Planning this path
does not itself authorize publication of this repository or creation of a remote site.

### Build a normal static website

The scaffold is an ordinary independently buildable static project, using the shared
runtime core from §3. Ship a browser-consumable versioned package whose dependency closure
contains no private workspace imports, Electron code or host bootstrap globals. Pin it in
the site's lockfile and bundle it locally into the static output. The same implementation
serves workspace panels; this distribution is not a fork of the SDK. A workspace-only
`@workspace/...` alias is insufficient for a GitHub clone or external build.

Include a Connect action, explicit unavailable/connecting/denied/revoked states, and a
small streamed chat example using the actual exposed service contract. Outside Vibestudio,
the page still loads and explains how to open it there; it does not try localhost ports,
request a provider token or silently substitute a remote model backend. Include an optional
template-offer JSON file using §6's schema and an Install action using that same flow.

The default project-site build handles the repository URL prefix, relative assets and
reloads without server-side SPA rewrites. Test it under a non-root path. Keep source maps
and other downloadable assets within the explicitly reviewed publication inventory. The
build must not require GitHub/model secrets or a running authoring workspace. Public output
contains only the site, SDK and deliberately published offers, never connection handles,
account metadata, private source/context or captured credentials.

### Extend the existing GitHub workflow

Base `skills/github/SKILL.md` owns account setup: `getGitHubOnboardingStatus()` and the
host-owned `GitHubSetup.tsx` flow. API calls use `credentials.fetch()`; managed repositories
use the runtime Git provider. [Git interop](../packages/service-schemas/src/gitInterop.ts)
already supplies `publishRepo` and `pushUpstream`. Preserve semantic source publication
followed by protected-main Git export. Never treat the host interchange checkout as source
or introduce shell `gh auth`/token environment handling as another credential system.

Add Pages read/configure/build-status operations to the existing GitHub integration, with
typed inputs/results and exact repository-scoped authority. Extend its endpoint declarations
and the existing setup/repair permission mappings together; the current integration's
declared GitHub endpoints do not list Pages configuration. Do not assume its existing
“publish” access choice covers Pages. Derive the required provider permissions from the
current [GitHub Pages REST contracts](https://docs.github.com/en/rest/pages/pages), and keep
their mapping in the credential setup owner. Ambiguous credentials/organizations require
the existing account picker. Missing permission returns its existing structured repair
path; no pasted token or automatic broad-scope escalation.

Start with one supported publication strategy: a reproducible local build into `/docs`
of the dedicated managed website repository, including `.nojekyll`, published from the
selected ordinary branch. This fits existing protected-main export without a new artifact
branch synchronizer or workflow-file credential requirement. GitHub supports branch-based
publication from `/docs`; `.nojekyll` bypasses Jekyll processing. See
[publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
and [Jekyll behavior](https://docs.github.com/en/pages/building-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll).
The scaffold owns source plus generated output and one build command; stale output fails
pre-publication verification. Existing sites with a different deployment owner are detected
and reported for deliberate integration, not silently reconfigured. Custom Actions builds
can be a later supported strategy if justified, sharing the same publication contract.

The developer-facing helper orchestrates existing owners:

1. Build, verify the output and preview the page in an owned browser panel. Verify connect,
   denial and one authorized operation against real document identity.
2. Prepare a concrete publication review: account/owner/repository, new or existing remote,
   repository visibility, exact source commit/output digest, published branch/path, and
   expected public audience. A dedicated public repository is the starter default; source
   as well as built assets will be public. Repository privacy and site visibility are
   separate provider facts. Do not change either silently.
3. Use existing bounded publication/account approval, then create/configure the remote,
   push the reviewed protected source and configure Pages through authenticated API calls.
   Later pushes to its publication source update the live site, so update reviews must
   describe that effect too. Authoring GitHub authority never flows into the published page.
4. Observe provider build/deployment status and obtain the actual site URL. Verify served
   build identity and asset loading; a successful Git push or HTTP 200 alone is insufficient.
   Return repository URL, site URL, source commit and deployment state, with bounded useful
   errors. Resume observation after timeout rather than recreating the repository.
5. Open the deployed URL in a fresh Vibestudio browser document and prove connection plus
   the chosen operation. Local preview and deployed origin have independent authority.

Repository creation, push and Pages configuration are not a distributed transaction.
Reuse durable operation identity/status at the existing owners so retries reconcile actual
remote state. Report partial progress precisely (for example, source pushed but Pages
configuration denied). Do not delete a repository to simulate rollback. Missing credentials
or provider policy may block live acceptance, but must not prevent preparing the build,
review and tests that do not depend on them.

### GitHub Pages origins are the permission boundary

GitHub project sites use URLs such as `https://owner.github.io/repository/`, while an
owner site uses `https://owner.github.io/`; see [GitHub Pages site types](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
Different repository paths on that host share one web origin. Consequently a remembered
origin grant applies to that owner domain, not one repository path. Do not invent path
scoping as a security boundary or substitute repository ownership for verified page origin.
Trusted approval must display the actual origin and explain this scope when persistence
is offered. Default document-only access limits persistence but does not make same-origin
scripts isolated. A dedicated custom origin is the path for applications needing separate
website identity; redirects require binding to the actual final origin.

## 8. Implementation sequence and completion evidence

1. **Contract census.** Trace real runtime bootstrap, all receiver registration forms,
   main/server routing, template clients and creation review. Include the general identity,
   grant-continuity and permission-presentation refactor in §2, with existing non-website
   subjects as acceptance cases. Record each method's website
   decision, rationale and disclosure. Resolve receiver authority for the first chat/model
   operation before exposing it. Add mandatory definition validation and bulk-update Host
   and Base in the same cutover; no permissive fallback for missing declarations.
2. **Runtime unification with host adapters.** Refactor the shared application runtime and host transport contract, migrate
   ordinary panels to it, and move host ownership routing behind it. Verify existing panel
   calls, streams, events and recovery before adding website admission.
3. **Document admission and enforcement.** Implement desktop/mobile bindings and trusted
   connection UI through canonical acquisition. Add website policy to discovery and actual
   dispatch and close stale connections. Prove one harmless baseline
   operation and one bounded acquired operation using the same typed client as a panel.
4. **Chat/model vertical slice.** Exercise an actual service with selected account use,
   streamed result and website-attributed downstream tool effect. Verify one-time consent,
   document-bound live result delivery and revocation at website entrypoints. Conversations
   and retained tool logs use the workspace's ordinary storage and sharing rules. Review
   receivers as trusted implementations; do not promise transitive website confinement.
5. **Template vertical slice.** Expose the common inspection/create API, exact-source review,
   minimal results and retry semantics. Feed the same structured offer to a website and an
   agent. Both create ordinary workspaces through the same owner. Store UI is optional.
6. **Author-to-Pages vertical slice.** Ship the standalone SDK build and website scaffold,
   extend the existing GitHub integration/setup for Pages, and document one supported
   build/preview/publish/update procedure. Publish a deliberately reviewed fixture when
   authorized and verify its deployed runtime connection. Publication is not required for
   every local test, but this path is not accepted solely on mocked provider responses.

Required evidence, beyond typechecks:

- Common authority coverage distinguishes stable subject from live execution and optional
  revision binding. Test website, installed-unit and agent/task cases through the same
  acquisition/revocation/presentation machinery. Existing revision grants never silently
  become identity grants; same-name replacement never inherits continuity. Pending exact
  operations cannot change while being approved. User-facing duration/continuity choices
  must correspond to stored, enforced constraints on desktop and mobile.
- Verify defaults follow the operation's reviewed policy, including a sensible per-version
  default for model-provider credential use by versioned code and appropriate other defaults
  for task/session or continuing access. For version-bound grants, repeated use by that version follows the granted limits;
  another version cannot spend through it, including when capability declarations are
  unchanged. Across-version access requires explicit broader consent. Website callers
  with no authoritative version retain their truthful document/site choices and cannot
  borrow an installed intermediary's version grant.
- Before connection, direct envelopes and discovery reveal no private data or effects.
  Spoofed identities, frames and workspace addresses fail at the receiving boundary.
  Verify otherwise-open calls and previously granted calls also fail without opening
  resource approvals or being replayed after connection. Connection approval is separate;
  only a subsequently submitted operation may enter ordinary authority acquisition.
- Visually inspect all three panel identities in desktop/mobile riders and tree rows,
  including compact layouts, long/deceptive titles, dark/light themes and large text.
  Verify accessible labels and non-color distinctions. Exercise connection pending,
  denied, connected, disconnected and remembered-but-not-live states. Capture resource,
  model-use and downstream-agent approvals: all show the actual website/workspace and
  concrete disclosure/cost/lifetime before acceptance. Focus changes, navigation and
  revocation update both clients without stale connected marks or actionable stale cards.
- Every registration form rejects missing website policy; `closed` fails even with an
  old grant, direct address, generic invocation or downstream forwarding. A representative
  ordinary panel and website share the client and serialization tests.
- Denial, reload, same-origin replacement, cross-origin navigation, reconnect, membership
  removal and policy tightening invalidate pending/active access. Two users and two
  workspaces visiting the same origin have independent decisions. Test queued effects,
  returned handles, stream delivery and callbacks, not just initial request entry.
- Website model use exposes no credential, private inventory or Quickfire history. Approval
  names origin, workspace, account use and result audience. A reviewed receiver executes
  its approved effect with its normal implementation authority; website attribution is not
  a promise of transitive confinement. One-time use is tested against actual egress and retry behavior.
- Persistence tests prove fresh same-site sessions can use explicitly saved grants only
  after connection; document/once grants cannot survive replacement. Reused panels at other
  origins, other users/workspaces, fabricated website facts and user/code/task grant fallback
  cannot substitute. Forget/reconnect and membership removal/rejoin do not revive old access.
- Inspect transcript, attachment and tool-log storage to verify it uses the connected
  workspace's ordinary storage, sharing and retention rules. Website attribution does not
  create exclusive data ownership or private storage within a shared workspace. Verify live
  document delivery separately from ordinary retained conversation access and deletion.
- Public Git offer inspection and creation work for both clients. Invalid pins, source
  substitution, private Git denial, incompatible manifests, rejected admission, duplicate
  submissions and lost replies preserve exact source/creation semantics. Created workspaces
  have fresh data and authority; the referring site cannot access them automatically.
- Interrupt creation before reservation, before effect, after commit and before receipt
  delivery. Reconnect with the same durable key and fresh receipt-read authority: at most
  one workspace is created, no old reply is delivered, changed inputs conflict, and a
  revoked/foreign caller learns no outcome. Include concurrent documents, forgotten access,
  lost client key and retry after deletion; reconcile only through the existing owner.
  Cover a no-record status followed by an authorized resubmission under the same key racing
  a delayed original: at most one creation, no stale-authority effect, and no cancellation
  of the valid submission by the stale one.
- Run native acceptance on supported desktop/mobile bridges. Record platform gaps honestly;
  an adapter unit test does not establish native document isolation. Use the repository's
  managed system-test workflow for agentic tests, inspect failures and stop owned instances.
- Pages coverage includes independent clone/build, repository subpath assets, no-secret
  output, missing/ambiguous credentials, denied publication, partial deployment recovery,
  exact deployed version and an update to the same site. In a normal browser it loads
  without the bridge; in Vibestudio it starts unconnected. Two Pages paths under one owner
  must not be reported as isolated origins. Live acceptance records the deployed URL and
  approved fixture lifecycle; temporary local instances/connections are cleaned up.

This design document has no runtime test verdict. Implementation is complete only when
the common panel path, website boundary and template creation slices have their recorded
product evidence, not merely when an SDK facade compiles.
