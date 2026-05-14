# Extension Services

> **Status:** Planning document — design resolved, not yet implemented.

NatStack extensions are **long-lived Node processes** that run alongside the server and expose RPC APIs to userland panels and workers. They extend the application itself — adding new RPC services, reacting to system events, and exposing callable surfaces to userland — in the spirit of VSCode extensions, not browser extensions.

Extensions are **trusted, first-party-installed Node code**. They get two ways to do work, and they choose which to use per call:

- The **userland runtime** (`ctx.fs`, `ctx.credentials`, …): same clients panels and workers see. Calls flow through the dispatcher with `callerKind: "extension"` and hit the same per-call approvals userland code hits. This is the path to take when you want the user to see what the extension is doing and have the option to refuse.
- **Raw Node** (`import "node:fs"`, `child_process`, native addons, sockets, anything Node can do): direct, unprompted, ambient. Authorized once at install time by the elevated approval and not asked again.

A given extension can use both. The trade-off is the extension author's call: route through `ctx.fs` for visibility and user-attributable auditing, or call Node directly for silent operations the user has already broadly consented to. Per-call approvals from extensions are useful for transparency, not as a security boundary — the install consent is what actually grants capability.

Every extension install and every code change to an installed extension goes through an **elevated approval flow** — a visually distinct, informed-consent prompt that calls out the trust level being granted. That is the boundary.

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

By convention, workspace-internal extensions use the `@workspace-extensions/*` scope; extensions installed from external sources keep whatever scope their `package.json` specifies. Cross-extension imports are not first-class in v1 (see Future work).

There is no per-user `{userData}/extensions/installed/` tree. Source lives in workspace git (every extension is a workspace unit, even those originally fetched from a remote source — they're cloned into `workspace/extensions/<name>/` at install time). Bundles live in `{userData}/builds/<key>/` keyed by content hash. Per-extension scratch lives at `{userData}/extensions/storage/<workspaceId>/<name>/`.

The registry is a small JSON in workspace state. It holds **operational state only** — never approval state. The single source of truth for "did the user consent to run this code" is the approvals system; the registry never duplicates it. Each entry has this canonical shape:

```ts
interface RegistryEntry {
  name: string;                  // "@workspace-extensions/git-tools"
  version: string;
  source: ExtensionSource;       // user-supplied (kind + url/repo + ref)
  installedAt: number;

  // Effective version is the approval gate — buildV2 already computes it
  // and it cascades through every workspace and external-dep change.
  resolvedEv: string;            // current EV (what would run if approved)
  resolvedSha: string;           // commit at the extension's own repo, for diff display
  activeEv: string | null;       // EV of the bundle currently running, if any
  activeSha: string | null;
  activeBundleKey: string | null;

  pendingEv: string | null;      // built but not yet known-approved
  pendingSha: string | null;
  pendingBundleKey: string | null;

  enabled: boolean;
  status: "running" | "stopped" | "error" | "pending-approval";
  lastError: string | null;
}
```

Activation is gated by an explicit `approvals.request(...)` call that names the **effective version** — not the source sha. The EV captures both the extension's own source (via its tree hash) and the EVs of every workspace dependency it transitively depends on; package.json changes (including external npm dep version bumps) are part of the tree hash. Any rebuild that produces a different bundle produces a different EV, and a different EV is a different consent. The approvals system stores decisions keyed by `(extension, ev)`; the manager never inspects that state, just calls request and obeys the answer. On grant, the manager promotes `pendingEv → activeEv`, `pendingBundleKey → activeBundleKey`, and starts/restarts the extension process.

A `BUILD_CACHE_VERSION` bump in buildV2 changes the **build key** but not the **EV**, so a NatStack-side build-pipeline change that rebuilds extensions without changing their semantic content does **not** re-prompt. The user approves their code, not our build.

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

  // Per-extension scratch, scoped to {userData}/extensions/storage/<workspaceId>/<name>/.
  readonly storage: ExtensionStorage;

  // Userland runtime — same client surface panels and workers see, dispatched
  // back to the host over the extension's WebSocket connection. Calls here
  // hit standard per-call approvals; use these when you want user-visible,
  // auditable operations. For silent ambient work, import "node:fs" etc.
  // directly. ctx.fs for extensions is NOT context-scoped — it covers the
  // whole host filesystem, matching the raw-Node access the extension
  // already has.
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

  // Lifecycle. Disposables are disposed in LIFO order on deactivate.
  readonly subscriptions: Disposable[];
  readonly log: Logger;

  // Events (visible to subscribed panels, workers, and other extensions)
  emit(event: string, payload: unknown): void;
}
```

The userland clients on `ctx` are the same the panel runtime exposes, bound through the extension process's WebSocket connection to the dispatcher with `callerKind: "extension"` and `callerId: <extension name>`. Every call is attributed to the extension for logs and approval prompts.

Node's standard library is available globally inside the extension process — `import * as fs from "node:fs"`, child processes, native addons all work normally. There is no host-mediated wrapper; the extension is running in a real Node process.

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

"Unexpected" is defined by the ready handshake: if the extension exited *before* sending `ready`, treat as a crash regardless of exit code. If it exited *after* `ready` with exit code 0, treat as intentional deactivation — no respawn, status `stopped` — until the next host restart or manual reload. Any non-zero exit code, or any signal-induced termination, is always a crash.

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

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("extensions", "invoke", [name, prop, args])`. The proxy's `get` trap returns `undefined` for `then`, `Symbol.toPrimitive`, and other well-known protocol properties. Calls to a non-existent or stopped extension fail with `ENOEXT` at invocation time; the proxy itself is always defined.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to subscribers via `extensions.on(name, event, cb)`. Internally, extension events are namespaced by extension name on the wire (`RpcEvent { service: "extensions", event: "<name>::<event>", payload }`) so two extensions emitting the same event name don't collide.

