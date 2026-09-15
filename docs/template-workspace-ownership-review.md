# Workspace template ownership

## Creating a workspace

**Use template** creates a new user-owned root that depends on the selected
repository. It has no publishing upstream until its first publication. Personal,
System, and Start fresh (Base) use this operation by default.

**Author template** adopts the selected repository as the workspace's authored
root, preserves its own dependencies, and records that repository as the upstream.
The selected repository is not also a dependency. Choose Base in the picker and
select **Author template** to author Base directly. The CLI equivalent is
`remote create-workspace --author-template` with the normal exact template inputs.
The purpose is part of the durable creation request and cannot change on retry.

## Authored source and runtime configuration

`meta/vibestudio.yml` contains the workspace's authored configuration and template
metadata. Its `template.installation` records exact source pins together with the
source manifests used to resolve dependencies. `installation.upstream`, when
present, names this workspace's own exact published baseline.

Runtime configuration is computed from the reachable dependency declarations and
this authored root. It is never written over the root as a flattened source
manifest. Resolution is offline and uses the installed exact pins; publication
and ownership inspection do not silently follow newer remote heads.

The installation record is local metadata. Publication emits only the authored
configuration, dependencies, selected repository units, and explicit overrides.
It omits installation records and credential IDs. Portable credential references
use the connected account's label; no credential material is exported.

The `meta` repository belongs to the root. Dependency manifests supply runtime
declarations through the installation record; their companion metadata files do
not become the new workspace's own files.

## Explicit whole-unit overrides

A derivative can publish an inherited unit by selecting it as an override:

```yaml
systemEpoch: 0
template:
  name: My workspace
  description: My customized workspace
  dependencies:
    - url: git+https://github.com/example/base.git
  repositories:
    - meta
    - panels/chat
  overrides:
    - repoPath: panels/chat
      source: git+https://github.com/example/base.git
```

The override owns the complete unit, including the absence of files deleted from
its source. Composition must name the dependency being replaced. An undeclared
collision, unrelated sibling, or different current owner is rejected. An override
can survive removal of the original unit by its dependency.

Updating the dependency leaves the complete replacement intact. Updating the
template that owns the replacement uses the ordinary native three-way merge and
conflict review, preserving subsequent local edits. Overrides are replacements,
not patches automatically reapplied to each new dependency version.

The publishing UI labels inherited choices as overrides. Selecting local units
only leaves inherited units supplied by dependencies. An empty unit selection is
valid: it publishes the manifest and dependencies alone. The entire selection is
the release; omitted local units remain local but are absent from that release.

## Publication and upstream tracking

The publishing page supports a connected GitHub account, paginated writable
repository selection, and an owner/name entry with public/private visibility for
creation. Existing destinations retain their visibility and Git history; their
complete file tree is replaced by the selected release. Name entry uses the same
resolve-or-create operation, so entering an existing name also updates it.

Publication captures the reviewed main state, publishes the exact release, then
records the resulting upstream and exact source baseline through native VCS. It
retains omitted local units and dependency origins. Each effect's arguments are
persisted before dispatch, so an uncertain response retries the same operation;
a completed remote publication is not repeated after a local push reply is lost.

Complete publication to a dependency repository is rejected. Open that repository
for authoring, or use a contribution branch for selected upstream changes.
The configured upstream pre-fills subsequent publication forms.

## Updating and existing workspaces

Updates recompose exact source baselines, stage native VCS changes, expose
conflicts, and publish only after review. A creation interrupted after source
materialization reuses the recorded dependency pins on recovery.

This is a source-format cutover. Old workspaces with the former flattened
`template.sources` metadata must be recreated from their template; the application
does not guess which flattened declarations were originally user-owned. Export
or retain local changes before replacing an old workspace. Existing source with
no ownership installation record can still be read as standalone configuration,
but template publication requires reopening through the picker.
