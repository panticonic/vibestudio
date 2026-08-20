/**
 * Helpers for driving the command overlay (the "quickfire" content-overlay
 * surface) from an e2e run.
 *
 * The overlay lives in its own `WebContentsView`, so Playwright's page object
 * cannot see it: everything here goes through `app.evaluate` and picks the right
 * web contents by the preload bridge it exposes, the same way
 * `contentOverlay.spec.ts` finds the approval card.
 *
 * Why this exists at all: every command-overlay defect found so far — the
 * accelerator being swallowed by panel key forwarding, an ownerless agent vessel
 * failing activation with a 403, and resource-bound subscription failures —
 * was invisible to unit tests because each one lives in the seam between the
 * main process, the server, and a userland worker. Only a real app run crosses
 * all three.
 */
import { expect } from "@playwright/test";

import type { TestApp } from "../../setup/electronSetup";
import { retryIdempotentAutomationRead } from "../../setup/automationContext";
import { clickWindowPointThroughNativeInput } from "../../setup/nativeInput";

export interface CommandOverlaySnapshot {
  /** The palette card is mounted in the overlay document. */
  open: boolean;
  /** Scope chip currently active: "All" | "Commands" | "Go to" | "Quickfire agent". */
  activeMode: string | null;
  /** Row titles in display order — the Enter target is the first one. */
  rows: string[];
  /** True when the conversation view (transcript + compose) is showing. */
  conversation: boolean;
  /**
   * Text of the rendered transcript messages ONLY.
   *
   * Separate from `text` on purpose: a suggestion row echoes the query back
   * ("Send \u201c…\u201d to the agent"), so asserting the typed prose against the
   * whole surface passes the instant you type it and proves nothing about the
   * conversation. A message here has been through the channel.
   */
  transcript: string[];
  /** Whole-surface text, so a test can assert on an error banner verbatim. */
  text: string;
}

