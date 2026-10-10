import YAML from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  approvePendingWorkspaceCreationReview,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getManagedTestWorkspaceRoot,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";
import type { E2eRootTemplate } from "../../setup/e2eRootTemplate";
import { declineFirstRunReporting } from "../support/workspaceCreation";
import { waitHostedShellReady } from "../support/commandOverlay";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

async function attachAuthoringExtensionLogs(app: TestApp): Promise<void> {
  const diagnostics = await app.app
    .evaluate(async (_electron, workspaceId) => {
      try {
        const api = await globalThis.__testApi!.forWorkspace(workspaceId);
        const entities = (await api.rpcCall("runtime", "supervision.list", [
          { kind: "extension" },
        ])) as Array<{ identity: { kind: string; entityId: string } }>;
        const extensions = await Promise.all(
          entities.map(async ({ identity }) => {
            try {
              return {
                identity,
                logs: await api.rpcCall("runtime", "supervision.logs", [identity, { limit: 200 }]),
              };
            } catch (error) {
              return {
                identity,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );
        return { workspaceId, extensions };
      } catch (error) {
        return {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }, app.workspaceId)
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  await test.info().attach("authoring-extension-logs.json", {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: "application/json",
  });
}

test("opens publishing and installed sources in the selected workspace", async () => {
  test.setTimeout(300_000);
  let app: TestApp | undefined;
  try {
    app = await launchTestApp({ launchTimeout: 240_000 });
    await waitHostedShellReady(app);
    await declineFirstRunReporting(app);
    const testRoot = getManagedTestWorkspaceRoot(app.workspacePath);
    const caseRootTemplate = JSON.parse(
      fs.readFileSync(path.join(testRoot, "case-root-template.json"), "utf8")
    ) as { template: E2eRootTemplate };
    for (const workspaceId of [app.systemWorkspaceId, app.workspaceId]) {
      await approvePendingWorkspaceCreationReview({ app: app.app, workspaceId });
      const text = await app.app.evaluate(async (_electron, workspaceId) => {
        const api = await globalThis.__testApi!.forWorkspace(workspaceId);
        const state = await api.rpcCall("vcs", "mainState", []);
        const repo = (await api.rpcCall("vcs", "resolveRepository", [
          { state, repoPath: "meta" },
        ])) as { repositoryId: string };
        const file = (await api.rpcCall("vcs", "readFile", [
          {
            state,
            repositoryId: repo.repositoryId,
            file: { kind: "path", path: "vibestudio.yml" },
          },
        ])) as { content: { kind: string; text: string } };
        return file.content.text;
      }, workspaceId);
      const document = YAML.parse(text);
      const expectedTemplate =
        workspaceId === app.systemWorkspaceId
          ? caseRootTemplate.template.defaultTemplates.system
          : caseRootTemplate.template.defaultTemplates.personal;
      expect(document.template.dependencies).toEqual([{ url: expectedTemplate.url }]);
      expect(document.template).not.toHaveProperty("repositories");
      expect(document.template).not.toHaveProperty("installation");
    }
    const expected = caseRootTemplate.template.defaultTemplates;
    const panels = await getPanelTree(app);
    expect(panels.length).toBeGreaterThan(0);
    await createPanel(app, panels[0]!.id, "about/workspace", { focus: true });
    let page: Page | undefined;
    await expect
      .poll(
        async () => {
          for (const candidate of app!.app.context().pages()) {
            if (await candidate.getByRole("tab", { name: "Publish", exact: true }).count()) {
              page = candidate;
              return true;
            }
          }
          return false;
        },
        { timeout: 120_000 }
      )
      .toBe(true);
    await page!
      .getByRole("tab", { name: "Publish", exact: true })
      .dispatchEvent("mousedown", { button: 0, ctrlKey: false });
    await expect(page!.getByRole("heading", { name: /^Publish / })).toBeVisible();
    // Do not accept the fallback heading as readiness: it is also rendered
    // while authoringSetup is still resolving.
    await expect(page!.getByRole("textbox", { name: "GitHub owner" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page!.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    await expect(page!.getByText("Connect GitHub to publish this release.")).toBeVisible();
    const visibility = page!.getByRole("radiogroup", { name: "Repository visibility" });
    await expect(visibility.getByRole("radio", { name: "Private" })).toBeChecked();
    const destination = page!.getByRole("radiogroup", { name: "Repository destination" });
    await destination.getByRole("radio", { name: "Existing repository" }).click();
    await expect(page!.getByRole("textbox", { name: "Find repository" })).toBeVisible();
    await expect(page!.getByRole("button", { name: "Load writable repositories" })).toBeDisabled();
    await destination.getByRole("radio", { name: "New repository" }).click();
    await expect(page!.getByRole("button", { name: "Review release" })).toBeVisible();
    await expect(page!.getByRole("button", { name: "Review release" })).toBeDisabled();
    await test.info().attach("template-publication.png", {
      body: await page!.screenshot(),
      contentType: "image/png",
    });
    await page!
      .getByRole("tab", { name: "Updates", exact: true })
      .dispatchEvent("mousedown", { button: 0, ctrlKey: false });
    await expect(page!.getByRole("heading", { name: "Workspace updates" })).toBeVisible();
    await expect(
      page!.getByText(expected.personal.url.replace(/^git\+/, ""), { exact: true })
    ).toBeVisible();
  } catch (error) {
    console.error("[templateAuthoring] original test failure before extension diagnostics", error);
    if (app) await attachAuthoringExtensionLogs(app).catch(() => undefined);
    throw error;
  } finally {
    await app?.cleanup();
  }
});
