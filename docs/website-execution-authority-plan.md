# Website execution authority and invention demo

Status: implemented; focused tests, native website acceptance, typechecks and the live parent/child permission regression passed. Not deployed.

## Contract

Connected websites participate in ordinary workspace RPC. Ordinary workspace
operations are subject to the existing capability, resource, context and approval
rules; a website is not limited to a second application API. Credential
administration, private workspace-state administration, authority administration,
and privileged system/native controls remain closed.

Launching arbitrary execution must not silently broaden authority. A website's
agent, its evals and their execution descendants retain the initiating execution
scope and applicable approval requirements. An approved typed service may use its
implementation authority to perform its declared effect. These are different
boundaries: service implementation calls must not be confused with arbitrary
user-authored execution.

The existing website attribution field is audit evidence, not enforcement. Do not
repurpose it as an authorization shortcut. Execution authority must be host-minted,
retained at the execution ownership boundary, propagated through canonical launch
and admission, and evaluated by the ordinary authorization machinery. No
website-specific agent service, privileged forwarding proxy, raw provider call,
or demo-only permission bypass is acceptable.

Accepted work continues after the initiating document disconnects. Document
disconnection ends page access, not accepted execution. Subject revocation or a
generation change prevents every subsequent protected effect, including effects
from recovered agents and their descendants. Document-only grants do not transfer
to accepted execution.

The generated invention stays inside vibestudio.app as an unsandboxed same-origin
document. It shares the page's authenticated runtime SDK instance and can itself
launch agents, generate images, and use ordinary workspace RPC. It has the same
website scope and approval ladder. Disconnect unloads its UI; accepted agent
work continues independently. It must demonstrate a live AI interaction, not
just an AI-authored static toy.

## Work sequence

1. Trace and specify launch, execution admission, resource authorization, grant
   reuse, revocation, reconnect and durable recovery. Establish the distinction
   between document access and accepted execution lifetime.
2. Implement the shared execution-authority binding and its persistence. Verify
   non-widening through website → agent → eval → child execution, including
   denial and stale/revoked binding cases. Existing code/session behavior must
   remain intact.
3. Audit public RPC families operation by operation. Open ordinary eval, runtime
   creation, agent/conversation, VCS, image and application operations. Keep
   privileged administration closed. Align receiver principals, prepared
   requirements, discovery and dispatch; regenerate derived policy catalogs.
4. Use the same runtime SDK for the website invention studio: combine interests,
   start a real workspace agent, show a working saved invention, and revise that
   invention conversationally. Rich presentation must expose actual results and
   actual progress, errors and approval states.
5. Run focused authority and lifecycle tests, host and template type checks, then
   real connected-website acceptance on an isolated managed instance. Test the
   demo at desktop and mobile sizes. Stop all owned instances and connections.

## Verification results

- Final host typecheck and Base composition typecheck passed.
- Focused host coverage includes authority grants/revocation, execution admission,
  runtime scope persistence, receiver enforcement, eval lifecycle and kernel
  callback forgery rejection.
- Native Electron website acceptance passed with real connection and capability
  approvals, agent launch, eval, private-operation denial, and document replacement.
- Six browser tests passed for desktop/mobile creation, revision, restoration,
  actual activity indicators, animation controls, and reduced motion.
- The deterministic invention smoke passed in 4.9 minutes. Only inference is
  scripted; read/eval/write tools, native approvals, child-agent messaging,
  revision, saved HTML, and reconnect use the real integration.
- The provider-backed Astra invention test passed in 12.6 minutes: generation,
  an embedded agent response quoting a fresh request, revision, and reconnect.
- Two crash regressions passed after killing the test worker during provisioning
  and after readiness. They verify the server, captured descendants, helpers, and
  temporary instance state are removed. All acceptance-owned resources closed.
- Website assets rebuilt and external-template hygiene passed.
- Live `subagent-task-permission-reuse` passed: run
  `st_f087666b26bf448f897e09d71b607ab4`, 96.4 seconds, zero tool failures.
  Admission retains the authenticated owning agent alongside its eval runtime.
- The live invention coverage exercises text agents. Real provider-backed image
  generation is not covered by that acceptance run.

## Acceptance criteria

- Connection alone cannot authorize a protected effect.
- Website-specific resource gates survive arbitrary execution boundaries.
- Unrelated code, user, agent and task grants cannot silently widen that scope.
- Explicit approval can authorize the exact additional effect through the normal
  ladder; no new permission mechanism is introduced.
- Retrying launch or delivery does not duplicate agents, messages or inventions.
- A stale identity, revoked grant or changed ownership cannot regain authority
  through a child, recovered runtime, callback or cross-workspace relay.
- Sealed service implementation retains only its established contract authority.
- Credential/state/system administration remains inaccessible to website-authored
  effects, including effects attempted through eval.
- The demo creates an actual interactive artifact in workspace storage and revises
  it through the same conversation; it does not substitute canned inventions.

## Integration observations and affordances

Implemented fixes:

- Export the existing `launchAgentIntoChannel` helper from the runtime SDK, so
  websites use the same launch/subscription contract as workspace applications.
- Persist task constraints on website grants. A task approval is owned by the
  website subject and generation, rather than an unrelated task principal.
- Detach accepted eval work and sealed kernel bookkeeping from transient inbound
  invocation lifetimes. Guest effects still carry the execution admission; kernel
  callbacks validate the active runtime/run or host-minted sink.
- Direct objects enforce live receiver declarations, including inherited methods.
  The build-local documentation catalog only parses worker-local declarations and
  must not serve as a second enforcement gate for inherited methods.
- Bind both an admitted eval and its authenticated owning agent to the same task
  closure. Later local lifecycle tools must retain membership when creating
  descendants; an agent does not become unrelated merely because its eval ended.
- Align website eligibility with receiver principals in conversation and image
  APIs. An eligible declaration with no website principal was unusable.
- Host-side closed-receiver errors now identify the source, class and method,
  and include the declared reason.

Further affordances worth improving:

- Documentation extraction should describe inherited methods and their source,
  even though it is not an authority boundary.
- Extend the [connected website guide](connected-website-agents.md) with a
  standalone runnable starter. It now explains launch, replay, observation versus
  cancellation, reconnect, approvals and file-backed embedded UI, and links the
  working invention studio.
- Add a policy consistency diagnostic for eligible methods whose principal
  requirements cannot admit a website.
- Expose an explicit accepted-work state in the SDK so applications can distinguish
  page disconnection from task cancellation without inferring it from transcripts.

Compatibility: adding persisted execution authority changes WorkspaceDO schema
from 35 to 36. The existing durable schema system deliberately accepts only an
exact current schema; this change has been tested with fresh state. It is not an
in-place migration for existing v35 state, and deployment must account for that
before touching existing workspaces.

The host checkout and linked Base checkout contain unrelated in-progress edits.
Preserve those changes and keep verification evidence attributable to this work.
