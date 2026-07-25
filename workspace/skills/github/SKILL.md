---
name: github
description: Connect and verify GitHub access, then use it for API and Git repository workflows.
---

# GitHub

Use this skill when the user wants to connect GitHub, work with repositories,
issues, pull requests, or Actions, or use Git clone/pull/push.

## Product UX

GitHub setup is one workflow, not a questionnaire.

- When status is `needs-token`, render the checked-in
  [GitHubSetup.tsx](GitHubSetup.tsx) with `inline_ui`.
- The card calls the GitHub helpers itself. Do not ask the agent to collect its
  choices and assemble a second eval/function call.
- Do not issue feedback requests for token type, access level, browser
  placement, repository selection, or permission names.
- Ask only about the user-visible outcome. The setup surface offers:
  **Look around**, **Work with code** (recommended), **Edit Actions too**, and
  **Full GitHub access**.
- Use GitHub’s fine-grained token flow automatically. Do not ask the user what
  “PAT,” “fine-grained,” “classic,” `repo`, or individual permission scopes
  mean on the happy path.
- Browser placement is expressed by the setup surface’s **Open here** and
  **Open in my browser** actions, not another form.
- Keep secrets out of chat and component state. The final action must call
  `requestGitHubTokenCredential()`, which opens the trusted credential prompt.
- If the user cancels or denies a prompt, stop cleanly. Do not retry, split the
  workflow into smaller prompts, or ask for the token in chat.

In a client without `inline_ui`, explain that GitHub setup needs an
interactive Vibestudio panel. Do not reconstruct the workflow as sequential
questions.

## Workflow

1. Run `getGitHubOnboardingStatus()`.
2. For `needs-token`, render:

   ```text
   inline_ui({
     path: "skills/github/GitHubSetup.tsx",
     props: {}
   })
   ```

3. The component opens GitHub, invokes the trusted credential prompt, verifies
   the stored credential, and renders success or retry state itself.
4. If a specific remote will be cloned or pulled later, run
   `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)`.
5. Refresh onboarding state when the card asks for it. Do not declare success
   before live verification.

Use ordinary server-side `eval` for status and verification. Use `client_eval`
only when work genuinely depends on the inviting panel’s local runtime. The
portable browser helpers work through either path with the same
destination-scoped approval.

## Friendly access levels

The UI owns these mappings:

| User-facing choice | Helper value | Outcome |
| --- | --- | --- |
| Look around | `read-only` | Read repositories, issues, pull requests, and Actions; clone/pull |
| Work with code | `collaborate` | Normal code changes, push, issues, and pull requests |
| Edit Actions too | `code-workflows` | Collaborate plus workflow-file changes |
| Full GitHub access | `broad` | Broadest supported repository permissions |

Default to `collaborate`. Use `broad` only when the user chooses the explicit
full-access outcome. Repository selection remains on GitHub’s page: users may
choose selected repositories or all repositories there.

## Runtime helpers

```ts
import {
  getGitHubOnboardingStatus,
  openGitHubTokenSettings,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
  verifyGitHubGitRemoteAccess,
} from "@workspace-skills/github";
```

The setup component uses:

```ts
await openGitHubTokenSettings({
  accessLevel: "collaborate",
  browser: "external", // or "internal"
});

const stored = await requestGitHubTokenCredential({
  accessLevel: "collaborate",
});
```

`openGitHubTokenSettings()` pre-fills the supported GitHub permissions.
`requestGitHubTokenCredential()` stores separate URL-bound bindings for GitHub
API, uploads, and Git HTTPS without exposing the token to workspace code.

## Advanced cases

Keep these out of initial setup:

- Use `tokenKind: "classic"` only when the user explicitly requests a classic
  token or a required GitHub operation cannot use a fine-grained token.
- Checks API writes require a GitHub App; do not invent a token permission.
- Use explicit `mode` or permission presets only for a task that genuinely
  needs narrower transport than the friendly access levels.
- Use [SETUP.md](SETUP.md) for GitHub-page guidance and advanced token details.
- Use [TROUBLESHOOTING.md](TROUBLESHOOTING.md) after a concrete verification
  failure.

## Repository work after connection

- API calls use `credentials.fetch()`.
- Clone/pull/push uses `@vibestudio/git` with `credentials.gitHttp()`.
- Workspace-managed remotes use the runtime `git` provider.
- `publishToGitHub()` creates a new GitHub repository through
  `git.publishRepo()` without receiving the token.
- Configure shared remotes with `git.setSharedRemote()`, tracking with
  `git.setUpstream()`, and inspect before push with `git.upstreamStatus()`.
- Import an external repository with `git.importProject()` and integrate its
  returned semantic candidate before publishing protected `main`.

For the complete remote/upstream model and divergence recovery, use
`docs/git-upstream.md`. Do not duplicate that machinery inside onboarding.
