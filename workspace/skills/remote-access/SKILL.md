---
name: remote-access
description: Deploy, diagnose, repair, and pair Vibestudio remote servers over WebRTC.
---

# Remote Access

Use this when working on remote server reachability, pairing, or phone/desktop
connectivity.

## Commands

- `vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <url>] [--port 3030] [--workspace default]`
- `vibestudio remote deploy status|logs|update|remove <user@host>`
- `vibestudio remote doctor [--signal-url <url>] [--identity <identity.pem>]`
- `vibestudio remote repair-identity --yes [--identity <identity.pem>]`
- `vibestudio remote setup-signaling [--url <wss-url>]`
- `vibestudio remote serve [--signal-url <url>]`
- `vibestudio remote invite [--workspace <name>] [--port 3030] [--url <url>] [--admin-token <token>]`
- `vibestudio remote pair "https://vibestudio.app/pair#..."`

## Current Contract

- Signaling resolves as flag > env > config > hosted default
  (`wss://signal.vibestudio.app`).
- Pairing links are complete: scheme link plus HTTPS pair URL. Do not mint or
  accept hub-level bare-code invites.
- The server identity is one combined `identity.pem`. Legacy
  `server.pem`/`server.key` remnants are an error, not a migration input.
- Desktop credentials live in one encrypted `device-credentials.json` store.
- Mobile bundle delivery uses `rn-host-2`: JS fetches over the active WebRTC
  pipe and native only appends chunks, finalizes integrity, and activates.

## Golden Paths

- Fresh host: `vibestudio remote deploy user@host --artifact <pkg.tgz>` installs
  the exact CLI/server version, writes config, installs the systemd user unit,
  starts it, mints an HTTPS pair URL/QR, and doctors the selected workspace
  child identity at
  `$HOME/.config/vibestudio/workspaces/<workspace>/state/webrtc/identity.pem`.
- Existing host invite: `ssh user@host vibestudio remote invite` should work
  even when the remote box has no stored CLI credentials; it mints through the
  local loopback admin route first.
- Desktop to phone: open the shell Devices surface, choose Connect a phone, and
  scan the HTTPS QR. The phone connects directly to the desktop's current
  server over WebRTC.

## Doctor Ladder

- node-datachannel missing: rebuild native deps with `pnpm rebuild
  node-datachannel` or reinstall the published package on the remote box.
- signaling unreachable: check `remote doctor --signal-url <url>`, the hosted
  endpoint, or self-hosted Worker deployment.
- identity anomaly: run `vibestudio remote repair-identity --identity
  <identity.pem>`; regenerating forces all devices to re-pair.
- linger denied: run the exact `sudo loginctl enable-linger <user>` command the
  deploy output prints, then rerun deploy.
- unit down: use `vibestudio remote deploy logs <user@host>` or
  `journalctl --user -u vibestudio-server -f`.
- TURN/relay failure: verify the signaling Worker vends TURN credentials before
  using relay-only invites.

## Verification

```bash
pnpm test:desktop-pairing-smoke
pnpm smoke:full
```

`pnpm smoke:full` is the composition check: branded Electron pairing, desktop
Playwright e2e, and Android emulator/mobile pairing with OTA activation. The
pairing phases use the deployed signaling service, normal `remote serve` hub,
and a workspace-scoped `remote invite` by default. Android attempts normal ICE;
use `--require-turn` for a relay-readiness pass or
`pnpm smoke:full -- --local-signaling` for an offline Miniflare/coturn run.
