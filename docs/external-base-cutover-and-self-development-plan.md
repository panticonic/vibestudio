# External Base cutover and host/system self-development

Status: implementation plan, revised 2026-08-12 for a pre-release clean cut

This plan completes step 9 of
`docs/official-template-repositories-plan.md`: publish a clean, root-capable
Base, make exact external-root acquisition the only workspace-creation path,
delete the bundled `workspace/` source, and preserve first-class host/system
co-development both outside and inside Vibestudio.

The system is pre-release and Vibestudio controls the host, Base, official
templates, registry, and deployed development/test instances. This plan uses
that fact directly. It does not build compatibility infrastructure for formats
that have never been released as a supported contract.

## Decision: one coordinated clean cut

The cutover has one supported generation:

- parsers accept only the new schemas;
- writers emit only the new schemas;
- the host and all official templates use one exact `systemEpoch`;
- Base and every official optional template are republished together when the
  epoch or a shared format changes;
- the registry exposes only releases from that generation;
- controlled pre-release workspaces are deleted and recreated from the new
  Base; and
- obsolete fields, readers, migration functions, rescue modes, and fallback
  paths are deleted in the same change that introduces their replacements.

Old Git commits and tags may remain as historical objects. They are not
selectable by the current registry or host and receive no runtime support.
Keeping immutable history is not compatibility.

This explicitly rejects:

- v1-to-v2 state migration;
- `bootstrapAdopted` consumption or translation;
- old-epoch structural parsing;
- maintenance admission for incompatible workspaces;
- skipped-version and downgrade behavior;
- `minVersion`/`maxVersion` ranges;
- additive host API compatibility revisions;
- migration notes, applied-note ledgers, and rescue harnesses for this cut;
- Durable Object production baselines, ordered schema migrations, migration
  ledgers/fixtures, and Build V2 migration-retention gates;
- owner-cutover declarations, route receipts, and old-owner storage transfer;
- dual readers, dual writers, shadow schemas, and temporary compatibility
  adapters; and
- silently repairing an old workspace into the new generation.

If a pre-release workspace contains facts worth keeping, they are exported
before the cut as ordinary user data and re-imported deliberately after fresh
creation. Vibestudio does not ship a general importer for its obsolete internal
shape.

Post-launch format or storage-owner migration is a separate future design. It
must be justified by actual durable user data and the concrete transition then
required; this plan does not pre-build a speculative migration platform.

## Outcome

After this cutover:

- `vibestudio` contains host/control-plane source and generic tooling, but no
  live or fallback default-workspace source;
- `vibestudio-workspace-base` is the independently released default
  system/userland distribution;
- one Base commit is both Composer-readable and directly bootable;
- the host release carries one exact Base pin, never Base source bytes;
- fresh creation acquires one exact external root snapshot through a
  content-addressed store and initializes complete semantic workspace state in
  one visible commit;
- installed Composer state is self-contained and cannot lose the fragment that
  explains an installed contribution;
- Base membership is an ordinary declaration in `meta/template.yml`, not a
  mirror policy or durable workflow object;
- a sibling Base checkout exchanges explicit imports and exports with the
  semantic workspace without requiring every local commit to be pushed;
- an agent inside Vibestudio can edit Base and host source together, build an
  exact pair, launch an isolated child, validate it, publish Base, and prepare
  the host pointer change; and
- host CI and packages succeed with `workspace/` physically absent.

The final topology is:

```text
vibestudio/                         host/control-plane repository
  build-resources/
    base-template-release.json      exact Base pin only

vibestudio-workspace-base/          system/userland repository
  meta/template.yml                 authoring intent and template fragment
  meta/vibestudio.yml               generated flattened runtime manifest
  <declared repositories/files>     complete root source

instance-owned snapshot store
  <snapshot digest>/manifest        canonical path/mode/blob inventory
  blobs/<content digest>             immutable file content

managed workspace
  meta/templates/workspace.yml      editable local composition intent
  meta/templates.state.yml          complete installed-layer state
  meta/vibestudio.yml               generated effective runtime manifest
  <semantic repositories>           authoritative current content
```

