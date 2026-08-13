# Official template repositories: overlapping contributions with agentic composition

Status: updated 2026-08-10. Examples, News, and Spectrolite have been published
and updated through the running app; their outcome-specific source units have
been removed from the base `workspace/`. Google Workspace is the fourth
optional outcome in this cut. Its implementation is separate from the generic
integrations package, its exact five-unit closure is published as v0.1.1, and
its onboarding contribution is discovered from the installed skill. Those
five source units have consequently been removed from the bundled Base
candidate. The public verified registry is configured in the bundled workspace
and now promotes all four optional outcomes, including Google Workspace
v0.1.1. Those are pre-release extraction proofs, not compatibility commitments.
The external-Base clean cut republishes Base and all four optional templates at
one exact epoch and promotes only that complete generation. Publishing a
standalone npm SDK is explicitly not an extraction prerequisite.

## Outcome

The single packaged workspace source is replaced by independently released
Git repositories, composed by a userland package that ships in base:

- **`vibestudio-workspace-base`** — the useful default workspace distribution.
  It is one possible source of shared infrastructure, not an authoring parent
  whose release coordinates feature templates must capture.
- **Feature template repositories** — one per user-visible outcome (news,
  Spectrolite, examples, and Google Workspace), each publishing the repositories it needs to
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
- The host's only template-specific act is workspace bootstrap
  (`workspaceRootTemplateBootstrap.ts`, `acquireRootTemplateSnapshot.ts`).
  Bootstrap may acquire an exact Git snapshot so creation is reproducible, but
  that installation fact is not copied into feature-template authoring or
  publication (D5).
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
    - url: git+https://github.com/vibestudio/vibestudio-workspace-base.git
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

**The checks:** authoring validates the selected contribution in the current
composed workspace—the state the author can actually inspect and repair. A
consumer then composes the contribution with its own installed sources and
runs build/type/static checks against that result. Failures retain an ordinary
semantic context with structured diagnostics so an agent can fix or merge the
combination; they do not become a non-actionable dependency-version rejection.
Protected main advances only after the reviewed result is publishable. The
checks are compile-and-type, not a promise that one template release works with
every historical base.

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

Consequences: before the supported release, an epoch bump is a coordinated
republication of Base and every official feature repository. Registry CI
records each entry's validated epoch, composes the exact current set, and
refuses mixed-generation promotion. Controlled workspaces on the old epoch are
deleted and recreated; the current host does not parse or upgrade them.

There is deliberately no `minSystemEpoch`/`maxSystemEpoch` range, additive API
revision, or negotiation fallback. Exact equality plus an exact composed build
is the whole contract.

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

### D5. Bootstrap identity is not a publication dependency

Workspace creation and feature-template publication answer different
questions. Creation needs a concrete source snapshot to materialize. A
workspace lock records the exact Git coordinates it resolved so that this one
workspace can update intentionally and reproduce its current composition.
Neither fact gives base exclusive ownership of any repository, and neither is
embedded into a feature release as a validated parent.

An author may select repositories that an installed base also contributes.
If base is installed, inspection can explain which selected or required parts
overlap or could be inherited. If it is not installed, the feature can publish
a self-contained contribution. In both cases the feature manifest contains
only semantic dependency URLs. On installation, ordinary VCS deltas merge all
contributors and local edits; the resulting workspace—not an authoring-time
base pin—is the compatibility boundary.

## Repository inventory

