import { expect, test, type Page } from "@playwright/test";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { viewMethods } from "@vibestudio/service-schemas/view";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import { nativeUiRead } from "../support/nativeUiRead";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getNativePanelSlotDebugInfo,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  approvePendingStartupUnits,
  type TestApp,
} from "../../setup/electronSetup";
import {
  declineFirstRunReporting,
  findWorkspaceShellPage,
  presentApprovalCard,
} from "../support/workspaceCreation";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type WebContentsSnapshot = {
  id: number;
  url: string;
  title: string;
  text: string;
  hasTitlebar: boolean;
  hasApprovalBar: boolean;
  workspaceLabels: string[];
};

async function listWebContents(testApp: TestApp): Promise<WebContentsSnapshot[]> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const snapshots: WebContentsSnapshot[] = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      const title = contents.getTitle();
      let dom: {
        text: string;
        hasTitlebar: boolean;
        hasApprovalBar: boolean;
        workspaceLabels: string[];
      } | null = null;
      try {
        dom = await contents.executeJavaScript(
          `({
            text: document.body?.innerText ?? "",
            hasTitlebar: !!document.querySelector('[data-shell-top-chrome="titlebar"]')
              || !!document.querySelector(".titlebar-breadcrumb-scroll")
              || !!document.querySelector('[aria-label="Menu"]'),
            hasApprovalBar: !!document.querySelector(".approval-card, .approval-pill"),
            workspaceLabels: [...document.querySelectorAll(".workspace-stack section")].map(node => node.getAttribute("aria-label") ?? ""),
          })`,
          true
        );
      } catch {
        dom = null;
      }
      snapshots.push({
        id: contents.id,
        url,
        title,
        text: dom?.text ?? "",
        hasTitlebar: dom?.hasTitlebar ?? false,
        hasApprovalBar: dom?.hasApprovalBar ?? false,
        workspaceLabels: dom?.workspaceLabels ?? [],
      });
    }
    return snapshots;
  });
}

async function getPanelSurfaceLayout(shellPage: Page): Promise<{
  surfaces: Array<{
    nativeSlotId: string;
    panelId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    bottom: number;
  }>;
  approval: { x: number; y: number; width: number; height: number; bottom: number } | null;
  topChrome: { x: number; y: number; width: number; height: number; bottom: number }[];
  sidebar: { x: number; y: number; width: number; height: number; bottom: number } | null;
  shellState?: {
    columns: string | null;
    restored: string | null;
    visiblePanels: string | null;
    rootPanels: string | null;
    residentColumns: string | null;
    panelContentStates: Array<{
      panelId: string | null;
      state: string | null;
      buildKey: string | null;
      buildState: string | null;
      runtimePhase: string | null;
    }>;
  };
}> {
  return shellPage.evaluate(() => {
    const rectFor = (node: Element | null) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
      };
    };
    const surfaces = Array.from(document.querySelectorAll("[data-native-panel-slot-id]"))
      .map((node) => {
        const rect = rectFor(node);
        const nativeSlotId = node.getAttribute("data-native-panel-slot-id");
        const panelId = node.getAttribute("data-panel-id");
        return rect && nativeSlotId && panelId ? { nativeSlotId, panelId, ...rect } : null;
      })
      .filter((surface) => surface !== null);
    const shellLayout = document.querySelector("[data-shell-layout-columns]");
    return {
      surfaces,
      approval: rectFor(document.querySelector(".approval-card, .approval-pill")),
      topChrome: Array.from(document.querySelectorAll("[data-shell-top-chrome]"))
        .map(rectFor)
        .filter((rect) => rect !== null),
      sidebar: rectFor(document.querySelector("[data-shell-panel-sidebar]")),
      ...(shellLayout
        ? {
            shellState: {
              columns: shellLayout.getAttribute("data-shell-layout-columns"),
              restored: shellLayout.getAttribute("data-shell-layout-restored"),
              visiblePanels: shellLayout.getAttribute("data-shell-layout-visible-panels"),
              rootPanels: shellLayout.getAttribute("data-shell-layout-root-panels"),
              residentColumns: shellLayout.getAttribute("data-shell-layout-resident-columns"),
              panelContentStates: Array.from(
                document.querySelectorAll("[data-panel-content-state]")
              ).map((node) => ({
                panelId: node.getAttribute("data-panel-id"),
                state: node.getAttribute("data-panel-content-state"),
                buildKey: node.getAttribute("data-panel-build-key"),
                buildState: node.getAttribute("data-panel-build-state"),
                runtimePhase: node.getAttribute("data-panel-runtime-phase"),
              })),
            },
          }
        : {}),
    };
  });
}

