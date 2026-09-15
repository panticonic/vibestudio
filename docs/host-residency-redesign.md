# Host Residency & Tier Redesign

Status: implemented 2026-07-30; conventional and live validation are tracked
separately in `docs/userland-gad-capabilities-prerequisite-plan.md` and
`docs/official-template-repositories-plan.md`.
Companion to `capability-model-redesign.md` (authority core — this plan builds on its
shipped machinery and changes none of its semantics), the system-agent spec set, and
`workspace-template-composition-plan.md`. Responds to the 2026-07 external architecture
review; where this document disagrees with that review, this document is canonical.

> Scope note: the system is pre-release and self-contained. Every migration in this
> plan is a destructive cutover — move ownership, update all consumers and docs, delete
> the old surface in the same change. No compatibility façades, no deprecation windows,
> no parallel old/new paths (H6).

## 1. Pre-cutover diagnosis, measured

The following figures are the 2026-07-29 baseline that motivated this plan,
not the current implementation state:

- **551 distinct enforced host methods over 66 services** (57 schema tables in
  `packages/service-schemas/src/contract.test.ts`, plus 9 handler-only services such as
  `panelCdp`, `adblock`, `workers`). 55 methods are declared on _both_ the server and
  main RPC planes. The full authority ledger, counting the workspace-DO plane, is 940
  rows.
- **166,806 non-test TypeScript lines** across `src/server` (136,669), `src/main`
  (27,309), and `apps/headless-host` (2,828).
- **~57,700 lines of authority metadata**: 7,360 TS lines under
  `packages/shared/src/authority/**` + approval copy, plus the generated 38,617-line
  `docs/runtime-foundations/authority-ledger.json` and 11,720 lines of golden matrices.
- A gated host method is registered in **~9 distinct sites with ~25 hand-written
  fields**: schema declaration, contract-test table, handler, golden matrix, tierTable
  row with prose rationale, capability presentation, capability group, domain/verb
  classification, ledger row — several enforced as compile errors or exact-set tests.
- **152 of 551 methods (28%) are panel-related**, with six snapshot entry points and
  five navigation surfaces over the same browser view.
- There is **exactly one product-sealed workspace service** (`gad.workspace`, the
  semantic control plane). Adding a second requires ~9 hand-edited touch points
  (catalog `.mjs` + hand-written `.d.mts`, `INTERNAL_DO_CLASSES`,
  `internalDoExecutionCatalog.json`, class re-export, a hardcoded single-pair
  boundary-linter exemption, tsconfig alias, bootstrap ordering), and
  `isSemanticControlPlane` is a bespoke bypass predicate threaded through
  `workerdManager` at six sites.
- Builtin methods are **less precisely described than userland**: they bypass the
  dispatcher's schema validation and tier registration; 67 of the control plane's 72
  methods are attested `open` at the host boundary via a 5-name hardcoded census
  (`authority/directMethodEffects.ts`). General read-only SQL over the whole semantic
  graph is open-tier to any workspace code through **two** entry points: `rawSql` and
  `query`, the latter a literal one-line alias of the former
  (the former workspace-source package implementation).
- The one attempted domain migration without a platform underneath —
  `workspace/extensions/browser-data` — produced a **1,164-line façade**: every byte of
  browser data still lives in a host-internal DO; the extension forwards. `git-bridge`
  is a _partial_ real transfer: the bridge genuinely owns checkout state, export/push
  sequencing, and auto-push scheduling, but the host `gitInterop` handlers still run
  git-domain validation, config-mutation callbacks, provider propagation, and
  reconciliation scheduling around the generic protected write
  (`src/server/services/gitInteropService.ts:133-276`).

**The conclusion is not "the host is bloated, move things out." It is: code accretes
where the platform is paved.** The host has a complete, type-error-guided developer
experience; the builtin tier has none. Product logic landed in the host because the host
was the only place with a road. This plan paves the builtin tier first, makes host
residency machine-justified, and then runs the migrations — each of which then becomes
mostly mechanical.

**Raw host mass is a goal in its own right, and this plan is honest about how much of
it it removes.** The migrations and deletions here take the host tree from ~167k
non-test lines to an estimated ~130–145k (development bookkeeping, templates,
missions, panel veneers, browser DO, gitInterop domain handlers, dual-plane and
lifecycle duplicates, dead code, and ~4.5k of hand-written metadata). The remainder is
infrastructure — `buildV2` (~11k), the workerd manager, the RPC server, `viewManager`,
`vcsHost`, egress/credentials, and `src/server/index.ts` at **~37k lines of top-level
wiring**. Residency cannot shrink that; only infrastructure simplification can
(decomposing `index.ts`, reducing `buildV2` to artifact contracts with
declarative/extension build drivers, transport-stack audit). That work is scoped in
**`host-infrastructure-simplification-plan.md`** — a placeholder artifact until it is
picked up, existing so this reference resolves to something reviewable rather than a
promise — and H14's mass metrics exist so the difference between "moved out" and
"still there" stays visible after every phase.

## 2. Trust model and tier vocabulary

Nothing here changes the capability model. Trust remains: context given to the agent ×
code identity of the harness; users are not threats to each other; the untrusted party
is content. This plan names the **execution tiers** that already exist and assigns each
a default job:

| Tier | Name         | Runtime                                                       | Identity / blessing                                                                                                                                                                     | Default contents                                                                                          |
| ---- | ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0    | **kernel**   | Node/Electron host processes                                  | host build fingerprint                                                                                                                                                                  | Only methods whose _irreducible operation_ is a kernel authority (H2)                                     |
| 1    | **builtin**  | workerd internal-DO bundle, SES-locked                        | execution identity over exact bundle bytes × class × reviewed authority (`internalDoLoader.ts`); catalog-registered, namespace-preempting; **product source outside `workspace/`** (H3) | Product domain logic and state: immutable/blessed behavior that does **not** need Node/Electron authority |
| 2    | **userland** | workerd workspace units, panels; extensions as Node processes | `code:<repoPath>@<effectiveVersion>` + manifests; extensions via elevated approval (`unitVersionApprovalStore`)                                                                         | Everything replaceable; extensions **only** for unavoidable native effects                                |

**What "builtin" means.** Builtin-ness is an _inbound_ property: nothing in the
workspace can change what the code **is** — not its bytes (digest-pinned execution
identity), not what its protocol name resolves to (namespace preemption, key
sealing), not the gap between reviewed and running (identity fixed even across
concurrent rebuilds). It protects against workspace mutation and substitution — the
relevant adversary being agent-written code under content influence, and honest
corruption, in a userland that is _deliberately_ self-rewriting. It does not
restrict **use**: workspace code calls builtin services freely per their tiers and
reads their open surfaces. The orthogonal _outbound_ property is **sandboxed** —
what the code can do to the world (workerd + declared ceiling, no Node, no ambient
FS). Kernel code is neither sandboxed nor workspace-mutable; userland is sandboxed
and mutable; builtin is both. Note the asymmetry: kernel code is _also_
workspace-immutable — the builtin tier's distinction from the kernel is not
immutability but the **absence of authority**; its distinction from userland is not
the sandbox but the immutability. Migrating a domain kernel→builtin changes what its
code _can do_, never what the workspace can do to it. (Terminology: the codebase
currently calls this pattern "product-sealed"; P2's vocabulary sweep renames it to
**builtin** everywhere.) The three `builtinBecause` reasons (H1) are the
three kinds of promises that need such a fixed point: authority decisions, data
survival, and the repair path.

Four principles, stated once and used as review language everywhere:

1. **Enforcing a decision ≠ owning the domain object.** The kernel validates an exact
   approved closure and mints/revokes grants; it does not need to own the mission
   document (H11).
2. **Blessed ≠ host-resident.** Builtin code has the same review/immutability story as
   kernel code with categorically less blast radius (no Node, no ambient FS, host
   capability ceiling declared in the catalog).
3. **Extensions do not shrink the trusted computing base.** An extension is a full Node
   process. Moving logic to an extension improves replaceability only. Policy and state
   go to tier 1; extensions keep native brokerage.
