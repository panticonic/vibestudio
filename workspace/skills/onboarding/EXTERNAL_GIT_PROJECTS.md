# External Git Projects

Vibestudio workspace source is GAD-backed, but external Git repositories can be
declared as workspace source entries. The durable representation is
`meta/vibestudio.yml`; checkouts are materialized from that declaration.

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

Use `git.importProject()` when you want to add the config declaration and clone
the repo immediately:

```ts
import { git } from "@workspace/runtime";

await git.importProject({
  path: "projects/upstream",
  remote: {
    name: "origin",
    url: "https://github.com/owner/upstream.git",
    branch: "feature/workspace-integration",
  },
  credentialId: "cred_github_...",
});
```

The remote's `branch` is recorded on both the shared remote and matching
upstream. The selected `credentialId`, when present, is recorded on the
upstream.

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
configured repos are still missing:

```ts
const result = await git.completeWorkspaceDependencies({
  credentialId: "cred_github_...",
});
console.log(result.imported, result.skipped, result.failed);
```

## Startup Behavior

On server startup, Vibestudio imports missing repos declared in
`meta/vibestudio.yml` before declared unit reconciliation. That means a declared
external panel, worker, skill, or package can be present before the normal
startup build/reconcile path scans workspace source. Materializing a remote-only
declaration also records its matching upstream with `autoPush: false`.

Startup import trusts the existing workspace config declaration and does not
prompt again. The approval boundary is the config edit that introduced the
remote declaration.

## Approvals

`git.importProject()` uses one workspace config approval covering both
declarations. The prompt names the external import and shows the destination
path, remote name, remote URL, and branch when present. After approval,
Vibestudio writes both declarations to `meta/vibestudio.yml`, with auto-push
disabled, then clones. If the clone fails, the approved config declarations
remain so startup or `git.completeWorkspaceDependencies()` can retry later.

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
