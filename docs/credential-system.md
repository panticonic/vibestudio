# Credential System

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Credential product contracts remain. Protected store placement, scoped use and native-login exchange are governed by U3/U5.

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
`docs/iroh-deployment.md`.

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

## Actor Attribution

Some providers record _who acted_: a human personally, or an agent acting for
that human. A credential may declare which one its provider attributes uses to
with `actor: "human" | "agent"` (on `credentials.store()`, `credentials.connect()`
`credential`, and credential-input requests; reported in secret-free
summaries).

- `actor: "agent"` — the provider marks uses as an agent's. Any caller may use
  it; attributing a human-driven request to an agent over-reports agency, which
  is safe.
- Absent — the provider makes no actor distinction; no caller rule applies and
  the credential stays shared across the hub's members as before.
- `actor: "human"` — the provider treats every use as one member acting
  personally. Two rules follow, both host-enforced before any approval is
  raised (no user decision can permit what they refuse):

### Each member acts with their own human credential

Every credential records the member who connected or stored it
(`owner.userId`), stamped by the host from the verified caller's WP0 subject,
never from the request. Among mutually trusted members this is attribution
correctness, not inter-user hardening: the provider would otherwise record
Bob's action as Dara's. A human-attributed credential is used only for its
owner's actions. The acting member is the verified caller's account
(`callerAccountUserId` / `verifiedInitiatingUserId`): a device's user, and for
agents, workers and other deputies the member whose lineage launched them
(WP0 §6).

- Members may each hold a human credential under the same label (e.g. every
  member's "Namlu"); selection by URL or label picks the acting member's own.
- A member with none gets `credential-owner-required` (userland turns it into
  "connect your own"); another member's credential is never a fallback.
- Naming another member's human credential explicitly is
  `credential-owner-mismatch`; so is re-authenticating over it.
- With no account behind the request at all, the answer is
  `credential-owner-required`.

### Agents act for the member, never as them

An agent execution session (the host-verified `credentialGrantAgentId`)
never receives a human credential's token. If the credential declares no agent
exchange, the agent is refused (`credential-actor-mismatch`), no agent-scoped
grant can be stored for it, and an agent that connects one preapproves nothing
for itself.

A human credential may instead declare an RFC 8693 agent exchange:

```ts
credential: {
  label: "Namlu",
  actor: "human",
  agentExchange: {
    tokenUrl: "https://namlu.example/oauth/token", // same origin as the credential's token endpoint
    clientId: "vibestudio",
    scope: "space:rw", // optional
  },
  // audience, injection, ...
}
```

When an agent of the credential's owner uses it, the host — which alone holds
the member's delegation authority — exchanges the member's current access
token for an agent-attributed one and injects that with the credential's
normal injection template:

```
POST tokenUrl  (application/x-www-form-urlencoded)
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
client_id=<clientId>
subject_token=<member's access token, refreshed first if needed>
subject_token_type=urn:ietf:params:oauth:token-type:access_token
actor_token={"v":1,"chain":[{"definition","instance","label"}, ...]}   (root agent first)
actor_token_type=urn:vibestudio:params:oauth:token-type:agent-lineage
scope=<scope>   (when configured)
```

The lineage is attested by the host from the entity graph: the agent entities
(self-bound agent vessels) on the caller's launch-parent chain, root first, so
a subagent's chain mirrors the real spawn tree. `definition` is the agent's
version-agnostic program (`repoPath#className`) and `instance` the agent
entity — a provider can key a durable agent identity on the program and a
delegation on each running agent. The exchanged token is cached per
(credential, agent entity) until 30 s before the provider's `expires_in` (never
cached without one). A failed exchange fails the request with
`agent-exchange-failed` (the provider's error code in the message); a provider
401 on the agent token triggers one re-exchange. Neither ever falls back to
the member's own token. Consent is the ordinary agent-scoped use grant on the
credential. The exchange's `tokenUrl` must share its origin with the
credential's own OAuth token endpoint, since it spends the member's token.

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
options in `docs/iroh-rpc-transport.md` (§7, callback relay).

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

`git.upstreams.<section>.<repo>.credential` is optional and, when present, is
never a concrete credential id. It is a portable logical name (see
`WorkspaceLogicalCredentialNameSchema` and `WorkspaceGitUpstreamSchema` in
`packages/workspace-contracts/src/workspaceConfigSchema.ts`, and
`WorkspaceGitUpstreamConfig` in `packages/workspace-contracts/src/types.ts`) —
a short identifier such as `github-workspace` that carries no secret material
and is safe to commit in `meta/vibestudio.yml`. The host resolves that name to
a real credential id through a profile-local binding table,
`GitCredentialBindingStore` in `src/server/gitCredentialBindings.ts`, keyed by
`{ workspaceId, name, remoteUrl }`. Concrete credential identities never enter
workspace configuration. When an upstream declares no `credential`, transport
is anonymous-first; the host derives a stable, non-secret coordinate from the
public remote URL instead (`implicitGitCredentialName` in
`src/server/gitCredentialRequirements.ts`), so a later account selection still
lands on the same logical binding.

At request time, `proxyGitHttp` in `src/server/services/credentialService.ts`
resolves a `request.logicalCredential` to a stored credential id through that
binding table and calls `assertGitRequestBelongsToRemote`, which requires the
request URL to be at or under the declared remote's origin and path before the
host injects anything. Userland connects accounts through the ordinary
credential APIs and supplies the portable logical name to Git operations. The
credential material remains host-owned: userland never receives it, and the
host injects it only for matching Git HTTP URLs through
`credentials.gitHttp()` or the git-bridge upstream methods.
Durable remote URLs must not contain usernames, passwords, tokens, query
parameters, or fragments.

The old `credentialId` field is gone; `WORKSPACE_SYSTEM_EPOCH` was bumped 56 →
57 (`packages/shared/src/vcs/systemEpoch.ts`) so a manifest still written
against it fails with an explicit workspace-source upgrade error instead of
silently parsing as an anonymous or automatic upstream.

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
