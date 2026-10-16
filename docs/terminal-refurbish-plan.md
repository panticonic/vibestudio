# Terminal apps refurbishment plan

Status: proposal (2026-10-12). Supersedes the operational parts of
`docs/terminal-apps.md`, which will be rewritten in phase 5.

Goal: one command starts (or attaches to) a server and opens a full-featured
terminal browser in the current TTY, and the Base template ships a terminal chat
app with parity with the chat panel's agentic protocol features.

## 1. Where things stand

The terminal stack cannot be reached from any current workflow:

- **It cannot get a TTY.** Terminal apps are spawned by the workspace child
  (`src/server/terminalAppRunner.ts`), and the hub spawns that child with
  `stdio: ["ignore","pipe","pipe","ipc"]` (`src/server/hubServer.ts` ~2941).
  So `vibestudio.app.interactive` + `stdio:"inherit"` gives the app
  `/dev/null` and a pipe, and terminal-browser exits on its `isTTY` check. Even
  if it worked, it would draw on the _server's_ terminal and could never work
  remotely. `vibestudio terminal start` only asks the server to start the app.
- **It is not installed.** `system/meta/vibestudio.yml` does not list
  `apps/terminal-browser`; `hostTargets.terminal.app` is `apps/remote-cli`, a
  headless status printer whose output only reaches supervision logs.
- **It has no session app.** `TerminalBrowser.tsx:32` hardcodes
  `workers/terminal-chat`, which was deleted in host commit `f59064794`
  (2026-08-13). No other unit declares `vibestudio.terminal`.
- **The browser itself is thin.** It has single-byte chords that steal ^A/^L/^P
  from sessions, no cursor, no scrollback, no frame coalescing, no gap recovery,
  no launcher, no reattach (every session is a fresh DO keyed by a random id),
  overlays that do not scroll, and dead code (`byTarget`, `cycle`,
  `TerminalLifecycleEvent`, duplicate `SESSION_METHODS`, `shim/node/crypto.ts`).
  The approvals overlay and install-review navigation are the good parts.
- **The shim has global state.** `terminal-shim`'s `signal-exit` and
  `terminal-size` replacements are module-global, so two sessions in one
  isolate share size and exit handlers.
- **The chat logic is in three places.** `useChatCore`/`useChannelMessages`
  (React, full parity), `quickfire-core/session` (React hook, subset), and
  `HeadlessSession` (moved to `system-testing`, resident delivery only, ignores
  `message.delta` signals and credential rows). None can drive a non-React
  client with parity.
- **Two pairing paths exist.** The dev supervisor auto-pairs
  (`src/dev/bootstrapInstanceCli.ts`); the product `remote serve` only prints the
  invite.
- **Some scripts and docs are broken or stale.** `terminal:jig` and
  `terminal:jig:smoke` look for `panels/terminal` in `system` instead of `base`.
  `docs/terminal-apps.md` describes the deleted worker and the pre-hub launch
  model.

## 2. Design

### 2.1 The terminal browser is a client, not a server process

The terminal browser is the TTY counterpart of the Electron shell: a trusted
client-device app that the server builds and the client runs. It is not a child
process of the server. This mirrors the existing `native-bootstrap` model for the
React Native app:

1. The CLI resolves `hostTargets.terminal.app` and runs the existing launch gate
   (approvals prompt) _before_ taking raw mode.
2. It fetches the built `primary` `.mjs` artifact through the app-artifact URL
   (`packages/shared/src/appArtifacts.ts`).
3. It obtains an app-principal connection grant through
   `POST /refresh-principal-grant`. `PrincipalGrantTarget` gains
   `"terminal-app"` beside `"react-native-app"`
   (`src/server/hostCore/auth/principalGrants.ts`), so the device credential is
   exchanged for the app identity that `HostService` owner checks rely on.
4. It runs the artifact in-process or as a child with `stdio:"inherit"`, giving
   it the gateway URL, grant and transport the CLI already uses (loopback or
   Iroh). This works for local and remote servers alike.

That makes the whole server-side terminal process path obsolete, so it is
removed rather than kept beside the new one: `TerminalAppRunner`,
`TerminalAppRuntime`, the `terminal-process` launch mode, `app.interactive`, the
process-adapter `stdio:"inherit"` option (if nothing else uses it), and
`apps/remote-cli` with its `VIBESTUDIO_TERMINAL_APP_*` env contract.
`hostTargets.terminal.app` points at `apps/terminal-browser`.

