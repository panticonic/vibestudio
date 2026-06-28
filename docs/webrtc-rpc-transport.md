# WebRTC RPC Transport — Design

**Status:** Draft / proposal
**Branch:** `claude/webrtc-rpc-transport-2ek0fw`

## Summary

Today a remote NatStack client (desktop Electron shell or React Native mobile
app) reaches its server over a public, TLS-terminated ingress: an RPC WebSocket
at `/rpc`, plus a panel HTTP origin (`/*`) the webview loads documents from, plus
a handful of HTTP routes for callbacks. Standing up that ingress is the bulk of
the remote-mode complexity — HTTPS-or-loopback origin rules, TLS pinning across
session partitions, public-URL/Tailscale detection, ADB reverse ports.

This proposal collapses that to **one peer-to-peer pipe**:

- All client↔server traffic — RPC calls *and* panel asset bytes — rides a
  **WebRTC data channel**, added as one more `EnvelopeRpcTransport`.
- A **minimal, auth-free signaling service** (Cloudflare Durable Object,
  UUID-addressed rooms) brokers the WebRTC handshake. Security lives in the QR /
  pairing key, not in the signaling box.
- Panels load from a **client-local loopback origin** (`http://127.0.0.1`); a
  small local server pulls bytes over the same data channel. No remote HTTP
  origin.
- A **constrained public relay** handles the one class that can never be P2P:
  inbound OAuth callbacks and webhooks from third parties.

The home server stops needing a public TLS endpoint, a stable hostname, TLS
certs/pinning, or reverse-proxy plumbing for its data plane. It keeps an
outbound connection to two small, dumb public services.

## Motivation

A full inventory of panel/client → server communication (see
`src/server/gateway.ts` routing) splits into four buckets:

1. **Needs a URL/origin** — panel HTML + JS/CSS bundles + assets
   (`src/server/panelHttpServer.ts`), blobstore bytes
   (`/_r/s/blobstore/blob/:digest`), app artifacts (`/_a/`), bootstrap scripts
   (`/__loader.js`, `/__transport.js`). Cannot be an `rpc.call()`, but the
   *bytes* can ride any transport.
2. **Inbound from third parties** — OAuth provider redirects
   (`/_r/s/credentials/oauth/callback`) and webhooks
   (`/_r/s/webhookIngress/:id`). An external IdP or GitHub must hit a public
   HTTPS URL; this can never be RPC or P2P.
3. **Foreign protocols** — CDP (`/cdp/:id`), workerd inspector. Their own
   framing, not panel-facing.
4. **Already RPC or trivial** — `credentials.proxyFetch` via `/rpc/stream`,
   `/healthz`, `/api/panels`.

The control plane (bucket 4 + every service call) is *already* 100% RPC over the
`EnvelopeRpcTransport` abstraction (`packages/rpc/src/types.ts`). The remote-mode
complexity is almost entirely downstream of **bucket 1 loading from a remote HTTP
origin**: the trustworthy-origin rules (`packages/shared/src/connect.ts:189`,
`src/main/startupMode.ts:71`), TLS pinning on every panel session partition
(`src/main/tlsPinning.ts:194`), public-URL/Tailscale juggling
(`src/server/publicUrl.ts`, `src/server/vpnDetect.ts`), and mobile ADB reverse
(`10.0.2.2`).

So the lever is not "swap WS for WebRTC" in isolation. It is **"serve panels from
a local origin and backhaul everything over one pipe."** WebRTC is the chosen
pipe because it is NAT-traversing and DTLS-secured, which additionally deletes
the public-TLS-endpoint and pinning ceremony.

## Goals

- One client↔server transport carrying RPC + asset bytes.
- Home server needs no inbound public TLS endpoint, no stable DNS, no TLS certs.
- Reuse the existing transport composition, streaming codec, device-credential,
  and fingerprint-pinning machinery rather than reinventing it.
