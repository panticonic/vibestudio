# Git Upstream

Git upstream support is the boundary between Vibestudio's semantic workspace
history and an external Git host such as GitHub. It is intentionally two-layered:

1. **The semantic workspace graph is the source of truth.** Agents, panels,
   workers, and apps accumulate local context applications, commit workspace
   events, and publish protected `main` through the VCS surface.
2. **A host-state Git checkout is the interchange format.** The
   manifest-declared `providers.gitInterop` extension exports protected `main`
   into `state/git-checkouts/<repoPath>` as normal Git commits with semantic
   event trailers, then may push those commits to the configured upstream.
   This operational checkout is never workspace source or a Build V2 input.
   Pulls travel the opposite way only as far as a semantic candidate: fetch an
   exact immutable Git revision, import that tree into a dedicated context, and
   return its committed event. A caller brings that event into an intended
   working context through ordinary incremental VCS integration and publishes
   it explicitly.

The host owns policy, approvals, credential injection, workspace config writes,
and provider dispatch. Runtime callers use the typed `git.*` API, which calls the
host `gitInterop.*` service; that service resolves `providers.gitInterop` and
dispatches transport work to the configured extension. Callers never address a
Git Bridge package directly. Config edits are narrow transactions applied to the
current protected `meta/main`, so concurrent edits to different remotes or
upstreams cannot replay stale workspace-config snapshots over one another.

## Configuration

Shared remotes and upstream tracking both live in `meta/vibestudio.yml`.

```yaml
git:
  remotes:
    projects:
      bgkit:
        origin:
          url: https://github.com/acme/bgkit.git
          branch: main

  upstreams:
    projects:
      bgkit:
        remote: origin
        branch: main
        autoPush: false
        credentialId: cred_github_abc123
        authorName: Vibestudio
        authorEmail: vibestudio@example.com
```

`git.remotes` declares the external endpoint shared across workspace contexts.
`git.upstreams` opts a repo into export/push and pull/import behavior by pointing
at one declared remote. `branch` defaults to the remote branch and then `main`.
A declared upstream exports on protected-main advances — the checkout mirrors
semantic events locally with no network involved. `autoPush` may additionally
push an outgoing export; it never publishes an incoming import candidate. Both
export and Git push stop while `upstreamStatus` reports
`integration-required`, preserving the candidate context and event IDs for
ordinary semantic integration. Auto-push does not bypass credential or push
policy, and it pauses while the repo is `diverged` or `auth-failed`.
`credentialId` is a stored URL-bound credential used by host-mediated Git HTTP.
Each network operation captures the declared URL, branch, credential, and
configuration fingerprint before checkout work begins. It uses that immutable
URL plus a fingerprint-specific tracking ref, so a concurrent manifest or Git
config update cannot redirect an in-flight fetch, pull, or push.

