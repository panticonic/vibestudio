---
name: api-integrations
description: Connect, use, or diagnose an external API through host-mediated credentials and egress, including provider setup UI, static secrets, OAuth, browser redirects, webhooks, and Git HTTP authentication.
---

# API integrations

Credentials are host-held, URL-bound, and usable only through mediated egress.
Workspace code must never receive, log, or relay their secret material.

Use `docs_search` and `docs_open` for the current `credentials` schemas. In
source code, the public workspace client lives under
`packages/runtime/src`; host-side wire schemas live in the service-schema
package. Do not infer a method from an internal RPC name.

## Missing credentials

Treat a missing credential as a normal setup state. Ask only for non-secret
facts needed to identify the provider and audience. Do not open a prompt with
placeholder endpoints, search source for a secret, or switch to a lower-level
credential service.

Credential IDs are opaque. Preserve the complete returned value, including any
prefix. For a diagnostic probe, convert only the canonical unavailable outcome
to a bounded `{ missing: true }` result and rethrow every other error. Do not
return raw errors, metadata, or request details.

Call the appropriate setup API once. A denial or cancellation ends that setup
attempt; unattended approval cannot invent client IDs, tokens, or secrets.

## Setup experience

- Use one persistent `inline_ui` workflow when setup has several related
  steps. Its controls should call trusted helpers directly.
- Put provider-console links next to the step that needs them. Offer internal
  `openPanel(...)` and external `openExternal(...)` actions when both make
  sense.
- For OAuth authorize URLs, pass the expected redirect URI to
  `openExternal(...)` so the host validates the callback binding.
- Ask about user outcomes, not OAuth vocabulary, credential formats, scope
  names, or storage mechanics. Put exceptional choices behind an advanced
  path.
- Collect secrets only through host-owned credential input or a dedicated
  provider workflow. Never use chat, feedback forms, or panel React state.
- Keep provider choice, access intent, browser action, progress, error, and
  retry in one workflow when they belong to one connection attempt.

Use owner skills for GitHub, Google Workspace, and web-search providers instead
of rebuilding their setup flows here.

## Choose the credential mechanism

Import `credentials` from `@workspace/runtime`; it is not an ambient eval
global. Prefer provider OAuth over static tokens when available.

- Use `requestCredentialInput` for user-entered static API keys or tokens.
- Use `connect` for host-owned OAuth. The host composes redirects and stores
  tokens; userland supplies only public configuration and the exact audience.
- Use `configureClient` when OAuth client material must be stored separately.
- Use `fetch` for authenticated HTTP requests and `gitHttp` for Git smart HTTP.
- Use `forAudience` or `hookForUrl` only when their live contract matches the
  caller's transport.

Read the live schema for supported OAuth flow discriminants and required
fields. Choose authorization-code with PKCE for redirect-capable interactive
clients, device code when the provider supports it and callbacks cannot reach
the server, and client credentials only for service identity. Do not maintain a
provider-support list in this skill.

When durable renewal is requested, verify the stored result's lifecycle facts;
requested scopes or the existence of a refresh token are not by themselves a
renewal guarantee. OAuth client configurations are bound to their authorize
and token endpoints; create a distinct configuration when that binding changes.

## Use the credential

```ts
import { credentials } from "@workspace/runtime";

const response = await credentials.fetch(
  "https://api.example.com/items",
  undefined,
  { credentialId },
);
```

The credential audience must cover the exact destination. Do not splice tokens
into URLs or headers yourself.

For unmanaged Git, use `@vibestudio/git` with `credentials.gitHttp()`. For a
shared managed repository, use the runtime `git` provider and
[Git Bridge](../../extensions/git-bridge/SKILL.md). Remote declarations contain
credential-free HTTP(S) URLs and logical credential names, never concrete
secrets. Imports return unpublished semantic candidates and never advance
protected main by themselves.

For external-project onboarding, read
[EXTERNAL_GIT_PROJECTS.md](../onboarding/EXTERNAL_GIT_PROJECTS.md). For webhook
receivers, use live capability docs and the owning unit's authority contract;
credential storage is not a substitute for request verification.