### 2.2 Terminal apps stay sandboxed server-side workers

Userland terminal apps, the chat included, remain workerd Durable Objects that
render Ink through `terminal-shim`. Their bytes never reach the real TTY: the
browser parses them into a VT grid. This is the terminal analogue of panels
(sandboxed userland) under the shell (trusted chrome), and it keeps the
approvals overlay unspoofable.

Client-side execution was considered and rejected (2026-10-12):

- **A second workerd on the client** is excessive.
- **Node `vm` is not a security boundary.** Node's docs say not to run
  untrusted code in it. Any host object bridged into the context (streams, the
  RPC bridge) reaches the host `Function` constructor and from there `process`.
  The host here is the trusted browser, which holds the device credential and
  `approvals.decide`, and Base code is agent-editable, so a compromised app
  could approve its own requests. `vm` also gives no resource isolation: a busy
  loop freezes the approvals overlay.
- **Node's permission model** is likewise documented as not a defence against
  malicious code.
- **OS sandboxes, `isolated-vm`, QuickJS-in-WASM and headless Chromium** are
  each a large per-platform or re-implementation cost.

Changes to the session model:

- **Discovery.** The `vibestudio.terminal` manifest block gains `title`,
  `description` and optional `icon`. The browser's launcher lists every unit
  that declares it, using `build.listUnits`/`workers.listSources`. The
  hardcoded source goes away.
- **Durable sessions.** DO keys are stable session ids, and a server-side
  per-user session registry records id, source, title, contextId and
  last-attached. Detach is not close: the DO keeps its state and, on
  reattach, gets `startSession` + `repaint`. The browser offers resume across
  restarts and devices, like tmux. A DO stays resident only while a browser is
  attached; detached sessions are evicted and rebuild their view from durable
  state (the channel, its own storage) on reattach. This repairs the current
  persistent-DO + heartbeat arrangement.
- **Context.** A new session gets a fresh context, matching panel semantics,
  passed as `StartTerminalSessionArgs.contextId`.
- **Protocol cleanup.**
  - Keep one method table (`terminalSessionRpcMethods`) and delete
    `SESSION_METHODS`.
  - A `seq` gap triggers `repaint` instead of silently dropping frames.
  - Add host methods `setAttention`, `openUrl` and `requestFile`, all
    user-confirmed.
  - Remove `setRawMode` and the unused lifecycle types.
- **Shim.** Make size and exit state per session, and drop `node/crypto.ts`.

Accepted cost: every keystroke travels to the DO and back before it is echoed.
That is negligible on loopback and noticeable on a remote Iroh link. Phase 3
measures it with the native profiling system. If it proves unacceptable, the
fix is a protocol-level capability (for example host-side line editing for a
declared input region), not a second rendering path.

### 2.3 The browser renders everything as grids

One compositor owns the TTY. Each session already becomes a headless xterm
grid. The browser's own chrome (tab bar, status bar, launcher, approvals, logs,
help, palette) is also an Ink tree rendered into its own headless VT layer, so
the existing Ink approvals UI is kept. The compositor merges the layers into one
cell buffer and diff-paints changed cells to the real TTY:

- alternate screen, synchronized output (DEC 2026), hidden cursor except for the
  focused session's cursor;
- renders are coalesced per event-loop turn (`setImmediate`), not on a timer.

This replaces today's approach of re-rendering every session grid through Ink's
reconciler on every frame.

### 2.4 One headless chat core

Extract a framework-free `ChatSession` store into `@workspace/agentic-core`. It
exposes `subscribe`/`getSnapshot`/actions and holds the logic that currently
lives in React hooks:

- connection over `ConnectionManager`, in both `stream` and `resident`
  delivery modes;
- durable reduce, `message.delta` signals, credential-connect rows, and replay
  paging (from `useChannelMessages`);
- the outbox: send, mentions, attachments, edit, retract, undo,
  deliver-after-turn, flush and interrupt (from `useChatCore`);
- first-agent bootstrap (`ProvisionalAgentLifecycle`, deferred first message),
  installed-agent persistence and recovery (from `panels/chat/bootstrap.ts`,
  `agentLifecycle.ts`, `useDeferredAgent`, `useAgentRecovery`), with
  persistence behind an injected storage port;
