# npm publishing authentication

The local release scripts retain the token saved by `pnpm setup:npm-token` until
you replace it or run `pnpm setup:npm-token --remove`. On Unix, its file is
mode `0600` under `${XDG_CONFIG_HOME:-~/.config}/vibestudio/npm-publish-token`.
`VIBESTUDIO_NPM_TOKEN_FILE` can select another path. Release commands prefer
`NODE_AUTH_TOKEN`, then `NPM_TOKEN`, then that saved file.

For the longest supported local publishing access, create a granular token with
90-day expiration, package read/write **publish and stage** permissions for the
packages/scopes being released, and bypass 2FA for unattended direct publication.
Save it using the hidden prompt:

```sh
pnpm setup:npm-token
pnpm setup:npm-token --check
```

The check authenticates the saved file, regardless of environment variables;
it does not publish, renew the token, or prove package write access. A saved
credential may differ from the credential used by plain `npm whoami`.
`npm login` changes npm's own configuration and does not replace our saved file.

npm limits login sessions to two hours and granular write tokens to 90 days.
Keeping the file indefinitely does not extend the registry credential's lifetime.
Replace the saved token when it expires or is revoked. See npm's
[authentication changes](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)
and [token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

For ongoing publication without rotating a stored write token, npm supports
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) using OIDC from
supported hosted CI runners. Each package must authorize the exact repository
and workflow in its npm settings; the workflow needs the provider's OIDC
permission. This does not authenticate local runs or self-hosted runners.
Configuring that package trust is a separate registry operation, not something
the local token setup command performs.