Extensions activate in unspecified order. Consumers that need another extension during their own `activate` must use `extensions.onActivate(name, cb)`. Peer extensions are guaranteed callable only after both have completed their `activate`; a callback that fires during a slow peer activation is queued and dispatched once both sides are ready. There is no declarative dependency graph.

### `ExtensionsClient` surface

The same client is exposed to panels and workers via `@workspace/runtime`, and to extensions via `ctx.extensions`:

```ts
interface ExtensionsClient {
  // Calling an extension
  use<T>(name: string): T;                                       // returns a proxy
  on(name: string, event: string, cb: (payload: unknown) => void): Disposable;
  onActivate<T>(name: string, cb: (api: T) => void): Disposable;
  list(): Promise<RegistryEntry[]>;

  // Management — all approval-gated; elevated when capability-granting
  install(spec: InstallSpec): Promise<void>;                     // elevated
  uninstall(name: string, opts?: { purge?: boolean }): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  reload(name: string): Promise<void>;                           // elevated if ref changed
}
```

## Elevated approvals — informed-consent UX

The extension subsystem **always** calls `approvals.request(...)` before running code at a given EV, regardless of context — at install, at push-trigger pickup, at reload, at boot. The approvals system decides whether to auto-grant (from a stored decision), prompt the user, or hold pending. Callers never inspect or branch on stored decisions; that's the approvals system's job.

Three elevated-category sub-kinds cover all the cases:

1. **`extension.install`** — first time this extension is being installed. Native-capability code is about to land in the workspace and run.
2. **`extension.update`** — a push changed the extension's *own* source. Issued by the push trigger and by `reload`.
3. **`extension.dep-update`** — the extension's EV changed because a transitive workspace dep or external npm dep changed, **without** any change to the extension's own source. Issued by the push trigger when a non-extension unit's push cascades into an extension's EV.

The `dep-update` sub-kind is intentionally separate because the trust shape is different: the user already trusted this extension's authored behavior; what changed is the library underneath. The prompt leads with that framing ("@workspace/runtime updated; @acme/git-tools and @acme/other-thing run different code now") rather than re-introducing the extension. See "Workspace dep update prompt" below.

At every server boot the manager also issues an **`extension.run`** request for each enabled extension at its `resolvedEv`. Same elevated category, but in the common case the approvals system has a stored decision keyed by `(name, ev)` from a prior install / update / dep-update and auto-grants without prompting.

Routine approvals (per-call `fs.write`, `credentials.read`, etc. through `ctx.*` clients) are standard-category — the same approval pipeline panels and workers use, attributed to the extension's `callerId`. Disable, enable (when the EV is unchanged), and uninstall are also standard.

### What the prompt has to communicate

The elevated approval payload includes everything needed for the UI to render an informed-consent card distinct from the standard approval prompt:

```ts
await approvals.request({
  kind: "extension.install",   // or "extension.update", "extension.dep-update", "extension.run"
  category: "extension-elevated",
  callerId: ctx.callerId,
  detail: {
    name: "@workspace-extensions/git-tools",
    version: "1.2.0",
    source: { kind: "internal-git", repo: "extensions/git-tools", ref: "v1.2.0" },

    // The approval gate
    ev: "ev_2a9f...",                // EV the user is being asked to approve
    previousEv: "ev_117c...",        // EV currently running (or last approved); null on install

    // Diff information for the prompt — three layers
    extensionDiff: {                 // null on install or pure dep-update
      sha: "abc123...",
      previousSha: "def456...",
      stat: { filesChanged: 7, insertions: 142, deletions: 11 },
    },
    workspaceDepChanges: [           // empty on a pure same-source update
      { name: "@workspace/runtime", fromEv: "ev_a1...", toEv: "ev_b2...",
        sha: "...", previousSha: "...",
        stat: { filesChanged: 3, insertions: 18, deletions: 4 } },
    ],
    externalDepChanges: [            // empty when package.json/lockfile is unchanged
      { name: "zod", fromVersion: "3.22.4", toVersion: "3.23.8" },
    ],

    integrity: "sha256-...",
    capabilities: ["node:fs", "node:child_process", "node:net", "userland:*"],
  },
});
```

