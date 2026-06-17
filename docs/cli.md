# natstack CLI

`natstack` is the unified terminal entrypoint for remote server and mobile setup.

## Development

For ongoing source checkout work, use the live TypeScript entrypoint:

```sh
pnpm install
pnpm cli --help
pnpm cli remote serve --host tailscale --port 3030
pnpm cli mobile install --launch
```

`pnpm cli ...` runs `src/cli/client.ts` through `tsx`, so CLI source changes are
picked up without rebuilding or relinking. It also sets
`NATSTACK_SERVER_ENTRY=live`, so pairing and mobile-dev commands start the
standalone server from `src/server/index.ts`.

```sh
pnpm server:live --help
```

Electron local mode still uses the bundled `dist/server-electron.cjs`; rebuild
after Electron or local-child-server changes.

## Install

For a stable command on your PATH, build and link the package bin:

```sh
pnpm build
pnpm link --global
```

That installs `natstack` and `natstack-server` from `package.json`. The global
link continues to point at this checkout, but it runs built files from `dist/`;
re-run `pnpm build` after source changes.

If you do not want a global link, use the built file directly:

```sh
node dist/cli/client.mjs --help
```

## Remote

Start a phone/laptop pairing server:

```sh
natstack remote serve --host tailscale --port 3030
# or, during source development:
pnpm cli remote serve --host tailscale --port 3030
```

Pair this terminal, launch Electron, start the terminal app, and mint new invites:

```sh
natstack remote pair "natstack://connect?url=...&code=..."
natstack remote start --pair "natstack://connect?url=...&code=..."
natstack remote start
natstack terminal start --pair "natstack://connect?url=...&code=..."
natstack terminal start
natstack remote invite
natstack remote status
natstack remote logout
```

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all ask the server to launch their selected host target and show
the same privileged workspace-unit approval before running workspace code.

`remote start` launches Electron and therefore uses built Electron artifacts,
even when invoked as `pnpm cli remote start`. `terminal start` runs fully in the
CLI; use `--yes` only for automation that should approve each startup request
once.

Credentials are stored in `~/.config/natstack/cli-credentials.json` with file
mode `0600`. The CLI does not use a system keyring.

## Mobile

Build/install the trusted internal Android APK:

```sh
natstack mobile build
natstack mobile install --launch
# or:
pnpm cli mobile install --launch
```

Start the phone pairing server over Tailscale:

```sh
sudo tailscale serve --bg 3030
natstack mobile pair --host tailscale --port 3030
```

Run the local Android dev loop:

```sh
natstack mobile dev
natstack mobile logs
```

Run a clean installed-app pairing smoke against an emulator or attached device:

```sh
natstack mobile smoke
natstack mobile smoke --avd Pixel_8
```

Useful flags:

- `--device <adb-serial>` targets a specific Android device.
- `--host tailscale|lan|<host>` chooses the phone-reachable route.
- `--workspace <name>` or `--workspace-dir <path>` uses a persistent workspace.
- `--dev` on `natstack mobile pair` uses a disposable template workspace.

See [remote-server.md](./remote-server.md) for deployment details and
[mobile-vpn.md](./mobile-vpn.md) for Tailscale/mobile notes.
