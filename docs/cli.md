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

`pnpm cli ...` runs the live TypeScript CLI through `tsx`, so CLI source changes
are picked up without rebuilding or relinking. It also sets
`VIBESTUDIO_SERVER_ENTRY=live`, so pairing and mobile-dev commands start the
standalone server from `src/server/index.ts`.

```sh
pnpm server:live --help
pnpm system-test --instance test-a doctor --approve-startup \
  --model openai-codex:gpt-5.3-codex-spark
```

`pnpm dev` and `pnpm server:live` use the same instance supervisor. A developer
instance owns one isolated hub state root: lease, server/device identity,
databases, workspaces, caches, ports, ready file, CLI credential, and CLI
sessions. User profile configuration, encrypted provider credentials, and their
encryption key remain shared, so a fresh test instance can use configured models
without copying secrets.

`pnpm dev` and `pnpm server:live` both default to the persistent `source`
instance. It is the checkout's persistent development identity: its acquired
workspace state survives restarts, but the promoted base-template repository is
immutable input and is never a publication target. The checkout-scoped instance
lock prevents the desktop and standalone launchers from accidentally owning
that identity at the same time.

`--instance NAME` selects another persistent state root. `--ephemeral` creates a
temporary root deleted after ordered shutdown; combine it with a name for
parallel testing. Every non-`source` instance is fully isolated: its protected
workspace publications remain in its own acquired workspace and are never
pushed into the promoted base-template repository. The supervisor prints
`pnpm cli --instance NAME <command>`. The instance registry is checkout-scoped,
so identical names in different worktrees do not collide. Starting or stopping
one instance never signals another.

For a server instance, the registry's process record is not readiness. The
supervisor clears the prior lifecycle marker before launch and publishes a new
marker only after the server is reachable and bootstrap CLI pairing has
completed. `pnpm cli --instance NAME ...` waits on that marker while verifying
the owning supervisor is still alive; it does not race startup, report a false
“not paired”, or impose an arbitrary RPC deadline. Supervisor exit, malformed
readiness data, and successful readiness are distinct terminal outcomes.

Electron local mode spawns the bundled `dist/server-electron.cjs` as one
**detached machine hub** (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, see
`src/main/hubProcessManager.ts`). The desktop shell pairs one global device with
that hub and asks it to route into the selected workspace child; it never starts
or authenticates a workspace child directly.

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
# disposable host with structured pairing handoff:
pnpm --silent cli remote serve --dev --ready-file /tmp/vibestudio-ready.json
```

The ready file contains the current one-time root pairing secret; protect it.
While the server has no root account, expiry atomically replaces that payload
with a fresh invite. Successful root redemption rewrites it with
`rootInvite: null`; stopping the owned server removes its temporary ready state.
Supplying `--ready-file` selects that protected handoff instead of printing the
secret to stdout, which keeps managed-service journals free of pairing links.
`--ready-file` makes pairing unattended; it does not auto-approve workspace
extensions, tool calls, credentials, or Git publication.
Source-mode `remote serve` rebuilds the internal Durable Object bundle before
startup. Its disposable `--dev` workspace does not mirror test commits back
into the source checkout.

For unattended system tests, use the system-test runner. It installs an
explicit per-test authority policy and full-auto agent configuration:

```sh
pnpm system-test --instance system-test doctor --approve-startup \
  --model openai-codex:gpt-5.3-codex-spark
pnpm system-test --instance system-test list --json
pnpm system-test --instance system-test run TEST_NAME \
  --model openai-codex:gpt-5.3-codex-spark
