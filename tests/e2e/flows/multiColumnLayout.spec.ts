/**
 * Multi-column panel layout — native verification (plan §5.3/§5.4, workstream W6).
 *
 * Verifies in a real Electron run that the multi-column shell layout keeps the
 * native WebContentsView slots in lockstep with the DOM pane surfaces:
 *   1. Cmd/Ctrl-click on a tree row opens a second panel beside the first
 *      (two simultaneous surfaces, distinct native slot ids).
 *   2. Divider drags settle with each native slot's bounds matching its DOM
 *      surface box within 1 px (measured through the main-process test API).
 *   3. Window shrink parks a column (edge tab, slot cleared); clicking the edge
 *      tab pages it back in and the slot rebinds with live content.
 *   4. Closing a pane via its header ✕ never archives the panel.
 *   5. Dividers respond to arrow keys; Ctrl/Cmd+Alt+arrows move the pane focus
 *      ring.
 *
 * The hosted shell renders in its own WebContentsView, so all DOM interaction
 * goes through executeJavaScript / sendInputEvent on that WebContents rather
 * than the Playwright window handle (same pattern as desktopShellChrome.spec).
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

import {
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  getNativePanelSlotDebugInfo,
  getPanelReadiness,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  approvePendingStartupUnits,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureInitialPanel(workspacePath: string, source: string): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [{ source }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

/** Find the hosted-shell WebContents (the one rendering pane surfaces / tree). */
async function findShellWebContentsId(app: ElectronApplication): Promise<number> {
  const id = await app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const isShell = (await contents.executeJavaScript(
          `Boolean(document.querySelector('[data-pane-id]') && document.querySelector('[data-panel-tree-row]'))`,
          true
        )) as boolean;
        if (isShell) return contents.id;
      } catch {
        // Non-DOM webContents.
      }
    }
    return -1;
  });
  if (id < 0) throw new Error("Hosted shell WebContents not found");
  return id;
}

async function shellEval<T>(app: ElectronApplication, wcId: number, script: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.wcId);
      if (!contents || contents.isDestroyed()) throw new Error("Shell WebContents gone");
      return (await contents.executeJavaScript(args.script, true)) as unknown;
    },
    { wcId, script }
  ) as Promise<T>;
}

type ShellRect = { x: number; y: number; width: number; height: number };

/** DOM boxes of every mounted pane surface, keyed by native slot id. */
async function getSurfaceRects(
  app: ElectronApplication,
  wcId: number
): Promise<Array<{ nativeSlotId: string; panelId: string; paneId: string; rect: ShellRect }>> {
  return shellEval(
    app,
    wcId,
    `Array.from(document.querySelectorAll('[data-native-panel-slot-id]')).map((node) => {
       const rect = node.getBoundingClientRect();
       return {
         nativeSlotId: node.getAttribute('data-native-panel-slot-id'),
         panelId: node.getAttribute('data-panel-id'),
         paneId: node.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
         rect: {
           x: Math.round(rect.left),
           y: Math.round(rect.top),
           width: Math.round(rect.width),
           height: Math.round(rect.height),
         },
       };
     })`
  );
}

/**
 * True when every bound native slot's main-process bounds match its DOM surface
 * box within `tolerance` px on every edge — the §5.4 lockstep assertion.
 */
async function surfacesMatchNativeBounds(
  app: ElectronApplication,
  wcId: number,
  tolerance = 1
): Promise<boolean> {
  const [slots, surfaces] = await Promise.all([
    getNativePanelSlotDebugInfo(app),
    getSurfaceRects(app, wcId),
  ]);
  if (slots.length === 0 || slots.length !== surfaces.length) return false;
  return slots.every((slot) => {
    const surface = surfaces.find((candidate) => candidate.nativeSlotId === slot.nativeSlotId);
    if (!surface || surface.panelId !== slot.panelId) return false;
    return (
      Math.abs(slot.bounds.x - surface.rect.x) <= tolerance &&
      Math.abs(slot.bounds.y - surface.rect.y) <= tolerance &&
      Math.abs(slot.bounds.width - surface.rect.width) <= tolerance &&
      Math.abs(slot.bounds.height - surface.rect.height) <= tolerance
    );
  });
}

