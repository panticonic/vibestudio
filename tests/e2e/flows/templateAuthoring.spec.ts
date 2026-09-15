import YAML from "yaml";
import { expect, test, type Page } from "@playwright/test";
import {
  approvePendingWorkspaceCreationReview,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";
import { requireE2eRootTemplate } from "../../setup/e2eRootTemplate";
import { waitHostedShellReady } from "../support/commandOverlay";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test("opens publishing and installed sources in the selected workspace", async () => {
  test.setTimeout(300_000);
  let app: TestApp | undefined;
  try {
    app = await launchTestApp({ launchTimeout: 240_000 });
    await waitHostedShellReady(app);
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
          ? requireE2eRootTemplate().defaultTemplates.system
          : requireE2eRootTemplate().defaultTemplates.personal;
      expect(document.template.dependencies).toEqual([{ url: expectedTemplate.url }]);
      expect(document.template.repositories).toEqual(["meta"]);
      expect(document.template.installation.upstream).toBeUndefined();
    }
    const panels = await getPanelTree(app);
    expect(panels.length).toBeGreaterThan(0);
    await createPanel(app, panels[0]!.id, "about/templates", { focus: true });
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
    await expect(
      page!.getByRole("heading", { name: "Publish this workspace as a template" })
    ).toBeVisible();
    await expect(page!.getByRole("textbox", { name: "GitHub owner" })).toBeVisible();
    await expect(page!.getByRole("combobox", { name: "GitHub account" })).toBeVisible();
    await expect(page!.getByRole("combobox", { name: "Repository visibility" })).toHaveValue(
      "private"
    );
    await page!.getByRole("combobox", { name: "Repository destination" }).selectOption("existing");
    await expect(page!.getByRole("combobox", { name: "Existing repository" })).toBeVisible();
    await expect(page!.getByRole("button", { name: "Load writable repositories" })).toBeDisabled();
    await page!.getByRole("combobox", { name: "Repository destination" }).selectOption("new");
    await expect(page!.getByRole("button", { name: "Review release" })).toBeVisible();
    await test.info().attach("template-publication.png", {
      body: await page!.screenshot(),
      contentType: "image/png",
    });
    await page!
      .getByRole("tab", { name: "Installed", exact: true })
      .dispatchEvent("mousedown", { button: 0, ctrlKey: false });
    await expect(page!.getByRole("heading", { name: "Installed templates" })).toBeVisible();
    await expect(page!.getByRole("combobox", { name: "Template source" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page!.getByRole("alert")).toHaveCount(0);
    const sources = await page!
      .getByRole("combobox", { name: "Template source" })
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)
      );
    const expected = requireE2eRootTemplate().defaultTemplates;
    expect(sources.at(-1)).toBe(expected.personal.url);
    expect(sources).not.toContain(expected.system.url);
  } finally {
    await app?.cleanup();
  }
});