async function approveStartupUnitsAndDeclineReporting(testApp: TestApp): Promise<void> {
  await approvePendingStartupUnits(testApp);
  await declineFirstRunReporting(testApp);
}

async function workspaceReviewState(
  page: Page,
  workspaceId: string
): Promise<{ status: string; approvalId?: string; error?: string }> {
  return nativeUiRead(
    page,
    { kind: "workspace", workspaceId },
    "shellApproval.getWorkspaceCreationReviewState",
    []
  );
}

async function approveWorkspaceCreationReviewInShell(
  page: Page,
  workspaceId: string
): Promise<void> {
  await expect
    .poll(async () => (await workspaceReviewState(page, workspaceId)).status, {
      timeout: 120_000,
    })
    .not.toBe("preparing");
  let state = await workspaceReviewState(page, workspaceId);
  if (state.status === "failed") {
    throw new Error(`Workspace creation review failed: ${state.error}`);
  }
  if (state.status === "pending") {
    if (!state.approvalId) throw new Error("Pending workspace review has no approval ID");
    const card = await presentApprovalCard(page, state.approvalId);
    expect(await card.getAttribute("data-approval-id")).toBe(state.approvalId);
    await card.getByRole("button", { name: "Add to workspace", exact: true }).click();
    await expect
      .poll(() => workspaceReviewState(page, workspaceId), { timeout: 120_000 })
      .toMatchObject({ status: "resolved" });
    state = await workspaceReviewState(page, workspaceId);
  }
  expect(["resolved", "not-required"]).toContain(state.status);
}