- Graceful fallback to the existing WebSocket transport where WebRTC can't
  connect.

## Non-goals

- Removing the public footprint entirely. Two minimal public services remain:
  signaling and the callback relay. The point is to make them *dumb and
  stateless-per-request*, not to delete them.
- Replacing app-level authorization. DTLS authenticates the *pipe*; device
  credentials and connection grants still authorize *principals*.
- Reworking CDP / inspector. They stay as-is (dev-only, not on the remote hot
  path).

## Architecture

```
                 ┌──────────────────────────────┐
                 │  Cloudflare (one global box) │
   QR / key      │  • Signaling DO (UUID rooms) │
  ┌─────────────▶│  • Callback relay (multi-    │◀── OAuth redirect / webhook POST
  │              │    tenant: id→server)        │      (the public island, shared)
  │              └───────────┬──────────────────┘
  │                          │ SDP/ICE exchange
  │                          │ + callback backhaul
  │     WebRTC DataChannel   │
  ▼   (RPC + asset bytes)    ▼
┌──────────────┐  DTLS/SCTP  ┌──────────────┐
│   Client     │◀═══════════▶│  Home server │
│ shell/mobile │             │  (behind NAT)│
│              │             │              │
│ 127.0.0.1    │             │  PanelHttp + │
│ loopback ───────bytes──────▶  services +  │
│ webview      │             │  workerd     │
└──────────────┘             └──────────────┘
        ▲
        │ loads panel documents from a LOCAL origin,
        │ never from the remote server
```

### 1. WebRTC `EnvelopeRpcTransport`

A new transport implementing the existing interface
(`packages/rpc/src/types.ts:285`):

```ts
interface EnvelopeRpcTransport {
  send(envelope: RpcEnvelope): Promise<void>;
  onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
  status?(): RpcConnectionStatus;
  ready?(): Promise<void>;
  onStatusChange?(handler): () => void;
  stream?(envelope, signal): Promise<Response>;
}
```

- Envelopes are JSON, framed onto a **reliable, ordered** data channel (SCTP) to
  match WebSocket delivery semantics.
- `stream()` reuses the existing frame codec (`protocol/streamCodec.ts`) — the
  same HEAD/DATA/END/ERROR framing `credentials.proxyFetch` already uses — so
  streaming proxyFetch works unchanged over the channel.
- Composed behind the current WS path via `composeTransports`
  (`packages/rpc/src/transports/compose.ts`): prefer the data channel, fall back
  to `wsClientTransport` when ICE fails.

Stacks: `node-datachannel` or `werift` in Electron main; `react-native-webrtc`
on mobile; native `RTCPeerConnection` in the renderer if a panel ever needs a
direct channel.

#### DataChannel mechanics (design up front, not later)

- **Chunking.** SCTP messages cap around ~256 KB in practice. The stream codec
  already chunks + base64-encodes DATA frames, so it is compatible; size asset
  chunks under the cap and honor `bufferedAmountLowThreshold` for backpressure on
  large transfers (wasm, images, fonts).
- **Multiple channels.** A single reliable-ordered channel serializes
  *everything*, so a large asset pull head-of-line-blocks RPC calls. Open at
  least a **control channel** (RPC calls/events) and a **bulk channel** (asset
  bytes, blob downloads), and consider per-stream channels for proxyFetch.
- **Reconnect / ICE restart.** The WS transport has real maturity here —
  exponential backoff with jitter, socket generations, auth-token refresh, and a
  `recoveryCoordinator` distinguishing cold-recover vs resubscribe
  (`packages/rpc/src/transports/wsClient.ts`,
  `packages/rpc/src/protocol/recoveryCoordinator.ts`). The RTC transport needs
  equivalent reconnection plus an **ICE-restart** path. This is the most
  underestimated chunk of work; budget for it explicitly.

### 2. Signaling — auth-free, capability-addressed

