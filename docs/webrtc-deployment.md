# WebRTC Remote Access Deployment

Remote clients reach a Vibestudio server over peer-to-peer WebRTC pipes
(DTLS-encrypted, paired by QR). The server itself stays on loopback and needs no
public inbound port. Cloudflare hosts only the public coordination surfaces:

```text
desktop / mobile / CLI client                    home server / VPS
         |  https://vibestudio.app/p#...                 |
         v                                               v
  +----------------------+  offer/answer/ICE  +-------------------------+
  | signal.vibestudio.app|<------------------>| hub control answerer    |
  | Signaling Worker DO  |                    | + workspace answerers   |
  +----------------------+                    +-------------------------+
         |                                               ^
         +---------- DTLS-pinned direct pipes -----------+

OAuth redirects / webhooks -> vibestudio.app apex Worker -> server backhaul
```

The signaling Worker blind-relays SDP/ICE and mints ICE servers. The apex Worker
owns `/p`, app-link verification, OAuth callbacks, webhook ingress, and the
server backhaul. Neither Worker is a data-plane proxy for workspace traffic.

The hub owns users, devices, memberships, pairing codes, workspace routing, and
one stable control WebRTC ingress in its identity database. Each paired client
keeps that hub control pipe while it selects or switches workspaces. The hub is
not a media relay: each workspace child keeps a separate persistent DTLS
identity and WebRTC ingress, and workspace RPC terminates directly at the
selected child. The hub returns only that child's room, fingerprint, and ICE
policy after checking membership.

Pairing rooms exist only on the hub ingress. A workspace child owns only its
workspace device/user rooms; it does not activate a proposed credential or
serve a shadow pairing/control path.

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
- `GET /p`
- `GET /panel`
- `GET /.well-known/apple-app-site-association`
- `GET /.well-known/assetlinks.json`
- `GET /oauth/callback/*`
- `GET /oauth/linkback/*`
- `POST /i/*`
- `WS /backhaul`

Configure secrets/vars:

```bash
cd apps/webhook-relay

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

The smoke checks `/healthz`, `/`, `/p`, the two `.well-known` app-link
documents, and a real P-256-authenticated `/backhaul` registration/unregistration
round trip.

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
pnpm test:cli-remote-smoke
pnpm test:desktop-pairing-smoke
pnpm smoke:full -- --android-avd NatStack_Test
```

These commands start the normal `vibestudio remote serve` hub in an isolated
home, consume its current one-time root-device invite from the strict ready file, and
assert that the invite contains `wss://signal.vibestudio.app/`. Android
emulators attempt normal host/STUN/TURN ICE by default. Add `--require-turn` for
a relay-readiness pass that fails during preflight when the service is still
STUN-only. Use `--local-signaling` only for an offline Miniflare/coturn run.
The desktop harness uses an isolated OS credential store rather than the
developer's keyring. From a headless Linux shell, install Xvfb, D-Bus, and GNOME
Keyring, then run `xvfb-run -a pnpm test:desktop-pairing-smoke`.

## Run A Server

