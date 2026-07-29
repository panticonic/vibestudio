# Official template repositories: slim base, versioned dependencies, Git registry

Status: architecture implemented; standalone repository extraction begins
after the pre-split commits

## Outcome

The single packaged workspace source is replaced by a set of independently
released Git repositories, composed by a userland package that ships in base:

- **`vibestudio-workspace-base`** — the smallest workspace that is genuinely
  useful on its own, and the root template every workspace is created from.
- **Feature template repositories** — one per user-visible outcome (news,
  browser, terminal, mobile, …), each vendoring only the units that outcome
  owns.
- **`vibestudio-template-registry`** — catalog metadata and exact verified
  pins, updated by reviewed PR with validation CI.

Templates correspond to outcomes a user would ask for, not to packages. A
user adds "News" and receives a working news workspace; they never reason
about `packages/feeds`.

This plan builds on `docs/workspace-template-composition-plan.md` for userland
composition and supersedes the host-owned seed lifecycle formerly proposed in
`docs/external-workspace-repositories-plan.md`. It defines how official
templates relate to each other and where the catalog comes from.

## Relationship to the existing system

| Existing piece                                                          | Role here                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveTemplateComposition()` (`workspace/packages/template-composer`) | Userland resolution is lock-first and a build gate precedes publication (decision D1). DAG walking, ordering, layering, and ownership are package behavior.                               |
| `initWorkspace(name, { templateDir })` filesystem copy                  | Retired as the default creation path. Bootstrap imports base's tree from an exact pin; the top layer arrives from base and declares no template relationship until adoption (§Bootstrap). |
| Checked-in `workspace/skills/onboarding/template-catalog.json`          | Replaced by the Git registry, read by the templates package (§Onboarding flow).                                                                                                           |
| Former `templates.*` host service                                       | Deleted. CLI and headless callers use the generic extension broker; all template logic and state live in userland (§Ownership).                                                           |
| `WORKSPACE_SYSTEM_EPOCH` (`packages/shared/src/vcs/systemEpoch.ts`)     | Becomes the published compatibility contract between the host and every template repository (decision D2).                                                                                |
| `docs/host-residency-redesign.md` H10                                   | **Superseded for templates.** H10 sends them to a sealed service; this plan sends them to userland (§Ownership). H10's other decisions stand.                                             |
| `workspace/skills/templates`                                            | Calls the userland composer through its public extension surface.                                                                                                                         |
| Excluded trust/provider suggestions from exact template manifests       | Promoted from diagnostic output to a required onboarding step (decision D3).                                                                                                              |

## Decisions

D1 changes the resolver's dependency contract; D2–D5 work with the resolver as
implemented. Each records the mechanism that forces it.

### D1. Templates name their dependencies; the build proves compatibility

**Feature templates declare base as a dependency, by URL only.** The edge is
real — a feature importing `@vibestudio/runtime` depends on the unit base
provides — so it must be visible to the resolver. But the edge carries no
version and no commit. Compatibility is not predicted; it is **measured, by
building the result before it is published**.

The declaration mechanism is the template source manifest: a template's own
`meta/template.yml` `templates.use` list _is_ its parent list
(`parents: [...(top.templates?.use ?? [])]`, `templateResolver.ts`), and
`visit()` recurses through it to build the DAG. Recursion, topological
ordering, `ancestorSets()`, fragment layering, and `maximalClaimants()`
repository ownership are all untouched.

#### Why not version ranges

Semver is a _predictive proxy_ for compatibility. It exists because ordinary
package managers cannot afford to build the world at install time, so they
trust a publisher's declaration instead. Both halves of that trade fail here:

- The world is buildable. The workspace _is_ the world, it is content
  addressed, and `validateBuildRef()` already accepts `ctx:<contextId>` —
  building unpublished context code is a first-class, existing capability.
- A publisher's range is a promise about code they have never seen: your
  particular combination of templates. The build is ground truth about exactly
  that combination.

Carrying ranges would mean maintaining a resolution apparatus to _approximate_
an answer the system can compute exactly.

The opposite error — declaring no dependency at all and letting features sit
beside base as siblings — is worse, and this plan previously made that mistake.
The dependency does not stop existing; it stops being _known_, and
incompatibility surfaces as an unattributed build failure instead of a named
one. Not naming a dependency is the same behaviour as an unsatisfiable one,
minus the diagnosis.

#### Declaration in the manifest, resolution in the lock

```yaml
# meta/template.yml in a template repository, or
# meta/templates/workspace.yml in a composed workspace
templates:
  use:
    - name: base
      url: git+https://github.com/vibestudio/workspace-base.git
      credential: github-main # optional; how to reach it, not which version