A **Cloudflare Worker + Durable Object** per pairing room, using the WebSocket
Hibernation API. A room is addressed by an unguessable UUID; the DO relays SDP
offers/answers and ICE candidates between the two peers, then can be discarded.
Rooms get a short TTL, mirroring the existing single-use, 1-hour pairing codes.

This is deliberately dumb: it sees SDP (peer IPs, DTLS fingerprints) and forwards
it. It performs **no authentication** — exactly the "transmission using
keys/UUIDs" model requested.

#### Security model — why dumb signaling is safe

The trap with broker-mediated WebRTC: a signaling server that can rewrite SDP can
**MITM by swapping DTLS fingerprints**. Since the signaling box is untrusted, the
channel's security cannot come from it. Two existing primitives close this:

1. **DTLS fingerprint pinning in the QR.** The pairing QR/key carries the
   server's DTLS certificate fingerprint out-of-band. The client accepts the
   peer iff its fingerprint matches — a malicious or compromised signaling server
   cannot MITM. This is the direct analogue of today's TLS fingerprint pinning
   (`src/main/tlsPinning.ts`, the "Fetch from server" / trust-on-first-use flow
   in the settings dialog).
2. **Device credentials over the established channel.** Once the pipe is up, the
   server authorizes the *principal* via the existing connection-grant /
   device-refresh model (`src/main/serverClient.ts`,
   `workspace/apps/mobile/src/services/mobileTransport.ts`). DTLS authenticates
   the pipe; it does not replace app-level authz.

Updated pairing payload (extends the current `natstack://connect?url=…&code=…`,
parsed in `scripts/cli/lib/connect-utils.mjs` /
`packages/shared/src/connect.ts`):

```
natstack://connect?room=<uuid>&fp=<dtls-sha256>&code=<pairing-secret>
```

Threat notes:
- **Room guessing / flooding** — mitigated by high-entropy UUIDs + short TTL.
- **Privacy** — the signaling DO observes peer IPs (inherent to ICE). Acceptable
  for self-host; document it.
- **No fingerprint pin (TOFU)** — same trust-on-first-use posture as the current
  HTTPS fingerprint flow; surface the observed fingerprint for confirmation
  before pinning.

### 3. ICE / TURN — do not assume pure P2P

STUN traverses most NATs, but **symmetric NATs and restrictive corporate/mobile
firewalls require a TURN relay**, at which point traffic is relayed rather than
truly peer-to-peer. This is the most commonly forgotten requirement.

- Use **Cloudflare's TURN service** (Realtime/Calls TURN) to keep the minimal-CF
  footprint, or self-host `coturn`.
- TURN credentials are short-lived and minted per session (ICE servers handed to
  both peers via signaling).
- **Keep the WS transport as a fallback** (`composeTransports`) for networks
  where even TURN is blocked or where the data channel is degraded. This also
  de-risks rollout: ship WebRTC behind the proven WS path.

### 4. Panel local origin — loopback everywhere

Panels load from a **client-local loopback HTTP origin** (`http://127.0.0.1:<port>`)
on every platform. A small local server — essentially the existing
`PanelHttpServer` relocated to the client — answers panel/asset requests by
pulling bytes over the data channel's bulk channel. This is uniform across
desktop and mobile and reuses the most existing code.

**Why loopback rather than a custom `natstack://` scheme.** A custom
`WKURLSchemeHandler` scheme does **not** reliably get a secure context on iOS
WKWebView, which rules out a uniform custom-scheme approach outright. The real
choice is therefore *uniform loopback* vs *three different per-platform handlers*
(desktop `protocol.handle`, iOS loopback, Android `WebViewAssetLoader`). Loopback
wins on:

- **Secure context on all three platforms.** `localhost` / `127.0.0.0/8` are
  "potentially trustworthy" origins, so Electron, iOS WKWebView, and Android
  WebView all grant secure-context APIs (crypto.subtle, etc.).
