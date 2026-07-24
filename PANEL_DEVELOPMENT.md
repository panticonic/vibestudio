# Panel Development Guide

Practical guide to building Vibestudio panels. For API reference, see [PANEL_SYSTEM.md](PANEL_SYSTEM.md).

## Quick Start

```tsx
// panels/my-app/index.tsx
export default function MyApp() {
  return <div>Hello World!</div>;
}
```

```json
// panels/my-app/package.json
{
  "name": "@workspace-panels/my-app",
  "vibestudio": { "title": "My App" },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

That's it. Vibestudio auto-mounts your default export.

---

## Panel Identity

Panels have two IDs. `slotId` is the stable visible panel slot and is the right
identity for panel-tree operations and PubSub/channel clients. `rpc.selfId`
matches the current runtime entity for direct RPC delivery and can change when
the panel navigates or reopens in place.

---

## React Hooks

Import from `@workspace/react`:

```tsx
import {
  usePanel, // Get full runtime API
  usePanelTheme, // "light" | "dark", auto-updates
  usePanelId, // Panel's unique ID
  usePanelPartition, // Storage partition name (null while loading)
  useContextId, // Context ID for storage grouping
  usePanelFocus, // Whether panel is focused
  usePanelParent, // Parent handle (null if root)
} from "@workspace/react";
```

### Theme Integration

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";
import { useAppTheme } from "@workspace/ui/panel";

export default function App() {
  const appearance = usePanelTheme();
  const appTheme = useAppTheme();
  return (
    <Theme appearance={appearance} {...appTheme}>
      {/* Your UI */}
    </Theme>
  );
}
```

### Navigation

Use `openPanel` to open panels. It handles both URLs (browser panels) and workspace sources.
From userland runtimes, opening a panel is a structural tree mutation and prompts on first use
per requester entity and parent/root target; shell UI calls use the trusted shell path.

```tsx
import { openPanel, buildPanelLink } from "@workspace/runtime";

function NavigationExample() {
  // Open a panel (new tab)
  const openEditor = () => openPanel("panels/editor");

  // Open with state args
  const openChat = () => openPanel("panels/chat", { stateArgs: { channel: "my-channel" } });

  // Open a URL as a browser panel
  const openSite = () => openPanel("https://github.com");

  // In-page navigation (replaces current panel) — use buildPanelLink
  const navigateToEditor = () => {
    window.location.href = buildPanelLink("panels/editor");
  };

  // Cross-context in-page navigation
  const navigateToChat = () => {
    window.location.href = buildPanelLink("panels/chat", {
      contextId: "abc-123",
      stateArgs: { channel: "my-channel" },
    });
  };

  return (
    <div>
      <button onClick={openEditor}>Open Editor</button>
      <button onClick={openChat}>Open Chat</button>
      <button onClick={openSite}>Open GitHub</button>
      <button onClick={navigateToEditor}>Navigate to Editor</button>
    </div>
  );
}
```

### Shared Storage with contextId

When panels need to share the same filesystem and storage (e.g., chat + agents in a session):

```tsx
import { buildPanelLink } from "@workspace/runtime";

function SessionLauncher() {
  const launchSession = () => {
    // Generate shared context ID for the session
    const sessionContextId = crypto.randomUUID();

    // Navigate to chat panel with shared storage
    window.location.href = buildPanelLink("panels/chat", {
      contextId: sessionContextId,
      stateArgs: {
        channelName: "my-channel",
        contextId: sessionContextId,
      },
    });

    // Or open an agent worker in a new tab sharing the same storage
    window.open(
      buildPanelLink("workers/agent", {
        contextId: sessionContextId,
        stateArgs: {
          channel: "my-channel",
          contextId: sessionContextId,
        },
      })
    );
  };

  return <button onClick={launchSession}>Start Session</button>;
}
```

**Important:** Pass `contextId` in both the link options (for storage) and
stateArgs (for app logic). `contextId` is not a build selector. If the panel code
itself must come from a context branch, the launch/navigation path must carry an
explicit build `ref` such as `ctx:<contextId>`; otherwise the panel uses the
main/default build.

