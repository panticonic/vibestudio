# vibestudio

## An integrated personal software environment

Vibestudio is a browser and light-weight sandbox for agents and custom, personalized apps. The goal is to blur the line between using and building software, using AI.

Vibestudio takes a batteries-included approach: Build system, agentic harness, sandboxed file system, version control, credentials management and more are all included (mostly in a way so you can tweak them to your needs) and standardized to make one unified happy-path of composable components.

Unlike many other agentic systems, vibestudio is sandboxed by default and has a privileged, out-of-band system for credentials management and access approval -- so instead of handing over your keys and nervously prompting agents to keep them from taking bad actions with the access you're giving them, you can maintain complete control over every privileged access.

The vibestudio sandbox:

- has a browser-style out-of-band approval system (similar to camera, microphone or storage access in normal browsers) and credential store for external providers.
- includes a context-isolated file system per app / agent instance.
- has facilities for building and debugging software within the system, including agents, apps and reusable packages.
- is particularly light-weight because it is based on browser/JS isolates, the lightest, most wide-spread and battle-tested sandbox out there, instead of OS containers.
- supports background processes and DB persistence via the included workerd service (the tech that drives CloudFlare workers).
- has an extension system for native access node.js code.
- has mobile, cli and desktop apps based on one sanbox runtime that you can customize yourself.

## Installation

Requires **Node.js 22.19.0+**. Both packages update via npm (re-run with `@latest`).

### Desktop app (macOS, Linux)

Installs the GUI and the bundled server:

```bash
npm install -g @panticonic/vibestudio
vibestudio             # launch the desktop app
vibestudio --help      # grouped CLI overview: remote, mobile, fs, vcs, agent, eval, …
```

On the first launch, choose or create a workspace. Its configured onboarding
prompt is added to the new chat's history and starts the onboarding agent
automatically.

### Headless server (remote/home server; clients connect to it)

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote serve --port 3030
# quick one-off (no global install):
npx -p @panticonic/vibestudio-server vibestudio remote serve --port 3030
```

Remote clients pair over WebRTC; the signaling
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

The real-client smoke tests use that deployed route, the normal `remote serve`
hub, and its one-time root-device invite from the strict ready file. Use
`pnpm smoke:full -- --local-signaling` only for an offline Miniflare/coturn run.

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
