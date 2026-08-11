# Workspace template composition: monorepo template upstreams, blended via a DAG

Status: historical design record. Repository ownership, conflict-winner
choices, and `templates.conflicts` described below are superseded. The
implemented model records an ordered contribution ledger per repository;
templates may overlap, and added, updated, or removed contributions are merged
through ordinary semantic VCS deltas. Build/type failures retain the operation
context for agent repair and `resume` rebuilds that context.

> **2026-08-11 state cutover:** every lock, fingerprint, fragment-integrity,
> and mismatch-rejection rule below is also superseded. Current workspace
> content is authoritative. `meta/templates.state.yml` records relationships,
> installed source selections, and merge baselines only; template layer files
> are mutable workspace files. Exact snapshot checks and fingerprints exist
> only inside the new or updated operation being reviewed. Persistent template
> metadata can lose attribution or update convenience when malformed, but it
> cannot reject workspace drift or block publication.

> **Canonical architecture:** the official-repositories plan supersedes every
> host-owned lifecycle, service, journal, catalog, and filesystem-template
> statement below—not only the manifest paths. Template resolution and
> operations now live in `workspace/packages/template-composer` and
> `workspace/extensions/template-composer`; semantic operation contexts are
> their durable state; the CLI calls that extension through the generic
> extension broker. There is no host `templates` service, host resolver,
> template lifecycle journal, or checked-in presentation catalog. The
> composition rules, Git interchange invariants, semantic review model, and UX
> outcomes below remain historical context only where they agree with the
> contribution-ledger model above.

## Outcome

A workspace's initial full state is assembled from **workspace templates**.
At creation the user picks exactly one _root_ template (the packaged default
or a URL); its DAG closure may still bring in several. Additional templates
are added at runtime — including from the onboarding conversation via an
inline catalog UI. A template is an ordinary Git repository shaped like a workspace
monorepo: it contains section directories (`panels/`, `workers/`, `packages/`,
…) whose immediate children are unit repos, plus a `meta/template.yml`
manifest fragment. Templates may themselves declare templates, forming a DAG
(e.g. `news-workspace` → `vibestudio-base` which carries pubsub, chat,
gad/vcs skills, and other basics).

After initialization, each template remains a live upstream: the workspace can
pull template updates (arriving as ordinary semantic candidates, integrated
per-repo) and push local changes back to the template monorepo (as subtree
commits on a contribution branch). Internally, the system keeps tracking
individual project repos — `panels/news` and `workers/news` are still two
repos with two protected mains; the monorepo boundary exists only at the Git
interchange layer.

This plan uses the generic exact-snapshot primitives shared with root
bootstrap: ref, commit, and canonical `v1-sha256` digest. Composition,
repository acquisition, and durable operation state are userland behavior. A
template is a verified repository snapshot plus a manifest fragment, not a
host-owned initialization workflow.

## Relationship to the existing system

| Existing piece                                                    | Role here                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical `initWorkspace(name, { templateDir })` filesystem copy | Deleted by the official-repositories cutover. Root bootstrap acquires an exact promoted Git pin; there is no filesystem-template or packaged-source fallback. |
| Generic Git bridge and semantic import                            | Userland acquires per-unit external repositories after bootstrap and submits ordinary semantic candidates.                                                    |
| `discoverRepos()` one-owner-per-path law                          | Preserved. Composition assigns each repoPath to exactly one template before any import happens.                                                               |
| `GitBridge` / `UpstreamEngine` per-repoPath sync                  | Extended with a monorepo remote abstraction (shared checkout + path prefix per repo).                                                                         |
| Gated meta writes (`workspaceConfigWriter.ts`)                    | Manifest merging produces an ordinary gated meta push; template-contributed sections flow through the same approval surface.                                  |

## Declaration

> **Superseded manifest paths:** `docs/official-template-repositories-plan.md`
> moves the workspace-authored declaration below to
> `meta/templates/workspace.yml`, moves each template repository's source
> manifest to `meta/template.yml`, and reserves `meta/vibestudio.yml` for the
> flattened host runtime manifest. The older host-owned composition described
> in this document no longer reads or writes these layers.

`meta/templates/workspace.yml` gains a `templates` section, sibling of `git`:

```yaml
templates:
  use:
    - name: base
      url: git+https://github.com/vibestudio/template-base.git
      ref: refs/tags/v4
      commit: 8c1f0d2e… # full oid, mandatory
      snapshot: v1-sha256:… # canonical digest of the admitted tree
      credential: github-main # logical name, profile-resolved
    - name: news
      url: git+https://github.com/vibestudio/template-news.git
      ref: refs/tags/v1
      commit: 41ab…
      snapshot: v1-sha256:…
  conflicts: # optional, path-based, user-controlled
    packages/chat: base # take packages/chat from template 'base'
    workers/legacy-feed: ignore # exclude from all templates
```

Rules:

- `commit` and `snapshot` are mandatory. A branch name is never a template
  identity. Bumping a template is an
  explicit, gated edit of `ref`/`commit`/`snapshot`.
- A template's own `meta/template.yml` may carry `templates.use`, forming
  the DAG. Only the **direct** parents are pinned in each node; the transitive
  closure is fully determined because every edge pins an exact commit.
- The workspace's `meta` repo is always locally owned. A template's
  `meta/template.yml` is read as a _manifest fragment_ input to composition;
  it is never imported as the workspace's `meta` repo (workspace identity never
  lives in an external repo).

## Resolution: the composition plan

### Bootstrap from an external root

Bootstrap hard-requires a ready `meta/vibestudio.yml` runtime manifest before
userland exists. A root template therefore ships that flattened runtime
artifact alongside `meta/template.yml`; bootstrap imports the root tree
naively and does not interpret template source:

- Workspace creation records a host-owned, journaled **creation descriptor**
  (`state/workspace-creation/v1.json`): `{rootTemplate: {url, ref, commit,
snapshot, alias, credential?}, overrides?, workspaceId}` — resolved to
  exact coordinates at creation time. `overrides` is an optional pin map
  for the one remediation that cannot wait for a workspace to exist: a pin
  conflict _inside the chosen root's closure_ (a diamond at two commits).
  With a single root pin and no meta to edit yet, creation must either
  accept override pins (surfaced by the creation UX when resolution fails)
  or reject the root as invalid until its repository fixes the conflict;
  the descriptor supports the former, and the rendered top layer carries
  the overrides so activation resolves identically. `alias` and the logical `credential` name
  are required inputs precisely because the rendered pin must be
  reproducible byte-for-byte (private roots cannot be re-fetched without
  the credential binding). `workspaceId` is host-resolved routing state and
  is **never** written into the YAML — `renderWorkspaceConfigYaml` already
  strips `id` from persisted manifests, and bootstrap follows the same rule.
