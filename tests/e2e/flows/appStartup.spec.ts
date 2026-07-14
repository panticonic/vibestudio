/**
 * App Startup E2E Tests
 *
 * Tests that the vibestudio app launches correctly and the shell initializes.
 */

import { test, expect } from "@playwright/test";
import {
  approvePendingStartupWork,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getExtensionRegistry,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test.describe("App Startup", () => {
  let testApp: TestApp;

  test.afterEach(async () => {
    if (testApp) {
      await testApp.cleanup();
    }
  });

  test("launches successfully with test workspace", async () => {
    testApp = await launchTestApp();

    // App should have launched and window should be visible
    expect(testApp.app).toBeDefined();
    expect(testApp.window).toBeDefined();
    expect(testApp.workspacePath).toBeDefined();
  });

  test("shell loads and displays initial content", async () => {
    testApp = await launchTestApp();
    const { window } = testApp;

    // Wait for the DOM to be fully loaded
    await window.waitForLoadState("domcontentloaded");

    // The shell should have loaded (check for any content)
    const content = await window.content();
    expect(content).toBeTruthy();
  });

  test("test API is available when VIBESTUDIO_TEST_MODE=1", async () => {
    testApp = await launchTestApp();

    // The test API should be exposed on the global object
    const hasTestApi = await testApp.app.evaluate(() => {
      return typeof (globalThis as { __testApi?: unknown }).__testApi !== "undefined";
    });

    expect(hasTestApi).toBe(true);
  });

  test("panel tree is accessible via test API", async () => {
    testApp = await launchTestApp();

    await expect
      .poll(
        async () => {
          try {
            return Array.isArray(await getPanelTree(testApp.app));
          } catch {
            // Startup swaps Electron execution contexts while presenting the
            // native trust gate. Accessibility is an eventual contract across
            // that navigation, not a guarantee for one sampled microtask.
            return false;
          }
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  });

  test("fresh-workspace extensions complete first activation without crashing", async () => {
    testApp = await launchTestApp({
      env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
    });
    await expect
      .poll(
        async () => {
          await approvePendingStartupWork(testApp.app);
          const extensions = await getExtensionRegistry(testApp.app);
          const devHost = extensions.find(
            (entry) => entry.name === "@workspace-extensions/dev-host"
          );
          return devHost ? { status: devHost.status, lastError: devHost.lastError } : null;
        },
        { timeout: 120_000 }
      )
      .toEqual({ status: "running", lastError: null });

    await expect(testApp.window.getByText("Extension stopped", { exact: true })).toHaveCount(0);
  });
});
