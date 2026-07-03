---
name: remote-server-onboarding
description: Connect a desktop, mobile, or CLI Vibez1 client to a state server running elsewhere (home server, VPS, remote workstation) over WebRTC.
---

# Connecting to a Remote Vibez1 Server

Vibez1's state server (the piece that owns workspaces, the build system, agents, DOs, and secrets) can run on a different machine from the client UI. Typical setup: the server runs on a home server or VPS, and you connect from a desktop Electron app, the mobile app, or the CLI.

Remote reach is **WebRTC**: the client and server establish one peer-to-peer, DTLS-encrypted pipe and pair by QR. There is no public HTTPS endpoint, no TLS cert/CA/fingerprint files, no Tailscale, and no reverse proxy — the gateway binds loopback only and remote clients reach it through the encrypted pipe. See `docs/webrtc-rpc-transport.md` for the design and `docs/webrtc-local-e2e.md` for a runnable local harness.

> **Single-user scope.** The current design assumes one user per server. Every connected client shares the same workspaces, OAuth tokens, and secrets.

## 1. Start the server as a WebRTC answerer

The server needs a **signaling endpoint** (a tiny Cloudflare Worker/DO that brokers the WebRTC offer/answer — it never sees your data). The server mints the per-invite signaling room and pairing code itself; point it at signaling and it prints a pairing link:

```
VIBEZ1_WEBRTC_SIGNAL_URL=wss://signaling.example.workers.dev \
  vibez1-server --serve-panels --print-credentials
# → Pairing link: vibez1://connect?room=…&fp=…&code=…&sig=…&v=2
```

- The server presents a **persistent DTLS cert** (default `<appRoot>/.vibez1/webrtc/server.{pem,key}`, overridable with `VIBEZ1_WEBRTC_CERT`/`VIBEZ1_WEBRTC_KEY`). Its SHA-256 is the `fp` in the link — the client pins it (**fail-closed** on mismatch), so a malicious signaling server cannot MitM.
- `VIBEZ1_WEBRTC_ICE=relay` forces TURN (set the signaling worker's `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` secrets); host candidates suffice for LAN/loopback.
- For local development, run signaling on Cloudflare's local runtime (`cd apps/signaling && wrangler dev --local`) — see `docs/webrtc-local-e2e.md`.

### Dogfood mode from a source checkout

When the remote server is meant to edit Vibez1 itself, start it with `pnpm dev:self:server`. This layers a source-checkout workflow on top of pairing: a managed workspace with `projects/vibez1`, userland pushes routed through the Vibez1 Git gateway and mirrored back into the host checkout when clean and fast-forwardable, then rebuild/restart on the same gateway port. Userland detects the mode via `meta/dogfood.json`.

## 2. Pair a client

The pairing link / QR carries everything the client needs (`room`, `fp`, `code`, `sig`); scanning or opening it establishes the WebRTC pipe and mints a **durable device credential** — no admin token leaves the server.

- **CLI** — run `vibez1 remote pair "vibez1://connect?…"` to pair over WebRTC. The CLI stores the device credential plus `room`/`fp`/`sig` pairing material and uses the shared `createPairedConnection()` bootstrap for later RPC calls.
- **Desktop (Electron)** — open the `vibez1://connect?…` link (or scan the QR); the shell pairs over WebRTC and stores the device credential in the OS keychain. Once one client is connected, mint a fresh link for another device with `vibez1 remote invite`.
- **Mobile** — scan the QR or follow a `vibez1://connect?…` link from `vibez1 mobile pair` / **Pair another device**; the native host stores the credential via `react-native-keychain`.

The QR `code` is the one-time pairing secret; the `fp` is the pinned DTLS fingerprint.

## 3. OAuth from a remote client

When you trigger an OAuth flow from a remotely-connected client, the flow opens through `externalOpen.openExternal` and **the client that started it** opens the URL in its local browser (desktop `shell.openExternal`, mobile `Linking.openURL`). Provider redirect URIs that need a public HTTPS endpoint resolve through the **callback relay** (`VIBEZ1_RELAY_OAUTH_BASE_URL`, plan §7), which backhauls the callback to your loopback server over the pipe — no public server URL or tunnel required.

## 4. Verifying the connection

The Electron connection badge in the title bar indicates:

- **Hidden** — local (co-located) mode, everything healthy.
- **Green globe with hostname** — connected to a remote server over WebRTC.
- **Amber "reconnecting"** — the pipe dropped and the client is re-establishing (full ICE re-establish, not a socket retry).
- **Red "disconnected"** — recovery exhausted.

Clicking the badge opens the connection dialog.

## 5. What lives where

| On the server (host machine) | On the client |
|---|---|
| Workspaces (`~/.config/vibez1/workspaces/`) | Device credential (OS keychain) + pinned pairing (`room`/`fp`/`sig`) |
| Credentials + consent state (`~/.config/vibez1/credentials/`, `credentials-consent.sqlite`) | Theme / local UI preferences |
| Persistent WebRTC cert (`<appRoot>/.vibez1/webrtc/`) | Electron userData cache for remote mode |
| Durable Object state (`.databases/workerd-do/`) | |
| Agent/worker execution | |

Back up the server side; the client is disposable.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Pairing link never appears | The server couldn't reach signaling, or `node-datachannel` isn't built — run `pnpm rebuild node-datachannel` once on the server. |
| `fingerprint mismatch` on connect | The `fp` in the client's saved pairing no longer matches the server cert — the cert was regenerated (or someone is MitM-ing signaling). Re-pair from a fresh link. |
| Client connects then drops repeatedly | Symmetric NAT with no TURN — set `VIBEZ1_WEBRTC_ICE=relay` on the server and TURN secrets on the signaling worker. |
| OAuth dialog never opens a browser | Check the badge: is the client actually connected? The event only fires to subscribers. |
