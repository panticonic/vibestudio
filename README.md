# vibestudio

## An integrated personal software environment

Vibestudio is a browser and light-weight sandbox for agents and personalized apps. The goal is to tighten the loop between agentically building software, humans using their own personal apps, integrating agents directly into those apps, and generating UI on-the-fly in agentic contexts -- while imposing hard barriers, with fine-grained control over what your agents can access.

- **Batteries included.** One build system, version-controlled file structure, background-process runtime, credentials management, and agentic harness -- standardized into a single composable happy-path so agents cannot and need not reinvent the wheel.
- **Self-modifying agentic harness.** The agentic system is embedded inside the environment it builds, so it can modify itself and be used in or adapted for any app you create.
- **Sandbox with capability grants.** A browser-style, out-of-band approval system (similar to camera or storage access, but with many more capabilities) gives you fine-grained control over every privileged access -- instead of handing over your keys and hoping for the best.
- **Agentic chat as an app.** The chat UI is itself an app inside the system, with affordances for inline generative UI and the ability to automate and inspect running apps from within a conversation.

Vibestudio sandbox details:

- Browser-style capability grant / approval system and credential store for external provider integrations (e.g. Google Workspace, OpenAI etc.).
- Context-isolated file system per app / agent instance.
- Facilities for building and debugging software within the system, including agents, apps and reusable packages.
- Light-weight isolation based on browser/JS isolates, arguably the lightest, most wide-spread and battle-tested sandbox out there.
- Background processes and DB persistence via the included workerd service (the tech that drives Cloudflare Workers).
- Extension system for native-access Node.js code.
- Mobile, CLI and desktop apps based on one sandbox runtime that you can customize yourself.

### Toward safely sharing AI-enabled code

A further question vibestudio is exploring: how do we create an environment to safely integrate untrusted code into an agentic system? For the near term we will likely rely on adapting shared primitives rather than generating complex experiences entirely on the fly -- but if those primitives need to be AI-enabled, there are obvious security and control challenges. The capability-grant system prototyped here is a step toward the equivalent of an agentic, bring-your-own-agent web page.

## Status

This is alpha software. It is _not_ reliable or safe. Or possibly fit for your purposes. The architecture is subject to sudden and violent spasmodic changes. You have been warned.