## Current state and concrete gaps

The optional-feature extraction is complete. Examples, News, Spectrolite, and
Google Workspace have published releases and are promoted in the verified
registry. Their existing releases belong to the old pre-release generation and
will be republished during the coordinated cut; no compatibility with those
releases is retained.

The remaining gaps are:

1. `build-resources/base-template-release.json` points at Base candidate
   `8a1027e6708e12c6d3fed4b0a9b3044f4064186d`, which still contains extracted
   Google/Gmail files and lacks the final flattened runtime manifest.
2. Fresh creation still discovers and copies `workspace-template/` or
   `<appRoot>/workspace`.
3. Electron and npm packaging still stage the in-tree workspace.
4. The source developer instance still writes protected publications toward a
   hard-coded `<appRoot>/workspace` destination.
5. Host generation, validation, tests, and dependency resolution still contain
   ambient `workspace/**` assumptions.
6. Runtime dependency resolution currently prefers the bundled template over
   the active semantic workspace, so an exact-pair test can accidentally use
   unrelated checkout bytes.
7. Composer stores relationship state separately from sanitized per-node
   fragments. Observation substitutes an empty layer when a fragment is
   missing, reclassifying Base-owned configuration as workspace-local.
8. Root initialization does not construct the complete Composer installed
   layer before publishing the first semantic main state.
9. A locally committed, unpushed sibling Base `HEAD` cannot use the normal
   acquisition miss path because that path requires remote reachability.
10. Mirroring every repository named by workspace publications into Base would
    leak optional templates and user repositories.
11. Inside-system development can build exact semantic host source, but cannot
    yet bind that host execution snapshot to an exact candidate Base snapshot.
12. The host-owned Development domain contains product workflow that should not
    grow merely to support exact host/Base pairs.

Publishing Base without a valid creation path creates a dead release. Deleting
`workspace/` before replacing development and build inputs destroys the
product's own development loop. The work packages below therefore land as one
ordered cutover, even though individual commits remain reviewable.

## Terminology

### Host

Trusted native/control-plane code in `vibestudio`: server, Electron/native
integration, routing, authority, semantic VCS, build infrastructure, and
generic service contracts.

### Base

The default system/userland distribution in `vibestudio-workspace-base`: apps,
extensions, panels, packages, workers, skills, manifests, and files required by
a useful fresh workspace. It excludes optional outcome templates and user
projects.

### Composer template repository

Any Git release containing `meta/template.yml` and the repositories/files that
manifest declares. Composer can inspect, add, update, or remove it after a
workspace is running. Contribution templates may depend on other templates.

### Root-capable template

Root capability is derived, not enabled by a flag. A release is root-capable
only when:

- `meta/template.yml` has no template dependencies;
- every declared repository and support file is present in the exact snapshot;
- the typed unit dependency closure is complete;
- `meta/vibestudio.yml` is the canonical flattened result;
- both manifests carry the current exact `systemEpoch`;
- all runtime references resolve inside the snapshot or to current host
  contracts; and
- inspection finds no reserved, unexplained, or unsafe path.

The host acquires one root. It never runs Composer or resolves another template
before userland exists.

### Flattened runtime manifest

`meta/vibestudio.yml` is the final effective configuration consumed by the
host. It contains no unresolved template inheritance. In a released root it is
generated by the publisher; in a live workspace it is generated by Composer.

### Installed-layer state

`meta/templates.state.yml` is a generated, self-contained description of the
installed template graph and merge baselines. It contains every pin, parent
relationship, sanitized fragment, contribution digest, and presentation value
needed to observe or change the composition. It is merge context, not an
integrity lock on intentional workspace changes.

### Exact snapshot

A canonical manifest of normalized file paths, modes, sizes, and content
digests, named by its snapshot digest. Git URL/ref/commit identifies the source;
the snapshot proves the bytes Vibestudio retained.

### Development pair

One exact host execution snapshot plus one exact Base/root snapshot. A pair
digest records what was tested. It does not create a compatibility range.

## Architectural invariants