4. **Security friction is bounded by the dangerous surface.** Per the capability
   model, approval friction belongs only on credentials, external egress, and
   destructive/protected operations. A residency move is never a reason for new
   friction: no flow that is promptless today becomes prompted, and no interactive
   path gains perceptible latency, because code changed tiers. A migration that needs
   new prompts to feel "safe" is mislocating enforcement, and a reviewer argument of
   the form "this surface is broad, gate it" is rejected unless it names the concrete
   dangerous operation.

The residency razor — _"could an unrelated third-party product use this mechanism
unchanged?"_ — governs **where code lives**, not how abstract its API must be. It is
not a mandate to generalize interfaces for hypothetical third parties.

## 3. Decision record

### H1 — Three named tiers; userland is the default home for product behavior, builtin is the exception with a named reason

The tier vocabulary of §2 becomes canonical in `workspace/skills/architecture/SKILL.md`
and `docs/architecture/rpc-and-services.md`. New product behavior lands in tier 1 or 2
unless its H2 residency reason says otherwise. "It needs to be immutable" or "it is
security-relevant product behavior" are **not** kernel residency reasons — that is what
the builtin tier is for.

Between tiers 1 and 2, the default is **userland** — product-seeded, workspace-visible,
editable, forkable (most product features already live there: the shell, Gmail/News
workers, terminal, local-models, git-bridge). Making a service builtin removes it from the
workspace's reach, which narrows the everything-is-replaceable ambition, so it carries
its own justification burden — the **builtin test**, mirroring H2: a builtin service's
catalog entry declares exactly one `builtinBecause` from a closed set:

- `feeds-authority` — its outputs or integrity claims are relied on by kernel
  authorization, attestation, or approval rendering (compiled closures, workspace
  topology, or ingress verification);
- `durable-data` — it holds data whose corruption or loss is not acceptable collateral
  of a workspace edit (browser data);
- `recovery-path` — it must keep functioning when the workspace is broken, because it
  is how the workspace gets repaired (the system agent surface, per the spark-session
  design).

Declaration presence is machine-checked like everything else in the catalog; the
substance is review-checked. A service that satisfies none of the three ships as
seeded userland. The builtin tier must not become the new accretion zone — it is a
concession the product makes reluctantly, one named reason at a time, and H14 tracks
its method count as an advisory metric.

**The builtin test is re-applied at each service's migration phase.** A claim made in
this document is a hypothesis, not an inheritance (templates' contested demotion in
P7 is the precedent, not an exception). The current roster, with each claim's
honest strength and the mechanism that would dissolve it:

| Service                                   | Claim                  | Movable to userland?                                                                                                                                                                                                             | Dissolving mechanism                                                                |
| ----------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| workspace source / semantic control plane | none; seeded userland  | **Yes — required by the userland-GAD prerequisite plan.** Exact-root bootstrap, conduit review, immutable execution identity, and transactional self-update break the fixed point without host-resident product code.            | Already dissolved by the singular userland-GAD cut.                                 |
| `EvalDO` (engine)                         | feeds-authority        | No — isolates co-resident untrusted guests and stamps attribution/lineage facts.                                                                                                                                                 | None while evals share an isolate.                                                  |
| `WebhookStoreDO` (engine)                 | feeds-authority        | No — verifier config authenticates external ingress.                                                                                                                                                                             | Kernel-side verification would demote the remainder to userland config.             |
| `WorkspaceDO`                             | feeds-authority        | Core no (entity records, slot ownership/context binding, lease/alarm rows feed attestation and access decisions); presentation rows (titles, search index, navigation history) could be userland — deferred as low-value churn.  | An authority-rows/presentation-rows split; **re-test in P5b**.                      |
| `browser.data`                            | durable-data           | Contingent: the claim rests heavily on passwords/form-fill.                                                                                                                                                                      | Credential-vault split (+ a protected-storage/backup primitive); **re-test in P4**. |
| missions                                  | feeds-authority        | A chosen trade-off, not a necessity: kernel-_mechanical_ rendering of compiled exposures would make a userland compiler unable to misrepresent approvals — at the cost of approval legibility. Builtin buys a trusted presenter. | Mechanical approval rendering, if the UX is acceptable; **re-test in P8**.          |
| system-agent surface                      | recovery-path          | Plausibly yes: the recovery property already comes from product-snapshot pinning + conduit blessing of the _userland_ `SystemAgentWorker`, not from tier residency.                                                              | Pinned userland (below); **re-test in P8**.                                         |
| templates                                 | feeds-authority (weak) | Likely yes — contested in favor of userland (P7).                                                                                                                                                                                | Already argued; publication is kernel-gated regardless.                             |

The roster surfaces a general alternative: **pinned userland** — conduit blessing +
product-snapshot pinning already give userland code a fixed-point property with no
tier change (the system agent runs this way today). Where a builtin claim is
recovery-path or presentation-trust, pinned userland is evaluated **first**; tier 1
is reached for only when the claim requires namespace preemption or
non-workspace-resident state, and the re-test at each migration phase records which
alternative was considered and why it lost.

**Companion lever — userland capabilities**
(`dynamic-vessels-and-userland-capabilities.md`): the strongest remaining force
pushing product code toward kernel or builtin residency is that only host methods get
real approval enforcement today (browser-data's advisory `GATED_METHODS` layer is the
symptom). Receiver-enforced userland capabilities — builtin declarations, declarative
resource derivation, host-sealed opaque handles, evaluated by the existing authority
core — remove that force: **"needs real enforcement" is never a residency or builtin
reason once that plan lands.** Its cutover also deletes kernel surface outright
(`userlandApproval.*`, 8 methods, plus its parallel grant lookup) and its terminal/PTY
receiver model reshapes development's native-terminal methods into exact
resource-handle authority (consumed by P9). The two plans share the evaluator and the
no-façade rule; its work is sequenced independently, but it is a **completion
dependency** of this plan — its companion markers block the H14 criterion (H2, §4).

### H2 — Every kernel method carries a machine-checked residency reason, and the reason must be irreducible

A closed enum, **exactly one value** per host method, enforced the same way tiers are
(exact-set test, no default, missing = build error). A durable (non-legacy) label is
subject to the **irreducible-effect rule**:

> A kernel method performs exactly one irreducible kernel operation. Domain
> validation, orchestration, policy decisions, projections, and follow-up actions are
> prepared and sequenced outside the kernel; the kernel validates the prepared input
> and performs the operation.

During migration, a method that mixed a kernel operation with product workflow could
not borrow the kernel operation's durable label. The temporary migration marker
described below made that debt explicit while later phases extracted it.

| `residency`           | Irreducible operation                                                                                                          | Explicitly excluded                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `identity`            | Establish/verify who a user, device, session, or peer host is                                                                  | profile/preference workflows                                                                            |
| `secret`              | Hold, inject, or exercise credential material; audience-bound egress                                                           | choosing _what_ to fetch; interpreting fetched content                                                  |
| `protected-write`     | Validate and atomically commit an **already-prepared exact mutation** against a protected target (ref CAS, config transaction) | computing the mutation; domain interpretation of its contents; follow-up propagation                    |
| `grant-authority`     | Mint/revoke/settle grants, approvals, blessings, admission verdicts                                                            | the domain object the grant is _about_                                                                  |
| `untrusted-execution` | Build provenance; create/isolate/retire an execution; context boundaries                                                       | product-specific launch workflows                                                                       |
| `native-effect`       | One directly-scoped native operation (view, pty, spawn, OS open, device call)                                                  | any multi-step workflow that merely _ends_ in a native call                                             |
| `supervision`         | Clocks, leases, exactly-once dispatch, process state, health observation                                                       | scheduling _policy_ (what runs when lives in config/userland)                                           |
| `transport`           | Authenticate and move an **opaque envelope**; resolve a service; ingress                                                       | domain-aware selection, fan-out policy, persistent product state — a forwarding façade is not transport |
| `observability`       | Raw structured ingestion and bounded reads                                                                                     | interpretation, aggregation policy, incident workflows                                                  |