- Each bootstrap artifact belongs to exactly one phase, because
  `initWorkspace` runs before any closure has been fetched and therefore
  cannot render closure-derived files:
  1. **Creation** writes the descriptor and the deterministic top-layer
     `vibestudio.yml` only (`WORKSPACE_SYSTEM_EPOCH` + the single root
     pin) — both derivable without network.
  2. **Activation** reads that pin before scanning, resolves the closure,
     and builds the fragment files `meta/templates/<node-id>.yml` and
     `templates.lock.yml` as CAS descriptors in the composition journal.
  3. **Activation** combines those generated meta descriptors with the
     scanned local repositories in the one initialization import.
     Closure-derived files are never written incrementally into the managed
     source tree (that would introduce partial-filesystem crash states), and no
     gated apply exists before the first
     publication — the runtime gated-apply path is strictly
     post-initialization. Descriptor, composition, and import phases share
     one recovery journal so a crash at any point resumes into the same
     publication.
- The descriptor is the resume authority: restart before the first
  publication re-renders the same meta byte-for-byte (all inputs are pinned).
  After the first publication the descriptor is inert history.

### Resolution steps

Composition runs inside `activateWorkspaceFromSource()` before `localState()`
scanning. It is a pure, deterministic
function of the root pins, producing a fingerprinted **composition plan**
journaled at `state/workspace-templates/v1.json`.

1. **Fetch closure.** Depth-first over `templates.use`, using the shared
   `GitClient` exact-snapshot primitive. Each node is verified
   (ref → expected commit → tree digest) before its own manifest is read.
   Checkouts land under `state/git-checkouts/_templates/<node-id>` and are never
   build inputs.
2. **DAG shape.** Node identity is the **canonical node ID**: a short digest
   of `(normalized url, commit)`, e.g. `t-3f9a12`. All persisted state —
   checkout paths (`state/git-checkouts/_templates/<node-id>`), the lock,
   ownership records, journal entries — keys on the node ID. `name` is a
   display alias only; the resolver validates that aliases are unique across
   the closure (root declarations may rename: `alias: base-2`) and rejects
   ambiguity, so `templates pull base` and `conflicts.<path>: base` resolve
   deterministically or fail with the alias collision named. The same URL at
   two different commits reached via a diamond is a **pin conflict** — fail
   fast; the user resolves it by pinning that template directly at the root
   (root pins win over inherited pins, npm-overrides style).
   Cycles are a hard error.
3. **Repo assignment.** Enumerate each template's unit repos via the same
   shape rule as `discoverRepos()` (section dir → immediate child). Build the
   map `repoPath → owning template`. **Ownership is stateful**: after the
   first composition, every template repo is necessarily present locally, so
   "present in the local tree" cannot mean "locally owned" — the previous
   lock's assignment is authoritative regardless of local content
   divergence. Precedence, in order:
   - a valid existing lock assignment for the path stands (local edits to a
     template-owned repo are divergence to integrate, not a change of
     ownership). **Validity is defined**: the assignment holds only while
     its owning node is still reachable in the resolved closure _and_ still
     claims that path at its pinned commit. When either fails — the node
     dropped out of the DAG, or the template stopped shipping that repo —
     the recomposition delta must explicitly orphan the path to local or
     transfer it to the newly claiming template, with consent; a stale lock
     never silently retains ownership for a vanished owner;
   - for **unassigned** paths only (initial composition, or a path new to
     this add), workspace-local content wins over every template;
   - a child template wins over its ancestors (you depend on `base` in order
     to override parts of it);
   - two **unrelated** templates claiming the same repoPath is a conflict:
     fail fast unless `templates.conflicts` names a winner or `ignore`.
     Ownership changes only through explicit acts: `remove` reassigns to
     local (orphan), a conflict resolution names a new owner, and forks
     inherit assignments from the copied lock verbatim.
     No file-level blending: the unit of composition is the repo. Two templates
     never co-author one repo's initial content.
4. **Manifest merge.** See next section; produces both the userland
   `meta/templates/workspace.yml` source and effective `meta/vibestudio.yml`
   runtime content.
5. **Nested upstreams.** An upstream names a remote, so the accepted Git
   fragment is defined precisely rather than excluding `git` wholesale:
   - **may merge**: credential-free remote URL + branch declarations
     (`git.remotes`), upstream declarations, and _logical_ credential
     requirements (names to be bound per profile);
   - **never merge**: concrete credential IDs or material, and author
     identity settings;
   - remote-name conflicts resolve by canonical identity (normalized URL),
     repo-path conflicts by canonical repoPath;
   - validation requires every contributed upstream to resolve against the
     **final composed** remote map — a template contributing an upstream
     whose remote lost its declaration in composition is a fail-fast, not
     a runtime surprise.
     The composed union covers ordinary `git.upstreams` contributed by template
     manifests after conflict resolution. Upstreams describe ongoing
     synchronization only; they do not cause host initialization imports.

Initialization then follows the exact root-bootstrap lifecycle: one
`filesystem` import for any local-only content, one `git` import **per
assigned repo** (source uri `git+<url>#<commit>:<subdir>`, carrying the
template's provenance), one import per unit-level seed, then a single push to
protected main. Readiness states, resumable journal phases, and the
"required means required" rule carry over unchanged.

### Slicing and the two digests

Subtree slicing is a **host-side acquisition concern**, not a semantic-schema
one: `vcsImportSnapshot` already receives pre-sliced file descriptors and
performs no clone or extraction, so the shared Git snapshot primitive gains
the subtree carve (clone once, emit per-repoPath file sets). Each import
names exactly one repository, satisfying the existing git-source refinement —
no schema change is required. The subdir rides in the provenance URI
(`git+<url>#<commit>:<subdir>`).

Two distinct identities are recorded, explicitly:

- the **template snapshot digest** (whole verified monorepo tree) — lives in
  the pin, checked at acquisition before any slicing;
- the **admitted subtree digest** per repoPath — what the semantic layer
  computes from the admitted descriptors; recorded in the lock as each
  repo's contribution base.

Conflating them would make pin verification and per-repo three-way bases
silently different quantities.

## Manifest composition: layered fragments, not baked values

Treating a flattened `meta/vibestudio.yml` as the next composition source —
destroys the distinction between local intent and inherited state: after one
bake, every template value looks workspace-authored, and correct pulls would
require the lock to carry exact old fragment values plus tombstones and a
field-level three-way merge per section. Instead, template manifests stay
**structurally separate as local files**:

- Each template node's accepted manifest fragment is written (by the gated
  apply) to `meta/templates/<node-id>.yml` inside the workspace's own `meta`
  repo. It is a local copy — the template's meta repo is still never
  imported — but it is _whole-file owned_ by that template node.
- `meta/templates/workspace.yml` is the workspace-authored top layer: root pins,
  repo conflict resolutions, and local declarations. Overriding an inherited
  manifest entry needs no special syntax — the top layer wins by
  **redeclaring the same canonical key**. The only dedicated mechanism is
  removal: one generic `disable:` list of `section/<canonical key>` entries
  (e.g. `disable: ["extensions/panels/legacy", "recurring/nightly-digest"]`).
