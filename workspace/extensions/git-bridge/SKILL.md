---
name: git-bridge
description: Use the Vibestudio Git Bridge for external Git import, export, upstream status, push, pull, clone, publication, disposable remotes, and remote-server workflows. Use when working on workspace/extensions/git-bridge, git.upstreams/git.remotes, protected-main synchronization, provider publication, or deciding between runtime Git APIs and checkout commands.
---

# Git Bridge

Git Bridge is an interchange adapter. The semantic VCS owns workspace state,
repository and file identity, Changes, provenance, local applications, commits,
and protected `main`. Git owns external commits, refs, checkouts, and transport.
Do not build a second semantic history, merge engine, or provenance system in
the bridge.

Read the [canonical VCS skill](../../skills/vibestudio-vcs/SKILL.md) before
changing a workflow that mutates managed workspace content.

## Mental model

```text
external remote ---- fetch ----> immutable Git HEAD tree
                                      |
                                      | vcs.importSnapshot
                                      v
                       dedicated candidate context + event
                                      |
                                      | vcs.compare + small vcs.integrate steps
                                      v
                       local applications -> commit -> explicit vcs.push
                                      |
                                      v
                              protected main event
                                      |
                                      | export exact repository snapshot
                                      v
                       local Git checkout and commit ---- optional Git push
```

The checkout under `state/git-checkouts/<repoPath>` is a host-state interchange
artifact, never workspace source or the source of truth for managed content.
Build V2 resolves exact semantic repository states through the CAS and never
discovers, hashes, or compiles source from this checkout.

One bridge invocation exports the current protected-main event. It does not
replay the semantic event graph into a parallel Git graph. The exported commit
records `Vibestudio-Repository`, `Vibestudio-State`, and `Vibestudio-Event`
trailers so the bridge can recognize the exact snapshot it produced.

Import scans one exact Git HEAD tree. If the tree differs, the bridge calls
`vcs.importSnapshot` in its dedicated context and returns the resulting
committed candidate event. It never publishes that event to protected `main`.
The import work unit retains the source URI, exact Git revision, and snapshot
digest derived by the semantic workspace after it verifies the complete
descriptors against their CAS bytes. The URI and revision are source-observed
evidence; Git ancestry and per-path commit metadata remain in Git and are not
converted into a second provenance model.

## Use the public API

Workspace code uses the typed `git` namespace from `@workspace/runtime`.
Command-line workflows use `vibestudio vcs git ...`. Both reach the configured
`gitInterop` provider. Userland code must not call the extension through
`extensions.invoke` or hard-code its package name.

In an agent conversation, keep semantic publication on the agent's
context-aware `commit` and `vcs` tools: commit the managed edit, then call the
`vcs` tool with `operation: "push"`. Do not import the lower-level runtime
`vcs` client just to publish the agent's current context; that client requires
an explicit context ID. The `git` runtime namespace below starts only after the
desired snapshot is already protected main.

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

