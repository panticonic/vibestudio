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
await verifyGitHubGitRemoteAccess(
  "https://github.com/owner/repository.git",
  credentialId
);
```

Connection is not verification. Do not mark onboarding complete merely because
the credential was stored.
