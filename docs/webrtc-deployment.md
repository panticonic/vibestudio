# WebRTC Remote Access Deployment

Remote clients reach a Vibestudio server over a peer-to-peer WebRTC pipe
(DTLS-encrypted, paired by QR). The server itself stays on loopback and needs no
public inbound port. Cloudflare hosts only the public coordination surfaces:

```text
desktop / mobile / CLI client                    home server / VPS
         |  https://vibestudio.app/pair#...              |
         v                                               v
  +----------------------+  offer/answer/ICE  +-------------------------+
  | signal.vibestudio.app|<------------------>| WebRTC answerer server  |
  | Signaling Worker DO  |                    | loopback gateway only   |
  +----------------------+                    +-------------------------+
         |                                               ^
         +----------- DTLS-pinned WebRTC pipe -----------+

OAuth redirects / webhooks -> vibestudio.app apex Worker -> server backhaul
```

The signaling Worker blind-relays SDP/ICE and mints ICE servers. The apex Worker
owns `/pair`, app-link verification, OAuth callbacks, webhook ingress, and the
server backhaul. Neither Worker is a data-plane proxy for workspace traffic.

## Cloudflare Zone

1. Add `vibestudio.app` to Cloudflare.
2. Import/recreate any existing DNS records.
3. If DNSSEC is enabled at the registrar, disable it before changing
   nameservers.
4. Change the registrar nameservers to the Cloudflare-assigned nameservers.
5. Wait until the zone is active in Cloudflare.

The Worker custom domains are declared in Wrangler config:

- `apps/signaling/wrangler.toml` -> `signal.vibestudio.app`
- `apps/webhook-relay/wrangler.toml` -> `vibestudio.app`

Do not deploy a separate Pages/static app at the apex. `apps/webhook-relay` is
the single apex owner.

## Local Preflight

```bash
pnpm type-check:cloudflare
```

This type-checks both Cloudflare Workers before deployment.

## Signaling Worker

Deploy target: `wss://signal.vibestudio.app/`

TURN is optional for local/dev, but production should set it. Without TURN,
connections may fail on symmetric or highly restricted NATs.

```bash
cd apps/signaling

# Required for reliable production NAT traversal.
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_KEY_API_TOKEN

# Optional; defaults to 86400 seconds.
wrangler secret put TURN_TTL_SECONDS

wrangler deploy
```

From the repo root, the deploy wrapper is:

```bash
pnpm deploy:cloudflare:signaling
```

Smoke it:

```bash
pnpm smoke:cloudflare:signaling -- --expect-turn
```

The smoke checks:

- `GET /healthz`
- `GET /room/<test-room>/ice-servers`
- a real two-role WebSocket relay through a Durable Object room
- `x-signaling-turn: minted` when `--expect-turn` is set

## Apex Worker

Deploy target: `https://vibestudio.app/`

Routes owned by this Worker:

- `GET /`
- `GET /pair`
- `GET /.well-known/apple-app-site-association`
- `GET /.well-known/assetlinks.json`
- `GET /oauth/callback/*`
- `POST /i/*`
- `WS /backhaul`

Configure secrets/vars:

```bash
cd apps/webhook-relay

# Required for relay backhaul auth and webhook envelope signing.
wrangler secret put VIBESTUDIO_RELAY_SIGNING_SECRET

# Required when mobile app-link / universal-link verification should be live.
wrangler secret put VIBESTUDIO_APPLE_APP_ID
wrangler secret put VIBESTUDIO_ANDROID_PACKAGE_NAME
wrangler secret put VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS

wrangler deploy
```

From the repo root:

```bash
pnpm deploy:cloudflare:apex
```

Smoke it:

```bash
pnpm smoke:cloudflare:apex
```

The smoke checks `/healthz`, `/`, `/pair`, and the two `.well-known` app-link
documents.

Before Apple/Android identifiers are configured, the smoke accepts `503` for the
two `.well-known` routes so the apex Worker can be deployed early. Once app-link
metadata is configured, run the strict check:

```bash
pnpm smoke:cloudflare:apex -- --expect-app-links
```

## Deploy Both Workers

After the Cloudflare zone is active and secrets are configured:

```bash
pnpm deploy:cloudflare
pnpm smoke:cloudflare
```

For a production readiness pass with TURN and app-link metadata enforced:

```bash
pnpm smoke:cloudflare:signaling -- --expect-turn
pnpm smoke:cloudflare:apex -- --expect-app-links
```

Run the real desktop and Android clients through the deployed signaling route:

```bash
pnpm test:desktop-pairing-smoke
pnpm smoke:full -- --android-avd NatStack_Test
```

These commands start the normal `vibestudio remote serve` hub in an isolated
home, run `vibestudio remote invite --workspace default`, and assert that the
workspace child's invite contains `wss://signal.vibestudio.app/`. Android
emulators attempt normal host/STUN/TURN ICE by default. Add `--require-turn` for
a relay-readiness pass that fails during preflight when the service is still
STUN-only. Use `--local-signaling` only for an offline Miniflare/coturn run.

## Run A Server

Signaling resolves as flag > environment > config > hosted default:

```bash
vibestudio remote doctor --signal-url wss://signal.vibestudio.app/
vibestudio remote serve --port 3030
```

The server prints a pair URL:

```text
https://vibestudio.app/pair#room=...&fp=...&code=...&sig=...&v=2
```

The server presents a persistent DTLS identity. `remote deploy` pins the hub
identity at:

```text
$HOME/.config/vibestudio/webrtc/identity.pem
```

Workspace child answerers use:

```text
$HOME/.config/vibestudio/workspaces/<workspace>/state/webrtc/identity.pem
```

Override with `VIBESTUDIO_WEBRTC_IDENTITY` only for explicit local setups. The
certificate SHA-256 is the `fp` in the pair link; clients pin it and fail closed
on mismatch.

Force a TURN-only pass when validating production NAT traversal:

```bash
VIBESTUDIO_WEBRTC_ICE=relay vibestudio remote serve --port 3030
```

For a managed SSH/systemd host:

```bash
vibestudio remote deploy user@host --port 3030 --workspace default --signal-url wss://signal.vibestudio.app/
vibestudio remote deploy logs user@host
vibestudio remote deploy update user@host --artifact ./vibestudio-server.tgz
vibestudio remote deploy remove user@host --purge
```

Deploy writes the systemd unit with an absolute `ExecStart` (resolved via
`command -v vibestudio` on the host), waits for the loopback gateway `/healthz`
before minting the first invite, and — on `update` — restarts the unit so the
new build takes over. `remove --purge` also uninstalls the npm package and
deletes the WebRTC identity material (paired devices must re-pair).

## Pair A Client

Open or scan the printed `https://vibestudio.app/pair#...` URL from desktop,
mobile, or CLI. The client redeems the one-time pairing code over the WebRTC
pipe, receives a durable device credential, and persists it for reconnects.

## OAuth And Webhooks

OAuth redirect URIs should use the apex Worker:

```text
https://vibestudio.app/oauth/callback/<transactionId>
```

Set server-side relay origin configuration to the same apex origin when enabling
remote OAuth/webhooks:

```bash
export VIBESTUDIO_RELAY_URL=https://vibestudio.app
export VIBESTUDIO_RELAY_SIGNING_SECRET='<same secret configured on the relay worker>'
```

Both variables are required together; the home server and relay worker must use
the same signing secret.

The relay does not have a per-server upstream URL. Each home server opens an
authenticated outbound `/backhaul` WebSocket and claims its own subscription ids.

## Local Rehearsal

Everything can still run against Cloudflare's local runtime:

```bash
pnpm rebuild node-datachannel
pnpm test:webrtc-e2e
```

`pnpm test:webrtc-e2e` spawns `wrangler dev apps/signaling`, a real answerer,
and a client. It covers connect, RPC, bulk stream, and the QR-code to
device-credential pairing flow.
