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

An explicit `git.importProject()` with no branch discovers the remote's
advertised default and records it. Durable URLs must be credential-free HTTP(S)
URLs without query parameters or fragments; use credential selection for
authentication instead of persisting token-bearing URLs.

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
not required. If that exact declaration already exists, import reuses it
without rewriting its credential, author, auto-push, or unrelated remote
settings. A conflicting URL, selected remote, or branch is rejected until the
declaration is edited explicitly.

## Import APIs

Use `git.importProject()` when you want to add the config declaration, clone the
repo, and create its first semantic `vcs.importSnapshot` candidate:

```ts
import { git } from "@vibestudio/runtime";

const imported = await git.importProject({
  path: "projects/upstream",
  remote: {
    name: "origin",
    url: "https://github.com/owner/upstream.git",
    branch: "feature/workspace-integration",
  },
  credentialIdOverride: "cred_github_...", // call-scoped only; never persisted
});

console.log(
  imported.candidate.contextId,
  imported.candidate.eventId,
  imported.candidate.semanticEvidence
);
```

The remote's `branch` is recorded on both the shared remote and matching
upstream. A concrete `credentialIdOverride` is call-scoped: omission uses the
declaration's logical binding when present and otherwise uses anonymous
transport, while `null` explicitly requires anonymous Git HTTP. The exact imported tree receives stable repository/file identities
and ordinary repository/file changes under one import work unit. That work
unit's required `externalSnapshot` retains the canonical credential-free remote
URI, exact revision, and snapshot digest derived by the semantic workspace only
after it verifies the complete descriptors against their CAS bytes. The
server-local checkout path and transport credentials are not provenance.
Blame stops at the snapshot boundary when its terminal ordinary change belongs
to that import work unit; Git ancestry and per-path commit metadata stay in
Git. Git commits never become a parallel workspace-event DAG.

`candidate.semanticEvidence` is required. The same atomic semantic transaction
that commits the candidate returns its exact application, import work unit, and
external snapshot; the bridge does not reconstruct these identities afterward.
Agents can independently inspect those returned IDs and verify the canonical
source URI, revision, digest, and target repository identities.

The returned candidate is committed in its dedicated import context, but it is
not protected `main`. From the working context where the project should land,
compare against `imported.candidate.eventId`, integrate ordinary changes in
small local steps, run checks, commit the complete chain with that event as the
integrated source, and call `vcs.push` explicitly only when publication is
intended. `autoPush: false` is an outgoing Git setting; changing it never
publishes an incoming candidate.

`git.importProject()` is intentionally the single-project workflow: one import
work unit has one source coordinate and never conflates several Git remotes.

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

When an existing workspace lacks a declared repository, import that one
repository explicitly. The call creates or reuses the declaration and returns
an unpublished candidate; it never advances protected main:

```ts
const candidate = await git.importProject({
  path: "projects/upstream",
  remote: { url: "https://github.com/owner/upstream.git", branch: "main" },
});
```

## Ongoing synchronization

Keep semantic workspace publication and external Git push as separate,
observable boundaries:

1. Run `git.upstreamStatus([repo])` before deciding what to do. Status always
   observes the remote; there is no cache-only status mode.
2. For local managed work, edit, check, commit, and publish through semantic
   VCS first. Then call `git.pushUpstream(repo)` to export protected main and
   push the resulting Git commit.
3. If the remote is ahead or diverged, preview with
   `git.pullUpstream(repo, { dryRun: true })`, then pull once. The pull returns a
   committed candidate and does not advance protected main. The preview uses a
   isolated temporary checkout and changes no managed checkout, bridge, semantic, or
   remote state.
4. Compare and integrate that exact candidate in small steps, check, commit the
   complete chain, and explicitly publish it through semantic VCS.
5. Fetch status again. Only call `git.pushUpstream(repo)` after the
   `integration-required` candidate has cleared.

Use an upstream's logical `credential` name for durable access. A
`credentialIdOverride` is a one-call override; omit it to use the logical
binding, or pass `null` to require anonymous HTTP. Credential-free declarations
are anonymous-first, so a public repository never prompts merely because it is
public.
If a successful fetch reports `remoteBranchExists: false`, the declared branch
was deleted or has not been created; push to create it or update the
declaration. Do not infer in-sync from zero counts.

Load [Git Bridge](../../extensions/git-bridge/SKILL.md) for remote declaration,
CLI equivalents, exact status states, and the full
divergence playbook.

## Acquisition behavior

External repositories are acquired after bootstrap through explicit userland
`git.importProject()` calls. Each exact source produces a semantic candidate;
ordinary compare, integrate, check, commit, and explicit publication are still
required before that project becomes shared workspace source. Upstream
declarations describe ongoing synchronization and never trigger host startup
imports.

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
Successful config changes queue immediate provider reconciliation without
waiting for provider readiness.

## Private Repos

Git operations resolve a declaration's logical credential through the
profile-local binding table. Declarations without one are attempted
anonymously first; private repositories require an explicit userland account
connection or a call-scoped credential override.

For private repos, prefer one of these paths:

- call `git.importProject({ ... })` when first adding the repo; any credential
  override applies only to that call
- connect the account through the ordinary credential surface, then use its
  logical name in the declaration

Do not expose PATs to userland code. For direct Git smart HTTP operations, use
`@vibestudio/git` with `credentials.gitHttp()` so credentials remain
host-mediated.

For semantic import invariants, idempotent retry, identity preservation, and
verification, read
[external snapshot import](../vibestudio-vcs/references/external-snapshot-import.md).