---

## Non-React panels / Choosing a framework

React is the default, but a panel can opt into another UI framework with
`vibestudio.template`. The template's `template.json` decides which esbuild adapter
compiles the panel: `"default"` ⇒ React + Radix, `"svelte"` ⇒ Svelte, `"vanilla"`
⇒ no framework (plain DOM). See
[PANEL_SYSTEM.md](PANEL_SYSTEM.md) for the full resolution order.

The neutral `@workspace/runtime` API — identity, navigation, `rpc`, `openPanel`,
`panel.stateArgs`, `vcs`, `workspace`, and so on — is **identical
across all three frameworks**. Only the rendering layer and the binding package
change.

### Svelte (`panels/hello-svelte`)

Set the template to `"svelte"` and depend on `@workspace/svelte`:

```json
// panels/hello-svelte/package.json
{
  "name": "@workspace-panels/hello-svelte",
  "vibestudio": { "title": "Hello Svelte", "template": "svelte" },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/svelte": "workspace:*"
  }
}
```

The entry is a tiny `index.ts` that re-exports the root `.svelte` component:

```ts
// panels/hello-svelte/index.ts
export { default } from "./App.svelte";
```

esbuild-svelte compiles `.svelte` files at build time, but `tsc` does not parse
them — add a one-line ambient shim so type-checking resolves the import:

```ts
// panels/hello-svelte/svelte.d.ts
declare module "*.svelte";
```

`panels/hello-svelte` is the canonical, working reference.

### Vanilla (`panels/hello-vanilla`)

No UI binding package — set the template to `"vanilla"` and depend only on
`@workspace/runtime`:

```json
// panels/hello-vanilla/package.json
{
  "name": "@workspace-panels/hello-vanilla",
  "vibestudio": { "title": "Hello Vanilla", "template": "vanilla" },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

The entry is an `index.ts` that mounts itself into the template's `#root` with
plain DOM:

```ts
// panels/hello-vanilla/index.ts
const root = document.getElementById("root")!;
root.textContent = "Hello from a vanilla panel!";
```

`panels/hello-vanilla` is the canonical, working reference.

---

## Typed RPC Communication

For type-safe parent-child communication, define a contract:

### 1. Define Contract (child panel)

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      saved: z.object({ path: z.string(), timestamp: z.number() }),
      modified: z.object({ dirty: z.boolean() }),
    },
  },
});
```

### 2. Export Contract (child's package.json)

```json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

### 3. Implement Child

```tsx
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract);

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.exposeAll({
      async getContent() {
        return content;
      },
      async setContent(text) {
        setContent(text);
      },
      async save() {
        // Save logic...
        await parent?.emit("saved", { path: "/file.txt", timestamp: Date.now() });
      },
    });
  }, [content]);

  return (
    <textarea
      value={content}
      onChange={(e) => {
        setContent(e.target.value);
        parent?.emit("modified", { dirty: true });
      }}
    />
  );
}
```

### 4. Use from Parent

```tsx
// panels/ide/index.tsx
import { useState, useEffect } from "react";
import { buildPanelLink } from "@workspace/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [dirty, setDirty] = useState(false);

  const launch = () => {
    // Navigate to the editor panel via URL
    window.open(buildPanelLink("panels/editor"));
  };

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      <span>{dirty ? "Modified" : "Saved"}</span>
    </div>
  );
}
```

---

## File System

Safe panels use an RPC-backed filesystem with a Node.js-compatible API:

```tsx
import { promises as fs } from "fs";

async function example() {
  await fs.writeFile("/data.json", JSON.stringify({ key: "value" }));
  const content = await fs.readFile("/data.json", "utf-8");
  const files = await fs.readdir("/");
  await fs.mkdir("/subdir", { recursive: true });
  await fs.rm("/data.json");
}
```

### Workspace VCS (semantic and workspace-atomic)

Vibestudio has one workspace ancestry graph. Repository and file views are
focused projections of an exact event or application state, not independent
logs or staging boundaries. Managed edits author intent-bearing work units and
append applications to a context's working head. Commit records the complete
local application chain as one workspace event.

