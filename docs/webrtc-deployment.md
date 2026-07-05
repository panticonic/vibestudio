# WebRTC remote access — deployment

Remote clients reach a Vibestudio server over a peer-to-peer **WebRTC** pipe
(DTLS-encrypted, paired by QR). Two small Cloudflare Workers support it; the
server itself stays on loopback and needs **no public endpoint**.

```
   desktop / mobile / CLI client                      home server / VPS
            │  vibestudio://connect?room&fp&code&sig          │
            ▼                                                ▼
   ┌─────────────────────┐   offer/answer   ┌──────────────────────────┐
   │  signaling Worker    │◀────────────────▶│  server (WebRTC answerer) │
   │  (SignalingRoom DO)  │   (no payload)   │  loopback gateway only    │
   └─────────────────────┘                  └──────────────────────────┘
            │  DTLS pinned by fp (fail-closed)                ▲
            └───────────  peer-to-peer pipe  ─────────────────┘

   OAuth redirects / inbound webhooks ─▶  webhook-relay Worker ─▶ server (backhaul)
```

Neither Worker sees your data: **signaling** only brokers the WebRTC
offer/answer, and the **relay** only forwards OAuth callbacks / webhooks over an
authenticated backhaul socket the server opens.

## 1. Deploy the signaling Worker

```bash
cd apps/signaling
wrangler deploy
# optional — only needed to traverse symmetric NAT (otherwise STUN suffices):
wrangler secret put TURN_KEY_ID            # Cloudflare Realtime TURN credential id
wrangler secret put TURN_KEY_API_TOKEN     # …and its signing key
# optional: wrangler secret put TURN_TTL_SECONDS   (default 86400)
```

`SIGNALING_ROOM` is a Durable Object (one instance per UUID room, WebSocket
Hibernation so a room survives ICE-restart). Note the deployed URL, e.g.
`wss://vibestudio-signaling.<account>.workers.dev` — that becomes `sig`.

## 2. Deploy the callback relay (only if you use OAuth / webhooks remotely)

```bash
cd apps/webhook-relay
wrangler deploy
wrangler secret put VIBESTUDIO_RELAY_SIGNING_SECRET   # backhaul auth + envelope signing
# universal-link hosting for mobile OAuth deep links (plain vars or secrets):
#   VIBESTUDIO_APPLE_APP_ID, VIBESTUDIO_ANDROID_PACKAGE_NAME, VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS
```

`RELAY_REGISTRY` is one global DO: each home server opens one authenticated
`/backhaul` WebSocket and claims its subscription ids (first-writer-wins). There
is no per-server base URL — routing is multi-tenant.

## 3. Run the server as a WebRTC answerer

Set `VIBESTUDIO_WEBRTC_SIGNAL_URL` to activate the answerer (off by default ⇒
loopback co-located mode is unchanged):

```bash
VIBESTUDIO_WEBRTC_SIGNAL_URL=wss://vibestudio-signaling.<account>.workers.dev \
  vibestudio-server --serve-panels --print-credentials
# logs:  Pairing link: vibestudio://connect?room=…&fp=…&code=…&sig=…&v=2
```

The server mints the per-invite signaling room and pairing code itself (one
fresh room per invite; paired devices keep their own rooms).

- The server presents a **persistent DTLS cert** at `<appRoot>/.vibestudio/webrtc/server.{pem,key}`
  (override with `VIBESTUDIO_WEBRTC_CERT`/`VIBESTUDIO_WEBRTC_KEY`). Its SHA-256 is the
  `fp` in the link — the client pins it, **fail-closed** on mismatch.
- `VIBESTUDIO_WEBRTC_ICE=relay` forces TURN (needs the signaling TURN secrets above).
- OAuth redirect URIs are minted from `VIBESTUDIO_RELAY_OAUTH_BASE_URL` (the relay
  origin); register that `…/oauth/callback` with your providers.

The native `node-datachannel` module is loaded lazily on first connect; build it
once with `pnpm rebuild node-datachannel`.

## 4. Pair a client

Scan/open the printed `vibestudio://connect?…` link from the desktop chooser, the
mobile app, or the CLI. The client redeems the one-time `code` over
the pipe, receives a durable device credential, and persists it (encrypted) for
reconnects — see [webrtc-rpc-transport.md](./webrtc-rpc-transport.md) for the
protocol and [webrtc-local-e2e.md](./webrtc-local-e2e.md) for a fully local
rehearsal of all of the above with `wrangler dev`.

## Local rehearsal (no deploy)

Everything above runs against Cloudflare's local runtime:

```bash
pnpm rebuild node-datachannel
pnpm test:webrtc-e2e    # spawns `wrangler dev apps/signaling`, a real answerer,
                        # and a client — covers connect, RPC, bulk stream, AND
                        # the full QR-code → device-credential → refresh pairing.
```