/** Wait for the hosted shell chrome, approving the bootstrap launch gate if shown. */
export async function waitHostedShellReady(testApp: TestApp): Promise<void> {
  await expect
    .poll(
      async () =>
        testApp.app.evaluate(async ({ webContents }) => {
          const candidates = webContents.getAllWebContents().filter((contents) => {
            if (contents.isDestroyed()) return false;
            const title = contents.getTitle();
            return title === "@workspace-apps/shell" || title === "Vibestudio Launch";
          });
          for (const contents of candidates) {
            try {
              const result = await Promise.race([
                contents.executeJavaScript(
                  `(() => {
                    if (document.querySelector(".titlebar-breadcrumb-scroll")
                      || document.querySelector('[aria-label="Menu"]')) return "ready";
                    const approve = Array.from(document.querySelectorAll("button"))
                      .find((b) => /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start)$/.test((b.textContent ?? "").trim()));
                    if (approve) { approve.click(); return "approved"; }
                    return "waiting";
                  })()`,
                  true
                ),
                new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 2_000)),
              ]);
              if (result === "ready") return true;
            } catch {
              // Non-DOM webContents.
            }
          }
          return false;
        }),
      // A cold workspace builds every unit before the chrome is usable, and on a
      // loaded machine single units have taken 50-95s each. The budget is for
      // that startup, not for anything this spec asserts.
      { timeout: 300_000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

/**
 * Press a chord on the web contents that currently holds focus.
 *
 * This is the point of the exercise: the regression that shipped was the shell
 * forwarding its keystrokes into the focused panel, so a synthetic event sent to
 * the *shell* would have passed while the real app did nothing. Sending to the
 * focused contents reproduces what the user's fingers do.
 */
export async function pressChordOnFocusedContents(
  testApp: TestApp,
  key: string,
  modifiers: string[] = []
): Promise<boolean> {
  return testApp.app.evaluate(
    async ({ webContents }, chord) => {
      const focused = webContents.getFocusedWebContents();
      const target =
        focused ??
        webContents
          .getAllWebContents()
          .find((c) => !c.isDestroyed() && c.getTitle() === "@workspace-apps/shell");
      if (!target || target.isDestroyed()) return false;
      target.sendInputEvent({
        type: "keyDown",
        keyCode: chord.key,
        modifiers: chord.modifiers as Electron.KeyboardInputEvent["modifiers"],
      });
      target.sendInputEvent({
        type: "keyUp",
        keyCode: chord.key,
        modifiers: chord.modifiers as Electron.KeyboardInputEvent["modifiers"],
      });
      return true;
    },
    { key, modifiers }
  );
}

/**
 * Press the hosted shell outside the overlay's sibling WebContentsView. The
 * main process must translate this native-view boundary into a dismiss intent;
 * no DOM backdrop can observe the press.
 */
export async function clickOutsideCommandOverlay(testApp: TestApp): Promise<boolean> {
  await clickWindowPointThroughNativeInput(testApp.app, { x: 8, y: 80 });
  return true;
}

/**
 * The overlay's web contents id, remembered across probes.
 *
 * Rediscovery walks every web contents and evaluates a script in each, which is
 * cheap when the workspace is idle and ruinous while it is compiling: a panel
 * view mid-build can stall `executeJavaScript` long enough to blow the whole
 * read budget. Finding the surface once and talking only to it keeps polling
 * affordable during exactly the cold-start window this spec has to survive.
 */
let overlayContentsId: number | null = null;

/** Read the overlay surface, or null when no overlay document is loaded. */
export async function probeCommandOverlay(
  testApp: TestApp
): Promise<CommandOverlaySnapshot | null> {
  const read = (contentsId: number | null) =>
    testApp.app.evaluate(async ({ webContents }, knownId) => {
      const SNAPSHOT = `(() => {
        if (!globalThis.__vibestudioContentOverlay) return null;
        const card = document.querySelector(".quickfire-card");
        if (!card) return { open: false, activeMode: null, rows: [], conversation: false, transcript: [], text: "" };
        const active = card.querySelector(".quickfire-mode[aria-pressed='true']");
        return {
          open: true,
          activeMode: active ? active.textContent.trim() : null,
          rows: Array.from(card.querySelectorAll("[data-row-id]")).map((row) => row.textContent.trim()),
          conversation: card.getAttribute("data-mode") === "conversation",
          transcript: Array.from(card.querySelectorAll(
            '[data-testid="quickfire-transcript"] [data-testid^="quickfire-card-"]'
          ))
            .map((message) => message.textContent.trim()),
          text: card.textContent ?? "",
        };
      })()`;
      const evaluate = async (contents: Electron.WebContents) =>
        Promise.race([
          contents.executeJavaScript(SNAPSHOT, true),
          // A busy renderer must not hold the whole probe hostage.
          new Promise((resolve) => setTimeout(() => resolve(undefined), 2_000)),
        ]);

      if (knownId !== null) {
        const known = webContents.fromId(knownId);
        if (known && !known.isDestroyed()) {
          try {
            const snapshot = await evaluate(known);
            if (snapshot) return { id: knownId, snapshot };
          } catch {
            // Fall through to rediscovery.
          }
        }
      }
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          const isOverlay = await Promise.race([
            contents.executeJavaScript(`!!globalThis.__vibestudioContentOverlay`, true),
            new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
          ]);
          if (!isOverlay) continue;
          const snapshot = await evaluate(contents);
          // The approval-card surface answers the bridge check too; only the
          // document holding a quickfire card is the one this spec drives.
          if (snapshot && (snapshot as CommandOverlaySnapshot).open) {
            return { id: contents.id, snapshot };
          }
        } catch {
          // Try the next web contents.
        }
      }
      return null;
    }, contentsId);

  const result = (await retryIdempotentAutomationRead(() => read(overlayContentsId), {
    label: "probing the command overlay",
    timeoutMs: 30_000,
  })) as { id: number; snapshot: CommandOverlaySnapshot } | null;
  if (!result) return null;
  overlayContentsId = result.id;
  return result.snapshot;
}

/**
 * Run one script in the overlay document, never in anything else.
 *
 * Every call here is bounded twice: each `executeJavaScript` races a short
 * timer, and discovery only runs when the cached web-contents id is stale.
 * Without that, a helper that walks every web contents blocks on the first
 * renderer busy compiling a unit — which is how "resume into the conversation"
 * spent 420s hanging instead of failing an assertion. A hang is not a result.
 */
async function evaluateInOverlayDocument<T>(
  testApp: TestApp,
  script: string,
  timeoutMs = 5_000
): Promise<{ id: number; value: T } | null> {
  const result = (await testApp.app.evaluate(
    async ({ webContents }, request) => {
      const run = async (contents: Electron.WebContents) =>
        Promise.race([
          contents.executeJavaScript(request.script, true),
          new Promise((resolve) => setTimeout(() => resolve(undefined), request.timeoutMs)),
        ]);
      if (request.knownId !== null) {
        const known = webContents.fromId(request.knownId);
        if (known && !known.isDestroyed()) {
          try {
            const value = await run(known);
            if (value !== undefined) return { id: request.knownId, value };
          } catch {
            // Fall through to rediscovery.
          }
        }
      }
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          const isOverlay = await Promise.race([
            contents.executeJavaScript(
              `!!(globalThis.__vibestudioContentOverlay && document.querySelector(".quickfire-card"))`,
              true
            ),
            new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
          ]);
          if (!isOverlay) continue;
          const value = await run(contents);
          if (value !== undefined) return { id: contents.id, value };
        } catch {
          // Try the next web contents.
        }
      }
      return null;
    },
    { script, timeoutMs, knownId: overlayContentsId }
  )) as { id: number; value: T } | null;
  if (result) overlayContentsId = result.id;
  return result;
}

