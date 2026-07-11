# vibestudio CLI

`vibestudio` is the unified terminal entrypoint for remote server and mobile setup.

## Development

For ongoing source checkout work, use the live TypeScript entrypoint:

```sh
pnpm bootstrap
pnpm cli --help
pnpm cli remote serve --port 3030
pnpm cli mobile install --launch
```

`pnpm cli ...` runs `src/cli/client.ts` through `tsx`, so CLI source changes are
picked up without rebuilding or relinking. It also sets
`VIBESTUDIO_SERVER_ENTRY=live`, so pairing and mobile-dev commands start the
standalone server from `src/server/index.ts`.

```sh
pnpm server:live --help
```

Electron local mode owns one detached **hub** through
`src/main/hubProcessManager.ts`. The desktop pairs once as a machine-global
device, asks the hub to route its selected workspace, and then connects to that
workspace child through the hub gateway. Workspace selection never creates a
second desktop-owned server or a workspace-scoped device credential.

## Install

For a stable command on your PATH, install from npm:

```sh
npm install -g @panticonic/vibestudio        # GUI + the `vibestudio` CLI dispatcher
# headless server box (CLI + daemon, no Electron):
npm install -g @panticonic/vibestudio-server
```

`@panticonic/vibestudio` provides `vibestudio` (bare invocation launches the GUI;
subcommands run the CLI) and `vibestudio-server`. `@panticonic/vibestudio-server`
provides `vibestudio-server` plus the `vibestudio` CLI for pairing/remote
management on a headless box. Update with `@latest`.

From a source checkout, run the built CLI directly without a global install:

```sh
node dist/cli/client.mjs --help     # or: pnpm cli --help
```

## Remote Pairing

Start a phone/laptop pairing server:

```sh
vibestudio remote serve --port 3030
# or, during source development:
pnpm cli remote serve --port 3030
```

Pair this terminal, choose a workspace, start the terminal app, and manage
accounts and devices:

```sh
vibestudio remote pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2&ice=all"
vibestudio remote workspaces
vibestudio remote select dev
vibestudio terminal start --pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2&ice=all"
vibestudio terminal start
vibestudio remote pair-device
vibestudio remote invite-user --handle mara --workspace dev
vibestudio remote list-devices
vibestudio remote status
vibestudio remote logout
```

Every human-facing management command requires a paired device credential and
uses the typed `hubControl` service. There is no URL/code pairing mode, local
admin-token invite mode, generic admin RPC command, or child-scoped credential.
Use `invite-user` for a new account and `pair-device` for another device owned
by the current account.

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all choose a workspace, ask the server to launch their selected
host target, and show the same privileged workspace-unit approval before
running workspace code.

Desktop pairing and workspace selection happen in the desktop bootstrap UI.
`terminal start` runs fully in the CLI; use `--yes` only for automation that
should approve each startup request once.

CLI credentials are stored in `~/.config/vibestudio/cli-credentials.json` with
file mode `0600`. Only schema version 3 is accepted. It contains one global
device credential, a stable control reach, and the selected workspace reach;
both reaches use exact `room`/`fp`/`sig`/`v`/`ice` coordinates and never persist
the one-time pairing code.

## Users & membership (multi-user)

The server is multi-user: identity (users, devices, memberships, roles) lives
in the hub-owned `server-auth/identity.db`, and the hub exposes the management
surface as hub RPC methods. On a fresh server the **startup pairing code is the
root invite** — the first device to redeem it bootstraps the `root` user.

The management verbs, and the hub RPC each dispatches to:

| Command                                                                                             | Hub RPC                                                   | Gate                       |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| `invite-user` — create a user (handle, optional role/workspaces) and mint a user-bound pairing link | `hubControl.inviteUser`                                   | root/admin                 |
| `pair-device` — mint a pairing link bound to **your own** account                                   | `hubControl.pairDevice`                                   | any member                 |
| `add-member` / `remove-member`                                                                      | `hubControl.addWorkspaceMember` / `removeWorkspaceMember` | root/admin                 |
| `list-users`                                                                                        | `hubControl.listWorkspaceMembers`                         | workspace member           |
| `list-devices` / `revoke-device`                                                                    | `hubControl.listDevices` / `revokeDevice`                 | authenticated role gate    |
| `workspaces`                                                                                        | `hubControl.listWorkspaces`                               | any member (root sees all) |
| `select`                                                                                            | `hubControl.routeWorkspace`                               | member of that workspace   |

Examples (a paired admin device; `vibestudio remote workspaces` / `select`
are the workspace list/route surface):