The migration temporarily permitted **`legacy-product:<decision>`**, only with a
reference to the migration decision in this plan (e.g. `legacy-product:H13`). Per
project convention, these carry **no expiry dates**; each is retired by the lifecycle
event of its migration landing, and the H14 ratchet forbids new ones and tracks the
count monotonically down. Every `legacy-product` reference must resolve to a phase in
§4 (H15/P9 included) **or to a milestone of an enumerated companion plan** — currently
exactly one: `dynamic-vessels-and-userland-capabilities.md`, which owns the
`userlandApproval.*` retirement. An unreferenced or plan-external marker is a build
error, so no marker can be indefinite by construction; companion-plan markers count in
the ratchet and blocked the H14 completion criterion exactly like phase markers.

**Post-cutover state:** the count reached zero and the marker enum, parser, digest,
baseline field, and ownership list were deleted. A `legacy-product:*` value is now
simply invalid. "Product workflow", "aggregation", and "convenience" are
unrepresentable.

**Enforcement is honest about its layers** — no build check can prove a handler
performs exactly one irreducible operation, and this plan does not pretend one can:

1. _Machine-checked_: label presence, enum validity, plan-reference resolution, the
   H14 ratchets — build errors.
2. _Machine-assisted_: a **residency import lint**, built on the existing
   boundary-checker. Because residency is per-method while imports are per-module,
   the lint's unit is the **residency-homogeneous handler module**: a durably-labeled
   handler must live in a module whose handlers all share its residency value (the
   extraction out of a mixed module is part of the same graduation PR that flips the
   label — see H14's relabel rule), and the module's import allowlist follows its
   single residency — `native-effect` and `transport` modules may not import domain
   packages or config-mutation helpers; `protected-write` modules may import
   canonical-form, digest, and validation code only; `supervision` modules may not
   import schedule-policy code. Modules still containing any `legacy-product`
   handler (e.g. `gitInteropService.ts` throughout P1) are lint-exempt but counted
   in a ratcheted **mixed-module baseline** (H14). Coarse, but it mechanically
   catches flagrant mixing of exactly the kind `gitInteropService` exhibits today —
   once its durable handlers graduate into pure modules.
3. _Review-checked_: the irreducible-effect judgment itself, applied per method via a
   `tier-audit-rubric.md` checklist at the P1 census and re-applied whenever a
   labeled handler's diff touches it.

A corollary used throughout: **a proposed kernel primitive that seems to need two
residency values is a composition**, and compositions live in builtin or userland code
over existing single-reason primitives (see H10's discovery operation, which this
rule reclassified).

Placement: at P1 the field is added to the `tierTable.ts` row shape
(`{tier, session, rationale, residency}`) since that census already covers every
method; at P3 it moves into the single declaration site with everything else. It is
surfaced into the generated ledger.

### H3 — Builtin-service catalog v2 + scaffold: one declaration, everything derived

Replace the hand-maintained builtin-service plumbing with a single typed catalog entry
from which every touch point is generated or read:

- **Source of truth lives in `packages/service-schemas`** (module
  `productWorkspaceServices.ts`), so a catalog entry references its method table (H4)
  as a **direct typed import** — compile-time cohesion, not a stringly `methodsRef`
  resolved by generators. Consumers that cannot depend on `service-schemas` — the
  plain-Node generator scripts and `packages/shared` — consume **generated,
  checked-in projections** (the `.mjs` + `.d.mts`, and shared-side tables), the same
  pattern H5 uses for authority metadata. The hand-written
  `packages/shared/src/productWorkspaceServices.mjs`/`.d.mts` become generated
  artifacts with drift tests.
- **Builtin source is product source and lives outside `workspace/`.** Builtin
  implementations live under `packages/builtin/<name>` and consume product packages.
  Workspace-side consumers resolve builtin services by protocol and import only their
  wire schemas. Conversely, the workspace-source control plane is deliberately
  userland and is never imported or bundled by the host: exact-root bootstrap builds
  it from the pinned workspace snapshot. The host/workspace boundary therefore has
  zero exemptions and no exemption mechanism.
- Catalog entry gains fields: the typed method-table import (H4), `builtinBecause`
  (H1's builtin test — exactly one of `feeds-authority | durable-data | recovery-path`,
  required, no default), `hostCapabilityRequests`, `durableObject.keyVersion`, and
  `workerd` properties (`injectWorkspaceId`, `bootstrapPhase: "first" | "normal"`,
  `staticAuthorityProjection`).
- **`hostCapabilityRequests` are part of the builtin artifact's execution identity**
  (input to the recipe/execution digest, like the reviewed authority manifest today)
  and are declared at capability granularity **with method scoping**: a request names
  the builtin methods permitted to exercise it. A catalog entry must not silently grant
  every method of a large builtin service the union of all requests.
- **Generated/derived from the catalog**: `INTERNAL_DO_CLASSES`,
  `internalDoExecutionCatalog.json`, the builtin portion of
  `reviewedInternalDurableObjectTargets.ts` (unifying the two internal-DO catalogs that
  nothing statically ties together today), `src/server/internalDOs/index.ts`
  re-exports, and bootstrap registration order. (No linter exemptions — none exist
  after the source relocation above.)
- **`isSemanticControlPlane` is deleted.** Workspace-source startup and handoff use
  the finite manifest-selected `WorkspaceSourceProviderV1`; builtin startup reads only
  catalog properties.
- **Every internal DO class is resolved in P2** into exactly one of: (a) a cataloged
  builtin _service_ (product surface, typed methods, tiers); (b) a cataloged builtin
  _infrastructure engine_ with no product service surface (methods reachable only via
  kernel-internal dispatch); or (c) **deleted within P2 itself** — the phase ends with
  zero uncataloged classes, not with deletion IOUs. Classification of the five
  current classes (`internalDoLoader.ts`): `BrowserDataDO` → builtin service (P4 moves
  it; P2 catalogs it); `WorkspaceDO` →
  builtin service — it already owns entities, slots, alarms, and recurring rows, and
  P5b puts panel product policy on it; `EvalDO` → builtin execution engine;
  `WebhookStoreDO` → builtin infrastructure engine (verified: it is the durable
  backing store for generic webhook ingress, `webhookIngressService.ts`). The H14
  "internal DO classes outside the builtin catalog → 0" metric is satisfied at the end
  of P2 by construction.
- `scripts/scaffold-builtin-service.mjs` emits a new catalog entry, schema table stub,
  DO class stub extending `DurableObjectBase`, and runs the generators. Target
  developer experience: **a new builtin service is one catalog entry, one schema table,
  one class.**

### H4 — Builtin methods get typed schemas and tiers — parity with host services

- Builtin service methods are declared with the same `defineServiceMethods` machinery
  host services use, in a schema table imported by the catalog entry (H3). The
  existing `gadWireMethods` (`workspace/packages/runtime/src/shared/gad-schema.ts`)
  is unified into this table rather than living as a workspace-side copy.
- The DO side validates args/returns against the table on receive (in
  `DurableObjectBase`, alongside the existing `directRpcEnforcement` check); the host
  side derives **per-method tier/sensitivity attestation from the table**, replacing
  the hardcoded 5-name census in `authority/directMethodEffects.ts` and the
  "everything else is open/read" fallback in `workerdManager`. The table supports the
  same `authority`/`authorityPreparation` declarations host methods have, evaluated at
  the existing host attestation point (the relay/attester) — this is the named
  mechanism P5b's panel access control and any future builtin-method resource scoping
  rely on; builtin services do not reimplement admission ad hoc.
- **There is no general SQL receiver method.** The later userland-GAD prerequisite
  review supersedes the earlier proposal to retain one read-only query escape hatch.
  `rawSql` and `query` are both deleted. Every supported diagnostic or semantic read
  has a named, typed method whose bounded result contract is declared in
  `gadWireMethods`; adding a use case extends that contract instead of reopening an
  untyped database language at the authority boundary.

### H5 — One declaration site per host method; all projections generated

Fold the per-method metadata into the schema declaration's `authority` block:
`tier`, `session`, `rationale`, `residency`, `family` (all four from the tierTable
row shape P1 established), `capability`,
`presentation` (`{title, action, description, group}` from
`hostCapabilityPresentations.ts`), capability-group membership (inverted from
`hostMethodCapabilities.ts` `GROUPS`), and the capability's `{domain, verb}` (from
`capabilityDomains.ts`, keyed by capability and declared at its first/owning method or
in a small capability-level registry inside the schema package).