- **Reusing the existing server.** `PanelHttpServer` is already an HTTP server;
  loopback keeps it nearly intact, swapping its byte source from disk to the
  channel. The trustworthy-origin checks (`connect.ts:isTrustedCleartextHost`
  already whitelists loopback) and session-partition isolation
  (`contextIdToPartition` → `persist:panel:${contextId}`, assigned at the webview
  level and independent of origin) carry over unchanged.

Panel URLs shift from `${protocol}://${externalHost}:${port}/${source}/?contextId=…`
(`packages/shared/src/panelFactory.ts`, mobile
`workspace/apps/mobile/src/services/panelUrls.ts`) to
`http://127.0.0.1:<port>/${source}/?contextId=…`.

Per-platform notes:

- **Desktop (Electron):** loads loopback as-is. *Optional later optimization:*
  swap to `protocol.handle` on a privileged `natstack://` scheme to drop the
  socket entirely (in-process, no port, no cross-process exposure). Not required
  for v1 — keep it as a clean-up once the loopback model is proven.
- **iOS (WKWebView):** embedded loopback server (GCDWebServer-style). Set
  `NSAllowsLocalNetworking` in `Info.plist` for cleartext-to-loopback under ATS.
  Pure loopback does **not** trigger the iOS 14 local-network permission prompt
  (that prompt is for LAN/Bonjour, not loopback). Foreground-only — fine for
  panel rendering. The bridge bootstrap
  (`workspace/apps/mobile/src/components/PanelWebView.tsx`) and managed-origin
  checks (`isManagedHost`) update to recognize the loopback origin.
- **Android (WebView):** a loopback server works (cleartext-to-loopback is
  allowed by default network-security config); alternatively `WebViewAssetLoader`
  gives a virtual `https://…/` secure origin with no socket. Either is fine;
  loopback keeps the model uniform with iOS/desktop.

**The one real cost — local socket exposure.** A listening socket on
`127.0.0.1:<port>` is reachable by *any* local process (and, on multi-user hosts,
potentially other users) — the in-process `protocol.handle` would have avoided
this. Neutralize it the same way `PanelHttpServer` already guards its management
API (`validateManagementAuth` — default-deny, constant-time token): require the
per-session capability token (`__natstackGatewayToken` / connectionId, already
injected into panels) on **every** request and serve nothing without it. Inject
it via per-partition header rewriting (`session.webRequest.onBeforeSendHeaders`
on desktop; initial-load headers on mobile) rather than a URL query param, so it
never leaks into referers/logs. Bind `127.0.0.1` only — never `0.0.0.0` — on a
random high port.

Bootstrap (`/__loader.js`, `/__transport.js`) is delivered the same way — as the
first bytes the loopback server serves — but note the transport code it
bootstraps now establishes the data channel rather than a WS to a remote origin.

### 5. Callback relay — one global, multi-tenant public island

OAuth callbacks and webhooks (bucket 2) need a public HTTPS URL a third party can
reach. This is the one piece that can never be P2P. **Decision: a single global,
NatStack-operated relay shared by all users**, faceting inbound callbacks to the
right home server by the routing keys the server already uses.

**Faceting works on existing keys — no server-side rework.** The server already
matches callbacks by globally-unique keys:

- webhook `subscriptionId` = `crypto.randomUUID()`
  (`src/server/services/webhookIngressService.ts:183`)
- OAuth `state` = 128-bit `randomBytes(16)`
  (`src/server/services/credentialService.ts:2197`)

Both are collision-free across tenants, so they are sound *global* routing keys.
The server's matching logic (`handleOAuthCallback`, webhook ingress) is unchanged;
only the ingress topology changes.

**What already exists.** `apps/webhook-relay/` is a thin Cloudflare Worker that
forwards `POST /i/:subscriptionId` to a server, and the webhook service already
has a first-class `delivery.mode: "relay"` (`webhookIngressService.ts:98`), a
`relayPublicBaseUrl`, `/i/{subscriptionId}` paths, and relay-envelope
verification (`verifyRelayEnvelope`, line 419). The data model is already
relay-ready.