Writing the first managed file for a brand-new panel records its repository
lifecycle through the managed filesystem adapter. Use `vcs.edit` for direct
semantic content changes and `vcs.move` / `vcs.copy` for explicit identity
operations. Every mutation carries the exact `expectedWorkingHead` it observed
and a stable `commandId`. Reuse a command ID only to recover an uncertain
identical response. Disk is a projection of the returned working head.

Publication is also workspace-wide. Run the ordinary build service against the
exact context state, commit the complete local chain, then use `vcs.push` to
approval-gate and atomically advance protected `main`. If main advanced, compare
its event, integrate source changes through local decisions, recommit, and retry.
There is no repository-group push, staging path, or rebase shortcut.

```typescript
import { contextId, vcs } from "@workspace/runtime";

const command = (operation: string) => `panel-dev:${operation}:${contextId}:${crypto.randomUUID()}`;
const status = await vcs.status({ contextId });
if (status.mainRelation === "behind" || status.mainRelation === "diverged") {
  throw new Error("Compare and integrate current main before committing");
}
const committed = await vcs.commit({
  commandId: command("commit"),
  contextId,
  expectedWorkingHead: status.workingHead,
  message: "Implement panel change",
});
const result = await vcs.push({
  commandId: command("publish"),
  contextId,
  expectedCommittedEventId: committed.event.eventId,
  expectedMainEventId: status.mainEventId,
});
console.log(`published ${result.eventId} as main ${result.mainEventId}`);
```

Read the canonical
[Vibestudio VCS skill](workspace/skills/vibestudio-vcs/SKILL.md) for
compare/integrate decisions, complete-chain commit, move/copy provenance,
typed recovery, and protected publication.

---

## Environment Variables

Access environment variables passed to your panel via `panel.env`:

```typescript
import { panel } from "@workspace/runtime";

const workspace = panel.env["VIBESTUDIO_WORKSPACE"] || "/workspace";
```

---

## CDP Panel Automation

Use `PanelHandle` for new or existing panels. Opening panels, CDP, and
structural operations are approval-gated per requester/target.

#### Typed API

```typescript
import { openPanel, openExternal, panelTree } from "@workspace/runtime";

// panelTree is a top-level export, not workspace.panelTree.
const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.page();

await page.locator("input[name=query]").fill("Vibestudio");
await page.locator(".search-button").click();
const text = await page.locator(".results .first").textContent();
const currentUrl = page.url(); // string, synchronous like Playwright

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

// Existing panels: discover or get by slot id.
const parent = panelTree.self().parent();
await parent?.cdp.page();

const allPanels = await panelTree.list();
const existing = allPanels.find((panel) => panel.source === "panels/spectrolite");
const existingPage = await existing?.cdp.page();

const known = panelTree.get("panel-slot-id");
await known.refresh(); // hydrate metadata when you start from a known slot id
await known.cdp.page();

// Or open in system browser (no CDP access)
await openExternal("https://docs.example.com");
```

Panels created by the workflow are owned by it; close temporary owned panels
when the workflow is done. Existing handles from `panelTree.*` are non-owned:
do not navigate, reload, or close them unless requested.

#### Fire-and-forget (window.open)

In Electron mode, `window.open("https://...")` also creates browser panels. Discover the child ID via event:

```typescript
import { getPanelHandle, onChildCreated } from "@workspace/runtime";

onChildCreated(({ childId, url }) => {
  const handle = getPanelHandle(childId);
  // Now use handle.cdp.getCdpEndpoint(), handle.cdp.navigate(), etc.
});
window.open("https://example.com");
```

#### PanelHandle CDP methods

| Method                 | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `cdp.page()`           | Connect the canonical CDP automation client and return the active page |
| `cdp.getCdpEndpoint()` | Get CDP WebSocket URL and token for Playwright                         |
| `cdp.navigate(url)`    | Load a URL                                                             |
| `cdp.goBack()`         | Navigate back                                                          |
| `cdp.goForward()`      | Navigate forward                                                       |
| `cdp.reload()`         | Reload page                                                            |
| `cdp.stop()`           | Stop loading                                                           |
| `close()`              | Close browser panel                                                    |

