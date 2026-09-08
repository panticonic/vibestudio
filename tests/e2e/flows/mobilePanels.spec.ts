/**
 * Mobile panel chrome smoke tests.
 *
 * These run the real Electron shell at a phone-sized native window and assert
 * shell-chrome behavior (titlebar, address bar, panel tree, stack mode) at
 * mobile size. The per-panel viewport-fit matrix lives in @workspace/testkit;
 * panels/chat keeps a targeted entry here because it exercises the agentic
 * panel chrome path in the desktop shell.
 */

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  callTerminalPanel,
  clickPanelText,
  createManagedTestWorkspace,
  getPanelLayoutAudit,
  getPanelDiagnostics,
  getPanelReadiness,
  getPanelText,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  isPanelReady,
  launchTestApp,
  approvePendingWorkspaceCreationReview,
  approvePendingStartupUnits,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

const MOBILE_BOUNDS = { width: 390, height: 844 };
const SHIPPED_PANELS = ["panels/chat"] as const;

type PendingApproval = {
  approvalId: string;
  kind: string;
  allowedDecisions?: string[];
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeInitPanelsConfig(
  sourceRoot: string,
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }>
): void {
  const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config["initPanels"] = panels;
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function launchMobileTestApp(
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }> = [{ source: "about/new" }]
): Promise<TestApp> {
  const workspacePath = await createManagedTestWorkspace({
    configureSource: (sourceRoot) => writeInitPanelsConfig(sourceRoot, panels),
  });
  let testApp: TestApp | null = null;
  try {
    testApp = await launchTestApp({
      workspace: workspacePath,
      launchTimeout: 240_000,
    });
    await approvePendingStartupUnits(testApp);
    await approvePendingWorkspaceCreationReview(testApp);
    const initialPanel = panels[0];
    if (initialPanel) {
      await waitForHostedShellChrome(testApp, initialPanel.source);
    }
    if (initialPanel) {
      // Hosted chrome can render before its authenticated panel-tree read has
      // seeded the server-authoritative init panels. The fixture is ready only
      // when the panel declaration it wrote is present and loaded.
      await waitForSourcePanel(testApp, initialPanel.source, 180_000);
    }
    return {
      ...testApp,
      cleanup: async () => {
        try {
          await testApp?.cleanup();
        } finally {
          removeManagedTestWorkspace(workspacePath);
        }
      },
    };
  } catch (error) {
    if (testApp) {
      console.log(
        "MOBILE_SHELL_DISCOVERY_DIAGNOSTICS",
        JSON.stringify(await listShellCandidateSnapshots(testApp).catch(() => []), null, 2)
      );
      await testApp.cleanup().catch(() => {});
    }
    removeManagedTestWorkspace(workspacePath);
    throw error;
  }
}

async function listShellCandidateSnapshots(owner: TestApp): Promise<
  Array<{
    id: number;
    url: string;
    title: string;
    text: string;
    hasShellChrome: boolean;
    labels: string[];
    viewport: { width: number; height: number; scrollWidth: number };
  }>
> {
  const { app } = owner;
  return app.evaluate(async ({ webContents }) => {
    const snapshots = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      const title = contents.getTitle();
      try {
        const dom = await contents.executeJavaScript(
          `(() => ({
            text: (document.body?.innerText ?? "").slice(0, 1200),
            hasShellChrome: Boolean(
              document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')
                || document.querySelector('[aria-label="Open panel tree"]')
                || document.querySelector('[aria-label="Close panel tree"]')
                || document.querySelector('[data-shell-top-chrome]')
                || document.querySelector('[data-native-panel-slot-id]')
            ),
            labels: Array.from(document.querySelectorAll("[aria-label]"))
              .map((node) => node.getAttribute("aria-label"))
              .filter(Boolean)
              .slice(0, 80),
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollWidth: document.documentElement.scrollWidth,
            },
          }))()`,
          true
        );
        snapshots.push({
          id: contents.id,
          url,
          title,
          ...dom,
        });
      } catch {
        snapshots.push({
          id: contents.id,
          url,
          title,
          text: "",
          hasShellChrome: false,
          labels: [],
          viewport: { width: 0, height: 0, scrollWidth: 0 },
        });
      }
    }
    return snapshots;
  });
}

