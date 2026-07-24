# CDP Panel Automation

CDP automation is available on any panel-tree target through `PanelHandle`.
Use top-level `panelTree` for existing panels; `workspace.panelTree` is not part
of the runtime surface. For web browsing or website automation, open or reuse a
dedicated browser panel. Existing workspace panels, especially chat panels, are
application surfaces: inspect them when that app is the target, but do not use
them as disposable web pages.

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.page();

await page.goto("https://example.com");
await page.getByRole("button", { name: "Sign in" }).click();
await page.locator("input[name=query]").fill("Vibestudio");
await page.locator(".search-button").click();
await handle.click(".search-button"); // same target, convenience wrapper

// Browser panels only: these intentionally reject for workspace app panels.
await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

await openExternal("https://docs.example.com");
```

`handle.cdp.page()` returns the canonical Playwright-style page driven by our
workerd-native CDP client (`@workspace/cdp-client`). It is the single
browser-automation surface; there is no second browser client or compatibility
tier to choose. Do not import or install any `playwright*` package;
load the page through `handle.cdp.page()` and do not import `@workspace/cdp-client`
directly for ordinary page work.

Navigation belongs to browser panels. On a workspace app panel, `page.goto()`,
`page.reload()`, `page.goBack()`, `page.goForward()`, and their `handle.cdp`
counterparts reject instead of bypassing the panel lifecycle. Use
`await handle.reload()` for the current workspace build or
`await handle.rebuild()` after source changes; both return a
`PanelObservation`, while the original `handle` remains the handle.

## Ownership and lifetime contract

`PanelHandle` owns the target; `CdpPage` owns one automation connection to that
target. The boundary is exact:

- `await handle.cdp.page()` creates one authenticated CDP connection to the
  handle's current panel target.
- `await page.close()` disconnects only that automation client. It does not
  close, unload, navigate, or otherwise mutate the panel.
- Eval is a notebook kernel, not an invocation sandbox. A page stored in
  `scope` remains the same live object across cells for 30 minutes after the
  latest cell. Every cell renews that idle lease. Call `page.close()` explicitly
  when finished.
- Durable scope persistence is a recovery snapshot, not the live heap. A page
  or other class instance cannot be reconstructed after kernel restart; retain
  stable identity alongside it and reacquire only after `[kernel] Restarted`
  reports that exact live value as lost.
- `await handle.close()` closes an owned panel and therefore invalidates page
  clients connected to that target.
- A handle obtained from `panelTree` is non-owned unless the current workflow
  created it. Disconnecting your `page` is safe; closing the handle is not.
- Browser `page.goto()` navigation keeps the same CDP target and page
  connection. Workspace-panel `handle.navigate()` and `handle.rebuild()`
  replace the runtime incarnation: the old page reports the replacement close
  reason, and callers must acquire one fresh `await handle.cdp.page()` from the
  same handle. More generally, if a lifecycle result has a different
  `runtimeEntityId`, replace the page.

Use `panelTree.list/roots/children/get` for existing panels. Existing handles
are non-owned: do not call `handle.navigate`, `handle.reload`, or
`handle.close` on them unless requested. Do not call `handle.cdp.navigate(url)`
or `page.goto(url)` on the current chat panel, a parent chat panel, or another
workspace panel unless the requested task is to replace that exact panel. Open a
browser panel for arbitrary URLs, login flows, scraping, and browser navigation.

```ts
// Later, when an owned temporary panel is no longer needed:
await scope.page?.close();
await scope.browser?.close();
delete scope.browser;
delete scope.page;
```

Reuse one handle per workflow and one CDP page per runtime incarnation.
Repeated `openPanel()` calls create duplicate panels, and repeated
`handle.cdp.page()` calls within an unchanged incarnation create duplicate CDP
connections. After an incarnation replacement, reacquiring through the same
handle is required; there is no second page-acquisition API.

## Where it runs

The CDP client is workerd-native: it works in panels **and** in
worker/DO/server-side-eval contexts. It runs over a WebSocket to the panel's CDP
endpoint, so any context that holds a panel handle can drive the page —
including server-side `eval`. `openPanel`/`panelTree`/`getPanelHandle` are part
of the portable runtime surface from `@workspace/runtime`, so server-side eval
can create or acquire a panel handle directly before driving CDP automation.

## Page surface

`handle.cdp.page()` returns the canonical Playwright-style page. Actions
auto-wait for the element to be visible/stable/enabled before acting and
resolve after their browser event turn, so a following action observes
framework state committed by the previous one. Do not add sleeps between
`fill()`, `press()`, `click()`, or other sequential actions.

```ts
const page = await handle.cdp.page();