- `meta/vibestudio.yml` is generated flattened runtime state. Every host
  consumer reads this one file and never loads the source, lock, or fragments.
  Userland reconstructs the prior generated runtime from the source and exact
  fragments, projects ordinary runtime-setting edits back into the source,
  composes the next runtime, and publishes the entire result atomically.

This makes "who owns this value" a structural fact, not a lock annotation:

- **Pull** becomes trivial for manifests — the template's new fragment
  replaces its own file, shown as an ordinary readable diff in the gated
  meta approval. No field-level merge; local overrides in the top layer are
  untouched and re-apply at compose time.
- **Remove** deletes the fragment file; **fork** copies layers intact.
- The lock shrinks to closure + repo assignment; manifest attribution is the
  file layout itself.

### Canonical entry identity (per section)

Composition still needs exact identity to detect sibling conflicts and to
address overrides. Keys follow the real schema shapes
(`packages/workspace-contracts/src/workspaceConfigSchema.ts`):

| Section                   | Identity key                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`, `apps`      | `source` (the `ref` is a _value_; differing refs for one source across siblings is a conflict)                                                                                                                                                                                                                                                       |
| `services`                | `(source, name)`                                                                                                                                                                                                                                                                                                                                     |
| `routes`                  | `(source, path)`                                                                                                                                                                                                                                                                                                                                     |
| `singletonObjects`        | `(source, className, key)`                                                                                                                                                                                                                                                                                                                           |
| `recurring`, `heartbeats` | `name`                                                                                                                                                                                                                                                                                                                                               |
| `initPanels`              | not merged at all — one whole-list value, latest in DAG order wins (workspace top layer, else the deepest declaring template). initPanels only matter at first start (`seedPanelTreeIfEmpty` never re-fires), the workspace always starts from one root closure, and runtime-added templates can never trigger them — so blending them buys nothing. |

Same key contributed by two unrelated sibling templates: **fail fast**, and
the resolution is always the same move — the user (or the guided approval
flow) redeclares the winning value in the top layer, which then shadows both
contributions. There is no separate manifest conflict-resolution map; the
top layer _is_ the resolution surface. A child template overriding its
ancestor's key is normal layering and no conflict at all.

Remaining rules:

- **Scalar / map sections** — `defaultRepo`, `defaultAgentConfig`,
  `hostTargets`: layer order, later wins, workspace wins.
- **Never accepted from templates** (hard-coded, not configurable): `trust`,
  `providers`, credential-bearing parts of `git`. These are consent and
  capability surfaces; a template must not be able to grant itself trust or
  rebind providers by being depended on. A template _may_ ship them as
  suggestions surfaced in the approval UI, but they never merge silently.
- **`systemEpoch`**: every template in the closure must declare an epoch
  compatible with `WORKSPACE_SYSTEM_EPOCH`; mismatch is a fail-fast with a
  clear "template needs upgrading" message.

The generated `meta/templates.lock.yml` records the resolved closure (node
IDs, aliases, pins, DAG edges), the repo assignment map, each repo's
admitted subtree digest (its contribution base for pull), and **each
accepted fragment file's canonical digest**. Fragment ownership is
enforced, not just asserted — and the lock is **a checked projection, not
the authority for its own integrity**: both fragment and lock are ordinary
editable files in the locally owned meta repo, so validating one against
the other proves nothing (edit both together and the check passes). Every
recomposition therefore _derives_ the expected sanitized fragment digest
from the pinned template snapshot itself (the pin's coordinates are the
only tamper-evident input) and validates fragment **and** lock against
that derived fingerprint. Deriving requires the template content (CAS or
checkout); when it is absent — a fresh fork validating offline — the check
degrades to lock↔fragment consistency and records that full verification
is deferred to the next acquisition (any pull, check, or add re-anchors
it). The degraded mode is reported in `templates.status`, never silent.
A mismatch is a hard failure whose message says
to move the intended override into
`meta/templates/workspace.yml` (the top layer is the only composition-intent
surface);
edited fragment content is never silently consumed as a template
contribution and never silently overwritten by pull. Path-admission rules
may additionally warn on direct fragment edits as UX hardening, but the
digest check is the guarantee. It is derived
output — regenerated on every composition — but lives in the `meta` repo so
that pulls have their exact bases and the audit trail survives workspace
forks. Manifest attribution needs no lock entries: the fragment file layout
carries it.

Missions stay out of scope: mission charters are host-owned documents by
design (`docs/mission-subsystem-spec.md`), so a template ships the harness
unit and skills but not charters. If template-shipped charters are wanted
later, that is a new seed channel analogous to `seed/missions/`, not a
manifest section.

## Pull

`templates pull <name>` (service method + CLI + panel surface):

1. Fetch the new target (again exact: user supplies or confirms
   ref/commit/snapshot; a convenience mode resolves a tag to its commit and
   shows it for confirmation — it never silently tracks a branch).
2. Re-run composition against the _new_ closure. Ownership changes (template
   added/dropped a repo) surface as explicit adds/removes needing consent.
3. For each owned repo whose template subtree changed, pull needs a source
   event that represents _exactly_ old-template → new-template. Neither
   `compare` inputs nor context creation can express this today:
   `vcs.compare` takes only a target state and a committed source event (a
   lock digest is not an input), a newly ensured context always starts at
   protected main (`semanticVcsStore.ts:393`), and comparison includes every
   source event back to the common target ancestor
   (`semanticWorkspace.ts:5139`) — so "import old, then new, then compare"
   would smuggle a current-main→old-template delta into the candidate.
   A committed event cannot carry this either: the engine authors only
   _true_ transitions — import planning derives every change's base from
   the state root of the context's `expectedWorkingHead`
   (`semanticWorkspace.ts:2905`) — so an event on a main-based context whose
   changes encode old-template bases would record a transition that never
   happened.
   The plan therefore names one new semantic contract: a first-class
   **unapplied external change-set node**, registered by the template
   coordinator through a host-only semantic operation.
   Given verified old and new descriptor sets (both reacquired from exact
   lock/pin coordinates and digest-checked), it records an external delta
   as **evidence, not a state transition**: a node carrying new-vs-old
   changes with old-content predicates, no parent state, no application.
   `compare` and `merge` are extended to accept this node as a source
   alongside committed events; classification uses its predicates against
   the target, and only an integration decision + commit _applies_ anything
   to workspace state — at which point the recorded transition is real.
   This is a **new semantic object type, not an adapter**; its full
   contract is specified below. Forks depend on this construction
   entirely: parent event IDs do not travel with copied source, so the old
   side is always rebuilt from coordinates. Template updates are never
   auto-published.
4. Per-repository decisions may happen incrementally through ordinary public
   `vcs.compare` and `vcs.merge`. Each delta is owned by the exact template
   operation context. A completed integration automatically wakes the
   coordinator; there is no template-specific review method or pull retry.
5. Finalization is **indivisible**: once every per-repo delta has a
   decision, the fragment replacement (shown as an ordinary readable
   diff), pin bump, fragment digest, and lock regeneration land in **one**
   meta commit and one protected-main publication. There is no intermediate
   state where the effective configuration comes from the new template
   while the pin and lock still identify the old one. Workspace-layer
   overrides are untouched; newly introduced sibling conflicts or override
   targets that vanished are reported at compose time, before
   finalization. Finalization additionally runs the **whole-graph
   validation** from the seeds contract over the _post-decision_ result:
   the actual repository set (after declines, orphans, and ownership
   transfers) joined with the composed manifest. Any app, extension,
   panel, service, route, provider reference, or upstream that no longer
   resolves — e.g. a new manifest declaration whose unit's repository
   change was declined — **blocks finalization** with a U7-mapped error
   naming the unresolved declaration and the decision that stranded it.
   Declining is always allowed; finalizing an inconsistent workspace is
   not.

### The host-owned external delta contract

- **Input**: mutation envelope; `repositoryId` + `repoPath`; `source`
  (same shape as import: kind/uri/snapshotRevision) for _both_ sides —
  old and new coordinates; `oldFiles` / `newFiles` descriptor sets
  (`vcsSnapshotFileSchema`), each digest-checked against the declared
  subtree digests before registration. Size limits and authorization tier
  are identical to `importSnapshot`; one delta describes exactly one
  repository.
- **Identity & idempotency**: `deltaId = canonicalDigest(protocol tag,
ownerContextId, repositoryId, oldSubtreeDigest, newSubtreeDigest)`.
  Integration and lifecycle mutation require that exact owner context.
  Re-registration with
  identical inputs returns the existing node; same coordinates with
  different content is an integrity failure.
- **What it mints**: one real `WorkUnit` (flagged `external-unapplied`)
  and ordinary `Change` rows (text-edit / file-create / file-delete with
  bases drawn from old-side content) — so `merge`'s existing
  `decision.sourceChangeIds` contract applies unchanged. What it never
  mints: a `WorkApplication`, an event, or a state node.
- **Path mapping**: old-side paths resolve to current repository/file IDs
  through the workspace fact map at the _target_ state by
  `(repositoryId, path)`; paths unknown at the target (template-added
  files) mint fresh file IDs in the change results, mirroring
  `importSnapshot` planning.
- **Compare/merge extension**: `vcsCompareInputSchema` and
  `vcsMergeInputSchema` gain a `sourceDeltaId` alternative to
  `sourceEventId` (exclusive union). Comparison's "source story" for a
  delta is its change list; classification runs the same predicate
  machinery against the target. Adopted changes are applied by the normal
  application path on the working head — a predicate that fails at
  application surfaces as the ordinary reconcile flow, not a special
  case. The eventual integration commit records the delta identity
  (uri + both digests) as provenance in place of a source event parent.
- **Lifecycle**: a registered delta is a content GC root until every one
  of its changes carries a decision and a finalization references it;
  then it is GC-eligible (decisions persist as history). If the pin moves
  again before decisions complete, the new pull registers the new delta
  and marks the old one **superseded**: recorded decisions remain,
  undecided changes stop counting toward any pending-review state, and a
  superseded delta can no longer be integrated.

## Runtime addition: `templates add <url>`

Adding a template to an already-initialized workspace is the same composition
machinery run as a **delta**, wrapped in a user-friendly, atomic flow:

1. **Resolve.** The user supplies just a URL. The resolver fetches, picks the
   default branch head or latest release tag, and resolves it to an exact
   `(ref, commit, snapshot)` triple shown for confirmation. The pin that gets
   written is always exact; the branch/tag was only a discovery convenience.
   The template's own DAG closure is fetched and verified the same way as at
   init.
2. **Dry-run composition delta.** Compose the candidate closure against the
   _current_ workspace: which repoPaths would be added, which collide with
   existing workspace repos or with other templates' owned repos, which
   manifest entries merge cleanly vs. conflict, which unit-level upstreams
   would be introduced. Nothing is imported yet.
3. **Live conflict handling.** The delta renders as one approval interaction
   (same gated-approval surface as meta writes): clean adds listed for
   consent; each conflict presented as an explicit per-path choice —
   `keep local`, `take template` (arrives as an integration candidate, never
   an overwrite), or `ignore` — written into `templates.conflicts`, so the
   resolution is durable, inspectable config. Manifest key conflicts are
   resolved by the same flow writing the chosen value as a top-layer
   redeclaration (or a `disable:` entry); excluded sections (`trust`,
   `providers`) appear as non-mergeable suggestions only.
4. **Atomic apply.** One journaled operation (extending the seeds-plan
   journal phases): N `importSnapshot` events for new repos, integration
   candidates for `take template` choices, the manifest merge, pin + lock
   update — published by **one** gated meta-inclusive push per affected repo
   set, with all-or-nothing semantics. This requires a dedicated
   **template-apply transaction primitive**: the existing config writer
   cannot host it, because `createWorkspaceConfigMainWriter` deliberately
   abandons a dirty/behind context, takes a fresh one, and immediately
   edit→commit→pushes the meta change alone
   (`src/server/workspaceConfigWriter.ts:297-359`). The apply operation
   instead owns one clean context end-to-end: authors all imports, then the
   meta edit, commits, and sends a single protected-main advance through the
   approval gate. WP-T5.5 includes this primitive (either a new
   `templateApply` host operation or a compose-into-caller-context mode of
   the config writer with the abandonment behavior disabled). On abort or failure, unpublished
   candidates are discarded and no pin is written; there is no intermediate
   state where the pin exists but the repos don't (or vice versa). Resumption
   follows the journal, mirroring init's resumable phases.

`templates remove <name>` severs a relationship, but the relationship is a
DAG closure, not one node — so removal is a **reachability recompute**:

- only **direct** top-layer pins are removable (an inherited node has no
  pin to remove; the error names the direct templates that pull it in);
- recompute reachability from the remaining root pins: every node whose
  inbound reachable count drops to zero loses its fragment file and its
  assignments; nodes still reachable through another root are retained
  untouched;
- repos are orphaned (assignment → local) according to the old-vs-new
  assignment delta, never by naive per-node listing.

The whole result — pin removal, dropped fragments, lock regeneration,
orphaned assignments — lands in one atomic gated apply. Deleting content is
left to ordinary workspace editing; no per-path deletion wizard.

## Onboarding: one root template + in-chat catalog

Startup stays deliberately simple: a workspace is created from **one** root
template (the packaged default, or a chosen URL). Everything beyond that is
runtime addition, driven from the onboarding conversation:

- **Catalog.** The composer reads a verified Git registry, keeps the last
  verified snapshot for offline display, and binds selection to the registry
  commit and snapshot. It is presentation data only; the exact promoted
  template pin remains the installation identity. Arbitrary URLs remain a
  first-class input alongside the catalog.
- **Inline UI.** Following the existing onboarding pattern
  (`composeOnboardingSnapshot` / `SetupHub.tsx` rendered via `client_eval` +
  `inline_ui`), the onboarding skill gains a `TemplateCatalog.tsx` app-store
  card: browse/search catalog entries, "Add" per entry, paste-a-URL row.
  Selections arrive as structured `interaction` objects (`kind:
