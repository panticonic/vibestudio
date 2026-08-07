import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

import {
  clickPanelSelector,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  isPanelReady,
  launchTestApp,
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  readMainProcessErrors,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureInitialPanel(sourceRoot: string): void {
  const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [{ source: "about/new" }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function clickServerLogs(app: ElectronApplication, panelId: string): Promise<boolean> {
  return clickPanelSelector(app, panelId, 'a[href*="/about/server-logs/"]');
}

test.describe("Server Logs navigation", () => {
  test("opens from About/New without leaving a stuck pending spinner", async () => {
    test.setTimeout(240_000);
    const workspacePath = createManagedTestWorkspace({ configureSource: configureInitialPanel });
    let testApp: TestApp | null = null;
    try {
      testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
      await approvePendingStartupUnits(testApp.app);
      await approvePendingWorkspaceCreationReview(testApp.app);

      const readiness = await ensureHostedShellReady(testApp.app, { panelSource: "about/new" });
      const panelId = readiness.panelId;
      await expect
        .poll(() => getPanelText(testApp!.app, panelId).catch(() => ""), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toContain("New Panel");

      await expect
        .poll(() => clickServerLogs(testApp!.app, panelId), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toBe(true);

      try {
        await expect
          .poll(
            async () => {
              const panel = (await getPanelTree(testApp!.app)).find((item) => item.id === panelId);
              return (
                panel?.snapshot?.source === "about/server-logs" &&
                (await isPanelReady(testApp!.app, panelId))
              );
            },
            { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] }
          )
          .toBe(true);
      } catch (error) {
        const [tree, text, mainErrors] = await Promise.all([
          getPanelTree(testApp.app).catch(() => []),
          getPanelText(testApp.app, panelId).catch(() => ""),
          readMainProcessErrors(testApp.app).catch(() => []),
        ]);
        throw new Error(
          `Server Logs navigation did not converge: ${JSON.stringify({
            panel: tree.find((item) => item.id === panelId),
            text,
            mainErrors,
            electronOutput: testApp.getOutput().slice(-12_000),
          })}\n${error instanceof Error ? error.message : String(error)}`
        );
      }

      await expect
        .poll(() => getPanelText(testApp!.app, panelId).catch(() => ""), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toContain("Server Logs");
    } finally {
      if (testApp) await testApp.cleanup().catch(() => {});
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
