---
name: git-bridge
description: Use the Vibestudio Git Bridge extension for GAD-native repository import/export, upstream status, publish, push, pull, clone, shared remote, auto-push, and remote-server topology workflows. Use when Codex works on external Git connectivity for workspace repos, docs or code under workspace/extensions/git-bridge, git.upstreams/git.remotes behavior, protected-main to Git synchronization, GitHub/GitLab provider publishing through the bridge, or when deciding whether to use runtime Git APIs versus raw checkout Git commands.
---

# Git Bridge

Use `@workspace-extensions/git-bridge` as the only venue for translating between
Vibestudio's protected GAD `main` history and external Git remotes. A checkout
under `workspace/<repoPath>` is an interchange artifact, not the source of
truth.

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
`disable`). These commands dispatch to Git Bridge through `extensions.invoke`.
For runtime code, configure `git.remotes`/`git.upstreams` through runtime
helpers or provider helpers.

From workspace runtime code, use the shared `git` namespace first:

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("projects/bgkit", {
  name: "origin",
  url: "https://github.com/acme/bgkit.git",
  branch: "main",
});

await git.configureUpstream("projects/bgkit", {
  remote: "origin",
  branch: "main",
  credentialId: "cred_github_...",
  autoPush: false,
});

const status = await git.upstreamStatus("projects/bgkit");
await git.pushUpstream("projects/bgkit");
await git.pullUpstream("projects/bgkit", { dryRun: true });
```

Use direct extension invocation only for extension-owned operations that do not
have a runtime wrapper, panel actions, or maintenance code. The public API is
the awaited return of `activate(...)`, reached through `extensions.invoke`;
Git Bridge is intentionally not registered as a panel-facing typed extension
client.

```ts
import { extensions } from "@workspace/runtime";

await extensions.invoke("@workspace-extensions/git-bridge", "cloneRepo", [
  { repoPath: "projects/bgkit" },
]);
```

Public extension methods:

| Method | Use |
| --- | --- |
| `upstreamStatus(repoPaths?)` | Report configured repos, state, ahead/behind counts, and last push metadata. |
| `pushUpstream(repoPath, opts?)` | Export protected `main` and push to the declared upstream. |
| `pullUpstream(repoPath, opts?)` | Fetch, optionally preview, fast-forward or merge diverged refs, import the tree, and publish to GAD. |
| `publishRepo(input, opts?)` | Create a provider repo, declare `origin`, configure upstream, export, and push. |
| `cloneRepo({ repoPath })` | Clone only the declared remote/upstream for an approved repo path, then import. |
| `importRepo({ url, path, branch?, credentialId? })` | Clone an external project through `gitInterop.importProject`. |
| `setUpstream` / `removeUpstream` | Write `git.upstreams` through host approval-gated config APIs. |
| `setRemote` / `removeRemote` | Write `git.remotes` through host approval-gated config APIs. |
| `setAutoPush(repoPath, on?)` | Toggle upstream auto-push by rewriting the upstream declaration. |
| `onMainAdvanced(repoPaths)` | Queue auto-push work after protected `main` advances. |
| `openGitTab(repoPath?)` | Ask the shell to open the Git upstreams panel. |
| `importRepoTree` / `exportRepoHead` | Low-level bridge import/export primitives for bridge maintenance and tests. |

## Required Boundaries

- Route config writes through runtime `git.*` or bridge wrappers backed by
  `gitInterop`; never edit `meta/vibestudio.yml` directly for remotes or
  upstreams.
- Use `ctx.credentials.gitHttp(...)` through the bridge/Git client path. Do not
  expose, log, return, or manually splice tokens into URLs.
- Keep `cloneRepo` URL-free at the call site. It must use the declared remote
  and upstream config for the repo path.
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
- Do not reintroduce legacy host adoption or direct extension ingestion to repo
  `main`; imports must stage on `import:main` and publish through the protected
  import path.

## Workflows

Before publishing or pushing, inspect status. If a repo is behind or diverged,
preview pull first:

```ts
const status = await git.upstreamStatus("projects/bgkit");
await git.pullUpstream("projects/bgkit", { dryRun: true });
```

For GitHub-specific onboarding and repository creation, prefer the GitHub skill
helper (`publishToGitHub`, `upstreamStatus`) when it is available. It configures
shared remotes/upstreams through runtime APIs and invokes Git Bridge without
receiving raw credentials.

For a generic external import, use runtime `git.importProject(...)` or bridge
`importRepo(...)` so clone plus remote recording remain approval-gated and
auditable. After import, configure upstream tracking separately and leave
`autoPush` off unless the user explicitly wants unattended pushes.

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

When changing Git Bridge behavior, update the bridge, runtime wrappers, panel
calls, docs, and tests together. Check these files first:

- `workspace/extensions/git-bridge/index.ts`
- `workspace/extensions/git-bridge/upstream.ts`
- `workspace/extensions/git-bridge/bridge.ts`
- `workspace/packages/runtime/src/shared/gitApi.ts`
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