pnpm system-test --instance system-test stop
```

The first command reuses the selected server when one is explicitly supplied,
or creates a named ephemeral server, waits for readiness, and pairs its
instance-scoped CLI. Later commands reuse that exact instance. `stop` refuses
to terminate instances not created by this launcher.

This workflow has two explicit approval layers. `doctor --approve-startup`
accepts only the fresh workspace’s exact, version-bound `startup` install reviews
and refuses to consume any credential, userland, publication, or other pending
consent. Each spawned test agent then runs with `approvalLevel: 2` plus the
host-attested per-test authority policy. That is the supported auto-approve
system for unattended tests; the server remains faithful to normal product
boundaries, while the disposable runner carries the test authority. The
policy is resident on the test context, so agents created downstream by panel
or worker infrastructure are pinned to the same exact model, full-auto
approval level, and disabled fallback. Trusted host deputies preserve this
attestation; no RPC request can supply or widen it. The
runner’s policy is intentionally separate from remote pairing. Do not use an
undocumented `remote serve --auto-approve` flag; it is not a supported CLI
option.

Pair this terminal, choose a workspace, start the terminal app, and mint
account-bound device links:

```sh
vibestudio remote pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2"
vibestudio remote workspaces
vibestudio remote select dev
vibestudio terminal start --pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2"
vibestudio terminal start
vibestudio remote pair-device --workspace dev
vibestudio remote invite-user --handle alice --workspace dev
vibestudio remote status
vibestudio remote logout
```

`pair-device` creates another device link for the current account.
`invite-user` creates or selects an account, grants explicit workspace access,
and creates that account's first device link. Both commands require an existing
paired administrator credential.

The equivalent desktop path is connection badge → **Paired devices** →
**Connect a device**. On mobile, use **Settings** → **Devices** → **Connect
another device** and share the complete one-time link.

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all choose a workspace, ask the server to launch their selected
host target, and show the same privileged workspace-unit approval before
running workspace code. Choosing another workspace retains the same hub device
identity and replaces only the routed child reach; it does not require pairing
again.

Desktop pairing and workspace selection happen in the desktop bootstrap UI.
`terminal start` runs fully in the CLI; use `--yes` only for automation that
should approve each startup request once. It reports a heartbeat while the host
is preparing and stops after 10 minutes by default; override that deadline with
`--timeout 30s`, `--timeout 20m`, and similar durations.

CLI credentials and agent sessions are stored below
`${XDG_CONFIG_HOME:-~/.config}/vibestudio` with file mode `0600` for credential
and session files. The server's local admin token is stored separately in the
same configuration root.

## Model credentials

Connect a model provider, or renew a credential that can no longer refresh:

```sh
vibestudio model connect openai-codex
```

The CLI always uses the system browser for interactive OAuth sign-in. The
command accepts exactly one provider and no browser-selection flag; `--json`
and `--plain` follow the normal structured-output rules. Its result contains
only the provider ID and a secret-free credential summary. Authorization URLs,
callbacks, access tokens, and refresh tokens are never printed.

`model connect` currently supports providers with a canonical browser OAuth
flow, including `openai-codex`. Providers that use API keys still collect those
secrets through Model Settings; the CLI does not introduce a second secret-input
or credential-storage path.

## Remote Deploy

Deploy or manage a systemd user service on this computer or over SSH:

```sh
vibestudio remote deploy local
vibestudio remote deploy status local
vibestudio remote deploy pairing local
vibestudio remote deploy logs local
vibestudio remote deploy update local
vibestudio remote deploy remove local
vibestudio remote deploy user@host --port 3030 --signal-url wss://signaling.example.workers.dev
vibestudio remote deploy status user@host
vibestudio remote deploy pairing user@host
vibestudio remote deploy logs user@host
vibestudio remote deploy update user@host --artifact ./vibestudio-server.tgz
vibestudio remote deploy remove user@host [--purge]
vibestudio remote doctor
vibestudio remote repair-identity --workspace default --yes
```

Use `local` when the computer running the command is the server; it uses the
same installer and service lifecycle without requiring an SSH daemon. Deploy
installs a `systemd --user` unit, enables linger, and starts
`vibestudio remote serve` bound to loopback. The unit's `ExecStart` uses the
absolute path resolved from `command -v vibestudio` on the host (so it survives
nvm / user-prefix npm installs). Deploy then polls both the loopback hub and the
routed `default` workspace health endpoint and requires protected managed ready
state before running `remote doctor` against both the stable hub identity and
the default workspace reach. Pairing invites are minted by
the hub with an exact target workspace ID; their rooms remain on the stable hub
control ingress. Deploy never consumes an invite. `remote deploy pairing
<target>` reads that target's mode-`0600` managed ready file, proves it belongs
to the live hub and a healthy default workspace, and prints the current root
QR/link. `remote deploy logs <target>` is only for diagnostics.

`update` reuses `deploy` and explicitly restarts the unit, so a new build
replaces the running old binary. `remove` disables and deletes the unit; add
`--purge` to also uninstall the `@panticonic/vibestudio-server` npm package and
delete workspace-child WebRTC reaches. Hub control identity, accounts, and
device pairing remain intact; clients obtain fresh workspace reaches through
the hub after reinstall. Workspace source directories are always left intact.

`remote doctor` runs a checklist: the `node-datachannel` native addon, the
selected `identity.pem` layout (present, mode `0600`, cert+key), signaling
reachability (a real `role=answerer` room dial, not the endpoint root), and —
when a deployed unit is present on the host — the unit's active state and
gateway port. It checks the stable hub control identity by default;
`--workspace` explicitly selects one child identity. Server-only checks are
skipped, not failed, when run as a client-side preflight.

`remote repair-identity` requires an explicit `--workspace` and rotates only
that child's reach. Device pairing remains valid and clients only re-route that
workspace. Hub control identity rotation is intentionally unsupported because
that identity is account/device trust, not a replaceable reach cache; restore
its exact backup instead.

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
vibestudio agent skills [NAME_OR_REPO_PATH] [--session NAME]
vibestudio agent logs UNIT
vibestudio agent diag UNIT
```

