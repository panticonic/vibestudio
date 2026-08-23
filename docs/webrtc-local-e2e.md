# WebRTC RPC — local end-to-end test setup

A complete local harness for the WebRTC transport: the **signaling Durable Object
runs on Cloudflare's local runtime** (`wrangler dev`/Miniflare), the server runs
as a **real WebRTC answerer**, and a client dials it over a real
`node-datachannel` DTLS pipe — no public endpoint, no deployment.

## TL;DR — run the automated coverage

```bash
pnpm rebuild node-datachannel   # one-time: build the native N-API binary
pnpm test:webrtc-e2e            # VIBESTUDIO_RUN_WEBRTC_E2E=1 vitest run tests/webrtc-*.e2e.test.ts
pnpm test:cli-remote-smoke      # packaged CLI pair + reconnect/status over hosted signaling
pnpm test:desktop-pairing-smoke # real Electron pair, shell, panel, and desktop-event flow
```

`test:webrtc-e2e` runs two suites against the v3 stack — hello preamble
`proto=3`, three negotiated traffic lanes, ingress
pool, per-invite rooms, the shared `createPairedConnection` bootstrap):

- **`tests/webrtc-native.e2e.test.ts`** — two real `node-datachannel` peers over
  in-process signaling: real DTLS connect, the fingerprint pin (accept on match,
  **fail-closed on mismatch**), the internally-negotiated hello, session
  handshake, RPC round-trip, an interactive response stream decoded by the
  client, a pipe-level bulk round-trip (`sendBulkFrame` → `onStreamFrame`,
  chunked under the negotiated size), control/interactive/bulk channel
  readiness, and the §9.8 `candidateType` surface on both ends.
- **`tests/webrtc-system.e2e.test.ts`** — the whole system, booted the way
  `src/server/index.ts` boots it: it spawns `wrangler dev apps/signaling` (the
  real signaling DO under Miniflare), starts the **WebRTC ingress pool**
  (`startWebRtcIngress`) over the real `RpcServer`, mints invites with
  **per-invite rooms** (`mintPairingInvite` → real `vibestudio://connect` v3 deep
  links), and dials each with `createPairedConnection` (the one shared client
  bootstrap). Scenarios: fresh-device pairing over the pipe (`code` →
  `createPairingRedeemer` → credential on the auth-result `onPaired`) + RPC
  dispatch; **one-shot code replay rejection**; **refresh-credential reconnect**
  (`refresh:<deviceId>:<refreshToken>`, no new credential); **two concurrent
  clients** on two invite rooms with independent sessions (neither evicts the
  other); and a **same-device reconnect on the SAME room** asserting
  deterministic takeover.

Both complete in a few seconds after `wrangler dev` boots (~3 s, Miniflare).
They also run nightly in CI (`.github/workflows/webrtc-e2e-nightly.yml`).

The two smoke commands exercise the user-facing binaries above that transport
contract:

- **`test:cli-remote-smoke`** starts an isolated real server, consumes its root
  invite through hosted signaling, pairs the CLI, reconnects with the issued
  device credential, and verifies workspace status.
- **`test:desktop-pairing-smoke`** starts an isolated real server and Electron
  client, consumes the root invite, approves the real startup gates, waits for
  the hosted shell and an actual panel surface, verifies the typed Settings
  event, and rejects renderer/main-process diagnostics. On Linux the harness
  uses an isolated D-Bus + libsecret keyring so credential persistence is both
  secure and independent of the developer's login keyring.

The desktop smoke needs a graphical display. In a headless Linux shell, run:

```bash
xvfb-run -a pnpm test:desktop-pairing-smoke
```

That headless route requires `xvfb-run`, `dbus-daemon`, and
`gnome-keyring-daemon`. The harness owns and deletes its server state, client
state, session bus, and keyring on both success and failure.

## The pieces

```
 wrangler dev apps/signaling  (SignalingRoom DO, Miniflare, ws://127.0.0.1:8798)
        ▲                                                ▲
  createSignalingClient (role=offerer)       createSignalingClient (role=answerer)
        │            real node-datachannel DTLS                 │
  createPairedConnection  ⇄══ DTLS + fingerprint pin ══⇄  startWebRtcIngress pool
   (createWebRtcTransport)                            (createWebRtcAnswererPipe ×N,
        │  main shell session (real handleAuth)        one per invite/device room)
        └──────────────── real RPC round-trip ─────────────────┘
```

