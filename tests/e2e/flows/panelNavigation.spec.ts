import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

import {
  clickPanelText,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  getPanelDiagnostics,
  getPanelReadiness,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  isPanelReady,
  launchTestApp,
  approvePendingWorkspaceCreationReview,
  approvePendingStartupUnits,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  typePanelText,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureInitialPanel(sourceRoot: string, source: string): void {
  const configPath = path.join(sourceRoot, "meta", "template.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config["initPanels"] = [{ source }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function shellStatus(owner: TestApp): Promise<{
  buildingCount: number;
  hasOperationFailure: boolean;
}> {
  const { app } = owner;
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

async function navigatePanel(owner: TestApp, panelId: string, source: string): Promise<void> {
  const { app } = owner;
  await app.evaluate(
    async (_electron, { workspaceId, payload: request }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      await testApi.navigatePanel(request.panelId, request.source);
    },
    { workspaceId: owner.workspaceId, payload: { panelId, source } }
  );
}

async function panelSurfaceState(
  owner: TestApp,
  panelId: string
): Promise<{
  text: string;
  alertCount: number;
  alertText: string;
  controlReady: boolean;
  initialLoading: boolean;
}> {
  const { app } = owner;
  const text = await getPanelText(owner, panelId);
  const alertState = await app.evaluate(
    async (_electron, { workspaceId, payload: id }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      return testApi.executePanelScript<{
        count: number;
        text: string;
        controlReady: boolean;
        initialLoading: boolean;
      }>(
        id,
        `(() => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        return {
          count: alerts.length,
          text: alerts.map((alert) => alert.textContent ?? "").join("\\n").trim(),
          controlReady: Boolean(
            document.querySelector('[aria-label="Permission view"], [aria-label="Enable Ad Blocking"]')
          ),
          initialLoading: Boolean(
            document.querySelector('[aria-label="Loading permissions"], [aria-label="Loading ad block settings"]')
          ),
        };
      })()`
      );
    },
    { workspaceId: owner.workspaceId, payload: panelId }
  );
  return {
    text,
    alertCount: alertState.count,
    alertText: alertState.text,
    controlReady: alertState.controlReady,
    initialLoading: alertState.initialLoading,
  };
}

async function severePanelDiagnostics(
  owner: TestApp,
  panelId: string
): ReturnType<typeof getPanelDiagnostics> {
  return (await getPanelDiagnostics(owner, panelId)).filter((item) => {
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
    const workspacePath = await createManagedTestWorkspace({
      configureSource: (sourceRoot) => configureInitialPanel(sourceRoot, "about/new"),
    });
    let testApp: TestApp | null = null;
    try {
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
      });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);
      const initialReadiness = await ensureHostedShellReady(testApp, {
        panelSource: "about/new",
      });
      const initialPanelId = initialReadiness.panelId;
      await startPanelDiagnostics(testApp, initialPanelId);
      await expect
        .poll(() => getPanelText(testApp!, initialPanelId).catch(() => ""), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toContain("Jump to a panel, revisit a page, or ask an agent.");
      // Utility pages are searchable, but intentionally stay out of the idle
      // app suggestions.
      await typePanelText(testApp, initialPanelId, "About Vibestudio");
      await expect
        .poll(
          async () => {
            try {
              const panel = (await getPanelTree(testApp!))[0];
              const readiness = await getPanelReadiness(testApp!, initialPanelId);
              if (
                panel?.id === initialPanelId &&
                panel.snapshot?.source === "about/about" &&
                readiness.terminal
              ) {
                return { source: panel.snapshot.source, state: readiness.presentation.state };
              }

              // A dispatched native click is not the navigation outcome. Keep
              // the idempotent user action coupled to the authoritative panel
              // tree until the same panel has actually converged.
              await clickPanelText(
                testApp!,
                initialPanelId,
                ".launcher-title",
                "About Vibestudio"
              ).catch(() => false);
              return {
                source: panel?.snapshot?.source ?? null,
                state: readiness.presentation.state,
              };
            } catch (error) {
              return {
                source: null,
                state: error instanceof Error ? error.message : String(error),
              };
            }
          },
          { timeout: 120_000, intervals: [250, 500, 1_000, 2_000] }
        )
        .toEqual({ source: "about/about", state: "ready" });

      await expect
        .poll(() => shellStatus(testApp!), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toEqual({ buildingCount: 0, hasOperationFailure: false });

      for (const surface of [
        {
          source: "about/adblock",
          readyText: "Enable Ad Blocking",
        },
        {
          source: "about/permissions",
          readyText: "Lasting access you granted to apps and agents",
        },
      ]) {
        await navigatePanel(testApp, initialPanelId, surface.source);
        await expect
          .poll(
            async () => {
              try {
                const panel = (await getPanelTree(testApp!))[0];
                if (
                  panel?.id !== initialPanelId ||
                  panel.snapshot?.source !== surface.source ||
                  !(await isPanelReady(testApp!, initialPanelId))
                ) {
                  return {
                    source: panel?.snapshot?.source ?? null,
                    ready: false,
                    alertCount: -1,
                    alertText: "",
                    hasReadyText: false,
                    controlReady: false,
                    initialLoading: false,
                    diagnostics: await severePanelDiagnostics(testApp!, initialPanelId),
                  };
                }
                const state = await panelSurfaceState(testApp!, initialPanelId);
                return {
                  source: panel.snapshot.source,
                  ready: true,
                  alertCount: state.alertCount,
                  alertText: state.alertText,
                  hasReadyText: state.text.includes(surface.readyText),
                  controlReady: state.controlReady,
                  initialLoading: state.initialLoading,
                  diagnostics: await severePanelDiagnostics(testApp!, initialPanelId),
                };
              } catch (error) {
                return {
                  source: null,
                  ready: false,
                  alertCount: -1,
                  alertText: "",
                  hasReadyText: false,
                  controlReady: false,
                  initialLoading: false,
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
            controlReady: true,
            initialLoading: false,
            diagnostics: expect.any(Array),
          });
      }

      expect(await shellStatus(testApp)).toEqual({
        buildingCount: 0,
        hasOperationFailure: false,
      });
    } finally {
      await testApp?.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
