# vibestudio

## A personal vibe computer

Vibestudio is a browser and light-weight sandbox for agents and personalized AI-built apps that blurs the line between using and building software.
It's an environment in which you can combine agentic workflows similar to OpenClaw or Hermes Agent with an app build system for creating and modifying personal software, where the AI is always available to refine your personal software to meet your needs.
Unlike many other agentic systems, vibestudio is sandboxed by default and has a privileged, out-of-band system for credentials management and access approval -- so instead of handing over your keys and nervously prompting agents to keep them from taking bad actions with the access you're giving them, you can maintain complete control over every privileged access.

Vibestudio is **multi-user and multi-workspace**: one server (the hub) hosts
several workspaces and a small, mutually-trusting team — a family, a household,
a close team. A root/admin invites users; each user pairs their own devices;
workspace members share the workspace fully (one panel forest, one approval
queue, mutual inspectability), with every action attributed to the acting user.
Roles gate only host administration (inviting/revoking users, membership,
workspace create/delete) — inside a workspace, members are peers.

The vibestudio sandbox:

- has a browser-style out-of-band approval system (similar to camera, microphone or storage access in normal browsers) and credential store for external providers.
- includes a context-isolated file system per app / agent instance.
- has facilities for building and debugging software within the system, including agents, apps and reusable packages.
- is particularly light-weight because it is based on browser/JS isolates, the lightest, most wide-spread and battle-tested sandbox out there, instead of OS containers.
- supports background processes and DB persistence via the included workerd service (the tech that drives CloudFlare workers).
- has an extension system for native access node.js code.
- has customizable mobile, cli and desktop apps.

## Installation

Requires **Node.js 22.19.0+**. Both packages update via npm (re-run with `@latest`).

### Desktop app (macOS, Linux; Windows soon)

Installs the GUI and the bundled server:

```bash
npm install -g @panticonic/vibestudio
vibestudio             # launch the desktop app
vibestudio --help      # grouped CLI overview: remote, mobile, fs, vcs, agent, eval, …
```

On macOS this runs cert-free for now (npm-delivered, non-quarantined); signed
DMG/AppImage/deb installers are published to GitHub Releases as they become available.

Locally the desktop shell is one globally paired **device of the server hub**,
not a workspace-owned process. The bundled hub runs as a detached OS process
(spawned with `ELECTRON_RUN_AS_NODE`) that outlives the app; on launch the app
attaches to the healthy recorded hub or starts a fresh one, then the hub routes
the device into a membership-authorized workspace child. Local and remote use
the same device/refresh-credential model; only the transport differs — loopback
locally, WebRTC remotely. Quitting the app leaves the hub and active workspace
children running when background work is active (you are prompted, and the
choice can be remembered); idle children stop on their own. See
[STATE_DIRECTORY.md](STATE_DIRECTORY.md) for the on-disk files.

On the first launch, choose or create a workspace. Its configured onboarding
prompt is added to the new chat's history and starts the onboarding agent
automatically. Local models remain an explicit offline option in the model picker
and Local Models panel; onboarding never begins a hidden model download.

### Headless server (remote/home server; clients connect to it)

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote serve --port 3030
# quick one-off (no global install):
npx -p @panticonic/vibestudio-server vibestudio remote serve --port 3030
```

The server installs with no compiler (workerd/esbuild ship prebuilt binaries) and
builds panels/workers on demand. Remote clients pair over WebRTC; the signaling
endpoint is only used to rendezvous, not to carry workspace data. See
[docs/webrtc-deployment.md](docs/webrtc-deployment.md) and [docs/cli.md](docs/cli.md).
The hosted signaling service (`wss://signal.vibestudio.app`) is used by default;
self-hosting is optional.

#### Inviting a user

Identity lives in one hub-owned database (`server-auth/identity.db`); the flow is:

1. **Root bootstrap** — on a fresh server the startup pairing code is the root
   invite: the first device to redeem it becomes the `root` user.
2. **Invite a user** (root/admin only) — mint a user-bound pairing code with a
   handle and optional workspace memberships; the invitee's first device
   redeems it and is issued as that user.
3. **Pair your own devices** (any member) — additional pairing codes are bound
   to your own account; phones, laptops, and terminals all become devices of
   the same user.
