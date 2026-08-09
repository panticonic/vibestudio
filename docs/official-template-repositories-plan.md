# Official template repositories: slim base, build-proven dependencies, Git registry

Status: corrected 2026-08-09. No optional template repositories or verified
template catalog entries are currently deployed. All three planned extraction
outcomes still ship in `workspace/` as part of the base product. Extraction is
ready for private candidate repositories; promotion and product cutover remain
blocked on the functional verification checklist and promotion CI. Publishing
a standalone npm SDK is explicitly not an extraction prerequisite.

## Outcome

The single packaged workspace source is replaced by independently released
Git repositories, composed by a userland package that ships in base:

- **`vibestudio-workspace-base`** — the smallest workspace that is genuinely
  useful on its own; the root every workspace is created from; independently
  bootable with its flattened runtime manifest present.
- **Feature template repositories** — one per user-visible outcome (news,
  Spectrolite, and examples), each publishing the repositories it needs to
  contribute. Templates correspond to outcomes a user would ask for, never to
  packages: a user adds "News" and gets a working news workspace; they never
  reason about `packages/feeds`.
- **`vibestudio-template-registry`** — catalog metadata and promotion
  pointers, updated by reviewed PR with validating CI.

This plan builds on the composition model of
`docs/workspace-template-composition-plan.md` (DAG, fragments, lock) but
supersedes its ownership model with ordered, overlapping contributions: there is no host `templates`
service, resolver, journal, or checked-in catalog. It also supersedes
`docs/host-residency-redesign.md` H10 for templates: not a builtin service —
userland, which is where the code already is.

## Current implemented infrastructure

Already true in-tree, so no longer plan material:

- `workspace/packages/template-composer` owns resolution
  (`resolveTemplateComposition`) and operations (inspect/prepare/publish/
  apply, `TemplateBuildGateError`, bootstrap adoption).
- `workspace/extensions/template-composer` is the runtime service;
  `workspace/skills/templates` wraps it for agents; CLI and headless callers
  reach it through the generic extension broker
  (`src/cli/templateComposerClient.ts`). The broker forwards and holds no
  template logic or state.
- The host's only template-specific act is bootstrap: acquire one exact root
  pin, import, publish (`workspaceRootTemplateBootstrap.ts`,
  `acquireRootTemplateSnapshot.ts`). `initWorkspace` retains three exclusive
  source kinds (`templateDir`, `forkFrom`, `rootTemplate`); the first becomes
  a dev-mode convenience and the pin becomes the product path (D5).
- `WORKSPACE_SYSTEM_EPOCH = 57`, exact-match, enforced at manifest parse.

Why userland composition is sound — recorded once, not re-argued: every step
of add (fetch → verify → land → import → compose → build → publish) is an
existing userland-reachable capability, already exercised by git-bridge and
the `code` principal (`readExactGitSnapshot`, blobstore, `vcs.importSnapshot`,
`build.getBuild` with `ctx:` refs, `vcs.commit`/`push`). And the semantic
operation context _is_ the durable journal — the former host phase machine,
crash-recovery journal, and artifact staging were re-implementations of what
a context already provides, which is why they could be deleted rather than
moved. What this trades away, stated plainly: the host-enforced
lock-anchoring check demotes to a userland reproducibility check. Acceptable
because the untrusted party is content and content cannot forge its own
snapshot digest; snapshot verification at every acquisition is unchanged.

## Decisions

### D1. Templates name their dependencies; the build proves compatibility

Feature templates declare base as a dependency **by URL only** — no version,
no commit:

```yaml
# meta/template.yml
templates:
  use:
    - name: base
      url: git+https://github.com/vibestudio/workspace-base.git
      credential: github-main # optional; how to reach it, not which version
```

The edge is real (a feature importing `@workspace/runtime` depends on the
unit base provides) so the resolver must see it; but compatibility is
**measured by building the result before publication**, never predicted by a
range. Semver ranges are a predictive proxy that exists because ordinary
package managers cannot build the world at install time. Here the world is
buildable, content-addressed, and `ctx:`-buildable already; a publisher's
range is a promise about a combination they never saw, while the build is
ground truth about exactly that combination. The opposite error — declaring
no edge and letting features sit as siblings — is worse: the dependency stops
being _known_, and incompatibility surfaces as an unattributed build failure.