The agentic harness currently requires a [Codex](https://chatgpt.com/codex) subscription and has mainly been tested against it. Other providers may work but are not actively validated.

## Installation

**[Downloads and package repositories →](https://panticonic.github.io/vibestudio/)** ·
**[Latest release →](https://github.com/panticonic/vibestudio/releases/latest)**

### Desktop app

Each platform's package manager delivers updates, so prefer it over a direct download.

**macOS** — updates with `brew upgrade`:

```bash
brew install --cask panticonic/tap/vibestudio
```

The build is ad-hoc signed rather than signed with an Apple Developer ID, so macOS
asks you to confirm it on first launch (System Settings → Privacy & Security →
Open Anyway). It cannot update itself; `brew upgrade` is the update path.

**Debian / Ubuntu** — updates with `apt upgrade`:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://panticonic.github.io/vibestudio/gpg.key \
  | sudo tee /etc/apt/keyrings/vibestudio.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/vibestudio.asc] https://panticonic.github.io/vibestudio/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/vibestudio.list
sudo apt update && sudo apt install vibestudio
```

**Fedora / RHEL / openSUSE** — updates with `dnf upgrade`:

```bash
sudo rpm --import https://panticonic.github.io/vibestudio/gpg.key
sudo dnf config-manager --add-repo https://panticonic.github.io/vibestudio/rpm
sudo dnf install vibestudio
```

**Windows** — the `.exe` installer on the
[releases page](https://github.com/panticonic/vibestudio/releases/latest). It is not
yet code signed, so SmartScreen warns on first run.

**Arch, or any distro without a repository** — the `.pkg.tar.zst`, `.rpm` and `.deb`
files on the [releases page](https://github.com/panticonic/vibestudio/releases/latest)
install directly. Every packaged format carries the AppArmor profile a workspace
sandbox needs on Ubuntu 24.04+ — `vibestudio remote doctor` reports whether this host
permits the sandbox.

Then:

```bash
vibestudio             # launch the desktop app
vibestudio --help      # grouped CLI overview: remote, mobile, fs, vcs, agent, eval, …
```

On the first launch, choose or create a workspace. Its configured onboarding
prompt is added to the new chat's history and starts the onboarding agent
automatically.

The desktop app is distributed only as a native package, and each one updates
through its own package manager: `apt`/`dnf` from the signed repositories above,
`brew upgrade` on macOS, and a fresh installer on Windows. Development and
linked launches never self-update.

### Headless server (remote/home server; clients connect to it)

Requires **Node.js 22.19.0+**.

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote deploy local
```

A workspace runtime is sandboxed, which on Ubuntu 24.04+ needs an AppArmor
profile that npm cannot install — prefer `apt`/`dnf` on a host those cover.
`vibestudio remote doctor` reports whether this host permits the sandbox and
what to do when it does not.

On Linux with systemd, `deploy local` installs an always-on user service on this
computer, enables it at login/boot, runs end-to-end diagnostics, and prints the
first-device pairing QR. The gateway remains loopback-only; remote clients use
endpoint-authenticated Iroh QUIC with explicit HTTPS relay fallback. The service does not
publish pairing readiness until the default workspace can provide a compiled
desktop shell, so first-use build work happens before a laptop consumes its
one-time link. Manage it with:

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

Remote clients pair directly to the advertised Iroh Endpoint ID. Reaches carry
an explicit ordered relay set; Iroh upgrades to direct paths when possible and
uses the relays when necessary. See [relay operations](docs/iroh-relay-operations.md)
and [CLI operations](docs/cli.md). Each RPC request owns a QUIC stream, while
immutable initial panel assets are verified and cached through one bundled transfer. See
[docs/architecture/remote-transport-qos.md](docs/architecture/remote-transport-qos.md).

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

The remote-transport suite uses real native Iroh endpoints and the current
one-time root-device invite contract. Run it with `pnpm test:remote-transport`.

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
pnpm start           # build + start Electron with normal desktop semantics
pnpm dev             # launch a fresh disposable development workspace
pnpm dev:production  # fresh disposable instance using the pinned production Base
pnpm dev:iroh        # build + start a local hub, then connect through Iroh
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
`vibestudio.baseCheckout`. The setting is untracked and shared by this clone's
Git worktrees. Base-aware developer commands resolve it when they need
unpublished Base input: `pnpm dev`, `pnpm server:live`, userland and browser
tests, type checks, generators, Metro, smoke tests, and commit checks, plus
`pnpm start` when the ordinary desktop profile needs its first workspace. It is
deliberately not an ambient `.env` file. Once setup has completed, no command or
commit requires the checkout path again.

When a command needs that unpublished input, it snapshots the checkout's
visible worktree into a privately owned checkpoint. Tracked and untracked
non-ignored edits are included; you do not need to commit, push, tag, or publish
Base before launching. The developer checkout itself is never staged or
committed by this process.

The persistent `source` server instance is a two-way co-development session.
Its initial semantic workspace comes from that worktree checkpoint, and every
reviewed publication to protected `main` is projected back to the configured
Base checkout. `pnpm start` is deliberately not a source instance: it uses the
ordinary desktop profile and never writes workspace publications into Base.

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

Optional workspace templates can likewise be tested from unpublished local
worktrees. Pass `--template-checkout PATH` once per contribution template:

```bash
pnpm dev --template-checkout ../vibestudio-template-examples
pnpm server:live --template-checkout ../vibestudio-template-examples
pnpm start --template-checkout ../vibestudio-template-examples
```

To open a checkout immediately as an additional workspace alongside Personal and
System, use:

```bash
pnpm dev --workspace-checkout ~/vibestudio-release-work/examples
pnpm server:live --ephemeral --workspace-checkout ~/vibestudio-release-work/examples
```

The target uses the same exact snapshot and normal workspace creation approval.
It does not import code into Personal or System. A changed snapshot selects a
new workspace; an unchanged snapshot can reopen its existing workspace in a
persistent instance. The target checkout is read-only to the running instance.
Base write-back remains owned by System. `pnpm dev` is ephemeral by default.

The launcher derives the template's canonical identity from its `origin`,
snapshots tracked and untracked non-ignored worktree changes into a private
exact commit, and makes that commit available to the ordinary catalog/direct
URL workspace creation flow. The normal source review, approval, build, and
provenance path is unchanged. Repeat the option to develop multiple templates
together. Private checkpoints are removed when the owning launcher exits.

See [docs/cli.md](docs/cli.md). (The published npm packages above replace the old
`pnpm link --global` flow; `pnpm dev` / `pnpm cli` remain the dev workflow.)

`pnpm start` builds the unpublished checkout with production runtime semantics
and launches it against the ordinary desktop profile. It reopens the most
recently used registered workspace, creating `default` from the linked
development Base only when the profile has no workspace yet. It does not expose
developer instances, ephemeral workspaces, or Base write-back. `pnpm dev`
explicitly launches a fresh,
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

MXC executor payloads come from the pinned `@microsoft/mxc-sdk` 0.8.0 package. Workspace cleanup also runs through MXC; no Rust toolchain or app-owned native helper is required. Source builds stage the executor for the current process architecture; release packaging consumes the tested CI artifacts separately, so a local host build cannot replace another platform's release binary. Before staging npm packages or installers, download the native artifacts from a successful CI run:

```bash
gh run download RUN_ID --pattern 'native-isolation-*' --dir native/isolation/artifacts
```

Generic npm packages require the complete Linux x64/ARM64, Apple Silicon macOS, and Windows x64 matrix. An Electron installer requires its requested target. Packaging rejects missing, stale, wrong-architecture or checksum-mismatched MXC inputs and restores executable permissions after artifact transfer. Build manifests describe the pre-signing input bytes; platform signing remains a separate installer step. Windows on ARM uses an x64 Node/Electron process under Windows 11 emulation; a native Windows ARM64 process is unsupported by the current workerd dependency.

The supported MXC release targets are Linux x64/ARM64, Apple Silicon macOS, and Windows x64. Native macOS/Windows enforcement and packaged-app conformance must pass on their respective systems before release. See [native isolation CI](docs/native-isolation-ci.md) for the acceptance matrix, standard-user checks, installer gates, and Windows 11 runner setup.

Native workspace commands and linked Claude use normal networking through stock MXC. Linux requires bubblewrap, with no slirp4netns dependency. Workspace trash deletion remains offline. The existing application egress proxy and its approvals are unchanged. Windows AppContainer may restrict host-loopback access; native Windows validation remains a release gate.

Windows builds include MXC's `wxc-host-prep.exe` alongside the executor so its OS-preparation diagnostics refer to an installed tool. Preparation requiring elevation remains an explicit administrator operation; startup never applies it silently.

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools
- `pnpm bootstrap` - Install the complete host and userland workspace graph
- `pnpm dev:iroh` - Build, start an isolated local hub, and launch Electron through Iroh
- `pnpm build` - Production build
- `pnpm stage:npm` - Build and stage the public npm packages under `dist-packages/`
- `pnpm setup:npm-token` - Save the local npm publish token used by the release script
- `pnpm publish:npm` - Build, stage, dry-run, publish, verify, and install-smoke the npm packages
- `pnpm publish:npm:staged` - Reuse `dist/` and `dist-packages/` for an auth-only publish retry
- `pnpm type-check:cloudflare` - Type-check the callback/apex Cloudflare Worker
- `pnpm deploy:cloudflare` - Deploy the callback/apex Worker
- `pnpm smoke:cloudflare` - Smoke the deployed callback/apex Worker
- `pnpm start` - Build unpublished code and launch it with normal desktop semantics
- `pnpm lint` - Run ESLint with strict rules
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check formatting
- `pnpm type-check` - Type check without emitting

To exercise the remote Iroh transport without a second machine:

```bash
pnpm rebuild @number0/iroh   # one-time, if the native module is not built
pnpm dev:iroh
```

`pnpm dev:iroh` starts a clean, isolated hub, routes its default workspace, and launches Electron with the
fresh root-bootstrap `vibestudio://connect` link from the hub ready file. Use
`pnpm dev:iroh -- --ephemeral` for an explicitly ephemeral child; named
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
  Endpoint ID: ...
  Relays:      https://relay.vibestudio.app/, https://relay-eu.vibestudio.app/
  Pair URL:    https://vibestudio.app/p#<compact-payload>
```

On a fresh server, that root-bootstrap invite is automatically replaced when it
expires. The foreground command prints each replacement; a managed service
atomically updates its protected ready state, so
`vibestudio remote deploy pairing local` always shows the current QR/link until
the first device claims the root account. Published server commands also gate
that ready state on the selected workspace's Electron artifact and every
deduplicated `initPanels` artifact. A visible pair URL is therefore a
first-surface readiness promise, not merely proof that the endpoint bound.

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
| `--relay-url URL`                    | Explicit canonical HTTPS Iroh relay (repeatable)         |
| `--dev`                              | Development mode                                         |
| `--ephemeral`                        | Use a disposable workspace                               |

The gateway binds loopback only; remote clients reach it over Iroh (paired by
QR). There is no `--host` / `--public-url` / `--protocol` / TLS flag — those were
decommissioned with remote-mode public ingress. OAuth/webhook routes resolve
through the callback relay (`VIBESTUDIO_RELAY_URL`).

The public server is always a hub. Clients pair with the hub, choose a
workspace, and then connect to `/_workspace/<name>`. Workspace flags are
reserved for internal child runtimes and are rejected by the public server.

### Android phone pairing

For an npm installation, install the Android app. Pairing authenticates the
server Iroh Endpoint ID — no Tailscale/VPN or HTTPS serve setup:

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
`https://vibestudio.app/p#<compact-payload>` invitation. Protocol v4 packs the
one-time secret, authenticated Endpoint ID, expiry, and explicit relay set into
one URL-safe fragment. It does not depend on SSH or a link-shortening service.
The first phone, desktop, or CLI to redeem a fresh
server's current startup invitation becomes the root account.
