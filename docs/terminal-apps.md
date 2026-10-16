# Terminal apps and the terminal browser

Vibestudio runs in a plain terminal as well as in the desktop app. The
**terminal browser** (`apps/terminal-browser` in the System template) is the
terminal counterpart of the desktop shell. It owns your terminal, shows tabs,
and is the trusted place where you answer approvals.

Each tab is a **terminal session**: a program running in a PTY in a workspace's
native runtime. The program is either a **terminal app** or your login shell.
A terminal app is to the terminal browser what a panel is to the desktop: an
ordinary workspace unit that a client hosts. It is a Node program, not a web
page.

```
your terminal ── terminal browser (trusted client, runs in the CLI process)
                  • tabs, launcher, palette, approvals overlay, help, settings
                  • one compositor: each tab's output is parsed into its own grid
                  │
                  │ shell extension: attach (framed output) / write / resize
                  │ terminalApps: launch / resume / close / list (+ change events)
                  ▼
                 workspace native runtime (sandbox)
                  └─ shell extension PTY ── node <terminal app build>  ─┐
                                                                         │ RPC as the app's
                 workspace server ◀───────────────────────────────────────┘ own principal
```

The program's bytes never reach your real terminal. The browser parses them,
so no program can draw over the approvals overlay or fake browser chrome.

## Using it

`vibestudio terminal` starts (or attaches to) a server and opens the browser in
the current terminal. Like the desktop app, it shows your **Personal**
workspace unless you pick another (`--workspace`, or prefix `w` inside).

- **First start:** the launcher lists that workspace's terminal apps and a
  login **Shell**.
- **Later starts:** the most recently active running session reopens, and the
  others stay listed under _Resume_.

Sessions belong to you, not to the device or the client. You can resume them
from another computer, or from the desktop app's terminal panel.

Every key goes to the program in the focused tab except the **prefix key**
(Ctrl-Space by default; change it in Settings). Press the prefix, then:

| Key                      | Action                                                              |
| ------------------------ | ------------------------------------------------------------------- |
| `k`                      | Command palette: fuzzy search over apps, sessions, tabs and actions |
| `c`                      | Launcher: start an app or a shell, or resume a session              |
| `1`–`9`, `n`, `p`, `Tab` | Go to tab N, next, previous, last used                              |
| `[`                      | Copy mode: scroll back, select (`v`), copy to your clipboard (`y`)  |
| `o`                      | Links the program showed in this tab; opening one asks first        |
| `a`                      | Approvals waiting for you                                           |
| `l`                      | Browser log (and the server log path when the CLI owns the server)  |
| `s`                      | Settings: prefix key, open approvals automatically, bell, mouse     |
| `d`                      | Detach the tab: the program keeps running and can be resumed        |
| `x`                      | End the session for good: the program stops (asks first)            |
| `r`                      | Reattach the tab, or start its program again if it ended            |
| `w`                      | Switch workspace                                                    |
| `?`                      | Help: every binding                                                 |
| `q`                      | Quit; sessions keep running and stay resumable                      |
| the prefix again         | Send the prefix key itself to the program                           |
| `Ctrl-G`                 | Cancel browser UI or the prefix                                     |

Ctrl-G cancels browser UI without making an approval decision. Enhanced
keyboard terminals also support Escape; on legacy terminals an isolated Escape
is indistinguishable from the start of a fragmented key sequence, so use Ctrl-G.
When the program has focus, its keys still pass through unchanged. Ctrl-G cannot
be configured as the browser prefix.

In copy mode, `/` searches retained terminal output and `n`/`N` move between
matches. Copy and export join soft-wrapped lines without losing Unicode cells.
The log supports filtering, full-entry inspection, copying and export. These
actions and terminal-output export are also available in the command palette.

The palette's upload/download actions ask for exact local and workspace paths
and keep the originally selected session context even if you change tabs.
Uploading replaces the chosen workspace destination; downloads and exports
never overwrite existing local files. Uploads are limited to 8 MiB; downloads
stream bounded pages and verify the complete content identity. Use
`/attach <workspace-path>` in chat after uploading a local attachment.

Chat has `/attachments` to inspect and remove staged files, `/queue` to inspect
and change unpublished messages, and `/search` and `/export` over the complete
conversation history. Drafts, attachments and deferred messages are kept per
conversation. Opening requests are immutable: cancel and compose a replacement
instead of editing a request already admitted to agent setup.
Once publication has been attempted, retry keeps the exact message and delivery
identity. Accepted messages awaiting attachment cleanup offer cleanup retry only;
they are not sent again. Discarding a queue entry never recalls an accepted message.

