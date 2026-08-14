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
 * failing activation with a 403, `subscribeChannel` refusing the host origin —
 * was invisible to unit tests because each one lives in the seam between the
 * main process, the server, and a userland worker. Only a real app run crosses
 * all three.
 */
import { expect } from "@playwright/test";

import type { TestApp } from "../../setup/electronSetup";
import { retryIdempotentAutomationRead } from "../../setup/automationContext";

export interface CommandOverlaySnapshot {
  /** The palette card is mounted in the overlay document. */
  open: boolean;
  /** Scope chip currently active: "All" | "Commands" | "Go to" | "Command agent". */
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
          conversation: !!card.querySelector(".quickfire-compose"),
          transcript: Array.from(card.querySelectorAll(".quickfire-message-text"))
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

/** Type into the overlay's input and dispatch the events the surface listens for. */
export async function typeIntoCommandOverlay(testApp: TestApp, value: string): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }, text) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const typed = await contents.executeJavaScript(
          `(() => {
            const input = document.querySelector(".quickfire-input");
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "value").set;
            setter.call(input, ${JSON.stringify(text)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`,
          true
        );
        if (typed) return true;
      } catch {
        // Try the next webContents.
      }
    }
    return false;
  }, value);
}

/** Press a key inside the overlay document, optionally after blurring the input. */
export async function pressInCommandOverlay(
  testApp: TestApp,
  key: string,
  options: { blurInput?: boolean } = {}
): Promise<boolean> {
  return testApp.app.evaluate(
    async ({ webContents }, request) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          const pressed = await contents.executeJavaScript(
            `(() => {
              const card = document.querySelector(".quickfire-card");
              if (!card) return false;
              const input = document.querySelector(".quickfire-input");
              const target = ${request.blurInput ? "(input && input.blur(), card)" : "(input ?? card)"};
              target.dispatchEvent(new KeyboardEvent("keydown", {
                key: ${JSON.stringify(request.key)},
                bubbles: true,
                cancelable: true,
              }));
              return true;
            })()`,
            true
          );
          if (pressed) return true;
        } catch {
          // Try the next webContents.
        }
      }
      return false;
    },
    { key, blurInput: options.blurInput === true }
  );
}

/**
 * Call a WORKSPACE service (server-side) from the test process.
 *
 * Not the app's `serviceCall` bridge: that dispatches to the MAIN-process
 * services (`view.*`, `panel.*`, …), so asking it for `quickfire.list` fails
 * with "unknown service" and looks exactly like "there is no conversation" —
 * the same collapse of two meanings this helper exists to avoid. `__testApi`
 * targets the workspace server, which is where quickfire's durable rows live.
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
        globalThis as { __testApi?: { rpcCall(s: string, m: string, a: unknown[]): Promise<unknown> } }
      ).__testApi;
      if (!testApi) return { ok: false, error: "Test API not available" };
      try {
        return { ok: true, value: await testApi.rpcCall(request.service, request.method, request.args) };
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
