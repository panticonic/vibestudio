# Panel Surface & Runtime Entity Architecture

Status: proposed (2026-07-27). Written after a browser-panel outage traced to the
entity-creation path; see §1.3. Reconciles with the runtime-entity model in
`packages/shared/src/runtime/entitySpec.ts` and the authority model in
`capability-model-redesign.md`.

> Scope: how panels (workspace code and web documents), workers, Durable Objects,
> apps, and sessions come into existence, and what a *browser* panel must be able
> to do for the product to feel like a browser rather than a viewer.

## 1. What is wrong today

### 1.1 One entity model, five preparation paths

`RuntimeEntityCreateSpec` is a clean discriminated union and every principal
shares an identity shape. `activateEntity` then discards that symmetry: each kind
gets a bespoke branch with its own preparation hook and its own idea of what an
"incarnation" needs.

| Kind | Preparation | Build artifact | Execution identity | Target id |
| --- | --- | --- | --- | --- |
| `do` | `hooks.prepareDurableObject` | required | required | from hook |
| `worker` | `hooks.prepareWorker` | required | required | from hook |
| `app` | `hooks.resolveAppExecution` | required | required | canonical |
| `panel` (code) | `hooks.preparePanel` | required | required | canonical |
| `panel` (browser) | *none* | none | none | canonical |
| `session` | *none* (inert) | none | none | canonical |

Four hooks with four different signatures, returning four differently-shaped
"prepared" records that all get funnelled into the same `activateInput`. Nothing
enforces that a new kind supplies the right shape; the checks are per-branch
`if` statements.

### 1.2 Two lifecycles, only one of them general

Code panels use a two-phase lifecycle — `reservePanelEntity` mints identity and
context, `activatePanelEntity` seals the build — so a slot can exist durably
before its image is ready. Every other kind is single-phase. The reason for the
split (deferred build) applies just as well to workers and DOs; the reason it
was built only for panels is that panels are what the tree renders eagerly.

### 1.3 "Browser panel" is a string prefix, checked in every layer

A browser panel is identified by `source.startsWith("browser:")`. That test is
independently re-implemented or imported in at least six places: `panelChrome`
(canonical helpers), `panelManager` (four separate sites), `panelView`,
`ownerPanelTreeBridge`, `runtimeService`, and the `preparePanel` hook in
`src/server/index.ts`.

This directly caused a production outage. `preparePanel` correctly returns
`{ effectiveVersion: "" }` for `browser:` sources — no build to select — while
`activateEntity`'s panel branch required an immutable BuildV2 artifact for *any*
`kind: "panel"`. Every browser panel creation threw
`preparation did not select an immutable BuildV2 artifact`. Because
`panelView.setupWindowOpenInterception` routes ordinary `target="_blank"` clicks
through the same path, **no link in any browser panel could open**, and the
browser-import flow could not open a single tab.

It survived review because `panelManager`'s tests stub the runtime service, so
`createBrowser` was never exercised against the real `activateEntity`. A fix is
in (`runtimeService` now branches on the surface before requiring a build) but
the shape that allowed it is unchanged: *surface* is inferred from a string
rather than declared, and the type system cannot see it.

### 1.4 Identity, titles, and the `name` trap

`PanelTreeCreateOptionsSchema.name` was documented as "display name override"
while `panelManager` used it as the panel's id segment (`{parentId}/{name}`) and
always took the title from the manifest. Six of seven call sites passed a human
label — including page titles, which repeat constantly — so ids collided
silently, and a collision reused an existing slot's preparation while reserving a
fresh entity. Fixed by splitting `title` (label) from `slug` (opt-in identity),
but the lesson generalizes: **identity must never be derived from display text**,
and the contract must not describe a field it does not implement.

### 1.5 Restrictions that have no principled basis

- `isOpenPanelBrowserUrl` admits only `http(s):`, `data:`, and `about:blank`, and
  everything else fails with one undifferentiated "This link type is not
  supported" — including `mailto:` and `tel:`, which should hand off to the OS,
  and `view-source:`. The scheme set is defensible; treating every excluded
  scheme as an error is not. (`file://` stays excluded on purpose — §3.1.)
- Site permissions live outside the capability model entirely, in their own
  table reached through a host-only service, so "what may this site do?" is
  answered by different machinery from every other authority question — and by a
  channel its only caller cannot legally use (§2.2).
- Reservation is refused for browser sources (a correct guard today, but it
  encodes "external documents cannot be deferred", which is a lifecycle
  accident rather than a decision).
