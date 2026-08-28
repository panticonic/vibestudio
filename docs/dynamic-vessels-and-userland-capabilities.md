# Dynamic iframe authority and userland-defined capabilities

**Status:** design direction
**Date:** 2026-07-27

## Decision

The chat panel is a trusted container for a client-affine dynamic iframe runtime. It owns
frame lifecycle, transcript placement, the composer, genuine user-origin
interactions, and authority UI. It does not execute authored MDX, widgets, or
`client_eval` in its own JavaScript realm.

The host creates one persistent sandboxed iframe for the chat's dynamic surface.
MDX, inline UI, custom feedback bodies, action bars, custom message renderers, and
`client_eval` execute there because they need a shared DOM, browser runtime,
client-local computation, package loading, context filesystem, durable scope, and
access to the workspace runtime. They should not be routed through EvalDO merely to
acquire authority.

Separate runtime kind from authority admission instead:

1. The concrete caller and entity kind is **iframe**.
2. The exact iframe bootstrap/build is admitted with **dynamic** authority mode.
3. Each iframe incarnation receives its own host-minted runtime principal and logical
   RPC session. It does not act as the containing panel.
4. Its logical session is carried over the host's existing physical transport. The
   iframe receives a private `MessagePort`, not transport credentials or a direct
   socket.
5. The host derives the iframe's owner, context, lineage domain, contributors, causal
   sources, and monotonic lineage from canonical state. Authored code cannot supply
   them.
6. Dynamically admitted iframe calls are not bounded by the installed chat container's capability
   request list, just as admitted EvalDO execution is not bounded by its harness
   manifest.
7. They still receive no authority automatically. Grants, locks, receiver contracts,
   context lineage, task/agent/mission scope, and fresh critical confirmation intersect
   normally.

Separately, workspace code may define capabilities for resources it owns. Those
definitions become receiver-enforced **userland capabilities** in the unified
authority evaluator and grant ledger. They replace provider code that asks a custom
approval question and is merely expected to honor the result.

## Containment and RPC identity

The containing panel and the dynamic iframe have different trust roles and therefore
different principals. Containment is a host-recorded relationship, never identity
substitution.

The host owns the session record:

```ts
interface DynamicIframeSession {
  v: 1;
  authoritySessionId: string;
  runtimeId: `iframe:${string}`;
  incarnation: string;
  parentRuntimeId: string;
  containingPanel: {
    slotId: string;
    runtimeId: string;
  };
  iframeBuildDigest: string;
  lineageDomainId: string;
  contextId: string;
  ownerUser: `user:${string}`;
  issuedAt: number;
  revokedAt: number | null;
}

interface IframeLineageDomain {
  v: 1;
  lineageDomainId: string;
  contextId: string;
  ownerUser: `user:${string}`;
  contributors: readonly (
    | {
        kind: "user";
        userId: `user:${string}`;
        sourceRef: string;
      }
    | {
        kind: "agent";
        agentBinding: {
          entityId: string;
          channelId: string;
          bindingId: string;
        };
        taskRef: string | null;
        sourceRef: string;
      }
  )[];
  lineage: ContextIntegrityFact;
  issuedAt: number;
  revokedAt: number | null;
}

type DynamicAdmissionSource =
  | {
      kind: "channel-message";
      logId: string;
      head: string;
      messageId: string;
      invocationId: string | null;
    }
  | {
      kind: "tool-invocation";
      logId: string;
      head: string;
      invocationId: string;
    }
  | {
      kind: "document-fragment";
      repositoryId: string;
      state: VcsStateNodeRef;
      path: string;
      fragmentKey: string;
    };

interface DynamicExecutionRecord {
  iframeRuntimeId: `iframe:${string}`;
  iframeIncarnation: string;
  executionId: string;
  kind:
    | "client-eval"
    | "message-mdx"
    | "inline-ui"
    | "feedback-custom"
    | "action-bar"
    | "custom-message"
    | "document-jsx";
  sourceDigest: string;
  admissionSource: DynamicAdmissionSource;
  startedAt: number;
}
```

The execution record proves that the host admitted and dispatched a source into the
iframe. It does not prove which code in the shared realm initiated a later effect:
arbitrary code can retain callbacks and runtime objects across dispatch boundaries.
It is therefore audit context beneath the iframe session, never a separately
claimable authority origin or a grant selector. The host derives it from canonical
channel/trajectory state:

- `client_eval` is bound to the exact advertised tool invocation and inviting panel;
- MDX is bound to the exact persisted agent message and content digest;
- inline UI, custom feedback, action bars, and custom message renderers are bound to
  the exact message, invocation, or panel-state event that installed them;
- executable document fragments are bound to an exact repository state, file,
  fragment key, source digest, and semantic provenance projection;
