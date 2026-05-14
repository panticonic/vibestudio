# Extension Services

> **Status:** Planning document — design resolved, not yet implemented.

NatStack extensions are **long-lived Node processes** that run alongside the server and expose RPC APIs to userland panels and workers. They extend the application itself — adding new RPC services, reacting to system events, and exposing callable surfaces to userland — in the spirit of VSCode extensions, not browser extensions.

Extensions are **trusted, first-party-installed Node code**. They get the entire userland runtime (`fs`, `ai`, `git`, `panel`, `credentials`, …) and on top of that, full Node access (filesystem outside the workspace, child processes, native addons, sockets). Because of that elevated capability, every extension install and every code change to an installed extension goes through an **elevated approval flow** — a visually distinct, informed-consent prompt that calls out the trust level being granted.

Each extension runs in its **own forked Node process** (`utilityProcess.fork` in Electron, `child_process.fork` in standalone). Isolation is for **robustness, not security**: a buggy extension that crashes, leaks memory, segfaults a native addon, or hangs the event loop affects only its own process and can be respawned without touching the host.

## Extensions vs. panels vs. workers

| | Extension | Panel | Worker |
|---|---|---|---|
| Process | Per-extension Node process | Isolated webview | Workerd isolate |
| Runtime | Full Node + userland runtime | Userland runtime (browser) | Userland runtime (workerd) |
| Lifecycle | Eager activation at server boot | Opened on user navigation | Spawned by request |
| Reachable from outside | The `extensions` RPC service | Direct (URL) | Direct (RPC) |
| Lives at | `workspace/extensions/<scope>/<name>/` | `workspace/panels/<name>/` | `workspace/workers/<name>/` |
| Trust grant | Elevated approval (informed-consent UX) | Standard approvals per call | Standard approvals per call |

Extensions are the only userland kind with full Node access. Panels and workers run inside V8 isolates with no host-Node primitives.

## Workspace layout

Extensions are workspace units like panels and workers. Each is its own git repo inside `workspace/extensions/`:

```
workspace/extensions/
└── @acme/
    └── git-tools/
        ├── package.json          # Manifest with natstack.extension field
        ├── index.ts              # Entry (TypeScript source)
        └── ...
```

The scope `@workspace-extensions/*` is reserved for workspace-internal references. Cross-extension imports are not first-class in v1 (see Future work).

There is no per-user `{userData}/extensions/installed/` tree. Source lives in workspace git, bundles live in `{userData}/builds/<key>/` keyed by content hash, and per-extension scratch lives at `{userData}/extensions/storage/<workspaceId>/<name>/`. The registry is a small JSON in workspace state, mapping `name → { ref, sha, bundleKey, enabled, approvedRef, installedAt }`.

## Manifest

```json
{
  "name": "@workspace-extensions/git-tools",
  "version": "1.2.0",
  "private": true,
  "type": "module",
  "natstack": {
    "extension": {
      "displayName": "Git Tools",
      "entry": "index.ts",
      "activationEvents": ["*"]
    }
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `displayName` | string | package name | Human-readable name for UI |
| `entry` | string | `index.ts` | Entry source file (built JIT by buildV2 as a node-target ESM bundle) |
| `activationEvents` | string[] | `["*"]` | When to activate. `"*"` = eager at startup. Reserved for future lazy triggers; values other than `"*"` fail validation in v1. |

The presence of `natstack.extension` in `package.json` is what marks the unit as an extension to the package graph. Manifests are validated against a JSON schema at install time and again at boot; validation failures fail closed (extension is not activated and an error is recorded in the registry).

No `dist/` — extensions ship TypeScript source, the workspace build pipeline produces the runtime bundle. Cross-extension type sharing is not a first-class concern in v1.

## Build pipeline integration

Extensions are first-class buildV2 units. In `src/server/buildV2/packageGraph.ts`, `GraphNode["kind"]` gains `"extension"`; the package graph scans `workspace/extensions/` and discovers extension units alongside packages, panels, workers, and templates. The push trigger reacts to changes; effective-version computation, source extraction from git, and shared external-deps installation behave exactly as for any other buildable unit.

The new `extension` build kind is a node-target ESM build modeled on the worker build at `builder.ts:1443`. Concretely:

- `platform: "node"`, `target: "node20"`, `format: "esm"`, `splitting: false`, single `bundle.js`.
- Reuses `prepareBuildEnv`, source extraction via `git archive`, transitive external-deps install, and the workspace resolve plugin.
- Reads the manifest from the extracted source tree (not `node.manifest`) so ref-pinned builds use the manifest at the requested commit. Same source-of-truth pattern as the worker build.
- Plugins: workspace resolve (node conditions: `["import", "default"]`), TS extension plugin, dedupe plugin. No workerd-specific shims (crypto, buffer, node-stub plugins are dropped — Node provides these natively).
- `mainFields: ["module", "main"]` fallback for packages without an `exports` field.
- Native addons externalized via `KNOWN_NATIVE_EXTERNALS` (`*.node`, `fsevents`, `bufferutil`, `utf-8-validate`, `node-pty`, `cpu-features`, `@parcel/watcher`). Extensions resolve native addons at runtime from a per-extension `node_modules/` installed at activation time.
- **Inline sourcemaps always on** so stack traces and the Node inspector point at the original TypeScript.
- Output: `bundle.js` plus a generated `package.json` (`{"type":"module"}`), stored under `{userData}/builds/<key>/`.

The stale `agent` build kind described in `BUILD_SYSTEM.md` was never actually implemented in `builder.ts` and never reached `GraphNode["kind"]`. It corresponded to a removed `workspace/agents/` directory. The `extension` kind takes the slot the docs reserved for "node-target ESM", and stale references in `BUILD_SYSTEM.md` and the comment header of `packageGraph.ts` are removed in the same change.

## Activation contract

```ts
// workspace/extensions/@acme/git-tools/index.ts
import type { ExtensionContext } from "@natstack/extension";