From runtime code, configure the two pieces separately:

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
  credentialId: "cred_github_abc123",
  autoPush: false,
});
```

### Startup dependency completion

Startup does not decide that a declared upstream needs cloning by inspecting a
workspace source path. It asks the configured `gitInterop` provider for
`upstreamStatus` on every supported declaration. Only a
`state: "not-materialized"` row starts clone/import. Every other reported state
means the operational checkout already exists and is returned in `skipped` with
`reason: "already-materialized"`; this includes a checkout whose semantic
candidate is still `integration-required`. Unsupported repository sections use
`reason: "unsupported-path"`, and an omitted provider row is an explicit
failure rather than permission to guess from disk.

Each successful clone imports its exact immutable HEAD tree as one committed
candidate. Startup does not publish it, copy it into workspace source, or make
the checkout a build input. `git.completeWorkspaceDependencies()` invokes this
same flow explicitly for retry/backfill, with an optional credential for private
remotes.

### Build boundary

Build V2 resolves exact semantic repository states and reads manifests and file
content through the content-addressed store. It materializes only the requested
unit's dependency closure as a disposable build source. Operational Git
checkouts under `state/git-checkouts/` do not participate in graph discovery,
source hashing, or compilation, even when they contain a fetched tree awaiting
semantic integration.

## Approval Matrix

| Operation                          | Layer                | Approval or grant                                                                                                                                                                                              |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declare or edit `git.remotes`      | Host config write    | Shared remote capability approval, then a gated `meta/vibestudio.yml` write.                                                                                                                                   |
| Declare or edit `git.upstreams`    | Host config write    | Upstream tracking capability approval. Approval records intent to track; it does not push.                                                                                                                     |
| Export protected main to local Git | git-bridge extension | Extension-owned local filesystem work under the trusted extension install boundary; refused while an incoming candidate is unresolved.                                                                         |
| Push local Git commits to upstream | Git transport        | Credential grant for the remote URL plus push approval/egress policy.                                                                                                                                          |
| Pull/fetch from upstream           | Git transport        | Credential grant for the remote URL; provider-specific helpers may verify repository access first.                                                                                                             |
| Import exact Git tree as candidate | git-bridge plus VCS  | Creates one committed import event in a dedicated context. It does not request or perform protected-main publication.                                                                                          |
| Integrate and publish a candidate  | Semantic VCS         | Ordinary compare/integrate/check/commit steps followed by an explicit protected-main push, host-computed approval, and atomic ref advance. Build checks are explicit advisory work, not publication authority. |
| `autoPush: true`                   | Background trigger   | Applies only to outgoing exports of already-published main events. It requires the upstream declaration and stored credential and stops at `integration-required`.                                             |
| Extension provider update          | Extension system     | Install, source push to active branch, or explicit dependency update goes through the elevated extension approval path.                                                                                        |

## Divergence Playbook

Upstream divergence means the local exported checkout and the remote branch no
longer have a fast-forward relationship. `integration-required` is distinct: it
means an exact external snapshot already exists as a committed semantic
candidate and has not yet been incorporated into protected `main`.

### Design decision: Git never performs Vibestudio integration

Git is an external transport and projection, not a second semantic state
machine. When a pull finds true divergence, the bridge materializes the exact
remote head in its operational checkout and imports that snapshot through
`vcs.importSnapshot`. The resulting import work unit records the canonical
credential-free remote URI, observed Git revision, and snapshot digest derived
by the semantic workspace from complete descriptors verified against CAS bytes.
It also records the complete sorted target-repository IDs. Inspection exposes
that complete exact vector; `imports-repository` neighbors expose the same
relation even when an identical tree authors no changes. It authors
ordinary repository/file changes and does not retain optional per-path commit
evidence, fabricate local edit authorship, or splice the Git commit graph into
the workspace-event DAG.

The snapshot import is one ordinary import work unit against the dedicated
context's exact working head. Its repository create, file create/delete/mode,
and whole-content replacement changes appear in the same compare pages as
native work. Whole-content external replacements do not claim a coordinate
mapping merely because some bytes look similar. The imported event remains a
candidate: the bridge does not build-gate it, publish it, or advance protected
`main`. The bridge never creates a Git merge commit, emits conflict markers, or
asks a later scan to reconstruct intent. After a caller incrementally integrates
the candidate through ordinary VCS operations and explicitly publishes the
result, an outgoing export writes the accepted semantic history back onto the
local Git projection.

1. Run upstream status for the repo. If it reports `integration-required`,
   retain the exact `candidate.contextId` and `candidate.eventId`; do not pull,
   export, or Git-push over that candidate.
2. From the working context where the external work should land, compare its
   exact working head with the candidate event. Adopt, reconcile, or decline
   small groups of ordinary changes with one `vcs.integrate` decision at a time
   and test between steps.
3. Commit the complete local application chain. Its recorded decisions derive
   the candidate source parent; a caller-supplied source must match, and mixed
   sources are rejected. Call `vcs.push` explicitly only when publication is
   intended. If main moved, re-observe and continue ordinary local integration;
   do not mutate the operational checkout to manufacture a merge.
4. When no candidate is pending and the remote branch is ahead or diverged,
   preview with `pullUpstream(repo, { dryRun: true })`, then pull once to create
   the exact semantic candidate. The result returns its context and event IDs.
5. After semantic publication, run upstream status again. The bridge may resume
   outgoing export/push only after `integration-required` clears.
6. Avoid force-pushing as a default repair. Use it only for explicitly approved
   recovery when the user intends to replace the external branch history.
7. When a Vibestudio event trailer is missing on an upstream commit, treat it
   as external history. Import by tree snapshot; do not try to synthesize
   historical semantic transitions from arbitrary Git commits.

## Provider Extension Guide

A provider integration, such as GitHub or GitLab, should stay outside host
services unless it is pure policy glue. The provider should:

- Declare credential bindings for API and Git HTTP audiences, using URL-bound
  injection so userland never receives raw tokens.
- Verify repository access with provider APIs or Git smart-HTTP discovery before
  claiming setup is complete.
- Configure `git.remotes` and `git.upstreams` through the runtime `git`
  namespace rather than editing `meta/vibestudio.yml` directly.
- Use the typed runtime `git.*` methods for publish, pull, push, status, and
  import. They route through `gitInterop.*`, where the host resolves the
  configured provider; do not invoke a provider extension by package name.
- Keep provider-specific branch defaults, repository creation, fork selection,
  and permission advice in the provider package or extension.
- Surface divergence in provider language, but hand repair back to the shared
  playbook above.

Provider extensions may use full Node after their elevated install approval, but
they should still route workspace config writes, credentials, and user-visible
approvals through the runtime clients so actions are attributed and auditable.

## Extension-Owned Host Boundary

Git upstream is extension-owned at the capability boundary. The host should not
grow provider-specific GitHub, GitLab, or Bitbucket services. Its job is to:

- Dispatch configured extension calls while retaining the existing authenticated
  caller and causal context; do not mint or stamp authorship metadata.
- Persist approved workspace config changes.
- Enforce credential audience matching and inject credentials only through
  host-mediated egress or Git HTTP.
- Run the protected-main publish path and approval gates.
- Keep the trusted-extension install/update boundary visually distinct.

The git-bridge extension owns operational checkout materialization below
`state/git-checkouts/`, semantic event trailers, and any local Git process
orchestration needed by the upstream methods. Provider extensions own
host-specific setup and UX. Neither checkout ownership nor provider status
makes Git bytes semantic source; only the canonical import operation crosses
that boundary.