UI requirements (these are contract, not implementation details):

- **Visually distinct from regular approvals.** Different card style, different icon, more spacing, plain-language framing.
- **Lead with capability, not provenance.** The first sentence is "This will run as native code on your machine with access to your filesystem, network, and ability to launch other programs." Provenance comes second.
- **Show all three diff layers.** Extension source diff, workspace dep EV changes (with their own commit diffs), external npm version changes. Each layer is collapsible; on a pure extension update the dep sections are empty and hidden; on a pure dep update the extension section is empty and hidden, and the prompt's title leads with the dep that changed (see "Workspace dep update prompt").
- **Decision options.** `once` and `deny` are always offered. `session` is offered with the user-facing label "dev session", and when picked it stores a session-scope decision in the approvals system, scoped to this extension — subsequent elevated requests for the same extension within that session auto-grant without prompting, regardless of which EV ships next. This is the dev-loop escape hatch. The standard `version` and `repo` decision keys are **not** offered for elevated approvals: a future EV is a future trust grant, and shouldn't carry over from an EV the user previously saw.
- **Distinct decision verbs.** "Install and run" / "Don't install" rather than "Allow" / "Deny". Verb choice matters when the action is qualitatively different.
- **Deferred default.** The default action when the user dismisses the prompt (closes the window, navigates away) is `deny`, never grant.

### Workspace dep update prompt

When a push to a non-extension unit cascades into an extension's EV (e.g. `@workspace/runtime` was pushed; three extensions depend on it), the push trigger issues an `extension.dep-update` request for each affected extension. The UI's treatment is distinct from `extension.install` and `extension.update`:

- **Title leads with the dep.** "An update to `@workspace/runtime` changes 3 of your extensions" rather than re-introducing the extension. The capability framing is shorter — the user previously approved each extension and that authored behavior is unchanged; only the library underneath has new code.
- **Batch by dep, not by extension.** If one push to `@workspace/runtime` affects N extensions, the UI surfaces a single combined card listing all N, not N separate cards. Each extension's `extension.dep-update` request still goes through the approvals system independently; the UI's batching is an aggregation over what's in the queue. A "review and approve all" path is available; a per-extension expand-to-inspect is always available.
- **Diff sections.** The dep diff (commit / stat / link) is the lead. Per-extension subsections list which EVs changed and let the user drill into the dep diff or the extension's own state. The extension source-diff section is empty for dep-updates (no extension source changed).
- **Decision still per-extension.** Granting the batched prompt issues a `once`-equivalent grant per extension, all keyed to the new EVs. Decline declines all (still per-extension on the wire). The user can split out individual decisions from the batch UI.

This mitigates the obvious approval-fatigue problem: a `@workspace/runtime` change in a workspace with a dozen extensions doesn't fire a dozen modal prompts in series, just one card describing the cascade with twelve sub-rows.

### Push-triggered updates

`pushTrigger` (in `src/server/buildV2/pushTrigger.ts`) reacts to **any push that changes an extension's EV** — not just pushes to the extension's own repo. The EV cascade is what buildV2 already computes: a push to `@workspace/runtime` recomputes EVs for every unit transitively depending on it, including extensions.

For each affected extension:

1. Build the new bundle (using buildV2's normal incremental path).
2. Update `resolvedEv` and `resolvedSha` in the registry; stash the new build artifact in `pendingEv` / `pendingSha` / `pendingBundleKey`. The currently running bundle is unchanged — `activeEv` / `activeBundleKey` stay as they were.
3. Decide which sub-kind of approval to request based on what changed:
   - Extension's own source changed → `extension.update`.
   - Only transitive deps changed (no extension source diff) → `extension.dep-update`.
   - Both → `extension.update` (it subsumes dep-update; one prompt covers all the layers).
4. Call `approvals.request({ kind, category: "extension-elevated", detail: { ev, previousEv, extensionDiff, workspaceDepChanges, externalDepChanges, ... } })`. On grant: promote `pendingEv → activeEv`, etc., reload the process. On deny: discard the pending fields. The trigger does not look at stored decisions; auto-grant from a dev-session decision is handled transparently inside the approvals system.

This means **no bundle change ever silently activates**. A pure source change, a transitive dep change, a npm version bump in package.json — all of them flip the EV, and the EV is what's approved.

### Boot-time activation consent

At server boot, the manager walks the registry. For each enabled extension it computes `resolvedEv` (this is cheap — buildV2 caches it) and calls `approvals.request({ kind: "extension.run", category: "extension-elevated", detail: { name, ev: resolvedEv } })`. The approvals system replies:

- **Grant** (typically from a stored install / update / dep-update decision matching `(name, ev)`, or from an active dev-session decision for this extension): activate.
- **Deny**: mark `error`.
- **Pending** (no stored decision, no consumer available to prompt): set `status: "pending-approval"` and leave the request open. When a UI later consents (or denies), the manager reacts accordingly.

**Headless mode**: same flow. Sensitive operations always request approval regardless of UI presence. EVs with a stored grant auto-resolve and activate normally with no UI in the loop. Requests without a stored decision stay pending until a UI client connects and answers them. There is no "skip the approval in headless" path.

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
});

