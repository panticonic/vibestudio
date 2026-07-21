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
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  createManagedTestWorkspace,
  removeManagedTestWorkspace,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type PanelTreeEntry = Awaited<ReturnType<typeof getPanelTree>>[number];

function flattenPanelTree(entries: PanelTreeEntry[]): PanelTreeEntry[] {
  return entries.flatMap((entry) => [
    entry,
    ...flattenPanelTree(entry.children as PanelTreeEntry[]),
  ]);
}

async function waitForRestorablePanelTree(
  app: Parameters<typeof getPanelTree>[0]
): Promise<PanelTreeEntry[]> {
  let tree: PanelTreeEntry[] = [];
  let lastError = "";
  await expect
    .poll(
      async () => {
        try {
          tree = await getPanelTree(app);
          return flattenPanelTree(tree).length;
        } catch (error) {
          // Electron can replace its automation execution context while the
          // workspace-owned shell is adopted. Readiness is the first stable,
          // non-empty authoritative panel-tree snapshot, not elapsed time.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastError) {
            lastError = message;
            console.warn(`[panel-persistence] waiting for main test API: ${message}`);
          }
          return 0;
        }
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);
  return tree;
}

test.describe("Panel Persistence", () => {
  // This test launches the app twice, so it needs a longer timeout
  test("panels persist across app restarts", async () => {
    test.setTimeout(480_000); // Double cold app launch plus graceful server teardown.
    const workspacePath = createManagedTestWorkspace();
    let testApp: Awaited<ReturnType<typeof launchTestApp>> | null = null;

    try {
      // First session: create panels
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
        env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
      });

      await ensureHostedShellReady(testApp.app, { panelSource: "panels/chat" });
      const seededTree = await waitForRestorablePanelTree(testApp.app);
      const created = await createPanel(testApp.app, seededTree[0]!.id, "about/help", {
        name: "persistence-check",
        focus: false,
      });
      await expect
        .poll(async () =>
          flattenPanelTree(await getPanelTree(testApp!.app)).some(
            (panel) => panel.id === created.id
          )
        )
        .toBe(true);

      const initialTree = await getPanelTree(testApp.app);
      const initialPanels = flattenPanelTree(initialTree).map((panel) => ({
        id: panel.id,
        source: panel.snapshot?.source ?? null,
      }));
      // Save workspace path for restart
      // Close app using cleanup (which has a timeout to prevent hanging)
      await testApp.cleanup();
      testApp = null;

      // Restart with same workspace
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
        env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
      });

      await ensureHostedShellReady(testApp.app, { panelSource: "panels/chat" });
      const restoredTree = await waitForRestorablePanelTree(testApp.app);
      const restoredPanels = flattenPanelTree(restoredTree).map((panel) => ({
        id: panel.id,
        source: panel.snapshot?.source ?? null,
      }));

      expect(restoredPanels).toEqual(initialPanels);
    } finally {
      if (testApp) {
        await testApp.cleanup();
      }
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