"template-add"`, `targetId`), never inferred from button labels — same
  routing rule the onboarding prompt already enforces.
- **Flow.** The skill routes a selection into the `templates add` service
  method. The dry-run delta and conflict choices surface through the standard
  gated-approval interaction; the agent narrates the outcome and re-composes
  a fresh observation card (installed / conflicts pending / failed), matching
  the onboarding rule of rendering new observations rather than mutating old
  cards.
- The onboarding agent never resolves or pins anything itself; it only calls
  the service. All atomicity, verification, and consent live in the host flow
  above.

## Forking a workspace

A fork copies the source sections, including `meta` — so template pins,
`templates.conflicts`, and `templates.lock.yml` all carry over. The rules:

- **A fork does not re-seed.** Template-owned content is already materialized
  in the copied repos, and the copied lock matches the copied pins. Fork
  activation therefore imports everything as one local filesystem snapshot
  (as today) and performs **no template fetching** — a lock that matches
  the pins means composition has nothing to acquire, and the copied lock's
  assignments carry template ownership forward unchanged (ownership is
  stateful; mere local presence never reassigns it). A fork works offline
  and never blocks on template credentials. Composition re-runs from the network only when pins and lock
  disagree — which in a fork means the fork's owner explicitly edited pins.
- **Pins are inherited as live relationships.** Because the lock (repo
  assignment + subtree bases) and the manifest fragment files all travel in
  `meta`, the fork can pull template updates with the same exact bases the
  parent had. This is the decisive argument for keeping the lock in `meta`
  rather than `state/`.
- **Forks diverge independently.** Parent and fork bump pins on their own
  schedules; nothing links them after the copy. Push collisions are avoided
  structurally: contribution branches are namespaced per workspace
  (`vibestudio/<workspace>/…`).
- **In-flight operations don't travel.** The composition/add journal lives in
  `state/`, and a pin is only written by the atomic apply. Forking a
  workspace that has a template add in progress yields a fork that simply
  doesn't have that template — never a half-applied one.

## Update notifications

Each `templates.use` entry may carry an optional discovery hint:

```yaml
- name: base
  url: …
  ref: refs/tags/v4
  commit: …
  snapshot: v1-sha256:…
  track: "refs/tags/v*" # optional; default: none
