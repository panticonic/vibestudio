# Credential System

Vibestudio credentials are URL-bound. Userland owns provider-specific setup and
OAuth semantics; the host stores encrypted credential material and injects it
only through host-mediated egress when the request URL matches an approved
audience.

Mobile OAuth and public webhook ingress on `vibestudio.app` are tracked in
`docs/credential-system-human-tasks.md`.

This provider-credential system is separate from remote device pairing. A
device refresh credential authenticates one paired client to the hub and its
workspace children; a provider credential authorizes URL-bound host egress.
Neither is converted into the other, and neither represents authorship or
agent intent. Remote pairing topology and storage are documented in
`docs/webrtc-deployment.md`.

Linked-agent authentication is a third, deliberately minimal mechanism. An
agent credential proves one exact live session entity and stores no copied
context, channel, user, scope, intent, or authorship fields. The workspace
derives semantic binding and owner from the current entity graph at
authentication and live-call time. Authorization remains a service decision;
intent and blame remain provenance traversals. Retiring the entity invalidates
both its credential and live bearer.

## Store Directly

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

`credentials.store()` is the userland runtime wrapper. Direct service/RPC
callers must use the exact wire method `credentials.storeCredential`.

## Host-Owned OAuth Connection

Use this for OAuth providers. Userland declares provider metadata; the host
creates the callback, opens the browser for the initiating client, validates the
callback, exchanges the token, stores allowlisted token material, and grants the
initial use scope selected by the user.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  browser: "external", // or "internal" for an app browser panel
});
```

Supported OAuth flows include PKCE/auth-code, compatibility auth-code,
device-code, client-credentials, JWT bearer, and token exchange. Stored client
configs support `client_secret_post`, `client_secret_basic`, and
`private_key_jwt`; private keys and client secrets stay in the host config.

For renewable OAuth connections, set `persistRefreshToken: true`. The encrypted
credential then owns both the refresh token and the exact refresh recipe that
issued it (token URL, client id, token authentication, and an exact client-config
version when secret client material is required). A token without that recipe is
intentionally nonrenewable and must reconnect. Secret-free summaries expose this
as `lifecycle.canRefresh`; their `scopes` are the provider-returned grant when the
token response includes one, otherwise the originally requested scopes.

## Broad Upstream, Staged Local Bindings

For workspace providers, prefer requesting a durable broad upstream grant once,
then expose narrow local bindings inside Vibestudio. This avoids reconnecting the
user when an agent moves from Gmail to Calendar or from GitHub issues to Git
transport, while still keeping runtime approval grants scoped to the service or
resource being used.

Use `credential.bindings` for the local stages. Each binding has its own
audience, injection shape, label, and use mode:

```ts
await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    clientConfigId: "google-workspace",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    persistRefreshToken: true,
  },
  credential: {
    label: "Google Workspace",
    audience: [
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/", match: "path-prefix" },
      { url: "https://www.googleapis.com/calendar/v3/", match: "path-prefix" },
    ],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
      stripIncoming: ["authorization"],
    },
    bindings: [
      {
        id: "google-gmail",
        label: "Google Gmail",
        use: "fetch",
        audience: [
          { url: "https://gmail.googleapis.com/gmail/v1/users/me/", match: "path-prefix" },
        ],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
          stripIncoming: ["authorization"],
        },
      },
      {
        id: "google-calendar",
        label: "Google Calendar",
        use: "fetch",
        audience: [{ url: "https://www.googleapis.com/calendar/v3/", match: "path-prefix" }],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
          stripIncoming: ["authorization"],
        },
      },
    ],
  },
});
```

For dynamic provider resources, add `grantResource` so approvals stage the
right reusable unit instead of the whole audience. GitHub API calls use this to
allow `/repos/{owner}/{repo}/...` per repository while the upstream PAT can be
valid for all repositories:

```ts
{
  id: "github-repos",
  label: "GitHub repositories",
  use: "fetch",
  audience: [{ url: "https://api.github.com/repos/", match: "path-prefix" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
    stripIncoming: ["authorization"],
  },
  grantResource: { type: "url-path-prefix", segmentCount: 3 },
}
```

Provider packages should export descriptor objects with their binding catalog
and scope list. Runtime clients should call `credentials.forAudience()` with
the binding audience they need first, then use the returned `credentialId` for
subsequent host-mediated fetches. The host still selects the matching binding
for each request URL, so a Gmail client can use the same stored credential for
People API lookups without sharing raw tokens with userland.

### Device-code flow (RFC 8628)

`type: "oauth2-device-code"` is the right choice when a redirect-based flow
can't reach the server — for example, when an OAuth provider rejects the
auto-detected Tailscale `*.ts.net` redirect URI, or when the user wants to
authorize from a different device than the one running vibestudio. The server:

1. Calls the provider's `device_authorization_url` to obtain a `device_code`,
   `user_code`, and `verification_uri`.
2. Opens the verification URL in the user's browser (using
   `verification_uri_complete` when the provider supplies it, so the page
   pre-fills the code).
3. Presents a **device-code approval bar entry** that displays the
   `user_code` in a large, copyable, monospace surface. The entry persists
   until polling completes; the user can cancel with one click.
4. Polls the token endpoint at the provider-specified interval until either
   a token grant arrives, the user cancels, or the device code expires.

Provider support is partial. Known good: Google, Microsoft / Azure AD,
GitHub, GitLab, Slack, Twitch, Spotify, Dropbox, Atlassian, Discord. **Apple
does not support device code** — for Apple Sign-In, see the redirect-URI
options in `docs/webrtc-rpc-transport.md` (§7, callback relay).

Use device-code as a fallback path in personal-server installs whose public
URL can't be registered with a given provider, since it skips the redirect
URI entirely.

## Trusted URL-Bound OAuth Client Config

Panels and workers can request a shell-owned input prompt for OAuth client
config without receiving the entered values. The stored client material is bound
to the approved authorize and token URLs. Once a `configId` is saved, those URL
bindings are immutable; changing OAuth endpoints requires a new `configId`.

```ts
await credentials.configureClient({
  configId: "google-workspace",
  title: "Configure Google Workspace OAuth",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  fields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "secret", required: true },
  ],
});