1. **There is one current generation.** Old schemas are rejected, not migrated.
2. **Semantic state is authoritative.** Git checkouts and materialized trees
   are imports, exports, or execution views; they never silently become
   workspace history.
3. **There is one production bootstrap path.** Packaged, headless, and
   development instances initialize from an exact external root pin.
4. **Bootstrap acquires one root.** A root release is dependency-free and
   already flattened.
5. **The host ships no Base bytes.** It carries only an exact promotion pointer.
6. **Installed state is complete or absent.** No visible main state may contain
   relationships without the fragments and contribution evidence that explain
   them.
7. **Release metadata is not self-referential.** A Base tree does not contain a
   pin to its own commit/snapshot or commit-derived installed node IDs.
8. **Base membership is explicit.** Creating, importing, or publishing a
   workspace repository does not add it to Base. Only `meta/template.yml` does.
9. **No automatic bidirectional checkout mirror exists.** Import and export are
   explicit checkpoints with recorded baselines and ordinary conflict handling.
10. **Runtime and tests have no ambient source authority.** They consume an
    explicitly supplied semantic workspace or exact snapshot.
11. **Compatibility is exact equality.** Host and workspace source use the same
    `systemEpoch`. There are no API revisions, ranges, or negotiated fallbacks.
12. **The build proves the current pair.** Typed contracts and Build V2 validate
    the exact host/Base/template result before promotion.
13. **External effects are idempotent and journaled.** Publication, checkout
    export, registration, and other retryable effects record exact inputs and
    receipts in one generic operation journal.
14. **The stable parent tests candidates.** Self-development launches an owned
    isolated child; it never replaces the parent process in place.
15. **Every release byte has an owner.** It is declared, deterministically
    generated, or rejected.
16. **Safety remains code.** Approval, credentials, integrity, path safety,
    no-overwrite/CAS, epoch equality, and process ownership are mechanically
    enforced.
17. **Persistence is current-only.** An empty store initializes at its current
    canonical schema; an exact current store opens; every other shape fails.
    There is no production baseline or ordered migration chain.

## Canonical artifacts

### `meta/template.yml`: portable semantic intent

The Base manifest names the exact current epoch and its intentional inventory:

```yaml
systemEpoch: 58

template:
  name: Vibestudio Base
  description: Default Vibestudio system workspace
  repositories:
    - apps/shell
    - extensions/template-composer
    - panels/chat
    - workers/model-settings
  files:
    - package.json
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
    - tsconfig.json

apps:
  - source: apps/shell
extensions:
  - source: extensions/template-composer
```

The epoch number above is illustrative; WP1 chooses the one cutover value and
uses it everywhere.

`template.repositories` names intentional roots. The publisher resolves the
typed unit dependency graph, shows the computed closure, and requires every
included repository to be present. Adding a semantic unit to Base is ordinary
work:

1. create or import the unit;
2. decide semantically whether it belongs in Base;
3. edit the manifest if it does; and
4. review the derived release diff.

The machinery never guesses membership from all changed repositories, a Git
checkout, or a publication event. `template.files` names non-repository support
paths explicitly and accepts no globs or path escapes.

### `meta/vibestudio.yml`: generated effective runtime

The publisher renders this file from `meta/template.yml` for a root release.
Composer renders it from local composition intent plus installed inline
fragments for a live workspace. It carries the exact current `systemEpoch` and
is the only runtime configuration the host loads.

Generated-byte equality is an inspection rule. Bootstrap validates; it never
repairs a release.

### `meta/templates/workspace.yml`: editable local composition

This is the human/agent-authored workspace layer: selected template URLs and
local settings not inherited from templates. Fresh creation derives it once
from the trusted root manifest and creation pin.

There is no `bootstrapAdopted` field or sentinel. The exact root is represented
as the ordinary installed root selection from the first commit onward.

### `meta/templates.state.yml`: one complete generated state

The new current format replaces split state plus
`meta/templates/<nodeId>.yml`. A conceptual node is:

```yaml
format: vibestudio-template-state/1
roots:
  - url: git+https://github.com/panticonic/vibestudio-workspace-base.git
nodes:
  - nodeId: t-...
    pin:
      url: git+https://github.com/panticonic/vibestudio-workspace-base.git
      ref: refs/tags/v0.2.0
      commit: <full commit>
      snapshot: v1-sha256:<snapshot>
    parents: []
    fragment: <sanitized template fragment>
    presentation: <sanitized optional presentation>
    suggestions: <sanitized trust/provider suggestions>
repositories:
  apps/shell:
    contributions:
      - nodeId: t-...
        subtreeDigest: v1-sha256:<digest>
```

The exact schema reuses current typed fragment, pin, suggestion, and
contribution types. Observation either parses the complete document or fails
visibly. It never substitutes an empty fragment and never reads the obsolete
per-node files.

Composer stages `workspace.yml`, the complete state, `vibestudio.yml`, and
repository changes together. Root initialization derives the same complete
value before its only visible main commit.

### `base-template-release.json`: exact host promotion pointer

The host-owned file is deliberately small:

```json
{
  "format": "vibestudio-base-release/1",
  "baseTemplate": {
    "url": "git+https://github.com/panticonic/vibestudio-workspace-base.git",
    "ref": "refs/tags/v0.2.0",
    "commit": "<full commit>",
    "snapshot": "v1-sha256:<snapshot>"
  }
}
```

It contains no source bundle, migration notes, owner cutovers, compatibility
range, or mutable channel. The host acquires the pin, validates the current
root schema and exact epoch, and boots it or fails.

### Publication receipt

The Base publisher returns evidence rather than creating another durable input:

- source semantic event and manifest digest;
- exact projected file inventory and snapshot digest;
- remote commit/tag/readback facts;
- flattened-manifest digest;
- exact epoch;
- standalone Base build result; and
- host execution digest, Base snapshot, and pair digest for the tested pair.

The host pointer is updated only from a verified receipt. Pair evidence proves
what was tested; it is not a startup admission protocol.

### Official registry snapshot

The coordinated cut publishes Base and fresh releases of Examples, News,
Spectrolite, and Google Workspace at the same epoch. Registry CI composes and
builds each exact optional release with the promoted Base. One reviewed registry
commit promotes the complete set. No current entry points at an old generation.

### Where optional-template release bytes come from

After extraction, each external template repository is its own authoring
source. Republishing Examples, News, Spectrolite, or Google Workspace never
reads their deleted paths from host `workspace/` and never temporarily adds
them back to Base.

For the coordinated cut, start from each exact published external commit:

| Template | Source commit |
| --- | --- |
| Examples | `bc4b1ec5ecf6bbb4b3584db2f3e6d651da693aca` |
| News | `090e1ba17abcd01a426b914a41d0a0218579b0ff` |
| Spectrolite | `e6ddffbea9f28fef8988b6b612e017c8348917a0` |
| Google Workspace | `8bdccc9d5195da9cdb6123396a499f7986a2935b` |

Acquire that tree into an ordinary clean checkout or exact semantic authoring
context, update its current-format manifest and any code affected by the new
host contract, then validate it against the candidate Base. The old release is
source material, not an installed template: its manifest is never admitted by
the new runtime.

The external and inside-system paths share one generic template-repository
exchange operation derived from `meta/template.yml`:

- checkout authoring edits the external repository directly and publishes its
  next immutable commit/tag;
- inside-system authoring seeds the exact repository snapshot, imports its
  declared projection into an isolated semantic context, edits and validates
  there, then exports/publishes that projection; and
- neither path mutates protected Base state merely to make optional source
  available.

This generalizes the explicit Base checkout exchange; it is not a second
optional-template publisher. Base is merely the root-capable use of the same
template repository format. After the cut, future current-generation releases
can also be installed and edited normally because their epoch already matches.

## Runtime boundaries

Before the first root or pair acceptance test, dependency resolution must stop
searching ambient checkout paths. Every host build/start entry takes an explicit
workspace source:

- semantic workspace state;
- an acquired exact snapshot; or
- an exact materialized execution tree owned by the operation.