async function rpcCall(
  owner: TestApp,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId, payload: request }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      return testApi.rpcCall(request.service, request.method, request.args);
    },
    { workspaceId: owner.workspaceId, payload: { service, method, args } }
  );
}

async function clickRecoveryApproval(owner: TestApp): Promise<boolean> {
  const { app } = owner;
  return app.evaluate(async ({ webContents }) => {
    const candidates = webContents.getAllWebContents().filter((contents) => {
      if (contents.isDestroyed()) return false;
      const title = contents.getTitle();
      return title === "@workspace-apps/shell" || title === "Vibestudio Launch";
    });
    for (const contents of candidates) {
      try {
        const clicked = await Promise.race([
          contents.executeJavaScript(
            `(() => {
              if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) return false;
              const approveAll = Array.from(document.querySelectorAll("button"))
                .find((button) =>
                  /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start)$/.test((button.textContent ?? "").trim())
                );
              if (!approveAll) return false;
              approveAll.click();
              return true;
            })()`,
            true
          ),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        if (clicked) return true;
      } catch {
        // The shell can navigate while startup authority is being committed.
      }
    }
    return false;
  });
}

async function evaluateInHostedShell<T>(owner: TestApp, script: string): Promise<T | null> {
  const { app } = owner;
  return app.evaluate(async ({ webContents }, code) => {
    const timed = async <Value>(promise: Promise<Value>, timeoutMs = 1500): Promise<Value | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
    const hasShellChromeScript = `(() => Boolean(
      document.querySelector(".titlebar-breadcrumb-scroll")
        || document.querySelector('[aria-label="Menu"]')
        || document.querySelector('[aria-label="Open panel tree"]')
        || document.querySelector('[aria-label="Close panel tree"]')
        || document.querySelector('[aria-label="Switch to tree navigation"]')
        || document.querySelector('[aria-label="Switch to breadcrumb navigation"]')
        || document.querySelector('[data-shell-top-chrome]')
        || document.querySelector('[data-native-panel-slot-id]')
    ))()`;
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const isHostedShell = Boolean(
          await timed(contents.executeJavaScript(hasShellChromeScript, true))
        );
        if (!isHostedShell) continue;
        return await timed(contents.executeJavaScript(code, true));
      } catch {
        // Ignore non-DOM webContents and transient navigation races.
      }
    }
    return null;
  }, script);
}

async function waitForHostedShellChrome(owner: TestApp, panelSource: string): Promise<void> {
  await ensureHostedShellReady(owner, { panelSource });
}

async function shellElementVisibleByLabel(owner: TestApp, label: string): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => {
        const label = ${JSON.stringify(label)};
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
            && !node.closest("[hidden], [aria-hidden='true']");
        };
        return Array.from(document.querySelectorAll("[aria-label]"))
          .some((node) => node.getAttribute("aria-label") === label && visible(node));
      })()`
    )
  );
}

async function shellElementVisibleByLabels(owner: TestApp, labels: string[]): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => {
        const labels = ${JSON.stringify(labels)};
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
            && !node.closest("[hidden], [aria-hidden='true']");
        };
        return Array.from(document.querySelectorAll("[aria-label]"))
          .some((node) => labels.includes(node.getAttribute("aria-label") ?? "") && visible(node));
      })()`
    )
  );
}

