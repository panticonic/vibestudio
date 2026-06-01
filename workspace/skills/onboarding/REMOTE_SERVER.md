---
name: remote-server-onboarding
description: Connect a desktop or mobile NatStack client to a state server running elsewhere (home server, VPS, remote workstation).
---

# Connecting to a Remote NatStack Server

NatStack's state server (the piece that owns workspaces, the build system, agents, DOs, and secrets) can run on a different machine from the client UI. Typical setup: the server runs on a home server or VPS, and you connect from a desktop Electron app and/or the mobile app on your phone.

> **Single-user scope.** The current remote-server design assumes one user per server. Every connected client shares the same workspaces, OAuth tokens, and secrets.

## 1. Start the server somewhere reachable

On the host machine:

```
natstack-server --host my-home-server.local --bind-host 0.0.0.0 \
  --protocol https --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem \
  --serve-panels --print-credentials
```

Flags worth knowing:

- `--host` — the external hostname clients will connect to.
- `--bind-host 0.0.0.0` — listen on all interfaces (LAN access). Default is loopback.
- `--protocol https` + `--tls-cert` / `--tls-key` — strongly recommended for anything outside localhost. Self-signed certs are fine for home use; see §3.
- `--print-credentials` — prints machine-parseable `NATSTACK_ADMIN_TOKEN=...` and `NATSTACK_PAIRING_CODE=...` lines after startup, useful for scripting.