```

The lock is unchanged: every node keeps its exact `ref`, `commit`, `snapshot`,
`fragmentDigest`, and per-repository `subtreeDigest` under the whole-lock
fingerprint. **Reproducibility is unchanged**, and so is
`assertTemplateLockAnchoredToSource()` — the lock is still provably the
projection of exactly pinned sources.

This makes the schema _smaller_ than today: `ref`, `commit`, and `snapshot`
leave the manifest and exist only in the lock, where they already live.

#### Source manifests and the flattened runtime manifest

Composition has two userland inputs and one host-facing output; they never
share a path:

- `meta/template.yml` is a template repository's portable source manifest. It
  declares the fragment contributed by that repository and its
  `templates.use` dependency URLs.
- `meta/templates/workspace.yml` is the workspace-authored source layer. It
  owns direct roots, registry configuration, conflict choices, disables, and
  local overrides.
- `meta/vibestudio.yml` is the complete flattened runtime manifest published
  by the composer. It contains neither template declarations nor disable
  projections. This is the only manifest the host reads or mutates.

The separation is an architecture boundary, not a naming preference. A single
file cannot simultaneously be host-ready flattened state and the source layer
needed to recompose future template updates. On each operation, userland
reconstructs the previously generated runtime from the stored workspace source,
lock, and exact fragments; projects any ordinary runtime settings edits back
onto the workspace source; then atomically publishes the updated source, lock,
fragments, repositories, and flattened runtime.

#### Resolution

Per URL in the closure, in order:

1. **The lock wins.** An already-resolved URL keeps its exact commit. Ordinary
   recomposition never consults the network and never drifts.
2. **Otherwise take the registry's promoted latest** (§Registry design), which
   is the last version its CI promoted — not merely the newest tag, so a push
   never reaches users unreviewed.
3. Acquire and verify the exact snapshot exactly as today.

There is exactly one resolution per URL by construction, so
`TemplatePinConflictError` becomes **unreachable**. `templates.overrides`
reverts to its honest meaning: a deliberate "use exactly this commit" rather
than a repair tool for a self-inflicted conflict.

The two alias errors are _not_ removed by that alone —
`TemplateAliasCollisionError` still fires when two different URLs claim one
name, and `TemplateAliasAmbiguityError` when one URL is reached under two
names. **So the alias stops being author-chosen and is derived from the URL.**
It is a display name; no author needs control of it, and deriving it makes both
errors unreachable too, with no remediation flow left to design. A workspace
that wants a different label renames it in its own top layer, where exactly one
opinion exists.

"Latest" is consulted only on an explicit add or pull.

One property is deliberately given up: a feature release no longer determines
its own closure. The same feature commit composes against whatever base a given
workspace has locked, so registry CI validating News against the promoted base
says nothing about a workspace holding an older one. Per-workspace
reproducibility is preserved by the lock, and incompatibility is caught by the
build gate at add time rather than predicted at publish time. Cross-workspace
release identity is the price of not having a synchronized release train.

#### The build gate

Before publishing, the operation builds in its own context:

1. The composer imports the resolved repositories into its operation context
   through `vcs.importSnapshot`.
2. It builds the affected unit closure at that context ref —
   `build.getBuild(unit, "ctx:<operationId>")`, which already accepts a `ctx:`
   ref and is already callable by the `code` principal.
3. Only a clean build is published.

Publication is the atomic boundary, so a failed build leaves protected main
untouched. No partially composed state is ever reachable.

#### When the build fails

The interesting case, and the one where this design beats declared ranges:

- The agent repairs it **inside the operation context**, as ordinary semantic
  edits. Those edits join the _same_ publication, so the workspace atomically
  receives "News, plus whatever made News build." There is no broken
  intermediate state to observe.
- The repair is now a divergence from the news template — already a modelled,
  first-class thing. The next pull brings the new version as external deltas
  reconciled per repository through `vcs.integrate`, and the suggest flow
  pushes the fix upstream. A local fix is a tracked divergence with an existing
  upstreaming path, not a hidden fork.
- **Non-interactive callers** (CLI, headless) have no agent to repair anything.
  A failed build discards the operation context and reports the failing units.
  Fail closed; never publish an unbuildable composition.

A green build is a **compile and type gate, not a behavioural one** — it proves
the composition assembles, not that News works. Extending the gate to run
system tests is possible later precisely because that harness now lives in base
(§Developer tools).

### D2. `systemEpoch` is an exact-match ABI gate; epoch bumps are coordinated releases

`parseTemplateManifest()` throws when a template's `systemEpoch` differs from
the host's. It is one integer with no range. Every epoch bump invalidates every
published template at once.

**Keep exact equality.** It is a real ABI gate and weakening it invites
silently incompatible compositions.

`systemEpoch` is the one declared compatibility contract in the system, and it
is deliberately the _only_ one. It governs the **host ↔ workspace source ABI**,
where the host cannot inspect what it is about to run and must fail closed.
Template ↔ template compatibility is not declared at all under D1 — it is
measured by building. A composition that builds is still refused if its epoch
differs from the host's; epoch is not negotiable.

Given that:

- Epoch bumps are batched and rare, and each one is a coordinated re-tag of
  base and every feature repository. Ordinary base releases do not force
  feature releases: a feature absorbs them as long as it still builds, and
  registry CI proves that at promotion time rather than by re-tagging
  everything. Only an epoch bump forces a coordinated release.
- The registry records the epoch each entry was validated against, and
  registry CI refuses an entry whose epoch differs from the current base
  release.
- A workspace on an older epoch gets the existing explicit
  "workspace-source upgrade required" error, not a parse failure.

If the coordinated re-tag proves too expensive in practice, the alternative is
to widen the contract to a supported `minSystemEpoch`/`maxSystemEpoch` range.
**That decision must be made before migration step 7**, because every
repository cut afterwards bakes the contract in at tag time, and retrofitting
across published repositories is far worse than deciding now.

### D3. Templates cannot inherit `trust` or `providers`; accepting suggestions is part of the flow

`sanitizeTemplateManifest()` strips `templates`, `disable`, `trust`,
`providers`, and upstream `authorEmail`/`authorName`.
`WorkspaceConfigFragmentSchema` omits them.

So `vibestudio-template-google-workspace` can ship the Gmail agent, package,
and skills — and cannot ship the `providers.*` wiring or trust grants that make
them work. Installed alone, the user gets inert units. The same applies to
browser and any other integration-heavy outcome.

The resolver already captures these as `excludedSuggestions` and carries them
through `inspectPlan`. This plan promotes them to a required step:

- Inspection surfaces excluded provider/trust suggestions in the composition
  preview, so the approval can say what the template _wants_ in addition to what
  it brings.
- After the add is approved and published, the flow presents those suggestions
  as a **separate, individually approved action** that writes to the workspace
  layer. Templates never acquire trust by being installed.
- Onboarding treats an outcome as incomplete until its suggestions are
  resolved (accepted or declined), and says so.

Without this step, the integration-heavy templates are not outcome-focused and
should not ship as templates.

The contract is deliberately the same one everything else here uses, and needs
no second approval machine: suggestions are read from the acquired manifests of
the exact snapshots just installed; the user accepts or declines each one; the
package writes the accepted ones into the workspace top layer and publishes. If
the workspace moved underneath, the publish fails on its expected protected-main
event and the flow re-derives from current state and re-asks. Suggestions carry
no durable pending state — an unresolved one is simply still visible in the next
inspection.

### D4. No files at a container-section root

`enumerateRepoFiles()` throws `TemplateManifestError` for any file at
`<section>/<file>` — every unit must live at `<section>/<unit>/...`.

These repositories are pnpm monorepos, and `packages/tsconfig.base.json` is
exactly where shared config normally goes. It would abort acquisition in the
consuming workspace, at install time, for someone else. Rules:

- Shared tooling config lives at the **repository root**, which sits outside
  every container section and is ignored by the resolver.
- Nothing is ever placed directly under `panels/`, `apps/`, `packages/`,
  `workers/`, `extensions/`, `skills/`, `about/`, `templates/`, `projects/`.
- Each template repository's CI carries a lint asserting this, because the
  failure is otherwise invisible until a user installs the template.

Related and already handled: a root `.npmrc` previously aborted template
acquisition outright. Templates now acquire with
`TEMPLATE_RESERVED_PATH_POLICY = "exclude"`, so reserved paths are omitted from
the admitted set and the digest instead of rejecting the repository.

### D5. The packaged default becomes a pinned root template

In `resolveTemplateComposition()`, a repoPath present in `localRepoPaths`
resolves to `selected = null`: the local copy wins and the template owns
nothing. So if the packaged default keeps shipping base's units as ordinary
files copied by `templateDir`, **base can never own or update them** — base
would be permanently frozen at whatever shipped.

Workspaces are therefore created from base **as a template pin**, not as a
filesystem copy. The pin is acquired over the network at creation; adoption of
those repositories into template ownership happens on the package's first run
(§Bootstrap), which is what keeps the host free of composition.

**Offline first-run is explicitly not a requirement.** Creating a workspace
performs an ordinary exact acquisition of base over the network, so no
pre-seeded checkout ships with the app. This is a deliberate simplification:
a usable cache would have to be a real Git checkout satisfying every
`readExactGitSnapshot` precondition (HEAD at the pinned commit, clean status
matrix, readable commit tree), and it would live in per-profile state at
`git-checkouts/_templates/<nodeId>` rather than in the app bundle — so
"shipping a cache" would mean seeding profile state on first run and garbage
collecting it whenever the packaged base pin changed. None of that is worth
building unless offline creation becomes a requirement.

This changes the last migration step from "swap the packaged workspace source"
into "change how workspaces are created", and it is what makes base updatable
at all.

## Repository inventory

Every template repository is a workspace-shaped monorepo: container sections
whose immediate children are unit repos, plus `meta/template.yml`. The bootable
base additionally ships `meta/vibestudio.yml` and
`meta/templates/workspace.yml`.

| Repository                             | Contents                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio-workspace-base`            | `apps/shell`, `panels/chat`, onboarding and templates skills, model settings, pubsub channel, agent/runtime/UI foundations, **developer tools** (see below) |
| `vibestudio-template-news`             | `panels/news`, `workers/news-agent`, `packages/feeds`, `packages/channel-fork`                                                                              |
| `vibestudio-template-browser`          | browser-data extension, collection/browser packages, browser About pages                                                                                    |
| `vibestudio-template-google-workspace` | Gmail agent and package, Google Workspace and Drive skills, integrations package                                                                            |
| `vibestudio-template-terminal`         | terminal panel/browser, terminal-chat worker, shell extension, terminal protocol packages                                                                   |
| `vibestudio-template-mobile`           | mobile app, React Native and mobile-debug extensions                                                                                                        |
| `vibestudio-template-local-models`     | local-models panel and extension                                                                                                                            |
| `vibestudio-template-spectrolite`      | Spectrolite panel, MDX editor package                                                                                                                       |
| `vibestudio-template-examples`         | `hello-vanilla`, `hello-svelte`                                                                                                                             |

