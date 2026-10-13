# Terminal apps refurbishment plan

Status: approved direction (2026-10-12), implementation pending. Checked against
the configured Base, System, and separate System-testing checkouts on 2026-10-14.

Userland terminal apps will be Node programs in the workspace's native runtime,
with PTYs owned by Base's shell extension. The terminal browser will be a trusted
client running on the user's machine. This is the selected direction; the earlier
Ink-in-workerd terminal app proposal is no longer part of this plan.

Goal: one command starts or attaches to a server and opens a terminal browser in
the current TTY. Base ships terminal chat with the chat panel's applicable agentic
features. Desktop and terminal clients share sessions and their ownership model.
[terminal-apps.md](terminal-apps.md) records the current operational status.

## Current implementation

- `src/server/terminalAppRunner.ts` and `terminalAppRuntime.ts` still launch
  terminal-target apps on the server. Interactive launches inherit server stdio,
  but `src/server/hubServer.ts` starts workspace children with ignored stdin and
  piped output. This does not supply the client's local or remote TTY.
- System's `meta/vibestudio.yml` selects `apps/remote-cli` for
  `hostTargets.terminal.app`. `system/apps/terminal-browser` exists but is not
  the configured terminal target.
- The browser hardcodes `workers/terminal-chat`, requires a real TTY, and exits
  on disconnect. Neither configured template currently declares a
  terminal-renderable worker. `workers/terminal-chat`,
  `workers/terminal-server-logs`, and `workers/terminal-sessions` are absent.
- Ink-in-workerd infrastructure still exists in System's `packages/terminal-shim`
  and `packages/terminal-host-protocol`, and in host builders. Remove it when the
  native replacement lands; do not retain another execution path.
- Base's desktop terminal uses `extensions/shell` PTYs. Sessions are owned by
  exact `callerId`. `panels/terminal/vscodeTerminalProcess.ts` still uses a 150 ms
  cursor watchdog and a reconnect loop.
- Chat behavior remains in Base's React hooks under `packages/agentic-chat` and
  `panels/chat`, with another consumer in `packages/quickfire-core/src/session.ts`.
  The separate System-testing checkout provides `HeadlessSession` in
  `packages/agentic-session/src/headless-session.ts`. It uses resident delivery,
  the shared channel reducer and message projection, and the shared protocol
  envelope converter. It also owns native input/run settlement observations,
  model evidence capture, optional synthetic panel UI methods, and joined
  context/entity cleanup. It does not register a live delta-signal callback;
  streaming parity remains extraction work.
- `terminal:jig` and `terminal:jig:smoke` still resolve `panels/terminal` from
  System instead of Base.

## Architecture

### Browser and terminal apps

The browser is a trusted System app, built by the server and run by the CLI on
the user's machine. It owns the TTY, device connection, and approval surface.

A terminal app is a workspace-bound code unit, distinct from trusted client
apps. It runs as an ordinary Node program in a shell-extension PTY, inside the
workspace's native runtime. Unix uses installed MXC: bubblewrap on Linux and
Seatbelt on macOS. Windows runs under the host user's permissions and provides
no native filesystem, network, or UI confinement.
[isolation-plan.md](isolation-plan.md) defines the actual platform boundaries.

The browser parses session bytes into headless VT grids and composites them with
trusted chrome. Session bytes never write directly to the real TTY. The desktop
terminal panel uses the same session protocol and ownership model.

Use standard terminal conventions: OSC 0/2 titles, BEL and OSC 9/777 attention,
OSC 8 links, and OSC 52 copy. The browser mediates URL opening and local file
selection on the user's machine. Do not add another Ink-worker attach protocol
or terminal worker host methods.

### Units, launch, ownership, and state

Add a terminal-app unit kind with entry point, title, description, and optional
icon. Choose its canonical manifest and directory during implementation;
`terminal-apps/chat` is the intended chat unit. Bundle Node ESM and materialize
native dependencies in the workspace runtime. Existing `buildTerminalApp` builds
trusted terminal-target apps, rather than this proposed unit kind.

One trusted launch service resolves an active artifact from the unit source.
Callers must not supply executable artifact paths. Bind a code entity and
connection grant to the build's execution digest, then open a PTY with the
installed Node runtime and artifact. Prefer an inherited descriptor or one-shot
channel for connection material. Attribution does not isolate sibling processes
inside one native runtime.

Launching uses the existing `native.shell.execute` boundary. The reviewed action
identifies the app and workspace. Subsequent requests use the app's code identity.

Design one ownership model that lets the same user resume sessions from another
client or device in the workspace. Record the launching principal and preserve
authorization for attach and input. Detach does not close a running PTY.

Maintain one per-user session/tab registry and persisted state port for app
settings, channel selection, and installed agents. Do not assume an existing
`workers/terminal-sessions`. PTYs end with their owning extension/runtime;
clients report that lifecycle and offer relaunch from persisted app state.

### Shared shell stream

Repair the existing attach stream for both browser and desktop:

- explicit cursor/epoch and gap/reset events for trimmed history and
  `clearScrollback`;
- byte-correct replay without decoding incomplete UTF-8 windows;
- per-attacher flow control with consistent units;
- full-screen redraw on attach: replay into the VT, then resize/SIGWINCH;
- authoritative completion, failure, cancellation, and runtime destruction.

Remove the panel's reconnect loop and cursor watchdog after the stream supplies
its missing readiness and lifecycle events. Slow work alone must not manufacture
failure or restart.

### Browser compositor and UX