```

- `track` is a ref pattern (tag glob or a branch ref). It affects
  **discovery only** — the pin remains the exact triple, and nothing is ever
  applied automatically.
- Update checking is **on-view, not scheduled** — no background poller, no
  clock. The lifecycle events that trigger a fetch are exactly the moments
  someone could act on the answer: `templateStatus` is requested, the
  template catalog card renders, or the user runs `templates check`. (A
  `recurring[]` job couldn't host this anyway — recurring declarations
  target a workspace DO, not a host callback — and discovery needs
  host-side credential bindings, so the template service performs the fetch
  itself when asked.) The service resolves the best candidate per tracked
  template (highest version-sorted tag, or branch head) and reports
  `update-available` with `{candidateRef, candidateCommit}`; the last
  result may be cached in `state/workspace-templates/updates.json` purely
  to render instantly while a refresh runs.
- Surfaces: the onboarding/template catalog card shows an "Update available →
  v5" affordance per template, routing into the standard pull flow (which
  resolves and displays the exact commit + snapshot digest for confirmation
  before anything is fetched into composition). CLI `templates status` prints
  the same.
- Notification state is per-workspace, derived, and disposable — it never
  enters `meta` and never influences composition. A fork starts with an
  empty updates file and discovers through its own on-view checks.

## Push

Pushing back to a template monorepo is a _multi-repo_ Git export:

- One shared checkout per template remote at
  `state/git-checkouts/_templates/<node-id>` with a lock
  (reuse `repoLocks.ts` pattern).
- The **export frontier is durable and authoritative**: per node and per
  repo, `state/workspace-templates/export-frontier/<node-id>.json` records
  the last exported semantic event and the subtree tree-hash it produced.
  `templates push` selects repos whose protected main advanced past that
  frontier — never by inspecting the checkout — and advances the frontier
  only after the wire confirms the branch update.
- Branch identity is collision-safe: `vibestudio/<workspace>/<opId>` where
  `opId` is the push operation's UUID (a date is display metadata, not
  identity — two same-day pushes must not collide). Before updating any
  branch, the remote is fetched and compared; remote truth always comes
  from the wire, never from the frontier record.
- `templates push <name>` constructs
  commits on that **contribution branch** (pushing to the template's
  default branch is possible but requires
  explicit flag + permission on the remote). Granularity is fixed: **one
  commit per repo**, per-repo history preserved. (A batched
  all-subtrees-in-one-commit mode is deliberately not offered until a real
  template maintainer asks for it.)
- Commits carry the existing provenance trailers
  (`Vibestudio-Event`/`-Repository`/`-State`) plus
  `Vibestudio-Template-Subtree: <repoPath>` so a later pull can recognize its
  own exports (same trick `GitBridge` already uses per-repo).
- Repos with a **unit-level upstream** are excluded from template push/pull
  content flow: exactly one sync upstream per repoPath (declared conflict
  otherwise). For those repos the template relationship is seed/pin-only.
- Push honors the seeds-plan fix: remote truth comes from the wire
  (fetched remote ref), never from a cached `lastPushedSha`.

## Failure and conflict UX

- Every conflict class is a structured, named error with the resolution
  written into it: `TemplateRepoConflict {repoPath, claimants[]}` → "add
  `templates.conflicts.<repoPath>: <name|ignore>`";
  `TemplatePinConflict {url, commits[], paths-through-dag}` → "pin `<url>` at
  the root"; `ManifestEntryConflict {section, key, claimants[]}`.
- Default is fail fast. There is no ordering-based silent shadowing between
  unrelated templates: DAGs have no natural sibling order and silent
  last-wins makes composition sensitive to list reordering.
- Initialization blocking states extend the seeds-plan readiness enum with
  `resolving-templates` and `template-conflict`.

## UX specification

This section is normative, in the sense of `approval-prompt-ux-spec.md`: no
template prompt ships without a card type registered in the prompt registry,
all copy lives in the registry (never inline in service code), and the §9
copy lint applies. The audience assumption is the same — non-technical
family members, often on a phone, mid-task.

### U0. Vocabulary (extends the canonical translation table)

| Internal concept                               | User-facing language                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| workspace template / template node             | "template" — always with its display name: "the News template"                                           |
| template DAG / closure / transitive dependency | "templates it brings along" / "{name} comes with {other}" — the graph is never drawn or named            |
| pin (ref+commit+snapshot)                      | "this exact version" / the tag name when one exists: "v4"                                                |
| canonical node ID                              | never surfaces; templates are named by alias everywhere                                                  |
| lock / fragment file / fragment digest         | never surface. Fragment-derived settings are "settings from {name}"                                      |
| repo / repoPath / subtree                      | "part" in counts ("adds 12 parts"), otherwise the concrete thing: "the News panel", "the pubsub package" |
| external delta / candidate / integration       | "incoming changes" / "review changes"                                                                    |
| orphan (assignment → local)                    | "becomes part of your workspace"                                                                         |
| contribution branch / push upstream            | "suggest your changes to {name}"                                                                         |
| track hint / update discovery                  | "updates" — "An update to {name} is available (v5)"                                                      |
| pin conflict (diamond)                         | "{a} and {b} disagree about which version of {c} to use"                                                 |
| repo conflict                                  | "Both {a} and {b} include {part}"                                                                        |
| fragment digest mismatch                       | "You edited settings that {name} manages"                                                                |

Banned-word rule applies in full: `digest`, `closure`, `hash`, `provenance`,
`artifact` etc. never appear outside the labeled technical block of a
Details pane. Additional template-specific bans in user copy: _monorepo,
DAG, node, pin, lock, fragment, subtree, upstream, ref, OID_.

### U1. Surface inventory

1. **Creation picker** — new-workspace dialog (hub) + `--template` CLI flag.
2. **Template catalog card** — inline UI in onboarding chat
   (`TemplateCatalog.tsx`), also openable later from the Templates panel.
3. **Templates panel** — a section in workspace settings: one row per
   template, states and actions (U6).
4. **Approval cards** — four registered card types: `template.add`,
   `template.update`, `template.remove`, `template.suggest` (U3–U5, U7).
5. **Chat observations** — progress and result cards rendered as _new_
   observations (onboarding rule: never mutate an old card).
6. **CLI transcripts** (U8).

### U2. Creation picker

Layout: workspace-name field, then one choice presented as two cards:

- Primary card (preselected): **"Standard workspace"** — sub-line "Panels,
  chat, and the basics. Recommended." (the packaged default template).
- Secondary card: **"From a template"** — expands to a URL field with
  placeholder `https://github.com/you/your-template` and a "Look up"
  button.

