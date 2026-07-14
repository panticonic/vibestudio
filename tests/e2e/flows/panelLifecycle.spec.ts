/**
 * Panel Lifecycle E2E Tests
 *
 * Only the persistence test remains here: it restarts the app, which cannot
 * run in-system. The rest of the lifecycle coverage (panel creation, focus
 * management, panel loading state) now lives in @workspace/testkit
 * (workspace/packages/testkit/src/suites/panelLifecycle.ts).
 */

import { test, expect } from "@playwright/test";
import {
  approvePendingStartupWork,
  createPanel,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  createManagedTestWorkspace,
  removeManagedTestWorkspace,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test.describe("Panel Persistence", () => {
  test("panels persist across app restarts", async () => {
    test.setTimeout(360000);
    const workspacePath = createManagedTestWorkspace();
    let testApp: Awaited<ReturnType<typeof launchTestApp>> | null = null;

    try {
      testApp = await launchTestApp({
        workspace: workspacePath,
        env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
      });
      const initialTree = await waitForStartedPanelTree(testApp);
      const parent = initialTree[0];
      if (!parent) throw new Error("Workspace started without an initial panel");
      const created = await createPanel(testApp.app, parent.id, "panels/chat", {
        name: "Persistence E2E",
        focus: true,
      });
      await expect
        .poll(async () =>
          (await getPanelTree(testApp!.app)).some((panel) => panel.id === created.id)
        )
        .toBe(true);

      await testApp.cleanup();
      testApp = null;

      testApp = await launchTestApp({
        workspace: workspacePath,
        env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
      });
      await expect
        .poll(
          async () => {
            await approvePendingStartupWork(testApp!.app);
            try {
              const restored = (await getPanelTree(testApp!.app)).find(
                (panel) => panel.id === created.id
              );
              return restored
                ? { id: restored.id, source: restored.snapshot?.source ?? null }
                : null;
            } catch {
              return null;
            }
          },
          { timeout: 180_000 }
        )
        .toEqual({ id: created.id, source: "panels/chat" });
    } finally {
      if (testApp) {
        await testApp.cleanup().catch(() => undefined);
      }
      removeManagedTestWorkspace(workspacePath);
    }
  });
});

async function waitForStartedPanelTree(
  testApp: Awaited<ReturnType<typeof launchTestApp>>
): Promise<Awaited<ReturnType<typeof getPanelTree>>> {
  let tree: Awaited<ReturnType<typeof getPanelTree>> = [];
  await expect
    .poll(
      async () => {
        await approvePendingStartupWork(testApp.app);
        try {
          tree = await getPanelTree(testApp.app);
          return tree.length;
        } catch {
          return 0;
        }
      },
      { timeout: 180_000 }
    )
    .toBeGreaterThan(0);
  return tree;
}
