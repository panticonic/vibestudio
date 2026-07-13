# Eval Tool

Run TypeScript/JavaScript code **server-side** in your own per-agent sandbox.
`eval` is a LOCAL agent tool: the agent loop dispatches it in-process and it
executes the code in your channel's `EvalDO` (a server-side Durable Object), not
in the chat/editor panel. Console output is captured and the return value is
sent back.

**Eval does not need a connected panel.** It keeps working even if the
chat/editor panel — or the user — disconnects. State (`scope`, the in-DO SQLite
`db`) lives in the EvalDO and persists across calls and across turns.

## Eval Perspective

Eval runs in a server-side EvalDO, not in the visible chat/editor panel. That
means its runtime perspective is slightly different from the user's panel
perspective:

- `chat.channelId` is the channel where this agent is currently responding.
  It is not automatically the channel for a parent panel, sibling panel, or
  any other chat panel in the tree.
- `panelTree.self()` in eval is the EvalDO runtime handle. Use top-level
  `parent`/`getParent()` for the owner agent's nearest visible panel ancestor.
- `openPanel()` from eval defaults new panels under that owner panel ancestor
  when one exists.
- A genuinely headless session has no initial panel ancestor. The panel tree is
  still fully available, but a child needs a real panel node to parent it. Use
  `getParent()` to test for an owner (`parent` is a compatibility no-panel
  handle when none exists). If it returns null, create an owned root explicitly
  and pass that handle's id as `parentId` when opening the child:

  ```ts
  import { openPanel } from "@workspace/runtime";

  const inherited = await getParent();
  const root = inherited ?? await openPanel("about/new", { parentId: null });
  const child = await openPanel("panels/spectrolite", {
    parentId: root.id,
    focus: true,
  });
  await child.refresh();
  if (child.parentId !== root.id) throw new Error("Panel was not created as a child");

  // Close the temporary root when the whole headless workflow is done; closing
  // it owns/cleans its descendants. Do not close an inherited user panel.
  if (!inherited) await root.close();
  ```
- When the user points at "this panel", "the parent panel", or another visible
  panel, inspect the visible tree with `panelTree.list()/roots()/children()`,
  choose the target panel, and read `await target.stateArgs.get()` to find its
  `channelName`/`channelId` before running channel diagnostics.

For perspective-heavy investigations, use `inline_ui` to render a small panel
tree or channel-health dashboard so the user can see and choose the same target
you are inspecting.

## Basic Usage

```
eval({ code: `console.log("hello")` })
```

Workspace packages are build-resolved automatically. To exercise or inspect a
built package, use a normal static import and return only the small export
summary you need—the first import builds on demand and later imports are cached:

```ts
import * as pkg from "@workspace-skills/workspace-dev";
return { exports: Object.keys(pkg).sort() };
```