One compositor owns the TTY. Render sessions and browser chrome into VT layers,
merge their cells, and diff-paint changes. Retain the existing Ink approvals UI
and install-review navigation. Use the alternate screen, synchronized output
where supported, and the focused session's cursor. Coalesce renders per
event-loop turn rather than with a timer.

Use a configurable prefix key, initially `Ctrl-Space`, so sessions receive other
keys. Provide tabs, a fuzzy palette, launcher, resumable sessions, scrollback/copy
mode, approvals, logs, workspace selection, and help. Show titles, attention,
connection state, and pending approvals. Splits can follow later.

Decisions go through the trusted browser overlay, with scrolling and automatic
presentation of actionable reviews. In-session cards point to that surface and
cannot decide approvals themselves.

Use RPC recovery events to resubscribe and show reconnecting. Explicit credential
revocation or destruction of an owned local server ends the app with the original
cause. Do not add a reconnect watchdog or retry timer.

### Shared chat core and terminal chat

Extract `ChatSession` into Base's `@workspace/agentic-core`, exposing `subscribe`,
`getSnapshot`, and actions. Move shared behavior from existing hooks:

- stream/resident delivery, durable reduction, deltas, credential rows, and replay;
- outbox, mentions, attachments, editing, retract/undo, deferred delivery,
  flushing, and interruption;
- first-agent bootstrap, agent persistence, and recovery through a storage port;
- model/thinking/fast/respond/approval settings, forks, and child transcripts.

React hooks become adapters. Move quickfire onto the same core or document a
concrete reason its behavior must remain separate. Browser-only renderers register
through a method-provider port. Migrate System-testing's existing
`HeadlessSession` onto the same channel feed and store as a thin headless adapter.
Preserve its native settlement observations, evidence capture, synthetic test UI,
and owned teardown; visible transcript completion must not replace actual native
input/run settlement. Add stream delivery and live delta support through the
shared core.

Stage extraction through channel feed (with `HeadlessSession` as its first
non-React consumer), delivery/outbox, method-provider port,
forks/child transcripts, deferred agent state machine, and `ChatHostController`
with injected persistence. Keep hook tests through adapters and add meaningful
store tests. Make effect ordering and snapshot identity explicit before building
terminal chat.

Base's chat unit uses Node, Ink, `ChatSession` in stream mode, and persisted
session state. Preserve applicable panel features: Markdown/ANSI and streaming,
collapsed thinking, expandable tool and child-task results, receipts, edits,
diagnostics, usage-limit actions, history paging, message actions, forks, resume,
and settings. The composer supports multiline editing, history, mentions,
bracketed paste, queued-message edit/undo, interrupt, and flush/interrupt.

Advertise `feedback_form` and render schema forms; do not advertise unsupported
inline/custom UI or client evaluation. Provider connection uses browser-mediated
URL opening and the pasted-callback flow in `src/cli/modelConnect.ts`. Files are
chosen locally through the browser. Missions use the existing client. Attention
uses terminal conventions. Dictation and sixel/kitty images are outside v1.

## One command and lifecycle

Add `vibestudio terminal` to attach to a paired server or start and own a local
server. Local state is persistent so chats survive. Server output goes to a log
file, never the TTY. Share local invite redemption and workspace routing with the
development supervisor instead of adding another pairing flow.

Run the client launch gate before raw mode, fetch the browser artifact through
the existing app-artifact mechanism, obtain its app-principal connection, and
launch it locally with inherited TTY stdio. Current principal grants support
React Native only; terminal client support remains to implement.

When the browser exits, stop and join the exact owned server unless the user
requested `--keep-server`. Add `pnpm terminal [--instance ID] [--ephemeral]`
through the existing supervisor. Remove `vibestudio terminal start` when its
replacement ships.

## Implementation order

1. **Client browser launch:** artifact execution, principal admission, launch
   gate, server lifecycle, unified pairing, and configuration selecting
   `apps/terminal-browser`. Remove `TerminalAppRunner`, `TerminalAppRuntime`,
   `terminal-process`, `app.interactive`, and `apps/remote-cli` with its obsolete
   environment contract. Keep unrelated process-adapter options only where used.
2. **Chat core:** extract the store, adapt React, migrate quickfire and
   System-testing's `HeadlessSession`, and verify.
   This is independent of client browser launch.
3. **Workspace units and shared sessions:** unit/build/launch service, identity,
   ownership, state, and repaired stream. Migrate desktop and browser consumers.
   Remove terminal-shim, terminal-host-protocol, DO terminal hosting, and obsolete
   Ink/workerd builders. Remove generic WASM support only if no consumer remains.
4. **Compositor and chat:** browser UX and Base chat. Browser work needs client
   launch and the shared stream; chat needs the core and terminal unit hosting.
   Verify send/stream/approval, forks, detach/reattach, and runtime termination/
   relaunch through the real browser under a PTY.
5. **Profiling and docs:** measure keystroke latency locally and over Iroh through
   the native Vibestudio profiling workflow. Update operational, CLI, and
   quickstart docs as the replacement ships. Fix jig checkout selection and
   sweep references to deleted execution paths.

## Questions to resolve during implementation

- Verify whether PTY children can read extension RPC material through process
  environment access. Do not claim process isolation the runtime lacks.
- Base's `requireContextAttachApproval` performs no independent approval and
  delegates authority to the context receiver. Clarify or remove that misleading
  helper after checking the receiver's actual boundary contract; its name alone
  does not establish a missing grant.
- Choose the manifest, state API, ownership, and registry location before adding
  consumers. Each has one implementation.