`workspace/`, `workspace-template/`, the current working directory, sibling
directories, and package-relative fallbacks are forbidden inputs. Tests place a
decoy `workspace/` beside the host and prove it cannot affect inspection,
building, or startup.

## Snapshot acquisition

Remote Git and local Git are adapters into one instance-owned,
content-addressed snapshot store.

### Remote adapter

1. Fetch the declared URL/ref.
2. Verify the expected commit is reachable from that ref.
3. Enumerate normalized tree entries.
4. Hash blobs and construct the canonical snapshot manifest.
5. Require the expected snapshot digest.
6. Publish the manifest atomically after all blobs exist.

### Local committed-tree adapter

1. Resolve a selected sibling checkout's committed `HEAD`.
2. Reject tracked-worktree mismatch for the chosen checkpoint; untracked files
   are excluded and reported.
3. Enumerate the committed tree through Git, not the mutable filesystem.
4. construct and verify the same canonical snapshot manifest.
5. Seed the same instance-owned store atomically.
6. Invoke the ordinary acquisition port using the exact seeded pin.

This lets an unpushed commit use the normal downstream path without teaching
bootstrap about sibling checkouts or silently pushing developer work.

## Atomic root initialization

Initialization is pure derivation followed by one semantic commit:

1. acquire and verify the exact root snapshot;
2. parse the current root manifest and flattened runtime manifest;
3. reject root template dependencies;
4. validate inventory, dependency closure, path ownership, and exact epoch;
5. derive the initial composition declaration;
6. derive the complete installed node including inline fragment and
   contribution digests;
7. derive the effective runtime manifest and require byte equality with the
   released flattened manifest;
8. import all semantic repositories and metadata into a private candidate;
9. run Build V2 against that candidate; and
10. publish one protected semantic main commit with a CAS.

No state exists in which imported repositories are visible but composition
metadata is incomplete. External registration after the main commit may use the
generic operation journal; it does not mutate or repair the semantic result.

## Base authoring and checkout exchange

Base is selected by its manifest, not by mirroring the whole workspace.

An explicit export:

1. reads one exact semantic context;
2. computes the previous and next Base projections from `meta/template.yml`;
3. derives the typed dependency closure;
4. shows included, newly included, excluded, and unknown paths;
5. compares semantic and checkout changes against their recorded common
   baseline;
6. reports conflicts for semantic resolution;
7. writes only the reviewed Base projection; and
8. records the new baseline after successful write.

An import performs the inverse comparison and publishes reviewed changes into
semantic VCS. Optional-template and user repositories never leak merely because
they exist or changed.

## Inside-system host/Base co-development

Base owns pair selection, workflow, retry policy, and presentation. The host
exposes only sealed exact effects:

- materialize an attested host execution snapshot;
- acquire/materialize an exact Base snapshot;
- launch and supervise an isolated child instance;
- expose bounded logs and test results;
- stop and clean up that owned child; and
- return exact effect receipts.

A generic execution ledger retains only fencing, effect identity, cleanup, and
recovery facts. It does not know recipes, Base policy, pagination, or repair UX.

The workflow is:

1. select exact host and Base candidates;
2. derive and display the pair digest;
3. build both sides through explicit inputs;
4. launch an isolated owned child;
5. run focused checks and system tests;
6. publish Base from the exact tested candidate;
7. adopt the verified receipt into the host pointer change;
8. rebuild/test the final host commit plus published Base pin; and
9. clean up the child on success, failure, or cancellation.

The stable parent remains available throughout. An external checkout and an
inside-system semantic context enter through different snapshot adapters but
share the same acquisition, build, launch, and receipt path.

## Work packages

### WP0. Eliminate ambient workspace authority

1. Inventory all production, build, package, test, and development reads of
   `workspace/`, `workspace-template/`, and checkout-relative workspace paths.
2. Change dependency resolution to require an explicit semantic or exact
   snapshot root.
3. Add forbidden-read tests with a decoy ambient workspace.
4. Fail generation/build entry points that omit their workspace input.

