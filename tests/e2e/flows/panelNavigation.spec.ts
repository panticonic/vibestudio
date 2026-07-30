import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

import {
  clickPanelSelector,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  getPanelDiagnostics,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  isPanelReady,
  launchTestApp,
  approvePendingStartupUnits,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureInitialPanel(workspacePath: string, source: string): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [{ source }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function shellStatus(app: ElectronApplication): Promise<{
  buildingCount: number;
  hasOperationFailure: boolean;
}> {
  return app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) => !candidate.isDestroyed() && candidate.getTitle() === "@workspace-apps/shell"
      );
    if (!contents) return { buildingCount: 0, hasOperationFailure: false };
    try {
      const status = await Promise.race([
        contents.executeJavaScript(
          `(() => ({
            buildingCount: document.querySelectorAll('.app-tree-spinner,[aria-label="Building"]').length,
            hasOperationFailure: (document.body?.innerText ?? '').includes('A Vibestudio operation failed'),
          }))()`,
          true
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      return {
        buildingCount: Number(status?.buildingCount ?? 0),
        hasOperationFailure: status?.hasOperationFailure === true,
      };
    } catch {
      return { buildingCount: 0, hasOperationFailure: false };
    }
  });
}

async function navigatePanel(
  app: ElectronApplication,
  panelId: string,
  source: string
): Promise<void> {
  await app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
          };
        }
      ).__testApi;
      if (!testApi) throw new Error("Test API not available");
      await testApi.rpcCall("panelTree", "navigate", [request.panelId, request.source, {}]);
    },
    { panelId, source }
  );
}

async function panelSurfaceState(
  app: ElectronApplication,
  panelId: string
): Promise<{ text: string; alertCount: number; alertText: string }> {
  const text = await getPanelText(app, panelId);
  const alertState = await app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: { executePanelScript: <T>(panelId: string, script: string) => Promise<T> };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.executePanelScript<{ count: number; text: string }>(
      id,
      `(() => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        return {
          count: alerts.length,
          text: alerts.map((alert) => alert.textContent ?? "").join("\\n").trim(),
        };
      })()`
    );
  }, panelId);
  return { text, alertCount: alertState.count, alertText: alertState.text };
}

async function severePanelDiagnostics(
  app: ElectronApplication,
  panelId: string
): ReturnType<typeof getPanelDiagnostics> {
  return (await getPanelDiagnostics(app, panelId)).filter((item) => {
    if (item.type !== "console")
      return item.type !== "did-fail-load" || !item.message.includes("(-3)");
    const level = String(item.level ?? "").toLowerCase();
    return (
      level === "2" || level === "3" || level === "error" || /\buncaught\b/i.test(item.message)
    );
  });
}

test.describe("Panel navigation convergence", () => {
  test("same-panel navigation converges without leaked failures or stuck build state", async () => {
    test.setTimeout(240_000);
    const workspacePath = createManagedTestWorkspace();
    configureInitialPanel(workspacePath, "about/new");
    let testApp: TestApp | null = null;
    try {
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
      });
      await approvePendingStartupUnits(testApp.app);
      const initialReadiness = await ensureHostedShellReady(testApp.app, {
        panelSource: "about/new",
      });
      const initialPanelId = initialReadiness.panelId;
      await startPanelDiagnostics(testApp.app, initialPanelId);
      await expect
        .poll(() => getPanelText(testApp!.app, initialPanelId).catch(() => ""), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toContain("Start a chat");
      await expect
        .poll(
          async () => {
            try {
              const panel = (await getPanelTree(testApp!.app))[0];
              const converged =
                panel?.id === initialPanelId &&
                panel.snapshot?.source === "panels/chat" &&
                (await isPanelReady(testApp!.app, initialPanelId));
              if (converged) return true;

              // A dispatched native click is not the navigation outcome. Keep
              // the idempotent user action coupled to the authoritative panel
              // tree until the same panel has actually converged.
              await clickPanelSelector(
                testApp!.app,
                initialPanelId,
                'a[href*="/panels/chat/"]'
              ).catch(() => false);
              return false;
            } catch {
              return false;
            }
          },
          { timeout: 180_000, intervals: [250, 500, 1_000, 2_000] }
        )
        .toBe(true);

      await expect
        .poll(() => shellStatus(testApp!.app), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toEqual({ buildingCount: 0, hasOperationFailure: false });

      for (const surface of [
        {
          source: "about/about",
          readyText: "Your personal vibe computer",
          pendingText: "Loading version and connection",
        },
        {
          source: "about/adblock",
          readyText: "Enable Ad Blocking",
          pendingText: "Loading ad blocking settings",
        },
        {
          source: "about/permissions",
          readyText: "Lasting access you granted to apps and agents",
          pendingText: "Loading saved permissions",
        },
      ]) {
        await navigatePanel(testApp.app, initialPanelId, surface.source);
        await expect
          .poll(
            async () => {
              try {
                const panel = (await getPanelTree(testApp!.app))[0];
                if (
                  panel?.id !== initialPanelId ||
                  panel.snapshot?.source !== surface.source ||
                  !(await isPanelReady(testApp!.app, initialPanelId))
                ) {
                  return {
                    source: panel?.snapshot?.source ?? null,
                    ready: false,
                    alertCount: -1,
                    alertText: "",
                    hasReadyText: false,
                    hasPendingText: false,
                    diagnostics: await severePanelDiagnostics(testApp!.app, initialPanelId),
                  };
                }
                const state = await panelSurfaceState(testApp!.app, initialPanelId);
                return {
                  source: panel.snapshot.source,
                  ready: true,
                  alertCount: state.alertCount,
                  alertText: state.alertText,
                  hasReadyText: state.text.includes(surface.readyText),
                  hasPendingText: state.text.includes(surface.pendingText),
                  diagnostics: await severePanelDiagnostics(testApp!.app, initialPanelId),
                };
              } catch (error) {
                return {
                  source: null,
                  ready: false,
                  alertCount: -1,
                  alertText: "",
                  hasReadyText: false,
                  hasPendingText: false,
                  diagnostics: [
                    {
                      type: "probe-error",
                      message: error instanceof Error ? error.message : String(error),
                    },
                  ],
                };
              }
            },
            { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] }
          )
          .toMatchObject({
            source: surface.source,
            ready: true,
            alertCount: 0,
            alertText: "",
            hasReadyText: true,
            hasPendingText: false,
            diagnostics: expect.any(Array),
          });
      }

      expect(await shellStatus(testApp.app)).toEqual({
        buildingCount: 0,
        hasOperationFailure: false,
      });
    } finally {
      await testApp?.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
