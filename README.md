<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="build-resources/brand/vibestudio-logo-dark.svg"><img src="build-resources/brand/vibestudio-logo.svg" alt="Vibestudio" width="120"></picture></p>

# Vibestudio

Build and share deeply AI-infused apps. Vibestudio is a browser for apps with
agents inside them. You can build your own with an agent, or open apps
other people made and let them run on your models, reaching only what you
allow.

Most AI apps today look alike: the app, a chat box in the corner, a few tools
wired up behind it. I think interfaces can do a lot more. They could generate
parts of themselves as you use them, work with your own data, and put agents
into games and tools wherever an agent actually helps. Nobody quite knows what
that looks like yet, so Vibestudio is built to make trying ideas cheap: the
decisions about builds, deploys, sandboxing and credentials are made up front
(any language you like, as long as it's TypeScript), and what you build can be
shared and opened by someone else in seconds.

More at [vibestudio.app](https://vibestudio.app).

## What's in it

- **A place to build.** Every workspace comes with a build system, version
  control, databases and background processes. Agents build apps there without
  having to reinvent any of it, and the agent harness lives in the same
  environment, so it can change itself and be dropped into the apps it builds.
- **The chat is an app too.** The chat panel can show interactive UI inline,
  open and drive other panels, and be modified like anything else you built.
- **A browser for other people's agentic apps.** A website can ask to connect
  to your workspace, much like a web3 site asks to connect to a wallet.
  Connecting grants almost nothing. The page then asks for specific things,
  like your model provider or a folder, and you approve each one. Whole
  workspaces can also be installed from templates, each in its own sandbox.
- **Approvals an agent can't fake.** Credentials stay outside the sandbox.
  Apps and agents get capabilities instead of keys, and you grant them through
  prompts in Vibestudio's own UI, a bit like a browser asking for camera
  access. You never hand your login to an agent and hope.
- **Your browser, imported.** Bring over tabs and cookies and stay logged in.
  With your permission, agents can read and automate those pages.
- **Desktop, server and phone.** The same sandbox runs the desktop app, a
  headless home server, the CLI and the mobile app.

Under the hood, apps and agents are isolated with browser/JS isolates, the
lightest and most widely deployed sandbox around. Background processes and
storage run on the bundled workerd (the runtime behind Cloudflare Workers).
Each app or agent instance gets its own view of the file system, and native
Node.js code can be added through extensions.

## Status

This is alpha software. It isn't reliable or safe yet, and the architecture
still changes in big, sudden ways. Be careful what you connect to it.

The agent harness has mostly been tested with a
[Codex](https://chatgpt.com/codex) (ChatGPT) subscription. Other providers may
work, but nobody is checking them regularly.

If you build something with it or find something broken, please
[open an issue](https://github.com/panticonic/vibestudio/issues).

## Installation

**[Downloads and package repositories →](https://panticonic.github.io/vibestudio/)** ·
**[Latest release →](https://github.com/panticonic/vibestudio/releases/latest)**

Install through your platform's package manager where you can. That's also how
you get updates.

**macOS** (Apple Silicon, macOS 14+): [Download the DMG](https://vibestudio.app/download/mac),
open it and drag Vibestudio into Applications. Or install through Homebrew:

```bash
brew install --cask panticonic/tap/vibestudio
```

The app is ad-hoc signed, not signed with an Apple Developer ID, so macOS asks
you to confirm it the first time (System Settings → Privacy & Security → Open
Anyway). Direct installs offer a download when an update is available: quit the
app, replace it in Applications, then reopen it. Homebrew installs offer to run
`brew upgrade --cask vibestudio` for you.

**Debian / Ubuntu**, updated with `apt upgrade`:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://panticonic.github.io/vibestudio/gpg.key \
  | sudo tee /etc/apt/keyrings/vibestudio.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/vibestudio.asc] https://panticonic.github.io/vibestudio/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/vibestudio.list
sudo apt update && sudo apt install vibestudio
```

**Fedora / RHEL / openSUSE**, updated with `dnf upgrade`:

```bash
sudo rpm --import https://panticonic.github.io/vibestudio/gpg.key
sudo dnf config-manager --add-repo https://panticonic.github.io/vibestudio/rpm
sudo dnf install Vibestudio
```

**Windows**: run the `.exe` installer from the
[releases page](https://github.com/panticonic/vibestudio/releases/latest). It
isn't code-signed yet, so SmartScreen will warn you the first time.

**Arch, or any other distro**: the `.pkg.tar.zst`, `.rpm` and `.deb` files on
the [releases page](https://github.com/panticonic/vibestudio/releases/latest)
install directly. Every package includes the AppArmor profile the workspace
sandbox needs on Ubuntu 24.04 and later. `vibestudio remote doctor` tells you
whether your system allows the sandbox.

Then:

```bash
vibestudio             # launch the desktop app
vibestudio --help      # CLI overview: remote, mobile, fs, vcs, agent, eval, …
```

On first launch, pick or create a workspace. A chat opens with the onboarding
agent, which asks what you want to do and helps you set things up.

### Updates

A while after launch, and every six hours after that, Vibestudio checks for a
new release and offers to install it in whatever way fits how you installed
it. The notification stays until dismissed; a dismissed release stays quiet for
the rest of that session. On Windows and Developer ID signed macOS builds it
downloads the release, installs it and restarts. Ad-hoc signed Mac builds offer
a DMG download or upgrade through Homebrew when Homebrew owns the app. On
Linux it asks the package manager that owns the installation (`apt`, `dnf` or
`pacman`) through the system's own password prompt, then offers to restart.
Package-manager installs also offer **Copy upgrade command** if you prefer to
run the upgrade yourself; that remains available when the desktop cannot ask
for permission. Linux upgrades refresh repository metadata first. Vibestudio
checks the installed package version afterwards and tells you if the repository
does not have the new release yet. Nothing installs
without asking, and development builds never update themselves.

## Running a server

You can run Vibestudio headless on a home server or VPS and connect your
desktop and phone to it. All the core services (builds, git, chat, agents,
credentials) run on the server, and storage lives in workerd Durable Objects,
so there are no native modules to compile. It needs **Node.js 22.19.0+**.

```bash
brew install panticonic/tap/vibestudio-server   # macOS, or Linuxbrew
npm install -g @panticonic/vibestudio-server    # anywhere else
vibestudio remote deploy local
```

On Linux with systemd, `deploy local` installs a user service that starts at
login or boot, runs end-to-end checks, and prints a QR code for pairing your
first device. Manage it with:

```bash
vibestudio remote deploy status local
vibestudio remote deploy pairing local
vibestudio remote deploy logs local
vibestudio remote deploy update local
```

`pairing` shows secrets; `logs` is for diagnostics. For a one-off session in
the foreground instead:

```bash
vibestudio remote serve --port 3030
npx -p @panticonic/vibestudio-server vibestudio remote serve --port 3030   # without installing
pnpm cli remote serve --port 3030                                          # from a source checkout
```

The installed launcher always uses its own package as the app root, so it works
from any directory.

**The sandbox on Ubuntu.** Vibestudio sandboxes both the workspace runtime and
the desktop's renderers, and each sandbox needs an unprivileged user namespace.
Ubuntu 24.04+ sets `kernel.apparmor_restrict_unprivileged_userns=1`, which only
allows that for binaries with an AppArmor profile. The `apt` and `dnf` packages
ship and install those profiles; npm can't. So on Ubuntu, prefer a package
manager. `vibestudio remote doctor` reports whether the sandbox is allowed and
what to do if it isn't. [Linux sandbox setup](docs/linux-sandbox-setup.md) has
the details.

**Updating.** The server doesn't update itself. Install the release you want,
then let the deployment reinstall exactly that version and restart:

```bash
brew upgrade vibestudio-server                          # or:
npm install -g @panticonic/vibestudio-server@latest
vibestudio remote deploy update local
```

### How devices connect

The server only listens on loopback. Remote devices reach it over Iroh QUIC,
authenticated by the server's endpoint ID, falling back to HTTPS relays when a
direct path isn't possible. There's no public port, TLS setup, Tailscale or VPN
to configure. On startup the server prints something like:

```
Pair a Vibestudio device
  Endpoint ID: ...
  Relays:      https://relay.vibestudio.app/, https://relay-eu.vibestudio.app/
  Pair URL:    https://vibestudio.app/p#<compact-payload>
```

The pair URL is a complete invitation. Its fragment packs the one-time secret,
endpoint ID, expiry and relay list, so it works without SSH or a link
shortener. The server doesn't show it until the default workspace has built
the desktop shell and initial panels, so your first connection doesn't sit
waiting on a build.

Pairing links work once. After one is used, nobody who copied or photographed
it can add another device with it. If the desktop can't store the credential
locally, it tells you the link was **not used** and you can retry. Once the
server accepts a link, any later failure tells you to get a fresh invite.

See [relay operations](docs/iroh-relay-operations.md),
[CLI operations](docs/cli.md) and
[remote transport](docs/architecture/remote-transport-qos.md) for more.

### Users and devices

1. **The first device is root.** On a fresh server, the startup pairing code is
   the root invite, and the first device to redeem it becomes the `root` user.
   Until then, the server replaces the invite when it expires and
   `remote deploy pairing <target>` always shows the current one, so you can
   step away without locking yourself out.
2. **Inviting people** (root or admin): create a pairing code bound to a new
   handle, optionally with workspace memberships. The invitee's first device
   redeems it.
3. **Adding your own devices** (anyone): pairing codes you create are bound to
   your account, so phones, laptops and terminals all become devices of the
   same user.
4. **Workspace membership** (root or admin): users only see workspaces they're
   members of. Inside a workspace, all members trust each other.

Identity lives in one database on the hub (`server-auth/identity.db`). See
[docs/cli.md](docs/cli.md#users--membership-multi-user) for the commands and
the [remote-access skill](https://github.com/panticonic/vibestudio-system/blob/main/skills/remote-access/SKILL.md)
for the full runbook.

### Pairing an Android phone

```bash
vibestudio mobile install --launch
```

Scan the server's startup QR if this is the first device. For another phone,
create a link from the desktop (connection badge → **Paired devices** →
**Connect a device**), from the phone (**Settings** → **Devices** → **Connect
another device**), or with `vibestudio remote pair-device`.

With no managed server running, `vibestudio mobile pair --port 3030` pairs in
the foreground. From a source checkout, run `pnpm build`, then
`pnpm cli mobile install --launch`.

### Server flags

| Flag                                 | Description                                              |
| ------------------------------------ | -------------------------------------------------------- |
| `--port PORT`, `--gateway-port PORT` | Hub ingress port (environment override or `3030`)        |
| `--app-root PATH`                    | Application root (the installed package root by default) |
| `--relay-url URL`                    | Explicit canonical HTTPS Iroh relay (repeatable)         |
| `--dev`                              | Development mode                                         |

There's no `--host`, `--public-url`, `--protocol` or TLS flag; public ingress
was removed in favor of Iroh. OAuth and webhook callbacks go through the
callback relay (`VIBESTUDIO_RELAY_URL`).

The public server is always a hub. Clients pair with the hub, choose a
workspace, and connect to `/_workspace/<name>`. Workspace flags are reserved
for internal child runtimes and the public server rejects them.

## Development

Requires Node.js 22.19+, pnpm, and the normal Electron system libraries.
Bootstrap rejects unsupported Node.js versions before installing dependencies.
If you use nvm, run `nvm install` and `nvm use` from this checkout to select
the version pinned in `.nvmrc` before running `pnpm bootstrap`.

Linux contributors running Electron E2E tests also need the isolated X11/native-input
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
pnpm dev:templates setup # clone and remember the Base, Personal and System templates
pnpm start           # build + start Electron with normal desktop semantics
pnpm dev             # launch a fresh disposable development workspace
pnpm dev:production  # fresh disposable instance using the pinned production templates
pnpm dev:iroh        # build + start a local hub, then connect through Iroh
pnpm cli --help      # run the CLI live from TypeScript
pnpm server:live --help
```

### Sandbox profiles for a source checkout

On Ubuntu 24.04+, install AppArmor profiles for your checkout's workspace
launcher and Electron binary:

```bash
sudo scripts/install-dev-apparmor-profile.sh
```

A profile attaches to an absolute path, so a developer tree installs its own
instead of using the packaged ones. The Electron profile also covers every
development client the desktop launches, since clients reuse the same
executable from a private directory. Re-run the script after moving the
checkout. See [Linux sandbox setup](docs/linux-sandbox-setup.md) for what each
profile permits, how to recognise each failure, and how to run a desktop client
on a headless host.

The remote-transport suite uses real native Iroh endpoints and the current
one-time root-device invite contract. Run it with `pnpm test:remote-transport`.

### Host and workspace-template co-development

Base, Personal and System are independent, publishable workspace-template
repositories. Personal and System each declare Base as a normal template
dependency. Configure their sibling checkouts once per host clone:

```bash
pnpm dev:templates setup
```

The command creates a collection root containing `base/`, `personal/`, and
`system/`, then records that root in local Git configuration as
`vibestudio.templateCheckouts`. Developer launchers checkpoint each repository
as authored. They do not build role projections or read a shared superset.

Tracked and untracked non-ignored edits are included in those checkpoints, so
local template work can be launched before it is published.

Publishing a workspace template is an explicit Templates operation inside
Vibestudio. The workspace's `meta/vibestudio.yml` records its dependencies;
publication retains those declarations and excludes repositories supplied by
them. No server writes a composed workspace back into a source checkout.

To exercise the shipped experience instead, run `pnpm dev:production`. It
ignores (but does not change) the local development selection, creates a fresh
disposable instance, and acquires the exact template pins packaged with the host.
`pnpm server:production` provides the corresponding headless server workflow.

Useful configuration commands:

```bash
pnpm dev:templates status                 # show all three checkouts
pnpm dev:templates use /other/templates   # select a root containing base/personal/system
pnpm dev:templates path                   # print the selected collection root
pnpm dev:templates clear                  # require setup again
```

`--template-checkouts PATH` and `VIBESTUDIO_TEMPLATE_CHECKOUTS=PATH` are
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
`pnpm dev` uses a disposable instance root by default.

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
recently used registered workspace, creating `default` from the selected Base
template only when the profile has no workspace yet. It does not expose
developer instances. `pnpm dev` launches into a disposable
instance root — its own identity, catalog and workspaces under a temporary
directory — and always stops its hub on quit, so the whole instance is removed
with it. Persistent and disposable launches therefore exercise the same
application; only where that instance's state lives, and how long it lasts,
differ.

`pnpm server:live` remains the explicit persistent `source` instance for CLI
and long-lived server work. Add `--instance NAME` for another persistent
isolated instance, or `--ephemeral --instance NAME` for a disposable parallel
test hub. Named and disposable instances never write their workspace
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

MXC executor payloads come from the pinned `@microsoft/mxc-sdk` 0.8.0 package. Workspace cleanup also runs through MXC; no Rust toolchain or app-owned native helper is required. Source builds stage the executor for the current process architecture; release packaging consumes the tested CI artifacts separately, so a local host build cannot replace another platform's release binary. Before staging the headless server npm package or installers, download the native artifacts from a successful CI run:

```bash
gh run download RUN_ID --pattern 'native-isolation-*' --dir native/isolation/artifacts
```

The headless server npm package requires the complete Linux x64/ARM64, Apple Silicon macOS, and Windows x64 matrix. An Electron installer requires its requested target. Packaging rejects missing, stale, wrong-architecture or checksum-mismatched MXC inputs and restores executable permissions after artifact transfer. Build manifests describe the pre-signing input bytes; platform signing remains a separate installer step. Windows on ARM uses an x64 Node/Electron process under Windows 11 emulation; a native Windows ARM64 process is unsupported by the current workerd dependency.

The supported MXC release targets are Linux x64/ARM64, Apple Silicon macOS, and Windows x64. Native macOS/Windows enforcement and packaged-app conformance must pass on their respective systems before release. See [native isolation CI](docs/native-isolation-ci.md) for the acceptance matrix, standard-user checks, installer gates, and Windows 11 runner setup.

Native workspace commands and linked Claude use normal networking through stock MXC. Linux requires bubblewrap, with no slirp4netns dependency. Workspace trash deletion remains offline. The existing application egress proxy and its approvals are unchanged. Windows AppContainer may restrict host-loopback access; native Windows validation remains a release gate.

Windows builds include MXC's `wxc-host-prep.exe` alongside the executor so its OS-preparation diagnostics refer to an installed tool. Preparation requiring elevation remains an explicit administrator operation; startup never applies it silently.

### Scripts

- `pnpm dev` - Build and start in development mode with DevTools
- `pnpm bootstrap` - Install the complete host and userland workspace graph
- `pnpm dev:iroh` - Build, start an isolated local hub, and launch Electron through Iroh
- `pnpm build` - Production build
- `pnpm stage:server-npm` - Build and stage the optional headless server npm package under `dist-packages/server/`
- `pnpm setup:npm-token` - Save the local token for manual headless server npm releases
- `pnpm publish:server-npm` - Build, stage, dry-run, publish, verify, and install-smoke the headless server package
- `pnpm publish:server-npm:staged` - Reuse the staged server package for an auth-only publish retry
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
fresh root-bootstrap `vibestudio://connect` link from the hub ready file. It
uses a disposable instance root, like `pnpm dev`; named workspace selection
happens through the paired client, as it does in production.

### Memory diagnostics (optional)

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