- A panel's slot history and its `webContents` history are separate stacks.
  `navigateHistory` moves the slot; `viewManager.goBack` moves the page. Nothing
  composes them, so "back" means different things depending on which control the
  user reaches for.

## 2. The model

Two orthogonal axes, both explicit in the type system.

**Axis 1 — kind**: what hosts the entity and what its lifecycle is (`panel`,
`app`, `worker`, `do`, `session`). Unchanged.

**Axis 2 — execution**: where the running code comes from. This is new, and it
replaces every `startsWith("browser:")` test.

```ts
type CodeExecution = { surface: "code"; source: RepoPath; ref?: RuntimeEntityBuildRef };
type ExternalDocument = { surface: "external"; url: string };   // one incarnation, one document

type RuntimeEntityCreateSpec =
  | { kind: "panel"; execution: CodeExecution | ExternalDocument }
  | { kind: "app" | "worker" | "do"; execution: CodeExecution }
  | { kind: "session"; execution: { surface: "inert" } };
```

The axis is **kind-indexed**, not free-floating: an external worker or an
external DO must be unrepresentable, and a session has no execution at all. A
browser panel is not a code panel with missing fields; it is a different
inhabitant, and the compiler knows a build key is unavailable rather than
absent.

**Incarnations do not navigate — slots do.** This is existing behaviour: a
committed navigation to a *different* URL fires `did-navigate`, which calls
`replaceCurrentSnapshot` → `replaceHistoryAtCurrent`, minting a new entity with
`source: "browser:<newUrl>"` in place of the current history entry
(`panelView.ts:528`, `panelManager.ts:1475`). Code panels do the same on
`navigate()`, appending rather than replacing.

The precise invariant is **one incarnation per distinct committed external
URL** — not "one incarnation, one document". A reload of the same URL mints
nothing, and `did-navigate-in-page` (same-document `pushState`) only updates
live state.

**The sealed origin is attribution, never the enforcement input.** Replacement
is asynchronous and its failure is currently discarded
(`void …replaceCurrentSnapshot(…).catch(() => {})`, `panelView.ts:592`). The
target architecture keeps browser navigation responsive without pretending the
durable replacement has already committed: Electron mints an exact document
epoch at main-frame commit, presentation readiness refers to that live document,
while durable incarnation provenance may still lag. Authority decisions read
Electron's live, validated requesting and top-level origin at the moment of the
decision. The incarnation remains durable provenance, not the enforcement input
and not a prerequisite for revealing ordinary navigation.

Ordering overlapping durable replacements and defining restart behaviour after a
failed replacement require a separate browser-navigation durability design. The
panel-presentation cutover deliberately does not invent that transaction protocol.

### 2.1 One preparation contract

Replace the four hooks with one, returning a closed union:

```ts
type PreparedIncarnation =
  | { surface: "code"; target: TargetBinding; effectiveVersion: string;
      buildKey: BuildKey; executionDigest: Digest; authority: UnitAuthorityManifest }
  | { surface: "external"; target: TargetBinding; document: DocumentFacts }
  | { surface: "inert"; target: TargetBinding };

function prepare<S extends RuntimeEntityCreateSpec>(
  spec: S
): Promise<PreparedFor<S["execution"]>>;
```

The result is **discriminated and correlated with its input**. A single
interface with an `identity` union would let a worker preparation type-check
while returning an external identity, and would force a meaningless
`effectiveVersion: ""` onto external and inert entities. Only the code arm has a
version, a build, or an authority manifest, because only code has them.

`DocumentFacts` carries the committed URL and its security origin for
provenance — not grants, and not an enforcement input (above).

`activateEntity` then has no per-kind identity logic: it asks the host to prepare
the incarnation, and persists whichever identity came back. Per-kind differences
(a DO needs a class name; a worker needs env and a parent binding) stay in the
*spec*, where they belong, not in the activation branch.

The immediate win: adding a sixth kind, or a third surface, cannot silently skip
an identity requirement, because there is exactly one place that consumes it.

### 2.2 Site permissions are user grants scoped to an origin

Web content has no representable authority today, and the four capabilities it
can already hold — camera, microphone, geolocation, notifications — live in a
table beside the capability model rather than inside it:

```ts
BrowserPermissionGrantSchema = { origin, capability, decision, scope, updatedAt }
authority: { principals: ["host"] }        // the decision belongs to the host
```

