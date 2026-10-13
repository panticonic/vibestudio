# Terminal apps: current status

Checked against the configured Base and System templates on 2026-10-14.

The desktop terminal panel works through Base's shell extension and workspace
PTY sessions. A standalone interactive terminal browser and terminal chat are
not currently wired into the normal CLI workflow.

The selected refurbishment design is documented in
[terminal-refurbish-plan.md](terminal-refurbish-plan.md). It runs userland terminal
apps as Node programs in the workspace native runtime, with shell-extension PTYs
shared by desktop and terminal clients. That unit kind, launch service, and
client browser launch are planned work, not current APIs.

## What exists today

| Component                  | Current implementation                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Desktop terminal           | Base `panels/terminal`, using Base `extensions/shell` PTYs                                   |
| Configured terminal target | System `meta/vibestudio.yml` selects `apps/remote-cli`                                       |
| Terminal browser source    | System `apps/terminal-browser`; not the configured terminal target                           |
| CLI launch                 | `vibestudio terminal start` still uses the server-side terminal app launch path              |
| Server launch              | Host `src/server/terminalAppRunner.ts` and `terminalAppRuntime.ts`                           |
| Ink/workerd infrastructure | System `packages/terminal-shim`, `packages/terminal-host-protocol`, and host builder support |

The hub starts workspace server children with ignored stdin and piped output.
An interactive terminal app inheriting that stdio does not receive the user's
TTY. A remote launch also cannot inherit the remote client's TTY. The configured
`remote-cli` output goes to server supervision rather than an interactive browser.

The browser requires a real TTY and still hardcodes `workers/terminal-chat`.
Neither configured template currently declares a terminal-renderable worker;
`workers/terminal-chat`, `workers/terminal-server-logs`, and
`workers/terminal-sessions` are absent. The old worker examples and DO session
instructions therefore do not describe a runnable current setup.

## Boundaries

The desktop terminal's workspace commands use the native runtime described in
[isolation-plan.md](isolation-plan.md). Unix uses installed MXC confinement;
Windows executes with the host user's permissions and has no native filesystem,
network, or UI confinement. Workspace processes are not separate security domains
inside one native runtime.

Shell sessions are currently owned by exact caller identity. Cross-device
user-owned resume is part of the planned shared session model, not an existing
terminal-app guarantee.

## Remaining work

The refurbishment replaces server-side interactive app launching with a trusted
browser running on the user's machine. It adds workspace terminal-app units,
code-attributed launch, shared session ownership and persisted state, repairs the
shell attach stream, extracts shared chat behavior, and builds terminal chat.
Approval decisions remain in the trusted browser surface; workspace terminal
output is parsed into VT grids rather than writing directly to the user's TTY.

`terminal:jig` and `terminal:jig:smoke` currently resolve `panels/terminal` from
System, although that panel lives in Base. Their checkout selection must be
corrected before those commands can validate the current desktop panel.

Do not use the historical Ink-in-workerd manifest examples as instructions for
the new native terminal-app design. Publish the replacement manifest and launch
instructions when their implementation is available.