| Repository                             | Contents                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio-workspace-base`            | The complete default workspace other than the four outcomes selected for extraction in this cut. It may overlap a feature template when that feature needs to distribute shared-infrastructure changes. |
| `vibestudio-template-news`             | `panels/news`, `workers/news-agent`, and `packages/feeds`; shared `packages/channel-fork` remains in base because base-owned agent chat also consumes it                                                |
| `vibestudio-template-spectrolite`      | Spectrolite panel, MDX editor package                                                                                                                                                                   |
| `vibestudio-template-examples`         | `panels/hello-vanilla`, `panels/hello-svelte`, `workers/hello`, and `workers/sample-do`; these modern examples were restored after an earlier cleanup deleted them instead of extracting them           |
| `vibestudio-template-google-workspace` | `packages/google-workspace`, `packages/gmail`, `skills/google-workspace`, `skills/google-drive`, and `workers/gmail-agent`. Generic credential and GitHub machinery remains in `packages/integrations`. |

**Developer tools belong to base.** Vibestudio is a place where people build
things; the development surface (`about/testbench`,
the system-test workers and skill, `packages/testkit`, type-check and test
extensions) is core, not an optional outcome. This is a deliberate choice
against "smallest useful base," priced: base acquisition happens on every
workspace creation, so base size is first-run latency. If that bites, the
lever is the audience split — user-facing tooling stays, the platform
self-test harness moves out — which under D1 is an ordinary feature template
declaring base by URL (§Deferred).

**Package selection is not ownership.** The rows describe the initial useful
contributions, not an exclusive partition. A feature normally includes its
direct implementation and deterministic package/runtime closure. It may also
include a shared repository when distributing a coherent infrastructure
change. Later overlap is an ordinary contribution delta and may require an
ordinary merge decision; no ownership-transfer protocol exists.

## Published and prepared releases (2026-08-10)

The three existing candidates were inspected and published through
`@workspace-extensions/template-composer`, reached through the generic in-app
extension broker. Each authoring manifest contains only this semantic
dependency:

```yaml
templates:
  use:
    - url: git+https://github.com/panticonic/vibestudio-workspace-base.git
