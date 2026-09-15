# Workspace template ownership review

Status: repository destination UI implemented; ownership redesign pending the inherited-edit policy.

## Verified current behavior

- `CentralData.ensurePrivateWorkspaces` reserves Personal and System with the same
  `addWorkspaceCreation` operation used for ordinary template workspaces.
  The durable descriptor stores a root template pin, with no distinction between
  using a template and authoring it.
- `composeDeclaredTemplateLayers` resolves the root's dependencies, appends the
  selected root, and replaces `meta/vibestudio.yml` with a merged manifest. It
  records the exact stack in `template.sources`, but retains only the root's
  declared `template.dependencies`.
- Consequently Personal's own units look local to Personal, and System's own
  units look local to System. The selected template is not itself a dependency
  of a new user-owned workspace.
- `templates.authoringParts` removes the inventory of declared dependencies.
  It cannot distinguish the selected root's units from units added by the user.
  Dependency inventory is also resolved from the dependency declaration, which
  can float beyond the installed exact pins recorded in `template.sources`.
- There is no workspace-template upstream declaration separate from installed
  source pins. Per-unit `git.remotes` and `git.upstreams` describe a different
  thing. Publishing a template returns a receipt but does not establish the
  destination as the workspace's own template upstream.
- `prepareUpdate` recomposes the recorded exact source stack and merges it
  through native VCS. This preserves local file edits, but its metadata baseline
  is the composed runtime manifest, not a separate authored root declaration.
- Composition rejects duplicate unit ownership. A dependent template cannot
  currently publish an edited copy of a dependency's unit at the same path.
  Silently omitting that edited copy from publication loses the user's changes.

These are model defects, not just missing picker controls. Adding a creation-mode
field and changing `template.dependencies` in the already-merged manifest would
not fix ownership of configuration or portable publication of inherited edits.

## Intended model

An authored manifest and its effective runtime configuration must have distinct
roles. The authored manifest is the source of truth for the workspace's own
units, dependency declarations, and configuration changes. Runtime configuration
is a deterministic projection of that source and its resolved dependencies;
it must not overwrite the authored declaration that publication later reads.

### Use a template (default)

Create a new user-owned root whose dependency is the selected template. Initially
it has no template upstream. Personal and System use this operation too. Record
exact dependency source pins as installation/update baselines. User-created units
belong to the new root. Choosing or creating a publishing destination establishes
that root's own upstream through the same durable publication operation.

### Author a template

Adopt the selected repository as the authored root and retain its own dependency
declarations. Its upstream is that repository. The selected root must not also
become its own dependency. Authoring Base therefore owns Base's units; a normal
workspace using Base inherits them.

Both operations use one resolver, one native semantic source model, and one
publication/update workflow. Their difference is the authored root being created
or adopted, not different runtime implementations.

## Decision required: edited inherited units

Two coherent policies are possible:

1. **Explicit replacement units.** A derivative declares that it replaces an
   inherited unit, carries the complete edited unit, and records its original
   exact baseline. Composition must validate that declaration rather than accept
   arbitrary duplicate ownership. Publication includes it; updates perform a
   three-way merge and require review of conflicts. Replacements and their
   configuration need one canonical representation.
2. **Fork the source template.** Dependencies remain strict and disjoint.
   Local inherited-unit edits can be used and contributed upstream, but cannot
   be published as a derivative without adopting/forking the owning template.
   Publication must identify such edits and explain the required fork, rather
   than silently omit them.

The first policy supports publishing a customized running workspace most
naturally. The second keeps composition smaller but restricts that workflow.
Neither policy should be implemented as silent precedence between duplicate
unit paths.

## Repository destination UI

The publishing page now lists writable, active GitHub repositories for the chosen
connected account, with pagination and actual listed visibility. Changing accounts
clears the selected repository. The account ID is captured in the durable review
and passed to publication.

The name-entry path uses the existing resolve-or-create publishing operation.
A missing repository is created with the selected visibility. If the name already
exists, publication replaces its file tree while retaining Git history and its
existing visibility. Both entry and final review state this behavior. A strict
create-only operation would need a durable repository-creation identity so that
retry after an uncertain creation can distinguish this operation's repository
from an unrelated pre-existing one; it should not be approximated with a
preflight existence check.

## Required validation for the ownership change

- Fresh Personal and System roots depend on their templates and have no own upstream.
- Using Base and authoring Base produce different, correct ownership inventories.
- A derived publication round-trips through a fresh installation, preserving local
  units, inherited units, intended configuration, and the chosen inherited-edit policy.
- Installed ownership is determined from exact recorded pins, not current remote heads.
- Updating any dependency preserves the authored root and local edits; conflicts
  remain reviewable and retries preserve operation identity.
- Publishing to another repository establishes that root's upstream without
  changing dependency origins or falsely claiming write access to them.
- Existing workspaces require an explicit, validated ownership conversion;
  changing their interpretation merely because the application restarted is unsafe.