Exit: no later pair test can pass using unrelated checkout bytes.

### WP1. Define the current-only contracts

1. Choose one new `systemEpoch` for the coordinated cut.
2. Define the root manifest inventory and root-capability validator.
3. Define the self-contained installed-state schema with inline fragments.
4. Define the exact Base pointer and publication receipt.
5. Delete per-node fragment reads/writes and empty-layer substitution.
6. Delete `bootstrapAdopted` from schemas, Composer, fixtures, and generated
   source.
7. Delete migration-note fields from the Base pointer and remove the pre-release
   note/rescue path. Remove migration facets from Composer/service schemas and
   their note-specific shell presentation while retaining ordinary
   current-format template review and merge.
8. Remove `migrations` as a reserved template content section and delete the
   migration-note parser/package surface.
9. Replace the Durable Object production-baseline/migration API with the same
   current-only lifecycle used by canonical host SQLite stores: initialize a
   truly empty store, validate exact current version and shape, and reject
   everything else unchanged.
10. Delete `schemaMigrations()`, migration ledgers, retained migration source
    digests, representative migration fixtures, and Build V2 rules that require
    or preserve migration chains. Build V2 still proves the exact fresh schema.
11. Delete old schema parsers and converters; tests assert rejection.
12. Retain exact `systemEpoch` equality and remove any planned host API revision,
   range, or negotiation.

Exit: every component has one reader and one writer for one current format.

### WP2. Implement the snapshot store and atomic bootstrap

1. Implement the canonical snapshot manifest and atomic content store.
2. Refactor remote acquisition into a store-seeding adapter.
3. Add the verified local committed-tree adapter.
4. Make bootstrap consume only a verified stored snapshot.
5. Derive the complete installed state before the single semantic main CAS.
6. Reject root dependencies rather than resolving another root.
7. Journal only effects after the semantic commit.

Exit: remote and unpushed local commits use one downstream path; partial
installed state is impossible.

### WP3. Publish the clean Base and official template generation

1. Remove extracted optional units from the Base projection.
2. Generate canonical `meta/vibestudio.yml`.
3. Validate root capability, inventory, closure, and standalone build.
4. Test the exact host/Base pair.
5. Publish and read back the immutable Base candidate.
6. Acquire each optional template from its exact external source commit; do not
   look for its deleted repository paths in `workspace/`.
7. Update each external manifest to the new exact epoch/current format and make
   only code changes required by the current host/Base contracts.
8. Publish a new immutable commit/tag in the same external repository.
9. Compose/build each optional candidate against the exact Base candidate.
10. Promote the complete release set in one reviewed registry snapshot.
11. Remove old-generation entries from the current registry view.

Exit: every selectable official release belongs to the same current generation.

### WP4. Cut fresh creation to the exact external root

1. Adopt the verified Base receipt into `base-template-release.json`.
2. Replace bundled-directory discovery with exact pointer acquisition.
3. Use WP2 atomic initialization for packaged, headless, development, and
   system-test instances.
4. Remove fallback selection and repair behavior.
5. Prove retained-store creation while the remote is unavailable.

Exit: every new workspace starts from the exact external Base or fails visibly.

### WP5. Complete external and inside-system co-development

1. Add one generic template-repository sibling-checkout import/export using the
   WP2 local adapter and manifest-declared projection; use it for Base and
   optional templates.
2. Move pair workflow, retries, and presentation into Base userland.
3. Keep only exact native effects and generic receipts in the host.
4. Support host-only, Base-only, and combined candidate pairs.
5. Prove owned child cleanup at every exit.

Exit: neither workflow needs a bundled workspace or an enlarged Development
builtin.

### WP6. Remove in-tree Base ownership

1. Move remaining legitimate source ownership to Base or host.
2. Replace protected publication destinations that target `<appRoot>/workspace`.
3. Remove Electron/npm staging of bundled workspace source.
4. Remove host package-manager dependencies on workspace-local packages or
   patches.
5. Delete tracked `workspace/` only after the protected clean Base is published.
6. Run host checks with `workspace/` physically absent and inspect release
   artifacts for copied fallback bytes.