const status = await git.upstreamStatus(["projects/bgkit"], { fetch: true });
await git.pullUpstream("projects/bgkit", { dryRun: true });
await git.pushUpstream("projects/bgkit");
```

An empty repository array means all configured upstreams:

```ts
const statuses = await git.upstreamStatus([], { fetch: true });
```

Use `fetch: true` at an operational decision boundary so ahead/behind and
divergence reflect the remote now. Use `fetch: false` only for an intentionally
local observation, such as checking the candidate returned by the import call
that just ran.

Important runtime methods:

| Method                                   | Meaning                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `setSharedRemote` / `removeSharedRemote` | Change shared remote declarations through approved workspace config APIs.                    |
| `setUpstream` / `removeUpstream`         | Change a repository's selected remote and branch.                                            |
| `detachUpstream`                         | Atomically remove tracking and optionally its declared remote.                               |
| `setAutoPush`                            | Toggle an optional outgoing push after an already-published main event is exported.          |
| `upstreamStatus`                         | Compare the protected-main export with its declared upstream and expose pending candidates.  |
| `pushUpstream`                           | Export the current protected-main snapshot and push it; refuse unresolved import candidates. |
| `pullUpstream`                           | Fetch exact upstream HEAD and return its unpublished semantic candidate.                     |
| `publishRepo`                            | Create a provider repository, configure it, export protected main, and push.                 |
| `importProject`                          | Configure, clone, and return the first unpublished semantic candidate.                       |
| `commitMapping`                          | Read Git commit to semantic-event mappings from export trailers.                             |
| `createDisposableRemote`                 | Create a short-lived credential-free smart-HTTP remote.                                      |
| `publishToDisposableRemote`              | Export, push, verify, and clean up a disposable remote.                                      |
| `pushDisposableRemote`                   | Push to an existing host-managed disposable remote without changing tracking.                |
| `inspectDisposableRemote`                | Read a disposable remote's exact branch head and commit count.                               |
| `removeDisposableRemote`                 | Delete a disposable remote before automatic expiry.                                          |

The CLI exposes the same host-mediated workflow:

```bash
vibestudio vcs git status --repo projects/bgkit
vibestudio vcs git pull --repo projects/bgkit --dry-run
vibestudio vcs git pull --repo projects/bgkit
vibestudio vcs git push --repo projects/bgkit
```

`vibestudio vcs git status` fetches before reporting. Use `--credential ID` to
select a stored credential or `--anonymous` to forbid credential resolution.
Run `vibestudio vcs git --help` for enable, disable, publish, import, auto-push,
and remote-declaration commands.

For a generic public import:

```ts
const imported = await git.importProject({
  path: `projects/import-${Date.now()}`,
  remote: {
    name: "origin",
    url: "https://github.com/octocat/Hello-World.git",
    branch: "master",
  },
});
```

The result carries `candidate.contextId`, `candidate.eventId`, whether the
snapshot changed, and `candidate.semanticEvidence`: the exact application,
import work unit, and external snapshot read back from the canonical GAD graph.
The import records the remote and upstream with
`autoPush: false`, but that setting controls only later outgoing Git pushes; it
never publishes an import candidate. Compare the candidate event from the
working context where it should land, integrate selected changes in small local
steps, and test. Commit derives the candidate source from those recorded local
decisions and rejects mixed or caller-mismatched source parents. Call
`vcs.push` explicitly when publication is intended.

Before reporting that an import succeeded, verify that the returned
`semanticEvidence` is complete and identity-joined to the candidate event. It
is produced by reading the event, application, and import work unit back from
the canonical GAD graph, rather than by trusting clone transport metadata. The
focused `provenance` tool can independently inspect the returned event,
application, and work-unit IDs. Confirm the external snapshot has the
credential-free source URI, exact revision, snapshot digest, and target
repository IDs. See
[external snapshot import](../../skills/vibestudio-vcs/references/external-snapshot-import.md)
for the canonical verification contract. Then use `upstreamStatus` on the same
repository path to distinguish an unpublished `integration-required` candidate
from protected main and outgoing Git publication.

## Startup dependency completion

- Treat the configured provider's `upstreamStatus` as the operational checkout
  observation. Do not infer materialization from workspace source, a repo path,
  or a filesystem scan.
- Clone/import only rows whose state is `not-materialized`.
- Return every other provider-reported state as `skipped` with
  `reason: "already-materialized"`, including `integration-required`: its
  checkout exists even though its candidate has not been published.
- Return unsupported repository sections as `unsupported-path`. Treat a missing
  provider row as a failure; never guess.
- Keep each successful startup import as its own committed candidate. Startup
  completion does not publish candidates or feed checkout bytes into Build V2.
- Use `git.completeWorkspaceDependencies({ credentialId })` for an explicit
  retry/backfill, especially when a private remote needs a credential that was
  unavailable during startup.

For a credential-free end-to-end verification:

```ts
const verified = await git.publishToDisposableRemote("projects/example");
```

Use the lower-level disposable lifecycle only when the remote must survive
between calls:

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
  credentialId: null,
  autoPush: false,
});
await git.pushUpstream("projects/example");
const received = await git.inspectDisposableRemote(disposable.url);
await git.detachUpstream("projects/example", { forgetRemote: true });
await git.removeDisposableRemote(disposable.url);
```

`publishToDisposableRemote` always creates and deletes its own separate remote.
It cannot initialize a URL returned by `createDisposableRemote`; use
`pushUpstream` after declaring that exact URL when later calls must observe the
same Git history. Detach the temporary upstream and shared remote before
deleting the disposable endpoint so workspace configuration never retains a
dead URL.

## Import rules

- Resolve an exact Git revision and require the checkout to match its HEAD tree.
  A dirty checkout is an error, not an implicit edit channel.
- Scan the complete snapshot. Honor the semantic import contract's atomic
  snapshot bound and refuse a larger tree honestly; do not truncate it or
  simulate chunking until a first-class atomic chunk protocol exists.
- Reject the entire snapshot when its Git tree tracks any path the semantic
  workspace excludes or cannot represent, including tracked dependency
  directories, secrets, logs, scratch files, generated artifacts, symlinks,
  submodules, and irregular entry modes. Never silently omit a tracked path:
  the accepted complete tree must describe every tracked entry exactly.
- Stop provenance at the exact snapshot boundary. Do not walk Git history or
  attach per-path authors, commit times, summaries, or revisions to an import.
- Record the canonical credential-free Git remote as the source URI, never the
  server checkout path. Strip transport credentials and ephemeral query/hash
  material; represent a local-only remote by an opaque digest.
- Shallow clones are valid sources. Do not walk or normalize the reachable Git
  graph merely to import a tree.
- Do not infer semantic moves or copies from Git similarity heuristics. Agentic
  edits use `vcs.move` and `vcs.copy`; an external snapshot simply describes
  the state observed at its boundary.
- A changed snapshot becomes one import work unit and one committed candidate
  event in the dedicated context. Adoption, checks, commit, and explicit
  publication happen later through the ordinary VCS workflow; there is no
  import-only publication path.