### Developer tools belong to base, not a template

Vibestudio is a place where people build things, so the development surface is
core rather than an optional outcome. Base therefore carries:

```
panels/development   panels/testbench
workers/system-test-runner   workers/test-agent   workers/testkit-driver
skills/system-testing   packages/testkit
type-check and test extensions
```

A note on the rationale, corrected: an earlier draft argued this on the grounds
that `packages/testkit` — consumed by `panels/testbench`, `workers/testkit-driver`,
and `skills/system-testing` at once — would straddle templates otherwise. That is
wrong. All three consumers sit inside the proposed developer-tools outcome, so as
a single template nothing straddles and testkit would travel with them. Only a
_further_ split by audience, separating user-facing tooling from the platform
self-test harness, would force testkit into base.

The decision stands on the product argument instead: Vibestudio is a place where
people build things, so the development surface is core rather than an optional
outcome. That is a deliberate choice against "smallest useful base", and it is
priced below.

Note the consequence for base's weight: `skills/system-testing` additionally
depends on `@workspace-skills/vibestudio-vcs`, and every workspace now builds
the self-test workers. Base acquisition happens on every workspace creation, so
base size is first-run latency. If that becomes a problem, the audience split
(user-facing tooling in base, platform self-test harness elsewhere) is the
lever to pull — see §Deferred.

