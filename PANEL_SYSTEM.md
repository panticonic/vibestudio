# Panel System Overview

Vibez1 panels are dynamically loaded TypeScript apps that run in isolated webviews. Panels navigate to each other via URL-based navigation.

## Panel Structure

```
my-panel/
├── package.json      # Manifest with vibez1 field (required)
├── index.tsx         # Entry point
├── contract.ts       # Optional: RPC contract for typed parent communication
└── style.css         # Optional: Styles
```

## Manifest (`package.json`)

```json
{
  "name": "@workspace-panels/my-panel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "vibez1": {
    "title": "My Panel",
    "entry": "index.tsx",
    "exposeModules": ["@radix-ui/colors"]
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

### Manifest Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | package name | Display name |
| `entry` | string | `index.tsx` | Entry point file |
| `template` | string | `"default"` | Workspace template name (see below) |
| `sourcemap` | boolean | `true` | Include inline source maps |
| `externals` | Record | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | string[] | `[]` | Modules registered on `__vibez1ModuleMap__` |
| `dedupeModules` | string[] | `[]` | Additional packages to deduplicate (react/react-dom always deduped) |
| `shell` | boolean | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | boolean | `false` | Hide from launcher UI |

## Workspace Templates

The `template` field in the vibez1 config selects a workspace template from `workspace/templates/{name}/`. Each template provides a `template.json` (framework config) and an `index.html` (HTML shell that loads `bundle.js` into `#root`). The template defines the framework, so panels do not need a separate `framework` field.

Three frameworks are supported, one per template:

| Template | Framework | UI layer | Binding package |
|----------|-----------|----------|-----------------|
| `default` (`workspace/templates/default/`) | `react` | React + Radix UI | `@workspace/react` |
| `svelte` (`workspace/templates/svelte/`) | `svelte` | Svelte 5 | `@workspace/svelte` |
| `vanilla` (`workspace/templates/vanilla/`) | `vanilla` | none — pure DOM | none (`@workspace/runtime` only) |

Most panels should use the `default` (React) template. To use another framework, set the `template` field and depend on its binding package (or none for vanilla). Canonical examples: `panels/hello-svelte` (Svelte) and `panels/hello-vanilla` (vanilla); see [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) for how to write each.

### Framework resolution order

The build's `src/server/buildV2/templateResolver.ts` picks the HTML shell and framework from the panel's source in this order:

1. **Panel owns an `index.html`** → it is self-contained: its own HTML is used, and the default template's framework does **not** bleed in.
2. **Otherwise, an explicit `vibez1.template`** → that template's `index.html` and `template.json` are used.
3. **Otherwise, the default template** (`templates/default/`, React) is used.

The framework id is read from the chosen template's `template.json` (`{"framework": ...}`). When no template applies (a self-contained panel, or no template at all), it falls back to dependency auto-detection: `@workspace/react` ⇒ `react`, `@workspace/svelte` ⇒ `svelte`, neither ⇒ `vanilla`.

## Core Runtime API

```typescript
import {
  // Identity & storage context (top-level)
  id,                    // Current runtime entity ID (changes on navigate/reopen)
  contextId,             // Storage context ID

  // The `panel` namespace — identity, theme, lifecycle, state args
  panel,                 // panel.slotId / entityId / parentId / env;
                         // panel.getTheme() / onThemeChange() / getInfo();
                         // panel.focusPanel() / onFocus() / onConnectionError() / reopen();
                         // panel.registerPaletteCommands() / onPaletteRun();
                         // panel.stateArgs.{ get, set, setForPanel }

  // RPC
  rpc,                   // RPC client: rpc.expose(), rpc.call(), events
  callMain,              // Call a server ("main") service method

  // Panels & navigation
  openPanel,             // Open a workspace/browser panel → PanelHandle
  buildPanelLink,        // Build a navigation URL (low-level; prefer openPanel)
  panelTree,             // Get/list/walk the panel tree (top-level, NOT workspace.panelTree)
  getPanelHandle,        // Handle by id
  listPanels,            // List open panels
  parent,                // This panel's parent handle (no-op handle when root)
  getParent,             // Parent handle, or null
  getParentWithContract, // Contract-typed parent handle, or null
  onChildCreated,        // window.open child notifications
  openExternal,          // Open a URL in the system browser

  // Filesystem & service namespaces
  fs,                    // RPC-backed filesystem
  workspace,             // Workspace catalog, source tree, units
  vcs,                   // GAD VCS: edit → commit → push
  gad,                   // GAD store queries
  git, blobstore, credentials, workers,
  extensions, approvals, notifications, webhooks,

  // Durable Objects, gateway, agent APIs
  doTargetId, createDurableObjectServiceClient,
  gatewayConfig, gatewayFetch,
  agentApi, adblock, journal,

  // Authoring helpers (portable: identical on panel · worker · eval)
  z, defineContract, Rpc,
  parseContextId, isValidContextId, getInstanceId,
  normalizePath, getFileName, resolvePath, createGatewayFetch,
} from "@workspace/runtime";
export type { PanelHandle } from "@workspace/runtime";
```