**What needs rework — and it's all in the relay, not the server.** Today's relay
makes two assumptions the global + WebRTC model breaks:

1. **Single-tenant → faceted.** The worker forwards to one hard-coded
   `NATSTACK_SERVER_BASE_URL` (`apps/webhook-relay/src/index.ts:59,91`). Replace
   that static target with a **lookup** (`subscriptionId → server`,
   `state → server`) in CF KV/DO, populated by a **registration** call: the
   server registers "this id is mine" when it creates the subscription / starts
   the OAuth flow.
2. **Public-HTTP delivery → backhaul.** The worker `fetch()`es the server's
   public URL — but in this design the server has *no* public endpoint. Delivery
   moves to a **persistent backhaul**: the server holds a connection open to a CF
   Durable Object; the relay pushes the payload down it. Because webhooks fire
   whenever the provider decides, the relay DO needs **durable offline buffering**
   (queue + TTL + provider-retry semantics) for when the backhaul is down. OAuth
   is interactive (server online, user waiting), so ephemeral `state` suffices.
3. **OAuth relay parity.** Webhooks have a relay mode + worker; OAuth does not yet.
   Build the analogous path (callback → global relay → backhaul → server, keyed by
   `state`). The hook points already exist — `redirect.callbackUri` override and
   the pluggable `"public" | "loopback"` callback mode
   (`credentialService.ts:296,2214`).

**Tenant safety of registration.** Ids are unguessable UUIDs, so the only attack
on a shared relay is registering *someone else's* id. Close it by binding
registration to the **authenticated backhaul identity** (first-writer-wins). The
current globally-shared `NATSTACK_RELAY_SIGNING_SECRET` proves "from the relay"
but is weak for multi-tenant isolation (one compromised server learns it); prefer
the authenticated per-server connection as the trust anchor.

**Accepted trust posture.** A single global relay necessarily sees callback
plaintext in transit:

- **OAuth `code`** — protected. PKCE is implemented (`codeVerifier =
  randomBytes(32)`, `credentialService.ts:742`); the verifier never leaves the
  home server, so an intercepted code is useless to the relay.
- **Webhook payloads** — exposed. HMAC/OIDC verifiers give the home server
  integrity/authenticity but not confidentiality *from the relay operator*. The
  global box can read every tenant's webhook bodies, and is a shared SPOF / DoS
  chokepoint.

This is accepted as the price of one global box (vs per-user relays). Document the
caveat and PKCE mitigation; keep retention/logging at the relay minimal.

Public-URL construction (`src/server/publicUrl.ts`,
`buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH)`) and `relayPublicBaseUrl` point at
the global relay hostname instead of the server's own.

## What moves where

| Traffic | Today | After |
| --- | --- | --- |
| Service calls (fs/git/ai/channels/build/tokens) | RPC over WS | RPC over data channel |
| `credentials.proxyFetch` streaming | RPC `/rpc/stream` | RPC stream over data channel |
| Panel HTML + bundles + assets | Remote HTTP origin `/*` | Bytes over channel → local loopback origin (`127.0.0.1`) |
| Blobstore bytes, app artifacts | HTTP routes | Bytes over channel |
| Bootstrap loader/transport | HTTP `/__*.js` | First bytes from local loopback server |
| **OAuth callbacks, webhooks** | Server's public HTTP routes | **Public relay → backhaul to server** |
| CDP / inspector (dev only) | WS | Unchanged |

Everything except the third-party callbacks rides the single RPC pipe.

## Phased rollout

1. **Transport spike.** Implement the WebRTC `EnvelopeRpcTransport` (control +
   bulk channels, chunking, reconnect/ICE-restart). Wire it behind WS via
   `composeTransports`. Validate against the existing RPC test suites
   (`wsClient.test.ts` analogues).