Use `/connect <provider>` for provider setup. API keys and other secrets are
entered in the browser's protected approval form, never in the chat transcript.
Device-code sign-in provides explicit open/copy actions; callback-based OAuth
waits for the provider callback rather than asking for an empty submission.

Mouse support:

- With the mouse enabled you can click tabs and links.
- The wheel scrolls a tab's scrollback, unless the program uses the mouse
  itself.
- Hold Shift to select text natively.

Pastes reach the program as bracketed pastes when it asked for them, and never
trigger browser commands.

Settings and your list of sessions are kept on the server by the workspace's
`terminalApps` service, so they follow you to other devices. Settings live in
your System workspace.

### What a program can ask of its terminal

Terminal apps use standard terminal sequences; any terminal understands them.
The browser maps them to its chrome:

| Sequence                                           | Effect in the browser                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OSC 0 / OSC 2                                      | Tab title                                                                                |
| BEL, OSC 9, OSC 777 `notify`                       | Badge on a background tab, and a bell if you enabled it                                  |
| OSC 8 hyperlinks                                   | Click or `prefix o`; the URL is shown and opened on your machine only when you press `o` |
| OSC 52                                             | Copies to your clipboard (clipboard reads are never answered)                            |
| Bracketed paste (`?2004`), focus reports (`?1004`) | Delivered as requested                                                                   |

## Writing a terminal app

A terminal app lives at `terminal-apps/<name>` in a workspace. It uses the
panel manifest fields:

```jsonc
{
  "name": "@workspace-terminal-apps/my-app",
  "type": "module",
  "vibestudio": {
    "title": "My App", // launcher and tab title
    "description": "What it is for, in one sentence.",
    "icon": "🧭", // one emoji (terminals show no images)
    "entry": "index.ts",
    "stateArgs": { "type": "object" }, // optional: schema of its session state
    "authority": {
      "provides": [],
      "requests": [
        /* what it calls */
      ],
    },
  },
  "dependencies": { "@workspace/terminal-app": "workspace:*", "ink": "^6.8.0", "react": "^19.0.0" },
}
```

It is a panel in every respect except its host:

- the same build pipeline, admission, effective version and execution identity;
- its own principal, context and `stateArgs`.

The build bundles it as a Node ES module and places native npm dependencies next
to the bundle, as for extensions. It runs from the workspace's build directory
inside the native runtime.

```ts
import { startTerminalApp } from "@workspace/terminal-app";

const app = await startTerminalApp(); // connects as this app's own principal
await app.state.patch({ filter: "warn" }); // durable per-session state (stateArgs)
// draw with Ink (or anything) on process.stdout; read keys from process.stdin
```

`startTerminalApp()` does three things:

- reads the launch material the launch service left for this process;
- connects to the workspace as the app's own principal;
- names the runtime after the app.

`app.state` is the session's `stateArgs`. It is a merge patch (`null` deletes a
key), validated against your `stateArgs` schema. It survives detach, a lost
connection and a relaunch.

The program ends with its session. When the person ends the session, the
program receives SIGHUP. When the program exits, the session shows that it
ended and can be started again with its state.

Every gated call your app makes (for example `serverLog.tail`) raises an
approval attributed to your app's code identity:

- the terminal browser opens its overlay when the request comes from the
  focused tab, and badges the tab otherwise;
- never draw your own "approve?" prompt.

The launch material includes `approvalsKey` (for example "Ctrl-Space a"), so
your UI can say how to open the overlay.

Two complete examples:

- `terminal-apps/chat` (Base) runs the full agentic chat (`@workspace/terminal-chat`).
- `terminal-apps/server-logs` (System) is a small live log viewer.

## How it works

### Launch: the `terminalApps` service

The workspace server's `terminalApps` service hosts terminal apps, as the
desktop shell hosts panels. `launch({source?, cols, rows})` does the following
for a terminal app (a shell takes the shorter path described below):

1. Asks for approval: "Run Chat 1a2b3c4d5e6f in Personal?"
   - Scopes are once, session and version.
   - Your own device session is cleared as your action, as in the desktop.
2. Activates a runtime entity `kind: "panel"` for the app:
   - it is owned by you, has no slot and has its own context;
   - a relaunch reuses the session's context and carries the previous
     incarnation's `stateArgs` over.
3. Holds that runtime's panel lease for a connection id it chooses.
   - Host-held leases are separate from the desktop's slot leases.
   - They end when the entity is retired, never on a timer.
4. Mints the program's connection grant on your behalf.
5. Starts `node <build>/bundle.js` through the Base shell extension, as you. The
   PTY is yours, in the session context's folder, with a minimal environment
   (no `CI`).