**Neither the panel nor the origin can be the grant subject.** D5 is explicit
that an entity is "attribution and lifetime only — never a grant subject", so
the panel is the *exerciser*, not the holder. And a subject must be something we
can authenticate — a user, a host, a code unit pinned by digest, a session, a
mission. We cannot authenticate a website; we can only observe which origin is
currently loaded. Adding `origin:` to `AuthorizationOrigin` would put an
unverifiable principal into a union whose entire value is verifiability.

**The camera is the user's.** What a permission prompt actually establishes is a
statement about the *user's* authority, scoped to the site that may invoke it:

```
subject:    user:<userId>                                   // an existing principal
capability: browser.camera
resource:   { kind: "exact", key: "<environmentKey>|https://meet.google.com" }
```

The origin is the **resource**, which is exactly what resource scoping exists
for. Nothing new enters the subject algebra: `ownerUserId` is the subject, and
the profile boundary is folded into the resource key.

Folding rather than constraining is deliberate. `AuthorityGrantConstraints` is a
closed set — `sessionId`, `invocationDigest`, `missionSubject`, `envelopeId`,
`lineageAtConsent`, `taskRef`, `agentBindingId` — with no browser-environment
fact in the evaluation context, so `constraints: { environmentKey }` is not
representable today and adding it would mean a new authenticated fact plumbed
through `grantConstraintsMatch`. The resource key already needs to be exact and
opaque; carrying the environment in it costs nothing and keeps the evaluator
untouched.

**"Session scope" needs its own mechanism.** `constraints.sessionId` matches
`context.session.id` — the RPC authority session — which has nothing to do with
a browsing session. A grant that should last "while I'm using this site" needs a
**browser-session epoch**: a value minted per browser-environment start, folded
into the grant (or held in a session-tier store), with startup cleanup that
drops the previous epoch's grants. Without that, "session" silently means
"forever", which is the one outcome a permission prompt must never produce.

Origin resource keys are **exact**. Prefix scoping over sites is banned — not
because matching is unsafe (`scopeCovers` requires a `/` boundary, so
`https://google.com` cannot be tricked into covering `https://google.com.evil`)
but because "every site under this one" is not a decision a user can meaningfully
make about a camera.

**Origins are not strings.** Model the security origin as a tuple
(scheme, host, port) *or* an opaque nonce, and make the durable grant resource
optional — an opaque origin has no key and therefore no durable grant, ever.
Serializing opaque as `"null"` would alias unrelated documents into one grant,
which is the worst possible failure here. Scheme alone does not decide this:
per the URL Standard a `blob:` URL normally *inherits* its creator environment's
origin and is only sometimes opaque. Resolve the security origin from Electron's
frame and request details, never by parsing the URL.

**Navigation stops being a problem.** Incarnations do not navigate — slots do
(§2.1) — so an incarnation seals exactly one origin, and a decision keyed on
that origin cannot go stale. Crossing an origin produces a different incarnation
and therefore a different resource key. The open web navigates freely: there is
no origin pinning, permission lease, or per-panel permission mode. A browser slot
continues to use the existing cross-host `PanelRuntimeLease`, as code panels do,
because navigation writes shared durable slot history and therefore needs one
authoritative host writer. That runtime lease carries no site-authority meaning;
its scoping and replacement semantics are not redesigned by the presentation
lifecycle.