// Discover the live accessibility contract before choosing named locators.
const buttons = await page.getByRole("button").all();
const buttonSemantics = await Promise.all(buttons.map((button) => button.inspect()));
// Records include role, accessibleName, text, attributes, visibility, box,
// and nearest rendered ancestors (with their roles, names, and text).

// Locators
page.locator("css selector");
page.locator('text="Exact text"'); // compiled to the getByText semantic engine
page.locator("text=substring"); // compiled to non-exact getByText semantics
page.getByRole("button", { name: "Sign in", exact: true });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");

// Chaining
page.getByRole("listitem").filter({ hasText: "active" }).nth(2);
page.locator(".row").first();
page.locator(".row").last();
const rows = await page.locator(".row").all();

// Actions (auto-wait)
await page.getByRole("button", { name: "Save" }).click();
await page.locator(".item").dblclick();
await page.locator(".item").hover();
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Email").type("user@example.com");
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

// Reads / state
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
await page
  .locator(".row")
  .first()
  .evaluate((row) => row.textContent?.trim());
await page.locator(".row").evaluateAll((rows) => rows.map((row) => row.textContent?.trim()));
await page.locator(".box").boundingBox();
await page.locator(".box").inspect();
```

Accessible names are computed from the live DOM. Descendant text such as a
numeric badge is part of a button's name, so a visually grouped `Done` + `3`
button may be named `"Done 3"`. Discover the names first, then use the exact
string or a deliberate regular expression such as `/^Done\b/`. When a named
role locator misses, `CdpError` reports the available names for that role.
If the accessible name exists under another role, the error reports those
role/name pairs as well; use the rendered role rather than guessing from text.

Controls repeated for collection items must have item-specific accessible
names. Treat repeated `"Mark task as completed"` buttons as an accessibility
defect and repair the app to expose names such as
`"Complete Write release notes"` before testing the interaction. Do not guess
item identity with `.first()`, `.last()`, or `.nth()`. If an external page
cannot be repaired, call `all()` and `inspect()` first; each inspection includes
nearest-ancestor context so an ordinal can be chosen from rendered evidence.

`locator()` accepts CSS plus the standard `text=` selector form. It does not
forward `text=` to `querySelectorAll`: quoted JSON strings mean exact text and
unquoted values mean substring text, both compiled into the same canonical
descriptor used by `getByText`. Prefer the explicit `getBy*` form in authored
code; the selector form is useful when translating an existing Playwright
interaction.

Page-level methods (navigation methods are browser-panel-only):

```ts
await page.goto("https://example.com");
await page.reload();
await page.goBack();
await page.goForward();
await page.title();
page.url(); // string, synchronous like Playwright
await page.content(); // full HTML
await page.evaluate(() => document.title);
const bytes = await page.screenshot({ fullPage: true });
await page.waitForSelector(".ready");
await page.waitForLoadState("domcontentloaded"); // or "load"
await page.waitForFunction(() => document.readyState === "complete");
const events = page.consoleEvents(); // live console capture after connect
await page.close(); // disconnect automation only; the panel remains open

// CSS locator forms
await page.locator("button.submit").click();
await page.locator('input[name="email"]').fill("user@example.com");
```

`page.screenshot()` returns `Uint8Array` and has no filesystem `path` option.
Persist it explicitly with `blobstore.putBytes(bytes)`. Unsupported options are
rejected rather than ignored.

Page callbacks are intentionally moved into the browser realm. Functions passed
to `page.evaluate`, `page.waitForFunction`, `locator.evaluate`, and
`locator.evaluateAll` must be self-contained apart from their explicit
argument. Exceptions preserve the
browser's actual exception description and stack; locator failures also include
the Playwright-style locator string. A generic `Uncaught` without the underlying
exception is a platform defect, not a prompt for the agent to guess.

### Not supported

The CDP client deliberately omits a few Playwright features. These
are out of scope: file uploads (`setInputFiles`), multiple pages/popups,
cross-origin frames, and full network request interception (`route`). For
protocol-level needs beyond the page surface, use raw `CdpConnection.send` (see
below).

## Protocol-level work

For raw CDP, open a connection to the panel's CDP endpoint and drive the
protocol directly:

```ts
import { CdpConnection } from "@workspace/cdp-client";

