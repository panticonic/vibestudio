# Git Upstream

Git upstream support is the boundary between Vibestudio's GAD-native workspace
history and an external Git host such as GitHub. It is intentionally two-layered:

1. **GAD main is the workspace source of truth.** Agents, panels, workers, and
   apps commit to Vibestudio repo logs and advance protected `main` through the
   VCS surface.
2. **A local Git checkout is the interchange format.** The manifest-declared
   `providers.gitInterop` extension exports protected `main` into
   `workspace/<repoPath>` as normal Git commits with GAD trailers, then pushes
   those commits to the configured upstream. Pulls travel the opposite way:
   fetch into the local checkout, import the checkout tree through the Git
   interop provider, then publish the imported state onto protected `main`.

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
A declared upstream ALWAYS exports on protected-main advances — the checkout
mirrors GAD history locally with no network involved. `autoPush` additionally
pushes after each export; it does not bypass credential or push policy, and it
pauses (export continues) while the repo is `diverged` or `auth-failed`.
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

## Approval Matrix

| Operation                             | Layer                | Approval or grant                                                                                                                                      |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Declare or edit `git.remotes`         | Host config write    | Shared remote capability approval, then a gated `meta/vibestudio.yml` write.                                                                           |
| Declare or edit `git.upstreams`       | Host config write    | Upstream tracking capability approval. Approval records intent to track; it does not push.                                                             |
| Export GAD main to the local checkout | git-bridge extension | Extension-owned local filesystem work under the trusted extension install boundary.                                                                    |
| Push local Git commits to upstream    | Git transport        | Credential grant for the remote URL plus push approval/egress policy.                                                                                  |
| Pull/fetch from upstream              | Git transport        | Credential grant for the remote URL; provider-specific helpers may verify repository access first.                                                     |
| Import pulled checkout tree into GAD  | git-bridge plus VCS  | Import publishes through the protected-main single-writer path and its normal approval gate.                                                           |
| `autoPush: true`                      | Background trigger   | Requires the upstream declaration and stored credential. Any still-required push or credential approval must already be grantable for unattended work. |
| Extension provider update             | Extension system     | Install, source push to active branch, or explicit dependency update goes through the elevated extension approval path.                                |

## Divergence Playbook

Upstream divergence means the local exported checkout and the remote branch no
longer have a fast-forward relationship, or an imported tree cannot publish over
the current protected `main`.

### Design decision: diverged pulls merge in GIT, not in GAD

When a pull finds true divergence (both the local branch and the remote moved),
the upstream engine runs a git-side merge in the checkout (`git pull`, authored
as the bridge identity) and then imports the MERGED tree into GAD through the
normal gated import publish. GAD does not merge the two histories itself — and
cannot: upstream commits are not GAD heads, so the GAD merge machinery has
nothing to merge against until the tree is imported. Consequences to be aware
of:

- GAD provenance records the merged result as one imported tree; the
  upstream-only commits stay git history (same rule as initial import).
- The merge commit gives the local branch the remote head as a parent, which is
  what makes the follow-up push fast-forward.
- A conflicting merge fails the pull: the repo is marked `diverged` with
  guidance, and the conflict is resolved with git tooling in the checkout (or
  overridden with an explicit force push). Auto-push stays paused throughout.

1. Run upstream status for the repo and identify the layer reporting divergence:
   local checkout vs remote, or imported state vs protected `main`.
2. If protected `main` advanced after export, export again before pushing. This
   is idempotent and should not lose local untracked files.
3. If the remote branch advanced, pull from upstream into the local checkout,
   resolve Git conflicts there if needed, then import and publish through
   git-bridge.
4. If the import publish reports a protected-main conflict, reconcile inside the
   VCS layer first (`vcs.merge` from `main` into the caller context), commit the
   result, then retry publish.
5. Avoid force-pushing as a default repair. Use it only for explicitly approved
   recovery when the user intends to replace the external branch history.
6. When a GAD trailer is missing on an upstream commit, treat it as external
   history. Import by tree snapshot; do not try to synthesize historical GAD
   transitions from arbitrary Git commits.

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

- Dispatch extension RPC calls and stamp caller attribution.
- Persist approved workspace config changes.
- Enforce credential audience matching and inject credentials only through
  host-mediated egress or Git HTTP.
- Run the protected-main publish path and approval gates.
- Keep the trusted-extension install/update boundary visually distinct.

The git-bridge extension owns local checkout materialization, import/export
mapping, GAD trailers, and any local Git process orchestration needed by the
upstream methods. Provider extensions own host-specific setup and UX.
