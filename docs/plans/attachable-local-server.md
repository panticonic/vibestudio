# Attachable Local Server — Big-Bang Implementation Plan

Goal: the desktop shell is **always a paired device of a workspace server**. One auth
model (device pairing + refresh credentials), one session model, two transports:
loopback WS (local) and WebRTC (remote). Local workspace servers are detached OS
processes that outlive the app; the app attaches on launch if one is healthy, spawns
otherwise. Quitting the app detaches; stopping a server is an explicit decision
(prompted when background work is running). Electron IPC mode in the server is
**deleted**, not preserved. No backward compatibility, no migration shims — this is a
single change landed together.

Verified ground truth this plan is built on:

- The WS auth path already accepts pairing codes and `refresh:<deviceId>:<token>`
  transport-agnostically — `createPairingRedeemer` (`src/server/services/authService.ts:96`)
  is wired into `RpcServer.handleAuth` (`src/server/rpcServer.ts:857`), and a freshly
  redeemed pairing returns `deviceCredential` on the `ws:auth-result` (`rpcServer.ts:973`).
- `GET /healthz` is unauthenticated and returns `serverId`, `serverBootId`,
  `workspaceId` (`src/server/gateway.ts:216`, provider `src/server/index.ts:3365`).
- The standalone server already writes a ready file with `gatewayPort`, `pairingCode`,
  `serverId`, `serverBootId` (`src/server/index.ts:3860-3894`) and mints startup pairing
  codes whenever it is not in IPC mode (`index.ts:3572`).
- `open-external` is ALREADY an RPC event (`external-open:open`,
  `src/server/services/externalOpenService.ts:21`; shell bridge
  `src/main/serverEventBridge.ts:73`). No work needed there.
- Only three capabilities still ride the Electron IPC channel: the `ready` handshake
  (shell/admin tokens), `workspace-relaunch`, and `credential-session-capture-request`
  (+ `workspace-list-request`, which standalone mode already answers itself).
- The loopback client (`src/main/serverClient.ts`) does NOT surface the auth-result's
  `deviceCredential`; the WebRTC client does (`webrtcServerClient.ts:64` `onPaired`).
- There is no server-wide "is background work active?" surface; the closest signal is
  evalDO's `inFlightRuns`/`durableRunActivity` used by its idle-eviction alarm
  (`src/server/internalDOs/evalDO.ts:757`).
- The server spawn is `utilityProcess.fork` today (`src/main/serverProcessManager.ts:244`);
  the `ELECTRON_RUN_AS_NODE=1` spawn pattern already exists in the repo
  (`packages/shared/src/npmInstaller.ts:55`, `packages/process-adapter/src/index.ts:80`).

---

## 1. Server: delete IPC mode entirely

File: `src/server/index.ts`

Remove every `ipcChannel` branch and the channel itself:

- `detectServerIpcChannel` + channel setup and the `ipcRequest` helper (~lines 118–192).
- `centralData` is now ALWAYS constructed (line 457) — the server owns workspace
  metadata in all modes.
- Hub-vs-workspace gate keys only on `VIBESTUDIO_FORCE_WORKSPACE_SERVER=1` (line 459).
  That env var remains the private contract for desktop-spawned and hub-managed
  workspace servers. `requireExplicitSelection` (line 490) becomes
  `FORCE_WORKSPACE_SERVER === "1"`.
- `ready`/`error` `postMessage` (lines 498–499, 3803–3813, 4033–4034), including
  `tokenManager.ensureToken("electron-main", "shell")` — the shell no longer gets a
  pre-issued bearer.
- The IPC `shutdown` message handler and the **disconnect suicide**
  (`ipcChannel.onDisconnect(() => shutdown())`, lines 3963–3970). SIGTERM/SIGINT
  handling stays; it's now the only signal path.
- `requestRelaunch` (2724) and `requestWorkspaceList` (2729), `isIpcMode` (2752),
  admin-token-persistence gate (1163, 1946), startup-pairing gate (3572 — always mint),
  ephemeral-delete gate (3948 — server always owns ephemeral deletion now).

The ready-file payload gains `pid: process.pid` and `version` (app/server build
version — reuse whatever the detailed `/healthz` reports).

Verify during implementation: startup pairing codes are minted by `deviceAuthStore`
independently of the WebRTC ingress (no `VIBESTUDIO_WEBRTC_SIGNAL_URL` required). If
any coupling exists, break it — loopback pairing must work with WebRTC off. Keep the
pairing-TTL exit ("server exits if unused"): it is the natural cleanup for a spawn the
desktop never managed to redeem.

