# CDP Panel Automation

URL panels are opened with the same API as workspace panels. CDP automation is
available on any panel-tree target through the unified `PanelHandle`. In
userland, opening a panel is a structural tree mutation and prompts on first use
per requester entity and parent/root target:

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.page();

await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();
await handle.close();

await openExternal("https://docs.example.com");
```

`handle.reload()` is panel lifecycle reload. For Chromium page reloads, use
`handle.cdp.reload()`.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
await parent?.cdp.page();

const sibling = panelTree.get("sibling-panel-id");
await sibling.cdp.navigate("https://example.com/status");
```

CDP access transparently loads unloaded targets after approval. Use
`handle.ensureLoaded()` only when you need a live target for RPC or `_agent`
introspection before calling `handle.call`, `handle.snapshot()`, `handle.tree()`,
`handle.state()`, `handle.routes()`, or `handle.setMode()`.

## Methods

| Method | Description |
|--------|-------------|
| `handle.cdp.page()` | Connect Playwright and return the page |
| `handle.cdp.navigate(url)` | Load a URL in the target panel |
| `handle.cdp.goBack()` / `goForward()` | Chromium history |
| `handle.cdp.reload()` | Chromium page reload |
| `handle.cdp.stop()` | Stop loading |
| `handle.close()` | Close the panel |

Opening panels, CDP, and structural operations prompt on first use per requester
entity and target panel/root. Privileged shell/about targets use a severe
danger-tone prompt. The remembered grant does not survive requester navigation.
Panels currently held by mobile/non-CDP hosts reject CDP access instead of being
silently taken over.

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.
