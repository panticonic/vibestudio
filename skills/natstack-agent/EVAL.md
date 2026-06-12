# Eval: Running Code Against the Server

`natstack eval run` executes TypeScript/JavaScript in a sandboxed local child
process wired to the paired server over RPC, with a **persistent REPL scope**
per agent session. It is the fastest way to explore live data or do anything
the dedicated commands don't cover.

```bash
natstack eval run [FILE | -e CODE | -]
    [--session NAME] [--timeout MS] [--fresh-scope]
    [--syntax typescript|jsx|tsx] [--imports JSON] [--json]
natstack eval repl-reset [--session NAME]
```

Code sources (mutually exclusive): a `FILE` positional, inline `-e CODE`, or
stdin (`-`, or implicitly when stdin is piped). Default syntax is `tsx`;
top-level `await` and `return` are allowed.

## Bindings available to your code

| Binding | What it is |
|---------|------------|
| `rpc.call(method, args)` | Raw RPC: `await rpc.call("git.contextStatus", [ctx.contextId, "panels/notes"])` |
| `services` | Proxy over rpc: `await services.meta.listServices()` ≡ `rpc.call("meta.listServices", [])` |
| `fs` | Context-bound fs service — the session contextId is injected as the first arg: `await fs.readdir("/")`, `await fs.grep("TODO", {})` |
| `ctx` | `{contextId, sessionId, workspaceId, serverUrl}` |
| `scope` | Persistent REPL scope (see below): `scope.results = data` survives across runs |
| `help()` | `await help()` lists services + import guidance; `await help("git")` describes one service |

```bash
natstack eval run -e '
  const files = await fs.glob("**/*.ts");
  scope.fileCount = files.length;
  return files.slice(0, 10);
'
```

## Persistent scope

- Assignments to `scope` (e.g. `scope.x = ...`) are serialized after every
  run — success **or** failure — and restored on the next run for the same
  session. One scope per session.
- `--fresh-scope` starts a single run from an empty scope without touching
  the stored one; `natstack eval repl-reset` clears it permanently.
- Unserializable values are dropped with a `scope: dropped <path> (<reason>)`
  warning on stderr (listed in `scopeWarnings` in JSON mode).

## Imports

```bash
natstack eval run --imports '{"lodash":"npm:4","@workspace/gad":"@workspace/gad"}' -e '
  import _ from "lodash";
  import { something } from "@workspace/gad";
  ...
'
```

- `npm:<version>` refs are installed/bundled server-side on demand.
- `@workspace/*` packages resolve to server-built library bundles. They are
  browser-targeted builds — packages depending on panel/worker runtime
  globals may not work in the Node runner.

## Output

- **Text mode (TTY):** the `return` value prints to stdout
  (pretty-printed JSON for objects); `console.*` output streams to stderr
  live, prefixed `[warn]`/`[error]`/`[info]`/`[debug]` for non-log levels;
  scope warnings go to stderr.
- **JSON mode (`--json` or piped stdout):** one document on stdout:
  `{success, returnValue, returnTruncated, error, console, scopeSaved, scopeWarnings}`
  where `console` is `[{type:"console", level, text, ts}]`.
- Return values are truncated at 256KB of JSON (`returnTruncated: true`).

## Timeouts and exit codes

- `--timeout MS` (default 120000) SIGKILLs the runner — sandboxed sync code
  cannot be preempted any other way. A timeout exits `4`.
- Exit codes: `0` success · `1` eval threw / RPC error / runner died ·
  `2` usage (bad flags, FILE+`-e` conflict) · `3` not paired/unreachable ·
  `4` timeout · `5` stale session.
- Long evals: the runner holds a single short-lived shell token; runs that
  outlive the token TTL will start failing RPC calls mid-run. Split work into
  shorter runs and carry state in `scope`.