test.describe("Desktop Shell Chrome", () => {
  test.setTimeout(240_000);

  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("mounts the dynamic shell app with custom titlebar chrome", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsAndDeclineReporting(testApp);

    let lastSnapshots: WebContentsSnapshot[] = [];
    try {
      await expect
        .poll(
          async () => {
            lastSnapshots = await listWebContents(testApp!);
            return lastSnapshots.some((snapshot) => {
              let pathname = "";
              try {
                pathname = new URL(snapshot.url).pathname;
              } catch {
                return false;
              }
              return (
                pathname.includes("/_a/") &&
                pathname.endsWith("/index.html") &&
                snapshot.hasTitlebar &&
                snapshot.workspaceLabels.includes("Personal workspace") &&
                snapshot.workspaceLabels.includes("System workspace")
              );
            });
          },
          { timeout: 120_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
      const chromeId = await testApp.app.evaluate(
        ({ webContents }) =>
          webContents
            .getAllWebContents()
            .find(
              (contents) =>
                !contents.isDestroyed() &&
                contents.getURL().includes("/_a/") &&
                contents.getURL().endsWith("/index.html")
            )!.id
      );
      for (const workspace of ["Personal", "System", "Personal"]) {
        await testApp.app.evaluate(
          async ({ webContents }, { chromeId, workspace }) => {
            const chrome = webContents.fromId(chromeId);
            if (!chrome || chrome.isDestroyed())
              throw new Error("Workspace switching replaced the desktop chrome");
            await chrome.executeJavaScript(
              `document.querySelector('[aria-label="Open ${workspace}"]').click()`
            );
          },
          { chromeId, workspace }
        );
        await expect
          .poll(
            () =>
              testApp!.app.evaluate(
                async ({ webContents }, { chromeId, workspace }) => {
                  const chrome = webContents.fromId(chromeId);
                  if (!chrome || chrome.isDestroyed()) return false;
                  return chrome.executeJavaScript(
                    `document.querySelector('.workspace-section-focused')?.getAttribute('aria-label') === '${workspace} workspace'`
                  );
                },
                { chromeId, workspace }
              ),
            { timeout: 60_000 }
          )
          .toBe(true);
      }
      // Personal's startup review consumes a worker receiver declaration even
      // though the worker itself does not require privileged-code admission.
      const shellPage = await findWorkspaceShellPage(testApp);
      const workspaces = await nativeUiRead<Array<{ workspaceId: string; privateRole?: string }>>(
        shellPage,
        { kind: "hub" },
        "hubControl.listWorkspaces",
        []
      );
      const personal = workspaces.find((workspace) => workspace.privateRole === "personal");
      expect(personal).toBeTruthy();
      let browserReview:
        | import("@vibestudio/shared/approvals").PendingUnitInstallReviewApproval
        | undefined;
      await expect
        .poll(
          async () => {
            const pending = await nativeUiRead<
              import("@vibestudio/shared/approvals").PendingApproval[]
            >(
              shellPage,
              { kind: "workspace", workspaceId: personal!.workspaceId },
              "shellApproval.listPending",
              []
            );
            browserReview = pending.find(
              (approval) =>
                approval.kind === "unit-install-review" &&
                approval.parts.some((part) =>
                  part.identityKey.startsWith("extensions/browser-data@")
                )
            );
            return Boolean(browserReview);
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      if (!browserReview) throw new Error("The browser-data declaration review disappeared");
      const reviewCard = await presentApprovalCard(shellPage, browserReview.approvalId);
      const browserDataRow = reviewCard.locator(
        '[data-part-row][data-identity-key^="extensions/browser-data@"]'
      );
      await expect(browserDataRow).toBeVisible();
      if (
        (await browserDataRow.getAttribute("aria-current")) !== "true" &&
        (await browserDataRow.getAttribute("aria-expanded")) !== "true"
      ) {
        await browserDataRow.click();
      }
      const browserDataDetail = reviewCard.locator(".install-review-detail").filter({
        hasText: "delete persistent browser data",
      });
      await expect(browserDataDetail).toBeVisible();
      expect(await browserDataDetail.innerText()).not.toContain("doesn't recognize");
      const screenshot = await testApp.app.evaluate(async ({ webContents }) => {
        const chrome = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              !contents.isDestroyed() &&
              contents.getURL().includes("/_a/") &&
              contents.getURL().endsWith("/index.html")
          );
        if (!chrome) throw new Error("System desktop chrome disappeared");
        return (await chrome.capturePage()).toPNG().toString("base64");
      });
      expect(Buffer.from(screenshot, "base64").length).toBeGreaterThan(0);
      await test.info().attach("workspace-desktop.png", {
        body: Buffer.from(screenshot, "base64"),
        contentType: "image/png",
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nLast WebContents snapshots: ${JSON.stringify(lastSnapshots)}\nElectron output tail:\n${testApp.getOutput().slice(-20_000)}`
      );
    }
  });

  test("presents every private workspace review before using the workspace catalog", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsAndDeclineReporting(testApp);
    let page: Page | undefined;
    await expect
      .poll(
        () => {
          page = testApp!.app
            .context()
            .pages()
            .find(
              (candidate) =>
                candidate.url().includes("/_a/") && candidate.url().endsWith("/index.html")
            );
          return Boolean(page);
        },
        { timeout: 120_000 }
      )
      .toBe(true);
    const chrome = page!;
    const rendererDiagnostics: string[] = [];
    chrome.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        rendererDiagnostics.push(message.text());
    });
    chrome.on("pageerror", (error) => rendererDiagnostics.push(error.message));
    const workspaces = await nativeUiRead<Array<{ workspaceId: string; privateRole?: string }>>(
      chrome,
      { kind: "hub" },
      "hubControl.listWorkspaces",
      []
    );
    const privateWorkspaces = workspaces.filter(
      (workspace) => workspace.privateRole === "personal" || workspace.privateRole === "system"
    );
    expect(privateWorkspaces).toHaveLength(2);
    for (const workspace of privateWorkspaces) {
      await expect
        .poll(
          async () =>
            (
              await nativeUiRead<{ status: string }>(
                chrome,
                { kind: "workspace", workspaceId: workspace.workspaceId },
                "shellApproval.getWorkspaceCreationReviewState",
                []
              )
            ).status,
          { timeout: 60_000 }
        )
        .not.toBe("preparing");
    }
    const pendingReviews = async () =>
      (
        await Promise.all(
          privateWorkspaces.map(async (workspace) => {
            const pending = await nativeUiRead<
              import("@vibestudio/shared/approvals").PendingApproval[]
            >(
              chrome,
              { kind: "workspace", workspaceId: workspace.workspaceId },
              "shellApproval.listPending",
              []
            );
            return pending
              .filter((approval) => approval.kind === "unit-install-review")
              .map((approval) => ({
                workspace: workspace.privateRole,
                id: approval.approvalId,
                parts: approval.parts.map((part) => part.repoPath),
              }));
          })
        )
      ).flat();
    for (let pass = 0; pass < 8; pass++) {
      const pending = await pendingReviews();
      if (!pending.length) break;
      const review = pending[0]!;
      const card = await presentApprovalCard(chrome, review.id);
      expect(await card.getAttribute("data-approval-id")).toBe(review.id);
      await expect(
        card.getByRole("button", { name: "Add to workspace", exact: true })
      ).toBeVisible();
      await card.getByRole("button", { name: "Add to workspace", exact: true }).click();
      await expect
        .poll(
          async () => (await pendingReviews()).some((candidate) => candidate.id === review.id),
          {
            timeout: 60_000,
          }
        )
        .toBe(false);
    }
    expect(await pendingReviews()).toEqual([]);
    for (const workspace of privateWorkspaces) {
      await expect
        .poll(
          async () =>
            (
              await nativeUiRead<{ status: string }>(
                chrome,
                { kind: "workspace", workspaceId: workspace.workspaceId },
                "shellApproval.getWorkspaceCreationReviewState",
                []
              )
            ).status,
          { timeout: 60_000 }
        )
        .toBe("resolved");
    }
    await chrome.getByRole("button", { name: "Add workspace", exact: true }).click();
    await chrome.getByRole("radio", { name: "Templates Find your starting point" }).click();
    await expect(
      chrome.getByRole("heading", { name: "Choose your starting point", exact: true })
    ).toBeVisible();
    try {
      let approvalPage: Page | undefined;
      await expect
        .poll(
          () => {
            approvalPage = chrome
              .context()
              .pages()
              .find((candidate) => candidate.url().endsWith("#overlaySurface=approval-card"));
            return Boolean(approvalPage);
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      const networkCard = approvalPage!.locator("[data-approval-card]");
      await expect(networkCard).toContainText("raw.githubusercontent.com");
      await expect(
        networkCard.getByRole("button", { name: "Connect once", exact: true })
      ).toBeVisible();
      await networkCard
        .getByRole("button", { name: "Connect once", exact: true })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(chrome.getByRole("button", { name: "Review News", exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } catch (error) {
      await test.info().attach("catalog-surfaces.json", {
        body: JSON.stringify(
          {
            surfaces: chrome
              .context()
              .pages()
              .map((page) => page.url()),
            rendererDiagnostics,
            anchors: await chrome.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '[id*="approval-host"], .workspace-desktop-notifications'
                ),
              ].map((element) => ({
                id: element.id,
                rect: element.getBoundingClientRect().toJSON(),
                html: element.outerHTML.slice(0, 1000),
              }))
            ),
          },
          null,
          2
        ),
        contentType: "application/json",
      });
      const pending = await Promise.all(
        privateWorkspaces.map(async (workspace) => ({
          workspace: workspace.privateRole,
          pending: await nativeUiRead(
            chrome,
            { kind: "workspace", workspaceId: workspace.workspaceId },
            "shellApproval.listPending",
            []
          ),
        }))
      );
      await test.info().attach("catalog-pending-approvals.json", {
        body: JSON.stringify(pending, null, 2),
        contentType: "application/json",
      });
      throw error;
    }
  });

  test("copies one selected file between workspaces into an unpublished review branch", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsAndDeclineReporting(testApp);
    let chrome: Page | undefined;
    await expect
      .poll(
        () => {
          chrome = testApp!.app
            .context()
            .pages()
            .find((page) => page.url().includes("/_a/") && page.url().endsWith("/index.html"));
          return Boolean(chrome);
        },
        { timeout: 120_000 }
      )
      .toBe(true);
    const page = chrome!;
    const rendererDiagnostics: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        rendererDiagnostics.push(message.text());
        if (rendererDiagnostics.length > 50) rendererDiagnostics.shift();
      }
    });
    page.on("pageerror", (error) => rendererDiagnostics.push(error.message));
    try {
      await expect(page.locator('[aria-label="Open Personal"]')).toBeVisible({ timeout: 60_000 });
      const hub = createTypedServiceClient(
        "hubControl",
        hubControlMethods,
        (service, method, args) => nativeUiRead(page, { kind: "hub" }, `${service}.${method}`, args)
      );
      const workspaces = await hub.listWorkspaces();
      const personal = workspaces.find((workspace) => workspace.privateRole === "personal")!;
      const system = workspaces.find((workspace) => workspace.privateRole === "system")!;
      expect(personal).toBeTruthy();
      expect(system).toBeTruthy();
      const approveVisibleStartupReviews = async (workspaceId: string) => {
        const approvals = createTypedServiceClient(
          "shellApproval",
          shellApprovalMethods,
          (service, method, args) =>
            nativeUiRead(page, { kind: "workspace", workspaceId }, `${service}.${method}`, args)
        );
        await expect
          .poll(async () => (await approvals.getWorkspaceCreationReviewState()).status, {
            timeout: 60_000,
          })
          .not.toBe("preparing");
        for (let pass = 0; pass < 8; pass++) {
          const queued = await approvals.listPending();
          if (workspaceId !== system.workspaceId) {
            expect(
              queued.filter(
                (approval) =>
                  approval.kind === "unit-install-review" &&
                  approval.parts.some((part) => part.kind === "app")
              ),
              "Only the designated System workspace can ask to start native apps"
            ).toEqual([]);
          }
          const pending = queued.filter((approval) => approval.kind === "unit-install-review");
          if (!pending.length) return;
          const approval = pending[0]!;
          const card = await presentApprovalCard(page, approval.approvalId);
          expect(await card.getAttribute("data-approval-id")).toBe(approval.approvalId);
          await card.getByRole("button", { name: "Add to workspace", exact: true }).click();
          await expect
            .poll(
              async () =>
                (await approvals.listPending()).some(
                  (item) => item.approvalId === approval.approvalId
                ),
              { timeout: 60_000 }
            )
            .toBe(false);
        }
        throw new Error("Startup reviews did not settle");
      };
      const focusedName = await page
        .locator(".workspace-section-focused .workspace-section-name")
        .innerText();
      const focused = workspaces.find(
        (workspace) =>
          workspace.privateRole === focusedName.toLowerCase() || workspace.name === focusedName
      )!;
      expect(focused).toBeTruthy();
      await approveVisibleStartupReviews(focused.workspaceId);
      if (focused.workspaceId !== personal.workspaceId)
        await page.getByRole("button", { name: "Open Personal", exact: true }).click();
      await expect(page.locator(".workspace-section-focused")).toHaveAttribute(
        "aria-label",
        "Personal workspace"
      );
      await approveVisibleStartupReviews(personal.workspaceId);
      const vcs = (workspaceId: string) =>
        createTypedServiceClient("vcs", vcsMethods, (service, method, args) =>
          nativeUiRead(page, { kind: "workspace", workspaceId }, `${service}.${method}`, args)
        );
      const sourceVcs = vcs(personal.workspaceId);
      const targetVcs = vcs(system.workspaceId);
      const sourceState = await sourceVcs.mainState();
      const sourceRepo = await sourceVcs.resolveRepository({
        state: sourceState,
        repoPath: "projects/default",
      });
      expect(sourceRepo).toBeTruthy();
      const sourceFile = await sourceVcs.readFile({
        state: sourceState,
        repositoryId: sourceRepo!.repositoryId,
        file: { kind: "path", path: "Welcome.mdx" },
      });
      expect(sourceFile).toBeTruthy();
      const targetMain = await targetVcs.mainState();
      expect(
        await targetVcs.resolveRepository({
          state: targetMain,
          repoPath: "projects/copied-welcome",
        })
      ).toBeNull();
      await approveVisibleStartupReviews(personal.workspaceId);
      const personalPanels = createTypedServiceClient(
        "view",
        viewMethods,
        (service, method, args) =>
          nativeUiRead(
            page,
            { kind: "workspace", workspaceId: personal.workspaceId },
            `${service}.${method}`,
            args
          )
      );
      const panelId = await page
        .locator("[data-native-panel-slot-id][data-panel-id]")
        .filter({ visible: true })
        .first()
        .getAttribute("data-panel-id");
      expect(panelId).toBeTruthy();
      await expect
        .poll(async () => (await personalPanels.getLocalPresentation(panelId!)).presentation, {
          timeout: 60_000,
        })
        .toMatchObject({ state: "ready", surface: "code" });
      const presentation = (await personalPanels.getLocalPresentation(panelId!)).presentation;
      if (presentation.state !== "ready") throw new Error("Personal New panel stopped being ready");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Templates", exact: true }).click();
      await page.getByRole("tab", { name: "Copy selected files", exact: true }).click();
      await expect(page.locator("#source-copy-workspace")).toContainText("Personal");
      await page.getByRole("button", { name: "Browse files", exact: true }).click();
      await page.getByRole("checkbox", { name: "Copy Welcome.mdx", exact: true }).check();
      await page.locator("#source-copy-destination").click();
      await page.getByRole("option", { name: "System", exact: true }).click();
      await page.locator("#source-copy-destination-path").fill("projects/copied-welcome");
      await page.getByRole("button", { name: "Review 1 file", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Review your copy", exact: true })
      ).toBeVisible();
      await expect(page.locator(".source-copy-route")).toContainText("Personal");
      await expect(page.locator(".source-copy-route")).toContainText("System");
      await expect(page.locator(".source-copy-audience")).toContainText("Only you");
      await expect(page.locator(".source-copy-destination-note")).toContainText(
        "projects/copied-welcome"
      );
      await expect(page.locator(".source-copy-files .source-copy-file")).toHaveCount(1);
      await expect(page.locator(".source-copy-files")).toContainText("Welcome.mdx");
      expect(await targetVcs.mainState()).toEqual(targetMain);
      await page.getByRole("button", { name: "Copy 1 file", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Your files are ready to review", exact: true })
      ).toBeVisible({ timeout: 60_000 });
      await page.getByText("Review branch details", { exact: true }).click();
      const contextId = (await page
        .locator(".source-copy-branch .source-copy-path")
        .textContent())!.trim();
      expect(contextId).toMatch(/^file-copy-/);
      const status = await targetVcs.status({ contextId });
      const repository = await targetVcs.resolveRepository({
        state: status.workingHead,
        repoPath: "projects/copied-welcome",
      });
      expect(repository).toBeTruthy();
      const copied = await targetVcs.listFiles({
        state: status.workingHead,
        repositoryId: repository!.repositoryId,
        limit: 200,
      });
      expect(copied.files.map((file) => file.path)).toEqual(["Welcome.mdx"]);
      const result = await targetVcs.readFile({
        state: status.workingHead,
        repositoryId: repository!.repositoryId,
        file: { kind: "path", path: "Welcome.mdx" },
      });
      expect(result?.contentHash).toBe(sourceFile!.contentHash);
      expect(result?.content).toEqual(sourceFile!.content);
      expect(await targetVcs.mainState()).toEqual(targetMain);
      expect(
        await targetVcs.resolveRepository({
          state: await targetVcs.mainState(),
          repoPath: "projects/copied-welcome",
        })
      ).toBeNull();
      await test.info().attach("selected-copy-native.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    } catch (error) {
      await test.info().attach("selected-copy-renderer-errors.txt", {
        body: rendererDiagnostics.join("\n"),
        contentType: "text/plain",
      });
      await test.info().attach("selected-copy-dom.txt", {
        body: await page.locator("body").innerText(),
        contentType: "text/plain",
      });
      throw new Error(
        `${error instanceof Error ? error.stack : error}\nElectron output tail:\n${testApp.getOutput().slice(-20_000)}`
      );
    }
  });

  test("places the native panel exactly in the measured shell panel surface", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsAndDeclineReporting(testApp);
    const shellPage = await findWorkspaceShellPage(testApp);
    await approveWorkspaceCreationReviewInShell(shellPage, testApp.systemWorkspaceId);
    if (testApp.workspaceId !== testApp.systemWorkspaceId) {
      await approveWorkspaceCreationReviewInShell(shellPage, testApp.workspaceId);
    }
    const nativeBounds = () =>
      testApp!.app.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().flatMap((window) =>
          window.contentView.children
            .filter((view) => view.getVisible())
            .map((view) => view.getBounds())
        )
      );

    let lastState: unknown = null;
    try {
      await expect
        .poll(
          async () => {
            const views = await nativeBounds();
            const [panelsResult, slotsResult, layoutResult] = await Promise.allSettled([
              getPanelTree(testApp!),
              getNativePanelSlotDebugInfo(testApp!),
              getPanelSurfaceLayout(shellPage),
            ]);
            const panels = panelsResult.status === "fulfilled" ? panelsResult.value : [];
            const slots = slotsResult.status === "fulfilled" ? slotsResult.value : [];
            const layout =
              layoutResult.status === "fulfilled"
                ? layoutResult.value
                : {
                    surfaces: [],
                    approval: null,
                    topChrome: [],
                    sidebar: null,
                  };
            lastState = {
              panels,
              slots,
              views,
              layout,
              errors: {
                panels: panelsResult.status === "rejected" ? String(panelsResult.reason) : null,
                slots: slotsResult.status === "rejected" ? String(slotsResult.reason) : null,
                layout: layoutResult.status === "rejected" ? String(layoutResult.reason) : null,
              },
            };
            if (slots.length === 0 || slots.length !== layout.surfaces.length) return false;

            const panelIds = new Set(panels.map((panel) => panel.id));
            const slotsMatchSurfaces = slots.every((slot) => {
              const surface = layout.surfaces.find(
                (candidate) =>
                  JSON.stringify([testApp!.workspaceId, candidate.nativeSlotId]) ===
                  slot.nativeSlotId
              );
              return (
                surface !== undefined &&
                surface.panelId === slot.panelId &&
                panelIds.has(slot.panelId) &&
                Math.abs(slot.bounds.x - surface.x) <= 1 &&
                Math.abs(slot.bounds.y - surface.y) <= 1 &&
                Math.abs(slot.bounds.width - surface.width) <= 1 &&
                Math.abs(slot.bounds.height - surface.height) <= 1 &&
                views.some(
                  (bounds) =>
                    Math.abs(bounds.x - surface.x) <= 1 &&
                    Math.abs(bounds.y - surface.y) <= 1 &&
                    Math.abs(bounds.width - surface.width) <= 1 &&
                    Math.abs(bounds.height - surface.height) <= 1
                )
              );
            });
            const chromeDoesNotOverlapSurfaces = layout.surfaces.every((surface) => {
              // The approval card is a deliberate overlay above the panel. In-flow
              // top chrome and the sidebar still must not consume the panel box.
              const topChromeDoesNotOverlap = layout.topChrome.every(
                (rect) => rect.bottom <= surface.y || rect.y >= surface.bottom
              );
              const sidebarDoesNotOverlap =
                !layout.sidebar ||
                layout.sidebar.x + layout.sidebar.width <= surface.x ||
                layout.sidebar.x >= surface.x + surface.width ||
                layout.sidebar.bottom <= surface.y ||
                layout.sidebar.y >= surface.bottom;
              return topChromeDoesNotOverlap && sidebarDoesNotOverlap;
            });
            return slotsMatchSurfaces && chromeDoesNotOverlapSurfaces;
          },
          { timeout: 120_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
    } catch (error) {
      const outputTail = testApp.getOutput().slice(-20_000);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nLast native-layout state: ${JSON.stringify(lastState)}\nElectron output tail:\n${outputTail}\nHub output tail:\n${testApp.getHubOutput()}`
      );
    }

    // Drive the host-owned outage state through the real preload subscription.
    // Native WebContentsViews must move with the shell DOM, not just its sidebar.
    const before = await getNativePanelSlotDebugInfo(testApp);
    const shellUrl = shellPage.url();
    const publish = async (phase: "reconnecting" | "online") => {
      await testApp!.app.evaluate(
        ({ webContents }, { phase, shellUrl }) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => !candidate.isDestroyed() && candidate.getURL() === shellUrl);
          if (!contents) throw new Error(`Shell webContents is unavailable at ${shellUrl}`);
          contents.send("vibestudio:workspace-connection-state", {
            version: 1,
            phase,
            mode: "remote",
            since: Date.now(),
          });
        },
        { phase, shellUrl }
      );
    };
    await publish("reconnecting");
    await expect
      .poll(
        async () => {
          const [slots, layout, views] = await Promise.all([
            getNativePanelSlotDebugInfo(testApp!),
            getPanelSurfaceLayout(shellPage),
            nativeBounds(),
          ]);
          return (
            slots.length > 0 &&
            slots.every((slot) => {
              const old = before.find((s) => s.nativeSlotId === slot.nativeSlotId);
              const surface = layout.surfaces.find(
                (s) => JSON.stringify([testApp!.workspaceId, s.nativeSlotId]) === slot.nativeSlotId
              );
              return (
                old &&
                surface &&
                slot.bounds.y > old.bounds.y &&
                Math.abs(slot.bounds.y - surface.y) <= 1 &&
                Math.abs(slot.bounds.height - surface.height) <= 1 &&
                views.some(
                  (bounds) =>
                    Math.abs(bounds.x - surface.x) <= 1 &&
                    Math.abs(bounds.y - surface.y) <= 1 &&
                    Math.abs(bounds.width - surface.width) <= 1 &&
                    Math.abs(bounds.height - surface.height) <= 1
                )
              );
            })
          );
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    await publish("online");
    await expect
      .poll(async () => {
        const [slots, views] = await Promise.all([
          getNativePanelSlotDebugInfo(testApp!),
          nativeBounds(),
        ]);
        return (
          slots.length > 0 &&
          slots.every((slot) => {
            const old = before.find((s) => s.nativeSlotId === slot.nativeSlotId);
            return (
              old &&
              Math.abs(slot.bounds.y - old.bounds.y) <= 1 &&
              views.some(
                (bounds) =>
                  Math.abs(bounds.x - old.bounds.x) <= 1 &&
                  Math.abs(bounds.y - old.bounds.y) <= 1 &&
                  Math.abs(bounds.width - old.bounds.width) <= 1 &&
                  Math.abs(bounds.height - old.bounds.height) <= 1
              )
            );
          })
        );
      })
      .toBe(true);
  });
});
