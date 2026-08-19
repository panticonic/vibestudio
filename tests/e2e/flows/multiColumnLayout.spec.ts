/**
 * Multi-column panel layout — native verification (plan §5.3/§5.4, workstream W6).
 *
 * Verifies in a real Electron run that the multi-column shell layout keeps the
 * native WebContentsView slots in lockstep with the DOM pane surfaces:
 *   1. Normal focused child creation opens a second panel beside the first at
 *      the default 1200px desktop width (two simultaneous native surfaces).
 *   2. Divider drags settle with each native slot's bounds matching its DOM
 *      surface box within 1 px (measured through the main-process test API).
 *   3. Window shrink makes a column non-resident without rendering edge-tab
 *      slivers; selecting it from the tree rebinds its live content.
 *   4. Closing a pane via its header ✕ never archives the panel.
 *   5. Tree dragging exposes left/full/right placement and applies the chosen
 *      viewport presentation through real pointer input.
 *   6. Dividers respond to arrow keys; Ctrl/Cmd+Alt+arrows move the pane focus
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
  approvePendingWorkspaceCreationReview,
  approvePendingStartupUnits,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureInitialPanel(sourceRoot: string, source: string): void {
  const configPath = path.join(sourceRoot, "meta", "template.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [{ source }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

/** Find the hosted-shell WebContents (the one rendering pane surfaces / tree). */
async function findShellWebContentsId(app: ElectronApplication): Promise<number> {
  const id = await app.evaluate(async ({ webContents }) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          getHostViewDebugInfo(): { hostedShellUrl: string | null };
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const hostedShellUrl = testApi.getHostViewDebugInfo().hostedShellUrl;
    if (!hostedShellUrl) return -1;
    return (
      webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getURL() === hostedShellUrl)?.id ??
      -1
    );
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
/**
 * Click a tree row by panel *identity*. Rows are addressed by id, not by their
 * label: a freshly created panel's title lands in the tree asynchronously, so a
 * label lookup races that write and fails while the row is still showing its
 * slot id.
 */
async function clickTreeRowForPanel(
  app: ElectronApplication,
  wcId: number,
  panelId: string,
  modifiers: { ctrlKey?: boolean } = {}
): Promise<boolean> {
  return shellEval<boolean>(
    app,
    wcId,
    `(() => {
       const row = document.querySelector(
         '[data-panel-tree-row="true"][data-panel-id=${JSON.stringify(panelId)}]'
       );
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

/**
 * Drag a tree row onto a pane and drop it on one of that pane's five zones.
 *
 * The drop vocabulary is geometric now: the shell hit-tests the pointer against
 * the pane rectangles it is already showing, so the test aims at the same
 * pixels a user would and asserts the preview the user would see before
 * releasing.
 */
async function dragTreePanelToPane(
  app: ElectronApplication,
  wcId: number,
  panelId: string,
  targetPaneId: string,
  zone: "left" | "right" | "top" | "bottom" | "center"
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.wcId);
      if (!contents || contents.isDestroyed()) throw new Error("Shell WebContents gone");
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const rowCenter = (await contents.executeJavaScript(
        `(() => {
           const row = document.querySelector('[data-panel-tree-row="true"][data-panel-id=${JSON.stringify(args.panelId)}]');
           if (!row) return null;
           const rect = row.getBoundingClientRect();
           return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
         })()`,
        true
      )) as { x: number; y: number } | null;
      if (!rowCenter) throw new Error(`Tree row not found for panel ${args.panelId}`);

      const target = (await contents.executeJavaScript(
        `(() => {
           const pane = document.querySelector('[data-pane-id=${JSON.stringify(args.targetPaneId)}]');
           if (!pane) return null;
           const rect = pane.getBoundingClientRect();
           const inset = 10;
           const zone = ${JSON.stringify(args.zone)};
           const point = {
             left: { x: rect.left + inset, y: rect.top + rect.height / 2 },
             right: { x: rect.right - inset, y: rect.top + rect.height / 2 },
             top: { x: rect.left + rect.width / 2, y: rect.top + inset },
             bottom: { x: rect.left + rect.width / 2, y: rect.bottom - inset },
             center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
           }[zone];
           return { x: Math.round(point.x), y: Math.round(point.y) };
         })()`,
        true
      )) as { x: number; y: number } | null;
      if (!target) throw new Error(`Pane not found: ${args.targetPaneId}`);

      contents.focus();
      contents.sendInputEvent({
        type: "mouseDown",
        x: rowCenter.x,
        y: rowCenter.y,
        button: "left",
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: "mouseMove",
        x: rowCenter.x + 12,
        y: rowCenter.y,
        button: "left",
        buttons: 1,
      });

      for (let step = 1; step <= 10; step++) {
        contents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(rowCenter.x + ((target.x - rowCenter.x) * step) / 10),
          y: Math.round(rowCenter.y + ((target.y - rowCenter.y) * step) / 10),
          button: "left",
          buttons: 1,
        });
        await sleep(16);
      }

      // The blueprint replaces the panel views for the length of the gesture,
      // and its preview is the promise the drop has to keep.
      let preview: string | null = null;
      for (let attempt = 0; attempt < 30 && preview === null; attempt++) {
        await sleep(25);
        preview = (await contents.executeJavaScript(
          `(() => {
             if (!document.querySelector('[data-layout-blueprint="true"]')) return null;
             const node = document.querySelector('[data-layout-drop-preview]');
             return node ? node.getAttribute('data-layout-drop-preview') : null;
           })()`,
          true
        )) as string | null;
      }
      if (preview === null) throw new Error("Placement blueprint never resolved a drop target");

      contents.sendInputEvent({
        type: "mouseUp",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
      });
    },
    { wcId, panelId, targetPaneId, zone }
  );
}

const POLL = { timeout: 60_000, intervals: [250, 500, 1_000] };

test.describe("Multi-column panel layout", () => {
  test("native slots track panes across child creation, drags, parking, close, and keyboard", async () => {
    test.setTimeout(600_000);
    const workspacePath = await createManagedTestWorkspace({
      configureSource: (sourceRoot) => configureInitialPanel(sourceRoot, "about/about"),
    });
    let testApp: TestApp | null = null;
    try {
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 240_000,
      });
      await approvePendingStartupUnits(testApp.app);
      await approvePendingWorkspaceCreationReview(testApp.app);
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

      // Exercise the application's default desktop width. With the 232px tree,
      // the remaining viewport fits two 460px columns and their divider.
      await setWindowSize(app, 1200, 800);

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
          return testApi.createPanel(args.parentId, args.source, { focus: true });
        },
        { parentId: panel1, source: "about/adblock" }
      );
      const panel2 = created.id;

      await test.step("normal child creation opens beside its parent at the default width", async () => {
        try {
          await expect
            .poll(async () => {
              if ((await getSurfaceRects(app, wcId)).length !== 2) return false;
              // Residency changes intentionally clear native surfaces for a
              // 150ms transition. Require the two-pane state to survive that
              // handoff rather than accepting its initial pre-effect frame.
              await new Promise((resolve) => setTimeout(resolve, 200));
              return (
                (await getSurfaceRects(app, wcId)).length === 2 &&
                (await surfacesMatchNativeBounds(app, wcId))
              );
            }, POLL)
            .toBe(true);
        } catch (error) {
          const diagnostics = await Promise.all([
            getPanelTree(app),
            getSurfaceRects(app, wcId),
            getNativePanelSlotDebugInfo(app),
            shellEval(
              app,
              wcId,
              `({
                rows: Array.from(document.querySelectorAll('[data-panel-tree-row="true"]')).map(
                  (node) => ({
                    label: node.getAttribute('aria-label'),
                    text: node.textContent,
                  })
                ),
                panes: Array.from(document.querySelectorAll('[data-pane-id]')).map((node) => ({
                  paneId: node.getAttribute('data-pane-id'),
                  text: node.textContent,
                })),
              })`
            ),
            app.evaluate(async (_electron, panelId) => {
              const testApi = (
                globalThis as {
                  __testApi?: {
                    getPanel: (id: string) => unknown;
                    getPanelReadiness: (id: string) => Promise<unknown>;
                    getFocusedPanelId: () => string | null;
                  };
                }
              ).__testApi;
              return {
                panel: testApi?.getPanel(panelId) ?? null,
                readiness: testApi ? await testApi.getPanelReadiness(panelId) : null,
                focusedPanelId: testApi?.getFocusedPanelId() ?? null,
              };
            }, panel2),
          ]);
          await test.info().attach("multi-column-open-beside-diagnostics.json", {
            contentType: "application/json",
            body: Buffer.from(
              JSON.stringify(
                {
                  panel2,
                  tree: diagnostics[0],
                  surfaces: diagnostics[1],
                  nativeSlots: diagnostics[2],
                  shell: diagnostics[3],
                  main: diagnostics[4],
                },
                null,
                2
              )
            ),
          });
          throw error;
        }

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
        // Give the divider room to move beyond both columns' minima.
        await setWindowSize(app, 1600, 1000);
        await expect.poll(() => surfacesMatchNativeBounds(app, wcId), POLL).toBe(true);
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

      // ---- Scenario 3: hide non-resident columns without slivers ----------
      await test.step("window shrink hides a column without a sliver; tree selection rebinds it", async () => {
        await setWindowSize(app, 780, 900); // only one actual column minimum fits

        let parkedPanelId = "";
        await expect
          .poll(async () => {
            const [slots, hasEdgeTabs] = await Promise.all([
              getNativePanelSlotDebugInfo(app),
              shellEval<boolean>(app, wcId, `Boolean(document.querySelector('[data-edge-tabs]'))`),
            ]);
            if (hasEdgeTabs || slots.length !== 1) return false;
            const residentPanelId = slots[0]!.panelId;
            parkedPanelId = residentPanelId === panel1 ? panel2 : panel1;
            return true;
          }, POLL)
          .toBe(true);

        // The parked column's slot must be cleared: not bound in the main process.
        const parkedReadinessBefore = await getPanelReadiness(app, parkedPanelId);
        expect(parkedReadinessBefore.nativeSlotBound).toBe(false);

        // Select the hidden presentation through the ordinary panel tree.
        expect(await clickTreeRowForPanel(app, wcId, parkedPanelId)).toBe(true);

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
      await test.step("closing a pane from its local rail keeps the panel in the tree", async () => {
        const surfaces = await getSurfaceRects(app, wcId);
        const secondSurface = surfaces.find((surface) => surface.panelId === panel2);
        expect(secondSurface).toBeDefined();

        // Every pane exposes its own close action while another logical pane
        // would survive; no focus round-trip through the global titlebar.
        expect(
          await shellEval<boolean>(
            app,
            wcId,
            `(() => {
               const frame = document.querySelector('[data-pane-id=${JSON.stringify(secondSurface!.paneId)}]');
               const button = frame?.querySelector('button[aria-label="Close pane"]');
               if (!(button instanceof HTMLElement)) return false;
               button.click();
               return true;
             })()`
          )
        ).toBe(true);

        await expect
          .poll(async () => (await getNativePanelSlotDebugInfo(app)).length, POLL)
          .toBe(1);
        expect(
          await shellEval<number>(
            app,
            wcId,
            `document.querySelectorAll('button[aria-label="Close pane"]').length`
          )
        ).toBe(0);
        // The panel is still in the tree — pane close is layout-only, never archive.
        const tree = await getPanelTree(app);
        expect(tree.some((panel) => panel.id === panel2)).toBe(true);
        expect(await shellErrorOverlayCount(app, wcId)).toBe(0);
      });

      // ---- Scenario 5: geometric drag placement ---------------------------
      await test.step("a tree drag lands where it was dropped, not where focus was", async () => {
        const survivingPaneId = (await getSurfaceRects(app, wcId))[0]?.paneId;
        expect(survivingPaneId).toBeTruthy();

        // Dropped on the centre of the only pane: it takes that pane over.
        await dragTreePanelToPane(app, wcId, panel2, survivingPaneId!, "center");
        await expect
          .poll(async () => {
            const surfaces = await getSurfaceRects(app, wcId);
            return (
              surfaces.length === 1 &&
              surfaces[0]?.panelId === panel2 &&
              (await surfacesMatchNativeBounds(app, wcId))
            );
          }, POLL)
          .toBe(true);

        // Dropped on that pane's left edge: a new column appears to its left.
        const occupiedPaneId = (await getSurfaceRects(app, wcId))[0]?.paneId;
        expect(occupiedPaneId).toBeTruthy();
        await dragTreePanelToPane(app, wcId, panel1, occupiedPaneId!, "left");
        await expect
          .poll(async () => {
            const surfaces = (await getSurfaceRects(app, wcId)).sort(
              (left, right) => left.rect.x - right.rect.x
            );
            return (
              surfaces.map((surface) => surface.panelId).join(",") === `${panel1},${panel2}` &&
              (await surfacesMatchNativeBounds(app, wcId))
            );
          }, POLL)
          .toBe(true);
      });

      // ---- Scenario 6: keyboard operation --------------------------------
      await test.step("dividers respond to arrow keys and Ctrl+Alt+arrows move the focus ring", async () => {
        // Re-open the second panel beside the first for a two-column layout.
        await expect
          .poll(async () => {
            const surfaces = await getSurfaceRects(app, wcId);
            if (surfaces.length >= 2) return true;
            await clickTreeRowForPanel(app, wcId, panel2, { ctrlKey: true }).catch(() => false);
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
        const slotsByPosition = (await getNativePanelSlotDebugInfo(app)).sort(
          (left, right) => left.bounds.x - right.bounds.x
        );
        const focusedIndex = slotsByPosition.findIndex(
          (slot) => slot.nativeSlotId === focusedSlotBefore!.nativeSlotId
        );
        const firstDirection = focusedIndex > 0 ? "ArrowLeft" : "ArrowRight";
        const returnDirection = firstDirection === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
        const moveFocus = (key: string) =>
          shellEval<boolean>(
            app,
            wcId,
            `(window.dispatchEvent(new KeyboardEvent('keydown', {
               key: ${JSON.stringify(key)}, ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
             })), true)`
          );
        await moveFocus(firstDirection);
        let focusedAfterFirstMove = "";
        await expect
          .poll(async () => {
            const focused = (await getNativePanelSlotDebugInfo(app)).find((slot) => slot.focused);
            if (!focused) return false;
            focusedAfterFirstMove = focused.nativeSlotId;
            return focused.nativeSlotId !== focusedSlotBefore!.nativeSlotId;
          }, POLL)
          .toBe(true);
        await moveFocus(returnDirection);
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
