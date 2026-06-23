# Eval: Running Code Against the Server

`natstack eval run` executes TypeScript/JavaScript **server-side** in your CLI
session's sandbox (a per-owner EvalDO behind the `eval` service), with a
**persistent REPL scope** per agent session. It is the fastest way to explore
live data or do anything the dedicated commands don't cover.

```bash
natstack eval run [FILE | -e CODE | - | --path P]
    [--session NAME] [--timeout MS] [--fresh-scope]
    [--syntax typescript|jsx|tsx] [--imports JSON] [--json]
natstack eval repl-reset [--session NAME]
```

Code sources (mutually exclusive): a `FILE` positional (read locally), inline
`-e CODE`, stdin (`-`, or implicitly when stdin is piped), or `--path P` (a
context-relative file the server reads itself). Default syntax is `tsx`;
top-level `await` and `return` are allowed. The session's eval scope is
selected by `--session`; the owner is your verified CLI identity, so eval runs
against that session's context (fs/git/vcs) automatically.

## Bindings available to your code

| Binding | What it is |
|---------|------------|
| `rpc.call(method, args)` | Raw RPC: `await rpc.call("vcs.status", ["ctx:" + ctx.contextId])` |
| `rpc.callTarget(targetId, method, args)` | Call a runtime entity (DO/worker) by target id, e.g. after `workers.resolveService`: `const svc = await rpc.call("workers.resolveService", ["natstack.testkit-driver.v1", null]); await rpc.callTarget(svc.targetId, "ping", [])` |
| `services` | Proxy over rpc: `await services.docs.listServices()` ≡ `rpc.call("docs.listServices", [])` |
| `fs` | Context-bound fs service — the session contextId is injected as the first arg: `await fs.readdir("/")`, `await fs.grep("TODO", {})` |
| `ctx` | `{contextId, sessionId, workspaceId, serverUrl}` |
| `scope` | Persistent REPL scope (see below): `scope.results = data` survives across runs |
| `help()` | `await help()` lists services + import guidance; `await help("vcs")` describes one service |

```bash
natstack eval run -e '
  const files = await fs.glob("**/*.ts");
  scope.fileCount = files.length;
  return files.slice(0, 10);
'
```

## Persistent scope

- Assignments to `scope` (e.g. `scope.x = ...`) are persisted in the EvalDO's
  own SQLite after every run and restored on the next run for the same session.
  One scope per session.
- `--fresh-scope` resets the persistent scope (and the user `db`) before the
  run, so the snippet starts empty; `natstack eval repl-reset` does the same
  reset as a standalone command.

## Imports

```bash
natstack eval run --imports '{"lodash":"npm:4","@workspace/gad":"latest"}' -e '
  import _ from "lodash";
  import { something } from "@workspace/gad";
  ...
'
```

- The map value is a *ref*, not a package name: `npm:<version>` for npm
  packages (installed/bundled server-side on demand), `"latest"` or a git
  ref (branch/tag/SHA) for `@workspace/*` packages.
- `@workspace/*` packages resolve to server-built library bundles, including
  subpath exports (e.g. `{"@workspace/testkit/profiling":"latest"}`). They
  are browser-targeted builds — packages depending on panel/worker runtime
  globals may not work in the eval sandbox.

## Importing the workspace runtime

`import { … } from "@workspace/runtime"` resolves to the SAME portable surface a
panel or worker gets — no imports map entry needed. The full list is in
`await help()`; the portable members are:

```ts
import {
  gad, workspace, vcs, git, credentials, webhooks, extensions, approvals, notifications,
  callMain, parent, getParent, getParentWithContract,
  workers, doTargetId, createDurableObjectServiceClient,
  openPanel, listPanels, getPanelHandle, panelTree, openExternal,
  gatewayConfig, gatewayFetch, rpc, fs, id, contextId,
} from "@workspace/runtime";
```

- `callMain("svc.method", ...args)` is sugar for `rpc.call("main", "svc.method", args)`.
- `approvals.request/revoke/list` — the only approval API (the old top-level
  `requestApproval`/`revokeApproval`/`listApprovals` no longer exist).
- `parent` / `getParent()` resolve the owning panel of the eval session (the
  agent's launch parent when an agent runs the eval), or a no-panel handle when
  there is none.
- To publish an inbound RPC method use `rpc.expose(method, (req) => …)` — there
  is no top-level `expose`.
- The imported `rpc` is the full RPC client; the AMBIENT `rpc` (above) is 2-arg
  REPL sugar — don't `import { rpc }` if you want the ambient form.

## Output

The `eval` service returns `{success, console, returnValue?, error?, scopeKeys?}`,
where `console` is the formatted console output captured during the run and
`scopeKeys` lists the keys currently held in the persistent scope.

- **Text mode (TTY):** the captured `console` prints to stderr, then the
  `return` value prints to stdout (pretty-printed JSON for objects). On
  failure the `error` is reported (exit `1`).
- **JSON mode (`--json` or piped stdout):** the result document is emitted
  verbatim on stdout.

## Timeouts and exit codes

- `--timeout MS` (default 120000) bounds how long the CLI waits for the
  server. On timeout the CLI stops waiting and exits `4`; the eval may keep
  running server-side.
- Exit codes: `0` success · `1` eval threw / RPC error · `2` usage (bad
  flags, conflicting code sources) · `3` not paired/unreachable · `4` timeout ·
  `5` stale session.
- Split long work into shorter runs and carry state in `scope` (persisted in
  the EvalDO between runs).