**Automation, where an existing rule does half the work.** When an agent calls a
service, the acting subject is `session:<id>` and grant sets **never union**
(`authorityRuntime.ts`: "a call may carry several authenticated facts, but
exactly one principal authorizes it"), so an agent cannot invoke a service under
the user's authority. That is the confused-deputy boundary working as designed.

It does not cover the permission callback, because that is not a service call.
Electron's callback names no subject: it fires from the *page*. The environment
owner is the natural subject — the environment is derived from workspace and
verified user — but then any page can reach the owner's grants, including a page
an agent is driving.

Navigation cause is **not** a sufficient guard here. An agent can attach raw CDP
to a page the user opened and call `getUserMedia()` without navigating at all,
leaving any `navigatedBy: "user"` marking untouched. The policy input must be
**current automation control**, which the bridge already tracks as a live 0↔1
attach state per target (`cdpBridge.ts` `clientConnections`, `firstForTarget`):

- while a view is under CDP control, physical-world capabilities are **refused,
  not prompted**;
- detaching does not immediately clear it. Script scheduled before a disconnect
  keeps running, so the view stays **tainted** until an explicit trusted user
  navigation or document recreation — a lifecycle event, not a timer;
- `navigatedBy` remains useful for provenance and for the "who opened this?"
  question, but it is not the gate.

**The origin then becomes the default resource for everything a browser panel
touches** — network egress, downloads, clipboard, autofill, popups — not just
the four web permissions. Each is a decision about a site, all key the same way,
and the scattered surfaces answering fragments of that question today
(`getSitePreferences`, `setSiteZoom`, the permissions panel, the downloads
service) become views over one grant set with one revocation.

Enforcement stays where it belongs — Electron's permission callback — but
resolves against the canonical grant store instead of a parallel table. **A
main-process projection must remain**: `setPermissionCheckHandler` is
synchronous and cannot await a store read, which is exactly why the controller
keeps a local map today. What goes away is the host-only channel and its polling
refresh, replaced by an event-fed cache over the canonical store. That is what
removes the host-principal mismatch — the feed changes shape, not merely the
rows' address.

Nothing user-visible changes: the prompt is still "youtube.com wants to use your
microphone", the answer still applies to that site across the profile, and the
permissions panel still lists sites.

### 2.3 One creation entry point

Today a panel can be created through `panelOrchestrator.createPanel`,
`createBrowserUrlPanel`, `panelManager.create`, `createBrowser`,
`createFromSource`, `createAboutPanel`, the `ownerPanelTreeBridge` create case,
and — for navigation and history traversal — three further direct
`runtime.createEntity` calls. They differ in defaults (root vs child, focus,
placement, owner stamping) and each re-derives the surface.

Collapse to one:

```ts
panelTree.create(execution, options)   // execution is the union from §2
```

`createBrowserUrlPanel` becomes `create({ surface: "external", url }, …)`;
`createAboutPanel` becomes `create({ surface: "code", source: "about/x" }, …)`.
Convenience wrappers may remain, but they must be thin argument adapters with no
independent policy.

## 3. Behaving like a browser

The tree is the differentiator and should stay; everything else users expect from
a browser should be present and unsurprising.

### 3.1 Schemes

Replace the allowlist regex with a policy table keyed by scheme:

| Scheme | Disposition |
| --- | --- |
| `http`, `https` | browser panel |
| `file` | **refused.** See below |
| `data`, `blob`, `about:blank` | browser panel, opaque origin — never a grant resource |
| `vibestudio:` (managed) | translated to a panel/source link (already) |
| `mailto`, `tel`, other OS schemes | hand to the OS via `openExternal`, with confirmation |
| `javascript:` | refused (correct today) |

`file://` stays unavailable. The local-document use cases it would serve — a
generated PDF, a build report — are better served over the workspace origin we
already run, which gives them a real origin that fits the model in §2.2; anything
else belongs to the OS via `openExternal`. Supporting `file:` would mean
distinguishing a user-selected PDF from `file:///etc/passwd` requested by
automation, which needs path-bounded file-handle authority rather than a scheme
disposition. CDP already refuses non-http navigation deliberately
(`panelCdpService.test.ts`), and that stays true.

Opaque origins (`data:`, `blob:`, `about:blank`) form no usable origin resource
key and never receive durable grants (§2.2).

### 3.2 History

Compose the two stacks instead of exposing both. A single ordered history per
slot, where entries are either a *source change* (slot history: panel navigated
from `panels/a` to `panels/b`, or to a URL) or an *in-document navigation*
(`webContents` history). `back` pops whichever is on top. This is what a browser
tab does when you navigate from one site to another and back; the fact that one
of our "sites" may be workspace code should not be visible in the control.

### 3.3 Tabs, windows, and the tree

A browser's tab strip is a flat list per window; ours is a tree. The mapping that
makes both intelligible:

- **Tab ≈ panel.** Already true.
- **Window ≈ a collection panel** (`about/collection`), which is what the
  browser-import flow now creates per source window. This generalizes: any group
  of panels a user wants to treat as a unit is a collection.
- **Tab groups ≈ nested collections.** Depth is **operationally limited to
  100**: `PanelRegistry` stops ancestor and selected-path walks there, so beyond
  it descendant checks and focus-path updates quietly stop being correct. Treat
  100 as the working limit rather than a cycle guard, and note that id length
  grows with depth since each level appends `/{source}/{nonce}`.
- **Session restore ≈ the durable slot tree**, which we already have and browsers
  approximate with a session store.

### 3.4 Already correct, keep

Link interception with disposition mapping (`new-window`/`foreground-tab` →
sibling, otherwise child; `background-tab` → unfocused), favicon capture,
history recording with title updates, downloads, per-site zoom, and one shared
cookie jar across browser panels with ordinary per-origin cookies inside it.
These are good and should not be disturbed by the refactor.

## 4. Migration

Each phase is independently shippable and leaves the tree working.

**P1 — Name the surface.** Add `execution` to `RuntimeEntityCreateSpec` as a
**required** field, resolved once at the create boundary; `activateEntity`
branches on it instead of the source prefix. An optional field would allow a
spec whose `execution` and `source: "browser:<url>"` disagree and would keep the
sniffing alive behind a fallback — violating this plan's own invariant. Persisted
records keep `source: "browser:<url>"` and are migrated separately; there is no
runtime fallback path.

**P2 — Site permissions as user grants scoped to an origin** (§2.2). Migrate the
four web permissions into the canonical grant store as
`user:<id> × browser.<capability> × exact origin`, constrained by
`environmentKey`; delete the standalone table; replace the polling projection
with an event-fed cache. No new subject kind, no change to
`AuthorizationOrigin`.

This phase comes second because a live defect depends on it: the host-only
`browserPermissions.snapshot` is uncallable by its only caller — Electron main
is never `hostOriginated` — which currently stops the browser environment from
starting at all. Removing the host-only channel is the fix; widening what "host"
means is not. User-facing behaviour is unchanged.

P2 is not done until it also defines: the **browser-session epoch** and its
startup cleanup (§2.2 — `constraints.sessionId` is the RPC session and will not
serve); the **security-origin representation** (tuple vs opaque nonce, resolved
from frame details, with no durable grant for opaque); and the **automation
control input** to the callback (live CDP attach state plus taint, §2.2). Each
is a prerequisite, not a follow-up: shipping the store migration without them
would turn "allow for this session" into "allow forever".

**P3 — One preparation contract.** Introduce `PreparedIncarnation`; migrate the
four hooks behind it one kind at a time (`app` is smallest, `do` largest).
Remove `requireActiveExecutionIdentity`'s callers as each moves.

**P4 — Collapse the creation entry points** to `panelTree.create(execution, …)`,
rewriting the orchestrator and bridge wrappers as adapters. This is the phase
that removes the remaining `startsWith("browser:")` tests.

**P5 — Extend origin-scoped resources to the rest of the site surface**: egress,
downloads, clipboard, autofill, popups. Each is a decision about a site and
should key the same way, so "what can this site do?" has one answer and one
revocation.

**P6 — Scheme policy** (§3.1). Small and user-visible; do it when the plumbing
beneath is uniform.

**P6b — Measure incarnation churn.** Every committed navigation to a distinct
URL mints an entity, so ordinary browsing produces entities at human-click rate.
Redirects are *not* a multiplier: only `did-navigate` is observed, which fires
once when the main-frame navigation completes; `did-redirect-navigation` is a
separate event nothing listens to. Measure real churn and entity-GC pressure
before optimizing — this is a property of the existing design, but the plan
leans on it harder.

**P7 — Unified history** (§3.2), which needs a design of its own before it can
be called shippable. Slot history is durable and each entry selects an entity
and context; Chromium's history is ephemeral inside `webContents`. "Pop whichever
is on top" requires a persisted ordering that survives redirects, same-document
navigation, entry replacement, forward truncation, view destruction, and
restart. That schema and its event-ordering contract are the deliverable; the UI
change is the easy part.

**P8 — Generalize reservation** to any buildable kind, or delete the two-phase
path if P3 makes deferred activation expressible without it.

## 5. Invariants to hold on to

1. **Identity is never derived from display text.** Titles are labels; ids come
   from a nonce or an explicit `slug` whose uniqueness the caller owns (§1.4).
2. **A contract describes what the implementation does.** The `name` field
   claimed a behaviour that did not exist for as long as it existed.
3. **Every authority exercise has an authenticatable subject.** "No authority"
   must mean an empty envelope held by someone, not the absence of a model. A
   surface that cannot be authenticated is a *resource* in someone else's grant,
   never a principal (§2.2, invariant 7).
4. **Surfaces are declared, not sniffed.** No layer below the boundary should
   parse a source string to learn what it is holding.
5. **Test at the layer that enforces.** The browser-panel outage was invisible
   to `panelManager`'s tests because they stub the enforcing service; the
   regression tests for it live in `runtimeService.test.ts`.
6. **A cleaner model must not produce a stranger browser.** Where our
   architecture and browser convention disagree about user-visible behaviour —
   cookie scope, permission scope, what "back" does — convention wins. The
   internals may gain structure; the browser must still behave like one.
7. **Only authenticatable things are subjects.** A website is observed, never
   authenticated, so it is a resource. When something needs authority but cannot
   be authenticated, the question to ask is "whose authority is this, and what is
   it scoped to?" — not "how do we make this a principal?".