Because `packages/shared` must not import `packages/service-schemas` (dependency
direction), the shared-side tables become **checked-in generated files** produced by a
build step from the schema declarations, with drift tests — the same pattern as the
ledger and the H3 catalog projections. Hand-maintained sources deleted:
`tierTable.ts` (3,050 lines), `hostCapabilityPresentations.ts` (1,258),
`hostMethodCapabilities.ts`, `capabilityDomains.ts` as hand-edited files. The
exact-set tests (`tierTable.test.ts`, the `PromptableHostMethod` compile gates)
convert to generator drift checks — the _enforcement_ (no method without
tier/capability/presentation) moves into the schema-table type so it remains a compile
error, just in one place.

Explicit non-goal: friction-as-deterrent. Declaring a kernel method becomes cheap
(**two hand-touched sites: schema declaration + handler**); the deterrent against
kernel growth is H2's closed enum and irreducible-effect rule, not paperwork.

### H6 — The no-façade rule

Every ownership migration in this plan: move the state and logic, repoint every
consumer, delete the old service + schema + capabilities + presentation copy + storage

- tests + docs entries **in the same change**, and update the H14 baselines downward.
  Pre-release data policy, decided per domain in its phase: either a one-shot import
  script run at first boot, or a clean reset where the data is cheap. Never a standing
  dual-read path.

Corollary — **no migrations for dead code**: before building any landing zone,
confirm production call sites exist. A surface with none is deleted outright with its
clients, types, and config schema; if the underlying feature is still wanted, it is
introduced deliberately where it belongs, never ported as a compatibility seed
(H12's `settings` chain is the first application).

### H7 — Browser data becomes the second builtin service; the extension shrinks to native brokerage

The audited facts: `BrowserDataDO` already extends the shared `DurableObjectBase`; its
15 tables, AES-GCM code, and `@rpc` policies run in workerd unchanged; the "password
encryption" key is stored in the DO's own state table (a co-located key, not a host
privilege boundary); the only genuinely native pieces — Electron cookie-jar projection
(`src/main/services/browserCookieProjection.ts`) and `DownloadItem`/`shell` control
(`browserDownloadManager.ts`) — already live in Electron main and are merely proxied
through the extension.

The cutover:

- New builtin service `browser.data`, protocol `vibestudio.browser-data.v1`, via the H3
  scaffold. The class keeps its name and object key so **DO SQLite storage carries over
  with zero data migration**; only the source location moves
  (`packages/builtin/src/browser-data/BrowserDataDO.ts` → the builtin bundle's package).
- The 68 extension-provider methods become builtin service methods with real tiers
  (password/form-fill reads gated — genuinely secret-bearing; bookmarks/history/
  preferences biased **open** per §2 principle 4 — reading your own browsing data from
  trusted workspace code powers features and is not the dangerous surface). The
  extension's advisory `GATED_METHODS`/approval layer is deleted — the acquisition
  flow is now the real and only gate, and because grants are durable
  (once/session/standing), previously-gated flows prompt the same or less
  (friction parity applies through the standard §4 phase checklist).
- All consumers (`packages/browser-data` client, Electron main, panels) switch from
  `extensions.invokeProvider("browserData", …)` to protocol resolution of the builtin
  service. The `browserData` provider slot shrinks to **import brokerage only**
  (native profile reads for Chrome/Firefox import) and gains host-contract validation
  like `gitInterop` has. Expected outcome is an extension of a few hundred lines — an
  indicator, not a gate; the acceptance criterion is structural (no data-shaped
  methods remain).
- `browserEnvironment` (30 methods, declared on both planes) is culled to the native
  subset (download control, cookie projection, native import reads) declared once,
  each method satisfying H2's one-scoped-native-operation rule.
- The bespoke `BrowserDataDO` entry in `reviewedInternalDurableObjectTargets.ts` and
  the broker-repo-path relationship rule are replaced by ordinary builtin-catalog
  principals.

This is deliberately the **proving migration** for H3/H4: it exercises the scaffold,
the schema table, per-method tiers, and the acquisition flow from tier 1, on a domain
with zero storage risk.

### H8 — One supervision contract; public creation convergence deferred, not rejected

Two layers, in order:

1. **One internal driver contract first.** Every executable-unit kind (worker, DO,
   panel, extension, app/hostTarget) implements a common `UnitDriver` contract with a
   **mandatory core** every running entity has: identity, artifact/execution digest,
   status, health, logs, restart, retirement. Versioning and rollback are properties
   of _releases_, not of running entities (today they are app-unit-specific,
   `workspace.ts` hostTargets/units), so they form an optional **release facet**
   implemented only by kinds with release/artifact identity (apps, extensions;
   ref-pinned workers if the census warrants). `describe` reports which facets a unit
   has; a facet's absence is a typed fact, not an unsupported-operation branch; and
   rollback always addresses a **release identity**, never a runtime entity id — so
   it can never silently target something other than what was named. Per-kind
   drivers own kind mechanics; the supervisor never reinterprets per-kind product
   semantics. This is the guard against H8 itself becoming the kind of unifying
   façade H6 prohibits — a `{kind, id}` switch over unrelated managers is **not**
   acceptable as the implementation.
2. **One public surface over that contract**: `runtime.supervision.*` (residency
   `supervision`), with **two key spaces, never mixed**: core verbs (`list`,
   `describe`, `health`, `logs`, `restart`) address a **runtime entity**
   (`{kind, entityId}`); release verbs (`versions`, `rollback`) address a **release**
   (`{kind, releaseId}`), and there is no entity-keyed rollback at all. The surface
   is semantically uniform because the contract underneath is.

Deleted in the same change:

- `workspace.units.*` (8 methods — list/inspector/restart/logs/diagnostics/versions/
  rollback/bakeAppDist; bake moves under `build`).
- `extensions.{list, ready, health, log, reload}` and `build.doctorExtension` (folds
  into `describe`/`health`). `extensions.{invoke, invokeProvider, invokeStream,
streamingMethods, emit, fetchRequestBodyChunk, fetchRequestBodyClose}` remain — they
  are transport under H2's opacity rule (authenticated envelope movement; provider
  _selection_ stays declarative in workspace config, not in the transport methods).
- `panelTree.{rebuildPanel, unload}` and other restart-shaped duplicates identified in
  the P6 sweep.
- `workspace.hostTargets.{list, versions}` fold in. The launch flow is split per H2,
  not kept whole: the kernel retains only **elevated-approval settlement**
  (`grant-authority`, through the ordinary settlement machinery) and **generic
  activation** through the driver contract; the launch-session _state machine_ —
  phases, timelines, selection state, user-facing messaging
  (`beginLaunch`/`getLaunchSession` orchestration) — is product workflow and moves to
  its shell/builtin owner in P6. Its methods are census-marked
  `legacy-product:P6` in P1.

**Creation convergence is deferred, not rejected.** `runtime.createEntity` already
covers five kinds; extensions and apps differ chiefly in artifact preparation and
admission (provider contracts, elevated approval), which are plausibly _inputs to_ a
generic activation rather than a different entity identity. P6 therefore requires:
one underlying executable identity and activation lifecycle across all kinds at the
driver layer, with per-kind admission steps modeled as preparation. Whether the
_public_ creation APIs then merge is re-decided from the post-P6 census, not assumed
either way.

The `workspace.heartbeats.*` / `workspace-state` alarm-lease pair is examined in the
same sweep for consolidation into the supervision family, without changing the
driver/durable-row design (which is correctly factored: policy in workspace config,
durable rows in WorkspaceDO, kernel owns only the timer — residency `supervision`).

### H9 — Panels: dedupe first, then product policy descends to the builtin topology owner

The audit found the _state_ ownership already correct — `workspace-state`/WorkspaceDO
owns topology, layout/pins are deliberately client-local per-device JSON, native
effects are contained in `viewManager`/`viewService` — but the review is right that a
host-resident product-policy veneer has no valid H2 residency reason, "pure" or not.
`panelTreeService` is actually two things interleaved: **product policy** (method
access tables, navigation rules, open-source validation, agent allowlists) and
**authority glue** (context-boundary `authorityPreparation`, `verifiedInitiator`
caller discipline). Under H2 those have different homes. Two stages:

- **P5a — consolidation by deletion** (independent of the builtin platform): merge
  `panel` into `panelTree` as the single interim surface. Dedupe: focus (2
  implementations → 1), snapshots (6 entry points → `snapshot` + `getSubtree`),
  `ensureLoaded` (2 → 1), takeover (`panel.takeOver` / `panelTree.takeOver` /
  `panelRuntime.takeOver` → 1 + the lease acquire/release pair), titles
  (`panelTree.setTitle` remains the write path). Navigation gets exactly two
  surfaces: `panelTree.navigate`/`navigateHistory` for slot/product navigation, and
  the `view.browser*` family as the native adapter; `panelCdp`'s duplicate
  navigate/back/forward/reload/stop and
  `panel.markBrowserNavigationIntent`/`reloadView`/`forceReloadView` are deleted or
  folded. Dual-plane declarations end (the 17 `panelTree` + 9 `panelCdp` methods
  declared on both planes are declared once; transport routing handles the plane).
- **P5b — policy descent** (depends on P2, because it needs H3's cataloging of
  `WorkspaceDO` and H4's typed builtin methods): panel topology semantics and product
  navigation policy move onto the builtin `WorkspaceDO` service surface — the object
  that already owns the slot tree — eliminating the host round-trip
  (shell → host veneer → bridge → DO becomes shell → DO with host attestation). The
  kernel retains only: the authority glue (context-boundary preparation moves into the
  generic authority layer, not into the DO), lease/activation operations under
  `runtime` (residency `untrusted-execution`/`supervision`), and the native adapter
  (`view.*`, residency `native-effect`). The `panelTree` host façade is then
  **deleted**, not kept as a merged veneer.

Client-local stores (`panelLayoutStore`, `panelPinStore`, theme, palette) stay
client-local — that design decision (D6 of the panel plan) is reaffirmed. The audit
suggests P5a roughly halves the 152 kernel panel methods and P5b leaves only the
native/execution subset — expectations tracked as H14 ratchet baselines (which record
what landed), never acceptance gates: the acceptance criteria are structural (one
surface per concern, no dual-plane declarations, no method without an H2 reason), so
they cannot be satisfied by merging methods. Reconcile with
`multi-user-wp3-panel-forest.md`,
`panel-surface-architecture.md`, and `panel-locations.md` in the same changes.

### H10 — Templates move to a builtin service; the kernel keeps two domain-neutral primitives

`templatesService` already owns nothing (98 lines of delegation); the real logic —
the 1,015-line pure resolver, lock/fragment integrity verification, the operation
journal (`operations-v1.json`), the fingerprint-sealed composition journal, artifact
staging, catalog — is pure computation over content-addressed inputs.

- New builtin service `templates` (protocol `vibestudio.templates.v1`) owns the
  resolver, both journals (state moves into DO SQLite; one-shot import of the JSON
  journals, or reset — they are operation logs, cheap to lose pre-release), artifact
  staging, catalog, `status`/`check`/`inspect`, the add/remove/pull operation state
  machine, **and all pin/discovery semantics** — which snapshot to want is template
  domain knowledge. Builtin-test note (H1): templates' claim is `feeds-authority` (its
  lock/fragment integrity verification is what the publication approval renders and
  relies on), but it is the weakest entry on the builtin roster — the protected write
  itself is kernel-gated regardless of who prepared the plan. P7 re-examines this
  honestly; if the claim doesn't hold up, templates ships as **seeded userland**
  instead, with zero change to the kernel primitives either way.
