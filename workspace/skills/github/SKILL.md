---
name: github
description: Connect GitHub, choose access level, use GitHub APIs, clone repos, or sync managed repos through Git Bridge.
---

# GitHub

## Connection workflow

GitHub setup is one owner-controlled workflow, not a questionnaire.

1. Call `getGitHubOnboardingStatus()` from `@workspace-skills/github`.
2. When status is `needs-token`, render the component:

   ```text
   inline_ui({ path: "skills/github/GitHubSetup.tsx", props: {} })
   ```

3. The component opens GitHub, requests the host-owned credential, verifies it,
   and renders success or repair state.
4. For a concrete Git remote, call `verifyGitHubGitRemoteAccess(remoteUrl,
   credentialId)` before clone or pull.

Never collect tokens, scopes, repo selections, or browser placement through
chat. The component owns those choices and calls
`requestGitHubTokenCredential()` so secrets never enter workspace code or
component state. Stop after a denial or cancellation.

Without `inline_ui`, explain that setup requires an interactive Vibestudio
panel. Don't reconstruct it as sequential questions.

## Access outcomes

Use the component's plain-language access choices rather than teaching token
vocabulary. Defaults: `collaborate` for repo work, `publish` for repo creation,
`code-workflows` for workflow-file changes, `broad` only after explicit user
request. Keep classic-token cases in [SETUP.md](SETUP.md) and diagnose failures
with [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Read `index.ts` for current helper exports and parameter types. Don't copy
permission mappings into another workflow.

## Repository work

- Call GitHub APIs with `credentials.fetch()`.
- Use `@vibestudio/git` with `credentials.gitHttp()` for unmanaged checkouts.
- Use the runtime `git` provider for managed workspace repos. Never operate on
  the server's interchange checkout as source.
- Pass `credentialId` when multiple credentials are active; don't guess an
  account or organization.

Managed publication has two boundaries: publish semantic working state through
[Vibestudio VCS](../vibestudio-vcs/SKILL.md), then export protected main to
GitHub. Pulling from GitHub returns an unpublished semantic candidate that must
be compared and integrated normally.

Read [Git Bridge](../../extensions/git-bridge/SKILL.md) for upstream status,
pull, push, divergence, credentials, and provider publication. Don't duplicate
that sync machinery here.
