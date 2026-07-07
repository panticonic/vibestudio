# WebRTC RPC — local end-to-end test setup

A complete local harness for the WebRTC transport: the **signaling Durable Object
runs on Cloudflare's local runtime** (`wrangler dev`/Miniflare), the server runs
as a **real WebRTC answerer**, and a client dials it over a real
`node-datachannel` DTLS pipe — no public endpoint, no deployment.

## TL;DR — run the automated e2e

```bash
pnpm rebuild node-datachannel   # one-time: build the native N-API binary
pnpm test:webrtc-e2e            # VIBESTUDIO_RUN_WEBRTC_E2E=1 vitest run tests/webrtc-*.e2e.test.ts
```

Two suites run (both against the v2 stack — hello preamble `proto=2`, ingress
pool, per-invite rooms, the shared `createPairedConnection` bootstrap):

- **`tests/webrtc-native.e2e.test.ts`** — two real `node-datachannel` peers over
  in-process signaling: real DTLS connect, the fingerprint pin (accept on match,
  **fail-closed on mismatch**), the internally-negotiated hello, session
  handshake, RPC round-trip, a bulk stream decoded by the client
  (`writeBulkFrame` → stream body), a pipe-level bulk round-trip
  (`sendBulkFrame` → `onBulkFrame`, chunked under the negotiated size), and the
  §9.8 `candidateType` surface on both ends.
- **`tests/webrtc-system.e2e.test.ts`** — the whole system, booted the way
  `src/server/index.ts` boots it: it spawns `wrangler dev apps/signaling` (the
  real signaling DO under Miniflare), starts the **WebRTC ingress pool**
  (`startWebRtcIngress`) over the real `RpcServer`, mints invites with
  **per-invite rooms** (`mintPairingInvite` → real `vibestudio://connect` v=2 deep
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

| Piece | Where |
| --- | --- |
| Signaling DO + `wrangler dev` | `apps/signaling/` (Miniflare-local) |
| Signaling client | `@vibestudio/rpc/transports/webrtcSignalingClient` (`ws` in Node; `role` required) |
| Native peer adapter | `src/main/webrtc/nodeDatachannelPeer.ts` (lazy-loads `node-datachannel`) |
| Persistent DTLS cert | `src/main/webrtc/cert.ts` (`ensurePersistentCert` → stable QR `fp`) |
| Client transport | `@vibestudio/rpc/transports/webrtcClient` |
| Shared client bootstrap | `@vibestudio/rpc/transports/pairedConnection` (`createPairedConnection` — desktop/mobile) |
| Server answerer pipe | `@vibestudio/rpc/transports/webrtcAnswerer` |
| Server attach | `RpcServer.attachWebRtcPipe` + `src/server/webrtcSessionShim.ts` |
| Server ingress pool | `src/server/webrtcIngress.ts` (`startWebRtcIngress`, wired env-gated in `index.ts`) |
| Per-invite rooms | `src/server/services/auth/model.ts` (`mintPairingInvite` → room + deep link) |

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
#      Pair URL:     https://vibestudio.app/pair#room=…&fp=…&code=…&sig=…&v=2&ice=all
#   and the pool logs:  [webrtc-ingress] armed room <uuid> (invite)
```

The server mints two startup invites (banner + ready file; disable with
`VIBESTUDIO_DISABLE_STARTUP_PAIRING=1`); further invites come from
`auth.createPairingInvite`. Each invite arms a fresh signaling room on the
pool; redemption persists the room onto the device record, so returning
devices reconnect into their own room after a restart.

Optional env: `VIBESTUDIO_WEBRTC_IDENTITY` (combined identity path, default
`<appRoot>/.vibestudio/webrtc/identity.pem`), `VIBESTUDIO_WEBRTC_ICE=relay` (force
TURN). The server presents the persistent identity cert; its SHA-256 is the published `fp`.

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

The wrapper builds like `pnpm dev`, starts `wrangler dev apps/signaling`, starts a
local workspace server as the WebRTC answerer, then launches Electron with the
fresh `vibestudio://connect` link. It passes `--skip-remote-pairing` so saved remote
credentials cannot steal the launch, and disables persistence for the fresh dev
pairing so the next normal `pnpm dev` remains local.

## Notes

- **The CLI uses the same paired bootstrap.** `vibestudio remote pair
  "vibestudio://connect?…"` dials the room with `createPairedConnection`, stores the
  device refresh credential plus `room`/`fp`/`sig`, and later RPC calls present
  `refresh:<deviceId>:<refreshToken>` over the pipe.

- **TURN** is optional for local/loopback (host candidates suffice). For symmetric
  NAT, set `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets on the signaling worker.
- **Pairing bootstrap.** Pairing completes OVER THE PIPE: the first session
  presents the invite `code` as its token, the server redeems it and returns the
  durable device credential on the auth-result (`onPaired`); reconnects present
  `refresh:<deviceId>:<refreshToken>`. The system e2e exercises exactly this.
- **Two real adapter bugs were caught only by real-native testing** (not the fake
  fabric): `node-datachannel`'s `remoteFingerprint()` returns `{value, algorithm}`
  (not a string), and the data channels open just *after* ICE `connected` — so
  `connect()` now gates on the channels being `open`, not just ICE state.
