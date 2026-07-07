/**
 * Mobile panel chrome smoke tests.
 *
 * These run the real Electron shell at a phone-sized native window and assert
 * shell-chrome behavior (titlebar, address bar, panel tree, stack mode) at
 * mobile size. The per-panel viewport-fit matrix lives in @workspace/testkit;
 * panels/chat keeps a targeted entry here because it exercises the agentic
 * panel chrome path in the desktop shell.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  clickPanelSelector,
  clickPanelText,
  createManagedTestWorkspace,
  getPanelLayoutAudit,
  getPanelText,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  isPanelLoaded,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

const MOBILE_BOUNDS = { width: 390, height: 844 };
const SHIPPED_PANELS = ["panels/chat"] as const;

type PendingApproval = {
  approvalId: string;
  kind: string;
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeInitPanelsConfig(
  workspacePath: string,
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }>
): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<
    string,
    unknown
  >;
  config.initPanels = panels;
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function launchMobileTestApp(
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }> = [
    { source: "about/new" },
  ]
): Promise<TestApp> {
  const workspacePath = createManagedTestWorkspace();
  writeInitPanelsConfig(workspacePath, panels);
  let testApp: TestApp | null = null;
  try {
    testApp = await launchTestApp({
      workspace: workspacePath,
      launchTimeout: 240_000,
      env: { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" },
    });
    await waitForHostedShellChrome(testApp.app);
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
        JSON.stringify(await listShellCandidateSnapshots(testApp.app).catch(() => []), null, 2)
      );
      await testApp.cleanup().catch(() => {});
    }
    removeManagedTestWorkspace(workspacePath);
    throw error;
  }
}

async function listShellCandidateSnapshots(app: ElectronApplication): Promise<
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
  return app.evaluate(async ({ webContents }) => {
    const snapshots = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const dom = await contents.executeJavaScript(
          `(() => ({
            text: (document.body?.innerText ?? "").slice(0, 1200),
            hasShellChrome: Boolean(
              document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')
                || document.querySelector('[aria-label="Open panel tree"]')
                || document.querySelector('[aria-label="Close panel tree"]')
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
          url: contents.getURL(),
          title: contents.getTitle(),
          ...dom,
        });
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return snapshots;
  });
}

async function rpcCall(
  app: ElectronApplication,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(async (_electron, request) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.rpcCall(request.service, request.method, request.args);
  }, { service, method, args });
}

async function clickRecoveryApproval(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const clicked = await contents.executeJavaScript(
          `(() => {
            if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) return false;
            const approveAll = Array.from(document.querySelectorAll("button"))
              .find((button) =>
                /^(Trust and start|Approve and start)$/.test((button.textContent ?? "").trim())
              );
            if (!approveAll) return false;
            approveAll.click();
            return true;
          })()`,
          true
        );
        if (clicked) return true;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return false;
  });
}

async function evaluateInHostedShell<T>(
  app: ElectronApplication,
  script: string
): Promise<T | null> {
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

async function waitForHostedShellChrome(app: ElectronApplication): Promise<void> {
  let launchSessionId: string | null = null;
  let lastProbe: Record<string, unknown> = {};
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const probe: Record<string, unknown> = {};
    await clickRecoveryApproval(app).catch((error: unknown) => {
      probe["recoveryClickError"] = error instanceof Error ? error.message : String(error);
      return false;
    });
    const launchSession = launchSessionId
      ? await rpcCall(app, "workspace", "hostTargets.getLaunchSession", [launchSessionId]).catch(
          (error: unknown) => {
            probe["launchSessionError"] = error instanceof Error ? error.message : String(error);
            return null;
          }
        )
      : await rpcCall(app, "workspace", "hostTargets.beginLaunch", ["electron"]).catch(
          (error: unknown) => {
            probe["launchSessionError"] = error instanceof Error ? error.message : String(error);
            return null;
          }
        );
    probe["launchSession"] = summarizeLaunchSession(launchSession);
    if (
      launchSession &&
      typeof launchSession === "object" &&
      "sessionId" in launchSession &&
      typeof launchSession.sessionId === "string"
    ) {
      launchSessionId = launchSession.sessionId;
      const approvals = Array.isArray((launchSession as { approvals?: unknown }).approvals)
        ? (launchSession as { approvals: unknown[] }).approvals
        : [];
      if (approvals.length > 0) {
        probe["resolvedSessionApprovals"] = approvals.length;
        await rpcCall(app, "workspace", "hostTargets.resolveLaunchSessionApproval", [
          launchSessionId,
          "once",
        ]).catch((error: unknown) => {
          probe["resolveSessionApprovalError"] =
            error instanceof Error ? error.message : String(error);
          return null;
        });
      }
    }
    const pending = await listPendingApprovals(app).catch((error: unknown) => {
      probe["pendingError"] = error instanceof Error ? error.message : String(error);
      return [];
    });
    probe["pending"] = pending.map((approval) => ({
      kind: approval.kind,
      approvalId: approval.approvalId,
      options: approval.options?.map((option) => option.value),
    }));
    for (const approval of pending) {
      await resolveApproval(app, approval).catch((error: unknown) => {
        probe["resolvePendingError"] = error instanceof Error ? error.message : String(error);
      });
    }
    const hasShell = Boolean(
      await evaluateInHostedShell(
        app,
        `(() => Boolean(
          document.querySelector(".titlebar-breadcrumb-scroll")
            || document.querySelector('[aria-label="Menu"]')
            || document.querySelector('[aria-label="Open panel tree"]')
            || document.querySelector('[aria-label="Close panel tree"]')
            || document.querySelector('[aria-label="Switch to tree navigation"]')
            || document.querySelector('[aria-label="Switch to breadcrumb navigation"]')
        ))()`
      )
    );
    probe["hasShell"] = hasShell;
    lastProbe = probe;
    if (hasShell) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for hosted shell chrome: ${JSON.stringify(lastProbe)}`);
}

function summarizeLaunchSession(session: unknown): unknown {
  if (!session || typeof session !== "object") return session;
  const record = session as Record<string, unknown>;
  return {
    sessionId: record["sessionId"],
    status: record["status"],
    currentPhase: record["currentPhase"],
    message: record["message"],
    detail: record["detail"],
    settled: record["settled"],
    approvals: Array.isArray(record["approvals"]) ? record["approvals"].length : undefined,
    approvalViews: Array.isArray(record["approvalViews"])
      ? record["approvalViews"].map((view) =>
          view && typeof view === "object"
            ? {
                title: (view as Record<string, unknown>)["title"],
                summary: (view as Record<string, unknown>)["summary"],
              }
            : view
        )
      : undefined,
  };
}

async function shellElementVisibleByLabel(
  app: ElectronApplication,
  label: string
): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      app,
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

async function shellClickByLabel(app: ElectronApplication, label: string): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      app,
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

async function shellClickButtonByTextPattern(
  app: ElectronApplication,
  pattern: RegExp
): Promise<boolean> {
  return Boolean(
    await evaluateInHostedShell(
      app,
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

async function setMobileWindow(app: ElectronApplication): Promise<void> {
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

async function waitForSourcePanel(app: ElectronApplication, source: string): Promise<string> {
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app
          .evaluate((_electron, panelSource) => {
            const testApi = (
              globalThis as {
                __testApi?: {
                  getPanelTree: () => Array<{ id: string; snapshot?: { source?: string } }>;
                };
              }
            ).__testApi;
            if (!testApi) throw new Error("Test API not available");
            return (
              testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)?.id ??
              null
            );
          }, source)
          .catch(() => null);
        return panelId;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();

  await expect
    .poll(async () => (panelId ? isPanelLoaded(app, panelId).catch(() => false) : false), {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);

  return panelId!;
}

async function ensurePanelSource(
  app: ElectronApplication,
  source: string,
  options?: { stateArgs?: Record<string, unknown> }
): Promise<string> {
  const existingPanelId = await app
    .evaluate((_electron, panelSource) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getPanelTree: () => Array<{ id: string; snapshot?: { source?: string } }>;
          };
        }
      ).__testApi;
      if (!testApi) throw new Error("Test API not available");
      return testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)?.id;
    }, source)
    .catch(() => null);

  if (existingPanelId) {
    await app.evaluate((_electron, panelId) => {
      const testApi = (globalThis as { __testApi?: { focusPanel: (id: string) => void } })
        .__testApi;
      if (!testApi) throw new Error("Test API not available");
      testApi.focusPanel(panelId);
    }, existingPanelId);
    await expect
      .poll(() => isPanelLoaded(app, existingPanelId).catch(() => false), {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    return existingPanelId;
  }

  const parentId = await waitForAnyPanel(app);
  const created = await createPanel(app, parentId, source, {
    focus: true,
    stateArgs: options?.stateArgs,
  });
  await expect
    .poll(() => isPanelLoaded(app, created.id).catch(() => false), {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);
  return created.id;
}

async function waitForAnyPanel(app: ElectronApplication): Promise<string> {
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app.evaluate(() => {
          const testApi = (
            globalThis as {
              __testApi?: {
                getPanelTree: () => Array<{ id: string }>;
              };
            }
          ).__testApi;
          if (!testApi) throw new Error("Test API not available");
          return testApi.getPanelTree()[0]?.id ?? null;
        });
        return panelId;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();
  return panelId!;
}

async function expectShellFitsMobileViewport(app: ElectronApplication): Promise<void> {
  const audit = await evaluateInHostedShell<{
    viewportWidth: number;
    viewportHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    titleBarText: string;
    hasMenu: boolean;
    hasNewPanel: boolean;
  }>(
    app,
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

async function ensureShellStackMode(app: ElectronApplication): Promise<void> {
  await shellClickByLabel(app, "Hide address bar").catch(() => false);
  await shellClickByLabel(app, "Close panel tree").catch(() => false);
  await expect
    .poll(() => shellElementVisibleByLabel(app, "Open panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);
}

async function expectPanelFitsMobileViewport(
  app: ElectronApplication,
  panelId: string
): Promise<void> {
  const audit = await getPanelLayoutAudit(app, panelId);
  expect(audit.viewport.width).toBeGreaterThan(0);
  expect(audit.viewport.width).toBeLessThanOrEqual(MOBILE_BOUNDS.width);
  expect(audit.document.scrollWidth).toBeLessThanOrEqual(audit.viewport.width + 2);
  expect(audit.horizontalOverflow).toEqual([]);
  expect(audit.verticalOverflow).toEqual([]);
}

async function listPendingApprovals(app: ElectronApplication): Promise<PendingApproval[]> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const pending = await testApi.rpcCall("shellApproval", "listPending", []) as Array<{
      approvalId: string;
      kind: string;
      options?: Array<{
        value: unknown;
        tone?: unknown;
        label?: unknown;
      }>;
    }>;
    return pending.map((approval) => ({
      approvalId: approval.approvalId,
      kind: approval.kind,
      options: Array.isArray(approval.options)
        ? approval.options.map((option) => ({
            value: String(option.value),
            tone: typeof option.tone === "string" ? option.tone : undefined,
            label: typeof option.label === "string" ? option.label : undefined,
          }))
        : undefined,
    }));
  });
}

async function resolveApproval(app: ElectronApplication, approval: PendingApproval): Promise<void> {
  await app.evaluate(async (_electron, pending) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
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
    await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, "session"]);
  }, approval);
}

async function approveShellPrompts(app: ElectronApplication): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clickedRecovery = await clickRecoveryApproval(app);
    const pending = await listPendingApprovals(app);
    for (const approval of pending) {
      await resolveApproval(app, approval);
    }
    const clicked = await shellClickButtonByTextPattern(
      app,
      /Trust and start|Approve and start|Approve all|Approve push|Approve|Dev session|Install and run|Allow|Run once|Allow for session|Use this session/i
    );
    if (!clickedRecovery && pending.length === 0 && !clicked) return;
    await delay(500);
  }
}

test.describe("Mobile Panels", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000);

  let testApp: TestApp | undefined;

  test.beforeAll(async () => {
    testApp = await launchMobileTestApp([{ source: "about/new" }]);
    await setMobileWindow(testApp.app);
  });

  test.afterAll(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("shell chrome exposes mobile panel tree without horizontal overflow", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!.app);
    await ensureShellStackMode(testApp!.app);
    await delay(500);

    await expectShellFitsMobileViewport(testApp!.app);

    expect(await shellClickByLabel(testApp!.app, "Open panel tree")).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Close panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(true);
    await expectShellFitsMobileViewport(testApp!.app);

    expect(await shellClickByLabel(testApp!.app, "Close panel tree")).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Open panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(true);
  });

  test("mobile titlebar toggles the address bar without overflow", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!.app);
    await ensureShellStackMode(testApp!.app);
    await ensurePanelSource(testApp!.app, "about/help");

    expect(await shellClickByLabel(testApp!.app, "Show address bar")).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Panel path"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(true);
    await expectShellFitsMobileViewport(testApp!.app);

    expect(await shellClickByLabel(testApp!.app, "Hide address bar")).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Panel path"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(false);
    await expectShellFitsMobileViewport(testApp!.app);
  });

  test("mobile titlebar creates a new panel", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!.app);
    await ensureShellStackMode(testApp!.app);
    await waitForAnyPanel(testApp!.app);
    const initialCount = (await getPanelTree(testApp!.app)).length;

    expect(await shellClickByLabel(testApp!.app, "New panel")).toBe(true);

    await expect
      .poll(
        async () => {
          const panels = await getPanelTree(testApp!.app);
          return {
            count: panels.length,
            hasNewPanel: panels.some((panel) => panel.snapshot?.source === "about/new"),
          };
        },
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toEqual({ count: initialCount + 1, hasNewPanel: true });
    await expectShellFitsMobileViewport(testApp!.app);
  });

  test("mobile panel tree selection returns to stack mode", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!.app);
    await ensureShellStackMode(testApp!.app);
    const parentId = await ensurePanelSource(testApp!.app, "about/new");
    await createPanel(testApp!.app, parentId, "about/help", { focus: false });
    await waitForSourcePanel(testApp!.app, "about/help");

    expect(await shellClickByLabel(testApp!.app, "Open panel tree")).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Close panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(true);
    expect(await shellClickByLabel(testApp!.app, "Select panel Help")).toBe(true);

    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Open panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(true);
    await expect.poll(() => shellElementVisibleByLabel(testApp!.app, "Close panel tree"), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    }).toBe(false);
    await expectShellFitsMobileViewport(testApp!.app);
  });

  test("terminal session fits the mobile panel viewport", async () => {
    expect(testApp).toBeDefined();
    await setMobileWindow(testApp!.app);
    await ensureShellStackMode(testApp!.app);
    const panelId = await ensurePanelSource(testApp!.app, "panels/terminal");
    await approveShellPrompts(testApp!.app);

    await expect
      .poll(async () => {
        await approveShellPrompts(testApp!.app);
        return getPanelText(testApp!.app, panelId);
      }, {
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      })
      .toMatch(/(?:\$|#|>\s*)|(?:\d+x\d+)/);
    await expectPanelFitsMobileViewport(testApp!.app, panelId);
  });

  for (const source of SHIPPED_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      expect(testApp).toBeDefined();
      await setMobileWindow(testApp!.app);
      await ensureShellStackMode(testApp!.app);
      const panelId = await ensurePanelSource(testApp!.app, source);
      await delay(500);

      await expectShellFitsMobileViewport(testApp!.app);
      await expectPanelFitsMobileViewport(testApp!.app, panelId);
    });
  }

});