- user and agent contributors, context, outside-content lineage, and causal turn come
  from host state rather than renderer claims.

The host creates a `MessageChannel`, retains one end as the session endpoint, and
transfers the other end into the admitted iframe. The iframe constructs the ordinary
RPC client over that port. It has its own request namespace, subscriptions, streaming,
recovery, revocation, and lifecycle, but no independent WebSocket/Iroh connection.
The session multiplexer carries it over the existing host transport.

Every inbound envelope is canonicalized from the port binding. A frame-supplied
`from`, caller kind, owner, context, agent, task, source, lineage, or authority session
is ignored or rejected. The authenticated caller is always the live iframe runtime
and incarnation bound to that port.

Agent- and task-scoped grants may select the iframe session only while every agent
contributor admitted to that lineage domain has a compatible host-derived binding.
Admitting authored code from another agent or task widens the domain's contributor
set and stops a narrower standing grant. A user contribution is useful provenance but
does not turn the iframe into a direct-human principal or lend it the user's ambient
authority. The system never switches agent/task authority per call based on a
frame-supplied execution id.

The containing panel participates only in the control and UI planes:

- request creation, attachment, replacement, and destruction of the iframe;
- place and size the dynamic surface within trusted panel chrome;
- present acquisition, critical-confirmation, and other trusted user-origin UI;
- deliver canonical message/execution references to the host for admission.

It is not in the iframe's RPC data plane and does not forward calls under its own
identity. When authored code needs a container operation such as focusing the
composer, presenting an overlay, or opening another panel, it calls the container as
an ordinary receiver. Any downstream closure preserves the iframe as original caller.

## Caller kind and runtime relationships

A dynamic iframe is `callerKind: "iframe"`, not `"panel"`. It also has a first-class
active runtime entity of kind `"iframe"` with canonical id `iframe:<key>`, exact build
identity, context, owner, lifecycle, and parentage.

Calling it a panel would incorrectly imply that it owns a normal panel-tree slot and
participates in panel leases, navigation takeover, stable-slot projection, direct-human
presence, and other panel-only lifecycle behavior. Calling it a worker or generic
session would similarly erase its browser containment and dynamic-authority semantics.

The iframe has these host-derived traits:

| Concern               | Iframe behavior                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Code identity         | Exact sealed iframe bootstrap/build                                                                                     |
| Authority origins     | Code baseline plus admitted dynamic session; never user merely because MDX received a click                             |
| Context               | Exact containing panel context                                                                                          |
| Direct runtime parent | Exact containing panel runtime incarnation                                                                              |
| Owning panel          | Stable containing panel-tree slot                                                                                       |
| Panel-tree node       | No; the iframe is not a visible slot                                                                                    |
| Child-panel placement | Defaults beneath its owning panel slot                                                                                  |
| Child-runtime lineage | Children name the iframe entity as direct parent and inherit its context; nearest-panel traversal reaches the container |
| User subject          | Inherited host-side from the iframe entity's owner                                                                      |
| Presence              | Code deputy, not a human client                                                                                         |
| Transport             | Host-multiplexed logical session over its private port                                                                  |
| Lifetime              | Bound to the containing panel runtime and iframe incarnation                                                            |

Runtime kind and authority mode are also independent coordinates. The chat iframe is
`iframe + dynamic`; an iframe admitted only for fixed code would remain
`iframe + fixed`. A future dynamic worker remains `callerKind: "worker"`, and EvalDO
remains `callerKind: "do"`. Dynamic admission never rewrites a runtime's concrete
caller kind.

Entity ancestry and panel-tree placement remain separate coordinates, as they are for
workers and DOs:

- `parentRuntimeId` records the exact runtime that launched/contains the iframe;
- `containingPanel.runtimeId` identifies the current panel runtime incarnation;
- `containingPanel.slotId` is the stable visible slot used for placement and
  user-facing association;
- `contextId` is copied from the containing panel by the host and cannot be requested
  by the frame.

The iframe's portable `parent` handle therefore resolves to the containing panel.
Panels opened by the iframe default under the containing slot. A worker, DO, or other
runtime launched by the iframe records the iframe as its direct entity parent, while
the ordinary nearest-panel walk still finds the chat container. Destroying or
replacing the containing panel runtime retires the iframe incarnation and all of its
live relationships; a new panel runtime creates a new iframe entity rather than silently
reparenting the old one.

Adding `"iframe"` must not become a repository-wide collection of
`kind === "panel" || kind === "iframe"` patches. The caller-kind registry should expose
the orthogonal traits currently inferred inconsistently from kind, with exhaustive
helpers for at least:

- code/build identity;
- context resolution;
- user-subject inheritance;
- authority-principal presentation;
- entity and nearest-panel parentage;
- panel-slot ownership versus panel-slot membership;
- physical transport and lease policy;
- direct-human presence;
- approval category and presentation.

