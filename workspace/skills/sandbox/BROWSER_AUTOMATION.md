# CDP Panel Automation

Automate panels with Playwright-style CDP page control. For web browsing or
website automation, open or reuse a dedicated browser panel. Existing workspace
panels, including chat panels, are application surfaces: inspect them when
debugging that app, but do not use them as disposable web pages.

> **Where this runs.** `openPanel`, `panelTree`, and `getPanelHandle` are part
> of the portable runtime surface from `@workspace/runtime`; they work from
> server-side eval, panels, workers, and DOs. The workerd-native CDP client is
> workerd-native and runs over a WebSocket to the panel's CDP endpoint, so a
> browser panel opened from eval can be driven there directly. The "Inline UI:
> Browser Control Panel" example below shows the panel/component
> shape; the `eval` snippets show the same page API. (`browserData` from
> `browserData` from `@workspace/runtime` is shell-only and not reachable from server-side
> eval.)

## Open Once, Reuse Across Calls (component refs)

The primary pattern: open a browser panel once, hold the handle/page (e.g. in a
component `useRef`/`useState`), and reuse it across interactions — do not
re-open or re-connect for the same target.

```tsx
// Open browser panel once, hold the handle
const handle = await openPanel("https://example.com");
const page = await handle.cdp.page();
console.log("Opened:", await page.title());

// Reuse — no new panel, same page
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByLabel("Email").fill("user@example.com");
await page.getByRole("button", { name: "Submit" }).click();
await page.waitForSelector(".dashboard");

const results = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map((el) => el.textContent)
);
console.log("Scraped", results.length, "items");
```

Two lines to get started:

1. `const handle = await openPanel(url)` — opens a browser panel; may prompt on first structural use
2. `const page = await handle.cdp.page()` — connects the canonical CDP client

Reuse the same `page` while `handle.observe().runtimeEntityId` is unchanged.
Do not call `openPanel()` or `handle.cdp.page()` repeatedly for one runtime
incarnation: repeated opens create duplicate panels and repeated page calls
create duplicate CDP connections. `handle.navigate()` and `handle.rebuild()`
replace the runtime incarnation; after either resolves, discard the old page
and obtain one fresh `await handle.cdp.page()` from the same handle.

Before the first live interaction, discover the intended roles and computed
accessible names with `getByRole(role).all()` plus `locator.inspect()`.
Descendant text and badges contribute to accessible names; do not guess them
from visual labels or source snippets.

When a task specifically requires a child panel from a genuinely headless
session, `getParent()` is null because there is no initial UI node. The tree is
still available: create an owned root with
`openPanel("about/new", { parentId: null })`, then open the target with
`{ parentId: root.id }`. See `EVAL.md#eval-perspective` for the complete cleanup
pattern. Do not test for an owner with the truthiness of the compatibility
`parent` handle.

## Existing Panels

Use `panelTree` for already-open panels; do not reopen duplicates. Only drive
an existing workspace panel when the task is to inspect or test that panel's
own UI. For arbitrary URLs, login flows, scraping, or browser navigation, use
`openPanel(url)` and hold that browser handle in your component's state.

```ts
import { panelTree } from "@workspace/runtime";

// panelTree is top-level; workspace.panelTree is not available.
const panels = await panelTree.list();
const target = panels.find((handle) => handle.source === "panels/spectrolite");
if (!target) throw new Error("target panel not found");

const page = await target.cdp.page();
console.log(await page.title());
```

With a known slot id:

```ts
import { panelTree } from "@workspace/runtime";

const handle = panelTree.get("panel-slot-id");
const observation = await handle.observe(); // exact attempt, host state, and provenance
const page = await handle.cdp.page();
```

`openPanel()` returns only at application boot-ready. Existing-panel handles are
non-owned: observe first, and do not call `handle.navigate`,
`handle.reload`, or `handle.close` on them unless requested. Do not call
`handle.cdp.navigate(url)` or `page.goto(url)` on the current chat panel, a
parent chat panel, or any workspace panel discovered from `panelTree` unless
the requested task is to replace that exact panel. Open a browser panel for web
navigation instead.

## Panel Ownership

