# Extension Services

> **Status:** Planning document — design resolved, not yet implemented.

NatStack extensions are **trusted Node.js modules** that run in a shared host process alongside the server. They extend the application itself — adding new RPC services, reacting to system events, and exposing APIs to userland panels — in the spirit of VSCode extensions, not browser extensions.

Extensions are **not** sandboxed. They run with the same authority as the core host: full filesystem access, the full service surface (`fs`, `ai`, `git`, `panel`, `credentials`, ...), and free communication with each other.

## Extensions vs. Panels

| | Extension | Panel |
|---|---|---|
| Trust | Trusted (full host authority) | Userland (sandboxed) |
| Process | Shared extension host (Node) | Isolated webview |
| Lifecycle | Activated eagerly on workspace open | Opened on user navigation |
| API surface | All core services unrestricted | Subset, gated by service policy |
| Talks to | Other extensions (in-process), host services, panels (via RPC) | Host services, parent panel, extensions (via RPC, mediated) |
| Lives at | `{userData}/extensions/installed/<name>/` | `{workspace}/panels/<name>/` (or external URL) |

Extensions and panels solve different problems. A panel is a UI surface a user navigates to; an extension is a background capability that augments the runtime. Extensions can ship a panel as part of their package, but the panel is just a regular panel — the extension is the long-lived host code.

## On-disk layout

Extensions live under the state directory next to `builds/` and `context-scopes/`:

```
{userData}/extensions/
├── installed/                       # active extensions (source on disk)
│   └── @acme/git-tools/
│       ├── package.json
│       ├── index.ts
│       └── ...
├── staged/                          # in-flight installs (atomic-renamed on success)
│   └── @acme-git-tools-<rand>/
├── storage/                         # per-extension scratch / state
│   └── @acme/git-tools/
└── registry.json                    # name → { version, source, ref, sha, enabled, installedAt, integrity }
```

Bundles are not stored here — extensions are built JIT via the existing esbuild pipeline (see [BUILD_SYSTEM.md](BUILD_SYSTEM.md)) and the resulting artifact lives in `{userData}/builds/<key>/` keyed by content hash, the same as panels.

`installed/` is the source of truth for what loads at startup. `registry.json` records provenance and enablement so disabled extensions stay on disk without being activated. `storage/<name>/` is exposed to the extension as `ctx.storage` and survives upgrades.

`getUserDataPath()` from `@natstack/env-paths` resolves the base. The same paths work in Electron and headless server modes.

## Extension package layout

```
@acme/git-tools/
├── package.json          # Manifest with natstack.extension field
├── index.ts              # Entry (TypeScript source)
└── ...
```

### Manifest

```json
{
  "name": "@acme/git-tools",
  "version": "1.2.0",
  "natstack": {
    "extension": {
      "displayName": "Git Tools",
      "entry": "index.ts",
      "activationEvents": ["*"]
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `displayName` | string | package name | Human-readable name for UI |
| `entry` | string | `index.ts` | Entry source file (built JIT by esbuild, same pipeline as panels) |
| `activationEvents` | string[] | `["*"]` | When to activate. `"*"` = eager at startup. Reserved for future lazy triggers (`"onPanel:<source>"`, `"onCommand:<id>"`, ...). |

The presence of `natstack.extension` in `package.json` is what marks a package as an extension. Anything in `installed/` without it is ignored.

There is no `main` field and no `dist/` — extensions ship source. Typed API consumers (other extensions, panels) import the package as a normal TypeScript package; the host's esbuild pipeline produces the runtime bundle.

## Activation contract

```ts
// @acme/git-tools/index.ts
import type { ExtensionContext } from "@natstack/extension";

export interface GitToolsApi {
  blame(path: string): Promise<BlameLine[]>;
}

export async function activate(ctx: ExtensionContext): Promise<GitToolsApi> {
  ctx.log.info("git-tools activating");

  await ctx.host.fs.mkdir("/.cache/git-tools", { recursive: true });

  ctx.subscriptions.push(
    ctx.host.panel.onOpened(p => ctx.log.debug("panel opened", p.id)),
  );

  return {
    async blame(path) { /* ... */ },
  };
}