Generic services such as filesystem, VCS, build, docs/catalog, RPC relay, handles,
credentials, userland capabilities, and runtime creation consume those traits or the
canonical entity relationship. Genuinely panel-specific operations such as navigation
takeover continue to require an actual panel. Wire schemas, caller-kind unions,
connection/session registries, grant serialization, receiver caller allowlists,
catalog visibility, test helpers, and userland boundaries are updated exhaustively so
an unknown or unclassified kind fails closed. This refactor is part of adding the kind,
not follow-up compatibility work.

The iframe bootstrap is admitted only from a sealed build whose manifest declares:

```json
{
  "vibestudio": {
    "authority": {
      "mode": "dynamic"
    }
  }
}
```

Ordinary panels and workers remain `"fixed"` by default and retain their exact
manifest ceiling. The trusted chat container has only its fixed baseline for channel
state, frame lifecycle, rendering placement, and trusted interaction surfaces. The
dynamic iframe has an unbounded acquisition vocabulary, but no grant merely because a
capability is discoverable or requestable.

## Permanent iframe confinement

Authority expansion changes the grant ledger, not the browser sandbox. The iframe
remains confined for its entire incarnation:

- sandboxed scripts are enabled, but same-origin access to the container is not;
- no parent DOM access, Electron preload globals, raw Electron IPC, Node integration,
  transport credentials, or unmediated host effects;
- an iframe-specific CSP denies direct network egress, remote subresources, nested
  frames, forms, downloads, popups, and top navigation;
- subframe navigation, window creation, browser permission requests, and network
  requests are independently enforced by the Electron host;
- the bootstrap document is host-generated, and authored source enters as data after
  the port and session are bound.

The confinement membrane does not impose a fixed capability list. The iframe receives
the same portable `@workspace/runtime` surface as panels through an iframe-specific
`RuntimeHost` adapter over its logical RPC session. Capability and receiver discovery,
preflight, acquisition, invocation, opaque handles, streams, subscriptions, package
builds, brokered network access, filesystem operations, terminal control, panel
operations, and userland-defined capabilities all use the unified RPC and authority
path.

Browser-local computation, DOM, React, timers, and component state remain ambient
inside the iframe. APIs whose effects leave that realm use broker-backed runtime
implementations. User authorization can therefore expand the iframe session to the entire
declared host and userland capability space without revealing an alternate
unaccounted authority channel.

The existing target-neutral runtime assembly is reused rather than copying the panel
runtime. An iframe supplies its own transport, RPC-backed filesystem, workers, panel
facade, gateway/fetch adapter, external-open adapter, and verified parent relationship
to `createHostedRuntime`. Authored imports remain `@workspace/runtime`. The panel's
singleton bootstrap, injected gateway credential, and Electron-local transport are
not loaded into the iframe.

## Lineage and user origin

The host maintains a monotonic contributor set and lineage latch for the entire
security domain. A chat iframe is its own domain; cooperating Spectrolite block frames
share their open document's domain:

- admitting persisted MDX joins the host-derived lineage of its exact message;
- admitting `client_eval` joins the lineage of its exact tool invocation and causal
  turn;
- before data from a file, network response, package, clipboard, channel, provider,
  or another runtime enters an iframe, its provenance joins the domain's
  lineage;
- durable scope values retain writer provenance, and reading one joins that
  provenance before releasing its value;
- values and effects leaving an iframe carry the domain's current contributors and
  lineage;
- copying, replaying, serializing, rendering, or approving data never cleanses it.

An iframe cannot clear, downgrade, replace, or fork these facts. Reset requires
retiring every iframe in the domain and minting a new domain; any persisted content
loaded into the new domain joins its contributors and lineage again.

Authored UI cannot mint user origin. A browser-trusted click inside arbitrary MDX says
only that physical input occurred; authored code controls its presentation and
handler. Genuine user-origin facts are minted only by trusted container or host
surfaces such as composer submission, acquisition, critical confirmation, and trusted
pickers. A genuine user action taken in response to authored content retains the
content's lineage.

One iframe should contain the whole dynamic chat surface and `client_eval` environment.
If multiple cooperating iframes are ever used, they may have distinct lifecycle
principals but conservatively share one iframe-session lineage domain because browser contexts
can communicate directly. Independent security-bearing lineage requires stronger
compartments with no direct browser communication, such as separate `WebContents`;
sibling iframe boundaries alone are insufficient.

## Chat-authored surfaces and interaction results

The chat boundary applies to every executable UI surface, not only transcript MDX and
`client_eval`. The same dynamic iframe owns:

- MDX message bodies and custom message renderers;
- persisted `inline_ui` elements;
- the authored body of `feedback_custom`;
- authored action-bar content;
- shared packages, browser-local component state, durable scope, and client-eval
  bindings used by those surfaces.

These are layout regions and host-admitted execution records within one iframe
principal, not separate caller identities. They deliberately share imports, callbacks,
scope, DOM events, and runtime objects, so pretending that an action bar or feedback
component has cleaner lineage than the transcript would be false. Installing or
loading any of them joins its host-derived contributors and lineage into the live
iframe domain before it can execute.

The trusted chat container may place and clip the iframe, own a resize affordance, and
overlay trusted chrome. It also continues to render wholly host-defined surfaces such
as schema feedback forms, the composer, capability acquisition, critical
confirmation, credential input, and trusted pickers. Authored React never crosses the
realm boundary through a portal or callback; data crosses through typed host
operations.

Interaction and user origin are separate facts:

- a click, input event, or browser user-activation token inside authored UI may be
  recorded as physical-interaction evidence, but the authored handler chooses its
  meaning;
- `chat.send()`, action-bar actions, inline-UI actions, and `feedback_custom.onSubmit`
  invoked by iframe code remain effects or results of the iframe principal, even when
  they immediately followed a click;
- a custom feedback completion may resume the waiting invocation, but its value is an
  **interactive-content response**, not a trusted user instruction and not an
  authority grant;
- when a result must become a genuine user-authored message, approval, credential,
  signature, or other security-bearing assertion, the iframe proposes bounded data
  and a trusted host surface displays and commits it through a separate typed
  operation.

This does not reduce dynamic capability range. Authored UI may directly attempt any
effect available through the runtime and acquire authority for it. It only prevents
arbitrary code from relabeling its own call or callback result as direct user action.

## Executable documents and Spectrolite

Spectrolite should use the same iframe caller kind and authority machinery, but not the
chat iframe's one-shared-realm topology. The current product already has the useful
semantic boundary: the document/prose editor is a trusted Lexical surface, while each
live JSX node is compiled independently and has no document-wide JavaScript scope.

Preserve and harden that boundary:

1. The Spectrolite panel remains a normal fixed panel and owns the editor, selection,
   source/diff controls, file tree, suggestions, publish UI, and user input.
2. Each executable JSX node renders in its own permanently sandboxed child iframe.
   Each has an `iframe + dynamic` lifecycle principal, parented to the Spectrolite
   panel and attached to the same context.
3. All executable frames in one open document share one document authority/lineage
   domain. Each iframe is admitted from the exact document state, file identity,
   fragment key, source digest, and host-derived provenance. A source change retires
   that block's iframe incarnation and admits the new revision, while its contributors
   and lineage join the shared document domain.
4. Non-executable prose and editing controls remain ordinary trusted editor DOM.
   Arbitrary document code never shares the contenteditable realm and cannot forge
   keystrokes, selection changes, suggestion acceptance, or publish actions.
5. Document component state uses a typed broker backed by Spectrolite's existing
   per-viewer view-state store. The iframe does not receive panel globals, React
   contexts, `globalThis` backdoors, or the panel runtime singleton.

Separate opaque-origin frames do not have sibling DOM access and receive only their
own private host ports, so one block cannot impersonate another frame or use its RPC
principal. Ordinary browser frames can nevertheless obtain window references and
exchange `postMessage` data. They are therefore useful DOM and lifecycle compartments,
but not independent security-bearing lineage domains. Cross-block state should still
use declared broker operations; the shared document lineage domain prevents a direct
browser message from laundering data or authority through a cleaner sibling.

Block-level independent lineage would require a stronger compartment that prevents
direct browser communication, such as a separate `WebContents` per block. That cost is
not justified by the current product. If stronger compartments are added later, the
host may safely split the document domain without changing the iframe caller kind or
runtime API.

If Spectrolite later adopts true whole-document JavaScript semantics, the executable
document becomes one document-preview iframe and therefore one principal and lineage
domain. It still cannot also be the trusted editor. The clean choices are an external
trusted editor plus whole-document preview, or the present trusted rich editor plus
per-block executable frames; putting arbitrary code into the contenteditable
realm makes reliable user/agent lineage impossible.

### Document contribution and review lineage

The canonical semantic VCS, not Spectrolite component state, owns edit provenance.
Every mutation is authenticated at receiver entry:

- direct editor mutations are recorded as contributions by the panel's user subject;
- agent mutations retain the exact agent entity, channel binding, task/work unit, and
  causal state;
- suggestion acceptance or merge records both the agent contribution and the user's
  review decision. It must not copy the suggested bytes into a fresh “normal user
  edit” that erases their origin;
- deleting, copying, formatting, accepting, publishing, or recompiling content never
  cleanses its causal lineage.