Panels opened by the workflow are owned by it. Hold handles in your component's
state; close temporary owned panels when the workflow is done:

```ts
await browser?.close();
```

Do not close panels discovered with `panelTree.*` unless requested.

## Reconnection by Panel ID

Browser handles and CDP pages are live objects tied to the panel runtime; they
cannot be persisted (the eval `scope` is server-side in your `EvalDO`, and a
panel/component's own state is lost on re-mount or panel reload). What you can
persist is the panel **id** (a string). Re-acquire a handle from a known id with
`getPanelHandle` (or rediscover via `panelTree.list()`) from panel/component
code, then reconnect the CDP page:

```tsx
import { getPanelHandle } from "@workspace/runtime";

const handle = getPanelHandle(savedBrowserId); // panel id survives as a plain string
const page = await handle.cdp.page();
console.log("Reconnected:", await page.title());
```

Keep the panel id somewhere durable for the surface you're on (component
props/state, or a value you stash via the channel) rather than relying on a live
handle persisting.

## Page API Reference

Obtain a `page` from a panel handle, then use the methods below.
`handle.cdp.page()` returns the canonical Playwright-style page driven by our
workerd-native CDP client (`@workspace/cdp-client`). It is the single
browser-automation surface — there is no separate compatibility tier
to choose, and you do not import or install any `playwright*` package.

```typescript
const browser = await openPanel("https://example.com");
const page = await browser.cdp.page();
```

`handle.cdp.page()` loads the standalone `@workspace/cdp-client`
internally; do not import that package directly for ordinary page work. There is
no second page-acquisition API.

Historical console diagnostics are not a CDP page feature. CDP console events
only include messages after the client connects. For "something already went
wrong in this panel" debugging, use the host-captured history:

```ts
const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 });
console.log(history.errors.map((entry) => entry.message));
console.log(history.dropped); // visible overflow counts, not silent truncation
```

`history.entries` is the recent general console buffer. `history.errors` is a
separate error-only buffer so noisy normal logs do not evict historical errors.
Each entry includes `timestamp`, `level`, `message`, `line`, `sourceId`, and
`url`. Use `page.consoleEvents()` on the page only for live events captured
after the CDP connection is established.

For broad post-mortem panel debugging, prefer the unified bundle:

```ts
const diagnostics = await handle.diagnose();
console.log(diagnostics.observation);
if (diagnostics.consoleHistory.available) {
  console.log(diagnostics.consoleHistory.errors);
}
```

The same historical capture includes renderer lifecycle failures such as
`render-process-gone`, failed main-frame loads, and unresponsive renderer
events.

If the symptom is outside the renderer — panel broker errors, build/reload
scheduling, workerd supervision, server reconnects, or startup/shutdown — use
the host log stream instead: `services.serverLog.query(...)` from eval, or the
`about/server-logs` live viewer. See `../server-logs/SKILL.md`.

`page.url()` follows the Playwright shape: it returns a string synchronously,
not a `Promise`. Do not `await page.url()` or attach `.then()` / `.catch()` to
it. Use `await page.evaluate(() => location.href)` only when you need the page
to compute a URL after client-side routing. Panel handles expose target RPC
under `.call` and automation under `.cdp`; `handle.click(selector)` is a
Playwright convenience wrapper for `handle.cdp.click(selector)`.
Use `await parent.observe()` for canonical handle/runtime metadata; the runtime's own
`panel.getInfo()` describes the current runtime, not arbitrary handles.

### Locators

Locators auto-wait — the element is resolved when an action or read runs against
it, so you can build a locator before the element exists.

```typescript
page.locator("css selector");
page.getByRole("button", { name: "Sign in", exact: true });
page.getByRole("button", { name: /delete .* item/i });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");

// Chaining
page
  .getByRole("listitem")
  .filter({ hasText: /active/i })
  .nth(2);
page.locator(".row").first();
page.locator(".row").last();
const rows = await page.locator(".row").all();
```

### Navigation

```typescript
await page.goto(url); // navigate (waits for load)
await page.reload();
await page.goBack();
await page.goForward();
page.url(); // current URL
await page.evaluate(() => location.href); // current URL computed in page context
await page.title(); // page title
await page.content(); // full HTML source
```

