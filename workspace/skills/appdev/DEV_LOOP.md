# App Development Loop

App development uses the workspace-wide semantic VCS. Read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) before changing source. An app edit
authors a coherent work unit and appends one local application. Commit consumes
the complete local application chain; publication advances protected `main`
after semantic ancestry/integration validation, approval, and one atomic ref
update. Builds are separate source projections.

## Standard Loop

1. Call `vcs.status` and retain the exact `workingHead`. Author source through
   the managed edit/write adapter or `vcs.edit` with that basis and a stable
   command ID. Use `vcs.move`/`vcs.copy` for identity changes.
2. Run focused typechecks, tests, and the ordinary build service against the
   current context.
3. When `main` advanced, compare its exact event and integrate useful changes
   in small local steps. Test between steps.
4. Commit the complete local application chain. Split unrelated work into a
   different context instead of staging a subset.
5. Push the clean committed event through the protected publication boundary.
   An ancestry, integration, authorization, approval, or atomic-ref failure
   advances no protected ref.
6. Let the post-publication build projection derive the app artifact. Approve
   the app install/update/source-change prompt if the trusted identity changed.
7. Use the target-specific update prompt to adopt a successful new build, or
   keep the currently loaded build until you are ready.

An explicit check returns structured diagnostics but has no ref authority. A
stale or diverged publication must return to exact comparison, deliberate
semantic integration, whole-chain commit, and protected publication: observe
current `main`, compare exact state nodes, adopt/reconcile/decline incoming
changes in local steps, commit the complete chain, and retry publication.
Follow the typed recovery table in the canonical VCS skill.

In development, app reconciliation prints an app status diagnostic with source,
target, active EV, build key, source HEAD, and clean/dirty state. Here
"dirty" means the context's committed event is ahead of `main` (or its
working head carries applications) that the running trusted app build does not yet include
— not filesystem dirtiness. Set `VIBESTUDIO_APP_DEV_STATUS=0` to silence
the diagnostic, or `VIBESTUDIO_APP_DEV_STATUS=1` to force it outside
`NODE_ENV=development`.

## Approval Behavior

App approvals are unit approvals. They are about trusting the app build and its
declared capabilities, not per-call user intent.

Approval can be required when:

- a new app is declared
- app source changes
- target changes
- capabilities change
- dependencies or external dependency versions change
- React Native provider identity changes
- source ref changes

If a changed app remains in `pending-approval`, the old active app may continue
to be used until the update is approved, depending on the reconcile path.

## Update Errors And Rollback

Publication-triggered rebuilds keep the previous active app build until the new
artifact validates and is eligible for activation. If build, target validation,
or activation fails, semantic `main` remains at the published event while the
previous active build stays in use. App status becomes `error`, `apps:status`
includes the active build key and effective version that remain in use, and
`apps:lifecycle` emits `type: "update-error"` with the failure message. The
shell and mobile clients surface these events through their notification/toast
surfaces. Repair with a new semantic event; do not roll back source history to
pretend the failed publication did not happen.

Successful app updates record the replaced build in app version history and emit
`apps:lifecycle` with `type: "update-available"`. Adoption is explicit for
already-loaded clients:

- desktop Electron apps keep the current view loaded and show a notification
  with `Load update` and, when available, `Roll back`
- mobile apps show a native prompt with `Install`, `Later`, and `Roll back`
  when rollback history exists
- terminal apps restart automatically when they are already running; otherwise
  the new trusted build remains available until the host target is launched or
  `workspace.units.restart(appName)` starts it

Clients can call `workspace.units.versions(appName)` to inspect the current and
previous builds, and `workspace.units.rollback(appName, { buildKey? })` to
switch the app back to a previous trusted build. Omitting `buildKey` rolls back
to the most recent previous version.

The workspace target picker also supports pinning a host target to a retained
build or to a specific commit/ref. Use this when the latest desktop, mobile, or
terminal app is broken and the host needs to recover on a known-good version.
Pinned targets do not follow newer committed states automatically: approved newer builds
are retained in history, then the host target is restored to the pinned build.
Choose `Follow latest` in the picker to resume normal update adoption.

## Electron App Loop

For Electron apps:

- Confirm the app declares only supported Electron host capabilities.
- For shell/chrome apps, confirm `panel-hosting` is present.
- Verify panel layout, titlebar/sidebar, overlays, menu actions, notifications,
  pair-link handling, and event subscriptions.
