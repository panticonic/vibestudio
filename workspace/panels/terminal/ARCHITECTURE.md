# Terminal Architecture

The terminal panel uses a vendored VS Code xterm layer for browser-side terminal behavior and keeps vibestudio-specific process connectivity at the edge.

## Product Shape

The panel owns one terminal split tree. It does not maintain a terminal-local sidebar, tab strip, saved-layout registry, or tab badge layer; workspace panels provide the outer navigation model. Inside the terminal panel, new shells are added as panes in the split tree, and the focused pane is tracked by `focusedSessionId`.

Pane headers carry the compact controls that belong to an individual terminal surface: split, zoom, settings, ports, preview, find, restart, and close. Global overlays are limited to the command launcher and notification center so the terminal output area remains the dominant surface on desktop and mobile.

## Boundaries

- `vscode-upstream/` stores the upstream VS Code source snapshots used while porting behavior.
- `vscodeTerminalFrontend.ts` owns the xterm instance, addons, renderer lifecycle, clipboard, search, serialization, unicode mode, shell integration events, and line-data events.
- `vscodeTerminalInstance.ts` owns lifecycle wiring between the frontend, process bridge, resize handling, scrollback bootstrap, and panel events.
- `vscodeTerminalProcess.ts` and `shellAttach.ts` are the vibestudio connectivity boundary. They adapt the shell extension RPC API to the frontend without importing VS Code process management or workbench services.
- `TerminalApp.tsx` owns the single split-tree state, startup/restore flow, command launcher, settings, and notification center.
- `SplitTree.tsx`, `PaneView.tsx`, and `PaneHeader.tsx` render the active terminal tree and pane-level controls.

## Streaming Path

Terminal attach is a streaming extension method:

1. Panel code calls `extensions.use("@workspace-extensions/shell", { streamingMethods: ["attach", "watchSessionInfo", "watchAllSessionInfo"] })`.
2. The runtime proxy routes those methods through `extensions.invokeStream`.
3. The server dispatches `extensions.invokeStream` to the extension host.
4. The extension child replies with RPC `stream-frame` messages.
5. The server routes those frames back into the pending server-side RPC bridge stream.
6. `VscodeTerminalProcessBridge` reads the `Response.body` and schedules writes into xterm.

Regular shell calls such as `getScrollback` stay unary. Streaming methods are declared through `use(name, { streamingMethods })` so unary and streaming methods live on one typed client.

## Renderer Policy

The frontend defaults to xterm's DOM renderer. WebGL, images, and ligatures remain structurally supported in the port, but they are not enabled by default in the panel because the Electron `WebContentsView` path showed GPU stalls and xterm WebGL disposal failures during terminal churn.

## Test Surface

- Unit tests cover the startup model, attach stream composition, write scheduling, shell integration parsing, keybindings, pane models, and the extension streaming proxy.
- RPC tests cover HTTP `/rpc/stream`, WS stream requests, and server-initiated stream-frame routing from extension children.
- The terminal e2e opens the panel, resolves approvals, verifies PTY scrollback, verifies rendered xterm text, clicks the terminal, types through the panel WebContents, reloads, and repeats the input/render assertions.
- The standalone input jig isolates the xterm frontend from Electron panel embedding so keyboard/focus regressions can be separated from shell/process transport regressions.