- **The kernel gains no new git surface.** Snapshot acquisition — git protocol
  interpretation, credential-bound fetch, temporary checkout, snapshot construction,
  CAS landing — is a _composition_, not a primitive; the giveaway was that it wanted
  two residency values (H2's corollary), and an anonymous acquisition would not even
  exercise `secret`. It therefore moves to the component that already owns git
  protocol work: **git-bridge exposes an
  `acquireSnapshot(remote, ref | exactPin, credentialName) → CAS snapshot identity`
  provider operation** (host-validated contract, like the rest of `gitInterop`'s
  provider surface), built entirely on kernel primitives that already exist — the
  credentialed git-HTTP proxy (`secret`; untouched by anonymous fetches) and
  `vcs.importSnapshot`/blobstore for landing content. The builtin templates service
  consumes it over the extension transport; the template-specific
  `createTemplateGitClient` + `discoverPin` kernel path (`src/server/index.ts:1210`)
  is deleted outright.
- The one kernel operation templates keep calling directly: **protected publication**
  (residency `protected-write`) — the existing `vcs.semanticPublishCall` path, with
  the add/pull approval running through the standard acquisition flow (gated tier on
  the publish-affecting builtin methods), replacing the bespoke pending-card wiring in
  `src/server/index.ts`.
- Delete: `templates.*` host service (8 methods), the host-side lifecycle
  orchestration in `src/server/workspaceTemplates/` (relocated), its
  tier/presentation/ledger rows.

This is the first builtin service that **exercises a raised host-capability ceiling**
(H3's method-scoped `hostCapabilityRequests`) and approval acquisition from tier 1 —
the two platform features browser-data doesn't need.

### H11 — Reviewed execution closures: the kernel authority record goes generic; missions become a builtin compiler of it

The hot-path constraint stands: the enforcement readers (`factForSession`, the
exposure assertions) are called inline from ~8 sites in the host authorization path
and cannot depend on a workerd RPC. But that requires a host-owned **authorization
record**, not a host-owned **mission domain**. Keeping mission IDs, charters,
lifecycle verbs, and seeding in a kernel `missionAuthority` service would leave a
substantial mission subsystem in the kernel and invite every future durable-automation
type to mint its own domain-specific kernel service.

The kernel record is a generic **reviewed execution closure**:

```
subject                  (e.g. mission:<id>@<closureDigest> — existing grant algebra)
closureDigest            (over the compiled closure itself)
state                    active | suspended | retired
compiled service exposure
compiled userland-service bindings
compiled network audiences
harness identity          (conduit-blessing check target)
allow/deny grant linkage  (grant store, unchanged)
owner / issuer attestation
```

Kernel operations (residency `grant-authority`, except session binding which feeds
enforcement facts): `activateReviewedClosure` (settled through the **ordinary generic
approval flow** — there is no domain-specific `approve` method; what the user approves
_is_ the rendered compiled closure, provenance-linked to its source document),
`suspendClosure`, `retireClosure`, `bindSession`, `finishSession`. Grant mint/revoke
on activation, the conduit-blessing check, digest verification at activation and
session-bind, and the `grantStore.onAgentGrantWithdrawal` subscription all keep their
current semantics — they attach to the closure record instead of mission rows. The
enforcement readers evaluate **compiled exposures**, with zero charter interpretation
in the kernel. Two requirements so the load-bearing parts are named work, not
implication: (a) P8 defines the compiled-exposure schema and **rewrites the three
exposure assertions** (`assertServiceExposure`, `assertUserlandServiceExposure`,
`assertNetworkExposure`) over it, with a parity suite proving charter-evaluation and
compiled-evaluation verdicts agree on the existing mission fixtures and the
adversarial test plan before the charter path is deleted; (b) approval settlement
renders the **domain presentation supplied by the builtin service** (title, action,
human-readable scope — provenance-linked to the mission document), never a dump of
compiled sets: approving a mission must be at least as legible as it is today.

The builtin `missions` service owns the mission domain: IDs, drafts, `edit`, revision
history, seeded-mission behavior and fork rules, run history/outcome bookkeeping
(materialized from kernel-emitted session lifecycle events),
pause/resume/retire _semantics_ (translated to suspend/retire on the closure),
`proposePermissionRevision`/decline workflow, and all list/get presentation. It
**compiles** charters into closures and submits them for activation. `missions.db`
splits accordingly (closures + sessions derive into the kernel record; missions/
revisions/runs import one-shot into the builtin DO).

The generality is not speculative: scheduled/recurring jobs already produce
unit-change approvals with capability strings, and development's standing-grant
resolvers are a third candidate — all future durable automations activate reviewed
closures instead of adding kernel services.

**System agent follows.** `systemAgent.resolveConversation` is 133 lines of pure
composition (owner-key hash, `runtime.createContext`/`createEntity`, blessing check,
session binding, locked-channel init) gated by chrome trust. It moves into the builtin
system-agent surface once chrome trust is exposed as an authenticated caller fact and
`bindSession` is callable under a catalog-declared capability. The host `systemAgent`
service is then deleted. Reconcile `mission-subsystem-spec.md` and
`system-agent-design.md` (SA1 severity semantics unchanged — it classifies pending
approvals, which now include closure activations).

### H12 — Warm-up deletions: settings, onboardingStatus, palette

Small, but they establish the deletion discipline and the "no replacement host API"
rule in P1:

- **`settings.getData` is dead code — deleted, not migrated.** Verified 2026-07-29:
  zero production call sites (the shell exports a client wrapper nothing imports;
  mobile instantiates a client it never calls), and `centralConfig.models` is
  consumed only by the service itself. Per H6's dead-code rule the whole chain goes:
  the service, its schema and typed clients, `CentralConfig.models` and its loader
  schema, and the `ModelRoleConfig`/resolver types if the census confirms no other
  consumer. No seed into `ModelSettingsDO` — central config is profile-global and
  that service is workspace-scoped; seeding would mint stale per-workspace copies and
  a synchronization problem for a feature nobody calls. If model roles are wanted
  later, they are designed natively into model-settings.
- **`onboardingStatus.read`** (aggregation of `hub.listDevices` + `hub.listWorkspaces`
  - connection mode): the shell composes the same redacted projection client-side from
    calls it can already make as the user. Main service deleted.
- **`palette.*`** (4 methods over an in-memory orchestrator map): baseline palette
  commands become **declarative unit-manifest contributions** read by the shell;
  dynamic registration/dispatch moves to the existing panel↔chrome messaging channel
  (it is chrome UI state and never belonged on a host RPC service). Main service and
  orchestrator registry deleted.

### H13 — Git: complete the inversion; the kernel keeps domain-neutral primitives only

git-bridge is the right _direction_ — it genuinely owns checkout state, export/push
sequencing, and auto-push scheduling — but it is not yet a finished ownership
transfer, and the census must not paper over that: the host `gitInterop` config
handlers run git-domain validation, config-mutation callbacks, provider propagation,
and reconciliation scheduling around the protected write
(`gitInteropService.ts:133-276`). Under H2's irreducible-effect rule those methods are
`legacy-product:H13`, not `protected-write`. The cutover (P7):

- **The bridge prepares; the kernel applies.** Remote/upstream/auto-push changes are
  computed and validated in git-bridge as an **exact prepared config mutation**. The
  kernel applies it through a generic protected-config primitive whose contract is
  **digest-bound CAS, not prose**:
  `{target, expectedBaseDigest, canonical patch | nextState, resultDigest,
allowedPathScope}`, with the approval bound to the exact mutation digest — the same
  shape as protected-ref push (`expectedCommittedEventId`/`expectedMainEventId`).
  Anything looser is a confused-deputy primitive, so
  `persistWorkspaceConfigMutation`'s current run-this-domain-callback form does not
  survive. Git-domain config helpers (`setDeclaredRemoteInConfig` etc.) move to the
  bridge.
- **Propagation and reconciliation scheduling move to the bridge**, which already
  observes config and owns reconciliation execution (`upstream.ts`).
- **Credential resolution stays kernel** (`secret`): logical name → credential id
  binding and the git-HTTP egress proxy, unchanged. Template discovery consumes the
  bridge's `acquireSnapshot` provider operation (H10), so git protocol work has
  exactly one owner and the kernel gains no git methods.
- **Temporary remotes**: decided in P7 between (a) bridge-owned lifecycle over a
  generic, credential-free ephemeral-git-endpoint kernel primitive
  (`native-effect`/`transport`), or (b) full bridge ownership if no kernel resource is
  actually required. The current host-owned create/publish/inspect/remove workflow
  does not survive as-is.
- The `gitInterop` host service is reduced to domain-neutral primitives or deleted;
  the bridge's self-round-trip (calling host `gitInterop.*` to reach its own
  implementation) goes with it.

### H14 — Guardrails: structural invariants with advisory footprint measurements

A checked-in `docs/runtime-foundations/residency-baselines.json` is asserted by a
structural-invariant test. Zero-state architectural invariants fail closed; descriptive
counts and footprint measurements remain visible without becoming numeric acceptance
gates. Tracked:

- total kernel methods (551) and services (66) — **no numeric quota**; the invariant
  is "every method has a non-`legacy-product` residency reason satisfying the
  irreducible-effect rule";
- migration-only `legacy-product` count (monotonic down while the migration was
  active). It reached zero only after every structural phase landed; its ratchet
  field and the marker mechanism were then deleted, so no future declaration can
  represent migration debt as a residency;
- dual-plane method count (55 → 0 target via H9 and per-family sweeps);
- panel-family kernel method count (descriptive: records the P5a/P5b outcome; the
  gates are P5's structural criteria, not this number);
- internal DO classes outside the builtin catalog (→ 0; owned by H3's P2
  classification);
- lifecycle/status/log surfaces per unit kind (→ 1, H8);
- hand-written authority-metadata line count (→ generated only, H5);
- residency-mixed handler modules (monotonic down; new mixed modules forbidden — the
  import-lint exemption set, H2);
- **host-tree non-test line count** (`src/server` + `src/main` + `apps/headless-host`),
  **`src/server/index.ts` line count**, and **builtin-tree line count**
  (`packages/builtin/`) are advisory measurements. They make relocation and footprint
  trends reviewable, but do not reject legitimate kernel wiring or encourage packing
  behavior into fewer methods or lines. Orphaned construction code is rejected by
  review and focused ownership tests, not by a raw line budget. The infrastructure
  mass that remains after P9 (buildV2,
  workerd manager, RPC server, viewManager, vcsHost, index.ts decomposition) is the
  scope of `host-infrastructure-simplification-plan.md` (§1), not a claim this plan
  makes.

Advisory (reported, not gated): product nouns in kernel service names; extension
provider methods that immediately call a same-domain host service; per-family
duplicate-shaped methods (see the consolidation note below); builtin-tier method count
per `builtinBecause` reason (H1 — watching for the builtin tier becoming a new
accretion zone).

**Consolidation is a distinct outcome from residency, and this plan is explicit about
how much of it it delivers.** H2 legitimizes residency; it does not prevent a kernel
of many separately-named, individually-legitimate methods. The consolidation this
plan commits to is carried by its family sweeps — P5a (panels), P6 (lifecycle verbs),
the `browserEnvironment` cull (P4), the two-surface navigation rule (H9), the
digest-bound prepared-mutation primitive (H13) — each with structural acceptance
criteria. Going forward, fragmentation is policed, not gated, through the
**`family` field**: assigned per durable method in the P1 census (tierTable row),
carried into the H5 declaration block and its generators, surfaced in the ledger;
the census/review rubric asks "does an existing family member already perform this
operation with a parameter's difference?", and the per-family duplication metric
above is computed from the field, not from prose. Whole-kernel API minimalism is deliberately **not** a completion
criterion — that would reintroduce the quota failure mode — but a new kernel method
that duplicates a family member without retiring it is a review finding by rule.

### H15 — Development and phone provisioning: seam split early, migration as P9

`development.*` (29 methods) is the most active domain and composes native pieces
tightly. The audit shows its irreducibly native kernel is small — the pty registry
(`node-pty`), the spawn executor, sealed-binary verification for the local Claude
driver, and the isolated-host executor; session/run/repair bookkeeping is pure over
the store. Early (opportunistically from P2): refactor internally so the native
controller sits behind one narrow interface and bookkeeping is cleanly separable;
census-mark the workflow methods `legacy-product:P9`.

**P9 is a real phase of this plan, not a deferral**: development session/run/repair
bookkeeping, recipes, pagination, and authority-preparation payload construction move
to builtin code; the kernel retains the native controller methods (`native-effect`),
the executors (`untrusted-execution`), and standing-grant issuance via H11 closures
(`grant-authority`). Phone provisioning gets the same treatment in P9: the Electron
half's script-spawn and pairing calls are `native-effect`/`identity`; the server-side
proxy's provider selection and workflow are product policy and move to builtin or
shell code (under H2's transport opacity rule, domain-aware fan-out does not qualify
as `transport`). Per H14, the plan cannot be declared complete while their
`legacy-product` markers remain.

## 4. Phases

Dependency shape: P1 → P2 → {P3, P4, P5b} → {P6, P7} → P8 → P9. P5a depends only on
P1 and can run in parallel with P2–P4. **Completion has one external dependency**:
the userland-capabilities companion plan's `userlandApproval` cutover (H2 companion
markers) — its work is sequenced independently of these phases, but the H14
criterion cannot be met until it lands, so the completion graph is
P1→…→P9 **plus** that cutover. Every phase ends with: ledger/goldens regenerated,
H14 baselines updated downward, the §5 doc set updated for what changed, and a
**friction-parity check** (§2 principle 4): the set of prompted flows and the
interactive latency of previously promptless flows are unchanged unless the phase
explicitly touched the dangerous surface, with any delta listed in the PR.

### P1 — Residency census, gate, and warm-up deletions

1. Extend the tierTable row type with `residency` and `family` (the H14 mechanism
   family); extend `tierTable.test.ts` to require both for all methods; add the enum,
   the irreducible-effect rule, and the plan-reference validation for
   `legacy-product` markers to `packages/shared/src/serviceAuthority.ts`; surface
   both fields in the ledger generator.
2. Classify all 551 methods, and produce a **disposition table covering all 66
   services** — every family ends P1 either fully labeled with durable residency
   reasons or carrying `legacy-product:<phase>` markers; no family may be left
   unassigned, and a family that fits no existing phase forces a plan amendment in
   the same PR, not a dangling label. Expected large `legacy-product` blocks: mission
   (11, →H11/P8), templates (8, →H10/P7), gitInterop config/workflow methods
   (→H13/P7), development (28+) and `attachedHosts` (8) (→P9), panels
   (product-policy subset, →P5b), `browserEnvironment` data subset plus `autofill`
   and `adblock` policy (→P4), systemAgent (→P8), phone provisioning server half
   (→P9), `userlandApproval` (8, →the userland-capabilities companion plan per H2),
   the `hostTargets` launch-session workflow subset (→P6, per H8).
   Families expected to classify durably in place: `hubControl` core
   (`identity` — with its profile/handle subset audited honestly), `notification` /
   `menu` / `desktopEvents` (`native-effect`), `workers` / `eval` /
   `developmentClientExecutor` (`untrusted-execution`), log services
   (`observability`). Every durable row is also assigned its mechanism `family`
   during the same pass. The census output doubles as the authoritative work-list
   for P4–P9 and updates `tier-audit-rubric.md` with the residency question, the
   irreducible-effect rule, and the family-duplication question (H14).
3. Land H12 (three deletions), including consumer updates and doc/copy removal.
4. Add the H14 ratchet test + baselines file, including the completion criterion.

Acceptance: build fails on an unclassified method, an invalid or plan-unreferenced
marker, or a residency import-lint violation; the mixed-method judgment beyond what
the lint catches is recorded per method in the census review against the rubric
checklist (H2's enforcement layers — not claimed as a build check); the `settings`
chain deleted end to end per H12; `onboardingStatus`, `palette` gone with no
replacement host APIs.

### P2 — Builtin-service platform (H3 + H4)

1. Catalog v2 typed in `packages/service-schemas`; generators for the plain-Node
   `.mjs`/`.d.mts`, shared-side projections, `INTERNAL_DO_CLASSES`, execution catalog
   (with method-scoped `hostCapabilityRequests` folded into execution identity),
   reviewed-targets, re-exports; drift tests.
2. Complete the singular userland-GAD cut from the prerequisite plan:
   `workspace-source` is a manifest-declared workspace worker, startup resolves its
   protocol and exact source identity, and the host has no internal GAD bundle,
   product target, fallback, or source import. Delete the boundary exemption
   mechanism entirely.
3. Delete `isSemanticControlPlane`; convert the six `workerdManager` sites to catalog
   properties; make bootstrap ordering catalog-driven.
4. Resolve all four internal DO classes per H3 (cataloged service / cataloged
   engine / deleted **within this phase**); catalog `WorkspaceDO` as a builtin service
   (schema table seeded from its existing `workspace-state` surface) in preparation
   for P5b; catalog `EvalDO` as a builtin execution engine and `WebhookStoreDO` as a
   builtin infrastructure engine.
5. Builtin method schema table: unify `gadWireMethods`; receive-side validation in
   `DurableObjectBase`; host-side per-method attestation from the table; delete the
   `directMethodEffects` census.
6. Tier audit of the complete `GadWorkspaceDO` surface; delete `rawSql` and `query`
   per the userland-GAD prerequisite plan, and replace every required diagnostic with
   a named, bounded typed method.
7. `scaffold-builtin-service.mjs` + a docs page (`docs/architecture/builtin-services.md`)
   written from the scaffold's own output.

Acceptance: a demo builtin service stands up with one catalog entry + one schema table

- one class; `grep isSemanticControlPlane` is empty; the host↔workspace boundary
  linter passes with **zero exemptions** and no exemption mechanism; every internal DO
  class is cataloged or already deleted; every builtin method carries a tier; no general
  SQL entry point exists; the builtin dev loop works —
  rebuild-on-change, inspector attach, and log tailing for a builtin service are at
  parity with host-service development; parity/ledger tests green.

### P3 — Declaration consolidation (H5)

1. Extend `defineServiceMethods` authority block; migrate all services (mechanical,
   scriptable from the existing four tables).
2. Build-step generators for the shared-side tables; convert exact-set tests to drift
   tests; move the compile-error enforcement into the schema types.
3. Delete `tierTable.ts`, `hostCapabilityPresentations.ts`,
   `hostMethodCapabilities.ts`, `capabilityDomains.ts` as hand-written sources.

Acceptance: adding a gated method touches schema + handler only; net deletion of
~4,500 hand-written metadata lines; ledger byte-identical modulo ordering before/after
for unchanged methods.

### P4 — Browser-data cutover (H7)

As specified in H7. Order within the phase: scaffold the builtin service → move the DO
source + schema table with tiers → repoint `packages/browser-data` client and main
consumers → shrink the extension to import brokerage with a validated host contract →
cull `browserEnvironment` to the native single-plane subset → delete the provider
contract, advisory approval layer, bespoke reviewed-target entry, and dead schema/
capability/copy rows. The phase also settles the rest of the browser product family:
`autofill` and `adblock` get explicit dispositions (native session/Electron effects
retained under `native-effect`; rule/policy/data ownership follows the browser-data
pattern into builtin or userland code).

Acceptance: zero browser-domain tables under `src/server/internalDOs/`; the extension
exposes only import-brokerage and native-forwarding methods (no data reads/writes); no
consumer on `invokeProvider("browserData", …)` except import methods; existing browser
data readable after upgrade (same class/objectKey — verified by a boot-time check, not
a migration).

### P5a — Panel consolidation by deletion (H9) — parallel with P2–P4

Sweep order: merge `panel`→`panelTree` → collapse snapshots/focus/takeover → two-surface
navigation rule (delete `panelCdp` duplicates) → end dual-plane declarations →
`panelRuntime` fold-or-keep decision → regenerate goldens/ledger → update the three
panel docs + WP3.

Acceptance: exactly one method surface per concern (focus, snapshot + `getSubtree`,
load, takeover, navigation, titles); dual-plane count for the family = 0; all panel UI
flows exercised in the system tests pass. (Expected method count roughly halves —
recorded in the H14 baseline, not gated.)

### P5b — Panel policy descent (H9) — after P2

Move topology semantics and product navigation policy onto the builtin `WorkspaceDO`
service surface; relocate context-boundary authority preparation into the generic
authority layer; keep leases under `runtime` and native operations under `view`;
delete the `panelTree` host façade.

Acceptance: no kernel panel method without a `native-effect`/`untrusted-execution`/
`supervision` residency reason; shell panel operations round-trip shell→DO with host
attestation only; panel system tests green.

### P6 — Supervision convergence (H8)

Define and implement the internal `UnitDriver` contract across all kinds → introduce
`runtime.supervision.*` as a thin projection of it → repoint shell/dev-tooling
consumers → delete the enumerated surfaces → hostTargets launch split per H8: the
launch-session state machine (phases, timelines, selection, user-facing messaging)
moves to its shell/builtin owner, the kernel keeping only elevated-approval
settlement and driver activation → decide heartbeat/lease consolidation → update
`EXTENSIONS.md` lifecycle sections → produce the census on which public creation
convergence is re-decided.

Acceptance: one list/describe/health/logs/restart surface covering workers, DOs,
extensions, apps, and panels via the mandatory driver core; versions/rollback served
**only** for units exposing the release facet (apps, extensions; ref-pinned workers
if the census warrants) and addressed by release identity; facet absence is a typed
`describe` fact, with no unsupported-operation branches or kind switches in the
supervisor; `workspace.units` gone; extension lifecycle verbs gone from the
`extensions` service; a written creation-convergence decision.

### P7 — Git inversion + templates (H13 + H10)

**Git cutover landed.** `gitInterop` is no longer registered as a host service.
The manifest-selected git-bridge provider owns Git-domain behavior and invokes the
digest-bound `workspace.applyPreparedConfig` primitive for exact remote/upstream
changes. Reconciliation is driven by the generic protected-ref event. No
`legacy-product:P7` method remains. Template extraction remains part of this phase.

Shared first: the bridge's `acquireSnapshot` provider operation and the digest-bound
prepared-mutation form of the protected-config primitive. Then, in either order:
(a) git cutover — bridge-side config preparation, propagation, and reconciliation
scheduling; temporary-remotes decision; `gitInterop` reduced/deleted; (b) templates —
scaffold builtin service, move resolver + journals (one-shot import or reset recorded
in the PR), acquisition-flow approval for add/pull, delete host service +
orchestration + the `createTemplateGitClient`/`discoverPin` path; update
`workspace-template-composition-plan.md` and `docs/git-upstream.md`.

> Contested: `docs/official-template-repositories-plan.md` argues templates
> should land in **userland** (a package shipped in base + the templates skill)
> rather than tier 1, on the grounds that `vcs.importSnapshot`/`commit`/`push`
> and `build.getBuild` are already `open` to `code`, that git-bridge already
> runs the whole acquisition pipeline from userland, and that the operation
> context replaces the lifecycle journal outright. If that argument is accepted,
> (b) reduces to deleting the host surface and H10 no longer applies to
> templates; (a) is unaffected either way.

Acceptance: no `legacy-product:H13` or template-domain markers remain; `templates.*`
absent from the kernel contract — this holds whether templates land as builtin (H10)
or as userland (the contested note above); the kernel gained **zero** new git methods
— its git surface is credential/egress + digest-bound prepared protected writes
(+ the temporary-remote endpoint primitive if chosen); template and git system tests
green; approvals run through the standard acquisition path.

### P8 — Reviewed execution closures, missions, system agent (H11)

Define the compiled-exposure schema → rewrite the three exposure assertions over it
with the H11 parity suite (charter vs compiled verdicts agree on mission fixtures and
the adversarial test plan) → introduce the generic closure record + kernel operations
→ builtin `missions` service with charter compilation, domain approval presentation,
and the data split migration → repoint the mission facade → convert seeded missions →
chrome-trust caller fact → `resolveConversation` move → delete host `systemAgent`,
mission product methods, and the charter-evaluation path → wire scheduled-job
approvals toward closure activation (design note, implementation may trail) → update
`mission-subsystem-spec.md`, `system-agent-design.md`, SA1 cross-refs.

Acceptance: the kernel contains no mission-named service; enforcement hot path reads
only kernel-owned closure/session tables with zero charter interpretation; approval of
a mission renders the compiled closure through generic settlement; mission and
system-agent system tests green.

### P9 — Development and phone provisioning (H15)

Development bookkeeping (sessions/runs/repair/recipes/pagination) and the
`attachedHosts` workflow subset to builtin code; kernel retains native controller,
executors, isolated-host invitation minting, and closure-based standing grants; the
native-terminal methods restructure onto the terminal/PTY receiver model from the
userland-capabilities plan (exact session-handle authority) if that plan has landed
by then, and are marked accordingly if not; phone provisioning server-half policy out
of the kernel; retire the last `legacy-product` markers this plan owns.

Acceptance: `legacy-product` count = 0 (the plan's completion criterion); development
and provisioning system tests green; kernel `development` surface is native/execution
methods only.

## 5. Documentation and skills to update (standing checklist)

Canonical (must change in the phase that touches them):
`workspace/skills/architecture/SKILL.md` (tier vocabulary, residency razor, H2 enum +
irreducible-effect rule; retire the "internal product bundle source may share package
layout" allowance per H3; rename the codebase term "product-sealed" → "builtin") ·
`workspace/skills/architecture/SYSTEM.md` ·
`docs/architecture/rpc-and-services.md` · `docs/tier-audit-rubric.md` (residency
question, H4 builtin audit) · `EXTENSIONS.md` (extensions = native brokerage;
lifecycle → supervision surface) · `docs/architecture/builtin-services.md` (new, P2) ·
`docs/git-upstream.md` (H13 cutover) · panel docs (`panel-surface-architecture.md`,
`panel-locations.md`, `multi-user-wp3-panel-forest.md`) ·
`workspace-template-composition-plan.md` · `mission-subsystem-spec.md`,
`system-agent-design.md` · `dynamic-vessels-and-userland-capabilities.md` (companion
plan — cross-reference H1's enforcement-is-not-a-residency-reason rule and the H2
companion-marker mechanism) · `docs/runtime-foundations/*` (regenerated each phase) ·
`capability-model-redesign.md` (add a cross-reference note: residency is orthogonal to
tiers; H5 relocates its catalogs' source of truth without changing semantics; H11
generalizes the mission-closure subject to reviewed execution closures without
changing grant algebra).

## 6. Explicitly rejected

- **A minimal-kernel big-bang or migration-first ordering.** The browser-data façade is
  the empirical result of migrating before paving.
- **A `{kind, id}` switch as the supervision implementation** — the internal driver
  contract is mandatory (H8); the public surface may not precede it.
- **Permanent rejection of unified creation** — replaced by H8's deferral: shared
  executable identity/activation at the driver layer now, public API convergence
  re-decided from the P6 census.
- **A _new_ panel-forest service** — panel policy descends into the existing builtin
  topology owner (`WorkspaceDO`, P5b); no additional owner is created, and no host
  policy veneer survives.
- **Domain-specific kernel authority services** (`missionAuthority.approve` and kin) —
  the kernel exposes generic reviewed-closure operations settled through ordinary
  approval (H11).
- **A method-count quota — including in acceptance criteria.** H2's justification
  invariant replaces it; H14 ratchets are baselines recording outcomes, not targets.
  Size/count numbers in this plan (extension lines, panel methods) are expectations
  used to sanity-check results; acceptance is always structural, because count gates
  invite merging behavior into larger methods and files.
- **Extension-ward migrations** for policy/state domains (tier 2 native processes do
  not shrink the TCB).
- **A workspace god service** absorbing removed host methods; removed methods leave no
  replacement kernel API unless H2 says otherwise.
- **New approval friction as a migration by-product** — relocating code never adds
  prompts or interactive latency to flows outside the dangerous surface (§2 principle
  4); "broad surface" is not a gating argument without a named dangerous operation.
- **Census-as-completion** — labeling a method `legacy-product` is not progress; the
  P1 disposition table must assign every service family to a phase or force a plan
  amendment, and the plan is complete only at zero markers (H14).
- **TTL/expiry on `legacy-product` markers** — retirement is a lifecycle event
  (migration landing), enforced by ratchet + the H14 completion criterion, not a
  clock.