Use `handle.ensureLoaded()` before RPC calls to an unloaded panel. CDP access
loads targets automatically after approval.

The CDP page API follows Playwright's sync/async split: actions and
DOM reads are async, while `page.url()` returns the cached current URL as a
plain string. Do not `await page.url()` or attach `.catch()` to it; use
`await page.evaluate(() => location.href)` only when the URL must be computed in
the page context.

---

## Sharing Code

### Export from Panel

```json
{
  "name": "@workspace-panels/my-panel",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts",
    "./types": "./types.ts"
  }
}
```

### Import in Another Panel

```json
{
  "dependencies": {
    "@workspace-panels/my-panel": "workspace:*"
  }
}
```

```typescript
import { myContract } from "@workspace-panels/my-panel/contract";
import type { MyType } from "@workspace-panels/my-panel/types";
```

---

## State Args

Pass and receive configuration data during panel navigation:

```typescript
import { buildPanelLink, panel } from "@workspace/runtime";
import { useStateArgs } from "@workspace/react"; // React hook — the reactive form of panel.stateArgs.get

// Pass state when navigating
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general", mode: "compact" },
});

// Read state reactively in a component (re-renders on update)
const stateArgs = useStateArgs<{ channelName: string; mode: string }>();

// Read state non-reactively (snapshot, for event handlers)
const args = panel.stateArgs.get<{ channelName: string }>();

// Update state (persists to DB + triggers re-render via WebSocket)
await panel.stateArgs.set({ mode: "expanded" });
```

---

## Persistent storage

There is no panel-facing `db` API. Persistent SQL storage lives inside Durable
Objects: every DO has a `this.sql` handle on its own private SQLite-backed
storage. To persist state from a panel, dispatch to a worker DO that owns the
schema. See `docs/architecture/storage.md` for the storage primitive and
`workspace/skills/workspace-dev/WORKERS.md` for the canonical worker/DO pattern.

For ephemeral or per-panel state, prefer `useStateArgs`/`panel.stateArgs.set` (above)
or the panel scope persistence (`scope` RPC service) used by the agentic-chat
REPL.

---

## Userland Approval Prompts

Use `approvals.request()` when a panel owns a domain-specific decision and wants
Vibestudio's trusted shell UI to ask the user. The verified panel is shown as the
issuer, and every non-dismiss choice is remembered for that issuer and
`subject.id`.

```tsx
import { approvals } from "@workspace/runtime";

const decision = await approvals.request({
  subject: { id: "sync:push", label: "Sync push" },
  title: "Allow sync push?",
  summary: "This panel wants to let the sync service push changes.",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
});

if (decision.kind === "choice" && decision.choice === "allow") {
  // Continue with the panel-owned action.
}

await approvals.revoke("sync:push");
const grants = await approvals.list();
```

Use built-in APIs instead for built-in host capabilities: `openExternal`,
`credentials.*`, `git.*`, and workspace/project operations already include the
right approval and trust-scope behavior.

---

## Channel Services

Real-time panel messaging is implemented as a workspace-authored service.
Use the workspace-local panel development docs for the current client package
and examples.

Key channel client APIs:

- `publish(type, payload)` -- Send a message
- `messages()` -- Async iterator for incoming messages
- `onRoster(handler)` -- Track connected participants
- `updateMetadata(meta)` -- Update participant metadata
- `ready()` -- Wait for replay completion

---

## Best Practices

1. **Use hooks** -- `usePanelTheme`, `useContextId`, etc. handle subscriptions automatically

2. **Use contracts** -- Type safety across panel boundaries catches errors at compile time

3. **Check optional parents** -- Panels may run standalone:

   ```typescript
   const parent = getParentWithContract(contract);
   await parent?.emit("event", data);
   ```

4. **Export contracts** -- Put contract in separate file and export via package.json

5. **Use openPanel for navigation** -- `openPanel(source)` opens any panel; use `buildPanelLink` only for in-page navigation:
   ```typescript
   import { openPanel } from "@workspace/runtime";
   await openPanel("panels/target");
   ```