### Interaction (auto-wait)

Actions wait for the element to be visible, stable, and enabled before acting.

```typescript
await page.getByRole("button", { name: "Submit" }).click();
await page.locator(".item").dblclick();
await page.locator(".item").hover();
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Search").type("query"); // appends to the current value
await page.getByLabel("Email").clear();
await page.locator("input").press("Enter");
await page.keyboard.press("Control+A");
await page.keyboard.type("replacement");
await page.keyboard.insertText("inserted in one browser operation");
await page.setViewportSize({ width: 390, height: 844 });
page.viewportSize(); // synchronous current CSS viewport
await page.getByRole("checkbox").check();
await page.getByRole("checkbox").uncheck();
await page.getByRole("checkbox").setChecked(true);
await page.getByLabel("Country").selectOption("US");
await page.locator("input").focus();
await page.locator("input").blur();
await page.locator(".far-below").scrollIntoViewIfNeeded();

// CSS locator forms
await page.locator("button.submit").click();
await page.locator('input[name="email"]').fill("user@example.com");
```

Text locators accept strings or `RegExp`; regular expressions retain their
source and flags across the workerd/CDP boundary. `fill()`, `type()`, `clear()`,
and checked-state actions use the element's native property setter before
dispatching browser events, so controlled React inputs observe the same state
change as a user edit.

### Reads & state

```typescript
await page.locator(".modal").waitFor({ state: "visible" });
await page.locator(".row").count();
await page.locator(".badge").isVisible();
await page.getByRole("checkbox").isChecked();
await page.locator("button").isEnabled();
await page.locator("button").isDisabled();
await page.locator("input").isEditable();
await page.locator("a").getAttribute("href");
await page.locator("input").inputValue();
await page.locator(".title").innerText();
await page.locator(".title").textContent();
await page.locator(".row").allInnerTexts();
await page.locator(".row").allTextContents();
await page.locator(".row").evaluateAll((rows) => rows.map((row) => row.textContent?.trim()));
await page.locator(".box").boundingBox();
await page.locator(".box").inspect();
// inspect() includes role and accessibleName in addition to DOM/visibility data.
```

### DOM waits

```typescript
await page.waitForSelector(".loaded"); // wait for element to appear
await page.waitForFunction(() => document.readyState === "complete");
await page.waitForLoadState("domcontentloaded"); // or "load"
```

### Evaluate JavaScript in Page

The most powerful method — run arbitrary JS in the page context:

```typescript
// Get text content
const text = await page.evaluate(() => document.querySelector("h1")?.textContent);

// Get multiple elements
const items = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map((el) => ({
    title: el.querySelector("h3")?.textContent,
    href: el.querySelector("a")?.getAttribute("href"),
  }))
);

// Pass arguments
const text = await page.evaluate((sel) => document.querySelector(sel)?.textContent, ".my-class");

// Interact with the page
await page.evaluate(() => {
  document.querySelector("form")?.submit();
});
```

`page.evaluate`, `waitForFunction`, and `locator.evaluateAll` serialize the
callback into the browser realm. Pass outside data through the explicit
argument instead of closing over eval variables. Browser exceptions retain
their real exception description and stack; locator failures additionally name
the rendered locator. If an error only says `Uncaught`, that is a platform
regression—capture it with `handle.diagnose()` rather than guessing.

### Screenshots

Prefer the panel handle for a reliable whole-panel capture. It uses the active
host directly (including hidden or unslotted panels) and returns base64 plus the
actual media metadata:

```typescript
import { blobstore } from "@workspace/runtime";

const shot = await handle.cdp.screenshot({ format: "png" });
const stored = await blobstore.putBase64(shot.data); // exactly one base64 argument
return {
  ...stored,
  mimeType: shot.mimeType,
  width: shot.width,
  height: shot.height,
};
```

When you specifically need a screenshot from the CDP page, it returns
raw bytes. Store those bytes with the runtime convenience method:

```typescript
const png = await page.screenshot({ fullPage: true }); // PNG Uint8Array
const jpeg = await page.screenshot({ type: "jpeg", quality: 80 });
const stored = await blobstore.putBytes(png);
return { ...stored, mimeType: "image/png" };
```