| Piece                         | Where                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Signaling DO + `wrangler dev` | `apps/signaling/` (Miniflare-local)                                                       |
| Signaling client              | `@vibestudio/rpc/transports/webrtcSignalingClient` (`ws` in Node; `role` required)        |
| Native peer adapter           | `src/node/webrtc/nodeDatachannelPeer.ts` (lazy-loads `node-datachannel`)                  |
| Persistent DTLS cert          | `src/node/webrtc/cert.ts` (`ensurePersistentCert` → stable QR `fp`)                       |
| Client transport              | `@vibestudio/rpc/transports/webrtcClient`                                                 |
| Shared client bootstrap       | `@vibestudio/rpc/transports/pairedConnection` (`createPairedConnection` — desktop/mobile) |
| Server answerer pipe          | `@vibestudio/rpc/transports/webrtcAnswerer`                                               |
| Server attach                 | `RpcServer.attachWebRtcPipe` + `src/server/webrtcSessionShim.ts`                          |
| Server ingress pool           | `src/server/webrtcIngress.ts` (`startWebRtcIngress`, wired env-gated in `index.ts`)       |
| Per-invite rooms              | `src/server/hostCore/auth/model.ts` (`mintPairingInvite` → room + deep link)              |

## Running the REAL server as a WebRTC answerer

The WebRTC ingress pool is **off by default** (loopback co-located mode is
unchanged). Activate it by setting `VIBESTUDIO_WEBRTC_SIGNAL_URL` — rooms and
pairing codes are minted **per invite** by the server (there is no room or code
env var; the per-server singleton room is gone, plan §2.1):

```bash
# 1. local signaling (Cloudflare local runtime)
cd apps/signaling && wrangler dev --port 8787 --local &

# 2. the server, with the ingress pool armed
VIBESTUDIO_WEBRTC_SIGNAL_URL=ws://127.0.0.1:8787 pnpm server
# → startup banner prints fresh invites:
#      Pair URL:     https://vibestudio.app/p#<compact-payload>
#   and the pool logs:  [webrtc-ingress] armed room <uuid> (invite)
```

On first bootstrap the hub publishes exactly one live `rootInvite` at a time;
its deep link and HTTPS pair/QR URL are presentation carriers for that same
invitation fact. If it expires before redemption, the hub cancels that room,
arms a replacement, and atomically republishes the ready payload. Renewal stops
as soon as the first device creates the root account. Later device invites come
from `hubControl.pairDevice`. Every invite arms a fresh room on the stable hub
control ingress, and redemption atomically promotes that room to the issued
device's durable control reach. The client then routes the exact invited
workspace ID and receives only the child `workspaceReach`. After a restart,
returning devices keep their hub control reach and obtain fresh child reach
coordinates through exact workspace routing.

Optional env: `VIBESTUDIO_WEBRTC_ICE=relay` (force TURN). The isolated hub owns
the persistent control identity whose certificate SHA-256 is the root invite's
`fp`; each disposable workspace child owns a separate identity published only
in its routed workspace reach.

Observability (§9.8 relay alarm): every pipe connect logs
`[webrtc-ingress] room=… device=… path=<host|srflx|relay>` and WARNS when the
path is a TURN relay; the token-gated detailed `/healthz` response carries
`webrtc: { rooms, stats }` (per-room state + candidate type, plus
connect/relay counters).

## Running the desktop app through local WebRTC

For interactive desktop development, use the wrapper instead of wiring the three
processes by hand:

```bash
pnpm rebuild node-datachannel   # one-time, if needed
pnpm dev:webrtc
```

The wrapper builds like `pnpm dev`, starts `wrangler dev apps/signaling`, and
starts a clean hub under a disposable config home. The hub routes its default
workspace child as the WebRTC answerer and publishes a complete desktop root
invite in its ready file; the wrapper launches Electron with that
`vibestudio://connect` link. It passes `--skip-remote-pairing` so saved remote
credentials cannot steal the launch, and disables persistence for the fresh dev
pairing so the next normal `pnpm dev` remains local.

## Notes

- **The CLI uses the same paired bootstrap.** `vibestudio remote pair
`vibestudio://connect/<compact-payload>`dials the derived room with`createPairedConnection`, stores the
  global device refresh credential plus the selected child's `room`/`fp`/`sig`  reach, and later RPC calls present`refresh:<deviceId>:<refreshToken>` over the
  pipe. Workspace switches replace reach information, not identity.

- **TURN** is optional for local/loopback (host candidates suffice). For symmetric
  NAT, set `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets on the signaling worker.
- **Pairing bootstrap.** Pairing completes OVER THE PIPE: the first session
  presents the invite `code` as its token, the server redeems it and returns the
  durable device credential on the auth-result (`onPaired`); reconnects present
  `refresh:<deviceId>:<refreshToken>`. The system e2e exercises exactly this.
- **Two real adapter bugs were caught only by real-native testing** (not the fake
  fabric): `node-datachannel`'s `remoteFingerprint()` returns `{value, algorithm}`
  (not a string), and the data channels open just _after_ ICE `connected` — so
  `connect()` now gates on the channels being `open`, not just ICE state.