A live JSX buffer does not execute and acquire provenance afterward. The trusted
editor first records its semantic working mutation and receives the exact resulting
state/source seal; iframe admission consumes that seal atomically. Debouncing may
coalesce edits before preview refresh, but there is no parallel DOM-only provenance
path and no unrecorded source may acquire runtime authority.

The VCS exposes a generic provenance projection for an exact state and resource slice
(file/range or stable semantic fragment). The iframe admission service consumes that
projection to construct the contributor set and outside-content lineage. This is a
VCS primitive usable by any executable document product, not a Spectrolite-only
sidecar blame database. Until a fragment-level projection is available, admission
conservatively uses the whole document state's causal closure.

Authorship, review, and runtime authority remain distinct:

- “edited by the user” is a source-contribution fact; executing those bytes is still
  code, not direct human presence;
- “accepted by the user” is a host-authenticated review edge and may satisfy a policy
  that explicitly requires review, but it does not rewrite agent authorship;
- a document execution domain's lineage remains monotonic. Replacing one block iframe
  does not reset it. A fresh domain requires tearing down every executable frame for
  that document and admitting an exact document state again, and only canonical
  provenance—not teardown itself—can omit a contributor.

Approval copy resolves these frames as, for example, “Interactive block in
`plans/q3.mdx` in Spectrolite,” followed by “edited by you and @scribe” and any task or
outside-content facts. The document title, path, fragment identity, contributors, and
review state all come from the host and semantic VCS.

## Difference from EvalDO

There should be no difference in the kinds of authority an admitted execution may
request. EvalDO, MDX, and `client_eval` all enter the same evaluator, grant ledger,
locks, tiers, lineage rules, and receiver contracts.

Their containment and lifecycle facts are different:

- EvalDO is a discrete server-side invocation with a sealed harness/build identity,
  bounded lifetime, isolated execution state, and an explicit invocation boundary.
- MDX and `client_eval` share a persistent sandboxed browser realm, host-minted iframe
  session, DOM, package state, durable scope, and monotonic lineage. Exact execution
  records show host admission and dispatch context, while the iframe principal and
  complete contributor set select authority.
- Spectrolite uses multiple iframe lifecycle principals for independent JSX block
  rendering, but their open-document lineage domain supplies the conservative
  contributor and lineage facts used by every block call.
- A dynamically admitted worker has no DOM but has the same persistent-runtime problem:
  activity and authored work share an incarnation and lineage latch.

Those facts affect admission, provenance, expiry, cleanup, and audit—not the
capability vocabulary. A host capability available to EvalDO should also be
requestable by a dynamic chat/worker execution unless its receiver contract requires a
relationship that the iframe or worker does not possess. That is an ordinary receiver
constraint, not a second authority tier.

## Execution behavior and UX

Authored MDX, widgets, document JSX, and `client_eval` are allowed to perform effects
during rendering if the user has delegated the necessary authority. The system should
not invent a mandatory click boundary that does not exist for eval.

The ordinary authority behavior is enough:

- no applicable grant: suspend at the first protected effect and present acquisition;
- once grant: bind to and consume on the exact invocation;
- task or agent grant: proceed silently while its constraints and lineage remain valid;
- a newly observed outside-content lineage class: standing authority stops until
  that class is reviewed;
- critical effect: fresh exact-invocation confirmation;
- replayed MDX: a new invocation, so consumed grants do not revive.

The approval card attributes all relevant facts:

- the visible containing panel and exact iframe build/incarnation;
- every authority-relevant contributor and agent/task binding in the iframe realm;
- host-observed message, widget, `client_eval`, or document-fragment dispatch context
  when available, without claiming exact same-realm call attribution;
- the concrete effect and resource;
- outside-content lineage changes;
- the scope being offered.

Approval presentation must resolve the iframe through its entity ancestry to the
nearest visible panel, as worker/DO/eval presentation already does, and then enrich it
with host-owned iframe and execution context. The primary copy uses recognizable
product entities rather than opaque runtime ids:

- headline: the requested action and concrete resource;
- primary requester: the authoring agent, “Interactive chat content,” or the exact
  executable document fragment;
- location: `in <containing panel title>`;
- breadcrumb: `<panel title> › <agent/task when present> › <message, widget, eval, or
document fragment>`;
- details: exact source message, invocation, or document state; iframe build;
  incarnation; lineage change; and technical runtime id.

For example, prefer “Research agent in Project Chat wants to write `reports/q3.md`”
over “iframe:8f3… requests fs.writeFile.” If the realm contains multiple
authority-relevant authors or tasks, the card says so explicitly and does not offer a
narrow grant that the complete contributor set cannot satisfy. All labels, breadcrumbs,
and associations come from the host's entity/title/channel records; authored MDX
cannot provide approval chrome.

