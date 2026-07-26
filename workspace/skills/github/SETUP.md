# GitHub setup

The normal setup experience is the checked-in
[GitHubSetup.tsx](GitHubSetup.tsx) component. Render it with
`inline_ui`; do not translate this document into a sequence of forms.

The component deliberately asks one user-level question—what the user wants to
do—and directly handles token type, permission prefill, browser placement,
trusted credential entry, and live verification within the same persistent
workflow. It does not return choices for an agent-authored follow-up call.

## Happy path

1. Choose an access outcome. **Work with code** is the recommended default.
2. Open GitHub either inside Vibestudio or in the user’s normal browser.
3. On GitHub:
   - keep the generated token name or replace it;
   - choose an expiration;
   - choose selected repositories or all repositories;
   - review the prefilled permissions;
   - generate the token.
4. Return to the setup surface and choose
   **I created the token — save it**.
5. Enter the token only in Vibestudio’s trusted credential prompt.
6. Verify the stored credential with a live GitHub user request.

Never ask the user to paste a token into chat, a normal feedback field, or
panel-owned React state.

## What the access choices mean

- **Look around**: view repository content and collaboration activity, and
  clone or pull code.
- **Work with code**: make normal code changes, push, and work with issues and
  pull requests.
- **Publish repositories**: create repositories, push code, and collaborate on
  issues and pull requests. This adds GitHub’s repository **Administration:
  write** permission, required by GitHub’s repository-creation API.
- **Edit Actions too**: work with code and change GitHub Actions workflow
  files.
- **Full GitHub access**: request the broadest supported repository
  permissions. This is intentionally not the default.

The implementation uses a fine-grained GitHub personal access token. That term
does not need to be surfaced unless the user asks or GitHub’s page requires an
explanation.

## Browser actions

- **Open here** uses a Vibestudio browser panel and is useful for guided setup.
- **Open in my browser** uses the system browser and is useful for existing
  GitHub sessions, passkeys, and password managers.

Both routes use `openGitHubTokenSettings()` and preserve the same
destination-scoped approval. If an internal panel was opened only for setup,
close it after the user no longer needs it.

The setup surface can optionally preselect an organization owner using GitHub's
`target_name` URL parameter. The selected owner is also persisted in the
credential metadata for later inspection. When publishing, that persisted owner
is the default repository owner, so an organization-targeted token can follow
the happy path without repeating the organization argument. The user must be
an organization member, and organization policy or approval may still apply.

When publishing, pass the organization separately from the repository name
when you want to override the persisted token owner:

```ts
await publishToGitHub({
  repoPath: "projects/my-project",
  name: "my-project",
  organization: "my-org",
});
```

When `organization` is omitted, both `publishToGitHub()` and raw
`git.publishRepo()` use the persisted PAT owner when the selected credential
has one, otherwise the authenticated GitHub user. An explicit organization
must match that owner; this prevents a token targeted at one organization from
silently attempting publication into another. If multiple active GitHub
credentials exist, pass `credentialId`; neither path guesses. Both paths
perform live credential and publish-permission preflight before creating
anything. Publishing an organization repository uses GitHub's organization
repository API and Git HTTPS separately. Existing credentials created before
organization API audience support are upgraded compatibly at request time;
reconnecting is not required solely because the credential predates that
binding.

## Advanced token cases

Use these only after a concrete requirement or failure:

- A classic token is a legacy broad-scope fallback. Use
  `tokenKind: "classic"` only when the user explicitly asks for it or the
  required operation cannot use a fine-grained token.
- Fine-grained tokens cannot perform every GitHub operation. Checks API writes
  require a GitHub App.
- Explicit `mode`, permission presets, and raw scopes are implementation
  controls for narrowly specified workflows; they are not onboarding
  questions.

Classic fallback:

```ts
await openGitHubTokenSettings({
  tokenKind: "classic",
  accessLevel: "broad",
  browser: "external",
});

const stored = await requestGitHubTokenCredential({
  tokenKind: "classic",
  accessLevel: "broad",
});
```

## Verification

```ts
const verification = await verifyGitHubCredential(credentialId);
if (!verification.valid) {
  // Use TROUBLESHOOTING.md with the concrete failure.
}
```

For clone or pull access to a known remote:

```ts
await verifyGitHubGitRemoteAccess("https://github.com/owner/repository.git", credentialId);
```

Connection is not verification. Do not mark onboarding complete merely because
the credential was stored. Call `getGitHubOnboardingStatus({ verify: true })`;
the returned `completedAt` is the agent-visible completion marker and includes
the verified credential and token owner.
