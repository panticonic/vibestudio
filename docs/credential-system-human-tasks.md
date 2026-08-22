# Credential System Human Tasks

This is the current human-facing plan for the URL-bound credential work. It
intentionally does not revive provider manifests, default credentials, legacy
consent, or non-interactive deployment flows.

## Default mobile OAuth path: the callback relay

The server binds loopback only and remote clients reach it over WebRTC, so there
is no per-server public URL for OAuth providers to redirect to. Provider redirect
URIs that need a public HTTPS endpoint resolve through the **callback relay**
(`apps/webhook-relay`, plan §7): the relay owns the stable
`https://vibestudio.app` product origin, receives the provider's redirect, and backhauls
the authorization code to the originating loopback server over its pipe. Each user
registers the relay's `…/oauth/callback` URL with their own OAuth provider clients
(in their own Google / GitHub / etc developer console).

`VIBESTUDIO_RELAY_URL` is only a local/staging override. The hosted product relay
is active by default and does not require server-side configuration.

There is no Tailscale Serve / MagicDNS / `--host tailscale` step anymore — that
HTTPS-ingress path was decommissioned with remote-mode public ingress.

The bootstrap and registration flow is described in
[webrtc-rpc-transport.md](./webrtc-rpc-transport.md) (§7 callback relay).

## Target Domain

Use `vibestudio.app` as the shared public host for the product site, OAuth
universal-link callbacks, well-known mobile verification, and webhook ingress.

OAuth callback paths (when using the shared-relay path) should be:

- `https://vibestudio.app/oauth/callback/:providerId`

`vibestudio://oauth/callback/:providerId` is no longer accepted; OAuth callbacks
must arrive through the verified app-link/universal-link host.

Webhook public ingress paths should be:

- `https://vibestudio.app/i/:subscriptionId`

The Vibestudio server should continue to receive relay traffic on private service
routes, not on provider-facing URLs directly.

## Operating Principles

1. Userland declares intent; the host owns credentials and ingress trust.
2. OAuth code exchange happens in server-supported credential APIs. Userland
   never receives access tokens or refresh tokens.
3. Webhook verification happens before userland code sees an event.
4. Session credential grants remain process/session scoped. No repo-wide
   defaults are reintroduced.
5. Public infrastructure must fail closed when the workspace proof, callback
   ownership, or provider verification is invalid.

## Current Implementation Status

Implemented in the repo:

- Mobile credential OAuth now starts through `credentials.connect`; the
  host owns redirect creation, browser handoff, callback validation, and token
  exchange.
- The webhook relay accepts `POST /i/:subscriptionId`, preserves the raw body,
  and forwards it over the owning workspace's authenticated backhaul.
- The server verifies the frame timestamp and body digest after it arrives on
  the authenticated socket, then performs provider verification, applies replay
  protection, stores subscriptions durably in workspace SQLite, and dispatches
  verified events to the configured worker target.
- Worker and panel runtimes expose generic webhook subscription APIs:
  create, list, revoke, and rotate secret.
- Userland subscriptions are constrained to the caller's own source before they
  can target a worker method.
- Legacy webhook relay routes, provider/lease subscription storage, and
  manifest-webhook runtime stubs have been deleted.

Follow-up TODOs:

- TODO: Configure Apple Team ID,
  Android signing fingerprints, and provider redirect registrations.
- TODO: Add a mobile OAuth continuation token if OAuth must survive full app
  termination or a shell reconnect during the pending flow.
- TODO: Add a dedicated approval-bar shape for public ingress creation; the
  current credential approval queue is credential-shaped and should not be
  reused blindly for webhook targets.
- TODO: Add delivery audit entries and end-to-end provider tests.
- TODO: Verify no deployed provider still points at deleted legacy
  provider-shaped relay URLs.

## Human Tasks

### TODO: Domain and Cloudflare

- TODO: Add DNS records for:
  - `vibestudio.app`
- TODO: Bind `vibestudio.app` to the apex webhook-relay Worker custom domain.
  This single Worker owns `/`, `/p`, `/.well-known/*`, `/oauth/callback/*`,
  `/i/*`, and `/backhaul`.
- TODO: Bind `signal.vibestudio.app` to the signaling Worker custom domain.
- TODO: Configure Cloudflare Realtime TURN secrets for the signaling Worker:
  - `TURN_KEY_ID`
  - `TURN_KEY_API_TOKEN`

### TODO: Mobile App Links

- TODO: Set `VIBESTUDIO_APPLE_APP_ID` on the apex Worker to
  `<teamId>.<bundleId>`.
- TODO: Set `VIBESTUDIO_ANDROID_PACKAGE_NAME` and
  `VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS` on the apex Worker:
  - upload key
  - Play App Signing key, if Play signing is enabled
- TODO: Deploy the apex Worker.
- TODO: Verify with `pnpm smoke:cloudflare:apex -- --expect-app-links`:
  - `https://vibestudio.app/.well-known/apple-app-site-association`
  - `https://vibestudio.app/.well-known/assetlinks.json`
- TODO: Confirm iOS associated domains include `applinks:vibestudio.app`.
- TODO: Confirm Android intent filters include `https://vibestudio.app/oauth/callback`
  and `https://vibestudio.app/p`.
- Done: OAuth callbacks are app-link/universal-link only. `vibestudio://` remains
  registered only for connect-link onboarding and is not accepted as an OAuth
  callback path.

### OAuth Provider Registrations

For each OAuth-backed credential provider we ship or document:

- **Hosted relay (default path):** register the exact callback URL issued beneath
  `https://vibestudio.app/oauth/callback/`.