This is incremental without being noisy. Users may delegate broadly to an agent when
that is their intent, while a new agent, task, resource, outside-content class, or
critical action creates a precise delta. Exact outside-source keys remain in the
host-derived invocation record for audit and causal explanation, but standing grants
match reviewed lineage classes. A new source in an already reviewed class does not
prompt again.

## Userland-defined capability contract

A userland capability governs entry to a resource owned by workspace code. It cannot
authorize a host effect, credential use, protected publication, or another provider's
resource.

Definitions are sealed build/declaration input, never runtime registrations:

```ts
interface UserlandCapabilityDefinition {
  name: string;
  title: string;
  action: string;
  description?: string;
  tier: "gated" | "critical";
  sensitivity: "read" | "write" | "admin" | "destructive";
  resource: DeclarativeResourceDerivation;
  presentation: {
    domain: AuthorityDomainId;
    verb: AuthorityVerb;
  };
  grantScopes: readonly ("once" | "task" | "agent" | "session" | "version")[];
}
```

A receiver method references the local name:

```ts
@rpc({
  principals: ["code", "session"],
  effect: {
    kind: "userland-capability",
    capability: "scratch-buffer.write",
    resource: { kind: "argument", path: ["handle"] },
  },
  tier: "gated",
  sensitivity: "write",
})
async updateScratchBuffer(input: { handle: SharedScratchBufferHandle; text: string }) {
  // Invoked only after host receiver enforcement.
}
```

The canonical capability identity is namespaced by the exact provider build and exact
definition:

```text
userland:<provider-repo-path>@<provider-execution-digest>/<local-capability-name>#<definition-digest>
```

Provider paths and local names have one validated canonical encoding, and both digests
are host-derived from sealed build inputs. The same exact identity is stored in grants,
locks, invocation snapshots, preflight results, audit records, and receiver
attestations. Any provider rebuild or definition change creates a different capability
identity and cannot reuse an existing once, task, agent, session, or version grant.
Logical provider name and package version remain presentation and discovery metadata;
there is no cross-build grant-compatibility path.

Installed callers declare the single provider-bound definition family
`userland:<provider-repo-path>/<local-capability-name>#*` with bounded-dynamic
evidence. The wildcard covers only definition revisions for that provider and
local name; runtime requirements, decisions, and grants always carry the full
definition digest, and no general capability wildcard is admitted.

### Resource derivation

Resource derivation must be host-verifiable and declarative. Supported forms should
include:

- exact opaque handle argument;
- validated scalar argument path with a fixed namespace prefix;
- target runtime/entity identity;
- receiver-owned object key;
- a composition of the above.

The host must not execute provider JavaScript to decide what the approval protects.
Complex preparation can return a host-sealed opaque handle first, after which the
effect method consumes that exact handle.

### Host-sealed resource handles

A handle's wire representation is an unguessable opaque id. Its meaning lives only in a
host-owned record:

```ts
interface UserlandResourceHandleRecord {
  id: string;
  capability: string; // exact provider-build + definition identity
  receiver: {
    runtimeId: string;
    incarnation: string;
  };
  objectKey: string;
  presentation: {
    type: string;
    label: string;
  };
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}
```

The exact receiver build may issue a handle only through a declared handle-producing
method or declared host sealing operation. Issuance binds the live receiver
incarnation, exact capability definition, receiver-owned object key, and bounded
presentation. The host does not run provider code to interpret the object key.

Possessing or copying a handle selects a resource but grants no authority by itself.
The consuming invocation still needs an applicable grant and every required live
relationship. When transfer requires an ownership or delegation relationship, that
relationship is recorded through a host-mediated operation; copying the opaque string
does not create it.

The host rejects unknown, expired, revoked, wrong-provider, wrong-definition,
wrong-receiver, and stale-incarnation handles before receiver entry. Receiver teardown,
incarnation replacement, capability-definition change, or provider rebuild invalidates
its handles. A receiver that needs continuity must reissue handles from reconciled live
state; old ids are never silently rebound. Revocation is immediate and appears in
preflight, permission inventory, and audit history.

### Presentation

The provider supplies bounded structured copy:

- action verb;
- resource type and label;
- consequence/description;
- one reviewed authority domain and verb from the shared presentation vocabulary;
- optional positive evidence fields.

The host supplies immutable chrome showing provider title, source, exact version,
caller/agent, scope, tier, and resource. Provider copy cannot impersonate built-in
capabilities because userland names occupy a separate namespace and always display
their issuer.

A malicious provider can misdescribe its own resource, but granting it still cannot
authorize downstream host effects. Those receivers independently evaluate their own
capabilities against the original caller and delegation chain.

## Enforcement

Userland capabilities use the existing authority evaluator and grant store:

