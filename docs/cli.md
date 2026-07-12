# vibestudio CLI

`vibestudio` is the unified terminal entrypoint for remote server and mobile setup.
Run `vibestudio --help` for a grouped overview, `vibestudio <group> --help` for
commands in one area, and `vibestudio <group> <command> --help` for full flags.
Structured commands switch to JSON when stdout is piped; pass `--plain` to keep
their readable format (or `--json` explicitly). Long-running passthrough commands
such as `remote serve`, deployment, and mobile tooling document their own output flags.

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

Electron local mode spawns the bundled `dist/server-electron.cjs` as a **detached
workspace server** (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, see
`src/main/localServerManager.ts`); rebuild it after Electron or local-server
changes. The desktop shell is a paired device of that server — it attaches to a
healthy recorded server on launch and spawns a fresh one otherwise, so there is no
separate Electron⇄server IPC mode.

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

Pair this terminal, choose a workspace, start the terminal app, and mint new invites:

```sh
vibestudio remote pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2"
vibestudio remote workspaces
vibestudio remote select dev
vibestudio terminal start --pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2"
vibestudio terminal start
vibestudio remote invite
vibestudio remote status
vibestudio remote logout
```

`remote invite` has two modes:

- With a stored CLI credential, it asks the paired server to mint a workspace
  invite.
- On the server host, with no stored CLI credential, it uses the local admin
  token against `http://127.0.0.1:<port>`; use `--port`, `--workspace`,
  `--url`, or `--admin-token` when the defaults do not match the running server.

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all choose a workspace, ask the server to launch their selected
host target, and show the same privileged workspace-unit approval before
running workspace code.

Desktop pairing and workspace selection happen in the desktop bootstrap UI.
`terminal start` runs fully in the CLI; use `--yes` only for automation that
should approve each startup request once. It reports a heartbeat while the host
is preparing and stops after 10 minutes by default; override that deadline with
`--timeout 30s`, `--timeout 20m`, and similar durations.

CLI credentials and agent sessions are stored below
`${XDG_CONFIG_HOME:-~/.config}/vibestudio` with file mode `0600` for credential
and session files. The server's local admin token is stored separately in the
same configuration root.

## Remote Deploy

Deploy or manage a remote server over SSH/systemd:

```sh
vibestudio remote deploy user@host --port 3030 --workspace default --signal-url wss://signaling.example.workers.dev
vibestudio remote deploy status user@host
vibestudio remote deploy logs user@host
vibestudio remote deploy update user@host --artifact ./vibestudio-server.tgz
vibestudio remote deploy remove user@host [--purge]
vibestudio remote doctor
vibestudio remote repair-identity --workspace default --yes
```

Deploy installs a `systemd --user` unit, enables linger, and starts
`vibestudio remote serve` bound to loopback. The unit's `ExecStart` uses the
absolute path resolved from `command -v vibestudio` on the host (so it survives
nvm / user-prefix npm installs). Deploy then polls the loopback gateway
`/healthz` for hub readiness and waits for the managed `default` workspace
identity before running `remote doctor` over SSH. Pairing invites are minted by
the hub and routed to the selected workspace; deploy itself does not consume or
print an invite.

`update` reuses `deploy` and explicitly restarts the unit, so a new build
replaces the running old binary. `remove` disables and deletes the unit; add
`--purge` to also uninstall the `@panticonic/vibestudio-server` npm package and
delete the WebRTC identity material (every paired device must then re-pair).
Workspace source directories are always left intact.

`remote doctor` runs a checklist: the `node-datachannel` native addon, absence of
the deleted `VIBESTUDIO_WEBRTC_CERT`/`KEY` env vars, the `identity.pem` layout
(present, mode `0600`, cert+key), signaling reachability (a real `role=answerer`
room dial, not the endpoint root), and — when a deployed unit is present on the
host — the unit's active state and gateway port. Server-only checks are skipped,
not failed, when run as a client-side preflight.

`remote serve`, `mobile pair`, and server startup resolve signaling as:
flag > `VIBESTUDIO_WEBRTC_SIGNAL_URL` > hosted default
(`wss://signal.vibestudio.app`). Self-hosted signaling is deployed from
`apps/signaling`; there is no separate setup command that mutates the repo.

Production Cloudflare deploys are rooted in the repo scripts:

```sh
pnpm type-check:cloudflare
pnpm deploy:cloudflare
pnpm smoke:cloudflare
```

`signal.vibestudio.app` is owned by `apps/signaling`; `vibestudio.app` is owned by
`apps/webhook-relay` for `/pair`, `/panel`, `.well-known`, OAuth callbacks,
webhooks, and backhaul.

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

From a Vibestudio source checkout, run the local mobile dev loop:

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

Use `git.setSharedRemote()` and `git.setUpstream()` from
`@workspace/runtime` to declare a remote and opt a workspace repo into upstream
tracking. The runtime `git.*` methods use the same host `gitInterop.*` service as
the CLI, and that service dispatches transport work through the configured
`providers.gitInterop` extension. Runtime code does not invoke the extension by
package name. Provider helpers such as the GitHub skill can then publish through
the same routed API.

See [git-upstream.md](./git-upstream.md) for the two-layer model, approvals,
`git.upstreams` config, and divergence repair workflow.