Resolution per URL, in order: (1) **the lock wins** — ordinary recomposition
never consults the network and never drifts; (2) otherwise the registry's
**promoted** latest (not the newest tag; CI put it there); (3) acquire and
verify the exact snapshot as today. One resolution per URL by construction
makes `TemplatePinConflictError` unreachable and returns
`templates.overrides` to its honest meaning ("use exactly this commit").
Aliases are **derived from the URL**, making both alias errors unreachable
too; a workspace that wants a different label renames in its own top layer,
the one place a single opinion exists.

The lock keeps exact `ref`/`commit`/`snapshot`/digests under the whole-lock
fingerprint; those fields leave the manifest entirely. Reproducibility and
lock-anchoring verification are unchanged. The three-file separation stands:
`meta/template.yml` (portable source fragment + dependency URLs),
`meta/templates/workspace.yml` (workspace-authored top layer), and the
generated flattened `meta/vibestudio.yml` — the only manifest the host reads.

**The build gate:** before publication the operation imports the resolved
repositories into its own context and builds the affected unit closure at
`ctx:<operationId>`. Only a clean build publishes; publication is atomic, so
a failed build leaves protected main untouched with no observable
intermediate. On failure, an agent repairs _inside the operation context_ and
the fix ships in the same publication — the workspace atomically receives
"News, plus whatever made News build," and the repair is a modelled
divergence with the existing reconcile/suggest upstreaming path.
Non-interactive callers fail closed: discard the context, report the failing
units. The gate is compile-and-type, not behavioral; extending it to system
tests is possible precisely because the harness lives in base.

Scope discipline: the gate builds the affected unit closure, not the whole
workspace — Build V2's unit graph computes it. What URL-only resolution gives
up is cheap a-priori rejection ("not base 5" without downloading it) —
irrelevant for a curated official set, a scaling boundary for a large
third-party ecosystem, not a blocker. A feature release also no longer
determines its own closure: the same feature commit composes against
whatever base each workspace has locked. Per-workspace reproducibility is
the lock's job; add-time compatibility is the gate's; cross-workspace release
identity is the price of not running a synchronized release train.

### D2. `systemEpoch` stays an exact-match ABI gate

Epoch governs the host ↔ workspace-source ABI, where the host cannot inspect
what it is about to run and must fail closed. It is deliberately the only
_declared_ compatibility contract — template ↔ template compatibility is not
declared at all under D1; it is built. Keep exact equality.

Consequences: epoch bumps are batched, rare, coordinated re-tags of base and
every feature repository. Ordinary base releases force nothing — a feature
absorbs them as long as it still builds, proven by registry CI at promotion.
The registry records each entry's validated epoch and refuses promotion on
mismatch with the current base release. A workspace on an older epoch gets
the explicit upgrade-required error, not a parse failure.

If coordinated re-tags prove too expensive, the fallback is a
`minSystemEpoch`/`maxSystemEpoch` range — but that decision must be made
**before the first repository is cut** (migration step 6), because every tag
afterwards bakes the contract in.

### D3. Templates cannot ship trust; accepting suggestions is part of the flow

`sanitizeTemplateManifest()` strips `trust`, `providers`, and credential-
bearing config from template fragments — a template must not grant itself
anything by being installed. So integration-heavy templates
(google-workspace, browser) install inert without a second step. The resolver
already carries the stripped items as `excludedSuggestions`; this plan
promotes them to a required onboarding step:

- The composition preview surfaces what the template _wants_ alongside what
  it brings.
- After the add publishes, each suggestion is presented as a separate,
  individually decided action through the **ordinary acquisition flow** — the
  same evaluator, cards, severity computation, inventory, and revocation as
  every other approval (prerequisite D7). No second approval machine; every
  card is registered in `docs/approval-prompt-ux-spec.md`.
- Accepted suggestions are written to the workspace top layer and published;
  if the workspace moved underneath, the publish fails on its expected
  protected-main event and the flow re-derives and re-asks. Suggestions carry
  no durable pending state — an unresolved one is simply still visible in the
  next inspection, and onboarding reports the outcome incomplete until each
  is accepted or declined. No clocks anywhere in this flow.

Content-lineage note (capability-redesign D8): template-acquired content
arrives external by default. Suggestion acceptance is exactly the vouch/
consent moment for the wiring it enables; the card must present it that way.