### Package placement

An internal package stays with the feature that owns it. It moves to base only
when two or more templates genuinely share it.

Placement is not cheap to change later: moving a package between templates is
a repository **ownership transfer**, producing `ownershipChanges` with reason
`transferred` or `orphaned`, which surfaces to the user as a conflict decision
on their next update. Bias toward putting a plausibly-shared package in base
from the start rather than migrating it after release. Ownership transfer gets
a dedicated system test (§Test matrix).

### Alias identity

Aliases are global within a composition, and today they come from each
declaring manifest — which is what makes `TemplateAliasCollisionError` (two
nodes, one name) and `TemplateAliasAmbiguityError` (one node, two names)
reachable. Under D1 the alias is **derived from the template URL** instead, so
neither error can occur and the registry has nothing to repair after the fact.

Registry CI still enforces a unique `id` ↔ URL mapping across entries, so two
catalog entries cannot present themselves as the same template. A workspace that
dislikes a derived label renames it in its own top layer, which is the one place
a single opinion exists.

## Ownership: a userland package in base, plus a skill

Template composition is **not host code and not a sealed service**. It ships as
an ordinary userland package in `vibestudio-workspace-base`, driven by the
`workspace/skills/templates` agentic skill. The host's only template-specific
responsibility is pulling the very first one.

