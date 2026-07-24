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
- `vibestudio remote repair-identity --workspace <name> --yes` rotates only
  that child's reach. Hub control identity rotation is intentionally
  unsupported.
- `vibestudio remote serve [--signal-url <url>] [--dev]`
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
- **Keep one stable hub control ingress per device.** Pairing invite rooms and
  durable device control rooms terminate at the hub. A fresh pairing returns
  the device credential plus its exact one-time `PairingContext.workspaceId`.
- **Route a workspace by exact ID.** Call
  `hubControl.routeWorkspace({ workspaceId })`; retain the existing control
  reach and replace only the returned `workspaceReach`.
- **Keep children workspace-only.** Each workspace child owns its own WebRTC
  ingress, persistent DTLS identity, and device/user rooms for workspace RPC.
  It never redeems invites, activates proposed credentials, or relays hub
  control. The hub routes but never relays workspace media. Internal control
  tokens are never human credentials.

## Current Contract

- Signaling resolves as `--signal-url` > `VIBESTUDIO_WEBRTC_SIGNAL_URL` > hosted default
  (`wss://signal.vibestudio.app`).
- Pairing links are complete: scheme link plus HTTPS pair URL. Do not mint or
  accept hub-level bare-code invites.
- Keep each hub or child endpoint identity in one combined `identity.pem`; no
  split-file identity layout is recognized.
- Desktop credentials live in one encrypted `device-credentials.json` store.
  One record keeps the global device credential, the stable hub
  `controlPairing`, and the current child `workspacePairing`. Never derive one
  reach from the other or infer a workspace from its display name.
- Treat the invite room's atomic hub-side promotion as the only pairing commit.
  Do not add child activation journals, proposed device credentials,
  `controlReach` route fields, or legacy transport readers.
- Mobile bundle delivery uses `rn-host-2`: JS fetches over the active WebRTC
  pipe and native only appends chunks, finalizes integrity, and activates.

## Golden Paths

- Fresh host: `vibestudio remote deploy user@host --artifact <pkg.tgz>` installs
  the exact CLI/server version, writes config, installs the systemd user unit,
  starts it, mints an HTTPS pair URL/QR, and doctors the selected workspace
  child identity at
  `$HOME/.config/vibestudio/workspaces/<workspace>/reach/webrtc/identity.pem`.
  The hub control identity lives separately at
  `$HOME/.config/vibestudio/server-auth/webrtc/identity.pem`.
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
- identity anomaly: identify whether the failing endpoint is the hub control
  ingress or a workspace child before replacing anything. Restore a damaged hub
  control identity from its exact backup; do not mint a replacement. A child
  identity may be rotated explicitly with `repair-identity --workspace`; that
  invalidates only the saved workspace reach, so re-route the exact workspace
  through the still-valid hub control connection.
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
