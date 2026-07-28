import { expect, test } from "@playwright/test";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getNativePanelSlotDebugInfo,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type WebContentsSnapshot = {
  id: number;
  url: string;
  title: string;
  text: string;
  hasTitlebar: boolean;
  hasApprovalBar: boolean;
};

async function listWebContents(testApp: TestApp): Promise<WebContentsSnapshot[]> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const snapshots: WebContentsSnapshot[] = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      const title = contents.getTitle();
      let dom: {
        text: string;
        hasTitlebar: boolean;
        hasApprovalBar: boolean;
      } | null = null;
      try {
        dom = await contents.executeJavaScript(
          `({
            text: document.body?.innerText ?? "",
            hasTitlebar: !!document.querySelector(".titlebar-breadcrumb-scroll")
              || !!document.querySelector('[aria-label="Menu"]'),
            hasApprovalBar: !!document.querySelector(".approval-card, .approval-pill"),
          })`,
          true
        );
      } catch {
        dom = null;
      }
      snapshots.push({
        id: contents.id,
        url,
        title,
        text: dom?.text ?? "",
        hasTitlebar: dom?.hasTitlebar ?? false,
        hasApprovalBar: dom?.hasApprovalBar ?? false,
      });
    }
    return snapshots;
  });
}

async function getPanelSurfaceLayout(testApp: TestApp): Promise<{
  surfaces: Array<{
    nativeSlotId: string;
    panelId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    bottom: number;
  }>;
  approval: { x: number; y: number; width: number; height: number; bottom: number } | null;
  topChrome: { x: number; y: number; width: number; height: number; bottom: number }[];
  sidebar: { x: number; y: number; width: number; height: number; bottom: number } | null;
}> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => {
            const rectFor = (node) => {
              if (!(node instanceof HTMLElement)) return null;
              const rect = node.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return null;
              return {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                bottom: Math.round(rect.bottom),
              };
            };
            const surfaces = Array.from(document.querySelectorAll("[data-native-panel-slot-id]"))
              .map((node) => {
                const rect = rectFor(node);
                const nativeSlotId = node.getAttribute("data-native-panel-slot-id");
                const panelId = node.getAttribute("data-panel-id");
                return rect && nativeSlotId && panelId
                  ? { nativeSlotId, panelId, ...rect }
                  : null;
              })
              .filter(Boolean);
            if (surfaces.length === 0) return null;
            return {
              surfaces,
              approval: rectFor(document.querySelector(".approval-card, .approval-pill")),
              topChrome: Array.from(document.querySelectorAll("[data-shell-top-chrome]"))
                .map(rectFor)
                .filter(Boolean),
              sidebar: rectFor(document.querySelector("[data-shell-panel-sidebar]")),
            };
          })()`,
          true
        );
        if (result?.surfaces?.length) return result;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return { surfaces: [], approval: null, topChrome: [], sidebar: null };
  });
}

async function approveStartupUnitsIfNeeded(testApp: TestApp): Promise<void> {
  await expect
    .poll(
      async () =>
        testApp.app.evaluate(async ({ webContents }) => {
          for (const contents of webContents.getAllWebContents()) {
            if (contents.isDestroyed()) continue;
            try {
              const result = await contents.executeJavaScript(
                `(() => {
                  const hasHostedShellChrome = Boolean(document.querySelector(".titlebar-breadcrumb-scroll")
                    || document.querySelector('[aria-label="Menu"]'));
                  if (hasHostedShellChrome) return "ready";

                  if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) {
                    return "missing";
                  }

                  const approveAll = Array.from(document.querySelectorAll("button"))
                    .find((button) =>
                      /^(Trust and start|Approve and start)$/.test((button.textContent ?? "").trim())
                    );
                  if (!approveAll) return "waiting";
                  approveAll.click();
                  return "approved";
                })()`,
                true
              );
              if (result === "ready" || result === "approved") return true;
            } catch {
              // Ignore non-DOM webContents.
            }
          }
          return false;
        }),
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

test.describe("Desktop Shell Chrome", () => {
  test.setTimeout(240_000);

  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("mounts the dynamic shell app with custom titlebar chrome", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsIfNeeded(testApp);

    await expect
      .poll(
        async () => {
          const snapshots = await listWebContents(testApp!);
          return snapshots.some(
            (snapshot) =>
              snapshot.url.includes("/_a/") &&
              snapshot.url.endsWith("/index.html") &&
              snapshot.hasTitlebar
          );
        },
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);
  });

  test("places the native panel exactly in the measured shell panel surface", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsIfNeeded(testApp);

    await expect
      .poll(
        async () => {
          const [panels, slots, layout] = await Promise.all([
            getPanelTree(testApp!.app).catch(() => []),
            getNativePanelSlotDebugInfo(testApp!.app).catch(() => []),
            getPanelSurfaceLayout(testApp!).catch(() => ({
              surfaces: [],
              approval: null,
              topChrome: [],
              sidebar: null,
            })),
          ]);
          if (slots.length === 0 || slots.length !== layout.surfaces.length) return false;

          const panelIds = new Set(panels.map((panel) => panel.id));
          const slotsMatchSurfaces = slots.every((slot) => {
            const surface = layout.surfaces.find(
              (candidate) => candidate.nativeSlotId === slot.nativeSlotId
            );
            return (
              surface !== undefined &&
              surface.panelId === slot.panelId &&
              panelIds.has(slot.panelId) &&
              Math.abs(slot.bounds.x - surface.x) <= 1 &&
              Math.abs(slot.bounds.y - surface.y) <= 1 &&
              Math.abs(slot.bounds.width - surface.width) <= 1 &&
              Math.abs(slot.bounds.height - surface.height) <= 1
            );
          });
          const chromeDoesNotOverlapSurfaces = layout.surfaces.every((surface) => {
            // The approval card is a deliberate overlay above the panel. In-flow
            // top chrome and the sidebar still must not consume the panel box.
            const topChromeDoesNotOverlap = layout.topChrome.every(
              (rect) => rect.bottom <= surface.y || rect.y >= surface.bottom
            );
            const sidebarDoesNotOverlap =
              !layout.sidebar ||
              layout.sidebar.x + layout.sidebar.width <= surface.x ||
              layout.sidebar.x >= surface.x + surface.width ||
              layout.sidebar.bottom <= surface.y ||
              layout.sidebar.y >= surface.bottom;
            return topChromeDoesNotOverlap && sidebarDoesNotOverlap;
          });
          return slotsMatchSurfaces && chromeDoesNotOverlapSurfaces;
        },
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);
  });
});