Unit selection and authority UX are specified in
[`template-install-unit-approval-ux-plan.md`](template-install-unit-approval-ux-plan.md).
A template is a collection of independently admitted panel, worker, Durable
Object, app, and extension principals—not an authority principal or
template-wide grant envelope. The collection flow may batch presentation and
publication, but grants and runtime attribution remain exact-unit scoped.

### D4. Template repositories are workspace-shaped, with nothing loose at section roots

Every unit lives at `<section>/<unit>/...`; `enumerateRepoFiles()` rejects
files directly under a container section. Since these repositories are pnpm
monorepos where `packages/tsconfig.base.json` is exactly where shared config
normally goes — and the failure would otherwise surface at install time, in
someone else's workspace — shared tooling config lives at the repository
root (outside every section, ignored by the resolver), and each template
repository's CI carries a lint asserting it. Reserved paths (e.g. a root
`.npmrc`) are excluded from the admitted set and digest
(`TEMPLATE_RESERVED_PATH_POLICY = "exclude"`) rather than aborting
acquisition.

### D5. Workspaces are created from base as a pin, not a copy

In the resolver, a locally present repo path wins and the template owns
nothing — so if creation kept copying base's units as ordinary files, base
could never own or update them; it would be frozen at whatever shipped.
Therefore creation acquires base over the network as an exact pin (the
`rootTemplate` source kind), and the host imports its tree as ordinary
**local** repositories — deliberately, because generating a lock requires
composition and the host does not compose.

**Adoption:** on the composer's first run it resolves base as the root
without treating its repositories as local, so base claims them the ordinary
way. The content is byte-identical to the bootstrap import, the delta is
empty, and the publication adds exactly the lock and fragment. From then on
base is a normal template on the normal pull path. Base must therefore have
no template dependencies of its own (satisfied by construction); a
third-party root must likewise be independently bootable, with any declared
dependencies completed by the composer's first run.

Offline first-run is explicitly not a requirement: a usable cache would be a
real Git checkout satisfying every exact-snapshot precondition, seeded into
per-profile state and garbage-collected on pin changes — none of it worth
building unless offline creation becomes a requirement (§Deferred).

## Repository inventory

| Repository                        | Contents                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio-workspace-base`       | Every repository not assigned to one of the three optional outcomes below, including Google Workspace, GitHub, local models, mobile, shell, browser, terminal, onboarding + templates skills, model settings, pubsub, shared integrations and channel-fork packages, agent/runtime/UI foundations, and developer tools |
| `vibestudio-template-news`        | `panels/news`, `workers/news-agent`, and `packages/feeds`; shared `packages/channel-fork` remains in base because base-owned agent chat also consumes it                                                                                                                                                               |
| `vibestudio-template-spectrolite` | Spectrolite panel, MDX editor package                                                                                                                                                                                                                                                                                  |
| `vibestudio-template-examples`    | `panels/hello-vanilla`, `panels/hello-svelte`, `workers/hello`, and `workers/sample-do`; these modern examples were restored after an earlier cleanup deleted them instead of extracting them                                                                                                                          |

**Developer tools belong to base.** Vibestudio is a place where people build
things; the development surface (`panels/development`, `panels/testbench`,
the system-test workers and skill, `packages/testkit`, type-check and test
extensions) is core, not an optional outcome. This is a deliberate choice
against "smallest useful base," priced: base acquisition happens on every
workspace creation, so base size is first-run latency. If that bites, the
lever is the audience split — user-facing tooling stays, the platform
self-test harness moves out — which under D1 is an ordinary feature template
declaring base by URL (§Deferred).

**Package placement:** an internal package stays with the feature that owns
it and moves to base only when two or more templates genuinely share it.
Moving a package later is an ownership transfer surfacing as a user-facing
conflict decision on their next update — so bias plausibly-shared packages
into base from the start, and keep the dedicated ownership-transfer system
test (§Test matrix).

## Registry design

`vibestudio-template-registry` is the presentation catalog and the promotion
pointer consulted only when a URL is not in the lock. It is data the composer
fetches and verifies — never composed.

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
    promoted: # CI put this here; never a moving ref
      ref: refs/tags/v1.2.0
      commit: <full lowercase 40-char oid>
      snapshot: v1-sha256:<digest>
```

- `promoted` carries an exact commit and snapshot; promotion is the review
  gate, so "latest" can never mean "whatever landed a minute ago" — this is
  what makes lock-first resolution safe as the default.