- The import work unit stores the complete sorted target-repository IDs.
  Inspection exposes an exact count and a 200-ID preview; page
  `imports-repository` neighbors for the full relation, including unchanged
  imports with no authored changes.

## Export rules

- Resolve protected `main`, discover the requested repository through
  `vcs.neighbors`, inspect its current state, and page `vcs.listFiles` to
  exhaustion.
- Read each file from that exact state with `vcs.readFile`.
- Materialize only tracked snapshot content. Propagate deletions and executable
  modes exactly.
- Never stage unrelated untracked checkout files.
- Derive projection identity from the actual Git HEAD commit/tree and its
  `Vibestudio-Event` trailer. Do not persist additional export identity or a
  shadow projection history.
- Re-exporting the same event and exact tree is a no-op. A newer semantic event
  creates the next interchange commit even when its repository tree is
  unchanged, because the trailer identifies the exported state.
- Refuse export and Git push while `upstreamStatus` is
  `integration-required`. Surface the candidate context and event IDs so the
  caller can resume ordinary semantic integration.

## Ownership boundaries

- The extension owns operational checkout materialization below
  `state/git-checkouts/`, local Git commands, Git HEAD observation, upstream
  operational state, transport, and provider dispatch.
- The semantic VCS owns meaning. The bridge calls only canonical VCS
  read/import methods: `status`, `neighbors`, `inspect`, `listFiles`,
  `readFile`, and `importSnapshot`. It has no semantic publication shortcut.
- The host owns policy, approvals, credential injection, workspace config
  writes, and dispatch to the configured provider. Do not move Git transport or
  semantic mutation logic into a general host service.
- Provider-specific repository creation, default-branch discovery, and API
  checks belong in provider packages, not the bridge core or host.
- Credentials flow through `ctx.credentials.gitHttp(...)`. Never expose, log,
  return, or splice tokens into URLs.
- Preserve per-repository locking for export, import, push, pull, clone, and any
  future checkout mutation.
- Auto-push is outgoing-only: it may push an export of an already-published
  protected-main event, and it must stop at an unresolved semantic candidate.
  It is never force-push. Force is an explicit recovery action with overwrite
  preview metadata and user approval.

## Remote topology

The extension runs on the workspace server. Its operational checkout is
`<workspace statePath>/git-checkouts/<repoPath>` even when the UI is on another
device. It is deliberately disjoint from semantic context projections and
workspace source. Clients use RPC through the active server connection; do not
add client-side filesystem shortcuts. Verify server-local host state and inspect
extension logs before attributing remote failures to desktop paths. Build logs
describe semantic/CAS source, not the Git checkout.

Useful diagnostics:

```ts
await workspace.units.logs("@workspace-extensions/git-bridge");
await serverLog.query({ tag: "BuildV2" });
```

## Divergence and recovery

1. Run `upstreamStatus([repo], { fetch: true })`.
2. If it reports `integration-required`, use its exact candidate context and
   event IDs. Compare that event from the intended working context, integrate
   ordinary changes incrementally, run checks, commit the complete local chain,
   and call `vcs.push` explicitly. Do not pull, export, or Git-push over it.
3. When the remote is ahead or diverged, preview with
   `pullUpstream(repo, { dryRun: true })`.
4. Pull once to import exact upstream HEAD as a committed candidate. Retain the
   returned context and event IDs; the pull does not advance protected `main`.
5. If protected `main` advances while integrating, re-observe it and continue
   with ordinary local compare/integrate steps before committing and explicitly
   retrying `vcs.push`. Do not create a bridge-specific merge session.
6. After publication, run `upstreamStatus` again. Outgoing export/push may
   resume only after the candidate is no longer reported.
7. Use force-push only after explicit confirmation that external branch history
   should be replaced.

Preserve actionable states such as `auth-failed` and `diverged`; do not flatten
them into a generic failure or silently retry with broader authority.

## Development checklist

When changing Git Bridge behavior, inspect the full path:

- `packages/service-schemas/src/gitInterop.ts`
- `src/server/services/gitInteropService.ts`
- `workspace/extensions/git-bridge/index.ts`
- `workspace/extensions/git-bridge/bridge.ts`
- `workspace/extensions/git-bridge/upstream.ts`
- `workspace/packages/runtime/src/shared/git.ts`
- `docs/git-upstream.md`

Run focused verification:

```bash
pnpm vitest run workspace/extensions/git-bridge/bridge.test.ts \
  workspace/extensions/git-bridge/upstream.test.ts
pnpm --filter @vibestudio/shared test -- gitInterop
pnpm exec tsc --noEmit --pretty false
```

Regression coverage should protect exact snapshot verification, bounded atomic
admission, deletion and mode propagation, staging failure safety, path swaps,
untracked-file preservation, HEAD-tree/trailer export idempotence, candidate
interlocks, shallow import boundaries, guarded force-push, credentials, and
server-local checkouts.