Workspace resources are semantic reads, so `agent skills` uses the selected
durable agent session's exact context (`default` unless `--session` is given).
It fails with the corresponding `agent attach` command when that session does
not exist; it never guesses a checkout or reads the host filesystem directly.

### Headless agentic system tests

Run the canonical workspace system-test catalog directly from a paired CLI
session. Runs execute asynchronously in the session's durable EvalDO, so a
detached run can be polled or cancelled from a later CLI invocation:

```sh
vibestudio system-test doctor --approve-startup \
  --model openai-codex:gpt-5.3-codex-spark
vibestudio system-test list --json
vibestudio system-test run eval-return-value \
  --model openai-codex:gpt-5.3-codex-spark
vibestudio system-test run --category smoke \
  --model openai-codex:gpt-5.3-codex-spark
vibestudio system-test run --all --detach \
  --model openai-codex:gpt-5.3-codex-spark
vibestudio system-test runs
vibestudio system-test status <run-id> --wait
vibestudio system-test wait <run-id>
vibestudio system-test inspect <run-id> --json
vibestudio system-test trajectory <run-id> <test-name> --full --json
vibestudio system-test rerun <run-id>
vibestudio system-test cancel <run-id>
```

Completed runs exit nonzero for validation failures, session errors, or
unexpected tool failures while still returning the run ID. Local metadata and
mode-`0600` artifacts default to
`${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/`; pass
`--out-dir` to choose another artifact root; each run gets its own subdirectory.

The CLI control plane never holds one RPC open for a suite's lifetime. A sealed
runner starts the durable eval and returns immediately; status, live inspection,
terminal result retrieval, result acknowledgement, and cancellation are
separate short operations addressed by the same run ID. Long model turns and
fixture cleanup therefore do not depend on an HTTP request staying open.

Each named agent session has one durable eval scope. `inspect` and `trajectory`
prefer the run's retained terminal heartbeat packet, so a completed run can be
diagnosed without queuing behind its still-unwinding eval work. When a restart
requires the durable-record fallback, reconstruction stays FIFO and read-only,
with a 30-second execution deadline once admitted. Separate named server
instances isolate workspace state; separate named agent sessions provide truly
parallel eval scopes within an instance.
Exact test names are used to avoid accidental substring expansion.

The default system-test route uses `openai-codex:gpt-5.3-codex-spark` and falls
back to `openai-codex:gpt-5.6-luna` at `low` thinking effort only when Spark
terminates with `usage_limit_terminal`. `doctor` checks both models, every
spawned workspace agent receives the same exact route, and run metadata records
it. This includes auxiliary agents created inside panel and worker contexts:
the host replaces their model, approval, and fallback configuration with the
case policy. Other provider failures remain visible and do not activate Luna.

Passing `--model REF` deliberately selects a single-model diagnostic run and
disables the default fallback. Keep explicit model overrides in automation only
when the model choice itself is part of the experiment.
Each system-test case has a 10-minute wall-clock deadline. Pass
`--test-timeout-ms N` to override that budget; multi-phase tests share one
deadline. A timeout produces a terminal errored result with captured
diagnostics and cleanup evidence.

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
`status`, `remote set`, `remote rm`, `enable`, `push`, `pull`, `publish`, `import`,
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

`vcs git pull` and `vcs git import` stop at a committed semantic candidate;
they do not advance protected `main`. Import results also contain required
`semanticEvidence` from the same atomic semantic transaction: the application,
import work unit, canonical snapshot revision/digest, and admitted repository
IDs. Use `--json` when a CLI agent needs the complete identity-joined evidence.
Human import and pull output still names the repository/branch, exact observed
commit, whether the semantic snapshot changed, candidate context/event, the
fact that protected main is unchanged, and the complete next workflow. While
`vcs git status` reports `integration-required`, use
the ordinary semantic compare/merge/check/commit workflow and publish
explicitly. Outgoing export and Git push remain blocked until that candidate is
accounted for.

Credential selection is explicit: omit both flags to use the declaration's
logical credential binding, or anonymous transport when no logical credential
is declared; pass `--credential ID` for a one-call concrete override, or pass
`--anonymous` to require anonymous transport. Durable remotes reject embedded
credentials, query parameters, and fragments. `vcs git pull --dry-run` uses a
isolated temporary checkout and mutates no managed Git or semantic state. A missing
configured remote branch is reported distinctly from fetch/auth failure; push
to create it or update the declaration. Related force updates show an exact
overwrite count, while unrelated histories deliberately have no comparable
count.

See [git-upstream.md](./git-upstream.md) for the two-layer model, approvals,
`git.upstreams` config, immediate reconciliation, and divergence repair
workflow.
