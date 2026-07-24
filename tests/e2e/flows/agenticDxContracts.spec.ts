import { expect, test } from "@playwright/test";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  approvePendingStartupUnits,
  createManagedTestWorkspace,
  ensureHostedShellReady,
  executePanelScript,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test.describe("agentic DX contracts", () => {
  test("Electron preserves directory reads and bounded causal diagnostics end to end", async () => {
    test.setTimeout(240_000);
    const workspacePath = createManagedTestWorkspace();
    const testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
    try {
      await approvePendingStartupUnits(testApp.app);
      await ensureHostedShellReady(testApp.app, { panelSource: "panels/chat" });
      const panel = (await getPanelTree(testApp.app))[0];
      expect(panel).toBeTruthy();

      const result = await executePanelScript<{
        entries: string[];
        diagnostic: {
          coordinate: {
            trajectoryId: string;
            branchId: string;
            invocationId: string;
          };
          invocation: unknown;
          events: unknown[];
          commands: unknown[];
          summary: {
            terminal: boolean;
            eventCount: number;
            commandCount: number;
            pendingEffectCount: number;
            cleanupFailureCount: number;
            truncated: { events: boolean; commands: boolean; effects: boolean };
          };
        };
      }>(
        testApp.app,
        panel!.id,
        `(async () => {
          const { fs, gad } = await globalThis.__vibestudioRequireAsync__("@workspace/runtime");
          const entries = await fs.readdir("panels");
          const diagnostic = await gad.diagnoseInvocation({
            trajectoryId: "electron-diagnostic-missing",
            branchId: "main",
            invocationId: "invocation-missing",
            eventLimit: 3,
            commandLimit: 2,
            effectLimit: 2,
          });
          return { entries, diagnostic };
        })()`
      );

      expect(result.entries).toContain("chat");
      expect(result.diagnostic).toEqual({
        generatedAt: expect.any(String),
        coordinate: {
          trajectoryId: "electron-diagnostic-missing",
          branchId: "main",
          invocationId: "invocation-missing",
        },
        invocation: null,
        turn: null,
        events: [],
        commands: [],
        summary: {
          terminal: false,
          eventCount: 0,
          commandCount: 0,
          pendingEffectCount: 0,
          cleanupFailureCount: 0,
          truncated: { events: false, commands: false, effects: false },
        },
      });
    } finally {
      await testApp.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