For an always-on Linux server on the computer running the command:

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote deploy local
```

The same deployment lifecycle accepts `user@host` when the server is a
different machine. It installs a loopback-only systemd user service, enables
linger, validates the hub plus the default workspace, and prints the service's
current root pairing QR. The hub publishes its ready file only after that
workspace has compiled and validated the desktop shell and every deduplicated
panel source declared by `initPanels`. This is a bounded startup set, not a
workspace-wide prewarm: optional panels and features stay lazy. The pairing
command therefore never hands a client a link while the first desktop surface
is still performing a cold build. Use `remote deploy pairing`, `status`,
`logs`, `update`, and `remove` with the same `local` or `user@host` target.

For a foreground session, signaling resolves as flag > environment > config >
hosted default:

```bash
vibestudio remote doctor --signal-url wss://signal.vibestudio.app/
vibestudio remote serve --port 3030
```

`remote doctor` checks the stable hub control identity by default. Use
`--workspace <name>` only when diagnosing that child's workspace ingress.

The server prints a pair URL:

```text
https://vibestudio.app/p#<compact-payload>
```

The v3 payload is self-contained. It compactly encodes the one-time pairing
secret, DTLS fingerprint pin, exact millisecond expiry, ICE policy, and an
optional non-default signaling endpoint. The room is a domain-separated
SHA-256 projection of the secret, so it consumes no link bytes and the blind
signaling service still cannot redeem the invite. The hosted-default URL is 109
characters and contains no `&`, `?`, `=`, or `+`, so it can be passed to
`vibestudio open` without shell quoting.

This root-bootstrap invite is one-time and expiring, but server ownership is
continuous: until a first device claims the root account, the hub replaces an
expired invite and atomically updates its ready payload. Foreground `remote
serve` prints each replacement. A managed service keeps the secret out of its
journal; use `vibestudio remote deploy pairing <target>` to display the current
protected link and QR. Service logs are diagnostic output, not a pairing
interface.

Single use is replay protection, not an arbitrary timeout: the URL is a bearer
secret, so a copy must not remain able to add devices after its intended device
has paired. Desktop pairing therefore preflights OS-backed encrypted credential
storage before redemption. A preflight error explicitly says **the pairing link
was not used** and may be retried. A server rejection explicitly says the link
was already used or expired and directs the user to request a fresh invite.
If credential persistence fails after acceptance despite the preflight, the
desktop says that the link is now used instead of suggesting a retry that cannot
succeed.

The hub control ingress presents a persistent DTLS identity at:

```text
$HOME/.config/vibestudio/server-auth/webrtc/identity.pem
```

Workspace child answerers use:

```text
$HOME/.config/vibestudio/workspaces/<workspace>/reach/webrtc/identity.pem
```

Override a child identity with `VIBESTUDIO_WEBRTC_IDENTITY` only for explicit
local setups. The certificate SHA-256 is the `fp` in each reach; clients pin it
and fail closed on mismatch.

Back up the hub control identity with the identity database. In-place hub
identity rotation is intentionally unsupported: it is account/device trust, not
a disposable reach cache. Restore its exact backup if damaged. A workspace
child identity may be rotated explicitly with
`remote repair-identity --workspace <name> --yes`; paired devices then obtain a
fresh child reach through the unchanged hub control connection.

Force a TURN-only pass when validating production NAT traversal:

```bash
VIBESTUDIO_WEBRTC_ICE=relay vibestudio remote serve --port 3030
```

For the managed local-or-SSH systemd lifecycle:

```bash
vibestudio remote deploy local
vibestudio remote deploy pairing local
vibestudio remote deploy logs local
vibestudio remote deploy user@host --port 3030 --signal-url wss://signal.vibestudio.app/
vibestudio remote deploy pairing user@host
vibestudio remote deploy logs user@host
vibestudio remote deploy update user@host --artifact ./vibestudio-server.tgz
vibestudio remote deploy remove user@host --purge
```

Deploy writes the systemd unit with an absolute `ExecStart` (resolved via
`command -v vibestudio` on the host), waits for both the loopback hub and routed
default-workspace health endpoints plus the protected managed ready file, then
diagnoses both the hub and workspace reaches.
The hub independently owns and renews the root invite described above. On
`update`, deployment restarts the unit so the new build takes over. `remove
--purge` also uninstalls the npm package and deletes workspace-child reaches. It
preserves the hub control identity, accounts, and paired devices; after
reinstall, clients re-route workspaces through their existing control
connection.

## Pair A Client

Open or scan the printed `https://vibestudio.app/p#...` URL from desktop,
mobile, or CLI. The URL reaches a one-time room on the hub control ingress. Its
redemption atomically promotes that room to the new device's durable control
room and returns:

- one durable, user-bound device credential;
- the exact `PairingContext.workspaceId` selected by the invite; and
- the already-known hub reach from the invite, minus its one-time code.

The client immediately calls `hubControl.routeWorkspace({ workspaceId })` over
that same hub connection. The route returns only the workspace child's
`workspaceReach`; it never replaces the hub control reach. Clients persist the
device credential, stable control reach, selected workspace ID, and current
workspace reach. Switching workspaces routes another exact ID over the stable
control pipe and replaces only the workspace reach.

There is no child-side pairing activation, proposed credential, inferred
current workspace, or compatibility path for older stored transport shapes.

## OAuth And Webhooks

OAuth redirect URIs should use the apex Worker:

```text
https://vibestudio.app/oauth/callback/<transactionId>
```

Remote OAuth/webhooks use this apex by default. Override the origin only for a
local or staging relay deployment:

```bash
export VIBESTUDIO_RELAY_URL=https://relay.staging.example
```

Each workspace authenticates with its persistent P-256 identity; there is no
shared relay credential to configure or distribute.

Relay webhook subscriptions default to their 1,500,000-byte transport ceiling
and may choose a smaller budget. Direct subscriptions default to the home
server's configured ceiling and may choose a smaller explicit `maxBodyBytes`.
An omitted limit is stored as a transport-default policy, so changing the host
ceiling updates existing direct subscriptions without changing their ids or
public URLs. Explicit subscription limits remain fixed caps; if the host ceiling
is lowered beneath one, the lower host ceiling applies without disabling the
subscription:

```bash
export VIBESTUDIO_WEBHOOK_DIRECT_MAX_BODY_BYTES=16777216
```

The direct ceiling defaults to 16 MiB and must be between 1,500,000 and 64 MiB.
Invalid configuration fails server initialization instead of silently removing
the limit. The hard bound reflects the current delivery contract: an event
retains both the raw body and `rawBodyBase64`, before any parsed payload. Raising
the ceiling therefore raises per-delivery memory pressure by more than the body
size itself.

The relay does not have a per-server upstream URL. Each home server opens an
authenticated outbound `/backhaul` WebSocket and claims its own subscription ids.

## Local Rehearsal

Everything can still run against Cloudflare's local runtime:

```bash
pnpm rebuild node-datachannel
pnpm test:webrtc-e2e
pnpm test:cli-remote-smoke -- --local-signaling
xvfb-run -a pnpm test:desktop-pairing-smoke -- --local-signaling
```

`pnpm test:webrtc-e2e` spawns `wrangler dev apps/signaling`, a real answerer,
and a client. It covers protocol-v3 negotiation, the control/interactive/bulk
lanes, connect, RPC, streaming, and the pairing-to-device-credential lifecycle.
The CLI and desktop smokes then validate the actual user-facing clients over
the same local signaling contract; omit `--local-signaling` to exercise the
deployed signaling service instead.