export async function deactivate(): Promise<void> {
  // optional cleanup; subscriptions are auto-disposed
}
```

`activate` returns the extension's **public API**. That value is what other extensions and panels see when they look the extension up by name. Returning `void` is valid — the extension is then "fire-and-forget" (only useful for side effects, e.g. registering event handlers).

## `ExtensionContext`

```ts
interface ExtensionContext {
  // Identity
  readonly name: string;          // "@acme/git-tools"
  readonly version: string;
  readonly storage: ExtensionStorage; // {userData}/extensions/storage/<name>/

  // Host service surface — same client API as the panel runtime, unrestricted
  readonly host: {
    fs: FsClient;
    ai: AiClient;
    git: GitClient;
    panel: PanelClient;          // panel lifecycle events, openPanel, etc.
    workspace: WorkspaceClient;
    credentials: CredentialsClient;
    db: DbClient;
    webhooks: WebhooksClient;
    approvals: ApprovalsClient;
    notifications: NotificationsClient;
  };

  // Extension registry — peer extensions
  readonly extensions: {
    get<T = unknown>(name: string): T | undefined;
    onActivate(name: string, cb: (api: unknown) => void): Disposable;
    list(): ExtensionInfo[];
  };

  // Lifecycle
  readonly subscriptions: Disposable[]; // auto-disposed on deactivate
  readonly log: Logger;

  // Events (visible to subscribed panels and other extensions)
  emit(event: string, payload: unknown): void;
}
```

`host.*` is the same client library the panel runtime exposes, bound in-process to the dispatcher with `callerKind: "extension"`. No new API surface to learn.

## Extension-to-extension communication

Same process, direct function calls — no RPC:

```ts
const git = ctx.extensions.get<GitToolsApi>("@acme/git-tools");
if (git) {
  const lines = await git.blame("/foo.ts");
}

// Wait for an extension that may activate later:
ctx.subscriptions.push(
  ctx.extensions.onActivate("@acme/git-tools", (api: GitToolsApi) => {
    // register integrations
  }),
);
```

Activation order: extensions activate in dependency order if they list each other in `dependencies` / `peerDependencies`; otherwise activation order is undefined and consumers must use `onActivate`.

## Panel → extension (the only RPC boundary)

A single dispatcher service `extensions` routes calls into the registry:

```ts
// dispatcher
{
  name: "extensions",
  policy: { allowed: ["panel", "shell", "extension"] },
  methods: {
    invoke: { args: [z.string(), z.string(), z.array(z.unknown())] },
    list:   { args: [] },
    on:     { args: [z.string(), z.string()] }, // (extName, event) — returns subscription id
  },
  async handler(ctx, method, args) {
    if (method === "invoke") {
      const [name, fn, params] = args;
      const api = registry.get(name);
      if (!api || typeof api[fn] !== "function") throw new RpcError("ENOENT", ...);
      return api[fn](...params);
    }
    // ...
  },
}
```

Panels get a thin client in the runtime:

```ts
import { extensions } from "@workspace/runtime";
import type { GitToolsApi } from "@acme/git-tools";

const git = extensions.use<GitToolsApi>("@acme/git-tools");
const lines = await git.blame("/foo.ts");

extensions.on("@acme/git-tools", "indexed", (payload) => {
  // ...
});
```

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("extensions", "invoke", [name, prop, args])`. No per-method registration on the extension side — whatever it returned from `activate` is callable.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to panels currently subscribed via `extensions.on(name, event, cb)`.

## Userland extension management

Userland code cannot bypass the extension manager — `installed/` and `storage/` live in the state directory, not the workspace, and panel `fs` is scoped to the context folder. To install, remove, enable, or inspect extensions, panels call the **same `extensions` service** but on its management methods.

Every mutating method requests approval via the existing `approvals` service. Callers always call `approvals.request(...)` and never branch on granularity — the approvals system itself decides whether to prompt the user, auto-grant from a saved preference, or apply a scoped grant. Granularity is a property of the approvals UX, not of the extensions service.