The full, always-current surface is generated from the runtime manifest into
[`workspace/skills/sandbox/RUNTIME_API.md`](workspace/skills/sandbox/RUNTIME_API.md)
(CI-checked via `pnpm check:runtime-docs`); call `await help()` at runtime for the
live surface. Identity, theme, lifecycle, and state args live under the `panel.*`
namespace — they are **not** flat top-level exports.

State args are read and written imperatively via `panel.stateArgs.get()` /
`panel.stateArgs.set()`. For reactive access in a React panel, use the
`useStateArgs` hook from `@workspace/react`:

```typescript
import { panel } from "@workspace/runtime";
import { useStateArgs } from "@workspace/react";

const snapshot = panel.stateArgs.get<{ channel: string }>(); // imperative
const reactive = useStateArgs<{ channel: string }>();         // re-renders
```

Use `panel.slotId` for panel-tree operations and PubSub/channel client identity. Use
`id`/`panel.entityId`/`rpc.selfId` only when you need the current live runtime entity;
that entity can change when a panel navigates or reopens in place.

`panelTree` is a top-level runtime export. Do not call
`workspace.panelTree`; the `workspace` namespace is for workspace catalog,
source-tree, and unit helpers, with only `workspace.openPanel` as a panel-opening
convenience.

## Navigation

Use `openPanel` to open panels. It handles both URLs (browser panels) and workspace sources:

```typescript
import { openPanel } from "@workspace/runtime";

await openPanel("panels/editor");                          // Open a workspace panel
await openPanel("panels/chat", { stateArgs: { ch: "x" }}); // With state args
await openPanel("https://github.com");                     // Open URL as browser panel
```

For in-page navigation (replacing the current panel), use `buildPanelLink` + `window.location.href`:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Same-context navigation (relative URL)
window.location.href = buildPanelLink("panels/chat");

// Cross-context navigation (absolute URL with contextId query parameter)
window.location.href = buildPanelLink("panels/chat", { contextId: "abc-123" });
```

`buildPanelLink` returns a relative path for same-context navigation and an absolute URL with `contextId` in the query string when `contextId` is provided.


## PanelHandle Methods

```typescript
const handle = panelTree.get("panel-id");

handle.id                         // Stable panel slot ID
await handle.refresh()            // Hydrate metadata for an existing slot
handle.call.method(args)          // Call exposed RPC method
handle.emit("event", payload)     // Emit event to the panel
handle.on("event", handler)       // Listen for events from the panel
handle.cdp.lightweightPage()      // Approval-gated CDP page access
handle.ensureLoaded()             // Explicit load for RPC/introspection
handle.close()                    // Approval-gated structural operation
```

Use `panelTree.get/list/roots/children` for existing panels;
`openPanel()` creates a new panel. Existing handles are
non-owned: do not navigate, reload, or close them unless requested; clean up
temporary panels opened by the workflow when it is done.

## Typed RPC Contracts

Define contracts for type-safe parent communication:

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string() }),
    },
  },
});
```

A panel exposes methods and communicates with its parent using the contract:

```typescript
import { rpc, getParentWithContract } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract);

rpc.expose({
  async getContent() { return content; },
  async setContent(text) { setContent(text); },
});

await parent?.emit("saved", { path: "/file.txt" }); // Typed when a parent is present.
```

## Repo Utilities

Query workspace repo metadata through the workspace and VCS namespaces:

```typescript
import { workspace, vcs } from "@workspace/runtime";

// Get the full workspace source tree
const tree = await workspace.sourceTree();
// tree.children: WorkspaceNode[] — each node has name, path, isUnit,
//   launchable?: { title }, packageInfo?: { name, version }, children

// Resolve a source path to its owning repo
const owner = await workspace.findUnitForPath("panels/editor/src/index.tsx");
// { unitPath: "panels/editor", relativePath: "src/index.tsx" }

// Read recent GAD-native repo history
const history = await vcs.log("panels/editor", { limit: 50 });
```

## Connection Error Handling

Monitor RPC connection health:

```typescript
import { onConnectionError } from "@workspace/runtime";

const unsubscribe = onConnectionError((error) => {
  console.error(`Connection error [${error.code}]: ${error.reason}`);
  // error.source is "electron" or "server" when using dual transports
});

// Later: unsubscribe();
```

Fires on terminal WebSocket close codes (auth failures like invalid token or bad handshake). Does not fire on normal disconnects (e.g., panel closing).

## Context & Storage

Panels have isolated storage based on their context ID:

- **Default**: `ctx_{instanceId}` -- server-side context folder per panel
- **Shared**: Panels sharing the same `contextId` share storage

## Workspace Packages

Panels can share code via workspace packages:

| Scope | Location | Purpose |
|-------|----------|---------|
| `@workspace/*` | `workspace/packages/` | Shared utilities |
| `@workspace-panels/*` | `workspace/panels/` | Panel packages |
| `@workspace-about/*` | `workspace/about/` | About/shell panels |
| `@workspace-agents/*` | `workspace/agents/` | Agent packages |

Export contracts for cross-panel imports:
```json
{
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

## Build System

- Panels built on-demand with esbuild
- Cached by effective version (content hash + transitive dependency hashes)
- Build store: `{userData}/builds/{build_key}/`
- See [BUILD_SYSTEM.md](BUILD_SYSTEM.md) for full details