Blobstore content is addressed by bytes and does not store MIME metadata. Keep
the MIME type beside the digest; do not pass it as a second `putBase64` argument.
The workerd-native page has no filesystem `path` option; unsupported screenshot
options are rejected instead of ignored.

### Close

```typescript
await page.close(); // disconnect this automation client; panel remains open
await browser.close(); // close the owned browser panel handle
```

### Not supported

The CDP client deliberately omits a few Playwright features. Out of
scope: file uploads (`setInputFiles`), multiple pages/popups, cross-origin
frames, and full network request interception (`route`). For protocol-level
needs beyond the page surface, use raw `CdpConnection.send` (see below).

### Protocol-level work

For raw CDP, connect to the panel's CDP endpoint and drive the protocol
directly:

```ts
import { CdpConnection } from "@workspace/cdp-client";

const endpoint = await handle.cdp.getCdpEndpoint(); // { wsEndpoint, token }
const c = await CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);

await c.send("Page.navigate", { url: "https://example.com" });
c.on("Page.loadEventFired", () => console.log("loaded"));
```

Use `c.send(method, params)` for CDP commands and `c.on(event, cb)` for CDP
events — the escape hatch for network interception, file inputs, or multi-target
work the page surface does not cover.

### PanelHandle Methods

The handle also has direct navigation methods (no page object needed):

| Method                                             | Description                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `handle.cdp.page()`                                | Connect the canonical CDP client and return the Playwright-style page      |
| `handle.cdp.getCdpEndpoint()`                      | Get `{ wsEndpoint, token }` for raw `CdpConnection.connect`                |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer   |
| `handle.cdp.screenshot({ format, quality })`       | Capture through the active host; returns base64, MIME type, and dimensions |
| `handle.click(selector)`                           | Convenience wrapper for `handle.cdp.click(selector)`                       |
| `handle.cdp.navigate(url)`                         | Load a URL                                                                 |
| `handle.cdp.goBack()`                              | Navigate back                                                              |
| `handle.cdp.goForward()`                           | Navigate forward                                                           |
| `handle.cdp.reload()`                              | Reload page                                                                |
| `handle.cdp.stop()`                                | Stop loading                                                               |
| `handle.close()`                                   | Close browser panel                                                        |

## Examples

These examples acquire a panel handle in panel/component code; the
`handle.cdp.page()` automation itself also works from server-side
eval once you hold the handle.

### Multi-Step Workflow: Scrape + Process

```tsx
import { openPanel } from "@workspace/runtime";

// Open and navigate
const browser = await openPanel("https://news.ycombinator.com");
const page = await browser.cdp.page();

// Scrape data
const stories = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".titleline > a")).map((el) => ({
    title: el.textContent,
    href: el.getAttribute("href"),
  }))
);
console.log("Scraped", stories.length, "stories");

// Process results
const top5 = stories.slice(0, 5);
console.log("Top 5:", JSON.stringify(top5, null, 2));
```

### Login Flow

```tsx
import { openPanel } from "@workspace/runtime";

const browser = await openPanel("https://example.com/login");
const page = await browser.cdp.page();

await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Password").fill("secret");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector(".dashboard");
console.log("Logged in, now at:", await page.evaluate(() => location.href));

// Still logged in — same page, same session
const dashboardData = await page.evaluate(() => document.querySelector(".stats")?.textContent);
console.log("Dashboard:", dashboardData);
```

### Combined: Import Cookies + Authenticate

```tsx
import { openPanel } from "@workspace/runtime";
import { browserData } from "@workspace/runtime";

// Step 1: Import cookies from an opaque Chrome source on a trusted host.
const hosts = await browserData.listImportHosts();
const host = hosts.find((candidate) => candidate.connected);
if (host) {
  const sources = await browserData.listImportSources(host.hostId);
  const chrome = sources.find((source) => source.browser === "chrome");
  if (!chrome) throw new Error("Chrome is not available on the selected host");
  await browserData.startImport({
    hostId: host.hostId,
    sourceId: chrome.sourceId,
    dataTypes: ["cookies"],
  });
  console.log("Cookies imported into the canonical browser environment");
}

// Re-running startImport for the same host/source is deterministic.

// Step 2: Open browser — now has imported cookies
const browser = await openPanel("https://github.com");
const page = await browser.cdp.page();

const title = await page.title();
console.log("Page title:", title);

// Check if logged in
const isLoggedIn = await page.evaluate(() => document.querySelector("img.avatar") !== null);
console.log(isLoggedIn ? "Logged in!" : "Not logged in");
```