On first boot the server generates an admin token (if `NATSTACK_ADMIN_TOKEN` isn't set) and persists it at `~/.config/natstack/admin-token` (`0o600`). Treat that token as bootstrap/recovery material. Normal clients should connect with the printed `Pair URL` or pairing code, which creates a durable device credential without copying the admin token off the server.

The server prints its URL and `/healthz` is available for liveness checks (e.g., `curl https://my-home-server.local:3000/healthz`).

### Dogfood mode from a source checkout

When the remote server is meant to edit NatStack itself, start it with:

```
pnpm dev:self:server
```

This is a source-checkout workflow layered on top of normal pairing. It creates
a managed workspace with `projects/natstack`, routes userland pushes through
the NatStack Git gateway, mirrors accepted pushes back into the host checkout
only when the host is clean and fast-forwardable, then rebuilds and restarts the
server on the same gateway port for server-relevant changes.

Userland code can detect the mode by checking for `meta/dogfood.json` in the
workspace. See `docs/remote-server.md` for the JSON marker and recovery
behavior.

## 2. Point a client at it

### Desktop (Electron)

Recommended path:

1. Run `natstack remote serve` or `natstack-server --print-credentials` on the server.
2. Click the printed `Pair URL`, or open the connection badge → **Remote server** → **Pair with code** and paste the URL/code.
3. Save and relaunch. The app stores a durable device credential in the OS-protected credential store.

Once any desktop client is connected, open **Remote server** → **Paired devices** → **Pair another device** to mint a fresh pairing link for another laptop or phone without returning to the server terminal. A paired terminal can do the same with `natstack remote invite`.

Admin-token bootstrap remains available for recovery and automation. Launch once with:

```
NATSTACK_REMOTE_URL=https://my-home-server.local:3000 \
NATSTACK_REMOTE_TOKEN=<paste-the-admin-token> \
natstack
```

Once connected, open the connection badge in the title bar → **Remote server** dialog → enter the same details on the **Admin token** tab → **Save & relaunch**. The app encrypts the token via OS keychain (Keychain / DPAPI / libsecret) from then on; you won't need the env vars again.

**Buttons in the settings dialog:**

- **Test** — runs a `/healthz` probe and a throwaway auth attempt against the URL + token you entered. Surfaces invalid URL, unreachable server, TLS mismatch, or auth failure inline — no relaunch needed to discover a bad config.
- **Fetch from server** (next to the fingerprint field) — pulls the server's leaf-cert SHA-256 from the TLS handshake so you don't have to run `openssl` by hand. Paired with the trust-on-first-use prompt: if you hit **Save & relaunch** against an `https://` URL without a stored fingerprint, the dialog shows the observed fingerprint and asks you to confirm before saving.
- **Pair another device** — only enabled while connected. Mints a fresh single-use pairing link through the active trusted device connection.
- **Rotate token** — only enabled while connected with a saved admin token. Mints a fresh admin token on the server, updates the local credential store, and relaunches with the new token. Old clients with the old token will fail to reconnect until updated.
- **Disconnect…** — destructive; wipes the credential store and relaunches into local mode. Requires a second click to confirm.

### Mobile

Use a `natstack://connect?...` pairing link from `natstack mobile pair`, `natstack remote serve`, or **Pair another device** in an already-connected desktop client. The native mobile host exchanges the code for a durable device credential stored via `react-native-keychain`.

## 3. Self-signed HTTPS

If the server uses a self-signed cert, the client needs one of:

- **CA path** — the client loads the server's cert as a trusted CA. Put the PEM somewhere on the client machine and pass the path in the settings dialog's "CA certificate path" field.
- **Fingerprint pinning** — copy the SHA-256 fingerprint (uppercase, colon-separated hex) from the server cert:
  ```
  openssl x509 -in cert.pem -noout -fingerprint -sha256
  ```
  Paste it into the dialog's "TLS fingerprint" field. The client bypasses normal CA validation and accepts the connection iff the leaf cert matches this hash.

Environment variable alternatives: `NATSTACK_REMOTE_CA`, `NATSTACK_REMOTE_FINGERPRINT`.

## 4. OAuth from a remote client

When you trigger an OAuth flow (e.g. connecting an AI provider) from a remotely-connected client, the flow opens through `externalOpen.openExternal` with the active callback URL attached as `expectedRedirectUri`. **The client that started the flow** receives the approved `external-open:open` event and opens that URL in its local browser — desktop uses `shell.openExternal`, mobile uses `Linking.openURL`. The server itself no longer needs a browser.

The OAuth callback redirects back to the server. For this to work your server's URL must be reachable from the internet (or you need a tunnel like Cloudflare Tunnel / Tailscale funnel). Set `--public-url` so the server builds the correct `redirect_uri`. See `docs/remote-server.md` for concrete proxy recipes.

## 5. Verifying the connection

From the client CLI or a terminal:

```
curl https://my-home-server.local:3000/healthz
# → {"ok":true,"protocol":"https"}
```

In the Electron app, the connection badge in the title bar indicates:

- **Hidden** — local mode, everything healthy.
- **Green globe with hostname** — connected to a remote server.
- **Amber "reconnecting"** — client lost the WS and is retrying.
- **Red "disconnected"** — all retries exhausted.

Clicking the badge opens the settings dialog.

## 6. What lives where

| On the server (host machine) | On the client |
|---|---|
| Workspaces (`~/.config/natstack/workspaces/`) | Encrypted remote credentials (`~/.config/natstack/remote-credentials.json`) |
| Credentials + consent state (`~/.config/natstack/credentials/`, `credentials-consent.sqlite`) | Theme / local UI preferences |
| Workspace/server config | Electron userData cache for remote mode (`~/.config/natstack/remote-state/`) |
| Durable Object state (`.databases/workerd-do/`) | |
| Agent/worker execution | |

Back up the server side; the client is disposable.

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `TLS fingerprint mismatch` on connect | Fingerprint in client settings no longer matches the cert — either the cert was regenerated or someone is MitM-ing. Re-copy the fingerprint from the server and save. |
| OAuth dialog never opens a browser | Check the badge: is the desktop/mobile client actually connected? The event only fires to subscribers. If the server has no connected clients, the OAuth URL is logged to the server's stdout instead. |
| "self-signed certificate" error | Pass a CA path or a fingerprint — see §3. |
| Admin token doesn't work | Did the server regenerate? `cat ~/.config/natstack/admin-token` on the host and compare. |
