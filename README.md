# vibestudio

## An integrated personal software environment

Vibestudio is a browser and light-weight sandbox for agents and personalized apps. The goal is to blur the line between using and building software, using AI, while imposing hard barriers, with fine grained control over what your agents can access.

Vibestudio takes a batteries-included approach: Build system, agentic harness, sandboxed file system, version control, credentials management and more are all included (mostly in a way so you can tweak them to your needs) and standardized to make one unified happy-path of composable components.

Vibestudio is sandboxed by default and has a privileged, out-of-band system for credentials management and access approval -- so instead of handing over your keys and nervously prompting agents to keep them from taking bad actions with the access you're giving them, you can maintain complete control over every privileged access.

The vibestudio sandbox:

- has a browser-style out-of-band capability grant / approval system (similar to camera, microphone or storage access in normal browsers, just with many more capabilities) and credential store for external provider integrations (e.g. Google Workspace, OpenAI etc.).
- includes a context-isolated file system per app / agent instance.
- has facilities for building and debugging software within the system, including agents, apps and reusable packages.
- is particularly light-weight because it is based on browser/JS isolates, arguably the lightest, most wide-spread and battle-tested sandbox out there.
- supports background processes and DB persistence via the included workerd service (the tech that drives CloudFlare workers).
- has an extension system for native access node.js code.
- has mobile, cli and desktop apps based on one sanbox runtime that you can customize yourself.

## Status

This is alpha software. It is _not_ reliable or safe. Or possibly fit for your purposes. The architecture is subject to sudden and violent spasmodic changes. You have been warned.

## Installation

Requires **Node.js 22.19.0+**.

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

A verified global npm desktop install checks the npm `latest` release
periodically. When an update is available, **Update and restart** confirms any
interruption of the desktop-owned local hub, stops its complete process tree,
installs the exact offered version, and relaunches the app. Vibestudio never
updates on a timer. If the npm prefix is not writable, the action instead
copies an exact-version command for the package manager environment that owns
the installation.

Only one desktop update can mutate the installation at a time. A second launch
during that window reports that Vibestudio is updating and exits. If
installation fails, the launcher tries once to restore the previous exact
version and the relaunched app reports the outcome and private update-log path.
Local, linked, `npx`, pnpm, and development launches do not self-update.

### Headless server (remote/home server; clients connect to it)

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote deploy local
```

On Linux with systemd, `deploy local` installs an always-on user service on this
computer, enables it at login/boot, runs end-to-end diagnostics, and prints the
first-device pairing QR. The gateway remains loopback-only; clients reach it
through the encrypted WebRTC connection described below. Manage it with:

```bash
vibestudio remote deploy status local
vibestudio remote deploy pairing local
vibestudio remote deploy logs local
vibestudio remote deploy update local
```

For a foreground session instead, or a quick one-off without a global install:

```bash
vibestudio remote serve --port 3030
npx -p @panticonic/vibestudio-server vibestudio remote serve --port 3030
```

Remote clients pair over WebRTC; the signaling
endpoint is only used to rendezvous, not to carry workspace data. See
[docs/webrtc-deployment.md](docs/webrtc-deployment.md) and [docs/cli.md](docs/cli.md).
Each workspace reach uses one peer connection with prioritized control,
interactive, and bulk lanes; immutable initial panel assets are verified and
cached through one bundled transfer. See
[docs/architecture/remote-transport-qos.md](docs/architecture/remote-transport-qos.md).
The hosted signaling service (`wss://signal.vibestudio.app`) is used by default;
self-hosting is optional.

The headless server does not update itself. Install the desired CLI release,
then let the deployment lifecycle reinstall that exact version and restart the
service:

```bash
npm install -g @panticonic/vibestudio-server@latest
vibestudio remote deploy update local
```

#### Inviting a user

Identity lives in one hub-owned database (`server-auth/identity.db`); the flow is:

1. **Root bootstrap** — on a fresh server the startup pairing code is the root
   invite: the first device to redeem it becomes the `root` user. Until that
   happens, the server replaces expired root invites and publishes the current
   QR/link through `remote deploy pairing <target>`; it never becomes permanently
   unclaimable because an operator stepped away.
2. **Invite a user** (root/admin only) — mint a user-bound pairing code with a
   handle and optional workspace memberships; the invitee's first device
   redeems it and is issued as that user.