Exit: `git ls-files workspace` is empty and no generated alias contains Base.

### WP7. Perform the destructive pre-release cut

1. Inventory controlled developer, test, and deployed pre-release workspaces.
2. Announce the destructive cut and export any deliberately retained user-level
   data through ordinary product export surfaces.
3. Stop affected instances through their normal lifecycle ownership.
4. Delete their obsolete semantic/runtime state explicitly; do not feed it to
   the new parser.
5. deploy the host, Base pointer, and registry snapshot as one generation.
6. Recreate every managed workspace from the exact external Base.
7. Reinstall desired optional templates from the current registry and import
   any deliberately retained user data.
8. Verify no old schema, tag, registry entry, or bundled directory is selected.
9. Record exact host commit, Base pin, registry snapshot, optional-template
   pins, epoch, and final pair evidence.

Exit: the running fleet contains only freshly created current-generation
workspaces. There is no legacy-state recovery path to test or maintain.

## Failure and recovery

Recovery repeats exact current-generation operations; it never interprets old
state.

### Snapshot acquisition

- A failed adapter leaves no published snapshot manifest.
- Complete immutable blobs may remain and be reused.
- Retry keeps the same expected pin/snapshot and never selects a newer ref.

### Initialization

- Failure before main CAS leaves no ready workspace.
- Retry re-derives the same complete result.
- Failure after main CAS resumes external registration after confirming the
  exact main digest.
- No path manufactures fragments or repairs obsolete state.

### Publication and promotion

- The operation journal verifies commit/tag/readback receipts before resuming.
- A published candidate is inactive until the host pointer and registry select
  it.
- Failed coordinated promotion leaves the previous complete generation active;
  it never exposes a mixed registry set.

### Checkout exchange

- Import/export preserves both sides on conflict.
- Paths outside the Base projection are untouched.
- Unknown paths require semantic classification, not a new hard-coded category.

### Isolated child lifecycle

- Parent state remains intact.
- Cleanup is scoped to the owned instance/process generation.
- Unknown ownership becomes explicit repair, never broad deletion.

### Cutover failure

- Before destructive deletion, remain on the old complete pre-release build.
- After deletion begins, finish deploying the new generation and recreate;
  do not restore obsolete internal state into the new host.
- Rollback of code means redeploying the complete old generation with its own
  disposable workspaces, not opening new-generation state with old code.

## Verification

### Conventional host tests

- current Base pointer parsing and strict rejection of old fields;
- exact epoch admission and rejection of old/missing epochs;
- empty-or-exact-current Durable Object/SQLite admission and hard rejection of
  every other shape;
- absence of migration ledgers, definitions, retained source digests, and
  migration fixtures;
- self-contained installed state and absence of per-node fragment reads;
- remote/local snapshot adapters, atomicity, corruption, and unpushed commits;
- atomic root derivation and crash points around the main CAS;
- explicit dependency workspace selection and forbidden ambient reads;
- generic journal idempotency;
- narrow exact-pair effect/receipt schemas and owned child cleanup; and
- build/typecheck/package checks with `workspace/` absent.

### Conventional Base and registry tests

- manifest inventory and deterministic dependency closure;
- explicit unit inclusion and undeclared-unit exclusion;
- path safety and root dependency rejection;
- flattened runtime generation and byte equality;
- exact epoch equality across Base and all official templates;
- standalone and composed Build V2 checks;
- optional-feature absence from Base;
- atomic full-registry promotion; and
- publication/readback receipts.

### Cross-repository tests

- fresh creation from exact remote Base;
- fresh creation from retained store while remote is unavailable;
- fresh creation from a locally seeded unpushed commit;
- rejection of wrong commit, snapshot, dependency, epoch, state schema, or
  flattened manifest;
- hard rejection—not migration—of representative old state and old releases;
- a decoy ambient `workspace/` cannot affect build, inspection, or startup;
- a workspace-local unit remains outside Base until the manifest changes;
- optional/user publications never touch the sibling Base checkout;
- explicit checkout conflict reporting;
- host-only, Base-only, and combined development pairs;
- coordinated Base/optional registry promotion; and
- Electron/npm artifact inspection proving Base bytes are absent.

