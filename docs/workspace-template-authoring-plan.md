# Authoring, contributing, and updating workspace templates

Templates contain repository units and their `meta/vibestudio.yml` manifest.
Every other file must belong to a declared unit. There is no `template.files`
field or standalone-file export. Put documentation, artwork notes, and similar
files inside an appropriate unit; use `meta` for template metadata companions.
Publication does not synthesize a root README.

## Current ownership limitation

The picker currently installs the selected template as the root for both ordinary
use and authoring. Personal and System use this same operation. It does **not**
yet create a separate user-owned root that depends on the selected template.
The [ownership review](template-workspace-ownership-review.md) describes the
required correction and the unresolved policy for publishing inherited-unit edits.

## Open the right authoring workspace

For a complete Base release, open Base directly from the workspace picker:
**Start fresh** starts with Base, and **Git URL** accepts the Base repository
address. This gives the authoring workspace Base's own units, without an
intermediate Personal or System template.

The workspace's **Workspaces** page contains **Browse**, **Publish**, and
**Installed** tabs. Publishing always reads protected main in that workspace.
Commit and publish local task changes to workspace main before reviewing a
release.

## Publish a complete release

In the Publish tab, choose a connected GitHub account, then either select an
existing writable repository or enter the owner and name of one to create.
Repository listings are paginated and exclude read-only, archived, and disabled
repositories. New repositories use the chosen public/private visibility. An
existing destination retains its visibility. Entering an existing name uses that
repository too; the review explains the complete-tree replacement below.

`@workspace-extensions/templates` owns inspection and publication. The
manifest-selected Git interop provider creates repositories and pushes the
reviewed bytes.

1. `authoringParts()` lists selectable workspace units. Units supplied by
   declared dependencies remain dependencies and are not selectable exports.
2. `inspectAuthoring({name, description, parts})` resolves the required unit
   closure and projects the runtime declarations into a portable
   `meta/vibestudio.yml`. Package-addressed provider declarations follow the
   selected package's owning unit.
3. Review the included units, generated manifest, source event, and fingerprint.
4. `publishAuthoring({commandId, intent, expectedFingerprint, destination,
version, creation?, credentialId?})` publishes that exact reviewed release.
   Use the same command ID and captured arguments when retrying.

The Publish tab captures the reviewed request before submission and retains it
across reopening, so a connection failure can be retried. The returned URL,
tag, and commit identify the published release. Registry promotion is separate.

### Publication replaces the complete destination tree

When publishing to an existing repository, the complete selected closure is
the next release. Publication preserves Git history and replaces the destination
tree; units and files omitted from the release disappear from that tree.
There is no automatic union with the destination and no remote-diff preview.
Choose the entire release deliberately, including every unit you intend to keep.

Selecting Base as a publication destination does not turn a derivative
workspace's selection into a selective Base contribution. Use the Installed tab
for selected-unit contributions, or open Base directly to author a full release.

CLI example:

```sh
vibestudio templates author-parts
vibestudio templates author-inspect --name News --description 'News workspace' \
  --part panels/news --receipt news-plan.json
vibestudio templates author-publish news-plan.json --owner alice \
  --repository news --version 1.0.0 --command-id news-1.0.0
```

## Contribute units to an installed source

Installation records dependency-first exact source pins in `template.sources`.
These local provenance coordinates are not exported in a published template.

The Installed tab lists those sources separately. Select a source and its units,
review the destination, then push a contribution branch. The source repository's
other units and manifest remain unchanged. Composed `meta` is not independently
owned by one layer, so manifest changes belong in a complete release authored
from that source directly.

The public operations are `installed`, `inspectContribution`, and
`suggestContribution`. CLI equivalents:

```sh
vibestudio templates installed
vibestudio templates contribution-inspect SOURCE_URL --part panels/news \
  --receipt contribution.json
vibestudio templates contribution-push contribution.json --command-id contribution-1
```

## Review an upstream update

An update compares the exact previously installed source composition with the
selected new composition. It stages native VCS deltas in a separate workspace
context and merges local edits. Protected main changes only after review and
ordinary VCS publication. Dependency declarations that pin an exact commit
continue to constrain the selected version.

Use **Review latest update**, inspect changed units, and resolve conflicts with
**Keep local** or **Use incoming**. **View versions** shows previous, local, and
incoming file contents. Binary files and files exceeding the preview limit are
identified explicitly. Coupled native conflicts are resolved together.

Apply the reviewed update only after all conflicts are resolved. The operation
records its exact source snapshots and mutation requests before submission, so
retrying retains its original intent. If main advances before publication,
prepare a new review against the new main rather than silently changing the
reviewed baseline. An affected upstream unit that has been removed locally
blocks an incoming modification until its ownership is resolved; updates never
silently recreate that unit. Workspaces created before exact source provenance
was recorded must be reopened from their template to use these source workflows.

```sh
vibestudio templates update-prepare SOURCE_URL --command-id update-1
vibestudio templates update-review update-1
vibestudio templates update-read update-1 --repo-path panels/news --path index.tsx
vibestudio templates update-resolve update-1 --delta-id DELTA \
  --kind file --id COORDINATE --resolution ours
vibestudio templates update-publish update-1
```