```ts
import { extensions } from "@workspace/runtime";

// No approval — registry metadata only
await extensions.list();

// Approval required
await extensions.install({
  source: { kind: "git", url: "https://github.com/acme/git-tools", ref: "v1.2.0" },
  // or { kind: "tarball", url: "...", sha256: "..." }
  // or { kind: "local",   path: "/abs/path/to/dir" }     // dev convenience
});

await extensions.uninstall("@acme/git-tools");
await extensions.setEnabled("@acme/git-tools", false);

// Reading and writing extension files (e.g. for an extension-manager panel)
await extensions.readFile("@acme/git-tools", "README.md");
await extensions.writeFile("@acme/git-tools", "config.json", buf);
```

Approval prompt payloads are structured so the UI can render meaningful consent:

```ts
await approvals.request({
  kind: "extension.install",
  callerId: ctx.callerId,
  detail: {
    name: "@acme/git-tools",
    version: "1.2.0",
    source: { kind: "git", url: "...", ref: "v1.2.0" },
    integrity: "sha256-...",
  },
});
```

Reads and writes of extension files are also gated — extensions are trusted code, may contain credentials, and may be re-executed at next activation, so granting blanket userland access would defeat the trust boundary.

| Method | Approval required | Notes |
|--------|-------------------|-------|
| `list` | No | Returns `{name, version, enabled, displayName}[]` from `registry.json` |
| `install` | Yes (`extension.install`) | See pipeline below |
| `uninstall` | Yes (`extension.uninstall`) | Deactivates, removes `installed/<name>/`, updates registry; `storage/<name>/` is retained unless `purge: true` |
| `setEnabled` | Yes (`extension.toggle`) | Persisted in registry; on disable, calls `deactivate()` |
| `readFile` | Yes (`extension.read`) | Path constrained to `installed/<name>/` |
| `writeFile` | Yes (`extension.write`) | Same; bumps the extension's version on next activation cycle |
| `invoke` | No | Calls the extension's exposed API — extension itself decides what it offers |

Extensions themselves call the same management surface without going through `approvals` (they have a privileged `ctx.host.extensions` binding) — this is what lets a trusted "marketplace" extension drive installs.

## Install pipeline

1. **Approval granted** → fetch source into `extensions/staged/<name>-<rand>/`.
   - `git`: shallow clone, then `git rev-parse` to resolve the user-supplied ref (branch / tag / sha) to its commit sha. Record both `ref` (what the user asked for) and `sha` (what got installed) in `registry.json`.
   - `tarball`: stream + verify `sha256` (required for tarball sources).
   - `local`: copy (or symlink in dev). No integrity check.
2. **Validate** the staged directory:
   - `package.json` parses and contains `natstack.extension`.
   - `entry` resolves inside the directory (no `..` escape).
3. **Resolve dependencies** via the existing `build-artifacts/` pipeline (content-addressed `node_modules`, shared with panels).
4. **JIT build**: run esbuild on `entry` using the same pipeline panels use; the bundle lands at `{userData}/builds/<key>/` keyed by content hash. Build failures abort the install.
5. **Atomic promote**: rename `staged/<name>-<rand>/` → `installed/<name>/`. Update `registry.json`.
6. **Activate**: `extensionHost.activate(name)` — `require()` the built bundle, call `activate(ctx)`, store the returned API in the registry.
7. **Emit** `extensions:installed` over the event channel.

Uninstall reverses: `deactivate()` → dispose subscriptions → evict from `require.cache` → `rm -rf installed/<name>/` → update registry → emit `extensions:uninstalled`. The built bundle in `builds/` is left for the build-cache GC.

Upgrade = uninstall + install in one approval (`extension.upgrade`). On upgrade the original `ref` is re-resolved against the source — branch refs move forward, pinned shas/tags don't.

### Integrity & pinning

| Source | Input ref | Stored | Mutable after install? |
|--------|-----------|--------|------------------------|
| `git`  | branch / tag / sha | resolved commit sha | No — upgrade re-resolves |
| `tarball` | URL + required `sha256` | sha256 of fetched bytes | No |
| `local` | path | path | Yes (dev convenience) |

This matches the lockfile pattern: users supply ergonomic refs, the registry stores what actually got installed.

## Activation lifecycle