1. Resolve the live receiver and exact build.
2. Load its sealed receiver and capability declarations.
3. Derive the concrete resource from validated arguments or an opaque handle.
4. Canonicalize the caller from its authenticated logical session and build an
   invocation snapshot containing the iframe incarnation, complete contributor set,
   host-observed source/dispatch context, receiver version, capability-definition
   digest, resource, and host-maintained lineage.
5. Evaluate fixed caller intent or dynamic admission, grants, locks, receiver
   relationships, and tier.
6. Acquire or confirm through the existing rendezvous when allowed.
7. Stamp a short-lived exact attestation and invoke the receiver.
8. Propagate the original iframe caller, incarnation, complete contributor set,
   host-observed causal context when present, and lineage through every closure leg.

Missing declarations fail closed at receiver ingress. Caller grants cannot repair an
undeclared receiver, and a provider cannot settle its own host capability.

## Terminal and PTY receiver model

Terminal control is the first end-to-end receiver-authority migration target because it
demonstrates exact resource authority and eliminates the current confused deputy. It is
not the first example of a purely userland-owned capability: a PTY controls host
processes and therefore crosses the host-effect boundary.

The shell/PTY receiver owns the process, scrollback, input stream, and opaque session
handles. It declares reviewed host semantic capabilities:

| Capability        | Resource                      | Suggested tier |
| ----------------- | ----------------------------- | -------------- |
| `terminal.create` | terminal host/context         | gated          |
| `terminal.read`   | exact terminal session handle | gated          |
| `terminal.input`  | exact terminal session handle | gated          |
| `terminal.admin`  | exact terminal session handle | critical       |

These names identify effects at the shell/PTY receiver even when the first addressed
method belongs to a terminal panel. They are host capabilities, not userland
capabilities issued by the panel.

The terminal panel is the local UI and an ordinary delegating receiver. Local keyboard
input is a direct user gesture and does not traverse cross-runtime authority. The panel
receives its session handles from the shell/PTY receiver through the declared creation
flow and may use them through its local UI relationship.

Another panel, worker, or dynamically admitted iframe receives or names a handle only
through an intentional host-recorded relationship/delegation. A task-scoped grant such
as “let this agent control Terminal 3 for this task” permits repeated reads and input
without per-keystroke prompts.

Automated noninteractive commands should prefer the canonical shell execution API.
Raw `terminal.input` is for controlling an interactive session and is intentionally a
separate, broader resource authority.

When a cross-runtime caller addresses a terminal method, the host resolves the
terminal method and downstream shell method to the same canonical PTY capability and
resource handle. One authority decision covers that causal closure; the panel does not
create a second approval gate. The original caller and terminal delegation remain in
the authenticated invocation chain through shell receiver entry. The terminal panel's
identity cannot replace the caller merely because it presents the PTY.

Userland capabilities may separately protect resources actually owned by terminal
workspace code, such as a shared scratch buffer or terminal-specific collaboration
object. They cannot authorize PTY creation, reading, input, signals, or disposal.

## Receiver-enforced userland capabilities

Workspace receivers declare sealed capability definitions and the host enforces them
at every dispatch boundary. There is no advisory custom-choice authorization API,
parallel grant lookup, stored-choice conversion, or compatibility path. Secret-input
collection remains a distinct input surface because it returns user data rather than
an authority decision.

Non-authorizing product choices with more than allow/deny are application state, not
capabilities. They should use an ordinary trusted form/interaction API. This keeps the
authority ledger about exercise permission rather than turning it into a generic
preference database.

## Required invariants

- Dynamic mode is sealed into the exact iframe build and cannot be requested at
  runtime.
- Every iframe incarnation has its own host-minted principal and revocable logical RPC
  session; it never acts as the containing panel.
- An iframe has its own caller and entity kind. It is context-attached and
  panel-parented but never acquires a panel slot, panel lease, or direct-human
  classification.
- The iframe receives a private logical-session port, never physical-transport
  credentials or a direct host connection.
- The containing panel controls frame lifecycle and trusted UI but is not in the
  iframe's RPC data plane.
- Caller, incarnation, containment, owner, context, complete contributor set, admitted
  sources, and lineage are canonicalized from host state. Frame-supplied identity or
  provenance fields have no authority meaning.
- Browser confinement is permanent. A grant never relaxes iframe sandbox flags, CSP,
  navigation, IPC, or network-egress policy.
- Dynamic code cannot supply, clear, downgrade, replace, or fork its host-maintained
  contributors or lineage. Exact outside-source keys are host-derived; grants match
  only the host's canonical projection to reviewed lineage classes.
- Authored UI cannot mint user origin. Trusted container/host interaction surfaces are
  the only source of user-origin facts, and user interaction does not cleanse authored
  lineage.