```sh
vibestudio remote invite-user --handle mara --workspace dev   # mints mara's pairing code
vibestudio remote pair-device                                  # pair another of YOUR devices
vibestudio remote add-member --handle mara --workspace notes
vibestudio remote list-users --workspace dev
vibestudio remote workspaces      # only workspaces you are a member of
vibestudio remote select dev      # membership-gated entry
```

Notes:

- Roles are `root` (exactly one, cannot be demoted or deleted), `admin`, and
  `member`. Roles gate only these host-admin operations; routine approvals and
  everything inside a workspace stay open to every member.
- The role is resolved **live** from the identity DB at each gated call — a
  demotion takes effect immediately, without reconnecting.
- Non-members are refused at the workspace boundary (`EACCES`); the hub also
  omits non-member workspaces from listings and never spawns a child for them.
- Internal hub-to-child control tokens are never accepted as a human identity
  or exposed by the CLI.

## Remote Deploy

Deploy or manage a remote server over SSH/systemd:

```sh
vibestudio remote deploy user@host --port 3030 --signal-url wss://signaling.example.workers.dev
vibestudio remote deploy status user@host
vibestudio remote deploy logs user@host
vibestudio remote deploy update user@host --artifact ./vibestudio-server.tgz
vibestudio remote deploy remove user@host
vibestudio remote doctor
vibestudio remote repair-identity --workspace default --yes
```

Deploy installs a `systemd --user` unit, enables linger, and starts
`vibestudio remote serve` bound to loopback. The service journal contains the
fresh root pairing link; after pairing, all later invites come from a paired
root/admin device. `remote doctor` checks the signaling endpoint and a selected
workspace child's managed WebRTC identity (the `default` workspace unless
`--workspace` or `--identity` is supplied).

`remote serve`, `mobile pair`, and server startup resolve signaling as:
flag > `VIBESTUDIO_WEBRTC_SIGNAL_URL` > hosted default
(`wss://signal.vibestudio.app`).

## Agent

The agent CLI can attach durable sessions, call server RPC methods, inspect
services, read logs/diagnostics, and use workspace skills:

```sh
vibestudio agent attach [NAME]
vibestudio agent status [NAME]
vibestudio agent call SERVICE.METHOD '[]'
vibestudio agent services [NAME]
vibestudio agent logs UNIT
vibestudio agent diag UNIT
```

## Mobile

Install the checksum-verified Android prebuilt shell, or build the internal
contributor shell locally from source:

```sh
vibestudio mobile install --launch
vibestudio mobile install --from-source --launch
vibestudio mobile install --platform ios --simulator --launch
```

Start the phone pairing server (pairing is over WebRTC — no Tailscale/HTTPS setup):

```sh
vibestudio mobile pair --port 3030
```

Run the local mobile dev loop:

```sh
vibestudio mobile dev --platform android
vibestudio mobile dev --platform ios
vibestudio mobile logs --platform android
vibestudio mobile logs --platform ios
vibestudio mobile doctor
```

Run a clean installed-app pairing smoke against an emulator or attached device:

```sh
vibestudio mobile smoke
vibestudio mobile smoke --avd Pixel_8
```

Useful flags:

- `--device <adb-serial>` targets a specific Android device.
- `--platform android|ios` selects the mobile target. iOS requires macOS + Xcode.
- `--port <port>` chooses the local pairing server port.
- `--signal-url <url>` chooses the WebRTC signaling endpoint; otherwise the hosted default is used.
- `--dev` on `vibestudio mobile pair` offers a disposable template workspace named
  `dev` after pairing.

Remote reach is WebRTC (pair by QR: signaling room + DTLS fingerprint); see
[webrtc-rpc-transport.md](./webrtc-rpc-transport.md) and [webrtc-local-e2e.md](./webrtc-local-e2e.md).

## Git Upstream

The CLI exposes Git upstream workflows through `vibestudio vcs git ...`:
`status`, `remote:set`, `enable`, `push`, `pull`, `publish`, `import`,
`auto`, and `disable`. These commands dispatch to the host-known `gitInterop`
service. Operations that need the Git upstream engine are fulfilled by the
workspace manifest's configured `providers.gitInterop` extension rather than a
host-hardcoded workspace package.

Use `git.setSharedRemote()` and `git.configureUpstream()` from
`@workspace/runtime` to declare a remote and opt a workspace repo into upstream
tracking. Provider helpers such as the GitHub skill can then publish through the
configured Git interop provider.

See [git-upstream.md](./git-upstream.md) for the two-layer model, approvals,
`git.upstreams` config, and divergence repair workflow.
