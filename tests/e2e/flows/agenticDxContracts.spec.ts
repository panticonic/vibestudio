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
          const { fs, gad } = await globalThis.__vibestudioRequireAsync__("@vibestudio/runtime");
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

  test("Electron captures hosted-panel pixels and historical console diagnostics end to end", async () => {
    test.setTimeout(240_000);
    const workspacePath = createManagedTestWorkspace();
    const testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
    try {
      await approvePendingStartupUnits(testApp.app);
      await ensureHostedShellReady(testApp.app, { panelSource: "panels/chat" });
      const panel = (await getPanelTree(testApp.app))[0];
      expect(panel).toBeTruthy();

      const result = await executePanelScript<{
        screenshot: {
          mimeType: string;
          width: number;
          height: number;
          prefix: string;
          byteLength: number;
        };
        blob: {
          digest: string;
          byteLength: number;
          restoredExactly: boolean;
        };
        console: {
          entryCount: number;
          errorCount: number;
          dropped: unknown;
        };
        observation: {
          source: string;
          phase: string;
          runtimeEntityId: string;
          buildKey: string;
        };
      }>(
        testApp.app,
        panel!.id,
        `(async () => {
          const { blobstore, openPanel } =
            await globalThis.__vibestudioRequireAsync__("@vibestudio/runtime");
          const handle = await openPanel("panels/hello-vanilla");
          try {
            const observation = await handle.observe();
            const screenshot = await handle.cdp.screenshot({ format: "png" });
            const stored = await blobstore.putBase64(screenshot.data);
            const restored = await blobstore.getBase64(stored.digest);
            const history = await handle.cdp.consoleHistory({ limit: 50, errorLimit: 20 });
            return {
              screenshot: {
                mimeType: screenshot.mimeType,
                width: screenshot.width,
                height: screenshot.height,
                prefix: screenshot.data.slice(0, 12),
                byteLength: Math.floor(screenshot.data.length * 3 / 4),
              },
              blob: {
                digest: stored.digest,
                byteLength: stored.size,
                restoredExactly: restored === screenshot.data,
              },
              console: {
                entryCount: history.entries.length,
                errorCount: history.errors.length,
                dropped: history.dropped,
              },
              observation: {
                source: observation.source,
                phase: observation.phase,
                runtimeEntityId: observation.runtimeEntityId,
                buildKey: observation.buildKey,
              },
            };
          } finally {
            await handle.close();
          }
        })()`
      );

      expect(result.screenshot).toMatchObject({
        mimeType: "image/png",
        width: expect.any(Number),
        height: expect.any(Number),
        prefix: expect.stringMatching(/^iVBOR/),
        byteLength: expect.any(Number),
      });
      expect(result.screenshot.width).toBeGreaterThan(0);
      expect(result.screenshot.height).toBeGreaterThan(0);
      expect(result.screenshot.byteLength).toBeGreaterThan(100);
      expect(result.blob).toEqual({
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        byteLength: expect.any(Number),
        restoredExactly: true,
      });
      expect(result.blob.byteLength).toBeGreaterThan(100);
      expect(result.console.entryCount).toBeGreaterThanOrEqual(0);
      expect(result.console.errorCount).toBe(0);
      expect(result.console.dropped).toBeTruthy();
      expect(result.observation).toMatchObject({
        source: "panels/hello-vanilla",
        phase: "ready",
        runtimeEntityId: expect.any(String),
        buildKey: expect.any(String),
      });
    } finally {
      await testApp.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