4. **Membership** (root/admin only) — users see and enter only workspaces they
   are members of; inside a workspace, all members are mutually trusted.

See [docs/cli.md](docs/cli.md#users--membership-multi-user) for the commands and
[workspace/skills/remote-access/SKILL.md](workspace/skills/remote-access/SKILL.md)
for the operational runbook.

### Develop (contributors)

```bash
pnpm bootstrap        # install root deps and the split userland workspace deps
pnpm dev             # build + start Electron with DevTools
pnpm dev:webrtc      # build + start a local hub, then connect to a routed child over WebRTC
pnpm cli --help      # run the CLI live from TypeScript
pnpm server:live --help
```

See [docs/cli.md](docs/cli.md). (The published npm packages above replace the old
`pnpm link --global` flow; `pnpm dev` / `pnpm cli` remain the dev workflow.)

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools
- `pnpm bootstrap` - Install both root dependencies and `workspace/` userland dependencies
- `pnpm install:userland` - Refresh only the split `workspace/` dependency install
- `pnpm dev:webrtc` - Build, start an isolated local hub, and launch Electron through its routed child over WebRTC
- `pnpm dev -- --auto-approve` - Start dev mode and automatically approve decision-style approval prompts
- `pnpm build` - Production build
- `pnpm stage:npm` - Build and stage the public npm packages under `dist-packages/`
- `pnpm setup:npm-token` - Save the local npm publish token used by the release script
- `pnpm publish:npm` - Build, stage, dry-run, publish, verify, and install-smoke the npm packages
- `pnpm publish:npm:staged` - Reuse `dist/` and `dist-packages/` for an auth-only publish retry
- `pnpm type-check:cloudflare` - Type-check the signaling and apex Cloudflare Workers
- `pnpm deploy:cloudflare` - Deploy the signaling Worker and apex relay Worker
- `pnpm smoke:cloudflare` - Smoke the deployed apex and signaling Workers
- `pnpm start` - Start the app (requires prior build)
- `pnpm lint` - Run ESLint with strict rules
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check formatting
- `pnpm type-check` - Type check without emitting

### Publishing npm packages

This repo's npm release flow is token-only. Use a granular npm access token with
package read/write access and bypass 2FA enabled. Save it once on the release
machine:

```bash
pnpm setup:npm-token
```

The token is written to `~/.config/vibestudio/npm-publish-token` with file mode
`0600`. It can also be supplied per shell with `NPM_TOKEN` or `NODE_AUTH_TOKEN`.
Use `pnpm setup:npm-token --path` to print the token path, `--remove` to delete
the saved token, and `--stdin` to read a token from stdin.

Run the full npm release:

```bash
pnpm publish:npm
```

That one command builds, stages, runs npm publish dry-runs, publishes
`@panticonic/vibestudio-server` first, publishes `@panticonic/vibestudio`
second, verifies both package versions on npm, then installs from npm into `/tmp`
and runs the packaged CLI smoke checks.

If the build/stage/dry-run already passed and only token or network access
blocked publish, retry without rebuilding:

```bash
pnpm publish:npm:staged
pnpm publish:npm:staged -- --package app   # if the server package already published
```

The staged retry uses the same publish, verification, and install-smoke checks;
it only skips rebuilding the local artifacts.

## How It Works

Each panel in Vibestudio occupies a node in the workspace's panel tree. You can:

1. **Open or nest panels**: Use New Panel (`Cmd+T` on macOS, `Ctrl+Shift+T` elsewhere) or panel actions to create content
2. **Navigate up**: Use ancestor breadcrumbs to go back to parent panels
3. **Navigate sideways**: Click sibling tabs to switch between panels at the same level
4. **Navigate down through descendants**: Click descendant breadcrumbs to jump to child panels

## Development

Start the development server:

```bash
pnpm dev
```

The app will open with DevTools enabled for debugging.

To exercise the remote WebRTC transport without a second machine:

```bash
pnpm rebuild node-datachannel   # one-time, if the native module is not built
pnpm dev:webrtc
```

`pnpm dev:webrtc` starts local signaling and a clean, isolated hub, routes its
default workspace child as the WebRTC answerer, and launches Electron with the
fresh root-bootstrap `vibestudio://connect` link from the hub ready file. Use
`pnpm dev:webrtc -- --ephemeral` for an explicitly ephemeral child; named
workspace selection happens through the paired client, as it does in production.

### Memory Diagnostics (optional)

You can enable lightweight memory logging to identify which panel/worker is growing. Logs are derived from `app.getAppMetrics()` and include working set, peak working set, and (Windows-only) private bytes for each view’s process.

```bash
# Log a snapshot every 60s
VIBESTUDIO_MEMORY_LOG_MS=60000 pnpm dev

# Log only if any view exceeds the threshold (MB)
VIBESTUDIO_MEMORY_LOG_THRESHOLD_MB=1500 pnpm dev

# Log a single snapshot at startup
VIBESTUDIO_MEMORY_LOG_ONCE=1 pnpm dev
```

To temporarily increase the renderer V8 heap limit in dev:

```bash
VIBESTUDIO_RENDERER_MAX_OLD_SPACE_MB=4096 pnpm dev
```

## Building for Production

```bash
pnpm build
pnpm start
```

---

## Headless Server

Vibestudio can run without Electron as a standalone Node.js server. All core
services — build, git, channels, AI, agents, tokens — are available over
WebSocket RPC. Persistent storage lives inside workerd Durable Objects (each
DO owns its own SQLite-backed `this.sql`); the server has no native module
dependencies. Panels can optionally be served to a regular web browser over
HTTP.

### Prerequisites

```bash
npm install -g @panticonic/vibestudio-server
```

For development from a source checkout instead: `pnpm bootstrap && pnpm build`.

### Running

```bash
vibestudio remote serve --port 3030
# from a source checkout:
pnpm cli remote serve --port 3030
```

The installed launcher pins the app root to the package, so it works from any
directory. On startup the pairing server prints a QR/deep-link:

```
Pair a Vibestudio device
  Room:        ...
  Fingerprint: ...
  Pair URL:    vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2&ice=all
```

### CLI Flags

| Flag                                 | Description                                              |
| ------------------------------------ | -------------------------------------------------------- |
| `--port PORT`, `--gateway-port PORT` | Hub ingress port (environment override or `3030`)        |
| `--app-root PATH`                    | Application root (the installed package root by default) |
| `--signal-url URL`                   | Signaling endpoint (hosted service by default)           |
| `--dev`                              | Development mode                                         |
| `--ephemeral`                        | Use a disposable workspace                               |

The gateway binds loopback only; remote clients reach it over WebRTC (paired by
QR). There is no `--host` / `--public-url` / `--protocol` / TLS flag — those were
decommissioned with remote-mode public ingress. OAuth/webhook routes resolve
through the callback relay (`VIBESTUDIO_RELAY_URL`).

The public server is always a hub. Clients pair with the hub, choose a
workspace, and then connect to `/_workspace/<name>`. Workspace flags are
reserved for internal child runtimes and are rejected by the public server.

### Android phone pairing

For an npm installation, install the Android app and start a QR-pairing server:
Pairing is over WebRTC (signaling room + DTLS fingerprint) — no Tailscale/VPN or
HTTPS serve setup:

```bash
vibestudio mobile install --launch
vibestudio mobile pair --port 3030
```

From a source checkout, run `pnpm build` first, then use `pnpm cli mobile
install --launch` and `pnpm cli mobile pair --port 3030`.

Scan the printed `vibestudio://connect?room=…&fp=…&code=…&sig=…&v=2&ice=all` QR. See
[docs/webrtc-local-e2e.md](docs/webrtc-local-e2e.md) for the WebRTC pairing +
local setup. Use the desktop app's bootstrap screen to pair a laptop without
copying an admin token. After one desktop client is connected, use **Remote
server** → **Paired devices** → **Connect a device** for additional links.

Each panel gets:

- **Injected globals** replacing Electron's preload/contextBridge
- **A WebSocket transport** connecting to the RPC server (same protocol as
  the Electron preload)
- **RPC-backed filesystem** via server-side context folders
- **Full service access** — AI, git, database, build, channels

### In-Process Agents

Agents run as in-process services managed by AgentManager. They have direct
access to the server service registry and AIHandler, and communicate via channels.