### Headless system tests

Use the repository's managed system-test workflow for the smallest scenarios:

- exact dirty semantic Base candidate in an isolated child;
- combined host/Base exact pair;
- explicit Base unit inclusion and optional/user exclusion;
- unpushed sibling `HEAD` acquisition;
- no ambient Base read;
- complete root installed state;
- current epoch success and old epoch hard failure;
- Base publication receipt and host adoption; and
- owned child failure/cleanup.

Provision one unique managed instance, run doctor, inspect any failure, repair
the actual layer, and stop the owned instance. No test provisions an old
workspace for migration because migration is not a supported behavior.

## Delivery order

```text
WP0 exact-source boundary
  -> WP1 current-only contracts
  -> WP2 snapshot store + atomic initialization
  -> WP3 coordinated Base/template publication
  -> WP4 exact fresh creation
  -> WP5 external + inside-system co-development
  -> WP6 delete workspace/
  -> WP7 destructive fleet cut + fresh recreation
```

WP5 userland workflow work may proceed beside WP3, but no pair result counts
until WP0 is active. `workspace/` deletion waits for the protected external
Base and both development entrances, not for later host/userland boundary
extractions.

## Commit and repository strategy

- Implement host changes in an isolated worktree and merge only after focused
  checks pass.
- Implement Base changes in semantic workspace state and publish exact
  candidates; use a sibling checkout only through explicit import/export.
- Keep host, Base, optional-template, and registry commits independent. The
  release record binds their exact identities.
- Choose one cutover epoch; do not allocate additive compatibility revisions.
- Publish and validate all candidates before changing current pointers.
- Do not merge `workspace/` deletion until protected Base source exists
  externally and both development workflows pass.
- Make obsolete reader/writer deletion part of the same reviewed series as the
  replacement format; never land a compatibility window.

## Completion criteria

The cutover is complete only when:

- one clean immutable Base release is root-capable and Composer-readable;
- every selectable official template is republished at the exact current epoch;
- the host pointer selects the exact verified Base pin;
- fresh creation has one external-root path;
- initial installed state is self-contained and atomically published;
- old state, old templates, and old host generations are rejected rather than
  migrated;
- controlled pre-release workspaces were recreated from scratch;
- local unpushed Base commits and remote releases use one snapshot store;
- Base membership is controlled only by `meta/template.yml`;
- external and inside-system exact-pair development are tested;
- optional-template releases are authored from their external repositories,
  never reconstructed from deleted host `workspace/` paths;
- Base owns development workflow while the host owns narrow exact effects;
- runtime/build/generation cannot read ambient `workspace/`;
- Electron/npm releases contain no Base source fallback;
- tracked `workspace/` is deleted; and
- no compatibility, maintenance-admission, migration-note, owner-cutover, or
  downgrade infrastructure was added for the pre-release generation.

## Explicitly rejected mechanisms

- bundled `workspace-template` fallback;
- submodule, symlink, or mandatory sibling checkout;
- root dependencies or pre-userland Composer execution;
- `root: true` capability flags;
- split per-node installed fragments;
- empty-layer substitution;
- self-pinning Base state or `bootstrapAdopted`;
- old-format migration or structural parsing;
- maintenance admission for old workspaces;
- host API revision/range negotiation;
- skipped-version and downgrade support;
- system migration notes and rescue harnesses for this cut;
- persistent-store production baselines, ordered migrations, and migration
  ledgers/fixtures;
- owner-cutover manifests, route receipts, or cross-owner transfer envelopes;
- dual routes, readers, writers, or compatibility adapters;
- pair-digest admission;
- automatic publication mirroring into Base;
- “all changed repositories belong to Base” heuristics;
- a second cache beside the exact snapshot store;
- separate root and contribution publication engines;
- domain-specific workflow journals;
- expanding the host Development product workflow;
- force-overwrite conflict resolution; and
- generated host copies of mutable Base source masquerading as authority.