- If the app is the shell, test with both local startup and remote startup when
  the change touches pairing or server connection state.

Common failure modes:

- shell app loaded as ordinary app view and sized like panel content
- missing `panel-hosting` blocks view service methods
- missing app event subscriber breaks shell event subscriptions
- unsupported capability rejects app loading
- app source changed outside the managed adapter, so no authored work unit was
  recorded at the working head
- unrelated work was placed in the same context even though it needed a
  separate commit boundary
- current `main` contains changes that have not been compared and integrated
- changes were committed but never published, so `main` and the active build
  did not advance

## React Native App Loop

For mobile apps:

- Keep native host bootstrap and workspace app responsibilities separate.
- Clean-install pairing must work in the shipped bootstrap before the workspace
  app bundle is available.
- Workspace mobile app should connect through native-held credentials and
  short-lived principal grants.
- Test platform-specific bundles; do not assume Android and iOS artifacts are
  always both present in dev/provider builds.
- Validate OS-level permissions and native module availability separately from
  app capabilities.

Useful smoke path:

1. Start a pairable server.
2. Install or launch a clean mobile host.
3. Open a `https://vibestudio.app/pair#...` or `vibestudio://connect?...` link.
4. Verify native bootstrap completes pairing.
5. Verify the host fetches the current platform bundle and reloads into the
   workspace app.
6. Verify the workspace app can refresh a principal grant and connect RPC.

Android emulator smoke:

```bash
node scripts/cli/mobile-smoke.mjs --platform android --avd <name>
```

iOS simulator loop:

```bash
vibestudio mobile dev --platform ios
vibestudio mobile smoke --platform ios
```

iOS shell builds require macOS + Xcode + signing configuration. Use
`vibestudio mobile doctor` to inspect signing, generated entitlements, Firebase,
and APNs provisioning. The iOS workspace bundle is still built by the server and
served over the same WebRTC pipe as Android.

Full composition smoke:

```bash
pnpm smoke:full
```

That command runs the branded desktop pairing smoke, desktop Playwright e2e, and
Android mobile smoke through the deployed signaling service, writing logs under
`test-results/full-system-smoke/`. Pass `--local-signaling` when intentionally
testing against local Miniflare/coturn instead.

## Terminal App Loop

For terminal apps:

- Expect `apps:available` with `launchMode: "terminal-process"`.
- Use `workspace.units.restart(appName)` to start or restart an available
  terminal app.
- Expect `available` when the build is trusted but no process is running, and
  `running` when the runner has spawned the process.
- Inspect stdout/stderr with `workspace.units.logs(appName)`.
- Inspect host runner/reconcile failures with `serverLog.query` (eval:
  `services.serverLog.query(...)`; app/panel/worker:
  `rpc.call("main", "serverLog.query", [{ ... }])`) or the
  `about/server-logs` live viewer; see `../server-logs/SKILL.md`.
- Test pushed updates and rollback while the terminal app is running; the runner
  should replace the process with the selected trusted build.

Terminal app source should be written as a clean Node ESM entry that reads the
runner-provided `VIBESTUDIO_TERMINAL_APP_*` environment, connects with the
provided RPC grant, and handles shutdown messages from the runner.

## Debugging Headless App State

Headless clients authenticate as paired users; there is no operator-token path
that mints a synthetic human shell. Pair the CLI with the root invite on first
boot, select a workspace, and use the normal typed services from that session.
From app, panel, worker, or eval contexts, use `workspace.units.*` for the app
process and `serverLog.*` for the host server. In eval, `services.serverLog.*`
is the convenience client; elsewhere use `rpc.call("main", "serverLog.query",
[{ ... }])`. `serverLog.query/tail/stats` is read-only and supports live
following through `server-log:append`; humans can open `about/server-logs`.

For a full terminal app smoke:

```bash
pnpm test:terminal-app-smoke
```

That command builds the app, starts an ephemeral server, launches the built-in
remote CLI terminal app, asserts it reaches `running`, verifies a pairing invite
appears in logs, and shuts the server down cleanly.

## Updating Docs And Skills

When app architecture changes, update:

- this `appdev` skill
- `skills/onboarding/WORKSPACE_STRUCTURE.md`
- `docs/trusted-workspace-units.md`
- `system-testing/SELF_IMPROVEMENT.md` if the change affects agent repair loops
