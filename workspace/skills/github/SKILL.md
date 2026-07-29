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

| User-facing choice   | Helper value     | Outcome                                                                     |
| -------------------- | ---------------- | --------------------------------------------------------------------------- |
| Look around          | `read-only`      | Read repositories, issues, pull requests, and Actions; clone/pull           |
| Work with code       | `collaborate`    | Normal code changes, push, issues, and pull requests                        |
| Publish repositories | `publish`        | Create repositories, push code, and collaborate on issues and pull requests |
| Edit Actions too     | `code-workflows` | Collaborate plus workflow-file changes                                      |
| Full GitHub access   | `broad`          | Broadest supported repository permissions                                   |

Default to `collaborate`. If the task includes creating a new repository, use
`publish`; GitHub requires the fine-grained **Administration: write** repository
permission for personal and organization repository creation. Organization
creation additionally requires organization membership and organization policy
approval. Use `broad` only when the user chooses the explicit full-access
outcome. Repository selection remains on GitHub’s page: users may choose
selected repositories or all repositories there.

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
The setup surface also accepts an optional organization owner, passes it to
GitHub as `target_name`, and persists it as credential metadata. Publishing
first resolves exactly one credential: an explicit `credentialId`, or the
sole active GitHub credential. It refuses to guess when multiple credentials
exist. It then resolves the owner as explicit organization, persisted token
owner, or authenticated GitHub user. The raw `git.publishRepo()` path and
`publishToGitHub()` use the same rules.

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
- A plain unmanaged checkout uses `@vibestudio/git` with
  `credentials.gitHttp()`.
- Workspace-managed source uses the runtime `git` provider; never reach into
  the server's operational checkout or run a second merge workflow there.
- `publishToGitHub()` and `git.publishRepo()` create a new GitHub repository
  through the configured provider without receiving the token. If
  `organization` is omitted, they use the persisted organization owner from
  the selected GitHub credential when one exists; otherwise they create the
  repository under the authenticated user. An explicit organization must
  match the selected token owner. Publishing performs live credential and
  permission preflight first, then returns the resolved credential ID, login,
  owner, and owner-source as safe diagnostics. If multiple GitHub credentials
  are active, pass `credentialId` explicitly.
- Configure shared remotes with `git.setSharedRemote()`, tracking with
  `git.setUpstream()`, and inspect before push with
  `git.upstreamStatus([repo])`. Status always observes the remote.
- Import an external repository with `git.importProject()` and integrate its
  returned semantic candidate before publishing protected `main`.

Keep the two publication boundaries explicit:

1. Commit a managed edit with `vcs({ operation: "commit", message })`, then
   publish it with `vcs({ operation: "push" })`.
2. Call `git.pushUpstream(repo)` to export that protected-main snapshot and
   push it to GitHub.
3. When GitHub is ahead or diverged, preview with
   `git.pullUpstream(repo, { dryRun: true })`; this uses isolated temporary Git state
   and mutates neither the managed checkout nor semantic state. Then call
   `git.pullUpstream(repo)` once. Retain the returned candidate event.
4. Compare and incrementally integrate the candidate, check, commit, and
   publish through semantic VCS; then re-run fresh status and
   `git.pushUpstream(repo)`.

Load `skills/git-bridge/SKILL.md` for the complete remote/upstream model,
credential tri-state and divergence recovery. Do not
duplicate that machinery inside GitHub onboarding.
