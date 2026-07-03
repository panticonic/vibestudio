# vibez1 CLI

`vibez1` is the unified terminal entrypoint for remote server and mobile setup.

## Development

For ongoing source checkout work, use the live TypeScript entrypoint:

```sh
pnpm install
pnpm cli --help
pnpm cli remote serve --port 3030
pnpm cli mobile install --launch
```

`pnpm cli ...` runs `src/cli/client.ts` through `tsx`, so CLI source changes are
picked up without rebuilding or relinking. It also sets
`VIBEZ1_SERVER_ENTRY=live`, so pairing and mobile-dev commands start the
standalone server from `src/server/index.ts`.

```sh
pnpm server:live --help
```

Electron local mode still uses the bundled `dist/server-electron.cjs`; rebuild
after Electron or local-child-server changes.

## Install

For a stable command on your PATH, install from npm:

```sh
npm install -g @vibez1/app        # GUI + the `vibez1` CLI dispatcher
# headless server box (CLI + daemon, no Electron):
npm install -g @vibez1/server
```

`@vibez1/app` provides `vibez1` (bare invocation launches the GUI; subcommands
run the CLI) and `vibez1-server`. `@vibez1/server` provides `vibez1-server`
plus the `vibez1` CLI for pairing/remote management on a headless box. Update
with `@latest`.

From a source checkout, run the built CLI directly without a global install:

```sh
node dist/cli/client.mjs --help     # or: pnpm cli --help
```

## Remote

Start a phone/laptop pairing server:

```sh
vibez1 remote serve --port 3030
# or, during source development:
pnpm cli remote serve --port 3030
```

Pair this terminal, choose a workspace, start the terminal app, and mint new invites:

```sh
vibez1 remote pair "vibez1://connect?room=...&fp=...&code=...&sig=...&v=2"
vibez1 remote workspaces
vibez1 remote select dev
vibez1 terminal start --pair "vibez1://connect?room=...&fp=...&code=...&sig=...&v=2"
vibez1 terminal start
vibez1 remote invite
vibez1 remote status
vibez1 remote logout
```

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all choose a workspace, ask the server to launch their selected
host target, and show the same privileged workspace-unit approval before
running workspace code.

Desktop pairing and workspace selection happen in the desktop bootstrap UI.
`terminal start` runs fully in the CLI; use `--yes` only for automation that
should approve each startup request once.

Credentials are stored in `~/.config/vibez1/cli-credentials.json` with file
mode `0600`. The CLI does not use a system keyring.

## Mobile

Build/install the trusted internal Android APK:

```sh
vibez1 mobile build
vibez1 mobile install --launch
# or:
pnpm cli mobile install --launch
```

Start the phone pairing server (pairing is over WebRTC — no Tailscale/HTTPS setup):

```sh
export VIBEZ1_WEBRTC_SIGNAL_URL=wss://vibez1-signaling.<account>.workers.dev
vibez1 mobile pair --port 3030
```

Run the local Android dev loop:

```sh
vibez1 mobile dev
vibez1 mobile logs
```

Run a clean installed-app pairing smoke against an emulator or attached device:

```sh
vibez1 mobile smoke
vibez1 mobile smoke --avd Pixel_8
```

Useful flags:

- `--device <adb-serial>` targets a specific Android device.
- `--port <port>` chooses the local pairing server port.
- `--signal-url <url>` chooses the WebRTC signaling endpoint; otherwise
  `VIBEZ1_WEBRTC_SIGNAL_URL` is required.
- `--dev` on `vibez1 mobile pair` offers a disposable template workspace named
  `dev` after pairing.

Remote reach is WebRTC (pair by QR - signaling room + DTLS fingerprint); see
[webrtc-rpc-transport.md](./webrtc-rpc-transport.md) and [webrtc-local-e2e.md](./webrtc-local-e2e.md).