Look-up states (all inline in the card, never a modal-on-modal):

| State                                               | UI                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resolving                                           | URL field disabled, inline spinner, "Checking the template…"                                                                                                                                                                                                                                 |
| resolved                                            | preview: template display name + one-line description (from its manifest), version ("v4 — March 2026"), host ("from github.com/vibestudio"), and a contents summary: "Includes 3 panels, 2 agents, 5 packages. Comes with the Base template." Primary button becomes **"Create workspace"**. |
| needs credential                                    | "This template is private. Connect your {provider} account to use it." + **Connect** button (standard credential flow, then auto-retry the lookup).                                                                                                                                          |
| unreachable / not a template                        | "Couldn't read a template at this address." + the specific reason in a Details pane. Primary stays disabled.                                                                                                                                                                                 |
| version disagreement in the template (pin conflict) | "This template disagrees with itself about which version of {c} to use." Details pane lists the two versions with dates; user picks one (radio) → recorded as the creation `overrides` entry. Copy never says pin/diamond/DAG.                                                               |

Rules: the exact resolved version is always shown before Create ("v4",
falling back to the short commit only when no tag exists — displayed as
"version 8c1f0d2", never the word "commit" alone). Creating is one click
after resolution; there is no second confirmation.

### U3. The add flow (`template.add` card)

Trigger: catalog "Add" button or pasted URL (chat or Templates panel). The
agent (or panel) immediately shows a progress line — "Looking at the News
template…" — while the dry-run delta runs. Then exactly one approval card:

- **Title:** `Add the {name} template?`
- **Body (no conflicts):** `It adds {n} new parts to your workspace.`
- **Body (conflicts):** `It adds {n} new parts. {m} of them need a choice
from you.`
- **Actions:** primary **Add template** · secondary **Not now** · Details.
- **Details panes:**
  1. _What's included_ — grouped list (Panels / Agents / Packages /
     Skills / Other), each row: icon, name, one-liner. Templates it brings
     along get their own group header: "Comes with: Base template (v4)".
  2. _Choices_ — one row per conflict, radio with three options, default
     preselected so the card is answerable without opening this pane:
     - `Keep yours` (default) — "your {part} stays as it is"
     - `Use theirs` — "you'll review their version before it replaces
       anything" (arrives as incoming changes, never an overwrite)
     - `Skip` — "don't add their {part}"
       Manifest-key conflicts use the same row pattern with the two values
       shown side by side.
  3. _Also suggests_ (only when the template ships excluded sections) —
     non-interactive: "The {name} template suggests connecting {provider}.
     Set that up separately in Settings." Never a button that grants.
  4. _Technical block_ — URL, tag, commit, content digest (banned words
     allowed here only).
- **groupKey:** the node ID (so a template re-added in a burst coalesces).
- On **Add template**: progress observation with per-part ticks
  ("Adding the News panel ✓ … 8 of 12"), then a **result observation**:
  "Added the News template — 12 new parts." with up to two follow-up
  actions ("Open the News panel", "See what's included"). On failure at
  any point: "Couldn't add the News template. Nothing was changed." +
  reason in Details. The atomicity guarantee is _always stated_ in the
  failure copy.

### U4. The update flow (`template.update` card)

Discovery is on-view (no unsolicited interrupts): the Templates panel row
and catalog card show an **"Update available — v5"** badge when a view
triggers a check. Starting an update (row action or `templates pull`):

- **Title:** `Update {name} to v5?`
- **Body:** `{k} parts change.` — plus, when local divergence exists:
  `You've changed {j} of them too; you'll review those together.`
- **Details:**
  1. _What changed_ — the template repo's commit subjects between the two
     versions, newest first, max 10 + "and {x} more". This is the
     human-readable changelog and costs nothing to produce.
  2. _Parts that change_ — list; diverged parts flagged "you changed this
     too".
  3. _Settings changes_ — the fragment diff rendered as plain rows
     ("adds recurring task 'nightly-digest'", "changes extension X
     version"), not a YAML diff. YAML lives in the technical block.
- **Actions:** primary **Update** · **Not now** · Details.
- After Update: clean parts apply without further questions; each diverged
  part yields a "Review changes in {part}" observation linking into the
  standard diff/integration panel. A persistent status chip on the
  Templates row shows "Reviewing changes — {done} of {total}" until the
  last decision, at which point finalization runs and a result observation
  appears: "News template is now v5." Declining every diverged part is a
  legitimate end state: "Kept your versions. News template is still v4
  for {j} parts" — the row then shows "Partially updated" with a Details
  explanation, and the pin state matches whatever finalization recorded.

### U5. The remove flow (`template.remove` card)

- **Title:** `Remove the {name} template?`
- **Body:** `Its {n} parts stay in your workspace and become yours to
manage.` — plus when shared: `{k} parts stay connected through the
{other} template.`
- **Actions:** primary **Remove** · **Cancel**. (Removal is
  relationship-severing only, so the primary is not destructive-styled;
  the body says explicitly that nothing is deleted.)
- Result observation: "Removed the News template. {n} parts are now part
  of your workspace." Content deletion is never offered here.

### U5b. The suggest flow (`template.suggest` card)

Entry: "Suggest changes" row action, or the agent noticing pushable
divergence when the user asks. Never unsolicited.

- **Title:** `Suggest your changes to {name}?`
- **Body:** `Sends your versions of {n} parts to {host} for the template's
maintainers to review. Your workspace doesn't change.`
- **Details:** the part list with per-part one-line summaries (from
  protected-main history subjects), and the technical block (branch name,
  remote URL).
- **Actions:** primary **Send suggestion** · **Cancel**.
- Result observation: "Sent. Your changes are on a review branch:
  {short link}." — the link is the branch (or forge compare/PR URL when
  derivable). Failure: "Couldn't send. Nothing left your workspace." +
  reason. Wire-truth rule surfaces here: if the remote moved, the copy is
  "The template changed since your last check — check for updates first",
  with **Check for updates** as the recovery action.