- Shared-realm code cannot select a narrower contributor/task origin per call. Agent-
  or task-scoped standing authority applies only when the lineage domain's complete
  monotonic agent-contributor set is compatible with that scope.
- Transcript MDX, `client_eval`, inline UI, custom feedback, action bars, custom
  message renderers, packages, and scope that can exchange browser objects share the
  chat iframe principal and lineage domain.
- A custom feedback or authored-widget callback is an interactive-content result, not
  a user-origin assertion. Security-bearing user assertions cross a trusted typed
  host surface.
- Spectrolite's trusted contenteditable/editor realm never executes document-authored
  JavaScript. Executable JSX runs in child iframe principals whose open-document
  lineage domain comes from canonical VCS provenance.
- Spectrolite admits executable source only from the exact state/source seal returned
  after recording the editor's semantic working mutation; no DOM-only source or
  provenance path exists.
- Suggestion acceptance records agent contribution plus user review; it never
  reauthors accepted bytes as solely user-origin.
- Transport identity never becomes authority by itself.
- Fixed units remain manifest-bounded.
- Dynamically admitted runtimes bypass only the fixed request ceiling; they do not bypass grants,
  locks, tier, lineage, mission, relationship, or receiver checks.
- Userland capabilities authorize only their declaring provider's receiver resources.
- Original caller, incarnation, complete contributor set, host-observed causal context when
  present, and lineage survive intermediaries.
- Capability definitions and generated docs never mint grants.
- A provider-build or definition change cannot reuse an existing grant.
- Critical effects always require a fresh exact-invocation confirmation.
- Multiple browser frames cannot be treated as independent clean lineage domains unless
  direct cross-frame communication is prevented by a stronger compartment boundary.
- Approval copy resolves the iframe to a recognizable owning panel and author/task
  breadcrumb; opaque ids and authored labels are never the primary identity.
- Headless tests use host-attested test policy over the same path, never a production
  bypass.

## Implementation order

1. Add the `"iframe"` caller/entity kind and refactor caller-kind decisions into
   exhaustive orthogonal traits. Audit every wire union, schema, identity resolver,
   context service, catalog filter, grant serializer, relay, receiver boundary,
   presence classifier, and lifecycle hook before enabling an iframe connection.
2. Add dynamic authority admission independently of caller kind, then add iframe
   principals, incarnations, logical sessions, causal execution records, complete
   contributor sets, shared lineage domains, and monotonic lineage to the shared RPC
   and authority model.
3. Add host-owned iframe entity creation and relationships: exact parent panel runtime,
   stable owning panel slot, inherited context/subject, nearest-panel traversal,
   default child placement, and teardown with the container incarnation.
4. Extend approval requester identity and trusted desktop/mobile copy with a
   user-facing `interactive-content` category, owning-panel title,
   agent/task/source breadcrumbs,
   mixed-contributor disclosure, and technical details.
5. Add the host-side iframe session multiplexer and private `MessagePort` transport.
   Canonicalize every inbound envelope from its port binding, preserve the iframe as
   original caller through closure legs, and make existing panel IPC main-frame-only.
6. Add the permanently sandboxed iframe bootstrap, iframe-specific CSP/navigation/
   egress enforcement, and an iframe `RuntimeHost` adapter. Extend runtime-surface
   parity tests so panel, worker, EvalDO, and iframe expose the same portable API.
7. Move the dynamic transcript, MDX evaluation, `client_eval`, inline UI, custom
   feedback bodies, action bars, custom message renderers, package/module state,
   console streaming, and durable provenance-bearing scope into one persistent iframe.
8. Reduce the trusted chat container to channel state, iframe lifecycle and placement,
   schema feedback, composer/user-origin interactions, and authority UI; collapse its
   fixed manifest to that baseline. Mark authored callbacks as interactive-content
   results and add typed trusted confirmation for results that must become user-origin.
9. Add authenticated mutation contributors, review/integration edges, and exact-state
   resource-slice provenance projection to semantic VCS. Migrate Spectrolite
   suggestion acceptance away from reauthoring accepted text as a normal user edit.
10. Move each Spectrolite live JSX block into a sandboxed iframe principal, replace
    panel globals and React-context backdoors with typed brokers, and bind all block
    frames for one open document to its shared lineage domain.
11. Add userland capability definitions to build metadata and direct receiver
    enforcement.
12. Migrate terminal receiver methods onto shell/PTY-owned host capabilities and
    preserve the original caller through the terminal closure into shell.
13. Migrate existing userland approval gates and remove the old authorization path.
14. Extend live docs, preflight, permission inventory, revocation, and system-test
    policy to the new namespace.

This order creates one authority system and one shared physical transport. The dynamic
iframe has a first-class logical caller identity, not a parallel capability ledger, a
panel-forwarded pseudo-identity, or a terminal-specific exception.