## 2. Server: RPC-plane replacements for the two remaining IPC capabilities

### 2a. `workspace-relaunch` → server event

`workspaceService.select` (`src/server/services/workspaceService.ts:581`) stops calling
`requestRelaunch` and instead emits a `workspace:relaunch-requested { name }` event via
`EventService`, exactly on the `externalOpenService` pattern
(`src/server/services/externalOpenService.ts:21-28`). Delete the `requestRelaunch` dep
through `panelRuntimeRegistration.ts:1102` and the dep type at
`workspaceService.ts:153`. Update `workspaceService.test.ts:565-575`.

### 2b. `credential-session-capture` → server→shell RPC roundtrip

Replace the `ipcRequest("credential-session-capture-request", …, 300_000)` call inside
the credential service wiring (`src/server/index.ts:1569-1591`) with:

- Server emits `credential:capture-request { captureId, kind, signInUrl, cookieNames,
  browser, completionUrlPattern }` targeted at connected shell-kind principals.
- New credential service RPC method `completeCapture(captureId, result | error)`,
  callable only by `callerKind === "shell"`.
- Server keeps a pending-capture map with the same 300s timeout.
- If **no shell client is connected** (RpcServer knows connected callers by kind), fail
  immediately with a typed `desktop-attachment-required` error so background agents get
  a clear, actionable failure instead of a 5-minute hang.

### 2c. `workspace-list-request` → deleted

Standalone mode already answers from its own `CentralDataManager`; now that is the only
mode. Note: `~/.config/vibestudio/data.json` becomes writable by both the desktop
(chooser bookkeeping) and the server. Whole-file last-writer-wins is acceptable for a
single-user pre-release product; do not build coordination for it.

## 3. Server: `hostLifecycle` service (activity + shutdown + idle exit)

New `src/server/services/hostLifecycleService.ts`, registered like any other service:

- `getActivity(): { activeRuns: number, oldestStartedAt: number | null }` — aggregate
  agent/eval run activity. Do NOT query DOs on demand; add a lightweight in-process
  activity registry that the evalDO host/dispatch layer updates as runs start/finish
  (the data already exists as `inFlightRuns`/`activeRunIds`/`durableRunActivity`,
  `evalDO.ts:234, 757-779`). Design the registry so other work sources (builds, future
  schedulers) can report into it.
- `shutdown()` — shell-gated graceful shutdown; calls the same `shutdown()` as SIGTERM
  (`src/server/index.ts:3917`).
- **Idle auto-exit** (workspace-server mode only): when there are no connected
  shell/app clients AND `getActivity().activeRuns === 0` continuously for
  `VIBESTUDIO_IDLE_EXIT_MS` (default 30 min; `0` disables) → `shutdown()`. This is the
  garbage collector for detached servers: workspace switches and "keep running" choices
  that go idle never accumulate orphans, so no other reaping mechanism is needed.

## 4. Desktop: loopback client gains `onPaired`

`src/main/serverClient.ts` + `wsClientTransport`: surface the `ws:auth-result`'s
optional `deviceCredential` and add an `onPaired?(cred)` option to
`createServerClient`, mirroring `webrtcServerClient.ts:64`. The server already sends it
(`rpcServer.ts:973`); today the loopback client discards the auth-result payload
(`serverClient.ts:168`). This is the enabler for pairing-code bootstrap over loopback.

## 5. Desktop: credential store + attachment record

- Extract the encrypted-single-file mechanics of `remoteCredStore.ts` (safeStorage
  cipher seam, fail-loud save, 0600, corrupt-tolerant load) into a shared
  `encryptedJsonStore.ts`. `webrtc-remote.json` keeps its shape on the new helper.
- New `localServerCredStore` → `userData/local-server-creds.json` (encrypted):
  `Record<workspaceId, { deviceId, refreshToken, serverId, pairedAt }>`.
- Attachment record lives on `WorkspaceEntry` in `packages/shared/src/centralData.ts`
  (`types.ts:342`): optional
  `localServer?: { gatewayPort, pid, serverId, serverBootId, startedAt, version }`,
  with set/clear helpers on `CentralDataManager`. The existing prune-on-missing-dir
  semantics are exactly right for this record.

## 6. Desktop: `LocalServerManager` replaces `ServerProcessManager`