async function getHostedShellNavigationState(owner: TestApp): Promise<{
  found: boolean;
  viewport: { width: number; height: number } | null;
  labels: string[];
  buttons: string[];
  bodyText: string;
}> {
  return (
    (await evaluateInHostedShell(
      owner,
      `(() => ({
        found: true,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        labels: Array.from(document.querySelectorAll("[aria-label]"))
          .map((node) => node.getAttribute("aria-label"))
          .filter(Boolean),
        buttons: Array.from(document.querySelectorAll("button,[role='button']"))
          .map((node) => (node.textContent ?? "").trim())
          .filter(Boolean),
        bodyText: (document.body?.innerText ?? "").slice(0, 1200),
      }))()`
    )) ?? {
      found: false,
      viewport: null,
      labels: [],
      buttons: [],
      bodyText: "",
    }
  );
}

async function shellClickByLabels(owner: TestApp, labels: string[]): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => {
        const labels = ${JSON.stringify(labels)};
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
            && !node.closest("[hidden], [aria-hidden='true']");
        };
        const nodes = Array.from(document.querySelectorAll("[aria-label]"))
          .filter((item) => labels.includes(item.getAttribute("aria-label") ?? "") && visible(item));
        if (nodes.length === 0) return false;
        for (const node of nodes) {
          if (node instanceof HTMLElement) node.click();
        }
        return true;
      })()`
    )
  );
}

async function shellClickByLabel(owner: TestApp, label: string): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => {
        const label = ${JSON.stringify(label)};
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
            && !node.closest("[hidden], [aria-hidden='true']");
        };
        const node = Array.from(document.querySelectorAll("[aria-label]"))
          .find((item) => item.getAttribute("aria-label") === label && visible(item));
        if (!(node instanceof HTMLElement)) return false;
        node.click();
        return true;
      })()`
    )
  );
}

function normalizeNavigationTreeOpenLabel(): string[] {
  return ["Open panel tree", "Switch to tree view", "Open stack", "Show panel tree"];
}

function normalizeNavigationTreeCloseLabel(): string[] {
  return ["Close panel tree", "Switch to breadcrumb navigation", "Hide panel tree", "Close stack"];
}

function normalizeHideAddressBarLabels(): string[] {
  return ["Hide address bar", "Back to breadcrumbs"];
}

