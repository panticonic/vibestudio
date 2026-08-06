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
            hasTitlebar: !!document.querySelector('[data-shell-top-chrome="titlebar"]')
              || !!document.querySelector(".titlebar-breadcrumb-scroll")
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
  shellState?: {
    columns: string | null;
    restored: string | null;
    visiblePanels: string | null;
    rootPanels: string | null;
    residentColumns: string | null;
    panelContentStates: Array<{
      panelId: string | null;
      state: string | null;
      buildKey: string | null;
      buildState: string | null;
      runtimePhase: string | null;
    }>;
  };
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
            const shellLayout = document.querySelector("[data-shell-layout-columns]");
            if (surfaces.length === 0 && !shellLayout) return null;
            return {
              surfaces,
              approval: rectFor(document.querySelector(".approval-card, .approval-pill")),
              topChrome: Array.from(document.querySelectorAll("[data-shell-top-chrome]"))
                .map(rectFor)
                .filter(Boolean),
              sidebar: rectFor(document.querySelector("[data-shell-panel-sidebar]")),
              ...(shellLayout
                ? { shellState: {
                    columns: shellLayout.getAttribute("data-shell-layout-columns"),
                    restored: shellLayout.getAttribute("data-shell-layout-restored"),
                    visiblePanels: shellLayout.getAttribute("data-shell-layout-visible-panels"),
                    rootPanels: shellLayout.getAttribute("data-shell-layout-root-panels"),
                    residentColumns: shellLayout.getAttribute("data-shell-layout-resident-columns"),
                    panelContentStates: Array.from(
                      document.querySelectorAll("[data-panel-content-state]")
                    ).map((node) => ({
                      panelId: node.getAttribute("data-panel-id"),
                      state: node.getAttribute("data-panel-content-state"),
                      buildKey: node.getAttribute("data-panel-build-key"),
                      buildState: node.getAttribute("data-panel-build-state"),
                      runtimePhase: node.getAttribute("data-panel-runtime-phase"),
                    })),
                  } }
                : {}),
            };
          })()`,
          true
        );
        if (result?.surfaces?.length || result?.shellState) return result;
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
          const testApi = (
            globalThis as {
              __testApi?: {
                getHostViewDebugInfo(): { visibleHostChromeAppId: string | null };
              };
            }
          ).__testApi;
          if (testApi?.getHostViewDebugInfo().visibleHostChromeAppId) return true;
          for (const contents of webContents.getAllWebContents()) {
            if (contents.isDestroyed()) continue;
            try {
              const result = await contents.executeJavaScript(
                `(() => {
                  const hasHostedShellChrome = Boolean(document.querySelector('[data-shell-top-chrome="titlebar"]')
                    || document.querySelector(".titlebar-breadcrumb-scroll")
                    || document.querySelector('[aria-label="Menu"]'));
                  if (hasHostedShellChrome) return "hosted-shell-loaded";

                  if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) {
                    return "missing";
                  }

                  const approveAll = Array.from(document.querySelectorAll("button"))
                    .find((button) =>
                      /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start)$/.test((button.textContent ?? "").trim())
                    );
                  if (!approveAll) return "waiting";
                  approveAll.click();
                  return "approved";
                })()`,
                true
              );
              if (result === "approved") return true;
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

    let lastSnapshots: WebContentsSnapshot[] = [];
    try {
      await expect
        .poll(
          async () => {
            lastSnapshots = await listWebContents(testApp!);
            return lastSnapshots.some((snapshot) => {
              let pathname = "";
              try {
                pathname = new URL(snapshot.url).pathname;
              } catch {
                return false;
              }
              return (
                pathname.includes("/_a/") &&
                pathname.endsWith("/index.html") &&
                snapshot.hasTitlebar
              );
            });
          },
          { timeout: 120_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nLast WebContents snapshots: ${JSON.stringify(lastSnapshots)}\nElectron output tail:\n${testApp.getOutput().slice(-20_000)}`
      );
    }
  });

  test("places the native panel exactly in the measured shell panel surface", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsIfNeeded(testApp);

    let lastState: unknown = null;
    try {
      await expect
        .poll(
          async () => {
            const [panelsResult, slotsResult, layoutResult] = await Promise.allSettled([
              getPanelTree(testApp!.app),
              getNativePanelSlotDebugInfo(testApp!.app),
              getPanelSurfaceLayout(testApp!),
            ]);
            const panels = panelsResult.status === "fulfilled" ? panelsResult.value : [];
            const slots = slotsResult.status === "fulfilled" ? slotsResult.value : [];
            const layout =
              layoutResult.status === "fulfilled"
                ? layoutResult.value
                : {
                    surfaces: [],
                    approval: null,
                    topChrome: [],
                    sidebar: null,
                  };
            lastState = {
              panels,
              slots,
              layout,
              errors: {
                panels: panelsResult.status === "rejected" ? String(panelsResult.reason) : null,
                slots: slotsResult.status === "rejected" ? String(slotsResult.reason) : null,
                layout: layoutResult.status === "rejected" ? String(layoutResult.reason) : null,
              },
            };
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
    } catch (error) {
      const outputTail = testApp.getOutput().slice(-20_000);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nLast native-layout state: ${JSON.stringify(lastState)}\nElectron output tail:\n${outputTail}\nHub output tail:\n${testApp.getHubOutput()}`
      );
    }
  });
});