const status = await credentials.getClientConfigStatus({
  configId: "google-workspace",
});
```

The stored client material can then be injected internally using the stored
URL-bound OAuth endpoints:

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    clientConfigId: "google-workspace",
    scopes: ["openid", "profile", "email"],
  },
  credential: {
    label: "Google Workspace",
    audience: [{ url: "https://www.googleapis.com/oauth2/v1/userinfo", match: "path-prefix" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
      stripIncoming: ["authorization"],
    },
  },
});
```

## Non-OAuth Provider Credentials

API keys, AWS SigV4, SSH keys, OAuth1a, and browser session credentials also go
through `credentials.connect()` so userland never receives the submitted secret.

```ts
const aws = await credentials.connect({
  flow: { type: "aws-sigv4" },
  credential: {
    label: "AWS S3",
    audience: [{ url: "https://s3.us-east-1.amazonaws.com/", match: "origin" }],
    injection: { type: "aws-sigv4", service: "s3", region: "us-east-1" },
  },
});

const git = await credentials.connect({
  flow: { type: "ssh-key" },
  credential: {
    label: "GitHub SSH",
    audience: [{ url: "https://github.com/acme/project", match: "path-prefix" }],
    injection: { type: "ssh-key" },
    bindings: [
      {
        id: "git",
        use: "git-ssh",
        audience: [{ url: "https://github.com/acme/project", match: "path-prefix" }],
        injection: { type: "ssh-key" },
      },
    ],
  },
});
```

## Git Upstream Credentials

External Git remotes should use URL-bound credentials rather than embedded
tokens in remote URLs. A provider can store a broad upstream grant once, then
expose narrow local bindings for API calls and Git HTTP transport. GitHub uses
this pattern with `github-user`, `github-repos`, `github-uploads`, and
`github-git-http`.

`git.upstreams.<section>.<repo>.credentialId` stores the credential selected for
push/pull. The credential material remains host-owned: runtime code passes the
credential id, and the host injects it only for matching Git HTTP URLs through
`credentials.gitHttp()` or the git-bridge upstream methods. Remote URLs must not
contain usernames, passwords, or tokens.

Provider extensions should pair credential setup with repository verification:
check the provider API or Git smart-HTTP discovery for the target repository,
then configure `git.remotes` and `git.upstreams` through the runtime `git`
namespace. See [git-upstream.md](./git-upstream.md) for the upstream approval
model and provider-extension boundary.

Browser-cookie and SAML cookie-session flows can use `browser: "internal"` or
`browser: "external"`. External mode is backed by the shell-owned browser import
store and captures only the declared origins and cookie names.

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});

const fetchExample = credentials.hookForUrl("https://api.example.com/v1/items", {
  credentialId: stored.id,
});
await fetchExample();
```

The host validates URL audiences, strips common incoming credential carriers,
and injects only the stored carrier shape. Runtime APIs do not expose stored
secret material or reusable credential-bearing headers.