- Promotion CI verifies the snapshot digest, checks epoch against the current
  base release, and **composes and builds the candidate against the promoted
  base** — the same gate D1 applies in the user's workspace.
- The manifest remains the source of dependency truth; the registry records
  what an entry resolved to, never what it depends on. Registry CI enforces a
  unique id ↔ URL mapping.
- `revision` is human-facing display metadata, not identity. The registry's
  identity is its verified Git commit and snapshot — the composer already
  verifies these on every acquisition — and registry CI enforces that a
  published revision string never maps to different content. Nothing binds
  authority or staleness decisions to the revision string (§Onboarding flow).
- `recommended` is presentational only — it badges and sorts; it does not
  drive a first-run install set (each add is its own approval and operation;
  a batch would mean N sequential approvals and conflict decisions a new user
  cannot answer). Registry CI nonetheless composes and builds the full
  recommended set together against base, which keeps a first-run set cheap to
  add later — only the batch-approval surface would remain to build.
- The composer caches the last verified registry snapshot; an unreachable
  registry leaves installed workspaces fully usable.

## Onboarding flow

The catalog has one owner: the composer. Onboarding asks it for the catalog;
the composer acquires and verifies the Git registry through the same
exact-snapshot path used for templates and returns revision + entries;
`TemplateCatalog.tsx` renders them (the checked-in
`template-catalog.json` and its host reader are both replaced). Selection
carries the entry id **and the verified registry commit + snapshot** (the
human `revision` rides along as display only); the agent requests an
inspection (exact resolved pin, composition preview, excluded suggestions);
the add runs against that exact inspected pin in its own operation context
through the build gate; suggestions follow as D3's individually decided
actions; onboarding re-renders from a fresh observation.

Constraints: registry staleness between catalog read and add — the selection's
registry commit/snapshot no longer matching the verified registry — is
**rejected**, never silently re-resolved, otherwise the pin the user approved
is not the pin installed. Binding to the commit rather than the revision
string means a registry whose content was replaced under a reused revision
still trips the staleness check. Catalog reads are network work: refresh is explicit or
cache-backed with a stale indicator, never implicit on render. Inspection
performs full recursive acquisition and verification, so it runs only on
explicit selection — never on hover or per-entry in a list. Onboarding UI
never fetches Git and never composes.

## Extracted-repository validation contract

A template repository is a Vibestudio source fragment, not necessarily an
independently installable npm monorepo. Its meaningful test matrix is:

```text
exact Vibestudio host release
        + exact base template release
        + optional template release
        -> Vibestudio build, typecheck, and system tests
```

Dependency resolution follows the composed source graph:

- `@workspace/*` resolves from base plus installed template repositories.
- `@vibestudio/*` is host platform API supplied by the exact Vibestudio
  release and is skipped by external npm installation.
- ordinary third-party dependencies are installed normally.

Consequently, `workspace:*` is valid in extracted manifests and publishing a
versioned host SDK package set is not a blocker. The gates are instead:

1. Workspace-owned implementations live in base/template source while the
   host retains only narrow platform contracts.
2. Every optional template is composed against an exact promoted base and
   exact host release, never local monorepo state.
3. `systemEpoch` proves the host/workspace ABI; the composition lock proves
   exact repository identity.
4. CI exercises the composed result. A bare `git clone && pnpm install &&
pnpm build` of one optional repository is neither required nor presented as
   meaningful validation.

## Migration sequence

Done (verified in-tree): ownership inversion — the composer package,
extension, and skill exist; the host has no template service; CLI routes
through the extension broker; the exact-pin creation path and bootstrap
adoption inspection exist.

Current migration state:

1. **Done:** userland GAD, receiver-enforced capabilities, clone-first
   bootstrap, package residency, deletion, and host-without-workspace gates.
2. **Done:** the ownership inventory in §Repository inventory is reflected by
   the authoring inventory/closure API and validated against buildable source.
3. **Done:** onboarding uses runtime owner discovery and has no compile-time
   imports of capability implementations. While every planned extraction
   owner remains in base, a missing owner is reported as unavailable base
   functionality, never as an installable template.
4. **Done:** URL-only `templates.use`, lock-first resolution, derived aliases,
   exact epoch matching, and build-gated publication are live.
5. **Done:** establish the composed host + base + optional validation contract
   (§Extracted-repository validation contract); no npm SDK publication gate.
