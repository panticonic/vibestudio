---
name: github
description: Connect or verify GitHub, choose an appropriate access outcome, use GitHub APIs, clone unmanaged repositories, or synchronize managed repositories through Git Bridge.
---

# GitHub

## Connection workflow

GitHub setup is one owner-controlled workflow, not a questionnaire.

1. Call `getGitHubOnboardingStatus()` from `@workspace-skills/github`.
2. When status is `needs-token`, render the checked-in component:

   ```text
   inline_ui({ path: "skills/github/GitHubSetup.tsx", props: {} })
   ```

3. Let the component open GitHub, request the host-owned credential, verify it,
   and render success or repair state.
4. For a concrete Git remote, call
   `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)` before clone or pull.

Do not collect tokens, token kinds, scopes, repository selections, or browser
placement through chat. The component owns those choices and calls
`requestGitHubTokenCredential()` so secret material never enters workspace
code or component state. Stop after a denial or cancellation.

Without `inline_ui`, explain that setup requires an interactive Vibestudio
panel. Do not reconstruct it as sequential questions.

## Access outcomes

Use the component's plain-language access choices rather than teaching token
vocabulary. Default ordinary repository work to `collaborate`; repository
creation needs `publish`; workflow-file changes need `code-workflows`; use
`broad` only after the user explicitly chooses full access. Keep advanced
classic-token cases in [SETUP.md](SETUP.md) and diagnose concrete failures with
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Read `index.ts` for the current helper exports and parameter types. Do not copy
their permission mappings into another workflow.

## Repository work

- Call GitHub APIs with `credentials.fetch()`.
- Use `@vibestudio/git` with `credentials.gitHttp()` for an unmanaged checkout.
- Use the runtime `git` provider for managed workspace repositories. Never
  operate on the server's interchange checkout as source.
- Repository publication must resolve one exact credential. Pass
  `credentialId` when more than one is active; do not guess an account or
  organization.

Managed publication has two distinct boundaries: publish the semantic working
state through [Vibestudio VCS](../vibestudio-vcs/SKILL.md), then export protected
main to GitHub. Pulling from GitHub returns an unpublished semantic candidate
that must be compared and integrated normally.

Read [Git Bridge](../../extensions/git-bridge/SKILL.md) for upstream status,
pull, push, divergence, credentials, and provider publication. Do not duplicate
that synchronization machinery in GitHub onboarding.