// Standard approval (disable/enable when EV unchanged)
await extensions.setEnabled("@workspace-extensions/git-tools", false);

// Standard approval (uninstall)
await extensions.uninstall("@workspace-extensions/git-tools");

// Elevated approval if reload would change the resolved sha, standard otherwise
await extensions.reload("@workspace-extensions/git-tools");
```

For all sources, `install` fetches into `workspace/extensions/<name>/` as a new workspace unit (cloning from `internal-git`, or initializing a fresh git repo from the fetched `git` / `tarball` content). From that point on every extension is a workspace git unit and rides buildV2 normally — there is no special "local source" code path. Dev iteration happens by editing in `workspace/extensions/<name>/` and pushing to its internal-git repo, optionally with a dev-session approval to avoid the per-push prompt.

| Method | Approval | Notes |
|--------|----------|-------|
| `list` | No | Returns `RegistryEntry[]` (full canonical shape from "Workspace layout") |
| `install` | `extension.install` (elevated) | Fetches into workspace, registers, builds, activates |
| `uninstall` | `extension.uninstall` | Deactivates, removes workspace unit, updates registry; `storage/<workspaceId>/<name>/` is retained unless `purge: true` |
| `setEnabled` | `extension.toggle` | Persisted in registry; on disable, kills the extension process |
| `reload` | `extension.reload` (elevated if EV changed) | Re-resolves the source ref, rebuilds, respawns the process |

There is no `readFile` / `writeFile` over the RPC surface. Source authoring happens against the workspace git; to push changes, commit and let the push trigger prepare the update.

## Activation lifecycle

- **Boot**:
  1. Read the registry. For each enabled extension, compute `resolvedEv` (via the buildV2 cache) and call `approvals.request({ kind: "extension.run", category: "extension-elevated", detail: { name, ev: resolvedEv } })`.
  2. On grant: spawn the process, wait for the ready handshake (timeout: 10s), call `activate(ctx)` over the wire, record the exposed API metadata, set `activeEv = resolvedEv` and `status = "running"`. On pending: set `status = "pending-approval"` and hold; spawn when the approval resolves. On deny: set `status = "error"`.
  3. Throws during `activate` are caught, logged, marked `error` in the registry, and emitted as `extensions:error` events. The process is killed. One extension's failure does not block others.
- **Eager only for v1**. `activationEvents` is plumbed through but only `"*"` is accepted; other values fail validation.
- **Hot install**: a freshly installed extension activates immediately — the manager spawns the process after the elevated approval resolves and the build completes.
- **Hot reload**: `reload` calls `deactivate()` on the running process (with a 5s grace period), then kills it, rebuilds if the EV changed, and spawns a fresh process. Subscribers receive an `extensions:reloaded` event before the old subscriptions go dead.
- **Crash**: handled by the crash policy above. The process boundary contains the failure; the host keeps running.

## Dispatcher integration

Minimal change to `packages/shared/src/serviceDispatcher.ts`:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name.
- Every existing service definition gets `"extension"` added to its `policy.allowed` list explicitly.
- Approval prompts attributed to an extension caller use the standard prompt style, **not** the elevated one — those are reserved for install/update events. The standard prompt's caller-attribution string surfaces the extension name; the prompt is fundamentally a transparency mechanism (the extension chose to route through `ctx.*` rather than call Node directly), not a security boundary.

`ctx.fs` for an extension is **unrestricted** — it covers the whole host filesystem, matching the ambient `node:fs` access the extension already has. There is no per-context root and no path scoping. This is a deliberate departure from panel/worker semantics; per-context rooting would be theater, since the extension can write anywhere via `node:fs` directly. The userland `ctx.fs` exists for callers that want auditable, user-attributable writes; the unrestricted scope makes that path strictly more capable than scoped, not less.

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
- **npm registry as a source**: currently internal-git / git / tarball. npm can be added later.
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