### Why this works: the primitives are already userland-reachable

Adding a template is fetch → verify → land content → import → compose → build →
publish. Every step is an existing capability that userland already holds, and
the whole pipeline is already exercised in-tree:

| Step                                      | Existing surface                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fetch a remote, verify its exact snapshot | `readExactGitSnapshot` from `@vibestudio/git` — **git-bridge, a userland extension, already imports and uses it**     |
| Land content in the CAS                   | `blobstore` methods, as git-bridge already drives them                                                                |
| Import repositories into a context        | `vcs.importSnapshot` — `principals: ["user", "code", "host"]`, tier `open`                                            |
| Build the result before publishing        | `build.getBuild(unit, "ctx:<id>")` — `principals: ["code", "user", "host"]`; the `ref` param already documents `ctx:` |
| Publish atomically to protected main      | `vcs.commit` / `vcs.push` — `principals: ["user", "code", "host"]`, tier `open`                                       |

Nothing here is new authority. Template acquisition is the operation git-bridge
already performs for upstreams, pointed at a different remote.

### The callable surface

A package API is not by itself reachable by everything that needs templates, so
the boundary is named explicitly:

| Caller                | Path                                                            |
| --------------------- | --------------------------------------------------------------- |
| Onboarding UI, panels | Import the package directly — same workspace, same bundle graph |
| Agents                | The `workspace/skills/templates` skill, which wraps the package |
| CLI, headless         | RPC to a thin broker that forwards to the package               |

The last row is the only one needing anything new, and it has a working
precedent: git-bridge is a userland extension, and `src/cli/agent/vcsGitCommands.ts`
already drives it over `RpcClient`. The broker forwards; it holds no template
logic, no resolution, and no state. That is the distinction that keeps this from
being the browser-data façade — the façade was a forwarder in front of state
that never moved, whereas here all state and logic genuinely relocate and only
the call path remains.

### The operation context is the journal

This is what collapses the subsystem. `templateLifecycle.ts` is a
`planned → reviewing → approved → publishing → applied` phase machine with
crash recovery journaled to `operations-v1.json`, an in-process mutex, a
`recover()` path, and supersede logic — roughly 1,400 lines re-implementing, in
host state, what a semantic context already provides: durable partial work that
survives a crash and can be inspected, resumed, or discarded.

If a template operation is "work in a context, then publish," the context _is_
the journal. The phase machine, the composition journal, and artifact staging
are not relocated. They are deleted.

### What the host keeps

- **Bootstrap.** Pull the root template naively — one exact pin, import its tree
  as the workspace's initial repositories, publish — because this happens before
  any userland exists. No DAG walk, no resolution, no lock, no conflict
  handling. See §Bootstrap.
- **Credential and egress brokerage.** Unchanged, already exists, already what
  git-bridge uses.
- **Protected publication** and **unit version approval.** Both unchanged and
  both domain-neutral. The second is the real security gate: a template
  contributes files and declarations, and nothing executes until a unit is
  approved. Declaring an extension in a manifest is not running one.

### Bootstrap: how base becomes updatable

The bootstrap import produces ordinary **local** repositories, not
template-owned ones. That is deliberate: generating a lock requires composition,
and composition is exactly what the host no longer does. A workspace whose repos
are local is fully bootable — it simply has no template relationship yet.

Base becomes template-owned on the package's first run, through machinery that
already exists. The package resolves base as the root **without treating its
repositories as local**, so base claims them the ordinary way
(`claimantIds.length === 1`). The content is byte-identical to what bootstrap
imported, so the resulting delta is empty; what the publication actually adds is
`meta/templates.lock.yml` and the fragment. From that point base is a normal
template and updates flow through the normal pull path.