async function shellClickButtonByTextPattern(owner: TestApp, pattern: RegExp): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => {
        const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
            && !node.closest("[hidden], [aria-hidden='true']");
        };
        const node = Array.from(document.querySelectorAll("button,[role='button']"))
          .find((item) => pattern.test((item.textContent ?? "").trim()) && visible(item));
        if (!(node instanceof HTMLElement)) return false;
        node.click();
        return true;
      })()`
    )
  );
}

async function setMobileWindow(owner: TestApp): Promise<void> {
  const { app } = owner;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const hasWindow = await app.evaluate(
      ({ BaseWindow, BrowserWindow }) =>
        BaseWindow.getAllWindows().length + BrowserWindow.getAllWindows().length > 0
    );
    if (hasWindow) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await app.evaluate(({ BaseWindow, BrowserWindow }, bounds) => {
    const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No Electron window available");
    const current = win.getBounds();
    win.setBounds({ ...current, ...bounds });
  }, MOBILE_BOUNDS);
}

async function waitForDeclaredSourcePanel(
  owner: TestApp,
  source: string,
  timeout = 60_000
): Promise<string> {
  const { app } = owner;
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app
          .evaluate(
            async (_electron, { workspaceId, payload: panelSource }) => {
              const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
              if (!testApi) throw new Error("Test API not available");
              return (
                testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)
                  ?.id ?? null
              );
            },
            { workspaceId: owner.workspaceId, payload: source }
          )
          .catch(() => null);
        return panelId;
      },
      { timeout, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();

  return panelId!;
}

async function waitForSourcePanel(
  owner: TestApp,
  source: string,
  timeout = 60_000
): Promise<string> {
  const panelId = await waitForDeclaredSourcePanel(owner, source, timeout);

  await expect
    .poll(() => isPanelReady(owner, panelId).catch(() => false), {
      timeout,
      intervals: [250, 500, 1000],
    })
    .toBe(true);

  return panelId;
}

async function ensurePanelSource(
  owner: TestApp,
  source: string,
  options?: { stateArgs?: Record<string, unknown> }
): Promise<string> {
  const { app } = owner;
  const existingPanelId = await app
    .evaluate(
      async (_electron, { workspaceId, payload: panelSource }) => {
        const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
        if (!testApi) throw new Error("Test API not available");
        return testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)?.id;
      },
      { workspaceId: owner.workspaceId, payload: source }
    )
    .catch(() => null);

  if (existingPanelId) {
    await app.evaluate(
      async (_electron, { workspaceId, payload: panelId }) => {
        const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
        if (!testApi) throw new Error("Test API not available");
        await testApi.focusPanel(panelId);
      },
      { workspaceId: owner.workspaceId, payload: existingPanelId }
    );
    await approveShellPrompts(owner);
    await waitForTerminalPanel(owner, existingPanelId, source);
    return existingPanelId;
  }

  const parentId = await waitForAnyPanel(owner);
  const created = await createPanel(owner, parentId, source, {
    focus: true,
    stateArgs: options?.stateArgs,
  });
  await approveShellPrompts(owner);
  await waitForTerminalPanel(owner, created.id, source);
  return created.id;
}

async function waitForTerminalPanel(
  owner: TestApp,
  panelId: string,
  source: string
): Promise<void> {
  try {
    await expect
      .poll(() => isPanelReady(owner, panelId).catch(() => false), {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
  } catch (error) {
    const readiness = await getPanelReadiness(owner, panelId).catch(() => null);
    const tree = await getPanelTree(owner).catch(() => []);
    throw new Error(
      `Panel ${source} (${panelId}) did not become terminally ready. ` +
        `readiness=${JSON.stringify(readiness)} tree=${JSON.stringify(tree)}`,
      { cause: error }
    );
  }
}

async function waitForAnyPanel(owner: TestApp): Promise<string> {
  const { app } = owner;
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app.evaluate(
          async (_electron, { workspaceId }) => {
            const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
            if (!testApi) throw new Error("Test API not available");
            return testApi.getPanelTree()[0]?.id ?? null;
          },
          { workspaceId: owner.workspaceId }
        );
        return panelId;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();
  return panelId!;
}

async function expectShellFitsMobileViewport(owner: TestApp): Promise<void> {
  const audit = await evaluateInHostedShell<{
    viewportWidth: number;
    viewportHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    titleBarText: string;
    hasMenu: boolean;
    hasNewPanel: boolean;
  }>(
    owner,
    `(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      titleBarText: document.body.innerText,
      hasMenu: Boolean(document.querySelector('[aria-label="Menu"]')),
      hasNewPanel: Boolean(document.querySelector('[aria-label="New panel"]')),
    }))()`
  );
  expect(audit).not.toBeNull();
  if (!audit) return;
  expect(audit.viewportWidth).toBeLessThanOrEqual(MOBILE_BOUNDS.width + 4);
  expect(audit.scrollWidth).toBeLessThanOrEqual(audit.viewportWidth + 2);
  expect(audit.hasMenu).toBe(true);
  expect(audit.hasNewPanel).toBe(true);
}

async function getRootPanelIds(owner: TestApp): Promise<string[]> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      return testApi?.getRootPanels().map((panel) => panel.id) ?? [];
    },
    { workspaceId: owner.workspaceId }
  );
}

async function ensureShellStackMode(owner: TestApp): Promise<void> {
  await shellClickByLabels(owner, normalizeHideAddressBarLabels()).catch(() => false);
  await shellClickByLabels(owner, normalizeNavigationTreeCloseLabel()).catch(() => false);
  try {
    await expect
      .poll(() => shellElementVisibleByLabels(owner, normalizeNavigationTreeOpenLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
  } catch (error) {
    const state = await getHostedShellNavigationState(owner).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Hosted shell navigation state: ${JSON.stringify(state)}`
    );
  }
}