- agent settings (model, thinking, fast, respond policy, approval level), fork
  lineage (`forkConversation`, rename, archive, switch), and child-task
  transcripts (from `useChildTranscript`).

Then the existing consumers move onto it, so there is still exactly one
implementation:

- `useChatCore`/`useAgenticChat` become `useSyncExternalStore` adapters;
- `HeadlessSession` (system-testing) becomes a thin wrapper and gains streaming
  for free;
- quickfire moves onto it, or a written reason is recorded for why its subset
  stays separate.

The panel's existing tests are the safety net, and this refactor lands before
any terminal chat UI.

### 2.5 Terminal chat in Base

`base/workers/terminal-chat` is a DO with
`vibestudio.terminal: { renderer: "ink", title: "Chat" }`. It runs Ink over the
headless `ChatSession` in resident delivery mode. Its `ChatHostController`
`StateArgsPort` is backed by the DO's own storage (channel name, installed
agents, agent config).

| Area             | Terminal behaviour                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript       | Markdown to ANSI (headings, lists, tables, code blocks with highlighting), streaming deltas, thinking collapsed by default, tool cards collapsible with result summaries (eval output, file-mutation diffs in colour, images as `[image]` + open), subagent/task cards expandable into the child transcript, typing indicator, receipts, retracted/edited markers, disconnect and diagnostic rows, usage-limit card with resume/schedule |
| Navigation       | Transcript scrollback with a selection cursor; act on the selected message (copy, fork here, edit & fork, expand, retry/resume); history paging via replay                                                                                                                                                                                                                                                                               |
| Composer         | Multiline editor (Enter sends, Alt/Shift-Enter for a newline), input history, `@mention` autocomplete, bracketed paste, queued-outbox view with edit/undo, Esc to interrupt, Esc Esc to flush and interrupt                                                                                                                                                                                                                              |
| Slash commands   | `/model`, `/thinking`, `/fast`, `/approval`, `/respond`, `/connect <provider>`, `/agents` (add/replace/remove), `/new`, `/resume` (chat list), `/fork`, `/forks` (tree + switch), `/title`, `/missions`, `/retry`, `/export`, `/help`; all also reachable from a `Ctrl-K` palette                                                                                                                                                        |
| Status line      | Model, thinking level, context-usage %, approval level, connection, agent busy/idle, unread forks                                                                                                                                                                                                                                                                                                                                        |
| Approvals        | Inline cards are display-only. Decisions go through the browser's trusted overlay (shellApproval queue), and the card names the key that opens it                                                                                                                                                                                                                                                                                        |
| `ask_user`       | Advertise `feedback_form` and render JSON-schema forms as terminal forms. Do not advertise `inline_ui`, action bar, `feedback_custom`, custom message-type renderers or `client_eval`, so agents fall back to text                                                                                                                                                                                                                       |
| Provider connect | Pre-agent and in-chat (`connectModelCredential`) flows use host `openUrl` on the user's machine, with the pasted-callback fallback from `src/cli/modelConnect.ts`                                                                                                                                                                                                                                                                        |
| Attachments      | Host `requestFile`: the browser reads a local path the user confirmed and sends the bytes to the session                                                                                                                                                                                                                                                                                                                                 |
| Attention        | Escalations and finished turns while unfocused call `setAttention` (tab badge, optional bell)                                                                                                                                                                                                                                                                                                                                            |
| Missions         | List/run/pause/resume via `createMissionsClient`                                                                                                                                                                                                                                                                                                                                                                                         |

Out of scope for v1: dictation (speech extension) and image rendering protocols
(sixel/kitty).

### 2.6 Terminal browser UX

- **Keys.** Use a prefix key (default `Ctrl-Space`, configurable) so sessions
  keep every other key. `prefix k` opens a fuzzy palette (launch app, switch,
  resume, approvals, logs, workspace, help, quit). Use `prefix 1..9` /
  `n`/`p` for tabs, `prefix [` for scrollback/copy mode, `prefix a` for
  approvals, `prefix ?` for help. Wheel and click focus/scroll via mouse
  reporting when the session has not requested mouse mode.
- **Layout.** A tab strip with titles and attention badges, the active session,
  and a status bar (workspace, server/connection, pending approvals, prefix
  hint). Splits come later.