export interface GitToolsApi {
  blame(path: string): Promise<BlameLine[]>;
}

export async function activate(ctx: ExtensionContext): Promise<GitToolsApi> {
  ctx.log.info("git-tools activating");

  await ctx.storage.mkdir("cache");

  ctx.subscriptions.push(
    ctx.panel.onOpened(p => ctx.log.debug("panel opened", p.id)),
  );

  return {
    async blame(path: string) { /* ... */ return []; },
  };
}

export async function deactivate(): Promise<void> {
  // optional cleanup; subscriptions are auto-disposed
}
```

`activate` returns the extension's **public API** — a plain object whose own enumerable function properties are callable from the host via RPC. There is no per-method registration step and no allowlist captured at activation time. The dispatcher resolves a call by reading `api[method]` and checking `Object.hasOwn(api, method) && typeof api[method] === "function"` at the time of the call. Anything else (`then`, `constructor`, inherited prototype methods, non-function properties) returns `ENOMETHOD`.

The API object is held by the extension process, not the host. The host knows the extension exposes some surface (recorded for `list`), and routes invocations across the wire.

Returning `void` is valid — the extension is then fire-and-forget (only useful for side effects, e.g. registering event handlers).

## `ExtensionContext`

```ts
interface ExtensionContext {
  // Identity
  readonly name: string;          // "@workspace-extensions/git-tools"
  readonly version: string;

  // Storage helper scoped to {userData}/extensions/storage/<workspaceId>/<name>/.
  readonly storage: ExtensionStorage;

  // Userland runtime — same client surface panels and workers see, dispatched
  // back to the host over the extension's WebSocket connection.
  readonly fs: FsClient;
  readonly ai: AiClient;
  readonly git: GitClient;
  readonly panel: PanelClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialsClient;
  readonly db: DbClient;
  readonly webhooks: WebhooksClient;
  readonly approvals: ApprovalsClient;
  readonly notifications: NotificationsClient;
  readonly extensions: ExtensionsClient;

  // Full Node — the std library, child_process, native addons, raw sockets.
  // Available to extensions, not to panels or workers. Subject to the
  // elevated-trust approval the user granted at install time.
  readonly node: typeof import("node:module");

  // Lifecycle. Disposables are disposed in LIFO order on deactivate.
  readonly subscriptions: Disposable[];
  readonly log: Logger;

