# GitHub Troubleshooting

## Verification Fails

- `401 Bad credentials`: regenerate the token and save it again.
- `403 Resource not accessible by personal access token`: add repository access
  or the missing fine-grained permission in GitHub.
- Organization repositories may require organization approval for fine-grained
  PAT access.

## Git Clone Or Push Is Needed

Create the PAT with a friendly access level such as
`requestGitHubTokenCredential({ accessLevel: "read-only" })` for clone/pull,
`accessLevel: "collaborate"` for push, or `accessLevel: "publish"` when the
workflow must create a new repository. Repository creation requires GitHub’s
fine-grained **Administration: write** repository permission. Organization
creation also requires organization membership and organization policy
approval. Explicit `mode: "git"` and
`mode: "api-and-git"` are still available for lower-level agent flows. Verify a
specific remote with `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)`.

Direct clone, pull, push, or fork workflows should use `@vibestudio/git` with
`credentials.gitHttp()` so the PAT is not exposed to panels or workers.