- **Launcher.** It opens on start when there is nothing to resume and lists
  terminal apps and resumable sessions.
- **Approvals.** Keep the existing overlay and reducer, add scrolling, and pop
  up automatically on a new approval for the focused session (configurable).
- **Connection.** Transport recovery shows "reconnecting" and resubscribes
  through the RPC client's recovery events, instead of `process.exit(0)` on
  disconnect. This is not a retry timer. An authoritative terminal event
  (revoked credential, server gone for a local owned server) ends the app with
  the cause.
- **Workspace switch** uses the same selection as `vibestudio remote select`.

### 2.7 One command

- **Product:** `vibestudio terminal`.
  - With a reachable paired credential, it attaches.
  - With `--local` (or no credential at all, after asking once), it starts and
    owns a local server whose state lives in the default persistent local
    state directory, so chats survive.
  - Server output goes to a log file, never the TTY; the browser's logs view
    and the exit message show the path.
  - It redeems the local root invite itself, using the same function the dev
    supervisor uses: `bootstrapInstanceCli` and `pair-server` get one shared
    "redeem local root invite + route workspace" implementation.
  - It runs the launch gate, then the browser.
  - When the browser exits it stops and joins the owned server, unless
    `--keep-server` is given.
- **Dev:** `pnpm dev:terminal` (originally `pnpm terminal`) is a new
  `runInstance.ts terminal` mode. It uses the same supervisor as
  `server:live`, writes server stdio to `<instanceRoot>/logs/server.log`, and
  launches the browser from the current checkout's build.
- **`vibestudio terminal start`** is removed: the launch is the command.

## 3. Phases

Phases 1 and 2 are independent and can run in parallel with separate owners.
Phase 3 depends on 1; phase 4 depends on 2 and 3.

1. **Client-hosted browser.** Add the `terminal-app` principal grant, the CLI
   artifact fetch + local launch, and `vibestudio terminal` / `pnpm dev:terminal`
   with owned-server lifecycle and unified local pairing. Point `hostTargets`
   at terminal-browser. Delete the server-side terminal process path and
   `remote-cli`. Port `scripts/terminal-app-smoke.mjs` to drive the real
   browser under a pty.
2. **Headless chat core.** Extract `ChatSession` into `agentic-core`, migrate
   the chat panel, `HeadlessSession` and quickfire onto it, and keep the
   panel's existing tests green. Add store-level unit tests for deltas, outbox,
   bootstrap, recovery and forks.
3. **Browser rework.** Build the compositor (grids + diff paint), prefix keys,
   palette, launcher, tabs, durable session registry and reattach, gap
   repaint, cursor, scrollback, overlay scrolling, connection recovery, and the
   host methods `setAttention`/`openUrl`/`requestFile`. Do the protocol and
   shim cleanup. Measure keystroke round-trip latency locally and over Iroh.
4. **Terminal chat.** Build `base/workers/terminal-chat` per §2.5. Add a
   system test that drives it end to end (send, stream, tool approval via the
   overlay, fork, resume after browser restart).
5. **Docs and sweep.**
   - Rewrite `docs/terminal-apps.md`; update `docs/cli.md` and the README
     quickstart.
   - Sweep template skills and docs for `terminal start`, `remote-cli`,
     `interactive` and `TERMINAL_APP_*`.
   - Fix or delete `terminal:jig` / `terminal:jig:smoke` (wrong template
     path).

## 4. Decisions

Settled (2026-10-12):

1. Eradicate the legacy server-side terminal process path (`TerminalAppRunner`,
   `TerminalAppRuntime`, `terminal-process`, `app.interactive`, `remote-cli`,
   `vibestudio terminal start`).
2. `vibestudio terminal` with no paired server starts and owns a local one.
3. Migrate the chat panel onto the extracted core (§2.4), staged as below.

4. Terminal apps stay server-side workerd DOs (§2.2); client-side execution
   is rejected.

## 5. Chat core extraction: feasibility