/** Exercise the browser Clipboard API from the isolated overlay document. */
export async function writeClipboardInCommandOverlay(
  testApp: TestApp,
  value: string
): Promise<boolean> {
  const result = await evaluateInOverlayDocument<boolean>(
    testApp,
    `navigator.clipboard.writeText(${JSON.stringify(value)}).then(() => true, () => false)`
  );
  if (result?.value !== true) return false;
  return testApp.app.evaluate(
    ({ clipboard }, expected) => clipboard.readText() === expected,
    value
  );
}

/** Type into the overlay's input and dispatch the events the surface listens for. */
export async function typeIntoCommandOverlay(testApp: TestApp, value: string): Promise<boolean> {
  const result = await evaluateInOverlayDocument<boolean>(
    testApp,
    `(() => {
      const input = document.querySelector(".quickfire-input");
      if (!(input instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      if (!setter) return false;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`
  );
  return result?.value === true;
}

/** Press a key inside the overlay document, optionally after blurring the input. */
export async function pressInCommandOverlay(
  testApp: TestApp,
  key: string,
  options: { blurInput?: boolean } = {}
): Promise<boolean> {
  const target = options.blurInput === true ? "(input && input.blur(), card)" : "(input ?? card)";
  const result = await evaluateInOverlayDocument<boolean>(
    testApp,
    `(() => {
      const card = document.querySelector(".quickfire-card");
      if (!card) return false;
      const input = document.querySelector(".quickfire-input");
      const target = ${target};
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()`
  );
  return result?.value === true;
}

/** Click a named control in the overlay conversation header. */
export async function clickInCommandOverlay(testApp: TestApp, label: string): Promise<boolean> {
  const result = await evaluateInOverlayDocument<boolean>(
    testApp,
    `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(label)}));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`
  );
  return result?.value === true;
}

/** Whether a named overlay action is present and currently actionable. */
export async function isCommandOverlayButtonEnabled(
  testApp: TestApp,
  label: string
): Promise<boolean> {
  const result = await evaluateInOverlayDocument<boolean>(
    testApp,
    `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(label)}));
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`
  );
  return result?.value === true;
}

/**
 * Call a WORKSPACE service (server-side) from the test process.
 *
 * Not the app's `serviceCall` bridge: that dispatches to the MAIN-process
 * services (`view.*`, `panel.*`, …). `__testApi` targets the workspace server
 * and is only appropriate for actual host service schemas; Base-owned durable
 * services are exercised through their product clients.
 */
export async function callWorkspaceService(
  testApp: TestApp,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return testApp.app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: { rpcCall(s: string, m: string, a: unknown[]): Promise<unknown> };
        }
      ).__testApi;
      if (!testApi) return { ok: false, error: "Test API not available" };
      try {
        return {
          ok: true,
          value: await testApi.rpcCall(request.service, request.method, request.args),
        };
      } catch (error) {
        return { ok: false, error: String((error as { message?: string })?.message ?? error) };
      }
    },
    { service, method, args }
  );
}

/**
 * Buffer the hosted shell's renderer console into the main process.
 *
 * The chrome holds the conversation's channel client, and a subscription that
 * fails or retries logs there — nowhere else. Neither the hub log (server side)
 * nor the overlay surface (a view with no RPC) can show it, which is why a
 * silent delivery failure has been diagnosable only by inference so far.
 */
export async function captureShellConsole(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const globals = globalThis as { __shellConsole?: string[]; __shellConsoleBound?: boolean };
    globals.__shellConsole ??= [];
    if (globals.__shellConsoleBound) return true;
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      if (contents.getTitle() !== "@workspace-apps/shell") continue;
      contents.on("console-message", (_event, level, message) => {
        globals.__shellConsole?.push(`[${level}] ${message}`);
      });
      globals.__shellConsoleBound = true;
      return true;
    }
    return false;
  });
}

/** Read (and keep) whatever the shell renderer has logged so far. */
export async function readShellConsole(testApp: TestApp): Promise<string[]> {
  return testApp.app.evaluate(async () => {
    return (globalThis as { __shellConsole?: string[] }).__shellConsole ?? [];
  });
}