async function shellErrorOverlayCount(app: ElectronApplication, wcId: number): Promise<number> {
  return shellEval<number>(
    app,
    wcId,
    `document.querySelectorAll('[role="alert"]').length +
       ((document.body?.innerText ?? '').includes('A Vibestudio operation failed') ? 1 : 0)`
  );
}

/** Ctrl-click (open-beside) or plain-click a panel's tree row by its current title. */
async function clickTreeRowForPanel(
  app: ElectronApplication,
  wcId: number,
  title: string,
  modifiers: { ctrlKey?: boolean } = {}
): Promise<boolean> {
  return shellEval<boolean>(
    app,
    wcId,
    `(() => {
       const rows = Array.from(document.querySelectorAll('[data-panel-tree-row="true"]'));
       const row = rows.find((node) =>
         (node.getAttribute('aria-label') ?? '') === ${JSON.stringify(`Select panel ${title}`)});
       if (!row) return false;
       row.dispatchEvent(new MouseEvent('click', {
         bubbles: true,
         cancelable: true,
         ctrlKey: ${modifiers.ctrlKey === true},
       }));
       return true;
     })()`
  );
}

async function setWindowSize(
  app: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  // The shell window is a BaseWindow (WebContentsView architecture), not a
  // BrowserWindow.
  await app.evaluate(
    ({ BaseWindow, BrowserWindow }, size) => {
      const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("Main window not found");
      win.setResizable(true);
      const bounds = win.getBounds();
      win.setBounds({ ...bounds, width: size.width, height: size.height });
    },
    { width, height }
  );
}

async function sendShellMouseDrag(
  app: ElectronApplication,
  wcId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.wcId);
      if (!contents || contents.isDestroyed()) throw new Error("Shell WebContents gone");
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      contents.focus();
      contents.sendInputEvent({
        type: "mouseDown",
        x: args.from.x,
        y: args.from.y,
        button: "left",
        clickCount: 1,
      });
      await sleep(30);
      for (let step = 1; step <= args.steps; step++) {
        const x = Math.round(args.from.x + ((args.to.x - args.from.x) * step) / args.steps);
        const y = Math.round(args.from.y + ((args.to.y - args.from.y) * step) / args.steps);
        contents.sendInputEvent({ type: "mouseMove", x, y, button: "left", buttons: 1 });
        await sleep(16);
      }
      contents.sendInputEvent({
        type: "mouseUp",
        x: args.to.x,
        y: args.to.y,
        button: "left",
        clickCount: 1,
      });
      await sleep(30);
    },
    { wcId, from, to, steps }
  );
}

const POLL = { timeout: 60_000, intervals: [250, 500, 1_000] };

