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
  getPanelReadiness,
  getPanelText,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function configureWithoutBrowserDataExtension(sourceRoot: string): void {
  const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as {
    initPanels?: Array<{ source: string }>;
    extensions?: Array<{ source: string }>;
    providers?: Record<string, unknown>;
  };
  config["initPanels"] = [{ source: "about/new" }];
  config.extensions = config.extensions?.filter(
    (extension) => extension.source !== "extensions/browser-data"
  );
  if (config.providers) delete config.providers["browserData"];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

test.describe("Browser panel startup", () => {
  test("loads while the optional browser-data extension is unavailable", async () => {
    test.setTimeout(240_000);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><title>Browser fixture</title><p>Browser panel is ready</p><a id="add-workspace" href="vibestudio://surface?v=1&amp;kind=workspace-chooser&amp;source=https%3A%2F%2Fexample.test%2Flinked-workspace.git">Add linked workspace</a>'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Browser fixture did not listen");
    const url = `http://127.0.0.1:${address.port}/`;
    const workspacePath = await createManagedTestWorkspace({
      configureSource: configureWithoutBrowserDataExtension,
    });
    let testApp: TestApp | null = null;

    try {
      testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);
      const initial = await ensureHostedShellReady(testApp, { panelSource: "about/new" });
      const browserSource = `browser:${url}`;
      const created = await createBrowserPanel(testApp, initial.panelId, url, {
        focus: true,
      });
      const readiness = await ensureHostedShellReady(testApp, {
        panelSource: browserSource,
      });

      expect(readiness.panelId).toBe(created.id);

      await expect
        .poll(() => getPanelText(testApp!, readiness.panelId).catch(() => ""), {
          timeout: 30_000,
        })
        .toContain("Browser panel is ready");

      const browserReadiness = await getPanelReadiness(testApp, readiness.panelId);
      if (browserReadiness.presentation.state !== "ready")
        throw new Error("Browser panel did not reach native readiness");
      await testApp.app.evaluate(async ({ webContents }, webContentsId) => {
        const contents = webContents.fromId(webContentsId);
        if (!contents) throw new Error("Browser panel WebContents is unavailable");
        await contents.executeJavaScript(
          `document.querySelector('#add-workspace').click()`
        );
      }, browserReadiness.presentation.webContentsId);
      let shell: import("@playwright/test").Page | undefined;
      await expect
        .poll(async () => {
          for (const page of testApp!.app.context().pages()) {
            if (await page.getByRole("textbox", { name: "Workspace source address" }).count()) {
              shell = page;
              return true;
            }
          }
          return false;
        })
        .toBe(true);
      await expect(shell!.getByRole("textbox", { name: "Workspace source address" })).toHaveValue(
        "https://example.test/linked-workspace.git"
      );
    } finally {
      await testApp?.cleanup();
      removeManagedTestWorkspace(workspacePath);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
