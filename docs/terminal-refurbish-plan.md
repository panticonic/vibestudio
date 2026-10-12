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
  if it worked, it would draw on the *server's* terminal and could never work
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
   (approvals prompt) *before* taking raw mode.
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

| Area | Terminal behaviour |
|---|---|
| Transcript | Markdown to ANSI (headings, lists, tables, code blocks with highlighting), streaming deltas, thinking collapsed by default, tool cards collapsible with result summaries (eval output, file-mutation diffs in colour, images as `[image]` + open), subagent/task cards expandable into the child transcript, typing indicator, receipts, retracted/edited markers, disconnect and diagnostic rows, usage-limit card with resume/schedule |
| Navigation | Transcript scrollback with a selection cursor; act on the selected message (copy, fork here, edit & fork, expand, retry/resume); history paging via replay |
| Composer | Multiline editor (Enter sends, Alt/Shift-Enter for a newline), input history, `@mention` autocomplete, bracketed paste, queued-outbox view with edit/undo, Esc to interrupt, Esc Esc to flush and interrupt |
| Slash commands | `/model`, `/thinking`, `/fast`, `/approval`, `/respond`, `/connect <provider>`, `/agents` (add/replace/remove), `/new`, `/resume` (chat list), `/fork`, `/forks` (tree + switch), `/title`, `/missions`, `/retry`, `/export`, `/help`; all also reachable from a `Ctrl-K` palette |
| Status line | Model, thinking level, context-usage %, approval level, connection, agent busy/idle, unread forks |
| Approvals | Inline cards are display-only. Decisions go through the browser's trusted overlay (shellApproval queue), and the card names the key that opens it |
| `ask_user` | Advertise `feedback_form` and render JSON-schema forms as terminal forms. Do not advertise `inline_ui`, action bar, `feedback_custom`, custom message-type renderers or `client_eval`, so agents fall back to text |
| Provider connect | Pre-agent and in-chat (`connectModelCredential`) flows use host `openUrl` on the user's machine, with the pasted-callback fallback from `src/cli/modelConnect.ts` |
| Attachments | Host `requestFile`: the browser reads a local path the user confirmed and sends the bytes to the session |
| Attention | Escalations and finished turns while unfocused call `setAttention` (tab badge, optional bell) |
| Missions | List/run/pause/resume via `createMissionsClient` |

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
- **Dev:** `pnpm terminal [--instance ID] [--ephemeral]` is a new
  `runInstance.ts terminal` mode. It uses the same supervisor as
  `server:live`, writes server stdio to `<instanceRoot>/logs/server.log`, and
  launches the browser from the current checkout's build.
- **`vibestudio terminal start`** is removed: the launch is the command.

## 3. Phases

Phases 1 and 2 are independent and can run in parallel with separate owners.
Phase 3 depends on 1; phase 4 depends on 2 and 3.

1. **Client-hosted browser.** Add the `terminal-app` principal grant, the CLI
   artifact fetch + local launch, and `vibestudio terminal` / `pnpm terminal`
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