  // Events (visible to subscribed panels, workers, and other extensions)
  emit(event: string, payload: unknown): void;
}
```

The userland clients on `ctx` are the same the panel runtime exposes, bound through the extension process's WebSocket connection to the dispatcher with `callerKind: "extension"` and `callerId: <extension name>`. Every call is attributed to the extension for logs and approval prompts.

Node's standard library is available globally inside the extension process — `import * as fs from "node:fs"`, child processes, native addons all work normally. `ctx.node` is reserved as a future home for any host-mediated Node helpers; in v1 it's the standard module surface.

## Process model

Each extension runs in its own forked Node process. The host owns an `ExtensionProcessManager` (a sibling to `WorkerdManager`) that:

- Spawns the process via `packages/process-adapter/` — `utilityProcess.fork` in Electron, `child_process.fork` in standalone Node.
- Hands the child an environment containing the gateway URL, the bundle path, a per-extension WebSocket token, and the extension's identity.
- Waits for a `ready` handshake (a message after the extension finishes `activate` and the WebSocket is connected).
- Forwards `extensions.invoke` calls from the dispatcher to the extension process's WebSocket.
- Routes the extension's outbound RPC calls (`ctx.fs.write(...)` etc.) into the dispatcher as ordinary client calls.
- Detects crashes, applies the crash policy (below), and respawns or marks `error`.

Per-extension cost: a fresh Node process (~30–100 MB RSS startup, ~150–500 ms cold start). Acceptable at expected scale.

### Transport

Same WebSocket the panels use. The extension process dials the gateway with its per-extension token; from the dispatcher's perspective it looks like another RPC client, distinguished only by `callerKind: "extension"`. Host → extension calls (`extensions.invoke`) ride the same channel in reverse, as RPC events. No new transport is introduced.

### Crash policy

If an extension process exits unexpectedly (non-zero exit, signal, ready-handshake timeout), the manager respawns it with exponential backoff: `1s, 2s, 4s, 8s, 16s`. If five consecutive spawn attempts fail within 60 seconds, the extension is marked `error` in the registry, an `extensions:error` event is emitted, and a notification surfaces the failure to the user. After that, only an explicit `extensions.reload(name)` will attempt activation again.

A clean `process.exit(0)` from inside the extension is treated as intentional deactivation — no respawn — and the extension is marked `stopped` until the next host restart or manual reload.

## The single `extensions` surface

There is exactly one way to reach an extension from outside its process: the dispatcher service named `extensions`. It mounts onto the existing dispatcher and is callable by every userland kind (`panel`, `worker`, `shell`, `extension`).

```ts
// dispatcher
{
  name: "extensions",
  policy: { allowed: ["panel", "worker", "shell", "extension"] },
  methods: {
    invoke:     { args: [z.string(), z.string(), z.array(z.unknown())] },
    list:       { args: [] },
    on:         { args: [z.string(), z.string()] }, // (extName, event) — returns subscription id
    install:    { /* elevated-approval-gated */ },
    uninstall:  { /* elevated-approval-gated */ },
    setEnabled: { /* approval-gated */ },
    reload:     { /* approval-gated, elevated when ref changed */ },
  },
}
```

`invoke`, `list`, and `on` are not approval-gated — they're userland code talking to userland code. The management methods are approval-gated, and the install / reload-on-new-ref paths use the **elevated** approval treatment described below.

Consumers — panels, workers, and other extensions — use the same thin client from `@workspace/runtime`:

```ts
import { extensions } from "@workspace/runtime";
import type { GitToolsApi } from "@workspace-extensions/git-tools";

const git = extensions.use<GitToolsApi>("@workspace-extensions/git-tools");
const lines = await git.blame("/foo.ts");

extensions.on("@workspace-extensions/git-tools", "indexed", (payload) => {
  // ...
});

// Wait for an extension that may activate later (useful from another extension's activate())
extensions.onActivate<GitToolsApi>("@workspace-extensions/git-tools", (api) => {
  // ...
});
```

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("extensions", "invoke", [name, prop, args])`. The proxy's `get` trap returns `undefined` for `then`, `Symbol.toPrimitive`, and other well-known protocol properties.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to subscribers via `extensions.on(name, event, cb)`. Internally, extension events are namespaced by extension name on the wire (`RpcEvent { service: "extensions", event: "<name>::<event>", payload }`) so two extensions emitting the same event name don't collide.

Extensions activate in unspecified order. Consumers that need another extension during their own `activate` must use `extensions.onActivate(name, cb)`. There is no declarative dependency graph.

## Elevated approvals — informed-consent UX

Three things trigger the **elevated** approval treatment:

1. **Initial install of an extension** — the user is installing native-capability code that will run at every server boot.
2. **A push to an extension's git repo that changes the ref the registry has approved** — new code is about to run with the trust already granted. The push triggers a build but the new bundle does **not** activate until elevated approval is granted; the previous approved bundle keeps running.
3. **`reload` of an extension when the resolved ref differs from the registry's `approvedRef`** — same situation, different entry point.

Routine approvals (per-call `fs.write`, `credentials.read`, etc.) flow through the standard approvals pipeline unchanged. Disable, enable (when the ref is unchanged), and uninstall use standard approvals.

### What the prompt has to communicate

The elevated approval payload includes everything needed for the UI to render an informed-consent card distinct from the standard approval prompt:

```ts
await approvals.request({
  kind: "extension.install",   // or "extension.update"
  category: "extension-elevated",   // signals the distinct UI treatment
  callerId: ctx.callerId,
  detail: {
    name: "@workspace-extensions/git-tools",
    version: "1.2.0",
    source: { kind: "internal-git", repo: "extensions/git-tools", ref: "v1.2.0" },
    sha: "abc123...",
    previousSha: "def456...",       // present on update
    diffSummary: { filesChanged: 7, insertions: 142, deletions: 11 },  // present on update
    integrity: "sha256-...",
    capabilities: ["node:fs", "node:child_process", "node:net", "userland:*"],
  },
});
```

UI requirements (these are contract, not implementation details):

- **Visually distinct from regular approvals.** Different card style, different icon, more spacing, plain-language framing.
- **Lead with capability, not provenance.** The first sentence is "This will run as native code on your machine with access to your filesystem, network, and ability to launch other programs." Provenance comes second.
- **Show the ref and sha being approved.** For updates, show what changed at the commit level — at minimum the diff stat, ideally a link to view the diff in a panel.
- **No "Allow always" option.** Standard approvals can be granted session-wide or repo-wide; elevated approvals are scoped to **exactly the ref being approved**. A new ref re-prompts.
- **Distinct decision verbs.** "Install and run" / "Don't install" rather than "Allow" / "Deny". Verb choice matters when the action is qualitatively different.
- **Deferred default.** The default action when the user dismisses the prompt (closes the window, navigates away) is "don't install", never "allow".

### Push-triggered updates

`pushTrigger` (in `src/server/buildV2/pushTrigger.ts`) gains a hook for extension units: when a push changes any unit whose `kind === "extension"`, the trigger:

1. Computes the new effective version and builds the new bundle as normal.
2. Stores the new `bundleKey` in a `pendingRef` slot in the registry (not the active `bundleKey`).
3. Emits an `extensions:updatePending` event with the install-prompt payload above.
4. Waits for the user to approve via the elevated UX. Approval promotes `pendingRef` → active, schedules a reload. Denial discards the new bundle (GC will collect it) and the previous version keeps running.

This means **a push to an extension repo can never silently change running code**. The push triggers a *prepared* update, not an applied one. The same logic covers the case where the user pushes accidentally, or where someone else with workspace write access pushes — the running extension stays at the last approved ref until the user actively consents.

### Boot-time activation consent

At server boot, every enabled extension whose `approvedRef === resolvedRef` activates without prompting — the user already granted consent at install time, and the ref hasn't changed. If an extension's `approvedRef` is missing (e.g. registry was edited externally, or storage was restored from backup), boot activation is held and the user is prompted with the elevated install flow.

## Userland extension management

Userland code cannot bypass the extension manager — extensions are workspace units, but `installed`/`enabled` state and the registry are server-managed. To install, remove, enable, or reload extensions, callers go through the `extensions` service.

```ts
import { extensions } from "@workspace/runtime";

// No approval — registry metadata only
await extensions.list();

// Elevated approval
await extensions.install({
  source: { kind: "internal-git", repo: "extensions/git-tools", ref: "v1.2.0" },
  // or { kind: "git",     url: "https://github.com/acme/git-tools", ref: "v1.2.0" }
  // or { kind: "tarball", url: "...", sha256: "..." }
  // or { kind: "local",   path: "/abs/path/to/dir" }   // dev convenience
});

// Standard approval (disable/enable when ref unchanged)
await extensions.setEnabled("@workspace-extensions/git-tools", false);

// Standard approval (uninstall)
await extensions.uninstall("@workspace-extensions/git-tools");

// Elevated approval if reload would change the resolved ref, standard otherwise
await extensions.reload("@workspace-extensions/git-tools");
```

For remote sources (`git`, `tarball`), `install` fetches into `workspace/extensions/<name>/` as a new workspace unit (with a fresh git repo initialized from the fetched content) and from then on the unit behaves like any other workspace extension. Local sources are dev-only and skip the import-into-workspace step.

| Method | Approval | Notes |
|--------|----------|-------|
| `list` | No | Returns `{name, version, enabled, displayName, approvedRef, resolvedRef, status}[]` from the registry |
| `install` | `extension.install` (elevated) | Fetches into workspace, registers, builds, activates |
| `uninstall` | `extension.uninstall` | Deactivates, removes workspace unit, updates registry; `storage/<workspaceId>/<name>/` is retained unless `purge: true` |
| `setEnabled` | `extension.toggle` | Persisted in registry; on disable, kills the extension process |
| `reload` | `extension.reload` (elevated if ref changed) | Re-resolves the source ref, rebuilds, respawns the process |