The extraction is of moderate difficulty and can be done cleanly in stages.
About 5,400 LOC of hooks are in scope (`useAgenticChat` 1728, `useChatCore`
1232, `useChannelMessages` 642, `useDeferredAgent` 642, `useForkLineage` 738,
`useChildTranscript` 154, signals 200, `useAgentRecovery` 59). Most of it is
already an imperative state machine kept in refs, with `setState` as the
publish step. About 80% moves, becoming a ~3,000–3,400 LOC store. The
browser-only feature hooks (inline UI, message-type compilation, action bar,
feedback renderers) stay React-side and register through a method-provider
port.

Order:

1. `ChannelViewFeed`, from `useChannelMessages`. Rebase `HeadlessSession` on it
   first to prove it outside React. Delete the duplicate
   `pubsubAgenticEventToEnvelope`.
2. `ChatSession` + delivery/outbox + composer, from `useChatCore` and the
   `useAgenticChat` connect loop. Consolidate the five reconnect sources into
   one `reconnect(reason)`.
3. A method-provider port that replaces `connectionMethodsRef`, `feedbackRef`
   and `chatToolsRef`.
4. `ForkLineageStore`, child transcripts and signals.
5. `DeferredAgentMachine` (`setHostInputs` + explicit `reconcile()`), the
   riskiest piece. Its 36 existing `renderHook` tests are the spec and keep
   running through a wrapper hook.
6. `ChatHostController`, from `panels/chat/index.tsx`: model settings, agent
   list, channel bootstrap, agent add/replace/remove/persist, recovery. It sits
   over a `StateArgsPort`: `panel.stateArgs` in the panel, DO storage in the
   terminal chat.

Hard parts:

- Implicit effect ordering becomes an explicit pipeline (reduce → derive →
  react → one notify).
- StrictMode double-mount: stores live outside React and are retained or
  released with a ref count.
- Snapshot identity: keep the `sameChatMessage` merge, and add slice selectors
  instead of the 80-field context memo.

The ~100 `renderHook` tests keep passing via thin compatibility hooks, and new
tests target the store directly through the existing Node-capable
`transcriptTestHarness`.

---

## Revision (2026-10-12): terminal apps run as Node programs in the workspace native runtime

Status: approved direction (user, 2026-10-12). Supersedes the workerd-DO design for
terminal apps (§2.2, §2.3 sources, §2.5 hosting). The user authorized deleting,
moving and refactoring whatever is needed and ripping out all legacy infrastructure.

## Shape

- A **terminal app** is a workspace-bound unit: an ordinary Node program (Ink renders
  natively) that runs in a PTY owned by the Base `shell` extension, inside that
  workspace's native runtime sandbox (MXC/bubblewrap on Linux, Seatbelt on macOS,
  unconfined on Windows per docs/isolation-plan.md). It is NOT trusted code and NOT
  an `app` (apps remain trusted client units: the terminal browser, the Electron
  shell, mobile).
- The **terminal browser** (System app run by the CLI on the user's machine, already
  built) is a tmux-like client: each tab attaches to a shell-extension session
  stream, feeds the bytes into its headless VT grid and composites; keys/resizes go
  back via `write`/`resize`. Approvals overlay stays un-spoofable (bytes never reach
  the real TTY). The same sessions are visible in the desktop terminal panel.
- Protocol = standard terminal conventions: OSC 0/2 title, BEL / OSC 9 / OSC 777
  attention, OSC 8 links (browser offers to open on the user's machine after
  confirmation), OSC 52 copy. No custom attach protocol, no host methods.

## Pieces

1. **Unit kind + build.** A terminal-app manifest kind (choose location/name, e.g.
   `<template>/terminal-apps/<name>` with `vibestudio.terminal {title, description,
icon?, entry}`), built as a bundled Node ESM like `buildTerminalApp`, with native
   deps materialized like extensions (`populateExtensionRuntimeDeps`) so it runs from
   `builds/` inside the sandbox. Launcher discovery lists these units per workspace.