### U6. Templates panel

One row per direct template (inherited templates appear indented under
"comes with", read-only):

`[icon] News template — v4 · [state chip] · [⋯ menu]`

| State chip                 | Meaning                             | Row actions (⋯)                            |
| -------------------------- | ----------------------------------- | ------------------------------------------ |
| Up to date                 | checked this view, no candidate     | Check for updates, Suggest changes, Remove |
| Update available — v5      | discovery found a newer version     | Update…, What changed, Remove              |
| Reviewing changes — 2 of 5 | pull in progress, decisions pending | Continue review                            |
| Needs attention            | any structured error (U7)           | Fix… (opens the specific remedy)           |
| Partially updated          | some parts declined at last update  | Details, Update again                      |

Empty state (no templates beyond the root): "Your workspace started from
the {root name} template. Add more from the catalog." + **Browse
templates** button. The catalog opened here is the same
`TemplateCatalog.tsx` used in onboarding: card grid (name, one-liner,
tags), search-as-you-filter, and a paste-a-URL row pinned at the bottom.
"Add" on a card runs U3 unchanged.

### U7. Error and blocked-state copy

Every structured error from the composition/apply layer maps to exactly one
registered remedy surface. The table is the contract; implementers add rows,
never invent inline strings:

| Internal state                             | Title / body                                                                                                                            | Primary action                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `waiting-for-credential` (init or add)     | "Connect {provider} to finish" / "The {name} template is private."                                                                      | Connect                                                     |
| `TemplateRepoConflict` (during add)        | rendered as U3 _Choices_, never as an error                                                                                             | —                                                           |
| `TemplatePinConflict` (runtime add)        | "{a} and {b} disagree about which version of {c} to use."                                                                               | Choose version… (radio of the two, writes the root pin)     |
| `ManifestEntryConflict`                    | "Both {a} and {b} set up {thing}."                                                                                                      | Choose one… (writes top-layer redeclaration)                |
| snapshot digest mismatch                   | "This template's content doesn't match its published version. Nothing was installed."                                                   | Details (technical block) — no retry button; this is a stop |
| fragment digest mismatch (edited fragment) | "You've edited settings that the {name} template manages." / "Move your change into workspace settings, then try again."                | Open settings                                               |
| alias collision                            | "Two of your templates are both called {alias}."                                                                                        | Rename one…                                                 |
| unreachable remote during pull/check       | quiet failure on-view (badge simply doesn't appear); explicit "Couldn't reach {host}" only on user-initiated Check                      |
| stale-owner orphan/transfer (pull delta)   | folded into the U4 card as a _Choices_ row: "{name} no longer includes {part}. Keep it in your workspace?" (Keep — default / Remove it) | —                                                           |

Two global rules: (1) a failure that changed nothing must say "Nothing was
changed."; (2) a failure that requires the user to do something elsewhere
must name the place and offer the navigation button, never instructions
alone.

### U8. CLI transcripts

CLI output mirrors card copy (same registry strings where possible), one
line per fact, no tables wider than 80 columns:

```
$ vibestudio templates status
  News template        v4   update available → v5
  Base template        v4   up to date (comes with News)

$ vibestudio templates add https://github.com/acme/news-template
  Checking the template… ok (News template, v1, from github.com/acme)
  Adds 12 new parts. 1 needs a choice:
    panels/chat — both News and Base include this part
      [1] keep yours   [2] use theirs (review first)   [3] skip
  choice [1]: 1
  Adding… 12/12 ✓
  Added the News template.

$ vibestudio templates pull news
  News template v4 → v5: 6 parts change, 2 you also changed
  4 applied. 2 to review:
    review with: vibestudio templates review news
```

The CLI never auto-answers a choice; absent a TTY it fails with the choice
list and the non-interactive flag to supply answers
(`--choice panels/chat=keep`).

### U9. Registry additions

- Card types `template.add`, `template.update`, `template.remove`,
  `template.suggest` registered per approval-prompt-ux-spec §3 with
  `groupKey = node ID`, standard cooldown, chip escalation; none are
  push-eligible except `template.update` in its compressed one-line form
  ("An update to News is available — open Vibestudio to review").
- Catalog interaction kinds: `template-add`, `template-update`,
  `template-browse` (structured `interaction` objects; routing never
  parses button labels).
- New `scopeRenderer: "template"` producing "{name} (v{tag}, from {host})".

## Agent surface: programmatic API and skills

Agents must be able to assist with _every_ operation above — status, add,
update, remove, suggest, authoring — without ever holding approval
authority themselves. The design rule: **agents propose, the registered
cards dispose.** An agent-initiated mutation mints exactly the same U3–U5
card the panel flow mints; there is no second, weaker consent path.

### Service methods

A `templates` method family in `packages/service-schemas/src/templates.ts`
(same envelope/tier discipline as `gitInterop`; tiers registered in the
tools-cards registry, fail-closed):

**Read tier (no approval):**

- `templates.status()` → per-template `{nodeId, alias, version, state}`
  matching the U6 chip states, plus pending-review counts.
- `templates.catalog()` → the last verified Git registry snapshot, including
  exact registry coordinates and stale/cache presentation state.
- `templates.check(alias?)` → on-demand update discovery; returns
  `update-available` candidates with `{candidateRef, candidateCommit}`.
- `templates.inspect(urlOrAlias)` → **dry-run composition delta with no
  side effects**: resolved identity (name, version, host), what it brings
  along, parts added, conflicts (typed, with the same shape the Choices
  pane renders), manifest-entry changes, excluded-section suggestions.
  This is the method agents call _first_, so they can tell the user
  exactly what would happen before proposing anything.

**Mutation tier (each call mints its registered card; the card is the
approval):**

- `templates.add({url|catalogId, choices?})` — `choices` pre-answers
  conflict rows (`{path: keep|take|skip}`, `{manifestKey: value}`); the
  card renders them preselected so the user confirms rather than
  re-decides. Unanswered conflicts default to `keep`.
- `templates.pull({alias, toRef?})` — starts U4; returns the per-part
  delta handles so the agent can walk the user through each review using
  the ordinary vibestudio-vcs compare/merge surface. The coordinator
  observes the final decision automatically and owns terminal cleanup and
  publication.
- `templates.remove({alias})` — U5 card; result reports orphaned vs
  retained-via-other-template parts.
- `templates.suggest({alias, parts?})` — U5b card; result carries the
  branch/compare URL.

All mutations take a `commandId` (idempotent retry), return the structured
readiness/error states from U7 verbatim (same discriminants), and **never
block on the card** — they return `{pending, cardRef}` immediately so the
agent can narrate "I've asked for your approval" instead of hanging.
Declines return `declined`, not an error.

### Skill package: `workspace/skills/templates/`

Follows the `vibestudio-vcs` skill shape (SKILL.md + `references/` +
`public-contract.json` mirroring the method schemas):

- **SKILL.md** — when to use; the concept model _in agent vocabulary_
  (internal terms allowed here: pins, closure, fragments, lock — the skill
  is the one place the two vocabularies are explicitly bridged, with the
  U0 table reproduced so agents translate correctly when speaking to
  users); core workflows as recipes:
  1. _Health check_: `status` → `check` → summarize per U6 states.
  2. _Add_: `inspect` first, narrate the delta in user vocabulary,
     collect the user's conflict choices conversationally, then `add`
     with `choices` pre-filled — "the approval card should confirm what
     we already discussed, not surprise them."
  3. _Update_: `check` → `pull` → walk each diverged part through
     compare/merge (cross-link `vibestudio-vcs`
     `references/compare-and-merge.md`) → confirm finalization.
  4. _Suggest back_: divergence summary → `suggest` → hand back the
     branch link.
     Hard rules, stated as invariants: never edit `meta/templates/*.yml`
     (digest-enforced, will fail composition); never present an operation as
     done before the card resolves; never resolve a conflict the user hasn't
     been asked about (defaults are for the card, not for silent agent
     choices); `inspect` before every `add`, no exceptions.
- **`references/template-authoring.md`** — for the other direction:
  helping a user _create_ a template repository. The authoring contract is
  owned by `docs/workspace-template-authoring-plan.md` and the live
  reference, which supersede this document's earlier summary on three
  points: parent declarations are **URL-only** in the portable manifest
  (exact pins live in the authoring receipt and the consumer's lock, per
  the official plan's D1); `providers`/`trust` **may** appear in a
  fragment — installation surfaces them as individually reviewed
  suggestions and never applies them; and validation follows a
  publish-privately-then-install sequence, since publication is what
  creates the installable coordinate.
- **`references/errors-and-remedies.md`** — the U7 table extended with
  the agent-side recovery for each state (e.g. fragment digest mismatch →
  offer to move the user's edit into the top layer for them, then retry).
- **`public-contract.json`** — the method/result schemas, kept in sync
  with `packages/service-schemas/src/templates.ts` the same way the VCS
  skill does.

The onboarding skill (WP-T7) gains a cross-reference: catalog
interactions route into these same methods, so onboarding and
general-agent assistance share one contract.

## Work packages

- **WP-T0 — Contracts.** `templates` section in `WorkspaceConfigSchema` +
  `workspace-contracts` types; lock-file schema; validation (exact pins,
  exclude-list defaults). No behavior change.
- **WP-T1 — Resolver.** Closure fetch via shared `GitClient` snapshot
  primitive; DAG validation; repo assignment; manifest merge; deterministic
  fingerprinted composition plan + journal. Pure host-side library with
  golden tests (diamonds, cycles, overrides, conflicts).
- **WP-T2 — Seeding integration.** `activateWorkspaceFromSource()` consumes
  the plan; subtree carve in the shared Git acquisition primitive (no
  semantic schema change); N imports + one push; subdir-qualified
  provenance URIs; both digests recorded; readiness states. Depends on seeds-plan WPs A–C (shared
  snapshot primitive + journal); sequence after them or land them together.
- **WP-T3 — Layered manifest composition.** Fragment files under
  `meta/templates/`, raw layer schemas + `composeWorkspaceConfig`, migration
  of all config readers, per-section identity keys + generic `disable:`
  list, `templates.lock.yml` generation, approval surfacing of
  template-suggested excluded sections.
- **WP-T4 — Pull + update discovery.** The unapplied external change-set
  contract (host-only registration + public `compare`/`merge` accepting
  it as a source); operation-context ownership, automatic decision
  observation, pin-bump flow, per-repo deltas, indivisible
  finalization (fragment + pin + digest + lock in one publication), lock
  regeneration, and journaled publication intent whose durable VCS receipt
  reconciles a crash after protected-main application; `track` hints, the on-view update check,
  `templates check`/`status` surfacing.
- **WP-T5 — Push.** Monorepo remote abstraction in `GitBridge`/
  `UpstreamEngine`: shared checkout, subtree export, durable
  per-node/per-repo export frontier, UUID contribution branches,
  wire-truth push. Unit-upstream exclusivity enforcement.
- **WP-T5.5 — Runtime add/remove.** `templates add <url>` / `remove <name>`:
  URL→exact-pin resolution, dry-run delta, approval interaction with per-path
  choices persisted to `templates.conflicts`, atomic journaled apply.
  Removal implements the reachability recompute. Depends on WP-T1
  (resolver) and WP-T3 (layered manifest composition); does not require
  WP-T4/T5.
- **WP-T6 — Surfaces.** Service methods (`templateStatus`, `addTemplate`,
  `removeTemplate`, `pullTemplate`, `pushTemplate`), CLI, hub
  `createWorkspace` root-template selection (today it only supports
  `forkFrom`), docs, end-to-end tests (init from a root template; runtime add
  of a second template incl. a diamond over `base`; pull with local
  divergence; push round-trip recognized by subsequent pull).
- **WP-T7 — Onboarding catalog.** `template-catalog.json`,
  `TemplateCatalog.tsx` inline card, onboarding skill routing for
  `kind: "template-add"` interactions, fresh-observation re-render after
  apply. Depends on WP-T5.5.
- **WP-T8 — UX registry.** The four card types + copy from §UX registered
  in the prompt registry, the U7 error table wired to structured errors,
  CLI transcript strings, `scopeRenderer: "template"`. Gating in the
  approval-prompt-ux-spec sense: WP-T5.5/T6/T7 surfaces must not ship
  prompts that are not registered here, and §9 copy lint covers the new
  strings (including the template-specific banned words in §U0).
- **WP-T9 — Agent surface.** `templates` method family in
  `service-schemas` (read tier + card-minting mutation tier,
  `{pending, cardRef}` non-blocking returns), `workspace/skills/templates/`
  package (SKILL.md, authoring + errors references, public-contract.json),
  onboarding-skill cross-reference. Depends on WP-T5.5 and WP-T8 (cards
  must exist before methods can mint them).

## Open questions

1. Lock-file location is settled in favor of `meta` by the fork requirement
   (forks need the three-way base); revisit only the _noise_ problem if lock
   churn pollutes meta approvals — e.g. by folding lock regeneration into the
   same approval as the pin bump it accompanies.
2. Should the packaged default template itself become a Git template pin once
   this lands (self-hosting), keeping `filesystem` only for dev?