- **Device-code fallback** (RFC 8628): for providers that support it
  (Google, Microsoft/Azure AD, GitHub, GitLab, Slack, Twitch, Spotify,
  Dropbox, Atlassian, Discord), userland can pass `type: "oauth2-device-code"`
  to `credentials.connect()` and skip redirect-URI registration entirely.
  The trusted approval bar displays the `user_code`; the polling loop is
  cancellable. See `docs/credential-system.md#device-code-flow-rfc-8628`.
- Loopback redirects remain available only when a co-located desktop flow
  explicitly requests one.
- Prefer public PKCE clients. Do not require a mobile client secret.
- Record whether the provider supports:
  - absent `token_type`
  - absent `expires_in`
  - refresh tokens
  - custom scopes
  - strict redirect URI matching
  - Apple Sign-In's domain requirements.

The OpenAI/Codex default must continue to use URL-bound credentials and the
server-supported OAuth PKCE path. The default model is
`openai-codex:gpt-5.6-sol`.

### TODO: Webhook Provider Setup

For each provider integration that needs webhooks:

- TODO: Create the provider-side webhook URL with
  `https://vibestudio.app/i/:subscriptionId`.
- TODO: Generate a provider webhook secret where the provider supports one.
- TODO: Select a verifier primitive:
  - HMAC SHA-256 header
  - timestamped HMAC
  - bearer token header
  - provider-specific built-in verifier only when needed
- TODO: Document expected event headers and replay identifiers.

Provider webhooks must use `https://vibestudio.app/i/:subscriptionId`.

## Programming Work

### Completed: Mobile OAuth on `vibestudio.app`

Done:

1. Mobile credential OAuth helper delegates to `credentials.connect`.
2. The host uses `https://vibestudio.app/oauth/callback/:transactionId` by
   default on mobile and desktop.
3. Explicit desktop loopback is host-owned. Panels and workers use `connect`
   and do not receive raw tokens or compose redirects.

Follow-up:

- TODO: Add a short-lived mobile OAuth continuation token if mobile reconnects
  during OAuth or the app must survive full termination while an OAuth flow is
  pending.
- TODO: Add app restart/reconnect mobile OAuth tests once continuation tokens
  exist.

### TODO: Apex Worker Deployment Hardening

1. Done: the standalone Pages app is gone. The apex `apps/webhook-relay` Worker
   owns pair links and app-link metadata.
2. Done: `scripts/smoke-cloudflare-apex.mjs` checks the landing and well-known
   URLs, then opens a real authenticated backhaul and verifies registration and
   cleanup acknowledgements:
   - content type
   - cache headers
   - Apple app-link route coverage
   - Android assetlinks presence
3. TODO: Wire `pnpm smoke:cloudflare:apex -- --expect-app-links` into CI as a
   manual or environment-gated check.

### Completed: Generic Public Webhook Ingress

Done:

1. Provider-shaped relay routes were replaced with one public route:
   - `POST /i/:subscriptionId`
2. The relay preserves the raw request body and original provider headers.
3. The relay forwards over the workspace-authenticated socket:
   - method
   - path
   - query
   - timestamp
   - raw body SHA-256
4. The relay forwards to:
   - `POST /_r/s/webhookIngress/:subscriptionId`
5. The server validates the backhaul frame timestamp and body digest, then
   looks up the webhook subscription and verifies the provider signature.
6. Replay protection exists:
   - relay timestamp tolerance
   - provider delivery ID dedupe when available
   - payload hash dedupe fallback with a short TTL
7. Verified events are delivered to userland through a worker method.
8. Tests prove old provider-shaped relay paths are no longer exposed.

Follow-up:

- TODO: Add audit entries for:
  - accepted delivery
  - verifier failure
  - replay rejection
  - target delivery failure

### Completed: Webhook Subscription API

Done:

1. Legacy provider/lease subscription storage was deleted.
2. Generic webhook ingress subscriptions are stored durably with:
   - `subscriptionId`
   - owner caller
   - target worker source/class/object/method
   - verifier
   - public URL
   - creation/update/revocation timestamps
3. Runtime APIs exist for workers/panels:
   - create subscription
   - list own subscriptions
   - revoke subscription
   - rotate secret
4. Userland cannot create a subscription that targets another source's
   worker/method.

Follow-up:

- TODO: Require shell/server approval to create public ingress for sensitive
  targets.
- TODO: Move webhook verifier secrets behind encrypted secret references if the
  current encrypted workspace database storage is not enough for the deployment
  threat model.

### TODO: Verification and Deployment Cutover

1. TODO: Add end-to-end tests with a local fake OAuth provider and a local fake
   webhook sender.
2. Done: Cloudflare Worker unit tests cover workspace proof-of-possession,
   registration ownership, raw-body preservation, and legacy route removal.
3. Done: Server integration tests cover:
   - valid authenticated relay delivery + valid provider signature
   - stale or corrupted relay frame
   - replayed delivery
   - revoked subscription
   - durable subscription persistence
   - secret rotation
   - cross-source target rejection
4. TODO: Add a server integration test for valid relay + invalid provider
   signature.
5. TODO: Update `docs/credential-system.md`, `docs/routes.md`, and the sandbox
   skills once the APIs are stable.

## Open Decisions

- TODO: Decide which verifier primitives are required for the first integrations
  beyond HMAC/timestamped HMAC/bearer.
- TODO: Decide whether mobile OAuth continuations need to survive full app
  termination or only foreground/background reconnects during the pending OAuth
  TTL.