This is why D5's conclusion survives without a host composer: base is not a
frozen copy, it is a template whose adoption is deferred by exactly one
operation.

The root repository ships a ready-to-run `meta/vibestudio.yml` as well as its
userland `meta/template.yml` source manifest. Bootstrap validates and imports
the runtime manifest only; it never interprets the source manifest.

Bootstrap being resolution-free requires the root template to have no
dependencies of its own. Base satisfies this by construction. A third-party root
must likewise be independently bootable; any dependencies in its source
manifest complete on the package's first run. The host delivers the declared
ready runtime tree and the workspace finishes assembling its closure itself.

### What this gives up, stated plainly

`assertTemplateLockAnchoredToSource()` currently proves a committed lock is the
projection of exactly pinned sources, enforced by the host. Once userland
composes, userland generates the lock, and that check demotes from an authority
boundary to a reproducibility and self-consistency check.

This is acceptable under the project's threat model — the untrusted party is
content, and content cannot forge its own snapshot digest — but it is a real
reduction and should not be glossed. Snapshot verification itself is unaffected:
every acquisition still checks the digest, exactly as git-bridge does today.

### Relationship to the host-residency redesign

`docs/host-residency-redesign.md` H10 moves templates to a **sealed** service.
This plan supersedes H10 for templates: the same reasoning H10 gives — "pure
computation over content-addressed inputs" — points past sealed to userland once
you observe that publication is open-tier and unit approval is the actual gate.
H10's other conclusions are unaffected, and its git-side decision (H13) is
independent.

Consequently this plan does **not** depend on phase P7. It needs the host
bootstrap path and nothing else from that redesign.

## Implementation cost

Net negative. The subsystem shrinks by roughly 6,500 lines of host code, and
what replaces it is smaller than what it replaces.

### Deleted

| Surface                                                                                          | Lines            |
| ------------------------------------------------------------------------------------------------ | ---------------- |
| `src/server/workspaceTemplates/` — resolver, lifecycle, ports, runtime, journals, artifact store | ~6,400           |
| `templates.*` host service and its tier, capability-presentation, and ledger rows                | ~100 + generated |
| `createTemplateGitClient` / `discoverPin` in `src/server/index.ts`                               | —                |

Of that, the phase machine, operation journal, composition journal, artifact
staging, in-process mutex, and crash-recovery path are deleted outright rather
than relocated — the operation context replaces all of them (§Ownership).

### Kept as shared packages

Already runtime-neutral and consumed from both sides of the boundary; they move
into base unchanged:

- `packages/workspace/src/templateLock.ts` — lock integrity and fingerprint
- `packages/workspace/src/templateCoordinates.ts` — node identity, URL
  normalization, `TEMPLATE_RESERVED_PATH_POLICY`
- `packages/workspace/src/configComposition.ts` — fragment layering
- `packages/git/src/exact-snapshot.ts` — already imported by git-bridge today

### Written new

- The composer package in base: the resolver (pure, and portable from the
  existing 1,015-line one), lock generation, and the operation flow — fetch,
  import, compose, build, publish — expressed as ordinary `vcs` and `build`
  calls.
- The `workspace/skills/templates` skill, which already exists and whose
  `public-contract.json` re-points from a host service to the package API.
- The host bootstrap path: acquire one exact pin, import, publish.

### Not needed

- No new kernel method. `build.getBuild` already accepts a `ctx:` ref and is
  already callable by `code`; `vcs.importSnapshot`/`commit`/`push` are already
  `open` to `code`. The build gate's residency question that an earlier draft of
  this plan raised does not arise.
- No sealed-service scaffold, and so no dependency on phase P7.

The one genuine engineering question remains **build scope**: the gate must
build the affected unit closure, not the whole workspace, or an add takes
minutes. Build V2 already has the unit graph needed to compute it.

What this design gives up relative to declared version ranges is cheap _a
priori_ rejection — saying "not base 5" without downloading and building it.
Irrelevant for a curated official set; it would begin to matter for a large
third-party ecosystem. A scaling boundary, not a blocker.

`docs/workspace-template-composition-plan.md` specifies `commit` as mandatory
in `templates.use` and a host `templates` service as the mutation authority.
This plan supersedes it on both points; the rest of that document stands.

## Standalone repository prerequisite