const endpoint = await handle.cdp.getCdpEndpoint(); // { wsEndpoint, token }
const c = await CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);

await c.send("Page.navigate", { url: "https://example.com" });
c.on("Page.loadEventFired", () => console.log("loaded"));
```

Use `c.send(method, params)` to issue CDP commands and `c.on(event, cb)` to
subscribe to CDP events. This is the escape hatch for anything the page surface
does not cover (network interception, file inputs, multi-target work).

## Console diagnostics

Use historical console diagnostics for post-mortem panel debugging. CDP live
console events start only after a CDP client connects; they cannot recover
earlier errors. The host captures panel console messages from `webContents` as
soon as the target is registered:

```ts
const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 });
console.log(history.errors);
console.log(history.dropped); // overflow is explicit
```

`history.entries` is the recent general log buffer. `history.errors` is a
separate error-only buffer so high-value errors survive noisy normal logging.
Entries include `timestamp`, `level`, `message`, `line`, `sourceId`, and `url`.
For a single panel-debugging call, use `await handle.diagnose()`. The packet
includes the canonical attempt/phase/failure, host-captured console and
lifecycle history, and a provenance-bearing document when ready.

Use the server host log stream for failures outside the renderer, such as panel
broker errors, build/reload scheduling, workerd supervision, reconnects, and
startup/shutdown. Query `services.serverLog.query(...)` from eval or open
`about/server-logs` to follow live; the full contract is in
`../server-logs/SKILL.md`.

Use the page object returned by `handle.cdp.page()` for automation:

```ts
const page = await handle.cdp.page();
console.log(page.url(), await page.title());
await page.locator("button.submit").click();
await page.locator(".status").innerText();
await page.waitForSelector(".ready");
await page.waitForLoadState("load");
```

`page.url()` is a synchronous Playwright-style accessor. Do not `await` it or
attach `.then()` / `.catch()`; use `await page.evaluate(() => location.href)`
only when the URL must be computed inside the page after client-side routing.

`handle.reload()` is panel lifecycle reload for the named workspace panel's
renderer; it does not rebuild code and does not unload the panel's runtime
lease. `page.reload()` and `handle.cdp.reload()` are raw Chromium navigation and
are available only for browser panel targets. Reloading the panel currently
executing eval can cancel that eval after the command is sent; run that reload
from a stable/root context when possible.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
if (parent) await parent.cdp.page();

const sibling = panelTree.get("sibling-panel-id");
await sibling.cdp.navigate("https://example.com/status");
```

Readiness-bearing operations establish a live, booted target. For a discovered
panel, call `observe()` and require `phase === "ready"` before custom RPC or
`_agent` inspection. Use `diagnose()` when it is failed or stalled.

## Methods

| Method                                             | Description                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `handle.cdp.page()`                                | Connect the canonical CDP client and return the Playwright-style page             |
| `handle.cdp.getCdpEndpoint()`                      | Get `{ wsEndpoint, token }` for raw `CdpConnection.connect`                       |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer          |
| `handle.diagnose()`                                | Read canonical observation, bounded console/lifecycle history, and ready document |
| `handle.click(selector)`                           | Click in the target panel through CDP                                             |
| `handle.cdp.navigate(url)`                         | Load a URL in a browser panel; rejects for workspace panels                       |
| `handle.cdp.goBack()` / `goForward()`              | Browser-panel Chromium history                                                    |
| `handle.cdp.reload()`                              | Browser-panel Chromium page reload                                                |
| `handle.cdp.stop()`                                | Stop loading                                                                      |
| `handle.close()`                                   | Close the panel                                                                   |

Opening panels, CDP, and structural operations prompt on first use per requester
entity and target panel/root. Privileged shell/about targets use a severe
danger-tone prompt. The remembered grant does not survive requester navigation.
Panels currently held by mobile/non-CDP hosts reject CDP access instead of being
silently taken over.

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.
