# External Git Projects

Vibestudio workspace source is a semantic provenance/VCS graph, while Git is an
external transport. External Git repositories can be declared in
`meta/vibestudio.yml`; their operational checkouts live under the server's
`state/git-checkouts/`, never workspace source. Bytes cross into the semantic
workspace only through explicit external snapshot work units.

## When To Use This

Use external Git projects when source should be editable inside the workspace
while still tracking an upstream Git remote. Common examples:

- a plain upstream repo under `projects/name`
- a panel, worker, skill, package, template, plain project, or about page imported from
  another repository
- a branch an agent is preparing for review outside the Vibestudio workspace repo

Supported parent directories are `panels`, `packages`, `workers`,
`skills`, `about`, `templates`, and `projects`.

## Config Shape

Shared remotes live under `git.remotes.<parent>.<name>.<remoteName>`.

Every remote uses one object shape. Omit `branch` to use the remote's default:

```yaml
git:
  remotes:
    projects:
      upstream:
        origin:
          url: https://github.com/owner/upstream.git
```

Add `branch` when the workspace should clone a specific branch:

```yaml
git:
  remotes:
    projects:
      upstream:
        origin:
          url: https://github.com/owner/upstream.git
          branch: feature/workspace-integration
```

An imported repo also has a matching entry under
`git.upstreams.<parent>.<name>`. `git.importProject()` writes the remote and
upstream together, with `autoPush: false`; a second `git.setUpstream()` call is
not required.

## Import APIs

Use `git.importProject()` when you want to add the config declaration, clone the
repo, and create its first semantic `vcs.importSnapshot` candidate:

```ts
import { git } from "@workspace/runtime";

const imported = await git.importProject({
  path: "projects/upstream",
  remote: {
    name: "origin",
    url: "https://github.com/owner/upstream.git",
    branch: "feature/workspace-integration",
  },
  credentialId: "cred_github_...",
});

console.log(imported.candidate.contextId, imported.candidate.eventId);
```

The remote's `branch` is recorded on both the shared remote and matching
upstream. The selected `credentialId`, when present, is recorded on the
upstream. The exact imported tree receives stable repository/file identities
and ordinary repository/file changes under one import work unit. That work
unit's required `externalSnapshot` retains the canonical credential-free remote
URI, exact revision, and snapshot digest derived by the semantic workspace only
after it verifies the complete descriptors against their CAS bytes. The
server-local checkout path and transport credentials are not provenance.
Blame stops at the snapshot boundary when its terminal ordinary change belongs
to that import work unit; Git ancestry and per-path commit metadata stay in
Git. Git commits never become a parallel workspace-event DAG.

The returned candidate is committed in its dedicated import context, but it is
not protected `main`. From the working context where the project should land,
compare against `imported.candidate.eventId`, integrate ordinary changes in
small local steps, run checks, commit the complete chain with that event as the
integrated source, and call `vcs.push` explicitly only when publication is
intended. `autoPush: false` is an outgoing Git setting; changing it never
publishes an incoming candidate.

`git.importProject()` is intentionally the single-project workflow. Dependency
completion also imports each configured external remote as its own exact
snapshot/event: one import work unit has one source coordinate and never
conflates several Git remotes.

The operational clone is not a Build V2 source tree. Builds resolve the exact
semantic repository state through the CAS, so an unintegrated candidate cannot
become executable merely because its Git checkout exists.

For a later fetched/pulled tree, the adapter calls the same
`vcs.importSnapshot` operation with the existing stable `repositoryId`, exact
complete snapshot, and exact source revision. Surviving file identities remain
stable. Use the import operation rather than pretending an external snapshot is
native `vcs.edit` intent. The operation itself still authors ordinary changes,
so compare, integrate, and revert need no import-specific path. The pull returns
the candidate context and event IDs and leaves protected `main` untouched;
`upstreamStatus` reports `integration-required` until ordinary semantic
integration accounts for the candidate.

Use `git.setSharedRemote()` when the workspace repo already exists and you only
need to record or update a shared remote:

```ts
await git.setSharedRemote("projects/upstream", {
  name: "origin",
  url: "https://github.com/owner/upstream.git",
  branch: "main",
});
```

Use `git.completeWorkspaceDependencies()` as an explicit retry or backfill when
a configured upstream reports that its operational checkout is not materialized:

```ts
const result = await git.completeWorkspaceDependencies({
  credentialId: "cred_github_...",
});
console.log(result.imported, result.skipped, result.failed);
```

## Startup Behavior

On server startup, Vibestudio asks the configured Git provider for
`upstreamStatus` on every supported declared upstream. It clones/imports only a
`not-materialized` row. Every other reported state is returned in `skipped` with
`reason: "already-materialized"`, including `integration-required`: the
operational checkout exists even though the candidate remains unpublished. An
unsupported section is skipped as `unsupported-path`; a missing provider row is
reported as a failure instead of being guessed from workspace source or disk.

Candidate creation does not publish the project or make its host checkout a
second source of truth. A declared external panel, worker, skill, or package
becomes normal shared workspace source only after its candidate is incrementally
integrated, checked, committed, and explicitly published. Materializing a
remote-only declaration also records its matching upstream with
`autoPush: false`.

Each newly materialized external project receives its own exact import work
unit. Startup does not batch unrelated remotes behind one misleading source
tuple.

Startup import trusts the existing workspace config declaration and does not
prompt again. The approval boundary is the config edit that introduced the
remote declaration; the resulting import work unit and external snapshot tuple
are still durable and inspectable.

## Approvals

`git.importProject()` uses one workspace config approval covering both
declarations. The prompt names the external import and shows the destination
path, remote name, remote URL, and branch when present. After approval,
Vibestudio writes both declarations to `meta/vibestudio.yml`, with auto-push
disabled, then clones. If a newly written declaration's clone fails, the host
attempts to roll both declarations back and reports whether rollback succeeded.
Retry the same import when nothing persisted. If rollback itself failed, status
reports `not-materialized`; retry the import or explicitly detach the upstream
and remote. Never treat a configured-but-uncloned path as imported content.

## Private Repos

Startup auto-import has no interactive `credentialId` argument. Public repos can
usually import without extra input. Private repos may fail at startup unless the
host can resolve a usable credential automatically.

For private repos, prefer one of these paths:

- call `git.importProject({ ..., credentialId })` when first adding the repo
- if the config declaration already exists and startup failed, run
  `git.completeWorkspaceDependencies({ credentialId })` as the retry path

Do not expose PATs to userland code. For direct Git smart HTTP operations, use
`@vibestudio/git` with `credentials.gitHttp()` so credentials remain
host-mediated.

For semantic import invariants, idempotent retry, identity preservation, and
verification, read
[external snapshot import](../vibestudio-vcs/references/external-snapshot-import.md).
