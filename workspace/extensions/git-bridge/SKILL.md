---
name: git-bridge
description: Use the Vibestudio Git Bridge extension for GAD-native repository import/export, upstream status, publish, push, pull, clone, shared remote, auto-push, and remote-server topology workflows. Use when Codex works on external Git connectivity for workspace repos, docs or code under workspace/extensions/git-bridge, git.upstreams/git.remotes behavior, protected-main to Git synchronization, GitHub/GitLab provider publishing through the bridge, or when deciding whether to use runtime Git APIs versus raw checkout Git commands.
---

# Git Bridge

Use `@workspace-extensions/git-bridge` as the only venue for translating between
Vibestudio's protected GAD `main` history and external Git remotes. A checkout
under `workspace/<repoPath>` is an interchange artifact, not the source of
truth.

## Task recipes (start here)

Use the typed `git` namespace directly. These are complete calls; do not inspect
implementation source to rediscover their argument shapes.

```ts
import { git } from "@workspace/runtime";

// All configured upstreams (an empty array means all).
const statuses = await git.upstreamStatus([]);

// Import a public repository without credentials.
const imported = await git.importProject({
  path: `projects/import-${Date.now()}`,
  remote: {
    name: "origin",
    url: "https://github.com/octocat/Hello-World.git",
    branch: "master",
  },
});

// GAD-to-Git mapping for an already-exported repo.
const mapping = await git.commitMapping("projects/example", { limit: 100 });
```

`git.commitMapping` does not need shell Git or checkout inspection; it reads the
bridge's exported commit trailers. Sandbox eval deliberately has no Node
`child_process` or host `/tmp` access. Safe `node:fs`, `node:fs/promises`, and
`node:path` imports are compatibility facades over the same owner-scoped runtime
filesystem; they do not provide host filesystem or process access.

For a credential-free writable remote (examples, development, or verification),
use the one-call host-managed disposable smart-HTTP path. It exports, pushes,
verifies the received commit count, removes the temporary remote, and leaves the
repo's declared upstream unchanged:

```ts
const verified = await git.publishToDisposableRemote("projects/example");
// { pushed, commitCount, headCommit, ... }
```

Use the lower-level lifecycle only when you specifically need to keep the
remote between calls. Do not try to construct a bare repo through runtime `fs`:

```ts
const disposable = await git.createDisposableRemote({ name: "publish-check" });
await git.setSharedRemote("projects/example", {
  name: "origin",
  url: disposable.url,
  branch: disposable.branch,
});
await git.setUpstream("projects/example", {
  remote: "origin",
  branch: disposable.branch,
  autoPush: false,
});
await git.pushUpstream("projects/example");
const received = await git.inspectDisposableRemote(disposable.url);
await git.removeDisposableRemote(disposable.url);
```

Disposable URLs are unguessable, accepted only by this host's Git transport,
expire automatically (one hour by default, at most 24 hours), and need no real
credential. They exercise the same export, declared-remote, upstream, and push
path as a provider remote.

## Operating Model

GAD `main` is authoritative. Agents, panels, workers, and apps write through
the VCS surface and advance protected `main`.

Git Bridge owns the local Git checkout, export/import mapping, GAD trailers,
upstream status, pull, push, publish, and clone work. It exports protected
`main` into `workspace/<repoPath>` as Git commits with `GAD-Repo:`,
`GAD-State:`, and `GAD-Event:` trailers, pushes those commits to the declared
upstream, fetches/pulls remote commits into the checkout, then imports the
resulting tree back through the protected-main publish path.

Export is incremental and idempotent. Bridge-private markers and checkout maps
live in extension storage, not in the checkout. Import scans the checkout as a
tree snapshot, ingests it onto non-main `import:main`, then publishes through
the gated single-writer import path. Do not replay arbitrary Git commit history
into GAD transitions.

The host remains policy and dispatch only: capability approvals, workspace
config writes, credential injection, extension invocation, and the protected
single-writer import path. Do not add provider-specific Git transport, clone,
push, status, or egress logic back into host services.

## Remote Topology

- The extension runs on the workspace server, not on the desktop client.
- Disk paths are server-local. In a remote session, `workspace/<repoPath>` refers
  to the remote server's checkout, even when the desktop UI is elsewhere.