6. Hands the program its launch material (gateway URL, grant, connection id,
   context, state) in a one-shot file. The only launch variable names the file;
   the program deletes the file on start, so no credential stays in its
   environment.
7. Records the session in your registry and emits
   `terminal-apps:sessions-changed`.

It then waits on the shell extension for the PTY's exit. When the PTY exits it
retires the entity, which ends the lease and the program's authority.

**Shells.** Without a `source`, `launch` starts a plain shell: the login shell,
or `command` with `args`, in `cwd`, with `label` as its title, in `contextId`
(default: a fresh context for the session). A shell is a session of the same
registry with no entity, grant or lease. The desktop terminal panel opens,
relaunches (`resume`, `restart`) and ends (`close`) every pane through this
service, so the panel and the terminal browser list the same sessions: a pane
opened in the desktop appears in the browser's launcher, and a session started
in the browser appears in the desktop panel as a pane. Only sessions the shell
extension spawns itself (`snug split` from inside a shell) are outside the
registry.

Processes inside one native runtime share its user and sandbox. They are not
separate security domains (see [isolation-plan.md](isolation-plan.md)). The
app's own principal, grant and stateArgs give **attribution**: what the app
does is recorded and approved as the app. They do not isolate the app from
other code in the runtime.

### Closing a session

Closing a terminal session behaves like closing a desktop chat panel. Only the
running program and its panel entity end. The conversation, its agents, the
session context and its folder, and any fork contexts persist, and the
conversation can be resumed from anywhere. Deleting them is a separate,
explicit action; closing never does it.

### Attach: the shell extension's framed stream

`@workspace-extensions/shell` owns every PTY. Sessions belong to the person the
caller acts for (`user:<id>`), and the opening principal is recorded.

`attach(sessionId, {after?, size?})` returns a framed binary stream, defined in
`@workspace/pty-stream`:

| Frame   | Meaning                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------ |
| `hello` | Epoch, retained window start, cursor, size, and an attachment id for acknowledgements            |
| `data`  | Raw output bytes and their byte cursor (never decoded, so UTF-8 split across chunks stays exact) |
| `reset` | Scrollback was cleared, or the requested position is from an older epoch: clear, then continue   |
| `gap`   | Bytes `[from, to)` were trimmed before this client read them                                     |
| `exit`  | The program exited; the stream ends                                                              |

Attaching and acknowledging:

- **Resume:** `after` continues exactly after the last byte a client consumed.
- **Size:** `size` makes the foreground program redraw (a resize, or SIGWINCH
  when the size did not change).
- **Flow control:** per attachment, in bytes on both sides
  (`acknowledge(sessionId, attachId, bytes)`).

The desktop terminal panel and the terminal browser are both clients of this
stream. Each re-attaches on its connection's recovery, never on a timer.

### The browser

The contract with the CLI is
`packages/shell-core/src/terminal/terminalBrowserHost.ts`:

- `host.rpc` is the browser's app principal in System, used for settings.
- `host.workspaceRpc` is this device's session in the shown workspace, used for
  sessions, apps and approvals.
- `host.signal` owns the invocation. Cancellation reaches transport creation,
  pending calls and transfers; shutdown joins their cleanup.
- `host.files` handles explicit user upload/download/export gestures through
  the existing context-scoped filesystem service. Workspace apps cannot invoke
  this trusted client-file capability themselves.
- `run` settles with `quit`, `switch-workspace` or `connection-lost`. It never
  exits the process, and it restores the terminal on every path.

Rendering:

- Each tab is an `@xterm/headless` grid.
- The browser's own chrome is Ink, rendered into separate grids.
- The compositor writes only changed cells, inside synchronized output, on the
  alternate screen, and coalesces renders to one per event-loop turn.

### How `vibestudio terminal` starts the browser

The browser is a client app, like the desktop shell: the server builds it and
the client runs it. `vibestudio terminal` (or `pnpm start:terminal` /
`pnpm dev:terminal` from a source checkout; see [cli.md](cli.md#terminal))
does the following:

1. Connects with its paired device credential. It starts this machine's local
   server first when the device is not paired or that server is not running.
2. Routes to the System workspace (where client apps are installed) and to the
   shown workspace, Personal by default.
3. Runs the launch gate for the `terminal` target while the TTY is still in line
   mode: build, startup approvals, and activation.
4. Obtains the browser's app principal, downloads its primary module, imports it
   and calls `run(host)`.

### Latency

Every keystroke travels to the program's PTY, and its echo comes back over the
attach stream before it is painted. On loopback this is a few milliseconds plus
the program's own render. Over a remote Iroh link it adds one network round
trip.