The extracted workspace currently depends on `workspace:*` references to
`@vibestudio/*` packages from the enclosing monorepo. Until that is resolved,
no extracted repository can have meaningful standalone CI.

Required before any repository is cut:

1. Publish and version the host-facing `@vibestudio/*` packages a workspace
   needs, or provide one supported SDK package set.
2. Remove `../packages/*` from the standalone `pnpm-workspace.yaml`.
3. Declare the SDK version and `systemEpoch` in each base/template release.
4. Validate every template by composing it against the **exact base release**,
   never against arbitrary local monorepo state.

## Registry design

`vibestudio-template-registry` is the presentation catalog and the **promotion
pointer** resolution reads when a URL is not already in the lock. It is not a
template and is never composed; it is data the templates package fetches and
verifies.

```yaml
version: 1
revision: 2026-07-29.3
systemEpoch: 57
entries:
  - id: news
    name: News workspace
    description: Read and discuss personalized news briefings.
    tags: [news, agent, panel]
    recommended: true
    url: git+https://github.com/vibestudio/template-news.git
    # The promoted release. Not "the newest tag" — CI put it here.
    promoted:
      ref: refs/tags/v1.2.0
      commit: <full lowercase 40-char oid>
      snapshot: v1-sha256:<digest>
```

Properties:

- `promoted` carries an **exact commit and snapshot**. The registry never
  publishes a moving ref as an installable coordinate.
- Promotion is the review gate. A push to a template repository reaches nobody
  until CI promotes it, so "latest" can never mean "whatever landed a minute
  ago". This is what makes lock-first resolution safe to default.
- `recommended` is **presentational only** — it badges and sorts catalog
  entries. It does not drive a first-run install set. Each `templates.add`
  mints its own approval card (`groupKey = nodeId`) and the lifecycle
  serializes operations with no batch add, so an auto-installed set would mean
  N sequential approvals, N acquisitions before the user has done anything, and
  any overlap between two recommended templates arriving as a
  `templates.conflicts` decision put to a user who has no basis to answer it.
  Registry CI nonetheless **composes and builds the full recommended set
  together against base** and fails if it conflicts or does not build. That
  keeps a first-run set available later — only the batch-approval surface would
  remain to build.
- The **manifest remains the source of dependency truth**. The registry records
  what each template resolved to, never what it depends on.
- Registry CI promotes a version only after verifying its Git snapshot digest,
  checking its `systemEpoch` against the current base release, and **composing
  and building it against the promoted base**. Promotion means "this
  demonstrably assembles", which is the same gate D1 applies in the user's
  workspace.
- The userland registry package caches the last verified registry snapshot.
  Installed workspaces remain fully usable when the registry is unreachable.

## Onboarding flow

Today the catalog exists twice: the host reads a checked-in JSON file while
onboarding statically imports and validates the same file. Both copies go away;
the templates package in base is the single owner.

1. Onboarding asks the templates package for the catalog.
2. The package acquires and verifies the configured Git registry, using the
   same exact-snapshot path it uses for templates themselves.
3. It returns the registry revision plus entries.
4. `TemplateCatalog.tsx` renders those entries and no longer imports
   `template-catalog.json`.
5. Selecting an entry carries its id **and the registry revision**.
6. The agent asks for an inspection: the exact resolved pin, the composition
   preview, and the excluded provider/trust suggestions (D3).
7. The add runs against that exact inspected pin, in its own operation context,
   through the build gate (D1).
8. Suggestions from step 6 are presented as a separate approved action (D3).
9. Onboarding renders a fresh catalog/status observation.

Onboarding UI never fetches Git and never composes. It renders what the package
returns and hands back structured selections; acquisition, verification,
composition, and publication all live in the package.

### Constraints this flow must respect

- **Revision is enforced, not merely passed.** A stale revision from step 5 is
  rejected rather than silently resolved against the current one. Otherwise the
  pin the user approved is not necessarily the pin installed.
- **Catalog reads are network work.** Refresh is an explicit user action, or
  cache-backed with a stale indicator — never implicit on render. A settings
  view must not turn into a fetch.
- **Inspection is expensive.** It performs a full recursive acquisition and
  snapshot verification of the closure. It runs only on explicit selection —
  never on hover, and never per-entry while rendering a list.
- **The registry is cached.** Its last verified snapshot is retained, and an
  unreachable registry leaves the installed workspace fully usable.

## Migration sequence