async function expectPanelFitsMobileViewport(owner: TestApp, panelId: string): Promise<void> {
  const audit = await getPanelLayoutAudit(owner, panelId);
  expect(audit.viewport.width).toBeGreaterThan(0);
  expect(audit.viewport.width).toBeLessThanOrEqual(MOBILE_BOUNDS.width);
  expect(audit.document.scrollWidth).toBeLessThanOrEqual(audit.viewport.width + 2);
  expect(audit.horizontalOverflow).toEqual([]);
  expect(audit.verticalOverflow).toEqual([]);
}

async function listPendingApprovals(owner: TestApp): Promise<PendingApproval[]> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      const pending = (await testApi.rpcCall("shellApproval", "listPending", [])) as Array<{
        approvalId: string;
        kind: string;
        allowedDecisions?: unknown;
        options?: Array<{
          value: unknown;
          tone?: unknown;
          label?: unknown;
        }>;
      }>;
      return pending.map((approval) => ({
        approvalId: approval.approvalId,
        kind: approval.kind,
        allowedDecisions: Array.isArray(approval.allowedDecisions)
          ? approval.allowedDecisions.filter(
              (decision): decision is string => typeof decision === "string"
            )
          : undefined,
        options: Array.isArray(approval.options)
          ? approval.options.map((option) => ({
              value: String(option.value),
              tone: typeof option.tone === "string" ? option.tone : undefined,
              label: typeof option.label === "string" ? option.label : undefined,
            }))
          : undefined,
      }));
    },
    { workspaceId: owner.workspaceId }
  );
}

async function resolveApproval(owner: TestApp, approval: PendingApproval): Promise<void> {
  const { app } = owner;
  await app.evaluate(
    async (_electron, { workspaceId, payload: pending }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      if (pending.kind === "userland") {
        const choice =
          pending.options?.find((option) => option.tone === "primary")?.value ??
          pending.options?.find((option) => option.tone !== "danger")?.value ??
          pending.options?.[0]?.value;
        if (!choice) {
          throw new Error(`Userland approval ${pending.approvalId} did not include any options`);
        }
        await testApi.rpcCall("shellApproval", "resolveUserland", [pending.approvalId, choice]);
        return;
      }
      const decision =
        pending.allowedDecisions?.find((candidate) => candidate !== "deny") ?? "once";
      await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, decision]);
    },
    { workspaceId: owner.workspaceId, payload: approval }
  );
}

async function approveShellPrompts(owner: TestApp): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clickedRecovery = await clickRecoveryApproval(owner);
    const pending = await listPendingApprovals(owner);
    for (const approval of pending) {
      // Unit-install reviews have a structured resolution contract; the
      // generic approval path below is intentionally only for ordinary
      // session/userland prompts.
      if (approval.kind === "unit-install-review") continue;
      await resolveApproval(owner, approval);
    }
    await approvePendingWorkspaceCreationReview(owner);
    const clicked = await shellClickButtonByTextPattern(
      owner,
      /Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start|Approve all|Approve push|Approve|Dev session|Install and run|Allow|Run once|Allow for session|Use this session/i
    );
    const hasApprovalSurface = Boolean(
      await evaluateInHostedShell(
        owner,
        `(() => Boolean(
          document.querySelector('.approval-card, .approval-pill')
            || document.querySelector('[data-bootstrap-launch-gate="true"]')
        ))()`
      )
    );
    if (!clickedRecovery && pending.length === 0 && !clicked && !hasApprovalSurface) return;
    await delay(500);
  }

  const unresolved = await listPendingApprovals(owner);
  const hasApprovalSurface = Boolean(
    await evaluateInHostedShell(
      owner,
      `(() => Boolean(
        document.querySelector('.approval-card, .approval-pill')
          || document.querySelector('[data-bootstrap-launch-gate="true"]')
      ))()`
    )
  );
  throw new Error(
    `Shell approvals did not settle: ${JSON.stringify({ unresolved, hasApprovalSurface })}`
  );
}