```

There is no base ref, commit, snapshot, or version in any feature manifest.
Base was not installed in the publishing workspace, so the authoring closure
made each release self-contained by including every required repository from
the observed protected workspace state. This is intentional overlap, not a
temporary ownership workaround.

| Template         | Published repository                              | Immutable release  | Commit                                     | Snapshot                                                                     |
| ---------------- | ------------------------------------------------- | ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Examples         | `panticonic/vibestudio-template-examples`         | `refs/tags/v1.0.3` | `bc4b1ec5ecf6bbb4b3584db2f3e6d651da693aca` | `v1-sha256:159d39fc9223c186b2a50e07fad15aaf40087cbe1ca8349d13bf91725381544e` |
| News             | `panticonic/vibestudio-template-news`             | `refs/tags/v1.0.2` | `090e1ba17abcd01a426b914a41d0a0218579b0ff` | `v1-sha256:f6ad5837333dd3defb49f2cf334c1a551d4abacbef50acbbc48a3f649165bbdc` |
| Spectrolite      | `panticonic/vibestudio-template-spectrolite`      | `refs/tags/v1.0.3` | `e6ddffbea9f28fef8988b6b612e017c8348917a0` | `v1-sha256:27b61de2e6abc3fb952293be22e09acb4649b470406141c79b7f13eeafad824d` |
| Google Workspace | `panticonic/vibestudio-template-google-workspace` | `refs/tags/v0.1.1` | `8bdccc9d5195da9cdb6123396a499f7986a2935b` | `v1-sha256:83602476a3d46139181c23427128e1da30dd0cf79e9a55a2cc32a5186731b6fb` |

Google Workspace completed the same composer path with requested and included
parts exactly equal to the five repositories in the inventory; the composer
added no required parts. Its manifest contains the semantic Base URL and no
exact Base coordinate. Publication used idempotency key
`publish-google-workspace-0.1.1`, and Git Bridge read back the immutable receipt
shown above. A fresh workspace then added that exact release transitively over
its already-adopted Base lineage. The five overlapping contributions converged
through ordinary VCS, passed the affected build gate, and published as operation
`validate-google-workspace-0.1.1-clean-final-proof4`. The Base contribution was
recorded as lineage without materializing or merging its older files. Only after that proof were the five
units deleted from the bundled Base candidate.

The public registry was then created and populated through the same running-app
workflow. Google Workspace's exact publication receipt produced contribution
commit `3e66740840e71556b1776e574ee59ed9580bc523`; reviewed PR #1 merged it into
registry `main` at `6fb0b9aed7901a9f2d8f5df495540d3da18bf309`. An in-app refresh verified
registry revision `2026-08-10.2`, snapshot
`v1-sha256:6505abe3427f04b66885f9f47f734bfce27cbefa837b800c8911ee57d01b498d`,
and all four catalog entries. Registry contribution writes use the ordinary
automatic URL-bound credential selection when no named credential is declared;
registry reads remain anonymous where possible.

The clean consumer proof also closed three build-gate defects exposed by the
larger Gmail worker closure: protected validation derives authority only from
the candidate state (never by re-entering the old workspace build), syntax
inference walks deep generated ASTs iteratively, and executable-closure
authority analysis uses one bounded TypeScript project instead of spawning one
compiler per module.

The publication receipts are authoritative because Git Bridge reads the
published commit back into an exact snapshot before returning. These updates
were produced from the current workspace source, including local source edits,
without requiring shared Git history with the template repositories. The
semantic event protects the inspected workspace state; Git Bridge constructs
the next repository commit from exact protected snapshots and uses the durable
operation ID to recognize its own prior commit on retry.

That workspace-source publication was the extraction path, not the permanent
source-of-truth model. Once an outcome is removed from Base, its external
template repository is authoritative for later releases. A later release
starts from the exact external commit, is edited in a normal checkout or an
explicitly imported isolated semantic context, and publishes a new immutable
commit/tag. It is never reconstructed by looking for the deleted paths in host
`workspace/`. The external-Base plan generalizes the same manifest-projected
checkout exchange for Base and optional template repositories.

This update run exercised partial-publication recovery concretely. News's main
commit landed before the tag push lost network connectivity. Replaying the same
operation ID found that commit, verified the recorded request fingerprint and
tree, and added only the missing immutable `v1.0.1` tag. It also exposed and
repaired transport assumptions that made the agentic path brittle:

- CLI RPC now owns a dispatcher without an implicit response-header deadline;
  reviewed publication and build operations control their own lifetime.
- credential-proxied REST and Git HTTP use owned dispatchers, resilient DNS
  lookup, and explicit cleanup; ordinary REST calls disable connection reuse,
  which had made the second GitHub API request hang or fail.
- Git receive-pack has a bounded 15-minute response/body allowance rather than
  Undici's implicit five-minute header timeout.
- authoring metadata inspection uses bounded concurrency rather than flooding
  the extension RPC lane with every workspace repository at once.

Remaining DX work is narrower: concurrent live invocations for one command ID
should be coalesced, repeated permission requests during a single reviewed
publication should be presented as one coherent operation, and Git transfer
failures should preserve the low-level cause in the agent-facing diagnostic.

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
- Promotion CI verifies the snapshot digest and exact epoch and composes the
  candidate against the exact promoted Base. Every current consumer still
  checks its own composed result and receives ordinary build/merge diagnostics;
  no check admits an older generation.
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
  recommended set together in a representative workspace, which keeps a
  first-run set cheap to add later — only the batch-approval surface would
  remain to build.
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
consumer's Vibestudio host/system epoch
        + consumer's installed contributions and local edits
        + optional template contribution
        -> compose, build, typecheck, static checks, and agent repair if needed
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
2. Authoring checks the current protected workspace state; installation checks
   the consumer's actual composition. Neither invents universal compatibility.
3. `systemEpoch` proves the host/workspace ABI; the workspace lock records
   exact installed Git identities without turning them into release
   dependencies.
4. CI exercises the composed result. A bare `git clone && pnpm install &&
pnpm build` of one optional repository is neither required nor presented as
   meaningful validation.

## Delivery sequence

Done (verified in-tree): responsibility inversion — the composer package,
extension, and skill exist; the host has no template service; CLI routes
through the extension broker; the exact-pin creation path and bootstrap
adoption inspection exist.

Current delivery state:

1. **Done:** userland GAD, receiver-enforced capabilities, clone-first
   bootstrap, package residency, deletion, and host-without-workspace gates.
2. **Done:** the contribution inventory in §Repository inventory is reflected by
   the authoring inventory/closure API and validated against buildable source.
3. **Done:** onboarding uses runtime owner discovery and has no compile-time
   imports of capability implementations. Installed skills contribute their
   own capability definitions and generic status observers. Optional template
   cards come only from the composer's verified registry snapshot and carry
   its exact commit and snapshot into the canonical Templates workflow. It
   never substitutes a template for a broken base capability or embeds an
   official repository table.
4. **Done:** URL-only `templates.use`, lock-first resolution, derived aliases,
   exact epoch matching, and build-gated publication are live.
5. **Done:** establish the consumer-composition validation and repair contract
   (§Extracted-repository validation contract); no npm SDK publication gate.
6. **Four extractions done:** Examples, News, Spectrolite, and Google Workspace
   are published, consumer-validated, and absent from Base. GitHub, local
   models, mobile, browser, and terminal functionality remain in Base.
7. **Done:** all four candidates were published through the in-app authoring
   path with the exact coordinates recorded above. The public registry was
   created, its reviewed Google Workspace contribution was merged, and all four
   entries are promoted.
8. **Code side done:** the verified Git registry client binds selection to
   registry commit + snapshot across the service schema, composer, skill
   contract, onboarding, CLI, and tests. The deployed registry exercises this
   contract rather than a checked-in fallback catalog.
9. Separately cut over workspace creation to an externally published base
   snapshot, delete the in-tree `workspace/` source, and prove that production
   builds and fresh workspace creation have no checkout-relative fallback. As
   part of that pre-release clean cut, republish and revalidate all four
   official feature templates at the same exact epoch and promote only the
   complete generation. The implementation sequence, root-release contract,
   external checkout workflow, and inside-system self-development path are
   specified in `docs/external-base-cutover-and-self-development-plan.md`.
10. **Done:** onboarding
    presents recommended entries from the verified composer catalog and hands
    the reviewed registry coordinates to the ordinary template-install flow.
    Without a configured verified registry it presents no invented template
    choices. The deployed registry includes all four optional outcomes.

## Final extraction boundary

The split is closed-world for this release:

| Repository                             | Content rule                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio-workspace-base`            | Everything retained in the default distribution for this cut, including root metadata, onboarding, GitHub, local models, mobile, template composer/registry client, shell, browser, terminal, and system-test infrastructure. It may overlap the feature rows, but no longer bundles the four extracted optional outcomes. |
| `vibestudio-template-examples`         | Example/demo repositories and their declarations only                                                                                                                                                                                                                                                                      |
| `vibestudio-template-news`             | News panel/agent and direct dependencies                                                                                                                                                                                                                                                                                   |
| `vibestudio-template-spectrolite`      | Spectrolite panel and direct dependencies                                                                                                                                                                                                                                                                                  |
| `vibestudio-template-google-workspace` | Google Workspace credential/API implementation, Gmail package and agent, and Google owner skills.                                                                                                                                                                                                                          |