- Desktop and mobile clients reach Git Bridge only through RPC over the active
  server connection. Do not add client-side filesystem shortcuts for remote
  workspaces.
- In remote scenarios, verify the expected files exist on the server host before
  blaming desktop path handling.
- Use `workspace.units.logs("@workspace-extensions/git-bridge")` and
  `serverLog.query({ tag: "BuildV2" })` for remote diagnostics.

## Preferred APIs

For command-line workflows, use `vibestudio vcs git ...` (`status`,
`remote:set`, `enable`, `push`, `pull`, `publish`, `import`, `auto`,
`disable`). These commands call the host `gitInterop.*` service. Operations that
need Git transport are dispatched from that service to the extension declared in
`providers.gitInterop`.

Workspace runtime code uses the shared `git` namespace. It is the typed public
client for `gitInterop.*`, so it follows the same policy and configured-provider
route as the CLI. Never call Git Bridge with `extensions.invoke` or hard-code its
package name in userland code.

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("projects/bgkit", {
  name: "origin",
  url: "https://github.com/acme/bgkit.git",
  branch: "main",
});

await git.setUpstream("projects/bgkit", {
  remote: "origin",
  branch: "main",
  credentialId: "cred_github_...",
  autoPush: false,
});

const statuses = await git.upstreamStatus(["projects/bgkit"]);
await git.pushUpstream("projects/bgkit");
await git.pullUpstream("projects/bgkit", { dryRun: true });
```

Public runtime methods:

| Method                                                                     | Use                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `setSharedRemote(repoPath, remote)` / `removeSharedRemote(repoPath, name)` | Write `git.remotes` through host approval-gated config APIs.                                           |
| `setUpstream(repoPath, config)` / `removeUpstream(repoPath)`               | Write `git.upstreams` through host approval-gated config APIs.                                         |
| `setAutoPush(repoPath, enabled)`                                           | Set auto-push on a declared upstream.                                                                  |
| `upstreamStatus(repoPaths, options?)`                                      | Report selected repos, or every configured upstream when `repoPaths` is `[]`.                          |
| `pushUpstream(repoPath, opts?)`                                            | Export protected `main` and push to the declared upstream.                                             |
| `pullUpstream(repoPath, opts?)`                                            | Fetch, optionally preview, fast-forward or merge diverged refs, import the tree, and publish to GAD.   |
| `publishRepo(input)`                                                       | Create a provider repo, declare its remote/upstream, export, and push.                                 |
| `createDisposableRemote(options?)`                                         | Create a short-lived credential-free smart-HTTP remote for development and verification.              |
| `publishToDisposableRemote(repoPath, options?)`                            | Export, push, verify, and clean up a disposable remote without changing declared upstream config.      |
| `inspectDisposableRemote(url)` / `removeDisposableRemote(url)`             | Verify received commits or clean up the disposable remote early.                                      |
| `commitMapping(repoPath, options?)`                                        | Read exported GAD↔Git commit mappings from commit trailers.                                            |
| `resetExportMarker(repoPath)`                                              | Clear a stale export marker before rebuilding an export checkout.                                      |
| `importProject(input)`                                                     | Record its shared remote and upstream (`autoPush: false`), then clone through the configured provider. |
| `completeWorkspaceDependencies(options?)`                                  | Import configured workspace dependencies that are not present locally.                                 |

Git Bridge implements the internal provider operations used by the host:
`upstreamStatus`, `pushUpstream`, `pullUpstream`, `publishRepo`, `cloneRepo`, and
`onMainAdvanced`. Only host-side provider dispatch invokes that contract:
`gitInterop` delegates requested operations, while the host's ref-change hook
delivers `onMainAdvanced`. Raw checkout import/export primitives are
implementation and test internals, not a second runtime API.

## Required Boundaries

- Route userland operations and config writes through runtime `git.*`; never
  invoke Git Bridge directly or edit `meta/vibestudio.yml` for remotes or
  upstreams.
- Use `ctx.credentials.gitHttp(...)` through the bridge/Git client path. Do not
  expose, log, return, or manually splice tokens into URLs.
- Keep the internal provider `cloneRepo` contract URL-free. The host passes only
  the repo path, and the provider must use its declared remote and upstream.
- Treat missing GAD trailers on remote commits as external history. Import by
  tree snapshot; do not synthesize GAD transitions from arbitrary Git commits.
- Never make auto-push force. Force push is manual recovery only and must flow
  through the credential Git intent with overwrite preview metadata.
- When push fails with auth or non-fast-forward errors, preserve the
  `auth-failed` or `diverged` state and let the user repair or resume.
- Keep `GitBridge` core local-only. Network push, pull, clone, provider
  creation, and credentialed Git HTTP belong in the upstream engine or provider
  helpers around the core.
- Preserve per-repo locking with `withRepoLock` for import, export, push, pull,
  clone, and any future mutating checkout operation.
- Never stage untracked checkout files during export. Refresh tracked files
  from the content store, propagate deletions, and update checkout maps only
  after staging succeeds.
- Keep ignored-path parity for `.git`, `node_modules`, VCS ignored dirs/files,
  `.gadignore`, root `MERGE_CONFLICTS.md`, env files, logs, scratch files, and
  TypeScript/package artifacts.
- Keep provider-specific creation, fork selection, branch defaults, and API
  checks in provider packages such as `workspace/packages/integrations`, not in
  host services.
- Host adoption and direct extension ingestion to repo `main` are not supported;
  imports must stage on `import:main` and publish through the protected import
  path.

## Workflows

Before publishing or pushing, inspect status. If a repo is behind or diverged,
preview pull first:

```ts
const statuses = await git.upstreamStatus(["projects/bgkit"]);
await git.pullUpstream("projects/bgkit", { dryRun: true });
```

For GitHub-specific onboarding and repository creation, prefer the GitHub skill
helper (`publishToGitHub`, `upstreamStatus`) when it is available. It configures
shared remotes/upstreams and publishes through the routed runtime Git API without
receiving raw credentials.

For a generic external import, use runtime `git.importProject(...)` so the
remote/upstream declarations and clone remain provider-routed, approval-gated,
and auditable:

```ts
await git.importProject({
  path: "projects/bgkit",
  remote: {
    name: "origin",
    url: "https://github.com/acme/bgkit.git",
    branch: "main",
  },
});
```

The import records both the shared remote and matching upstream in one approved
config change, with `autoPush: false`. Call `git.setAutoPush(...)` afterward only
when the user explicitly wants unattended pushes.

For behind/diverged recovery:

1. Run `upstreamStatus` and identify whether local exported checkout or remote
   history moved.
2. If remote is ahead or diverged, run `pullUpstream(repo, { dryRun: true })`,
   then pull. Diverged pulls merge the fetched upstream into the local checkout
   before importing the resulting tree.
3. If protected `main` moved after export, push again; export is idempotent.
4. If import publish conflicts with protected `main`, reconcile in the VCS layer
   and retry import/publish.
5. Force push only after explicit user confirmation that external branch history
   should be replaced.

## Development Checklist

When changing Git Bridge behavior, update the provider, canonical service schema,
runtime client, panel calls, docs, and tests together. Check these files first:

- `packages/shared/src/serviceSchemas/gitInterop.ts`
- `src/server/services/gitInteropService.ts`
- `workspace/extensions/git-bridge/index.ts`
- `workspace/extensions/git-bridge/upstream.ts`
- `workspace/extensions/git-bridge/bridge.ts`
- `workspace/packages/runtime/src/shared/git.ts`
- `workspace/panels/gad-browser/index.tsx`
- `docs/git-upstream.md`
- `workspace/skills/github/SKILL.md`

Run focused verification after changes:

```bash
pnpm vitest run workspace/extensions/git-bridge/bridge.test.ts
pnpm --filter @vibestudio/shared test -- gitInterop
```

Bridge regression coverage should protect trailers, deletion propagation,
staging failure safety, path swaps, untracked-file preservation, import staging,
ignored paths, guarded force-push behavior, and server-local checkout handling
in remote sessions. For broader changes touching runtime or panels, also run
the relevant TypeScript check or package tests before handing off.