### Inline UI: Browser Control Panel

> **Defensive coding:** This example uses `props.startUrl`. Always default: `const startUrl = props?.startUrl ?? "https://example.com"` to handle cases where the caller omits the prop.

```
inline_ui({
  code: `
import { useState, useRef } from "react";
import { Button, Flex, Text, TextField, Box, Badge } from "@radix-ui/themes";
import { openPanel } from "@workspace/runtime";

export default function BrowserController({ props, chat }) {
  const [url, setUrl] = useState(props.startUrl || "https://example.com");
  const [status, setStatus] = useState("disconnected");
  const [pageTitle, setPageTitle] = useState("");
  const handleRef = useRef(null);
  const pageRef = useRef(null);

  const handleConnect = async () => {
    setStatus("connecting...");
    const handle = await openPanel(url);
    handleRef.current = handle;
    const page = await handle.cdp.page();
    pageRef.current = page;
    setStatus("connected");
    setPageTitle(await page.title());
  };

  const handleNavigate = async () => {
    if (!pageRef.current) return;
    await pageRef.current.goto(url);
    setPageTitle(await pageRef.current.title());
  };

  const handleScrape = async () => {
    if (!pageRef.current) return;
    const text = await pageRef.current.evaluate(() => document.body.innerText);
    await chat.send("Page text (" + text.length + " chars):\\n" + text.slice(0, 500));
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root value={url} onChange={e => setUrl(e.target.value)} style={{ flex: 1 }} />
        {status === "disconnected"
          ? <Button size="1" onClick={handleConnect}>Open</Button>
          : <Button size="1" onClick={handleNavigate}>Go</Button>}
        <Button size="1" variant="soft" onClick={handleScrape} disabled={!pageRef.current}>Scrape</Button>
      </Flex>
      <Flex gap="2" align="center">
        <Badge color={status === "connected" ? "green" : "gray"}>{status}</Badge>
        {pageTitle && <Text size="1" color="gray">{pageTitle}</Text>}
      </Flex>
    </Flex>
  );
}`,
  props: { startUrl: "https://example.com" }
})
```

## Tips

- **Acquire or create one handle and reuse it** — `openPanel`/`panelTree`/`getPanelHandle` work from server-side eval, panels, workers, and DOs; once you hold the handle, `handle.cdp.page()` drives the browser page.
- **Hold a handle/page in component state and reuse it within one runtime incarnation** — re-open only for a new target. After `handle.navigate()` or `handle.rebuild()`, keep the handle but replace the page with one fresh `await handle.cdp.page()`.
- **Prefer locators with auto-wait** — `page.getByRole(...)` / `page.locator(...)` wait for the element automatically; reach for `page.evaluate()` for complex DOM queries that need full DOM API access.
- **For SPAs, wait for application state** — after `page.goto(url)`, use
  `page.waitForFunction(...)` or a stable locator that represents the loaded
  application. The CDP page does not claim full-Playwright
  `waitUntil: "networkidle"` semantics.
- **Use `page.waitForSelector()` or `locator.waitFor()` before interacting** — ensures elements exist before clicking/filling.
- **Wait on the page condition you need** — prefer explicit page state checks over wall-clock limits.
- **Imported cookies are auto-synced** — if you imported browser data via the browser-import skill, browser panels will have those cookies available automatically.
- **Connection lifetime follows the runtime incarnation** — browser
  `page.goto()` navigation keeps the same page connection. Workspace-panel
  `handle.navigate()` and `handle.rebuild()` replace the runtime, so keep the
  handle and obtain a fresh page without opening a duplicate panel. If another
  lifecycle operation returns a different `runtimeEntityId`, treat it the same
  way.
