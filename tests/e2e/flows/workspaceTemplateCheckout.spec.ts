import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import {
  requireE2eRootTemplate,
  WORKSPACE_CREATION_DESCRIPTOR_PATH,
} from "../../setup/e2eRootTemplate";
import {
  getPanelTree,
  getPanelReadiness,
  getPanelText,
  launchTestApp,
  approvePendingWorkspaceCreationReview,
  hasElectronDisplay,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  type TestApp,
} from "../../setup/electronSetup";
import { waitHostedShellReady } from "../support/commandOverlay";
import { nativeUiRead } from "../support/nativeUiRead";
import { presentApprovalCard } from "../support/workspaceCreation";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test("opens one explicit checkout directly at its exact dirty review", async () => {
  test.setTimeout(300_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-launch-"));
  let app: TestApp | undefined;
  try {
    const template = requireE2eRootTemplate();
    const source = template.sources.find(
      (item) => item.pin.commit === template.defaultTemplates.base.commit
    )!;
    const checkout = path.join(root, "source");
    execFileSync("git", ["clone", "--local", source.checkout, checkout], { stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", checkout, "remote", "set-url", "origin", "https://example.invalid/launch.git"],
      { stdio: "pipe" }
    );
    const manifestPath = path.join(checkout, "meta/vibestudio.yml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.template.name = "Dirty launch workspace";
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    app = await launchTestApp({ templateCheckouts: [checkout], launchTimeout: 240_000 });
    await waitHostedShellReady(app);
    await approvePendingWorkspaceCreationReview(app);
    let shell: Page | undefined;
    await expect
      .poll(
        async () => {
          for (const page of app!.app.context().pages()) {
            if (await page.getByRole("heading", { name: "Dirty launch workspace" }).count()) {
              shell = page;
              return true;
            }
          }
          return false;
        },
        { timeout: 120_000 }
      )
      .toBe(true);
    await expect(shell!.getByRole("textbox", { name: "Workspace name" })).toBeVisible();
    await test.info().attach("explicit-checkout-review.png", {
      body: await shell!.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await app?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("opens the selected local checkout as a separate workspace after exact review", async () => {
  test.setTimeout(360_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-ui-"));
  let app: TestApp | undefined;
  try {
    // An explicit examples checkout exercises the user's command unchanged.
    // The ordinary suite owns a dirty source fixture with an unreachable remote,
    // so accidentally inspecting or installing from remote Git cannot pass.
    let checkout = process.env["VIBESTUDIO_E2E_TEMPLATE_CHECKOUT"];
    if (!checkout) {
      const template = requireE2eRootTemplate();
      const source = template.sources.find(
        (item) => item.pin.commit === template.defaultTemplates.base.commit
      )!;
      checkout = path.join(root, "source");
      execFileSync("git", ["clone", "--local", source.checkout, checkout], { stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-C",
          checkout,
          "remote",
          "set-url",
          "origin",
          "https://example.invalid/unpublished-workspace.git",
        ],
        { stdio: "pipe" }
      );
      const manifestPath = path.join(checkout, "meta/vibestudio.yml");
      const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.template.name = "Unpublished local workspace";
      fs.writeFileSync(manifestPath, YAML.stringify(manifest));
    }
    app = await launchTestApp({ launchTimeout: 300_000 });
    await waitHostedShellReady(app);
    await approvePendingWorkspaceCreationReview(app);
    for (const workspaceId of [app.systemWorkspaceId, app.workspaceId]) {
      const ids = await app.app.evaluate(async (_electron, workspaceId) => {
        const api = await globalThis.__testApi!.forWorkspace(workspaceId);
        const pending = (await api.rpcCall("shellApproval", "listPending", [])) as Array<{
          kind: string;
          approvalId: string;
        }>;
        return pending
          .filter((item) => item.kind === "unit-install-review")
          .map((item) => item.approvalId);
      }, workspaceId);
      await approvePendingWorkspaceCreationReview({ app: app.app, workspaceId }, ids);
    }
    let chrome: Page | undefined;
    await expect
      .poll(
        async () => {
          for (const candidate of app!.app.context().pages()) {
            if (
              await candidate.getByRole("button", { name: "Add workspace", exact: true }).count()
            ) {
              chrome = candidate;
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const page = chrome!;
    const before = await nativeUiRead<HubWorkspaceEntry[]>(
      page,
      { kind: "hub" },
      "hubControl.listWorkspaces",
      []
    );
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, checkout);
    await page.getByRole("button", { name: "Add workspace", exact: true }).click();
    await page.getByRole("radio", { name: /Folder/ }).click();
    await page.getByRole("button", { name: "Choose folder…", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Workspace name" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unpublished local workspace" })).toBeVisible();
    expect(
      await nativeUiRead<HubWorkspaceEntry[]>(
        page,
        { kind: "hub" },
        "hubControl.listWorkspaces",
        []
      )
    ).toHaveLength(before.length);
    await test.info().attach("local-workspace-review.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.getByRole("textbox", { name: "Workspace name" }).fill("local-checkout-acceptance");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    let after: HubWorkspaceEntry[] = [];
    await expect
      .poll(
        async () => {
          after = await nativeUiRead<HubWorkspaceEntry[]>(
            page,
            { kind: "hub" },
            "hubControl.listWorkspaces",
            []
          );
          return after.length;
        },
        { timeout: 60_000 }
      )
      .toBe(before.length + 1);
    const created = after.find(
      (entry) => !before.some((old) => old.workspaceId === entry.workspaceId)
    )!;
    expect(created.name).toBe("local-checkout-acceptance");
    for (const previous of before)
      expect(after.some((entry) => entry.workspaceId === previous.workspaceId)).toBe(true);
    const descriptorPath = path.join(
      path.dirname(app.workspacePath),
      created.name,
      "state",
      WORKSPACE_CREATION_DESCRIPTOR_PATH
    );
    await expect.poll(() => fs.existsSync(descriptorPath), { timeout: 120_000 }).toBe(true);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    expect(descriptor.rootTemplate.url).toBe(
      "git+https://example.invalid/unpublished-workspace.git"
    );
    expect(descriptor.rootTemplate.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(descriptor.rootTemplate.snapshot).toMatch(/^v1-sha256:[0-9a-f]{64}$/);
    const owner = { app: app.app, workspaceId: created.workspaceId };
    let creationReview: string | null = null;
    await expect
      .poll(
        async () => {
          creationReview = await owner.app.evaluate(async (_electron, workspaceId) => {
            const api = await globalThis.__testApi!.forWorkspace(workspaceId);
            const state = (await api.rpcCall(
              "shellApproval",
              "getWorkspaceCreationReviewState",
              []
            )) as
              | { status: "pending"; approvalId: string }
              | { status: "preparing" | "not-required" | "resolved" | "unresolved" }
              | { status: "failed"; error: string };
            if (state.status === "failed")
              throw new Error(`Workspace creation review failed: ${state.error}`);
            return state.status === "pending" ? state.approvalId : null;
          }, created.workspaceId);
          return creationReview;
        },
        { timeout: 120_000 }
      )
      .not.toBeNull();
    const review = await presentApprovalCard(page, creationReview!);
    await review.getByRole("button", { name: "Add to workspace", exact: true }).click();
    await expect
      .poll(
        () =>
          owner.app.evaluate(async (_electron, workspaceId) => {
            const api = await globalThis.__testApi!.forWorkspace(workspaceId);
            return (await api.rpcCall("shellApproval", "getWorkspaceCreationReviewState", [])) as {
              status: string;
            };
          }, created.workspaceId),
        { timeout: 120_000 }
      )
      .toEqual({ status: "resolved" });
    await expect
      .poll(async () => (await getPanelTree(owner)).length, { timeout: 120_000 })
      .toBeGreaterThan(0);
    await expect(page.getByLabel(`${created.name} workspace`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    const expectedPanelSource = process.env["VIBESTUDIO_E2E_EXPECTED_PANEL_SOURCE"] ?? "about/new";
    const expectedPanelText =
      process.env["VIBESTUDIO_E2E_EXPECTED_PANEL_TEXT"] ?? "Jump to a panel";
    const loadingPanelText = process.env["VIBESTUDIO_E2E_LOADING_PANEL_TEXT"];
    const settledPanelText = process.env["VIBESTUDIO_E2E_SETTLED_PANEL_TEXT"];
    const panelActionLabel = process.env["VIBESTUDIO_E2E_PANEL_ACTION_LABEL"];
    const panelActionResultText = process.env["VIBESTUDIO_E2E_PANEL_ACTION_RESULT_TEXT"];
    const initialPanel = (await getPanelTree(owner)).find(
      (panel) => panel.snapshot?.source === expectedPanelSource
    );
    expect(initialPanel).toBeDefined();
    await expect
      .poll(
        async () => {
          const { presentation } = await getPanelReadiness(owner, initialPanel!.id);
          return presentation.state === "ready" || presentation.state === "failed";
        },
        { timeout: 120_000 }
      )
      .toBe(true);
    const readiness = await getPanelReadiness(owner, initialPanel!.id);
    if (readiness.presentation.state === "failed")
      throw new Error(`Initial panel failed: ${readiness.presentation.message}`);

    await expect
      .poll(
        async () => {
          try {
            return await getPanelText(owner, initialPanel!.id);
          } catch (error) {
            // A committed tree node precedes native view creation. Only that
            // known pending state is retryable; renderer errors still fail here.
            if (String(error).includes(`Panel WebContents not available: ${initialPanel!.id}`))
              return "";
            throw error;
          }
        },
        { timeout: 120_000 }
      )
      .toContain(expectedPanelText);
    if (loadingPanelText) {
      await expect
        .poll(async () => await getPanelText(owner, initialPanel!.id), {
          timeout: 120_000,
        })
        .not.toContain(loadingPanelText);
    }
    if (settledPanelText) {
      await expect
        .poll(async () => await getPanelText(owner, initialPanel!.id), {
          timeout: 120_000,
        })
        .toContain(settledPanelText);
    }
    if (panelActionLabel) {
      await app.app.evaluate(
        ({ webContents }, input) => {
          const contents = webContents.fromId(input.webContentsId);
          if (!contents) throw new Error("The initial panel was destroyed");
          return contents.executeJavaScript(`(() => {
            const action = Array.from(document.querySelectorAll('button')).find(
              (candidate) =>
                candidate.getAttribute('aria-label') === ${JSON.stringify(input.label)} ||
                candidate.textContent?.trim() === ${JSON.stringify(input.label)}
            );
            if (!(action instanceof HTMLButtonElement))
              throw new Error('Panel action is not available');
            if (action.disabled) throw new Error('Panel action is disabled');
            action.click();
          })()`);
        },
        {
          webContentsId: readiness.presentation.webContentsId,
          label: panelActionLabel,
        }
      );
      if (panelActionResultText) {
        await expect
          .poll(async () => await getPanelText(owner, initialPanel!.id), {
            timeout: 30_000,
          })
          .toContain(panelActionResultText);
      }
    }
    if (process.env["VIBESTUDIO_E2E_ASSERT_NO_HORIZONTAL_OVERFLOW"] === "1") {
      await app.app.evaluate(({ BaseWindow }) => {
        const window = BaseWindow.getAllWindows().find((candidate) => candidate.isVisible());
        if (!window) throw new Error("The workspace window is not visible");
        const bounds = window.getBounds();
        window.setBounds({ ...bounds, width: 720 });
      });
      const readPanelWidth = () =>
        app.app.evaluate(async ({ webContents }, id) => {
          const contents = webContents.fromId(id);
          if (!contents) throw new Error("The initial panel was destroyed");
          return contents.executeJavaScript(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
          })`);
        }, readiness.presentation.webContentsId);
      await expect
        .poll(async () => (await readPanelWidth()).clientWidth, { timeout: 30_000 })
        .toBeLessThan(720);
      const narrowPanel = await readPanelWidth();
      expect(narrowPanel.scrollWidth).toBeLessThanOrEqual(narrowPanel.clientWidth);
      await test.info().attach("narrow-panel.png", {
        body: await app.app.evaluate(async ({ webContents }, id) => {
          const contents = webContents.fromId(id);
          if (!contents) throw new Error("The initial panel was destroyed");
          return (await contents.capturePage()).toPNG();
        }, readiness.presentation.webContentsId),
        contentType: "image/png",
      });
    }
    // Capture the actual native panel pixels before the whole display. DOM text
    // and animation callbacks can precede compositor delivery under Xvfb.
    if (readiness.presentation.state !== "ready")
      throw new Error("The initial panel is not presented");
    const nativeState = await app.app.evaluate(async ({ BaseWindow, webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error("The initial panel was destroyed");
      return {
        panelImage: (await contents.capturePage()).toPNG().toString("base64"),
        windows: BaseWindow.getAllWindows().map((window) => ({
          bounds: window.getBounds(),
          children: window.contentView.children.map((view) => ({
            bounds: view.getBounds(),
            visible: view.getVisible(),
            webContentsId:
              "webContents" in view ? (view as Electron.WebContentsView).webContents.id : null,
          })),
        })),
      };
    }, readiness.presentation.webContentsId);
    await test.info().attach("initial-panel.png", {
      body: Buffer.from(nativeState.panelImage, "base64"),
      contentType: "image/png",
    });
    await test.info().attach("native-presentation.json", {
      body: JSON.stringify({ readiness, windows: nativeState.windows }, null, 2),
      contentType: "application/json",
    });
    await test.info().attach("created-workspace.png", {
      body: Buffer.from(
        await app.app.evaluate(async ({ BaseWindow, desktopCapturer, screen }) => {
          const window = BaseWindow.getAllWindows().find((candidate) => candidate.isVisible());
          if (!window) throw new Error("The workspace window is not visible");
          const bounds = window.getBounds();
          const display = screen.getDisplayMatching(bounds);
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: display.size,
          });
          const source = sources.find((candidate) => candidate.display_id === String(display.id));
          if (!source || source.thumbnail.isEmpty())
            throw new Error(
              `Cannot capture display ${display.id}: ${JSON.stringify(sources.map(({ id, display_id }) => ({ id, display_id })))}`
            );
          return source.thumbnail
            .crop({
              x: bounds.x - display.bounds.x,
              y: bounds.y - display.bounds.y,
              width: bounds.width,
              height: bounds.height,
            })
            .toPNG()
            .toString("base64");
        }),
        "base64"
      ),
      contentType: "image/png",
    });
  } finally {
    await app?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