3. **Pair your own devices** (any member) — additional pairing codes are bound
   to your own account; phones, laptops, and terminals all become devices of
   the same user.
4. **Membership** (root/admin only) — users see and enter only workspaces they
   are members of; inside a workspace, all members are mutually trusted.

See [docs/cli.md](docs/cli.md#users--membership-multi-user) for the commands and
[Base remote-access skill](https://github.com/panticonic/vibestudio-workspace-base/blob/main/skills/remote-access/SKILL.md)
for the operational runbook.

The real-client smoke tests use that deployed route, the normal `remote serve`
hub, and the current one-time root-device invite from the strict ready file. Use
`pnpm smoke:full -- --local-signaling` only for an offline Miniflare/coturn run.

### Develop (contributors)

Requires Node.js 22.19+, pnpm, and the normal Electron system libraries. Linux
contributors running Electron E2E tests also need the isolated X11/native-input
tooling:

```bash
sudo apt-get update
sudo apt-get install -y xvfb xauth x11-utils xdotool
```

The Playwright config launches one authenticated Xvfb server per test
invocation and passes its private `DISPLAY` to Electron and `xdotool`. This is
intentional even when the developer has a desktop session: native keyboard,
pointer, focus, and clipboard tests cannot interact with the real desktop or a
concurrent test run. The harness stops Xvfb before its single run-level
temporary-directory cleanup.

`pnpm test:e2e:headed` is the deliberate exception: it borrows the current
desktop so a developer can watch and interact with the test. Do not run that
mode concurrently with other native-input work.

```bash
pnpm bootstrap        # install the complete host and userland workspace graph
pnpm dev:base setup   # clone and remember the external Base checkout (one time)
pnpm start           # build + start Electron in the source developer instance
pnpm dev             # launch a fresh disposable development workspace
pnpm dev:production  # fresh disposable instance using the pinned production Base
pnpm dev:webrtc      # build + start a local hub, then connect to a routed child over WebRTC
pnpm cli --help      # run the CLI live from TypeScript
pnpm server:live --help
```

#### Host and Base co-development

Base is an external repository because it is independently publishable userland,
but normal development does not require repeatedly passing its path or publishing
it. Configure it once per host clone:

```bash
pnpm dev:base setup
```

The command clones the canonical Base repository into the sibling
`../vibestudio-workspace-base` directory when it is absent, then records its
canonical path in this repository's local Git configuration under
`vibestudio.baseCheckout`. The setting is untracked, shared by this clone's Git
worktrees, and resolved by every Base-aware developer command: `pnpm start`, `pnpm dev`,
`pnpm server:live`, userland and browser tests, type checks, generators, Metro,
smoke tests, and commit checks. It is deliberately not an ambient `.env` file.
Once setup has completed, no command or commit requires the checkout path again.

`pnpm start` and `pnpm dev` snapshot the checkout's visible worktree into an instance-owned
checkpoint. Tracked and untracked non-ignored edits are included; you do not
need to commit, push, tag, or publish Base before starting or restarting the
app. The developer checkout itself is never staged or committed by this
process.

The default `source` developer instance is a two-way co-development session.
Its initial semantic workspace comes from that worktree checkpoint, and every
reviewed publication to protected `main` is projected back to the configured
Base checkout. The projection is a three-way merge against the publication's
exact previous state: checkout-only edits are preserved, identical edits
coalesce, and overlapping edits reject the entire write-back before any file is
touched. Named, disposable, system-test, and candidate-pair instances never
write to the configured checkout.

To exercise the shipped experience instead, run `pnpm dev:production`. It
ignores (but does not change) the local development selection, creates a fresh
disposable instance, and acquires the exact Base release pinned by the host.
`pnpm server:production` provides the corresponding headless server workflow.

Useful configuration commands:

```bash
pnpm dev:base status             # show the configured checkout, HEAD, and cleanliness
pnpm dev:base use /other/base    # select an existing Base checkout
pnpm dev:base path               # print the selected checkout for scripts/editors
pnpm dev:base clear              # require setup again; use dev:production for the published Base
```

`--base-checkout PATH` and `VIBESTUDIO_USERLAND_ROOT=PATH` remain explicit,
single-command overrides. They do not change the stored selection.

See [docs/cli.md](docs/cli.md). (The published npm packages above replace the old
`pnpm link --global` flow; `pnpm dev` / `pnpm cli` remain the dev workflow.)

`pnpm start` follows the same startup policy as the packaged app: it reopens the
most recently used registered workspace, creating `default` only when the
instance has no workspace yet. `pnpm dev` explicitly launches a fresh,
hub-owned disposable workspace and always stops its hub on quit so the
workspace checkout and catalog lifecycle are removed. Persistent and ephemeral
launches therefore exercise the same application; only workspace ownership and
lifetime differ.

`pnpm server:live` remains the explicit persistent `source` instance for CLI
and long-lived server work. Add `--instance NAME` for another persistent
isolated instance, or `--ephemeral --instance NAME` for a disposable parallel
test hub. Named and ephemeral instances never write their workspace
publications into the checkout.
Profile-owned model configuration and encrypted provider credentials remain
shared. For system tests, the self-provisioning launcher creates and pairs the
disposable instance automatically:

```bash
pnpm system-test --instance panel-dx doctor
pnpm system-test --instance panel-dx stop
```

Different instances have independent leases, identities, databases, workspaces,
ports, ready files, CLI credentials, and sessions. The checkout-scoped lock
prevents two launchers from competing for one instance, while different
instances run concurrently. Stopping one never targets another hub.

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools
- `pnpm bootstrap` - Install the complete host and userland workspace graph
- `pnpm dev:webrtc` - Build, start an isolated local hub, and launch Electron through its routed child over WebRTC
- `pnpm build` - Production build
- `pnpm stage:npm` - Build and stage the public npm packages under `dist-packages/`
- `pnpm setup:npm-token` - Save the local npm publish token used by the release script
- `pnpm publish:npm` - Build, stage, dry-run, publish, verify, and install-smoke the npm packages
- `pnpm publish:npm:staged` - Reuse `dist/` and `dist-packages/` for an auth-only publish retry
- `pnpm type-check:cloudflare` - Type-check the signaling and apex Cloudflare Workers
- `pnpm deploy:cloudflare` - Deploy the signaling Worker and apex relay Worker
- `pnpm smoke:cloudflare` - Smoke the deployed apex and signaling Workers
- `pnpm start` - Build and start the source developer instance with the configured Base
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

For an always-on Linux server managed by the normal user-service lifecycle:

```bash
vibestudio remote deploy local
```

Use `remote deploy pairing local`, `status local`, `logs local`, and `update
local` to manage that same service. Pairing is the secret-bearing setup surface;
logs remain diagnostic output. For a foreground session instead:

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
  Pair URL:    https://vibestudio.app/p#<compact-payload>
```

On a fresh server, that root-bootstrap invite is automatically replaced when it
expires. The foreground command prints each replacement; a managed service
atomically updates its protected ready state, so
`vibestudio remote deploy pairing local` always shows the current QR/link until
the first device claims the root account.

Pairing links are one-time bearer capabilities. Consuming a link prevents
anyone who copied or photographed it from replaying it to add another device.
The desktop checks its encrypted credential store before contacting the server;
if that check fails, it says that the link was **not used** and the same link can
be retried after fixing local storage. Once the server accepts a link, any later
failure says that the link is used and that a fresh invite is required—never the
ambiguous “Invalid token.”

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

For an npm installation, install the Android app. Pairing is over WebRTC
(signaling room + DTLS fingerprint) — no Tailscale/VPN or HTTPS serve setup:

```bash
vibestudio mobile install --launch
```

Scan the managed server's current startup QR if this is the first device. For an
additional phone, create a link from desktop via the connection badge →
**Paired devices** → **Connect a device**, or from mobile via **Settings** →
**Devices** → **Connect another device**. `vibestudio remote pair-device` is the
equivalent paired-CLI flow.

`vibestudio mobile pair --port 3030` remains the foreground, one-off path when
no managed server is running. From a source checkout, run `pnpm build` first,
then use `pnpm cli mobile install --launch` and the same pairing flow.

The QR carries the complete, self-contained
`https://vibestudio.app/p#<compact-payload>` invitation. Protocol v3 packs the
one-time secret, DTLS fingerprint, expiry, ICE policy, and any non-default
signaling endpoint into one URL-safe fragment; the signaling room is derived
one-way from the secret. The normal hosted link has no shell metacharacters and
does not depend on SSH or a link-shortening service. See
[docs/webrtc-local-e2e.md](docs/webrtc-local-e2e.md) for the transport and local
development harness. The first phone, desktop, or CLI to redeem a fresh
server's current startup invitation becomes the root account.