6. Extract the final repository set from the current workspace:
   `vibestudio-workspace-base` plus exactly three optional templates:
   `examples`, `news`, and `spectrolite`. Everything not selected by one of
   those three templates remains in base for this cut. In particular, Google
   Workspace, GitHub, local models, mobile, browser, and terminal functionality
   remain in base.
7. Introduce release tagging and cross-repository composition tests; create
   the registry repository with build-gated promotion.
8. **Code side done:** the verified Git registry client binds selection to
   registry commit + snapshot across the service schema, composer, skill
   contract, onboarding, CLI, and tests. Creating and promoting the external
   registry repository remains part of step 7.
9. Switch workspace creation to the exact base pin as the product default
   (D5), delete the in-tree `workspace/` source, and prove that production
   builds and fresh workspace creation have no checkout-relative workspace
   fallback.
10. **After repositories and catalog entries are deployed**, change onboarding
    discovery and presentation so capabilities supplied by
    an optional template are shown as installable, not ready or configurable.
    Selecting one routes through the ordinary verified registry selection and
    template-install flow. After installation, the same catalog entry
    re-resolves to its ordinary setup/use workflow from the newly installed
    owner skill.

## Final extraction boundary

The split is closed-world for this release:

| Repository                        | Content rule                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio-workspace-base`       | Every current workspace repository not owned by one of the three rows below, plus the root workspace metadata, lockfile, default manifest, onboarding core, Google Workspace, GitHub, local models, mobile, template composer/registry client, shell, browser, terminal, and system-test infrastructure required to install and verify optional templates |
| `vibestudio-template-examples`    | Example/demo repositories and their declarations only                                                                                                                                                                                                                                                                                                     |
| `vibestudio-template-news`        | News panel/agent and direct dependencies                                                                                                                                                                                                                                                                                                                  |
| `vibestudio-template-spectrolite` | Spectrolite panel and direct dependencies                                                                                                                                                                                                                                                                                                                 |

Selections are produced and validated by the authoring inventory/closure API.
The table names outcomes; it is not a hand-maintained file list. A repository
shared by base and an optional outcome stays in base and is inherited through
the exact base parent. No source repository is copied into two published
templates.

The monorepo may contain extraction tooling and fixtures, but it must not
contain a live or fallback copy of the workspace source after cutover. The only
default-workspace input is the promoted base template URL and exact release
pin resolved through the ordinary clone-first template path.

## Test matrix

Run before step 9 changes how workspaces are created:

- Creation from a pinned base root; creation with registry or base remote
  unreachable fails actionably with no half-initialized workspace.
- Adding each official feature independently; use synthetic templates for the
  generic two-template repository-overlap and explicit-conflict-decision case,
  because the official three-way partition is intentionally disjoint.
- Lock-first resolution: an add never moves an already-locked base and
  performs no network lookup for it.
- The build gate blocks publication: a non-building feature leaves protected
  main untouched, no partial state, failing units reported; an in-context
  repair ships atomically in the same publication; a repaired template stays
  reconcilable on later pull (divergence as external deltas, never a clobber
  or silent fork); a headless add whose build fails cancels cleanly.
- Registry CI refuses to promote a version that does not build against the
  promoted base; registry offline serves the cached catalog; registry-content
  staleness between read and add (commit/snapshot mismatch, including a reused
  revision string over changed content) is rejected.
- Update discovery through a completed pull, including tag selection across
  a prerelease and its release; rejection/rollback of an in-flight add.
- Suggestion acceptance and decline through the acquisition flow (D3),
  including the re-derive-and-re-ask path after a concurrent publish.
- Package ownership transfer between two templates across an update.
- A file at a container-section root fails the template repository's own CI
  lint (D4); epoch mismatch produces the explicit upgrade error.
- The host does no composition: with the composer removed, template
  operations fail cleanly — there is no second implementation.

## Deferred

Decided against for now, recorded so the reasoning is not relitigated:

- **Offline first-run** (D5): revisit only if creation must work without
  connectivity; the cache cost is described there.
- **Automatic installation of a first-run recommended set**: `recommended`
  remains presentational. After an optional repository and its verified catalog
  entry are deployed, onboarding may recommend and offer it, but installation
  remains an explicit user selection through the ordinary reviewed
  template-install flow.
- **Splitting developer tools by audience**: all in base until first-run
  latency bites; under D1 the extracted harness template is an ordinary
  feature declaring base by URL, so the split stays cheap.
