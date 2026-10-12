# Terminal apps and the terminal browser

Vibestudio runs in a plain terminal as well as in the desktop shell. The
**terminal browser** (`apps/terminal-browser` in the System template) is the
TTY counterpart of the shell: it owns your terminal, shows tabs of
**terminal apps**, and is the trusted place where you answer approvals.
Terminal apps are ordinary sandboxed workers that render an
[Ink](https://github.com/vadimdemedes/ink) UI.

```
your terminal ── terminal browser (trusted, runs in the CLI process)
                  • compositor: one screen, many grids
                  • tabs, launcher, palette, approvals, help, settings
                  │
                  │ RPC calls: terminalInput / terminalResize / …   (browser → app)
                  │ attachment stream: output, title, attention, …  (app → browser)
                  ▼
                 terminal app session (Durable Object in workerd, renders Ink)
```

## Using it

`vibestudio terminal` starts (or attaches to) a server and opens the browser
in the current terminal. Like the desktop app, it shows your **Personal**
workspace unless you pick another (`--workspace`, or prefix `w` inside). On
first start the **launcher** lists the terminal apps of that workspace;
afterwards its most recently used session resumes and the others stay listed
under *Resume*. Each workspace has its own apps and sessions: Server Logs, for
example, lives in your System workspace.

Every key goes to the app in the focused tab except the **prefix key**
(Ctrl-Space by default; change it in Settings). Press the prefix, then:

| Key | Action |
|---|---|
| `k` | Command palette: fuzzy search over apps, sessions, tabs and actions |
| `c` | Launcher: start an app or resume a session |
| `1`–`9`, `n`, `p`, `Tab` | Go to tab N, next, previous, last used |
| `[` | Copy mode: scroll back, select (`v`), copy to your clipboard (`y`, via OSC 52) |
| `a` | Approvals waiting for you |
| `l` | Browser log (and the server log path when the CLI owns the server) |
| `s` | Settings: prefix key, open approvals automatically, bell, mouse |
| `d` | Detach the tab: the session keeps its state and can be resumed |
| `x` | End the session for good (asks first) |
| `r` | Reattach the tab (after an error, or if another terminal took it) |
| `w` | Switch workspace |
| `?` | Help: every binding |
| `q` | Quit; sessions stay resumable |
| the prefix again | Send the prefix key itself to the app |
| `Esc` | Cancel the prefix |

With the mouse enabled you can click tabs and scroll a session's scrollback
with the wheel (unless the app uses the mouse itself); hold Shift to select
text natively. Pastes reach the app as bracketed pastes when the app asked for
them and never trigger browser commands.

Settings and the list of resumable sessions are stored for you on the server
(`workers/terminal-sessions` in your System workspace), so they follow you to
other devices.

## Writing a terminal app

A terminal app is a worker with a Durable Object class and a
`vibestudio.terminal` block:

```jsonc
{
  "name": "@workspace-workers/my-app",
  "vibestudio": {
    "entry": "index.tsx",
    "durable": { "classes": [{ "className": "MyAppSession" }] },
    "terminal": {
      "renderer": "ink",
      "title": "My App",                         // launcher and tab title (≤ 60 characters)
      "description": "What it is for, in one sentence.",
      "icon": "🧭"                                // optional, one emoji
      // "className": "MyAppSession"              // only needed with several durable classes
    }
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/terminal-shim": "workspace:*",
    "@workspace/terminal-host-protocol": "workspace:*",
    "ink": "^6.8.0",
    "react": "^19.0.0"
  }
}
```

The build validates the block and refuses a malformed one, naming the field
to fix. Once the worker builds, it appears in every launcher.

One DO instance is one session; its object key is the session id. Forward the
protocol methods to `InkTerminalSessionHost` and render your UI:

```tsx
import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";
import { InkTerminalSessionHost } from "@workspace/terminal-shim";
import type {
  TerminalAttachArgs,
  TerminalHostReply,
  TerminalSession,
  TerminalSize,
} from "@workspace/terminal-host-protocol";

const SESSION_RPC = {
  website: { kind: "closed", reason: "Driven only by the person's terminal browser." },
  principals: ["host", "user", "code"],
  effect: { kind: "open" },
  tier: "open",
} as const;

export class MyAppSession extends DurableObjectBase implements TerminalSession {
  static override schemaVersion = 1;
  private readonly terminal = new InkTerminalSessionHost({
    render: (session) => <MyApp session={session} />,
    onClose: () => this.deleteStateValue("view"), // the user ended the session
  });
  protected createTables(): void {}

  @rpc({ ...SESSION_RPC, sensitivity: "write" })
  async terminalAttach(args: TerminalAttachArgs) {
    return this.terminal.attach(this.caller?.callerId, args);
  }
  @rpc({ ...SESSION_RPC, sensitivity: "write" })
  async terminalInput(id: string, data: string) {
    this.terminal.input(this.caller?.callerId, id, data);
  }
  @rpc({ ...SESSION_RPC, sensitivity: "write" })
  async terminalResize(id: string, size: TerminalSize) {
    this.terminal.resize(this.caller?.callerId, id, size);
  }
  @rpc({ ...SESSION_RPC, sensitivity: "write" })
  async terminalFocus(id: string, focused: boolean) {
    this.terminal.focus(this.caller?.callerId, id, focused);
  }
  @rpc({ ...SESSION_RPC, sensitivity: "write" })
  async terminalReply(id: string, reply: TerminalHostReply) {
    this.terminal.reply(this.caller?.callerId, id, reply);
  }
  @rpc({ ...SESSION_RPC, sensitivity: "destructive" })
  async terminalClose(id: string) {
    await this.terminal.close(this.caller?.callerId, id);
  }
}
```

`workers/terminal-server-logs` in the System template is a complete, small
example: a live, filterable tail of the server log whose filter survives
detach and resume.

### What your UI gets

`render(session)` receives a `TerminalSessionHandle`:

- `setTitle(title)`: the tab and launcher title (remembered across restarts).
- `setAttention({ reason?, bell? } | null)`: badge the tab while it is in the
  background (the bell rings only if the user enabled it). Cleared when the
  user switches to the tab.
- `openUrl(url)` → `Promise<boolean>`: the browser shows the full URL with its
  host emphasised and opens it on the user's machine only if they press `o`.
  Only http and https URLs can be opened.
- `requestFile(prompt?)` → `Promise<TerminalFile | null>`: the user types a
  local path; nothing is read or sent until they press Enter (8 MB limit).
- `isFocused()`, `onFocusChange(listener)`, `size()`.
- `end(reason?)`: finish the session; the tab closes and the session is not
  resumable. Exiting Ink (`useApp().exit()`) does the same.

Use `useTerminalSize()` from `@workspace/terminal-shim` for layouts that fill
the screen: Ink re-lays-out on resize, but components need the size as state.
Use Ink's `useInput` for keys: the browser forwards raw bytes, so arrows and
Ctrl/Alt combinations arrive as they would in a real terminal.

Gated calls your app makes (for example `serverLog.tail`) raise an approval.
The browser opens its approvals overlay by itself when the request comes from
the focused tab and badges the tab (`!`) otherwise. Never draw your own
"approve?" prompt: approvals are answered only in browser chrome.

### Lifecycle

- **Start.** In the workspace the browser shows, the launcher creates a
  fresh context (`runtime.createContext`), records the session (with that
  workspace) in the registry, activates the DO
  (`runtime.createEntity` with the session id as key and that context) and
  calls `terminalAttach`.
- **Attached.** The `terminalAttach` response stream is the attachment. While
  it is open the DO stays resident and your Ink tree runs. Output, title,
  attention, host requests and `ended`/`superseded` travel down it in order.
- **Detach, quit or lost connection.** The browser cancels the stream: your
  Ink tree is unmounted, outstanding `openUrl`/`requestFile` promises resolve
  as declined, and the DO may be evicted. Nothing else happens; detaching is
  not closing.
- **Resume**, on the same or another device. `terminalAttach` runs again: the
  screen is cleared and `render` runs anew. **Rebuild your view from durable
  state** (DO storage, the channel, …), never from memory: the DO may be a new
  instance. Title and attention set earlier are re-announced for you.
- **Another terminal attaches.** The old attachment receives `superseded` and
  ends; the session follows the newest browser.
- **End.** The user ends the session (prefix `x` → `terminalClose`, then
  your `onClose` runs so you can discard state), or your app calls `end()`.

Only the attached browser may call `terminalInput`, `terminalResize`,
`terminalFocus` and `terminalReply`; `InkTerminalSessionHost` rejects every
other caller.

## Chat in a terminal app

A terminal chat is not a reimplementation of the chat panel: both run on the
same headless core, `@workspace/agentic-core/chat-store`.

- `ChatSession` owns the connection (`stream` or `resident` delivery), the
  transcript (`ChannelViewFeed`: durable events, `message.delta` streaming,
  replay paging), roster, composer, outbox, first-agent bootstrap
  (`session.deferredAgent`) and fork lineage (`session.forks`).
- `ChatHostController` owns the host side (model settings, agent catalog,
  channel bootstrap, installed agents and recovery) over a `StateArgsPort`
  that a Durable Object backs with its own storage.
- The panel binds these stores to React (`useAgenticChat`, `useChatCore`,
  `useChatStore`); `HeadlessSession` wraps a resident `ChatSession` for tests;
  an Ink UI subscribes to the same snapshots.

See `workspace/packages/agentic-core/src/chat-store/README.md` for the API.

## Protocol reference

`@workspace/terminal-host-protocol` defines one method table,
`terminalSessionRpcMethods`, on the session DO:

| Method | Purpose |
|---|---|
| `terminalAttach({ sessionId, viewport, focused })` → `Response` | Attach; NDJSON stream of `TerminalSessionEvent`s |
| `terminalInput(sessionId, data)` | Keyboard, paste and mouse bytes, already routed by the browser |
| `terminalResize(sessionId, { columns, rows })` | The browser is authoritative for the size |
| `terminalFocus(sessionId, focused)` | Tab focus |
| `terminalReply(sessionId, reply)` | Answer to an `open-url` or `request-file` event |
| `terminalClose(sessionId)` | End the session for good |

Stream events: `output` (VT text), `title`, `attention`, `open-url`,
`request-file`, `ended`, `superseded`. `TerminalEventDecoder` parses the
stream and rejects malformed events rather than skipping them.

The browser exposes **no** RPC methods. Everything an app can make the
browser do arrives on the attachment the browser itself opened, so no other
code in the workspace can draw on, or ask questions through, its chrome.

## How the browser works

- **Contract with the CLI.** The CLI imports the server-built artifact of
  `hostTargets.terminal.app` and calls `run(host)` (see
  `packages/shell-core/src/terminal/terminalBrowserHost.ts`). It provides
  two RPC clients, server information, stdin and stdout, connection state,
  `listWorkspaces`, `openExternal` and `readLocalFile`. `run` settles with
  `quit`, `switch-workspace` or
  `connection-lost`. It never exits the process, and it restores the terminal
  on every path, including errors, `SIGTERM`/`SIGHUP` and process exit.
- **Two workspaces, like the desktop shell.** The browser is installed in the
  account's System workspace, and `host.rpc` is its app principal there
  (`app:<source>:<deviceId>`); it reaches only the browser's own state, the
  session registry. Everything about the workspace it shows (`host.workspace`)
  goes through `host.workspaceRpc`, this device's own session in that
  workspace (`shell:<deviceId>`): listing terminal apps, creating contexts and
  session DOs, the attachment stream, and the approval queue. The desktop
  shell does the same for the workspace it shows. The browser runs inside the
  CLI process, which already holds the device credential, so handing it the
  device session grants nothing the process did not have; the app principal
  needs no manifest authority at all.
- **Compositor.** Each session is an `@xterm/headless` grid. The browser's
  own chrome (tab strip, status bar, launcher, palette, approvals, help,
  settings, dialogs) is Ink rendered into separate headless VT layers. The
  compositor merges the layers into one cell buffer and writes only the cells
  that changed, inside synchronized output (DEC 2026), on the alternate
  screen. The real cursor sits where the focused app left its cursor. Renders
  are coalesced to one per event-loop turn (`setImmediate`).
- **Keys.** A tokenizer splits input into keys (keeping their exact bytes),
  bracketed pastes and SGR mouse reports; the prefix state machine routes
  them. Application-cursor mode is mirrored for the focused app.
- **Sessions.** `workers/terminal-sessions` (a System singleton service)
  keeps each person's resumable sessions, keyed by workspace, and settings,
  partitioned by the caller's user id. The app principal's user is the
  device owner, whose device session minted its grant.
- **Connection.** While the CLI reports `reconnecting`, the status bar says
  so and tabs show that they will reattach. On `connected`, every interrupted
  attachment is reopened (with a full repaint) and the approval queue is
  refreshed. `lost` ends `run` with the cause.

### How `vibestudio terminal` starts the browser

The browser is a client app, like the desktop shell: the server builds it and
the client runs it. It never runs as a server process. `vibestudio terminal`
(or `pnpm terminal` from a source checkout; see [cli.md](cli.md#terminal)):

1. Connects with its paired device credential, starting this machine's local
   server first when it is not paired or that server is not running, and
   routes to the account's System workspace and to the workspace to show
   (Personal unless `--workspace` names another).
2. Runs the launch gate in System for the `terminal` target while the TTY is still in
   line mode: build, startup approvals (asked as questions, or `--yes`), and
   activation. `apps:available` reports terminal targets with
   `launchMode: "client-module"`.
3. Calls `auth.grantAppPrincipal([{ principal: "terminal-app", source }])` over
   its own connection. The grant is bound to that connection's transport
   endpoint, so it works over loopback and Iroh alike, and names the device's
   app principal (`app:<source>:<deviceId>`) and the exact build it may run.
4. Downloads that build's primary `index.mjs` through `gateway.fetch` of its
   `/_a/<buildKey>/index.mjs` route, imports it in-process, opens a second
   device session to the shown workspace (a second peer from the same Iroh
   endpoint when remote), and calls the module's exported `run(host)`.

The CLI restores the terminal when the browser exits, and runs another pass
when the browser switches workspace (the browser still comes from System) or
an adopted app update is observed while reconnecting.

### Rendering in workerd

Ink's layout engine (yoga) instantiates WASM asynchronously, which workerd
rejects. For workers with a `vibestudio.terminal` block, the build aliases
`yoga-layout` to `@workspace/terminal-shim/yoga`, which instantiates a
pre-compiled `yoga.wasm` module binding synchronously. The build emits
`yoga.wasm` beside the bundle, and `workerdManager` attaches it. `signal-exit`
and `terminal-size` are replaced by stateless shims, so several sessions can
share one isolate safely.

### Latency

Every keystroke travels to the DO, and its echo comes back over the
attachment before it is painted. On loopback this is a few milliseconds plus
Ink's render; over a remote Iroh link it is one network round trip more. If
that ever proves too slow, the fix is a protocol capability (for example
host-side line editing for a declared input region), not a second rendering
path.