New `src/main/localServerManager.ts`; delete `src/main/serverProcessManager.ts`.

**`attachOrSpawn(mode)`**:

1. Read `localServer` record for the workspace. If present:
   `GET http://127.0.0.1:{gatewayPort}/healthz` → require `ok`,
   `serverId === record.serverId`, `workspaceId === mode.workspaceId` (this makes pid
   reuse and port collision harmless — never trust the pid alone).
2. Version mismatch (running server ≠ current app build): stop the server
   (`hostLifecycle.shutdown()`, fallback SIGTERM) and fall through to spawn. No prompt,
   no compatibility window — pre-release policy is "converge to current version".
3. Healthy match → load refresh credential → return an attach target
   `{ gatewayPort, authToken: "refresh:<deviceId>:<refreshToken>" }`.
4. Stale/absent → clear record + credential, spawn.

**`spawn(mode)`**:

- `child_process.spawn(process.execPath, ["--max-old-space-size=<N>", serverBundle],
  { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env: {
  ELECTRON_RUN_AS_NODE: "1", VIBESTUDIO_FORCE_WORKSPACE_SERVER: "1",
  VIBESTUDIO_WORKSPACE_DIR, VIBESTUDIO_APP_ROOT, ESBUILD_BINARY_PATH (packaged),
  VIBESTUDIO_WORKSPACE_EPHEMERAL / VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS as today,
  ...ready-file arg } })`, then `unref()`. Bundle path from
  `getServerProcessEntryPath()` (`src/main/paths.ts:266`); the as-node pattern is
  proven at `npmInstaller.ts:55`.
- Server logs go to `<wsDir>/state/logs/server.log` (truncate on spawn) — stdout no
  longer flows through the app.
- Ready file at `<wsDir>/state/server-ready.json`; poll for a write newer than spawn
  time, with timeout. On ready: connect loopback WS with `authToken = pairingCode`,
  `onPaired` persists the device credential, then write the attachment record.

**Supervision** (only while the app is attached): on WS disconnect, probe `/healthz` +
pid; if the process is dead, respawn with the existing restart-throttle semantics
(5 restarts/60s → `onCrash` → relaunch app, `serverProcessManager.ts:178-197` logic
carries over). A detached server with no app is unsupervised by design — idle-exit and
stale-record cleanup on next launch cover it.

**`stop()`**: `hostLifecycle.shutdown()` RPC → fallback `SIGTERM` pid → timeout
`SIGKILL`; clear attachment record + credential entry.

## 7. Desktop: `serverSession` rewrite

`src/main/serverSession.ts` local arm (lines 121–277):

- Replace spawn-and-token flow with `LocalServerManager.attachOrSpawn()` +
  `createServerClient(port, authToken, { onPaired, refreshAuthToken: () =>
  "refresh:<…>" from localServerCredStore, … })`. Reconnect and credential rotation now
  work identically to the remote path (`persistRotated…` equivalent for local).
- `SessionConnection`: **delete `adminToken` and `shellToken`**. Add
  `serverOwnership: "desktop-local" | "external"` (remote = external) and
  `localServerManager` in place of `serverProcessManager`.
- CDP host auth (`src/main/index.ts:2128`, `conn.shellToken || conn.adminToken`):
  replace with a bearer obtained by exchanging the stored refresh credential via the
  loopback `/refresh-shell` endpoint (referenced in `authService.ts:85`; implementer
  verifies the exact route) or, if cleaner, a new `auth.issueShellBearer` RPC. CDP
  remains local-only, as today (remote already runs with empty tokens).
- Delete `onIpcRequest`/`onRelaunch` wiring (`serverSession.ts:174-204`). Instead,
  `serverEventBridge` subscribes:
  - `workspace:relaunch-requested` → `relaunchApp(workspaceRelaunchArgs(name))`.
  - `credential:capture-request` → existing `handleCredentialSessionCaptureRequest`
    (`src/main/index.ts:699`) → `credential.completeCapture` RPC. The handler moves
    unchanged; only its transport changes.

## 8. Desktop: quit and workspace-switch policy

`src/main/index.ts`:

- New `before-quit` step (before the existing `will-quit` cleanup), when
  `serverOwnership === "desktop-local"` and not ephemeral:
  - Query `hostLifecycle.getActivity()` with a short timeout (~250ms; on failure treat
    as inactive).
  - `activeRuns > 0` and no remembered preference → `dialog.showMessageBox` (first use
    of it in main — none exists today): **"Keep server running for background tasks?"**
    [Keep running] / [Stop server], `checkboxLabel: "Remember my choice"`. Use
    preventDefault + re-quit, same pattern as the will-quit cleanup.
  - Inactive → stop, silently. (An idle server would idle-exit anyway; stopping is the
    honest default.)
  - Remembered preference persists in `centralData` (global, not per-workspace).
- `will-quit` (`index.ts:2607-2690`): panel/client cleanup unchanged; then
  `decision === stop ? localServerManager.stop() : /* leave process, keep record */`.
- **Ephemeral workspaces never detach**: always stop; the SERVER now owns
  ephemeral-workspace deletion (its standalone-mode delete at `index.ts:3948` is now
  unconditional), so delete the desktop-side `cleanupDevWorkspace` duplication.
- **Workspace switch** (relaunch): treated as quit-with-keep — leave the old server
  running, no prompt; idle-exit reaps it. Switching back attaches instantly.
- `window-all-closed → app.quit()` unchanged.

## 9. Startup precedence (unchanged shape, new local arm)

`establishServerSession`: fresh pairing → stored remote → **local attach-or-spawn**.
The chooser keeps resolving local-vs-remote; the "local" choice now attaches when
healthy. Connection status UI already exists; optionally badge "reattached".

## 10. Deletions summary

- `src/main/serverProcessManager.ts` — whole file (replaced by `localServerManager.ts`).
- `src/server/index.ts` — all `ipcChannel` code, `ready`/`error` postMessage,
  disconnect suicide, `requestRelaunch`, `requestWorkspaceList`, `isIpcMode`,
  `ensureToken("electron-main","shell")`.
- `ServerPorts.adminToken/shellToken` and `SessionConnection.adminToken/shellToken`
  plumbing end-to-end.
- `serverSession.ts` IPC handler wiring; desktop-side ephemeral deletion.

## 11. Tests

- **Update**: `workspaceService.test.ts` (relaunch → event emission);
  `serverClient.scoped.test.ts` (+ auth-result `deviceCredential`/`onPaired`);
  `remoteCredStore` tests (against extracted `encryptedJsonStore`); any
  startupMode/serverSession tests touching tokens.
- **New**:
  - `localServerManager` unit tests: attach happy path, serverId mismatch → spawn,
    dead pid + stale record cleanup, version mismatch → stop-and-respawn (mock
    `/healthz` + ready file).
  - Integration: spawn a real workspace server detached, pair via loopback pairing
    code, disconnect, reconnect via refresh credential, assert same `serverBootId`.
  - Credential-capture RPC roundtrip incl. the no-shell-connected fast-failure.
  - Idle-exit timer unit (clients present / activity present / both absent).
  - Quit-decision matrix unit (activity × remembered-choice × ephemeral).
- **Manual e2e**: launch → spawn+pair → start a long agent run → quit choosing Keep →
  verify run continues (server log) → relaunch → attaches (same bootId) → quit
  choosing Stop → process gone, record cleared.

## 12. Docs

`README.md`, `docs/cli.md` (local-mode description), `STATE_DIRECTORY.md` (new files:
`local-server-creds.json`, `state/server-ready.json`, `state/logs/server.log`,
`data.json` `localServer` field), architecture notes for the capture flow.

## Suggested build order (single PR — order is for the implementer's own sanity, not gates)

1. Pure additions: `onPaired` on the loopback client, `encryptedJsonStore` +
   `localServerCredStore`, attachment record on `WorkspaceEntry`.
2. Server: relaunch event, capture RPC, `hostLifecycle` service + idle-exit,
   ready-file `pid`/`version`.
3. Desktop: `LocalServerManager`, `serverSession` rewrite, quit policy, event-bridge
   subscriptions.
4. Deletions: IPC mode, token plumbing, `serverProcessManager.ts`.
5. Test/docs sweep; full suite + manual e2e.

## Known risks (handle inside this change, none are gates)

- **Pairing without WebRTC**: confirm startup pairing codes mint with the ingress off;
  fix if coupled (§1).
- **Windows detached spawn**: `detached: true` + `unref()` + `windowsHide`; verify the
  child escapes Electron's process teardown on all three platforms.
- **`data.json` dual-writer**: accepted last-writer-wins (single user, whole-file
  writes). Revisit only if it bites.
- **Port squatting**: harmless — the `serverId` check on `/healthz` rejects imposters
  and falls through to a fresh spawn on a new port.
