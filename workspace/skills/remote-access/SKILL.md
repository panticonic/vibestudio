---
name: remote-access
description: Deploy, diagnose, repair, and pair Vibestudio remote servers over WebRTC.
---

# Remote Access

Use this when working on remote server reachability, pairing, or phone/desktop
connectivity.

## Commands

- `vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <url>] [--port 3030]`
- `vibestudio remote deploy status|logs|update|remove <user@host>`
- `vibestudio remote doctor [--signal-url <url>] [--workspace <name> | --identity <identity.pem>]`
- `vibestudio remote repair-identity --yes [--workspace <name> | --identity <identity.pem>]`
- `vibestudio remote serve [--signal-url <url>] [--dev --auto-approve]`
- `vibestudio remote pair "https://vibestudio.app/pair#..."`
- `vibestudio remote invite-user --handle <handle> --workspace <name> [--workspace <name>...]`
- `vibestudio remote pair-device [--workspace <name>]`
- `vibestudio remote add-member|remove-member --workspace <name> --handle <handle>`
- `vibestudio remote list-users --workspace <name>`
- `vibestudio remote list-devices` / `revoke-device <device-id>`

## Multi-User Model

- The server is a **hub** hosting several workspaces and users. Identity
  (users, devices, memberships, roles) is one hub-owned SQLite DB at
  `~/.config/vibestudio/server-auth/identity.db`; workspace children read it
  read-only.
- **Root bootstrap:** on a fresh server the startup pairing code is the root
  invite — the first device to redeem it becomes the `root` user. Everyone
  else joins by invite.
- **Invite a user** (root/admin): `hubControl.inviteUser` mints a pairing link bound
  to the new user (handle, optional role/workspaces); their first device
  redeems it and is issued as them.
- **Pair your own device** (any member): `hubControl.pairDevice` mints a link bound
  to your own account — phone, laptop, and terminal become devices of one user.
- **Membership** (root/admin): `hubControl.addWorkspaceMember`/
  `removeWorkspaceMember`/`listWorkspaceMembers`. A non-member is refused at the workspace boundary (`EACCES`),
  omitted from `hubControl.listWorkspaces`, and never spawns a child. Inside a workspace,
  members are mutually trusted peers.
- **Each workspace child keeps its own WebRTC ingress + DTLS identity** — the
  hub directs devices (identity/pairing/routing-signaling) but never relays
  media. Internal control tokens are never human credentials.

## Current Contract

- Signaling resolves as `--signal-url` > `VIBESTUDIO_WEBRTC_SIGNAL_URL` > hosted default
  (`wss://signal.vibestudio.app`).
- Pairing links are complete: scheme link plus HTTPS pair URL. Do not mint or
  accept hub-level bare-code invites.
- The server identity is one combined `identity.pem`; no split-file identity
  layout is recognized.
- Desktop credentials live in one encrypted `device-credentials.json` store.
- Mobile bundle delivery uses `rn-host-2`: JS fetches over the active WebRTC
  pipe and native only appends chunks, finalizes integrity, and activates.

## Golden Paths

- Fresh host: `vibestudio remote deploy user@host --artifact <pkg.tgz>` installs
  the exact CLI/server version, writes config, installs the systemd user unit,
  starts it, mints an HTTPS pair URL/QR, and doctors the selected workspace
  child identity at
  `$HOME/.config/vibestudio/workspaces/<workspace>/state/webrtc/identity.pem`.
- Existing host invite: pair one root device from the service's startup link,
  then mint every later user/device invite from that authenticated device.
- Desktop to phone: open the shell Devices surface, choose Connect a device, and
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
and the fresh hub's root-device invite by default. Android attempts normal ICE;
use `--require-turn` for a relay-readiness pass or
`pnpm smoke:full -- --local-signaling` for an offline Miniflare/coturn run.