2. **Signaling DO + pairing.** Cloudflare DO rendezvous; extend the QR/connect
   link with `room` + `fp`; reuse fingerprint pinning. Land TURN config + WS
   fallback.
3. **Local panel origin.** Relocate `PanelHttpServer` to the client as a loopback
   server (`127.0.0.1`) sourcing bytes over the channel; gate every request on
   the per-session capability token via injected headers. Uniform across
   desktop/iOS/Android. (Desktop may later swap to socket-free `protocol.handle`.)
4. **Callback relay.** Public DO relay + server-side registration/backhaul;
   repoint `publicUrl` for OAuth/webhooks only.
5. **Decommission remote ingress.** Once the above is proven, the home server no
   longer binds a public TLS endpoint; remote-mode origin/TLS-pinning machinery
   is removed or gated to legacy.

Each phase is independently shippable behind the WS fallback.

## Open questions / risks

- **Loopback token bootstrap** — the *initial* document navigation must carry the
  capability token via injected request headers (not a URL param); verify
  per-platform header injection on first load (`onBeforeSendHeaders` desktop;
  initial-load headers on mobile). This is the main loopback wrinkle.
- **iOS embedded server** — adds a native dependency (GCDWebServer-style) and is
  foreground-only; confirm acceptable for panel lifecycle and App Store review.
- **Reconnect/ICE-restart parity** — most underestimated effort; needs to match
  the WS transport's recovery semantics (cold-recover vs resubscribe).
- **TURN dependency & cost** — pure P2P is not guaranteed; budget for a relay.
- **Webhook offline buffering** — webhooks fire whenever the provider decides, so
  the global relay DO must durably queue per-subscription and deliver on backhaul
  reconnect (TTL + provider-retry semantics). OAuth is interactive, so ephemeral
  `state` is fine.
- **Registration auth & tenant binding** — id→server registration must be bound to
  the authenticated backhaul identity (first-writer-wins) so one tenant cannot
  claim another's `subscriptionId`/`state`. Replace the shared relay HMAC with the
  per-server connection as trust anchor.
- **Relay as SPOF/DoS chokepoint** — one global box for all users; needs rate
  limiting, abuse controls, and minimal retention given it sees webhook plaintext.
- **Observability** — ICE state, channel `bufferedAmount`, relay delivery
  need surfacing equivalent to today's `server-health` badge.

## Touch points (where code lands)

- `packages/rpc/src/transports/webrtcClient.ts` — new transport (mirrors
  `wsClient.ts`).
- `packages/rpc/src/transports/compose.ts` — already supports fallback routing.
- `packages/rpc/src/protocol/streamCodec.ts` — reused for channel streaming.
- `src/main/serverClient.ts` — desktop transport selection.
- `src/server/panelHttpServer.ts` — reused as a client-local loopback server
  (byte source = data channel); add capability-token gate on all requests.
- `src/main/` — bind the loopback server + inject the token via
  `session.webRequest.onBeforeSendHeaders` per panel partition. (Optional later:
  socket-free `protocol.handle` byte source.)
- `workspace/apps/mobile/src/services/mobileTransport.ts`,
  `components/PanelWebView.tsx`, `services/panelUrls.ts` — mobile transport +
  loopback origin (embedded server / `WebViewAssetLoader`).
- `packages/shared/src/connect.ts`, `scripts/cli/lib/connect-utils.mjs` —
  extended pairing link (`room`, `fp`).
- `src/server/publicUrl.ts`, `services/credentialService.ts`,
  `services/webhookIngressService.ts` — repoint callbacks at the global relay;
  register `state`/`subscriptionId` → self over the backhaul.
- `apps/webhook-relay/` — rework from single-target (`NATSTACK_SERVER_BASE_URL`)
  to multi-tenant `id → server` lookup + DO-held backhaul delivery + offline
  buffer; add the OAuth-callback relay path.
- New: `apps/` Cloudflare signaling DO (UUID rooms).