There is no `readFile` / `writeFile` over the RPC surface. Source authoring happens against the workspace git; to push changes, commit and let the push trigger prepare the update.

## Activation lifecycle

- **Boot**:
  1. Read the registry. For each enabled extension, check `approvedRef === resolvedRef`. Mismatched entries are held and surfaced as an `extensions:approvalRequired` event.
  2. For matching entries, spawn the process, wait for the ready handshake (timeout: 10s), call `activate(ctx)` over the wire, record the exposed API metadata.
  3. Throws during `activate` are caught, logged, marked `error` in the registry, and emitted as `extensions:error` events. The process is killed. One extension's failure does not block others.
- **Eager only for v1**. `activationEvents` is plumbed through but only `"*"` is accepted; other values fail validation.
- **Hot install**: a freshly installed extension activates immediately — the manager spawns the process after the elevated approval resolves and the build completes.
- **Hot reload**: `reload` calls `deactivate()` on the running process (with a 5s grace period), then kills it, rebuilds if the ref changed, and spawns a fresh process. Subscribers receive an `extensions:reloaded` event before the old subscriptions go dead.
- **Crash**: handled by the crash policy above. The process boundary contains the failure; the host keeps running.

## Dispatcher integration

Minimal change to `packages/shared/src/serviceDispatcher.ts`:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name.
- Every existing service definition gets `"extension"` added to its `policy.allowed` list explicitly.
- Approval prompts attributed to an extension caller use the standard prompt style, **not** the elevated one — those are reserved for install/update events. The standard prompt's caller-attribution string surfaces the extension name.

The dispatcher does not root `fs` differently for extensions. `ctx.fs` is the same client a panel sees, subject to the same per-context constraints and approvals; the extension's full-Node filesystem access is via `import "node:fs"` directly (and is what the elevated install approval consented to).

## Extension host package

A new package `packages/extension-host/`:

```
packages/extension-host/
├── src/
│   ├── index.ts                  # boot, walk registry, spawn enabled extensions
│   ├── registry.ts               # in-memory map + registry.json atomic writes
│   ├── processManager.ts         # ExtensionProcessManager (sibling to WorkerdManager)
│   ├── childRuntime.ts           # entry shipped into the child process — sets up WS,
│   │                             # imports the bundle, calls activate, handles invokes
│   ├── service.ts                # dispatcher service ("extensions") handler — invoke / on / management
│   └── installer.ts              # install / uninstall / reload pipeline + push-trigger integration
```

`childRuntime.ts` is the entry actually executed by the forked process. It reads the bundle path and gateway URL from `process.env`, opens the WebSocket, requires the bundle, calls `module.activate(ctx)`, and serves invoke requests by looking up the returned API object. The user's bundle is loaded as a normal Node module — no `vm.createContext`, no sandbox — `vm.createContext` adds nothing once the process boundary is in place.

The host runs in-process with the server. It mounts the `extensions` dispatcher service onto the existing dispatcher. The Electron main process consumes the same package — there is one extension host per running NatStack instance regardless of mode.

## Future work

Out of scope for v1, kept as forward-compat anchors:

- **Lazy activation**: the `activationEvents` field is plumbed through but only `"*"` is honored.
- **Per-workspace extension catalogs**: today extensions are workspace units. A central catalog of vetted extensions could layer on top.
- **Cross-extension type sharing**: today consumers either define interfaces themselves or duplicate types.
- **Resource limits**: per-extension RSS caps and CPU quotas. The OS can enforce these via `setrlimit`-equivalents; not wired in v1.
- **npm registry as a source**: currently internal-git / git / tarball / local. npm can be added later.
- **Extensions shipping panels**: deliberately out of scope. Extensions register RPC APIs; a separate panel can call into the extension.

## Related cleanup

The same change set removes stale `agent` build-kind references:

- `BUILD_SYSTEM.md` removes the "Agent build (node target)" subsection and the `workspace/agents/` directory entry.
- `src/server/buildV2/packageGraph.ts` header comment (lines 1–7) drops the `workspace/agents/` reference.
- `STATE_DIRECTORY.md` removes the "agents only" qualifier on the `package.json` entry in the build-store sentinel.

## See also

- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) — panel architecture
- [STATE_DIRECTORY.md](STATE_DIRECTORY.md) — `{userData}/` layout
- [PERMISSIONS.md](PERMISSIONS.md) — userland permission requirements (extensions are subject to these for userland-runtime calls; their full-Node access is granted by the elevated install approval)
- [BUILD_SYSTEM.md](BUILD_SYSTEM.md) — buildV2 pipeline (extensions are a node-target ESM build kind alongside panel and worker)