test.describe("Multi-column panel layout", () => {
  test("native slots track panes across open-beside, drags, parking, close, and keyboard", async () => {
    test.setTimeout(600_000);
    const workspacePath = createManagedTestWorkspace();
    configureInitialPanel(workspacePath, "about/about");
    let testApp: TestApp | null = null;
    try {
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 240_000,
      });
      await approvePendingStartupUnits(testApp.app);
      const app = testApp.app;

      // The server RPC bridge connects only once the workspace runtime is
      // ready, and a fresh managed workspace cold-builds its extensions first —
      // that takes minutes. Worse, app bootstrap hard-requires the
      // browser-data extension; on the first boot it cannot be running yet, so
      // startup lands in the recovery window while the hub keeps building.
      // Drive the app's own remedy: click "Retry startup" between attempts.
      const clickRetryStartup = () =>
        app
          .evaluate(async ({ webContents }) => {
            for (const contents of webContents.getAllWebContents()) {
              if (contents.isDestroyed()) continue;
              try {
                const clicked = (await contents.executeJavaScript(
                  `(() => {
                     const button = Array.from(document.querySelectorAll("button")).find(
                       (candidate) => candidate.textContent?.trim() === "Retry startup"
                     );
                     if (!button) return false;
                     button.click();
                     return true;
                   })()`,
                  true
                )) as boolean;
                if (clicked) return true;
              } catch {
                // Non-DOM webContents.
              }
            }
            return false;
          })
          .catch(() => false);
      let readiness = null as Awaited<ReturnType<typeof ensureHostedShellReady>> | null;
      for (let attempt = 0; readiness === null; attempt++) {
        try {
          readiness = await ensureHostedShellReady(app, { panelSource: "about/about" });
        } catch (error) {
          // "Extension is not installed" is equally transient on first boot:
          // the browser-data extension is still building/activating.
          if (
            attempt >= 60 ||
            !/Not connected to server|Extension is not installed/i.test(String(error))
          ) {
            throw error;
          }
          await clickRetryStartup();
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      const panel1 = readiness.panelId;

      // Wide window so two ≥420px columns fit beside the sidebar.
      await setWindowSize(app, 1600, 1000);

      let wcId = 0;
      await expect
        .poll(async () => {
          try {
            wcId = await findShellWebContentsId(app);
            return true;
          } catch {
            return false;
          }
        }, POLL)
        .toBe(true);

      // ---- Scenario 1: open a second panel beside the first --------------
      const created = await app.evaluate(
        async (_electron, args) => {
          const testApi = (
            globalThis as {
              __testApi?: {
                createPanel: (
                  parentId: string,
                  source: string,
                  options?: { focus?: boolean }
                ) => Promise<{ id: string; title: string }>;
              };
            }
          ).__testApi;
          if (!testApi) throw new Error("Test API not available");
          return testApi.createPanel(args.parentId, args.source, { focus: false });
        },
        { parentId: panel1, source: "about/adblock" }
      );
      const panel2 = created.id;

      await test.step("open second panel beside the first via Ctrl-click on its tree row", async () => {
        await expect
          .poll(async () => {
            const surfaces = await getSurfaceRects(app, wcId);
            if (surfaces.length >= 2) return true;
            // Retry the idempotent user action until the layout converges:
            // Ctrl-click the second panel's tree row (guarded on <2 panes so a
            // slow frame cannot open a third column).
            const tree = await getPanelTree(app);
            const title = tree.find((panel) => panel.id === panel2)?.title;
            if (title) {
              await clickTreeRowForPanel(app, wcId, title, { ctrlKey: true }).catch(() => false);
            }
            return false;
          }, POLL)
          .toBe(true);

        const surfaces = await getSurfaceRects(app, wcId);
        expect(surfaces).toHaveLength(2);
        const slotIds = surfaces.map((surface) => surface.nativeSlotId);
        expect(new Set(slotIds).size).toBe(2);
        for (const surface of surfaces) {
          expect(surface.nativeSlotId).toBe(`panel-stack:${surface.paneId}`);
        }
        expect(new Set(surfaces.map((surface) => surface.panelId))).toEqual(
          new Set([panel1, panel2])
        );
        // Both native slots bound, with distinct ids, in lockstep with the DOM.
        await expect.poll(() => surfacesMatchNativeBounds(app, wcId), POLL).toBe(true);
        const slots = await getNativePanelSlotDebugInfo(app);
        expect(slots).toHaveLength(2);
        expect(new Set(slots.map((slot) => slot.nativeSlotId)).size).toBe(2);
      });

      // ---- Scenario 2: divider drag keeps native bounds in lockstep ------
      await test.step("column divider drag settles with native bounds matching DOM within 1px", async () => {
        const before = await getSurfaceRects(app, wcId);
        const leftBefore = before.reduce((min, s) => Math.min(min, s.rect.width), Infinity);
        const separator = await shellEval<ShellRect | null>(
          app,
          wcId,
          `(() => {
             const node = document.querySelector('[role="separator"][aria-orientation="vertical"]');
             if (!node) return null;
             const rect = node.getBoundingClientRect();
             return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height };
           })()`
        );
        expect(separator).not.toBeNull();

        await sendShellMouseDrag(
          app,
          wcId,
          { x: separator!.x, y: separator!.y },
          { x: separator!.x + 160, y: separator!.y },
          10
        );

        // The drag commits on pointer-up; the §5.4 layout-epoch resync must
        // bring every native slot to the DOM box within one frame of settling.
        await expect
          .poll(async () => {
            const surfaces = await getSurfaceRects(app, wcId);
            const widths = surfaces.map((surface) => surface.rect.width);
            const changed = widths.some((width) => Math.abs(width - leftBefore) > 50);
            return changed && (await surfacesMatchNativeBounds(app, wcId));
          }, POLL)
          .toBe(true);
        expect(await shellErrorOverlayCount(app, wcId)).toBe(0);
      });

      // ---- Scenario 3: park via window shrink, un-park via edge tab ------
      await test.step("window shrink parks a column and clears its slot; edge tab rebinds it", async () => {
        await setWindowSize(app, 780, 900); // below SINGLE_COLUMN_BREAKPOINT (900)

        let parkedPanelId = "";
        await expect
          .poll(async () => {
            const [slots, hasEdgeTabs] = await Promise.all([
              getNativePanelSlotDebugInfo(app),
              shellEval<boolean>(app, wcId, `Boolean(document.querySelector('[data-edge-tabs]'))`),
            ]);
            if (!hasEdgeTabs || slots.length !== 1) return false;
            const residentPanelId = slots[0]!.panelId;
            parkedPanelId = residentPanelId === panel1 ? panel2 : panel1;
            return true;
          }, POLL)
          .toBe(true);

        // The parked column's slot must be cleared: not bound in the main process.
        const parkedReadinessBefore = await getPanelReadiness(app, parkedPanelId);
        expect(parkedReadinessBefore.nativeSlotBound).toBe(false);

        // Click the edge tab to page the parked column back in.
        expect(
          await shellEval<boolean>(
            app,
            wcId,
            `(() => {
               const tab = document.querySelector('[data-edge-tabs] [role="button"]');
               if (!tab) return false;
               tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
               return true;
             })()`
          )
        ).toBe(true);

        // The column returns, rebinds its slot, and the panel is live again —
        // no dead surface (§5.4: un-parking re-runs loading if GC unloaded it).
        await expect
          .poll(async () => {
            const slots = await getNativePanelSlotDebugInfo(app);
            if (slots.length !== 1 || slots[0]!.panelId !== parkedPanelId) return false;
            const parkedReadiness = await getPanelReadiness(app, parkedPanelId);
            return (
              parkedReadiness.nativeSlotBound &&
              parkedReadiness.terminal &&
              (await surfacesMatchNativeBounds(app, wcId))
            );
          }, POLL)
          .toBe(true);

        // Restore the wide window; both columns become resident again.
        await setWindowSize(app, 1600, 1000);
        await expect
          .poll(async () => {
            const slots = await getNativePanelSlotDebugInfo(app);
            return slots.length === 2 && (await surfacesMatchNativeBounds(app, wcId));
          }, POLL)
          .toBe(true);
      });

      // ---- Scenario 4: close-pane never archives ------------------------
      await test.step("closing a pane from its breadcrumb ✕ keeps the panel in the tree", async () => {
        const surfaces = await getSurfaceRects(app, wcId);
        const secondSurface = surfaces.find((surface) => surface.panelId === panel2);
        expect(secondSurface).toBeDefined();

        // Focus that pane first: the close-pane ✕ rides on the focused panel's
        // own breadcrumb item, and only while a second pane would survive it.
        expect(
          await shellEval<boolean>(
            app,
            wcId,
            `(() => {
               const frame = document.querySelector('[data-pane-id=${JSON.stringify(secondSurface!.paneId)}]');
               const handle = frame?.querySelector('[role="button"]');
               if (!(handle instanceof HTMLElement)) return false;
               handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
               return true;
             })()`
          )
        ).toBe(true);

        await expect
          .poll(
            async () =>
              await shellEval<boolean>(
                app,
                wcId,
                `(() => {
                   const item = document.querySelector('[data-breadcrumb-id=${JSON.stringify(panel2)}]');
                   const button = item?.querySelector('button[aria-label="Close pane"]');
                   if (!(button instanceof HTMLElement)) return false;
                   button.click();
                   return true;
                 })()`
              ),
            POLL
          )
          .toBe(true);

        await expect
          .poll(async () => (await getNativePanelSlotDebugInfo(app)).length, POLL)
          .toBe(1);
        // The panel is still in the tree — the ✕ is layout-only, never archive.
        const tree = await getPanelTree(app);
        expect(tree.some((panel) => panel.id === panel2)).toBe(true);
        expect(await shellErrorOverlayCount(app, wcId)).toBe(0);
      });

      // ---- Scenario 5: keyboard operation --------------------------------
      await test.step("dividers respond to arrow keys and Ctrl+Alt+arrows move the focus ring", async () => {
        // Re-open the second panel beside the first for a two-column layout.
        await expect
          .poll(async () => {
            const surfaces = await getSurfaceRects(app, wcId);
            if (surfaces.length >= 2) return true;
            const tree = await getPanelTree(app);
            const title = tree.find((panel) => panel.id === panel2)?.title;
            if (title) {
              await clickTreeRowForPanel(app, wcId, title, { ctrlKey: true }).catch(() => false);
            }
            return false;
          }, POLL)
          .toBe(true);
        await expect.poll(() => surfacesMatchNativeBounds(app, wcId), POLL).toBe(true);

        // Keyboard divider resize: ArrowRight on the focused separator commits
        // a step and the native bounds follow.
        const widthsBefore = (await getSurfaceRects(app, wcId)).map(
          (surface) => surface.rect.width
        );
        expect(
          await shellEval<boolean>(
            app,
            wcId,
            `(() => {
               const node = document.querySelector('[role="separator"][aria-orientation="vertical"]');
               if (!(node instanceof HTMLElement)) return false;
               node.focus();
               node.dispatchEvent(new KeyboardEvent('keydown', {
                 key: 'ArrowRight', bubbles: true, cancelable: true,
               }));
               return true;
             })()`
          )
        ).toBe(true);
        await expect
          .poll(async () => {
            const widths = (await getSurfaceRects(app, wcId)).map((surface) => surface.rect.width);
            const changed = widths.some(
              (width, index) => Math.abs(width - (widthsBefore[index] ?? width)) >= 10
            );
            return changed && (await surfacesMatchNativeBounds(app, wcId));
          }, POLL)
          .toBe(true);

        // Focus ring movement: Ctrl+Alt+ArrowRight/Left flips which slot is focused.
        const focusedSlotBefore = (await getNativePanelSlotDebugInfo(app)).find(
          (slot) => slot.focused
        );
        expect(focusedSlotBefore).toBeDefined();
        const moveFocus = (key: string) =>
          shellEval<boolean>(
            app,
            wcId,
            `(window.dispatchEvent(new KeyboardEvent('keydown', {
               key: ${JSON.stringify(key)}, ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
             })), true)`
          );
        // The just-opened column is focused and rightmost, so move LEFT first.
        await moveFocus("ArrowLeft");
        let focusedAfterFirstMove = "";
        await expect
          .poll(async () => {
            const focused = (await getNativePanelSlotDebugInfo(app)).find((slot) => slot.focused);
            if (!focused) return false;
            focusedAfterFirstMove = focused.nativeSlotId;
            return focused.nativeSlotId !== focusedSlotBefore!.nativeSlotId;
          }, POLL)
          .toBe(true);
        await moveFocus("ArrowRight");
        await expect
          .poll(async () => {
            const focused = (await getNativePanelSlotDebugInfo(app)).find((slot) => slot.focused);
            return Boolean(focused && focused.nativeSlotId !== focusedAfterFirstMove);
          }, POLL)
          .toBe(true);
      });

      expect(await shellErrorOverlayCount(app, wcId)).toBe(0);
    } finally {
      await testApp?.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