Do not search generated build directories or call a separate “import build”
service. For npm packages, declare the npm mapping in the eval tool's `imports`
argument; workspace package specifiers need no mapping. See
[workspace and npm import rules](#imports) for
ref-pinned imports and the full rules.

Console capture belongs to eval itself; no panel, CDP session, or testkit helper
is needed. A single successful eval may emit several lines and return a compact
summary:

```ts
console.log("line 1");
console.log("line 2");
console.log("line 3");
return { lines: 3 };
```

The tool result contains the captured console text plus the return value. Use
panel `cdp.consoleHistory()` only when the task specifically asks for console
messages produced inside a rendered panel.

For multi-file code, put the entry point in a context-relative file and use `path`:

```
eval({ path: ".vibestudio/eval/check-project.ts" })
```

File-loaded eval reads the entry file from the current context, supports static
relative imports from that file, and resolves bare imports from the nearest
`package.json` when it can find one.

When `path` names a non-executable document/data file (for example `.md`,
`.json`, `.yaml`, or `.txt`), eval returns its UTF-8 contents instead of trying
to parse it as TypeScript. Executable `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.mts`, `.cts`, and `.tsx` paths retain normal file-execution behavior.

Inline `code` eval normally has no source file. To resolve relative imports,
pass `sourcePath` as a context-relative virtual filename, or pass `path` with
inline code as a directory/file hint. With no inline code, `path` retains its
file-loaded meaning. For substantial multi-file work, prefer a real entry file.

## Parameters

| Param     | Type                             | Default | Description                                                            |
| --------- | -------------------------------- | ------- | ---------------------------------------------------------------------- |
| `code`    | string                           | —       | TypeScript/JavaScript code to execute |
| `path`    | string                           | —       | Code file to execute, text/data file to load, or a source-base hint when `code` is also present |
| `sourcePath` | string                        | —       | Virtual context-relative filename for inline code and relative imports |
| `syntax`  | `"javascript" \| "typescript" \| "jsx" \| "tsx"` | `"tsx"` | Source syntax                                           |
| `imports` | `Record<string, string>`         | —       | Packages to build on-demand (workspace or npm)                         |

## Injected Variables

These are available in eval code. `services`, `ctx`, `scope`, `scopes`, `db`,
`help`, `chat`, and `agent` are eval-only ambient variables. `rpc` and `fs` are
the same portable bindings used by panels/workers; use them ambiently or import
them from `@workspace/runtime`. Eval also accepts importing an available ambient
helper from `@workspace/runtime` as a compatibility form; it resolves to the
same live binding rather than shadowing it.

| Variable | What it is |
| --- | --- |
| `rpc.call(targetId, method, args)` | Portable RPC client, same shape as panels/workers. Raw server services target `"main"`: `await rpc.call("main", "vcs.status", ["ctx:" + ctx.contextId])` |
| `services` | Convenience namespace for server services. If the service name is also a rich runtime binding (`workers`, `vcs`, `fs`, `credentials`, `blobstore`, …), `services.<name>` is that ergonomic runtime client, not the raw service catalog. Raw catalog methods are always reachable with `rpc.call("main", "<svc>.<method>", [...])`; non-colliding services are also reachable as `services.<svc>.<method>(...)`. Access is still gated server-side by each method's policy. Use `help()` to list services and `help("workers")` to inspect a runtime binding. |
| `fs` | Context-scoped filesystem — the EvalDO resolves your context, so you do NOT pass a contextId: `await fs.readdir("/")`, `await fs.readFile("src/index.ts", "utf-8")` |
| `ctx` | `{ contextId, objectKey }` for the current eval session |
| `scope` | Persistent REPL scope (see below); `scope.x = …` survives across calls in the same channel |
| `scopes` | Management API for the serialized scope layer (see below) |
| `db` | Synchronous in-DO SQLite (see below) |
| `chat` | The full chat API for the current channel — `publish`/`send`, custom-message cards, `registerMessageType`, `callMethod`, etc. (agent eval only; see below) |
| `agent` | Inspect/configure THIS agent's own state — `await agent.describe()`, `await agent.setModel("provider:model")`, etc. (agent eval only; see below) |
| `help()` | `await help()` lists services + import guidance; `await help("vcs")` describes one service |

```
eval({ code: `
  const files = await fs.readdir("/");
  scope.fileCount = files.length;
  return files.slice(0, 10);
` })
```

### chat (agent eval)

When eval runs **as an agent** (the agent's own server-side EvalDO), a `chat`
binding for the agent's current channel is injected — the same surface as
[CHAT_API.md](CHAT_API.md): `chat.send`, `chat.publish`,
`chat.publishCustomMessage`/`chat.updateCustomMessage`,
`chat.registerMessageType`/`chat.clearMessageType`, `chat.callMethod`,
`chat.callMethodByHandle`, `chat.participantByHandle`, `chat.contextId`,
`chat.channelId`, etc. Everything publishes **as the agent** (correct `@agent`
attribution).

```
eval({ code: `
  await chat.registerMessageType({
    typeId: "status",
    displayMode: "row",
    source: { type: "file", path: "renderers/status.tsx" },
    stateSchema: { type: "object", properties: { phase: { type: "string" } } },
  });
  const { messageId } = await chat.publishCustomMessage({ typeId: "status", initialState: { phase: "starting" } });
  await chat.updateCustomMessage(messageId, { phase: "done" });
` })
```

Under the hood `chat` is a thin proxy: the EvalDO forwards each call to the
owning agent DO, which performs it with its channel machinery and relays the
result. `chat.callMethod` resolves to the **delivered** participant result, and
`chat.participantByHandle` is async (the roster is fetched over RPC).
`chat.focusMessage` is panel-only and resolves `false` server-side.

`chat.callMethod` and `chat.callMethodByHandle` are channel-scoped. They only
route to participants in `chat.channelId`. To inspect an agent or channel from
another panel, first identify that panel's channel id from its state args, then
use GAD inspectors or the channel DO's read-only `inspectAgent` method.

> Note: `chat` is only present for **agent** eval. CLI/panel eval (no channel)
> gets no `chat` — interact with the channel through `rpc`/`services` instead.
> The `chat` handle is also available to panel-rendered components
> (`inline_ui`, `feedback_custom`, action bars) — see [CHAT_API.md](CHAT_API.md).

### agent (agent eval)

When eval runs **as an agent**, an `agent` binding lets the agent introspect and
reconfigure **itself**. Config is **per-agent** (one model, thinking level,
approval posture, respond policy, … shared across every channel the agent is in)
— it is NOT per-channel. Writes apply to all the agent's channels and take effect
on the next turn.

```
// Read your own state (identity, resolved config, channels, tools, turn, effects):
const me = await agent.describe();
me.config.model;        // the model you are running
me.channels;            // every channel you're a member of
me.turn.status;         // this channel's turn status

// Reconfigure yourself (each returns the updated config):
await agent.setModel("openai:gpt-5.3");
await agent.setThinkingLevel("high");
await agent.setApprovalLevel(2);          // UX convenience; sensitive ops are gated by app approvals
await agent.setRespondPolicy("mentioned-or-followup");
await agent.setRespondFrom(["@alice"]);   // handles resolve per-channel
await agent.configure({ model: "…", thinkingLevel: "medium" });  // batch
```

To make a spawned/headless agent inherit your model, read it here and pass it
into the new agent's **creation** config (its `stateArgs.agentConfig.model`),
since model rides creation — not the subscription.

> Note: `agent` is only present for **agent** eval (same gate as `chat`); the
> EvalDO forwards each call to your own vessel, which only accepts your own eval.

## Top-level Await

Fully supported. Async operations are automatically tracked and awaited:

```
eval({ code: `
  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
  console.log(data);
  return data;
`
})
```

A trailing async IIFE is also treated as the eval result and awaited:

```ts
(async () => {
  await services.vcs.push({ repoPaths: ["panels/example"] });
  return "done";
})();
```

Use `void (async () => { /* ... */ })()` only when intentionally starting
detached background work. Detached work may outlive the eval result, so it is
not appropriate for mutations whose result or failure the caller needs.

## Console Output

`console.log/warn/error/info/debug` output is captured during the run and
returned to the agent in the result's `console` field.

This is only the eval run's own console output. To debug the workspace server
host process itself, query `services.serverLog.tail/query/stats` from eval, or
open the `about/server-logs` viewer for a live follow. See
`../server-logs/SKILL.md`.

## Result Shape

`eval.run` returns `{ success, console, returnValue?, error?, scopeKeys? }`:

- `success` — whether the run completed without throwing.
- `console` — captured console output. Oversized output is windowed in the
  terminal result; a bounded saved copy is available as `scope.$lastConsole`.
- `returnValue` — the `return` value (or last expression), safe-serialized.
  Oversized values may be replaced with a structured truncation summary pointing
  at `scope.$lastReturn`.
- `error` — present on failure.
- `scopeKeys` — the keys currently held in the persistent `scope`.

Non-serializable values (functions, symbols, circular refs) are safely converted
to string representations in `returnValue`.

The most recent defined return is also retained as `scope.$lastReturn` for a
follow-up eval. Small returns keep their structured shape; oversized returns are
stored as a bounded JSON/text string and can be paged with `.slice(...)`.

Terminal eval results are always bounded so a huge return cannot strand the
turn in `eval:pending`. For large data, return a compact summary and keep the
full value in `scope`, `db`, or `blobstore` for follow-up paging/grep.

## Imports

Workspace and npm packages are loaded via the `imports` parameter (npm) or
auto-resolution (workspace), then brought in with a normal `import`. Both static
`import` and dynamic `await import(...)` work — they compile to the EvalDO's
per-object require, which is isolated per owner (your loaded modules never leak
to another agent's EvalDO sharing the same isolate).

Do NOT import the **ambient-only** globals (`services`, `scope`, `scopes`, `db`,
`ctx`, `help`, `chat`) — they are injected free variables, not module exports,
and the eval engine rejects importing them.

`rpc` and `fs` are the exception: they are injected ambiently (the table above)
**and** re-exported by `@workspace/runtime`, so importing them is allowed and
gives the full portable client. `import { rpc } from "@workspace/runtime"` is the
3-arg `rpc.call(targetId, method, args)` client (the ambient `rpc` is 2-arg sugar
over the server); `import { fs } from "@workspace/runtime"` is the same
context-scoped fs.

### Importing the runtime surface

`@workspace/runtime` is importable in eval and exposes the **same portable
surface** as panels and workers — so the same code runs on any target:

```
eval({ code: `
  import { vcs, workspace, gad, credentials, openPanel, panelTree } from "@workspace/runtime";
  const head = await vcs.resolveHead("main", "panels/my-panel");
  const off = vcs.subscribeHead(head, (advance) => console.log("head advanced", advance));
` })
```

Importable members: `id`, `contextId`, `rpc`, `fs`, `gad`, `blobstore`,
`workspace`, `credentials`, `git`, `vcs`, `webhooks`, `extensions`, `approvals`,
`notifications`, `workers`, `doTargetId`, `createDurableObjectServiceClient`,
`gatewayConfig`, `gatewayFetch`, `openExternal`, `openPanel`, `listPanels`,
`getPanelHandle`, `panelTree`. (`gatewayFetch` in eval is **gateway-relative
only** — use `credentials.fetch` for external requests.)

#### CDP (Chrome DevTools Protocol) from eval

Drive a live panel's browser target over CDP — full commands **and** events —
from eval. Get an endpoint from a panel handle, then connect with
`CdpConnection` from `@workspace/cdp-client`:

```
eval({ code: `
  import { CdpConnection } from "@workspace/cdp-client";
  const handle = getPanelHandle("<panelSlotId>");
  const { wsEndpoint, token } = await handle.cdp.getCdpEndpoint();
  const cdp = await CdpConnection.connect(wsEndpoint, token);
  cdp.on("Runtime.consoleAPICalled", (e) => console.log("panel console:", e.args));
  await cdp.send("Runtime.enable", {});
  const r = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  return r.result.value;
` })
```

### Workspace packages — auto-resolved

Workspace packages (`@workspace/*`, `@workspace-skills/*`, `@vibestudio/*`) are
**automatically built and loaded** when you import them. Just write the import —
no `imports` parameter needed:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
```

The first import triggers an on-demand build from the eval caller's current
context working state (a few seconds). Subsequent imports of that state use the
cached build.

To pin a specific VCS ref or state hash, use the `imports` parameter explicitly:

```
eval({ code: `...`, imports: { "@workspace-skills/workspace-dev": "state:<stateHash>" } })
```

The map value is a *ref*, not a package name. Omit workspace packages entirely
for the current context; `"latest"`, `"workspace"`, and package-manager-style
`"workspace:*"`/`"workspace:^"`/`"workspace:~"` are accepted aliases for that
same context working state. Explicit pins are GAD build refs: `"main"`,
`"ctx:<contextId>"`, or `"state:<stateHash>"`. Git branches, tags, and raw SHAs
are not build refs. Workspace bundles include subpath exports.

**Important:** Workspace runtime units are built from your context head's working state, which is always in lockstep with your edits. The model is **edit → commit → push**: the `edit`/`write` tools and `vcs.edit({ edits })` record each change to source under `apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, or `skills/` as one tracked working edit on your context head and project it to disk, so the change takes effect for builds immediately (a working edit is NOT a commit — `vcs.commit({ message })` seals working edits as a messaged milestone, and `vcs.push` advances `main`). Runtime `fs` mutations under source repos route through the same GAD working state, so Node-like code cannot bypass VCS; prefer `edit`/`write`/`vcs.edit` for intentional authoring because they expose edit intent and invocation provenance directly.

Context folders are isolated working trees backed by per-repo context-local VCS heads. Do not assume another context's edits reset your current context. An "unpushed changes" count shown by a running panel is the unpushed state of that panel's own per-repo context head (changes ahead of that repo's `main`), not a global workspace state.

### npm packages

Use the `imports` parameter with `"npm:<version>"`, then `import` the package:

```
eval({
  code: `
    import _ from "lodash";
    console.log(_.chunk([1, 2, 3, 4, 5, 6], 2));
  `,
  imports: { "lodash": "npm:^4.17.21" }
})
```

```
eval({
  code: `
    import * as d3 from "d3-array";
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    console.log("mean:", d3.mean(data));
    console.log("deviation:", d3.deviation(data));
  `,
  imports: { "d3-array": "npm:^3.0.0" }
})
```

Version values follow registry semver/range conventions accepted by the build
service: `"npm:1"`, `"npm:1.3.0"`, `"npm:^1.0.0"`, `"npm:~2.3.0"`,
`"npm:latest"`, or `"npm:*"`.
The import-map key is the package name; prefer version-only values such as
`imports: { "left-pad": "npm:1.3.0" }`. Package-qualified values like
`"npm:left-pad@1.3.0"` are accepted only when the package name matches the key.

Packages are installed with `--ignore-scripts` for security (no postinstall hooks). Specifiers are validated against npm naming rules — only standard package names are accepted (no URLs, file paths, or git refs). Native addon packages (those requiring `.node` binary files) are not supported.

Installed packages and their bundles are both cached, so subsequent imports of the same package/version are fast. The first install of a new package may take 10-30 seconds (npm download + esbuild bundle); eval waits for that work to complete.

For file-loaded code, npm package versions are inferred from the nearest
`package.json` dependency fields when possible. The lookup checks
`dependencies`, `peerDependencies`, `optionalDependencies`, and
`devDependencies`, in that order. Use `imports` to override or provide versions
not declared there.

File-loaded code also supports package-local aliases declared through
`package.json` `imports` (for `#alias` style imports) and simple
`tsconfig.json` `compilerOptions.paths` mappings.

### Mixing workspace and npm imports

```
eval({
  code: `
    import { createProject } from "@workspace-skills/workspace-dev";
    import Ajv from "ajv";
    const ajv = new Ajv();
    console.log("Ajv loaded:", typeof ajv.compile);
  `,
  imports: {
    "@workspace-skills/workspace-dev": "latest",
    "ajv": "npm:^8.12.0"
  }
})
```

### Limitations

- `package.json` `exports`, lockfile-exact versions, and full Node
  `node_modules` resolution are not implemented.
- Only packages with standard npm names are accepted (e.g. `lodash`, `@scope/pkg`). URLs, file paths, and git specifiers are rejected.
- Packages requiring native addons (`.node` binaries) won't work — esbuild cannot bundle them.

## Path Conventions

The `path` parameter for file-loaded eval is always context-relative, for
example `.vibestudio/eval/check-project.ts`.

Runtime `fs.*` calls are also scoped to the current context folder. In `fs`
calls, both `src/index.ts` and `/src/index.ts` refer to files under the context
root; the leading slash means context-root absolute, not a host filesystem path.
Prefer paths without a leading slash in examples that touch workspace source,
and never pass host absolute paths such as `/home/user/.../workspace/...`.

## REPL Scope

`scope` is a persistent object shared across eval calls within the same channel.
Store data — query results, intermediate state, config — in `scope.*` and it is
available on the next eval call. After every eval call the EvalDO serializes
`scope` to its own SQLite (`repl_scopes` table) and rehydrates it on the next
run, so scope survives EvalDO eviction and reconstruction.

### scope vs scopes

- **`scope`** — the persistent REPL object. Read/write `scope.x` during normal
  operation; assignments and deep mutations are saved after each eval call.
- **`scopes`** — management API for the serialized (DB) layer:
  - `scopes.currentId` — current scope's durable UUID
  - `scopes.push()` — serialize + archive current scope, start a fresh one (only serializable values carry over)
  - `scopes.get(id)` — retrieve an archived scope by its durable ID (deserialized snapshot — data only, no functions)
  - `scopes.list()` — list all scopes for this channel with keys and partial keys
  - `scopes.save()` — force-serialize scope to DB now

### Serialization

Scope is serialized per-property when persisted:

- **Kept:** primitives, plain objects, arrays, Date, Map, Set, RegExp
- **Dropped:** functions, symbols, class instances, WeakRef/WeakMap/WeakSet, circular refs, depth > 20

Because the EvalDO is a server-side isolate (not the browser), prefer storing
plain serializable data in `scope`. Functions and class instances held in
`scope` between calls only survive while the EvalDO instance stays warm; after
idle eviction the scope is rehydrated from the serialized snapshot, so any
non-serializable values are lost.

### Resetting scope

To start with an empty scope and empty `db`, reset the eval context. The agent
`eval` tool accepts `reset: true`; reset and the following execution are atomic
and idempotent on that tool invocation. It drops your user `db` tables and the
persistent scope before running the supplied code, preserving only reserved/base
tables. Verify reset effects in that call or a later call.

Do not call `eval.reset` or `eval.forceReset` through `rpc` from inside eval
code. Nested RPC is authenticated as the EvalDO, not as the agent that invoked
the tool, so it cannot address the executing agent/channel sandbox. Those raw
service methods exist for host lifecycle recovery; the agent-facing lifecycle
surface is `eval({ reset: true, ... })`.

### Deep Mutations

Deep mutations (`scope.data.push(x)`, `scope.config.key = val`) are captured by
the post-eval auto-save. No need for extra `scopes.save()` calls within eval.

## Database Access

`db` is a **synchronous** in-DO SQLite database, persisted in the EvalDO across
calls (so it survives across turns and panel disconnects). It is the persistent
storage companion to `scope`.

```
eval({ code: `
  db.run("CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, note TEXT)");
  db.run("INSERT INTO findings (note) VALUES (?)", "first finding");
  const rows = db.exec("SELECT * FROM findings");
  console.log(rows);
  return rows;
` })
```

- `db.exec(query, ...params)` runs a statement and returns the rows as an array.
- `db.run(query, ...params)` runs a statement for its side effect (no result).
- Reserved tables `state`, `repl_scopes`, and `sqlite_*` are off-limits to
  destructive statements (DROP/DELETE/ALTER/UPDATE/INSERT/REPLACE/TRUNCATE/CREATE)
  — use your own table names. Create and write your own tables freely.

For storage that other panels, apps, workers, or agents need to read, define a
worker Durable Object and use its `this.sql`, then declare it as a userland
service and call it over RPC:

```ts
import { rpc, workers } from "@workspace/runtime";

const store = await workers.resolveService("example.todos.v1", "project-123");
if (store.kind !== "durable-object") throw new Error("Expected DO service");
const todos = await rpc.call(store.targetId, "listTodos", []);
```

See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#durable-object-backed-app-databases)
for the full app database pattern. The eval `db` is private to your EvalDO.

## Filesystem Access

`fs` is injected and scoped to your current context — no contextId argument.
Relative paths and leading-slash paths are both context-root-relative: `"note.txt"`
and `"/note.txt"` stay inside the context; the leading slash never names a host
filesystem path.

```
eval({ code: `
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
` })
```

Pass an encoding such as `"utf-8"` when reading text. Without an encoding,
`fs.readFile` returns bytes, so string methods like `.replace()` will fail.

Use `await help("fs")` for the live surface. Common methods include `readFile`,
`writeFile`, `appendFile`, `readdir`, `stat`, `mkdir`, `rm`, `exists`,
`copyFile`, `rename`, `open`, `grep`, `glob`, and `mktemp`.

`fs.open(path, flags?, mode?)` returns the portable low-level file-handle
contract `{ fd, read, write, stat, close }` in eval, panels, workers, and
Durable Objects. `read(buffer, offset, length, position)` resolves to
`{ bytesRead, buffer }`; `write(data, offset?, length?, position?)` resolves to
`{ bytesWritten, buffer }`. Always close in `finally`:

```ts
const path = await fs.mktemp("handle");
await fs.writeFile(path, "hello");
const handle = await fs.open(path, "r+");
try {
  const buffer = new Uint8Array(5);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  await handle.write(new TextEncoder().encode("H"), 0, 1, 0);
  console.log({ bytesRead, text: new TextDecoder().decode(buffer) });
} finally {
  await handle.close();
  await fs.rm(path, { force: true });
}
```

`fs.stat()` and `fs.lstat()` return Node-shaped metadata: `mtime` and `ctime`
are `Date` instances (with `mtimeMs`/`ctimeMs` numeric companions), alongside
`size`, `mode`, and the `isFile()`/`isDirectory()`/`isSymbolicLink()` methods.

Portable `node:fs`/`node:fs/promises` imports and the equivalent bare Node
aliases `fs`/`fs/promises` are backed by this same context-scoped filesystem,
never the host filesystem. The other safe compatibility modules accept both
spellings too (`node:path`/`path`, `node:os`/`os`, `node:util`/`util`, and
`node:crypto`/`crypto`). Eval is asynchronous, so
prefer promises. For direct default or namespace `node:fs` imports, familiar
top-level supported calls such as `readFileSync()`, `writeFileSync()`, and
`unlinkSync()` are automatically lifted to their awaited portable equivalents;
code inside a nested synchronous callback should use the async methods
explicitly.

`node:path` is available for path manipulation. A tenant-neutral `node:os`
facade is also available for portable recipes: notably, `tmpdir()` returns the
context-local `/.tmp` directory rather than a host path. Machine identity,
network, CPU, and memory methods return stable non-host values.
Pure `node:util` helpers are available too, including `TextEncoder`,
`TextDecoder`, `inspect`, and `promisify`.
Pure `node:crypto` hashing, randomness, and Web Crypto compatibility are
available as well.

For disposable files, let `mktemp` choose an untracked path. This is the
canonical write → rename → content-match flow:

```ts
const source = await fs.mktemp("copy-rename");
const renamed = `${source}.renamed`;
const expected = "sandbox rename check\n";

try {
  await fs.writeFile(source, expected);
  await fs.rename(source, renamed);
  const actual = await fs.readFile(renamed, "utf-8");
  if (actual !== expected) throw new Error("content mismatch after rename");
} finally {
  await fs.rm(source, { force: true });
  await fs.rm(renamed, { force: true });
}
```

Use `fs.copyFile(source, destination)` instead when both files should remain.
Paths inside a workspace repo (`packages/<name>/…`, `panels/<name>/…`, etc.)
are routed into that context's VCS working edits. Platform-ignored paths and
paths outside workspace source repos stay as direct, context-local scratch
files. Prefer `mktemp` for scratch to avoid collisions; for intentional source
authoring, prefer the `edit`/`write` tools or `vcs.edit` so the edit and its
provenance are explicit.

## Calling Services

Use `rpc.call("main", "<svc>.<method>", [...])` to reach raw server/main service
catalog methods from eval. `services.<svc>.<method>(...)` is available for
service names that do not collide with runtime bindings, but rich runtime
bindings win on collision: `services.workers` is the ergonomic `workers` client,
which includes worker `create`/`list`/`destroy` plus `listSources()`. The equivalent raw catalog call is
`rpc.call("main", "workers.listSources", [])`.

```
eval({ code: `
  const tree = await rpc.call("main", "workspace.sourceTree", []);
  console.log("Workspace tree:", tree);
  // Use the ergonomic runtime binding when available:
  const tree2 = await workspace.sourceTree();
` })
```

Use `await help()` for live discovery and `await help("vcs")` or
`await help("workers")` for one runtime binding's actual eval surface. Pass the
name as a string; do not call `help(workers)`.

## Worker Management

Launch, list, and retire regular workers with the typed `workers.create`,
`workers.list`, and `workers.destroy` methods. They delegate to the canonical
runtime entity lifecycle, whose raw methods remain available for advanced and
non-worker entities. List launchable sources with `workers.listSources()`. Each
row includes `source`, the manifest's real `entry` (do not guess `index.ts`), and
`classes` (empty for regular workers).

```
eval({ code: `
  // Launchable worker sources (the workers/* repos that can be started)
  const sources = await workers.listSources();
  console.log("Available worker sources:", sources);

  // Currently-running worker instances
  const instances = await workers.list();
  console.log("Running instances:", instances.map((w) => w.id));
` })
```

```
eval({ code: `
  const key = \`worker-probe-${crypto.randomUUID()}\`;
  let handle;
  try {
    // \`key\` names the instance; pass \`ref\` for code edited on the current
    // context head, or omit it for the main build.
    handle = await workers.create("workers/my-worker", {
      key,
      contextId: ctx.contextId,
      ref: \`ctx:${ctx.contextId}\`,
      env: { NON_SECRET_PROBE: "configured" },
    });
    const during = await workers.list();
    if (!during.some((entity) => entity.id === handle.id)) throw new Error("Worker was not listed");
  } finally {
    if (handle) await workers.destroy(handle);
  }
  const after = await workers.list();
  if (handle && after.some((entity) => entity.id === handle.id)) {
    throw new Error("Worker remained active after retireEntity");
  }
` })
```

`env` accepts extra string bindings and delivers them to the worker's `env`
parameter (`WorkerEnv`), not Node's `process.env`. A successful
`runtime.createEntity` proves that the host accepted the configuration and
started the worker; it does **not** prove that worker code read a particular
value. To claim runtime observation, call a worker HTTP endpoint or exposed RPC
method designed to return one named, non-secret probe value. Never add generic
entity introspection that returns the full env object or arbitrary secret keys.
See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#worker-lifecycle-and-environment-bindings)
for the worker-side probe pattern.

The probe belongs in the worker being tested; a successful check must call that
worker through the returned `targetId`. See
[workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#worker-lifecycle-and-environment-bindings)
for the narrow fixed-method pattern. Do not use a permanently shipped sample as
a substitute for testing the actual worker.

## Workspace VCS

Use the `vcs` service for workspace source changes:
`rpc.call("vcs.<method>", [...])` or `services.vcs.<method>(...)`.

The model is **edit → commit → push**, and `main` advances ONLY via push:

- `vcs.edit({ edits })` records a *working* change on your context head and
  projects it to disk so it builds immediately. It returns a `VcsEditResult`
  (`{ head, stateHash, committed: false, status: "uncommitted", editSeq,
  changedPaths }`). It is **not** a commit, has no message, and does not appear
  in `vcs.log`. The `edit`/`write` tools do exactly this for you.
- `vcs.commit({ message })` folds your uncommitted working edits into a per-repo
  snapshot — a deliberate, messaged milestone. The `message` is **mandatory**.
  It returns a `VcsCommitResult[]` (`{ repoPath, head, stateHash, eventId,
  editCount, status: "committed" | "unchanged", changedPaths }`).
- `vcs.push({ repoPaths })` advances `main`. Push is **fast-forward-only** and
  **build-gated** (see below).

So edit ≠ commit: accumulate working edits, then seal them as named commits.

VCS tracks workspace **source**: every path must live under a tracked directory
(`projects/`, `panels/`, `packages/`, `apps/`, `workers/`, `skills/`,
`extensions/`). A *temporary* file you write still goes under one of those (e.g.
`projects/tmp-foo/note.txt`) — `vcs.edit` rejects platform-ignored paths
(`.vibestudio`, `.tmp`, `.git`, `.gad`, `node_modules`, `dist`, `.env`, `*.log`),
so never use an `fs.mktemp()` path here. In container sections such as
`projects/`, `section/name` is the repo root; write `section/name/file`, not the
repo root itself. File-oriented APIs accept a file-looking shorthand such as
`projects/note.txt` and return its canonical expansion
`projects/note/note.txt`; names without an extension remain repo roots.
`vcs.readFile({ path })` returns
`{ content, stateHash, ... }` (no `baseStateHash` field) — pass its `stateHash`
as the `baseStateHash` of a later `vcs.edit`. `content` is a tagged union:
use `content.text` only after checking `content.kind === "text"`; binary reads
return `{ kind: "bytes", base64 }`.

No scaffold is required for a temporary project repo. Writing
`projects/tmp-foo/note.txt` is enough to create context-local working content for
repo `projects/tmp-foo`. It stays private to the current context until you
explicitly `vcs.commit` and `vcs.push` that repo. `createProject` is for
published workspace units and pushes immediately.

```
eval({ code: `
  const before = (await services.vcs.resolveHead("main", "panels/my-panel")).stateHash;
  const result = await services.vcs.edit({
    baseStateHash: before,
    edits: [
      { kind: "write", path: "panels/my-panel/index.tsx", content: { kind: "text", text: "..." } },
    ],
  });
  console.log("Working state:", result.stateHash, "committed:", result.committed); // false
  const status = await services.vcs.status("panels/my-panel");
  console.log("Uncommitted edits:", status.uncommitted);

  // Seal the working edits as a milestone (message is mandatory):
  const [commit] = await services.vcs.commit({
    message: "Wire up my-panel index",
    repoPaths: ["panels/my-panel"],
  });
  console.log("Committed:", commit.eventId, commit.changedPaths);
` })
```

When editing based on a prior read, unwrap text content explicitly:

```
eval({ code: `
  const repoPath = \`projects/tmp-\${Date.now()}\`;
  const path = \`\${repoPath}/note.txt\`;
  await services.vcs.edit({
    edits: [{ kind: "write", path, content: { kind: "text", text: "initial\\n" } }],
  });

  const read = await services.vcs.readFile({ path });
  if (!read) throw new Error(\`Missing file: \${path}\`);
  if (read.content.kind !== "text") throw new Error(\`Not a text file: \${path}\`);

  await services.vcs.edit({
    baseStateHash: read.stateHash,
    edits: [{
      kind: "write",
      path,
      content: { kind: "text", text: read.content.text + "\\nupdated\\n" },
    }],
  });

  // Drop the working edits if you change your mind (also clears a pending merge):
  // await services.vcs.discardEdits(repoPath);
` })
```

`vcs.status(repoPath, head?)` scopes to one repo (a positional repo path like
`"panels/my-panel"`, not a workspace root or filesystem path). Its optional
second argument is a materialized VCS head such as `"main"` or `"ctx:..."`. It
reports that repo head's `uncommitted` working-edit count and its committed
changes vs the repo's own `main`, not filesystem dirtiness. Ship a repo's
**committed** changes into its `main` with the fast-forward-only, build-gated
`vcs.push({ repoPaths: ["panels/my-panel"] })` (push throws if working edits are
uncommitted — commit or `vcs.discardEdits` first). To compare two committed
states, use state hashes returned by `vcs.edit`/`vcs.commit` or `resolveHead`:

```
eval({ code: `
  const before = (await services.vcs.resolveHead("main", "panels/my-panel")).stateHash;
  const after = (await services.vcs.resolveHead(undefined, "panels/my-panel")).stateHash;
  const diff = before ? await services.vcs.diff(before, after) : null;
  console.log({ before, after, diff });
` })
```

### Push, divergence, and merge

`vcs.push` builds the candidate (esbuild + tsc) before any head moves and
fast-forwards `main` only if your base is still its tip. Its result is a
discriminated union on `status`: `"pushed"` / `"up-to-date"` (success),
`"build-failed"` (no head advanced — `reports[].builds[].diagnostics[]` carry the
structured `{ source, severity, file, line, column, message }` errors), or
`"diverged"` (`main` moved past your base; `divergences[]` name the repos). On
`diverged`, fold `main` into your head with `vcs.merge(repoPath)`:

```
eval({ code: `
  const result = await services.vcs.push({ repoPaths: ["panels/my-panel"] });
  if (result.status === "diverged") {
    const merge = await services.vcs.merge("panels/my-panel");
    if (merge.mergeable === "clean") {
      // clean merge auto-commits — just re-push
      await services.vcs.push({ repoPaths: ["panels/my-panel"] });
    } else {
      // conflict markers were written into merge.conflictPaths; resolve them
      // with vcs.edit, then seal and re-push:
      // await services.vcs.edit({ edits: [/* resolved files */] });
      // await services.vcs.commit({ message: "Resolve merge", repoPaths: ["panels/my-panel"] });
      // await services.vcs.push({ repoPaths: ["panels/my-panel"] });
      console.log("Conflicts to resolve:", merge.conflictPaths);
    }
  }
` })
```

To dry-run a build of your **working** content before committing (same structured
diagnostics, no head advance and no EV baseline written), use
`vcs.previewBuild({ repoPaths: ["panels/my-panel"] })`.

## Large Results And Diagnostics

Do not return broad hydrated channel histories, full `scope` dumps, large DOM
dumps, or full GAD payloads from `eval`. Large values are intentionally stored as
blob refs in trajectory/channel storage; broad hydrated reads can pull them back
into the transcript and hide the useful part of the report.

Eval has a safety net for accidental large output: terminal console/return data
is windowed before it is persisted or delivered. The tool result will point to
`scope.$lastConsole` or `scope.$lastReturn` when a bounded saved copy exists.
Read those values in pages, for example:

```ts
return scope.$lastReturn.slice(0, 40_000);
// or
return /needle/.test(scope.$lastConsole);
```

That fallback is for recovery, not a reporting pattern. Prefer compact
summaries first.

Prefer compact inspectors first:

```ts
return await rpc.call("main", "gad.inspectChannelEnvelopes", [{ channelId, limit: 50 }]);
return await rpc.call("main", "gad.inspectTurnState", [{ branchId }]);
return await rpc.call("main", "gad.inspectInvocationState", [{ transportCallId }]);
return await rpc.call("main", "gad.inspectPublicationIntegrity", [{ channelId }]);
return await services.serverLog.query({ level: "warn", contains: "BuildV2", limit: 100 });
```

If you need a large artifact, store the full bytes/text in the **blobstore** and
return its digest, byte count, and a small head sample. Keep full objects in
`scope` only for short-lived interactive follow-up.

The blobstore is a curated runtime binding — reach it as `services.blobstore`
(equivalently `import { blobstore } from "@workspace/runtime"`, or a raw
`rpc.call("main", "blobstore.<method>", [...])`). Read/write methods
(`putText`/`putBase64`/`getText`/`readText`/`getRange`/`grep`/…) work from agent eval; the
admin methods (`delete`/`list`) are server-only. Raw calls
use `rpc.call("main", "blobstore.<method>", [...])`. A binary
artifact such as a `Uint8Array` screenshot can be stored directly:

```ts
const png = await page.screenshot();
const { digest, size } = await services.blobstore.putBytes(png);
return { digest, size, mimeType: "image/png" };
```

At the raw service boundary, use exactly one base64 string:

```ts
const { digest, size } = await services.blobstore.putBase64(pngBase64);
return { digest, size, mimeType: "image/png" };
```

The content-addressed store records bytes only. Keep MIME type, filename, and
other artifact metadata alongside the returned digest rather than passing them
as extra `putBase64` arguments.

Preferred return shape for large artifacts:

```ts
const text = JSON.stringify(largeValue);
const stored = await services.blobstore.putText(text);
return {
  omitted: true,
  reason: "large diagnostic value stored in blobstore",
  digest: stored.digest,
  bytes: new TextEncoder().encode(text).byteLength,
  type: Array.isArray(largeValue) ? "array" : typeof largeValue,
  keys: largeValue && typeof largeValue === "object" ? Object.keys(largeValue).slice(0, 20) : [],
  preview: text.slice(0, 1000),
};
```

`readText(digest)` is the portable readable alias of `getText(digest)`; both
return `string | null` directly (not an object with a `text` property).

The method transport also caps oversized durable results and records a blob
digest when storage is available. Agents should still return bounded summaries
because compact results are easier to inspect and less likely to hide the
important error message. Read stored text with
`services.blobstore.getRange(digest, offset, length)` or search it server-side
with `services.blobstore.grep(digest, pattern)`.

## Build System

```
eval({ code: `
  // Build a panel at the current head and get its bundle
  const build = await rpc.call("main", "build.getBuild", ["panels/my-app"]);
  console.log("Build artifacts:", Object.keys(build));

  // Build at a specific context branch when you intentionally want to test
  // edits made in that context. `contextId` alone never selects code provenance.
  const branchBuild = await rpc.call("main", "build.getBuild", ["panels/my-app", \`ctx:\${ctx.contextId}\`]);
  console.log("Context branch build:", branchBuild.sourceStateHash);

  // Build at a specific immutable GAD state ref (second arg). build.getBuild
  // needs a workspace-rooted composed state. vcs.log/vcs.commit/resolveHead
  // return repo-rooted states, so compose the repo state into a workspace view
  // before passing it to the build service.
  const [{ outputStateHash }] = await services.vcs.log("panels/my-app", 1);
  const { stateHash: workspaceStateHash } = await services.vcs.workspaceViewWithRepoAt(
    "panels/my-app",
    outputStateHash
  );
  const pinned = await rpc.call("main", "build.getBuild", ["panels/my-app", workspaceStateHash]);
  console.log("Built at:", pinned.sourceStateHash);

  // Runtime launches use main code unless `ref` is explicit. This creates a
  // worker that reads/writes ctx-1 but still runs the main build:
  await rpc.call("main", "runtime.createEntity", [{
    kind: "worker",
    source: "workers/agent-worker",
    key: "agent-main-code",
    contextId: "ctx-1"
  }]);

  // Targeted branch launch for testing code edited in ctx-1:
  await rpc.call("main", "runtime.createEntity", [{
    kind: "worker",
    source: "workers/agent-worker",
    key: "agent-ctx-code",
    contextId: "ctx-1",
    ref: "ctx:ctx-1"
  }]);

  // Check effective version
  const ev = await rpc.call("main", "build.getEffectiveVersion", ["panels/my-app"]);
  console.log("Effective version:", ev);
`
})
```

## Return Values

The last expression or `return` value is serialized and sent back to the agent:

```
eval({ code: `
  const files = await fs.readdir("src");
  return files;
` })
// Agent receives a result whose returnValue is ["index.ts", "utils.ts", ...]
```

## Timeouts

Eval runs are not bounded by a hidden wall-clock timeout; they finish on
completion, error, or explicit interruption. Split long work into shorter runs
and carry state in `scope` or `db` (both persisted in the EvalDO between runs,
across turns, and across panel disconnects).