1. Generate an ownership and dependency inventory for every unit under
   `workspace/`.
2. Define and validate the smallest bootable base.
3. Refactor onboarding so optional GitHub, Google, and web-research skills are
   **not compile-time dependencies**. Onboarding discovers installed
   capabilities through service/catalog data. This is a true blocker: a static
   import forces those skills into base regardless of how template boundaries
   are drawn.
4. Establish the SDK boundary (§Standalone repository prerequisite) and settle the epoch contract (D2).
5. **Invert ownership** (§Ownership): move the resolver into a userland package
   in base, re-point `workspace/skills/templates` at it, reduce the host to the
   bootstrap pull, and delete `src/server/workspaceTemplates/` and the
   `templates.*` host service.
6. **Implement D1 in that package**: URL-only entries in `templates.use`,
   lock-first resolution, and the build gate at `ctx:<operationId>` before
   publication. This lands before any repository publishes a manifest, because
   the first tagged release fixes the manifest contract.
7. Extract `workspace/` history into `vibestudio-workspace-base`.
8. Move leaf features first: examples, news, local models, Spectrolite.
9. Move the larger bundles: browser, mobile, terminal, Google Workspace.
10. Introduce release tagging and composition tests across all repositories.
11. Create the registry repository and its build-gated promotion workflow.
12. Replace the checked-in catalog with the Git registry client.
13. Switch workspace creation to a base template pin (D5): the host imports
    base's tree, the package adopts it on first run (§Bootstrap).

Steps 3–6 are the real gates. Everything from 7 onward bakes contracts into
published repositories.

**Step 5 precedes step 6 deliberately.** D1 changes the resolver and the
publication path — exactly the code step 5 moves out of the host. Implementing
D1 first would build it twice and then port it.

Steps 5 and 6 are independent of the host-residency redesign's phase P7: this
plan supersedes H10 for templates and needs nothing from that phase
(§Ownership).

## Test matrix

Run before step 13 changes how workspaces are created:

- Creation from a pinned base root template.
- Creation with the registry or the base remote unreachable fails with an
  actionable error and leaves no half-initialized workspace.
- Adding one feature; adding two features with a genuine repository overlap
  (explicit `templates.conflicts` decision).
- **Resolution is lock-first (D1):** adding a feature to an existing workspace
  never moves an already-locked base, and performs no network lookup for it.
- **The build gate blocks publication:** a feature that does not build against
  the resolved base leaves protected main untouched, leaves no partially
  composed state, and reports the failing units.
- **An in-context repair ships atomically:** edits made in
  `ctx:template-composer-operation-<opId>` to fix a failing build land in the
  same publication as the template import — the workspace never observes the
  unrepaired state.
- **A repaired template stays reconcilable:** a later pull of a locally repaired
  template presents the divergence as external deltas rather than clobbering or
  silently forking it.
- **Non-interactive failure fails closed:** a headless/CLI add whose build
  fails cancels the operation and changes nothing.
- Registry CI refuses to promote a version that does not build against the
  promoted base.
- Update discovery through to a completed pull, including tag selection across
  a prerelease and its release.
- Provider/trust suggestion acceptance and decline (D3).
- Registry offline: cached catalog serves, workspace stays usable.
- Registry revision staleness between the catalog read and the add is rejected.
- Rejection and rollback of an in-flight add.
- **The host does no composition:** with the templates package removed from the
  workspace, adding a template fails cleanly rather than falling back to a host
  path — there is no second implementation.
- Package ownership transfer between two templates across an update.
- A template repository containing a file at a container-section root fails
  its own CI lint before publication (D4).
- Epoch mismatch produces the explicit workspace-source upgrade error.

## Deferred

Decided against for now, recorded so the reasoning is not relitigated:

- **Offline first-run.** Not a requirement (D5). Revisit only if workspace
  creation must work without connectivity; the cost is described in D5.
- **A first-run recommended set.** `recommended` stays presentational
  (§Registry design). The composition guarantee from registry CI is what keeps
  this cheap to add later; the missing piece would be a batch-approval card.
- **Splitting developer tools by audience.** All of it lives in base. If base
  acquisition latency becomes a problem, the lever is moving the platform
  self-test harness (`skills/system-testing`, `workers/system-test-runner`)
  out, leaving user-facing tooling in base. Under D1 this is now
  straightforward — the extracted template would declare base as a dependency
  like any other feature, and installing it alongside base resolves rather than
  conflicts.