async function diagnosePendingApprovalResolution(
  owner: TestApp
): Promise<
  Array<{ approvalId: string; before: string[]; choice?: string; outcome: string; after: string[] }>
> {
  const pending = await listPendingApprovals(owner);
  const attempts: Array<{
    approvalId: string;
    before: string[];
    choice?: string;
    outcome: string;
    after: string[];
  }> = [];
  for (const approval of pending) {
    const before = pending.map((item) => item.approvalId);
    const choice =
      approval.kind === "userland"
        ? (approval.options?.find((option) => option.tone === "primary")?.value ??
          approval.options?.find((option) => option.tone !== "danger")?.value ??
          approval.options?.[0]?.value)
        : undefined;
    let outcome = "resolved";
    try {
      await resolveApproval(owner, approval);
    } catch (reason) {
      outcome = reason instanceof Error ? reason.message : String(reason);
    }
    const after = (await listPendingApprovals(owner).catch(() => [])).map(
      (item) => item.approvalId
    );
    attempts.push({
      approvalId: approval.approvalId,
      before,
      ...(choice ? { choice } : {}),
      outcome,
      after,
    });
  }
  return attempts;
}

test.describe("Mobile Panels", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  let testApp: TestApp | undefined;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(600_000);
    testApp = await launchMobileTestApp([{ source: "about/new" }]);
    await setMobileWindow(testApp);
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(600_000);
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("shell chrome exposes mobile panel tree without horizontal overflow", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!);
    await ensureShellStackMode(testApp!);
    await delay(500);

    await expectShellFitsMobileViewport(testApp!);

    expect(await shellClickByLabels(testApp!, normalizeNavigationTreeOpenLabel())).toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabels(testApp!, normalizeNavigationTreeCloseLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    await expectShellFitsMobileViewport(testApp!);

    expect(await shellClickByLabels(testApp!, normalizeNavigationTreeCloseLabel())).toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabels(testApp!, normalizeNavigationTreeOpenLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
  });

  test("mobile titlebar toggles the address bar without overflow", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!);
    await ensureShellStackMode(testApp!);
    await ensurePanelSource(testApp!, "about/help");

    expect(await shellClickByLabel(testApp!, "Show address bar")).toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabel(testApp!, "Panel path"), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    await expectShellFitsMobileViewport(testApp!);

    expect(await shellClickByLabels(testApp!, normalizeHideAddressBarLabels())).toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabel(testApp!, "Panel path"), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(false);
    await expectShellFitsMobileViewport(testApp!);
  });

  test("mobile titlebar creates a new panel", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!);
    await ensureShellStackMode(testApp!);
    await waitForAnyPanel(testApp!);
    const initialCount = (await getPanelTree(testApp!)).length;

    expect(await shellClickByLabel(testApp!, "New panel")).toBe(true);
    await expect
      .poll(
        async () => {
          const panels = await getPanelTree(testApp!);
          const rootPanelIds = await getRootPanelIds(testApp!);
          const newPanel = panels.find((panel) => panel.snapshot?.source === "about/new");
          return {
            count: panels.length,
            hasNewPanel: Boolean(newPanel),
            hasRootNewPanel: Boolean(newPanel && rootPanelIds.includes(newPanel.id)),
          };
        },
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toEqual({ count: initialCount + 1, hasNewPanel: true, hasRootNewPanel: true });
    await expectShellFitsMobileViewport(testApp!);
  });

  test("mobile panel tree selection returns to stack mode", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!);
    await ensureShellStackMode(testApp!);
    const parentId = await ensurePanelSource(testApp!, "about/new");
    const existingHelpPanel = (await getPanelTree(testApp!)).find(
      (panel) => panel.snapshot?.source === "about/help"
    );
    const helpPanel =
      existingHelpPanel ??
      (await createPanel(testApp!, parentId, "about/help", {
        focus: false,
      }));

    // A background panel has no native slot, so canonical presentation
    // readiness begins only after selecting it. Its durable tree row is the
    // precondition for exercising that selection.
    expect(await shellClickByLabels(testApp!, normalizeNavigationTreeOpenLabel())).toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabels(testApp!, normalizeNavigationTreeCloseLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabel(testApp!, "Select panel Help"), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    expect(await shellClickByLabel(testApp!, "Select panel Help")).toBe(true);

    await expect
      .poll(() => isPanelReady(testApp!, helpPanel.id).catch(() => false), {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);

    await expect
      .poll(() => shellElementVisibleByLabels(testApp!, normalizeNavigationTreeOpenLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    await expect
      .poll(() => shellElementVisibleByLabels(testApp!, normalizeNavigationTreeCloseLabel()), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(false);
    await expectShellFitsMobileViewport(testApp!);
  });

  test("terminal session fits the mobile panel viewport", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!);
    await ensureShellStackMode(testApp!);
    const panelId = await ensurePanelSource(testApp!, "panels/terminal");
    await startPanelDiagnostics(testApp!, panelId);
    await approveShellPrompts(testApp!);
    // Terminal is the first flow that lazily activates the native shell
    // extension. Re-run the host launch review after the panel has requested
    // it; approving only the cold-start batch leaves the panel waiting forever
    // when the extension build is first materialized on demand.
    await approvePendingStartupUnits(testApp!, 30_000).catch(() => {});
    await approvePendingWorkspaceCreationReview(testApp!).catch(() => {});

    try {
      await expect
        .poll(
          async () => {
            await approveShellPrompts(testApp!);
            // The panel can mount before the newly approved native shell
            // extension finishes its first build. Exercise its user-facing
            // recovery path once the approval/build race settles.
            await clickPanelText(testApp!, panelId, "button", "Retry").catch(() => false);
            return getPanelText(testApp!, panelId);
          },
          {
            timeout: 60_000,
            intervals: [500, 1000, 2000],
          }
        )
        .toMatch(/(?:\$|#|>\s*)|(?:\d+x\d+)/);
    } catch (error) {
      const units = (await rpcCall(testApp!, "workspace", "units.list").catch((reason) => ({
        error: reason instanceof Error ? reason.message : String(reason),
      }))) as unknown;
      const shellUnits = Array.isArray(units)
        ? units.filter((unit) => {
            const row = unit as { name?: unknown; source?: unknown };
            return String(row.name ?? row.source ?? "").includes("shell");
          })
        : units;
      console.log(
        "MOBILE_TERMINAL_STARTUP_DIAGNOSTICS",
        JSON.stringify(
          {
            text: await getPanelText(testApp!, panelId).catch(() => ""),
            pendingApprovals: await listPendingApprovals(testApp!).catch(() => []),
            approvalResolutionAttempts: await diagnosePendingApprovalResolution(testApp!).catch(
              (reason) => [
                {
                  outcome: reason instanceof Error ? reason.message : String(reason),
                },
              ]
            ),
            shellUnits,
            shellLogs: await rpcCall(testApp!, "workspace", "units.logs", [
              "@workspace-extensions/shell",
              { limit: 200 },
            ]).catch((reason) => ({
              error: reason instanceof Error ? reason.message : String(reason),
            })),
            sessions: await callTerminalPanel(testApp!, panelId, "listSessions").catch(
              (reason) => ({ error: reason instanceof Error ? reason.message : String(reason) })
            ),
            panelDiagnostics: await getPanelDiagnostics(testApp!, panelId).catch(() => []),
          },
          null,
          2
        )
      );
      throw error;
    }
    await expectPanelFitsMobileViewport(testApp!, panelId);
  });

  for (const source of SHIPPED_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      expect(testApp).toBeDefined();
      await setMobileWindow(testApp!);
      await ensureShellStackMode(testApp!);
      const panelId = await ensurePanelSource(testApp!, source);
      await delay(500);

      await expectShellFitsMobileViewport(testApp!);
      await expectPanelFitsMobileViewport(testApp!, panelId);
    });
  }
});
