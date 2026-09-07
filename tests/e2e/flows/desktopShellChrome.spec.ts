import { expect, test, type Page } from "@playwright/test";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { viewMethods } from "@vibestudio/service-schemas/view";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import type { RpcEnvelope } from "@vibestudio/rpc";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getNativePanelSlotDebugInfo,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";

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

async function getPanelSurfaceLayout(testApp: TestApp): Promise<{
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
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => {
            const rectFor = (node) => {
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
                return rect && nativeSlotId && panelId
                  ? { nativeSlotId, panelId, ...rect }
                  : null;
              })
              .filter(Boolean);
            const shellLayout = document.querySelector("[data-shell-layout-columns]");
            if (surfaces.length === 0 && !shellLayout) return null;
            return {
              surfaces,
              approval: rectFor(document.querySelector(".approval-card, .approval-pill")),
              topChrome: Array.from(document.querySelectorAll("[data-shell-top-chrome]"))
                .map(rectFor)
                .filter(Boolean),
              sidebar: rectFor(document.querySelector("[data-shell-panel-sidebar]")),
              ...(shellLayout
                ? { shellState: {
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
                  } }
                : {}),
            };
          })()`,
          true
        );
        if (result?.surfaces?.length || result?.shellState) return result;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return { surfaces: [], approval: null, topChrome: [], sidebar: null };
  });
}

async function approveStartupUnitsIfNeeded(testApp: TestApp): Promise<void> {
  await expect
    .poll(
      async () =>
        testApp.app.evaluate(
          async ({ webContents }, { workspaceId }) => {
            const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
            if (testApi?.getHostViewDebugInfo().visibleHostChromeAppId) return true;
            for (const contents of webContents.getAllWebContents()) {
              if (contents.isDestroyed()) continue;
              try {
                const result = await contents.executeJavaScript(
                  `(() => {
                  const hasHostedShellChrome = Boolean(document.querySelector('[data-shell-top-chrome="titlebar"]')
                    || document.querySelector(".titlebar-breadcrumb-scroll")
                    || document.querySelector('[aria-label="Menu"]'));
                  if (hasHostedShellChrome) return "hosted-shell-loaded";

                  if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) {
                    return "missing";
                  }

                  const approveAll = Array.from(document.querySelectorAll("button"))
                    .find((button) =>
                      /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start)$/.test((button.textContent ?? "").trim())
                    );
                  if (!approveAll) return "waiting";
                  approveAll.click();
                  return "approved";
                })()`,
                  true
                );
                if (result === "approved") return true;
              } catch {
                // Ignore non-DOM webContents.
              }
            }
            return false;
          },
          { workspaceId: testApp!.workspaceId }
        ),
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

/** Read-only assertions use the same admitted native System UI transport as the product. */
async function nativeWorkspaceRead<T>(
  page: Page,
  workspaceId: string | undefined,
  method: string,
  args: unknown[]
): Promise<T> {
  return page.evaluate(
    async ({ workspaceId, method, args }) => {
      const bridge = (
        window as unknown as {
          __vibestudioTransport: {
            identity: { runtimeId: string; workspaceId: string };
            send(envelope: RpcEnvelope): Promise<void>;
            onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
          };
        }
      ).__vibestudioTransport;
      const requestId = `e2e-copy-read-${crypto.randomUUID()}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out reading ${method}`));
        }, 30_000);
        const off = bridge.onMessage(({ message, delivery }) => {
          if (message.type !== "response" || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          if (delivery.caller.workspaceId !== (workspaceId ?? bridge.identity.workspaceId)) {
            reject(new Error(`Received ${method} from a different workspace`));
            return;
          }
          if ("error" in message) reject(new Error(message.error));
          else resolve(message.result as T);
        });
        const caller = {
          callerId: bridge.identity.runtimeId,
          callerKind: "app" as const,
          workspaceId: bridge.identity.workspaceId,
        };
        void bridge
          .send({
            from: caller.callerId,
            target: "main",
            destination: { kind: "workspace", workspaceId: workspaceId ?? caller.workspaceId },
            delivery: { caller },
            provenance: [caller],
            message: { type: "request", requestId, fromId: caller.callerId, method, args },
          })
          .catch((error) => {
            clearTimeout(timer);
            off();
            reject(error);
          });
      });
    },
    { workspaceId, method, args }
  );
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
    await approveStartupUnitsIfNeeded(testApp);

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
      await expect
        .poll(
          () =>
            testApp!.app.evaluate(async ({ webContents }, chromeId) => {
              const chrome = webContents.fromId(chromeId);
              if (!chrome || chrome.isDestroyed()) return "";
              return chrome.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('[data-part-row]')].find(node =>
            node.getAttribute('data-identity-key')?.startsWith('extensions/browser-data@')
            && node.getBoundingClientRect().width > 0);
          if (!row) return "";
          if (row.getAttribute('aria-current') !== 'true' && row.getAttribute('aria-expanded') !== 'true') row.click();
          return [...document.querySelectorAll('.install-review-detail')]
            .filter(node => node.getBoundingClientRect().width > 0)
            .map(node => node.innerText).join('\\n');
        })()`);
            }, chromeId),
          { timeout: 60_000 }
        )
        .toContain("delete persistent browser data");
      const browserReviewText = await testApp.app.evaluate(async ({ webContents }, chromeId) => {
        return webContents.fromId(chromeId)!.executeJavaScript(`(() => {
          const detail = [...document.querySelectorAll('.install-review-detail')].find(node =>
            node.getBoundingClientRect().width > 0 && node.innerText.includes('delete persistent browser data'));
          return detail?.innerText ?? '';
        })()`);
      }, chromeId);
      expect(browserReviewText).not.toContain("doesn't recognize");
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

  test("copies one selected file between workspaces into an unpublished review branch", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await approveStartupUnitsIfNeeded(testApp);
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
        (service, method, args) =>
          nativeWorkspaceRead(page, undefined, `${service}.${method}`, args)
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
            nativeWorkspaceRead(page, workspaceId, `${service}.${method}`, args)
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
          const pending = filterRuntimeApprovals(queued).filter(
            (approval) => approval.kind === "unit-install-review"
          );
          if (!pending.length) return;
          const add = page.getByRole("button", { name: "Add to workspace", exact: true });
          // Approval settlement can coalesce another startup request while its
          // previous list response is in flight. Re-read before waiting for UI.
          await expect
            .poll(
              async () =>
                (await add.isVisible()) ||
                !filterRuntimeApprovals(await approvals.listPending()).some(
                  (approval) => approval.kind === "unit-install-review"
                ),
              { timeout: 60_000 }
            )
            .toBe(true);
          if (!(await add.isVisible())) continue;
          const card = page.locator("[data-approval-card]").filter({ has: add });
          const approvalId = await card.getAttribute("data-approval-id");
          if (!approvalId || !pending.some((approval) => approval.approvalId === approvalId))
            throw new Error("Visible startup approval belongs to another workspace");
          await add.click();
          await expect
            .poll(
              async () =>
                (await approvals.listPending()).some(
                  (approval) => approval.approvalId === approvalId
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
          nativeWorkspaceRead(page, workspaceId, `${service}.${method}`, args)
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
          nativeWorkspaceRead(page, personal.workspaceId, `${service}.${method}`, args)
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
      const newPanel = await testApp.app.evaluate(async ({ webContents }, webContentsId) => {
        const contents = webContents.fromId(webContentsId);
        if (!contents || contents.isDestroyed()) return null;
        return {
          url: contents.getURL(),
          hasLauncher: await contents.executeJavaScript(
            `!!document.querySelector('[aria-label="Search panels and history, enter a web address, or start a chat"]')`
          ),
        };
      }, presentation.webContentsId);
      expect(newPanel).toEqual({ url: presentation.url, hasLauncher: true });
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
    await approveStartupUnitsIfNeeded(testApp);

    let lastState: unknown = null;
    try {
      await expect
        .poll(
          async () => {
            const [panelsResult, slotsResult, layoutResult] = await Promise.allSettled([
              getPanelTree(testApp!),
              getNativePanelSlotDebugInfo(testApp!),
              getPanelSurfaceLayout(testApp!),
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
                (candidate) => candidate.nativeSlotId === slot.nativeSlotId
              );
              return (
                surface !== undefined &&
                surface.panelId === slot.panelId &&
                panelIds.has(slot.panelId) &&
                Math.abs(slot.bounds.x - surface.x) <= 1 &&
                Math.abs(slot.bounds.y - surface.y) <= 1 &&
                Math.abs(slot.bounds.width - surface.width) <= 1 &&
                Math.abs(slot.bounds.height - surface.height) <= 1
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
  });
});