Selections are produced and validated by the authoring inventory/closure API.
The table names outcomes; it is not a hand-maintained file list or an ownership
map. The same repository may be contributed by base and any number of feature
templates. Ordered contribution ledgers plus ordinary semantic VCS deltas
represent that overlap explicitly.

The monorepo may contain extraction tooling and fixtures, but it must not
contain a live or fallback copy of the workspace source after cutover. The only
default-workspace input is an explicitly configured base template source
resolved through the ordinary clone-first path. Its installed exact coordinate
lives in that workspace's lock, not in downstream feature releases.

## Test matrix

Run before step 9 changes how workspaces are created:

- Creation from an external base snapshot; creation with registry or base remote
  unreachable fails actionably with no half-initialized workspace.
- Adding each official feature independently, plus two-template repository
  overlap and explicit-conflict-decision cases using real or synthetic
  contributions.
- Lock-first resolution: an add never moves an already-locked base and
  performs no network lookup for it.
- The build gate blocks publication: a non-building feature leaves protected
  main untouched, no partial state, failing units reported; an in-context
  repair ships atomically in the same publication; a repaired template stays
  reconcilable on later pull (divergence as external deltas, never a clobber
  or silent fork); a headless add whose build fails cancels cleanly.
- Registry CI refuses to promote a version that does not build in its
  maintained representative composition; registry offline serves the cached
  catalog; registry-content staleness between read and add (commit/snapshot
  mismatch, including a reused revision string over changed content) is
  rejected.
- Update discovery through a completed pull, including tag selection across
  a prerelease and its release; rejection/rollback of an in-flight add.
- Suggestion acceptance and decline through the acquisition flow (D3),
  including the re-derive-and-re-ask path after a concurrent publish.
- A repository becoming overlapping, ceasing to overlap, and changing in two
  templates across updates.
- A file at a container-section root fails the template repository's own CI
  lint (D4); epoch mismatch produces an unsupported-generation error and no
  migration path.
- The host does no composition: with the composer removed, template
  operations fail cleanly — there is no second implementation.

## Deferred

Decided against for now, recorded so the reasoning is not relitigated:

- **Offline first-run**: revisit only if creation must work without
  connectivity; it requires a verified local acquisition cache.
- **Automatic installation of a first-run recommended set**: `recommended`
  remains presentational. After an optional repository and its verified catalog
  entry are deployed, onboarding may recommend and offer it, but installation
  remains an explicit user selection through the ordinary reviewed
  template-install flow.
- **Splitting developer tools by audience**: all in base until first-run
  latency bites; under D1 the extracted harness template is an ordinary
  feature declaring base by URL, so the split stays cheap.
