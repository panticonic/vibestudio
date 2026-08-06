import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import YAML from "yaml";

import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  createBrowserPanel,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  getPanelText,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureWithoutBrowserDataExtension(workspacePath: string): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as {
    initPanels?: Array<{ source: string }>;
    extensions?: Array<{ source: string }>;
    providers?: Record<string, unknown>;
  };
  config.initPanels = [{ source: "about/new" }];
  config.extensions = config.extensions?.filter(
    (extension) => extension.source !== "extensions/browser-data"
  );
  if (config.providers) delete config.providers.browserData;
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

test.describe("Browser panel startup", () => {
  test("loads while the optional browser-data extension is unavailable", async () => {
    test.setTimeout(240_000);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Browser fixture</title><p>Browser panel is ready</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Browser fixture did not listen");
    const url = `http://127.0.0.1:${address.port}/`;
    const workspacePath = createManagedTestWorkspace();
    configureWithoutBrowserDataExtension(workspacePath);
    let testApp: TestApp | null = null;

    try {
      testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
      await approvePendingStartupUnits(testApp.app);
      await approvePendingWorkspaceCreationReview(testApp.app);
      const initial = await ensureHostedShellReady(testApp.app, { panelSource: "about/new" });
      const browserSource = `browser:${url}`;
      const created = await createBrowserPanel(testApp.app, initial.panelId, url, {
        focus: true,
      });
      const readiness = await ensureHostedShellReady(testApp.app, {
        panelSource: browserSource,
      });

      expect(readiness.panelId).toBe(created.id);

      await expect
        .poll(() => getPanelText(testApp!.app, readiness.panelId).catch(() => ""), {
          timeout: 30_000,
        })
        .toContain("Browser panel is ready");
    } finally {
      await testApp?.cleanup();
      removeManagedTestWorkspace(workspacePath);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