- **Boot**: extension host walks `installed/`, filters by `registry.enabled`, sorts by declared dependencies, calls `activate` on each. Failures are logged and the extension is marked `error` in the registry but boot continues.
- **Eager only for v1**. `activationEvents: ["*"]` is required. The field exists for forward-compat with lazy activation (e.g. `"onPanel:panels/editor"`).
- **Hot install**: a freshly installed extension activates immediately — no app restart. Module cache is clean for a new package.
- **Hot uninstall / upgrade**: deactivate → dispose `ctx.subscriptions` → walk `require.cache` and delete every entry whose resolved path is under the extension's `installed/<name>/` directory or its built bundle → optional re-activate. Anything an extension registered outside `ctx.subscriptions` (raw event listeners, timers, references held by other code) leaks across an upgrade — extensions are expected to use `ctx.subscriptions` for everything. If an extension turns out to leak references in practice, the fix is in the extension, not the host. (We may revisit per-extension `Module` isolation later if this becomes a recurring problem.)
- **Crash**: an extension throwing during `activate` is marked errored and does not block others. Crashes during a method call propagate as RPC errors to the caller; they do not take down the host.

## Dispatcher integration

Minimal change to `packages/shared/src/serviceDispatcher.ts`:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name (`@acme/git-tools`).
- No blanket bypass — every existing service definition gets `"extension"` added to its `policy.allowed` list explicitly. Easier to read than a global rule.
- Two places inspect `callerKind === "extension"`:
  - **`fs`**: when no other root is specified, defaults to rooting at `{userData}/extensions/storage/<name>/`. This is what `ctx.storage` resolves to. Extensions can still target arbitrary paths — they are trusted — but their default scope is their own storage dir.
  - **Logging**: log lines from service calls are tagged with the extension name as `callerId`.

No other behavior differs between an extension call and a panel call.

## Extension host process

A new package `packages/extension-host/`:

```
packages/extension-host/
├── src/
│   ├── index.ts          # boot, walk installed/, activate all
│   ├── registry.ts       # in-memory map of name → { api, manifest, subs }
│   ├── context.ts        # ExtensionContext factory (binds host clients)
│   ├── installer.ts      # install / uninstall / upgrade pipeline
│   ├── service.ts        # dispatcher service ("extensions") handler
│   └── loader.ts         # require + cache eviction
```

The host runs in-process with the server (single Node process). It mounts its `extensions` service onto the existing dispatcher. The Electron main process consumes the same package — there is one extension host per running NatStack instance, regardless of mode.

## Future work

Out of scope for v1, kept as forward-compat anchors:

- **Lazy activation**: the `activationEvents` field is plumbed through but only `"*"` is honored. Other triggers (`"onPanel:<source>"`, `"onCommand:<id>"`, ...) can be added without breaking the manifest.
- **Per-workspace extensions**: if project-pinned versions become useful, a per-workspace install location (`{workspace}/.natstack/extensions/`) can layer over the per-user one. Resolution order: workspace > user. Not built yet.
- **Untrusted / sandboxed extensions**: today all extensions are trusted. If we ever want to install third-party untrusted extensions, the cleaner path is a separate sandboxed-extension kind with its own policy-gated context, not retrofitting capabilities onto the trusted variant. Today's trusted extensions stay trusted forever.
- **Per-extension `Module` isolation**: if hot-upgrade reference leaks become a real problem in practice, revisit loading each extension in its own `Module` instance or `vm` context. Not worth the complexity until there's evidence we need it.
- **npm registry as a source**: currently git / tarball / local only. npm can be added as a fourth `source.kind` if there's demand.
- **Extensions shipping panels**: deliberately out of scope. Extensions register RPC APIs; if a UI is wanted, a separate panel can call into the extension. Revisit only if a concrete need appears.

## See also

- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) — panel architecture
- [STATE_DIRECTORY.md](STATE_DIRECTORY.md) — `{userData}/` layout
- [PERMISSIONS.md](PERMISSIONS.md) — userland permission requirements (extensions bypass these, by design)
- [BUILD_SYSTEM.md](BUILD_SYSTEM.md) — `build-artifacts/` dep resolution (reused by extension installer)