2. **Launch service (trusted, server-side).** One call, e.g.
   `terminalApps.launch({source, contextId?, cols, rows})`, that: resolves the unit's
   active build artifact (callers never pass paths); creates/resolves a code entity
   for the session (bound to the build's execution digest, like workers); mints a
   connection grant for that principal; opens the PTY through the shell extension
   with `command = <dist node>`, `args = [artifact]`, and the connection material
   (gateway URL, principal id, context id) — pass the grant through an inherited fd
   or one-shot channel rather than a long-lived env var where feasible, and document
   that inside one native runtime processes are not separate security domains
   (attribution, not isolation, per the platform contract). Gated by the existing
   `native.shell.execute` capability (grant scopes once/task/session/version), so
   approval is "run <app> vX in <workspace>". Approvals the app itself triggers are
   attributed to its code identity.
3. **Session ownership.** Today shell sessions are owned by exact `callerId`. Terminal
   sessions must be resumable by the same user from any device/client in that
   workspace: design ownership accordingly (e.g. user-owned sessions launched via the
   service, with the launching principal recorded) and keep the desktop terminal
   panel on the same model — one path.
4. **Attach protocol fixes (shell extension, used by panel and browser alike).**
   Framed attach with explicit cursor/epoch and gap/reset events (trimmed window,
   clearScrollback), byte-correct replay (no UTF-8 string decoding of partial
   windows), per-attacher flow control with consistent units, and a clean redraw on
   attach for full-screen apps (replay into the VT, then resize/SIGWINCH). Migrate the
   terminal panel off its reconnect loop and 150 ms watchdog onto the fixed stream.
5. **Per-session state.** A `stateArgs`-equivalent for terminal sessions held by the
   launch service, so apps (the chat's ChatHostController StateArgsPort) persist
   state server-side and a relaunch after a runtime restart resumes. One per-user tab
   registry (decide whether it is the launch service or the existing
   workers/terminal-sessions; keep exactly one).
6. **Rip out**: `@workspace/terminal-shim`, `@workspace/terminal-host-protocol`,
   `InkTerminalSessionHost`, `terminalAttach` stream protocol, Ink-in-workerd builder
   support (yoga alias plugin, wasm extraction, `isTerminalWorker`, `role:"wasm"`
   artifacts, workerdManager/universalDo wasm modules if nothing else uses them),
   `vibestudio.terminal` worker block semantics, DO-based terminal sessions. Port
   `workers/terminal-server-logs` to a terminal-app unit. Sweep docs/skills.
7. **Chat**: `base/terminal-apps/chat` (or chosen location): Node program, Ink over
   `ChatSession` (stream delivery) + `ChatHostController` with StateArgsPort backed
   by (5), RpcClient over the gateway with the minted grant.

## Known risks to check

- Extension child env holds `VIBESTUDIO_EXTENSION_RPC_TOKEN`; PTY children share the
  uid/sandbox and might read `/proc/<pid>/environ` (unverified) — check and fix.
- `requireContextAttachApproval` in the shell extension is a no-op — fix or delete.
- Sessions die with the extension/runtime; the browser must show that clearly and
  offer relaunch (state survives via (5)).

## Implementation status (2026-10-13)

The revision is implemented. See:

- [terminal-app-units-design.md](terminal-app-units-design.md) for how terminal
  apps reuse the panel model. The user chose option B (a slotless panel runtime
  whose lease is held by its PTY host).
- [terminal-apps.md](terminal-apps.md) for the user and developer guide.

The workerd terminal stack, the Ink-in-workerd builder support and
`workers/terminal-sessions` are gone.

### Upstream sync status (2026-10-13)

`terminal/apps-lifecycle` now merges host `main` (`39554dbe0`) and all configured
Base, System, System-testing and Personal mains. The formerly held-back
model-authority changes are integrated. Nothing has been merged into main or
pushed. The host merge passed the full commit gate; Base and System-testing
passed focused projected tests and composition typechecks.

### System test `terminal-chat-approval-fork-resume` (status 2026-10-13)

Passing after main integration (run `st_1093b70974ba4c53ae2d1d8045c18ab2`,
concurrency 1, zero tool failures; managed instance stopped).
The scenario no longer answers the person's approval queue. Like every other
system test, its approvals are decided by the runner's test policy. The launch
service now creates the session context with a caller that carries the
launching call's policy.

The extended scenario verifies a fork-only agent reply, switching back to the
parent, and killing/relaunching with history restored. Its remaining blocker
was harness readiness: it confused the parent fork marker with the child's
navigation confirmation, and expected an older question in the initial
50-envelope history replay. It now waits for the actual navigation confirmation
and uses PageUp to retrieve older history. The speculative input/join changes
based on the earlier delivery diagnosis were removed; no production delay,
timeout or retry was introduced.

See [terminal-handover.md](terminal-handover.md) for the full state at handover
and the open work.

### Infrastructure and polish follow-ups (2026-10-14)

Terminal launch/resume/restart now use one app/version/workspace-specific
prepared approval for user and code callers, preserving declared authority and
session ownership. Canonical requester labels no longer fall back to opaque
runtime IDs.

Native startup profiling exposed and repaired build-report inconsistencies:
reports now include declared compiler-only dependencies, and authority folding
and checkout audit apply the mobile context baseline consistently. The terminal
browser's native report now passes with an identical-key verified repeat.
No startup scheduling regression or user-visible speedup was established.

Concurrent projected Base/System typechecks passed; no cache collision was
reproduced, but compiler memory pressure was observed. The two mobile suites now
wait for visible operation completion instead of mock entry, with a controlled
pending-refresh regression and passing two-worker coverage.

Stricter history traversal also exposed a real resume defect: replay readiness
used the global history start rather than the retained window, and receipt
snapshots manufactured sequence zero. Replay now derives its retained durable
boundary and preserves sequence-less receipt identities. Eighty-eight focused
regressions pass; fresh fork/resume run
`st_27c3756523324092a716c2425cafdbce` passed in 50.957 s with zero tool failures.
Artifact review also found a completed tool card losing its name when older
start metadata arrived later. The canonical reducer now enriches that metadata
without rewinding lifecycle state; 73 protocol tests pass. The scenario's final
repeat additionally checks the originally observed tool title after resume.
That stricter run exposed transport-ready being mistaken for projection-ready
before the subscriber's retained replay drained. Ordered, non-durable replay
completion now travels on the existing event stream, with generation-owned
readiness and atomic replay/live admission. Connection cancellation joins its
reader and active callback while retaining original failures. The final Base
composition check, 101 focused replay tests and 17 connection tests pass.
Fresh strict fork/resume run `st_79a0805c43fa446597cdb60c3a3c7c24` passed in
55.440 s with zero tool failures, including original tool-title preservation.
Final `eval-cancel-run` passed in `st_4c1422d4fdc04f2a81939af8eafbc0af`,
1.515 s. All owned instances were stopped and retired. The restoration
assertion remains strict, and model context receives no replay controls.

The existing terminal smoke test supports exact installed artifacts and checks
pins, complete release validation, fresh/warm-profile readiness and clean
shutdown. Actual installed acceptance, including session restoration, still
requires published terminal template versions and a matching package; neither
the stale local installation nor current published pins represent this branch.
Publication has not been performed.

### UX completion pass (2026-10-15, source acceptance complete)

This pass follows the end-to-end review, not merely the original feature list.
Completion requires both the behavior and evidence for its adverse boundaries.

| Area            | Required outcome                                                                                 | Verification boundary                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Approvals       | Stable request identity, visible decisions, complete protected forms and actual install outcomes | Queue withdrawal/reorder, resize while deciding, secret/device-code flows              |
| Input           | Fragment-safe keyboard and paste framing; explicit legacy cancellation                           | Split ESC/CSI/paste, enhanced keyboard negotiation, exact PTY key forwarding           |
| Sessions        | One admitted lifecycle operation per session; real exit/disposal; complete rollback              | Concurrent resume, held exit, failed launch/close/restart, transport observation error |
| Connections     | Owner cancellation reaches authentication and stream creation; retirement is joined              | Held authentication/attach head/body cancellation, workspace switch and shutdown       |
| Pairing         | Device identity persists independently of later workspace selection                              | Cancel/fail after invite redemption; recover without consuming another invite          |
| Chat navigation | Durable selection commits atomically; stale actions cannot affect a new conversation             | Failed state write, delayed attachment/OAuth callbacks, concurrent navigation          |
| Composer        | Per-conversation durable drafts, staged files and unpublished queue with real delivery ownership | Navigation/relaunch, deferred model setup, queued edit/cancel/publish                  |
| History         | Full durable export/search with truthful paging and one canonical projection                     | Multi-page history, replay recovery, content beyond old display limits                 |
| Content         | Cursor-following editors and complete inspectable forms/tool results                             | Long/wide text, Unicode graphemes, resizing, large queues                              |
| Browser         | Visible focused tabs, scrollback search, full error/log inspection and ordered settings          | Overflow tabs, Unicode copy, delayed reads/saves, failed actions                       |
| Files           | Explicit client upload/download through existing context-scoped fs; no new app/client transport  | Binary bytes, immutable context, budget/identity failure, exclusive local publication  |
| Credentials     | Terminal-only OAuth and API-key setup through trusted protected input                            | No secret in chat/history/logs; withdrawal and generation ownership                    |
| Packaging       | Native public command reaches the canonical bundled CLI                                          | Installed launcher dispatch, exact packaged cold/warm startup and restoration          |

Independent source ownership is split between host lifecycle, System browser,
Base chat, and integration. Projection consumers depend on one completed host
artifact generation; host sources must remain stable during its production.
Final agentic latency journeys run alone on one uniquely owned managed instance,
after conventional checks finish. Every required check remains in the handoff
gate, and all owned instances, stream readers, transports and scratch must be
retired before claiming completion. Published-package acceptance remains a
separate authority boundary; unpublished worktrees are not published releases.

The host verification session now passes 9,439 tests (21 environment-dependent
skips) and all 12 runtime-foundation evidence cases. The full host Vitest run
and its evidence consumer own one uninterrupted evidence session: a concurrent
focused host Vitest invocation would replace the reporter fragment before the
consumer reads it. Projected template checks may run independently, with one
heavy composition compiler admitted at a time to bound host memory.

The first real source smoke found a cross-bundle RPC ownership defect that
same-module mocks could not reproduce. Client views now delegate to the client
creator's required `createView` capability, preserving its schema, transport,
and lifecycle ownership across independently bundled CLI and browser modules.
No global client registry or alternate transport path is introduced. Independent
bundle regressions cover calls, events, peers, streams and cancellation. The
smoke's readiness assertion also now requires active alternate-screen chrome;
matching words in pairing prose are not evidence that the browser started.
The failed smoke's owned processes and scratch were retired; bounded failure
evidence is retained privately. That failure required a fresh source smoke and
the extended managed fork/resume journey; both passed as recorded below.

Durable queued delivery now distinguishes publication acceptance from retained
attachment retirement. Accepted entries can only retry cleanup, never hydrate
or publish again. Restoring unresolved cleanup exposes actionable rows instead
of rejecting the whole queue; a failed release does not hide or block independent
pending messages. Failed discard cleanup is likewise non-publishable. The final
42 focused lifecycle/UI cases and Base composition/integration typechecks pass,
including restart while release still fails followed by in-place repair.

Fresh source smoke passed on 2026-10-15: the real pseudo-terminal CLI paired,
rendered active browser chrome, quit with code zero, and stopped and joined its
owned server. Owned preparation/cache scratch was removed. The preceding smoke
exposed normal quit racing the initial approval projection: observer retirement
created an unrelated error instead of preserving the browser's cancellation
reason. `DurableObservation.stop(reason)` now preserves that exact owner reason
and joins admission, read and leave independently, retaining genuine late read
and cleanup failures. The 23 host helper/consumer cases, 32 browser cases, final
host typecheck and System composition typecheck pass. All four source worktrees
are checkpointed locally; the host commit passed the full mandatory hook.

The first managed run (`st_c0b635f1338c4e05b7c1ae872d3386df`) exposed an
invalid panel identity at the real terminal-app lease boundary before any model
turn. Sessions now persist one key from the canonical panel-history allocator
before launching and reuse it across retry, resume and restart. Valid older
registry identities are preserved at load. The 22 service regressions now use
the real panel runtime coordinator, including caller registration, lease
retirement and grant revocation rather than a permissive lease mock.

Fresh managed run `st_870eae060bcd4d34b61a7d15409c4f1a` passed
`terminal-chat-approval-fork-resume` in 41.843 seconds with concurrency 1 and
zero tool failures. It covers complete-history search, export followed by
attachment inspection/removal, independent parent/fork drafts, and kill/resume
restoration with the original tool title preserved. Doctor passed on the fresh
instance. Its background artifact producer was joined before the latency-judged
run, and no other host build or test overlapped that run. Both owned managed
instances were stopped and their temporary roots removed; private run evidence
is retained. No check assertion, production timeout or approval policy was
weakened to obtain the pass.

Source acceptance is complete. Exact installed-package acceptance remains the
explicit publication boundary above: it needs matching published templates and
a native package. Nothing in this pass was pushed or published, and this source
evidence is not presented as installed-release evidence.
