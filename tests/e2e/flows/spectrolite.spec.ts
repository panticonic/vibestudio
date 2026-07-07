import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import {
  clickPanelSelector,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  executePanelScript,
  getPanelHtml,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  isPanelLoaded,
  launchTestApp,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  type TestApp,
  createManagedTestWorkspace,
  typePanelText,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function e2eVaultContextId(vaultWorkspaceRoot: string): string {
  const input = vaultWorkspaceRoot
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
    h2 = (h2 + i + 1) >>> 0;
  }
  return `vault-${h1.toString(36)}${h2.toString(36)}`;
}

type PendingApproval = {
  approvalId: string;
  kind: string;
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

function replaceInitPanels(workspacePath: string, stateArgs: Record<string, unknown>): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<
    string,
    unknown
  >;
  config.initPanels = [
    Object.keys(stateArgs).length > 0
      ? { source: "panels/spectrolite", stateArgs }
      : { source: "panels/spectrolite" },
  ];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

function initializeDefaultVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "default");
  fs.writeFileSync(
    path.join(repo, "E2E.mdx"),
    [
      "---",
      "title: E2E",
      "tags: [e2e]",
      "---",
      "",
      "# E2E Note",
      "",
      "A simple note for end-to-end editor interactions.",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "Linked.mdx"),
    [
      "---",
      "title: Linked",
      "---",
      "",
      "# Linked",
      "",
      "This note points at [[E2E]].",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "Broken.mdx"),
    [
      "---",
      "title: Broken",
      "---",
      "",
      "# Broken",
      "",
      "This document keeps the editor usable around malformed JSX.",
      "",
      "<BrokenWidget",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "LiveError.mdx"),
    [
      "---",
      "title: Live Error",
      "---",
      "",
      "# Live Error",
      "",
      "The editor should stay usable when a JSX preview fails.",
      "",
      "<MissingWidget />",
      "",
    ].join("\n")
  );
}

function initializeSecondVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "second");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "Second.mdx"),
    [
      "---",
      "title: Second Vault",
      "---",
      "",
      "# Second Vault",
      "",
      "This note proves Spectrolite switched vault roots.",
      "",
    ].join("\n")
  );
}

function initializeLargeVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "default");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "Hub.mdx"),
    [
      "---",
      "title: Large Hub",
      "---",
      "",
      "# Large Hub",
      "",
      "This file is linked from many generated notes.",
      "",
    ].join("\n")
  );

  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    const area = Math.floor(i / 50).toString().padStart(2, "0");
    const dir = path.join(repo, "bulk", `area-${area}`);
    fs.mkdirSync(dir, { recursive: true });
    const relTitle = `Bulk-${i.toString().padStart(4, "0")}`;
    const linksHub = i % 100 === 0 || i === total - 1;
    fs.writeFileSync(
      path.join(dir, `${relTitle}.mdx`),
      [
        "---",
        `title: ${relTitle}`,
        "---",
        "",
        `# ${relTitle}`,
        "",
        linksHub ? `This generated note links to [[Hub]].` : "This generated note has no hub backlink.",
        "",
      ].join("\n")
    );
  }

}

function flattenPanels(nodes: Array<Record<string, any>>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const node of nodes) {
    out.push(node);
    const children = Array.isArray(node.children) ? node.children : [];
    out.push(...flattenPanels(children));
  }
  return out;
}

async function listPendingApprovals(app: ElectronApplication): Promise<PendingApproval[]> {
  const pending = await rpcCall(app, "shellApproval", "listPending", []) as Array<{
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
      if (!choice) throw new Error(`Userland approval ${pending.approvalId} has no options`);
      await testApi.rpcCall("shellApproval", "resolveUserland", [pending.approvalId, choice]);
      return;
    }
    await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, "session"]);
  }, approval);
}

async function resolvePendingShellApprovals(app: ElectronApplication): Promise<void> {
  const pending = await listPendingApprovals(app).catch(() => []);
  for (const approval of pending) {
    await resolveApproval(app, approval).catch(() => undefined);
  }
}

async function approvePendingStartupWork(app: ElectronApplication): Promise<void> {
  const launchSession = await rpcCall(app, "workspace", "hostTargets.beginLaunch", [
    "electron",
  ]).catch(() => null);
  if (
    launchSession &&
    typeof launchSession === "object" &&
    "sessionId" in launchSession &&
    typeof launchSession.sessionId === "string" &&
    Array.isArray((launchSession as { approvals?: unknown }).approvals) &&
    (launchSession as { approvals: unknown[] }).approvals.length > 0
  ) {
    await rpcCall(app, "workspace", "hostTargets.resolveLaunchSessionApproval", [
      launchSession.sessionId,
      "once",
    ]).catch(() => undefined);
  }
  await resolvePendingShellApprovals(app);
}

async function findLoadedSpectrolitePanelId(
  app: TestApp,
  options: { approveStartup?: boolean } = {}
): Promise<string> {
  const approveStartup = options.approveStartup ?? true;
  if (approveStartup) await approvePendingStartupWork(app.app);
  else await resolvePendingShellApprovals(app.app);
  const panels = flattenPanels(await getPanelTree(app.app));
  for (const panel of panels) {
    if (panel.snapshot?.source !== "panels/spectrolite" && panel.source !== "panels/spectrolite") {
      continue;
    }
    if (typeof panel.id === "string" && await isPanelLoaded(app.app, panel.id).catch(() => false)) {
      return panel.id;
    }
  }
  return "";
}

async function waitForSpectrolitePanel(
  app: TestApp,
  options: { approveStartup?: boolean } = {}
): Promise<string> {
  let panelId = "";
  await expect.poll(async () => {
    try {
      panelId = await findLoadedSpectrolitePanelId(app, options);
      return panelId;
    } catch {
      return "";
    }
  }, {
    timeout: 180000,
  }).not.toBe("");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const nextPanelId = await findLoadedSpectrolitePanelId(app, options);
      if (nextPanelId) {
        await startPanelDiagnostics(app.app, nextPanelId);
        return nextPanelId;
      }
    } catch {
      // The app can still be swapping Electron execution contexts here.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Spectrolite panel not found after panel tree stabilized");
}

async function liveSpectroliteText(
  app: TestApp,
  panelId: string,
  options: { approveStartup?: boolean } = {}
): Promise<{ panelId: string; text: string }> {
  const nextPanelId = await findLoadedSpectrolitePanelId(app, options).catch(() => "");
  const currentPanelId = nextPanelId || panelId;
  const text = await getPanelText(app.app, currentPanelId).catch(() => "");
  return { panelId: currentPanelId, text };
}

async function launchSpectroliteTestApp(workspacePath: string): Promise<TestApp> {
  return launchTestApp({
    workspace: workspacePath,
    launchTimeout: 180000,
    env: {
      VIBESTUDIO_AUTO_APPROVE: "1",
    },
  });
}

async function clickPanelElement(app: TestApp, panelId: string, selector: string): Promise<boolean> {
  const nativeClick = await clickPanelSelector(app.app, panelId, selector).catch(() => false);
  if (nativeClick) return true;
  return executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLElement)) return false;
      node.focus();
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      node.click();
      return true;
    })()
  `);
}

async function isPanelElementVisible(app: TestApp, panelId: string, selector: string): Promise<boolean> {
  return executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        node.getAttribute("data-state") !== "closed";
    })()
  `);
}

async function openSpectroliteViewDrawer(
  app: TestApp,
  panelId: string,
  method: "openBacklinks" | "openFiles" | "openSettings"
): Promise<boolean> {
  return executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const view = globalThis.__spectroliteE2EView__;
      const open = view?.[${JSON.stringify(method)}];
      if (typeof open !== "function") return false;
      open();
      return true;
    })()
  `).catch(() => false);
}

async function openFilesDrawer(app: TestApp, panelId: string): Promise<void> {
  const alreadyOpen = await isPanelElementVisible(
    app,
    panelId,
    '[data-testid="spectrolite-files-drawer"]'
  );
  if (alreadyOpen) return;
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain('data-testid="spectrolite-files-trigger"');
  const opened =
    await openSpectroliteViewDrawer(app, panelId, "openFiles") ||
    await clickPanelElement(app, panelId, '[data-testid="spectrolite-files-trigger"]');
  expect(opened).toBe(true);
  await expect.poll(() => isPanelElementVisible(
    app,
    panelId,
    '[data-testid="spectrolite-files-drawer"]'
  ), {
    timeout: 30000,
  }).toBe(true);
}

async function openFileFromFilesDrawer(app: TestApp, panelId: string, fileName: string): Promise<void> {
  await openFilesDrawer(app, panelId);
  expect(await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const button = document.querySelector('[data-testid="spectrolite-files-drawer"] [aria-label="Refresh"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `)).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain(fileName);
  const opened = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const target = ${JSON.stringify(fileName)};
      const drawer = document.querySelector('[data-testid="spectrolite-files-drawer"]');
      if (!(drawer instanceof HTMLElement)) return false;
      const link = Array.from(drawer.querySelectorAll('button, a'))
        .find((node) => node instanceof HTMLElement && node.textContent?.includes(target));
      if (!(link instanceof HTMLElement)) return false;
      link.click();
      return true;
    })()
  `);
  expect(opened).toBe(true);
  await expect.poll(() => executePanelScript<boolean>(app.app, panelId, `
    !document.querySelector('[data-testid="spectrolite-files-drawer"]')
  `), {
    timeout: 10000,
  }).toBe(true);
}

async function openBacklinksDrawer(app: TestApp, panelId: string): Promise<void> {
  const alreadyOpen = await isPanelElementVisible(
    app,
    panelId,
    '[data-testid="spectrolite-backlinks-drawer"]'
  );
  if (alreadyOpen) return;
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain('data-testid="spectrolite-backlinks-trigger"');
  const opened =
    await openSpectroliteViewDrawer(app, panelId, "openBacklinks") ||
    await clickPanelElement(app, panelId, '[data-testid="spectrolite-backlinks-trigger"]');
  expect(opened).toBe(true);
  await expect.poll(() => isPanelElementVisible(
    app,
    panelId,
    '[data-testid="spectrolite-backlinks-drawer"]'
  ), {
    timeout: 30000,
  }).toBe(true);
}

async function openWorkspaceSettings(app: TestApp, panelId: string): Promise<void> {
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain('data-testid="spectrolite-workspace-settings"');
  const opened =
    await openSpectroliteViewDrawer(app, panelId, "openSettings") ||
    await clickPanelSelector(
      app.app,
      panelId,
      '[data-testid="spectrolite-workspace-settings"]'
    ).catch(() => false) ||
    await executePanelScript<boolean>(app.app, panelId, `
      (() => {
        const candidates = Array.from(document.querySelectorAll('[data-testid="spectrolite-workspace-settings"], [aria-label="Workspace settings"]'));
        const button = candidates.find((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0";
        });
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
  expect(opened).toBe(true);
  await expect.poll(() => isPanelElementVisible(
    app,
    panelId,
    '[data-testid="spectrolite-workspace-settings-drawer"]'
  ), {
    timeout: 30000,
  }).toBe(true);
}

async function closeTopDialog(app: TestApp, panelId: string): Promise<void> {
  const closed = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const buttons = Array.from(document.querySelectorAll('[aria-label="Close"]'))
        .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      const button = buttons.at(-1);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `);
  expect(closed).toBe(true);
  await expect.poll(async () => {
    const anyVisible = await executePanelScript<boolean>(app.app, panelId, `
      (() => {
        for (const node of document.querySelectorAll('[data-testid="spectrolite-files-drawer"], [data-testid="spectrolite-backlinks-drawer"], [data-testid="spectrolite-workspace-settings-drawer"]')) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            node.getAttribute("data-state") !== "closed"
          ) {
            return true;
          }
        }
        return false;
      })()
    `);
    return !anyVisible;
  }, {
    timeout: 10000,
  }).toBe(true);
}

async function getPanelLayoutIssues(app: TestApp, panelId: string): Promise<string[]> {
  return executePanelScript<string[]>(app.app, panelId, `
    (() => {
      const issues = [];
      for (const selector of [
        '[data-testid="spectrolite-editor"]',
        '[data-testid="spectrolite-mobile-actions"]',
        '[aria-label="Open files"]'
      ]) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) {
          issues.push(selector + " missing");
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) issues.push(selector + " has no visible area");
        if (rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) {
          issues.push(selector + " overflows viewport");
        }
      }
      const editor = document.querySelector('[data-testid="spectrolite-editor"]');
      const actions = document.querySelector('[data-testid="spectrolite-mobile-actions"]');
      if (editor instanceof HTMLElement && actions instanceof HTMLElement) {
        const e = editor.getBoundingClientRect();
        const a = actions.getBoundingClientRect();
        if (e.bottom > a.top + 1) issues.push("editor overlaps mobile actions");
      }
      return issues;
    })()
  `);
}

test.describe("Spectrolite", () => {
  test.describe.configure({ timeout: 360000 });

  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("opens a preselected vault and renders the requested document", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    const html = await getPanelHtml(testApp.app, panelId);
    expect(html).toContain('data-testid="spectrolite-editor"');
    expect(html).not.toContain("/projects/&lt;not-selected-yet&gt;");
  });

  test("lets the user pick the default vault from first-run state", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {});

    testApp = await launchSpectroliteTestApp(workspacePath);
    let panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-vault-default"');
    expect(await getPanelText(testApp.app, panelId)).not.toContain("@scribe");

    expect(await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-vault-default"]')).toBe(true);

    await expect.poll(async () => {
      const result = await liveSpectroliteText(testApp!, panelId, { approveStartup: false });
      panelId = result.panelId;
      if (
        result.text.includes("Open a vault") &&
        result.text.includes("projects/default") &&
        !result.text.includes("Open a file to start editing.")
      ) {
        await clickPanelSelector(
          testApp!.app,
          panelId,
          '[data-testid="spectrolite-vault-default"]'
        ).catch(() => false);
      }
      return result.text;
    }, {
      timeout: 180000,
    }).toMatch(/Loading files\.\.\.|Open a file to start editing\.|This vault is empty/);
  });

  test("switches vaults and supports manual agent add/remove", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    initializeSecondVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    let panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('contenteditable="true"');

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nOld vault dirty line must stay in default");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Old vault dirty line must stay in default");

    await openWorkspaceSettings(testApp, panelId);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-agent-add-trigger"');
    expect(await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-agent-add-trigger"]')).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-agent-option-SilentAgentWorker"');
    expect(await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-agent-option-SilentAgentWorker"]')).toBe(true);
    await expect.poll(async () => {
      await resolvePendingShellApprovals(testApp!.app);
      return executePanelScript<number>(testApp!.app, panelId, `
        document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
      `);
    }, {
      timeout: 180000,
    }).toBeGreaterThan(1);
    const removedManualAgent = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]'))
          .find((node) => node instanceof HTMLElement && !node.getAttribute("data-testid")?.endsWith("-scribe"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(removedManualAgent).toBe(true);
    await expect.poll(async () => executePanelScript<number>(testApp!.app, panelId, `
      document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
    `), {
      timeout: 60000,
    }).toBe(1);
    await closeTopDialog(testApp, panelId);

    await openWorkspaceSettings(testApp, panelId);
    const startedVaultSwitch = await clickPanelElement(
      testApp,
      panelId,
      '[data-testid="spectrolite-settings-switch-vault"]'
    );
    expect(startedVaultSwitch).toBe(true);
    await expect.poll(async () => {
      const nextPanelId = await findLoadedSpectrolitePanelId(testApp!, {
        approveStartup: false,
      }).catch(() => "");
      if (nextPanelId) panelId = nextPanelId;
      return getPanelHtml(testApp!.app, panelId).catch(() => "");
    }, {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-vault-second"');

    // Selecting a vault reopens the panel under a new context (panel reloads).
    await rpcCall(testApp.app, "panelTree", "navigate", [
      panelId,
      "panels/spectrolite",
      {
        contextId: e2eVaultContextId("projects/second"),
        stateArgs: { repoRoot: "projects/second" },
      },
    ]);
    await expect.poll(async () => {
      const result = await liveSpectroliteText(testApp!, panelId, { approveStartup: false });
      panelId = result.panelId;
      if (result.text.includes("Open a vault") && result.text.includes("projects/second")) {
        await rpcCall(testApp!.app, "panelTree", "navigate", [
          panelId,
          "panels/spectrolite",
          {
            contextId: e2eVaultContextId("projects/second"),
            stateArgs: { repoRoot: "projects/second" },
          },
        ]).catch(() => false);
        return "";
      }
      return result.text;
    }, {
      timeout: 180000,
    }).toMatch(/Loading files\.\.\.|Open a file to start editing\.|This vault is empty/);

    await openFilesDrawer(testApp, panelId);
    expect(await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = document.querySelector('[aria-label="Refresh"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `)).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Second.mdx");

    await openFileFromFilesDrawer(testApp, panelId, "Second.mdx");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Second Vault");

  });

  test("recovers from an empty vault by creating a starter note", async () => {
    workspacePath = createManagedTestWorkspace();
    const repo = path.join(workspacePath, "source", "projects", "empty");
    fs.mkdirSync(repo, { recursive: true });
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/empty",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("This vault is empty");
    const createdStarter = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Create starter note"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(createdStarter).toBe(true);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Welcome to Spectrolite");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Welcome.mdx");
  });

  // external write conflicts and missing files — pending: co-edit reconcile + suggestion-card e2e
  test.fixme("surfaces external write conflicts and missing active files", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nUser keeps this unflushed line");

    const installedE2EHook = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const install = globalThis.__spectroliteInstallE2E__;
        return typeof install === "function" ? install() : false;
      })()
    `);
    expect(installedE2EHook).toBe(true);

    const externalWrite = await executePanelScript<boolean>(testApp.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return false;
        await api.writeFile("E2E.mdx", [
          "---",
          "title: E2E",
          "---",
          "",
          "# E2E Note",
          "",
          "External agent edit.",
          ""
        ].join("\\n"));
        return true;
      })()
    `);
    expect(externalWrite).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-disk-conflict"');

    const keptMine = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Keep my edits"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(keptMine).toBe(true);

    await openFilesDrawer(testApp, panelId);
    const openedLinked = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("Linked.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedLinked).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("This note points at");

    const externalDelete = await executePanelScript<boolean>(testApp.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return false;
        await api.unlink("Linked.mdx");
        return true;
      })()
    `);
    expect(externalDelete).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-file-missing"');
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Your in-memory buffer is the only copy");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Recreate file");
  });

  test("auto-saves edits and shows the publish bar", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nE2E Spectrolite edit");

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Spectrolite edit");

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-publish-bar"');
  });

  test("auto-saves an edit", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nCommitted by e2e");

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Committed by e2e");

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-publish-button"');
  });

  test("shows backlinks and keeps the editor usable around failing live JSX", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await openBacklinksDrawer(testApp, panelId);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-backlink-Linked.mdx"');
    await closeTopDialog(testApp, panelId);

    await openFileFromFilesDrawer(testApp, panelId, "LiveError.mdx");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-live-jsx-error"');
    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
  });

  test("keeps discovery and backlinks responsive in a large vault", async () => {
    test.setTimeout(480000);
    workspacePath = createManagedTestWorkspace();
    initializeLargeVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "Hub.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Large Hub");

    await openFilesDrawer(testApp, panelId);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Bulk-1999.mdx");

    const fileMetrics = await executePanelScript<{ files: number; responsive: boolean }>(testApp.app, panelId, `
      (() => {
        const fileButtons = Array.from(document.querySelectorAll("button"))
          .filter((node) => node instanceof HTMLElement && node.textContent?.includes(".mdx"));
        const refresh = document.querySelector('[aria-label="Refresh"]');
        if (refresh instanceof HTMLElement) refresh.click();
        return {
          files: fileButtons.length,
          responsive: document.querySelector('[data-testid="spectrolite-editor"]') instanceof HTMLElement,
        };
      })()
    `);
    expect(fileMetrics.files).toBeGreaterThanOrEqual(2001);
    expect(fileMetrics.responsive).toBe(true);
    await closeTopDialog(testApp, panelId);

    await openBacklinksDrawer(testApp, panelId);
    await expect.poll(async () => {
      await openSpectroliteViewDrawer(testApp!, panelId, "openBacklinks");
      return getPanelHtml(testApp!.app, panelId);
    }, {
      timeout: 180000,
    }).toContain("spectrolite-backlink-bulk/area-39/Bulk-1999.mdx");

    const metrics = await executePanelScript<{ backlinks: number; responsive: boolean }>(testApp.app, panelId, `
      (() => {
        const backlinkLinks = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'));
        return {
          backlinks: backlinkLinks.length,
          responsive: document.querySelector('[data-testid="spectrolite-editor"]') instanceof HTMLElement,
        };
      })()
    `);
    expect(metrics.backlinks).toBeGreaterThanOrEqual(21);
    expect(metrics.responsive).toBe(true);

    const openedFarBacklink = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Bulk-1999.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedFarBacklink).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Bulk-1999");
  });

  test("keeps core controls usable in a mobile-sized viewport", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchSpectroliteTestApp(workspacePath);
    const panelId = await waitForSpectrolitePanel(testApp);
    await testApp.app.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0]?.setSize(390, 740);
    });
    await testApp.window.setViewportSize({ width: 390, height: 740 });
    await testApp.window.waitForTimeout(1000);

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-mobile-actions"');
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-editor"');
    const issues = await getPanelLayoutIssues(testApp, panelId);
    expect(issues).toEqual([]);

    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Open files"]')).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Files");
    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close files"]')).toBe(true);

    const openedSettings = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = document.querySelector('[aria-label="Workspace settings"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(openedSettings).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Workspace");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Agents");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-vcs-head"');

    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close"]')).toBe(true);
    await expect.poll(() => executePanelScript<boolean>(testApp!.app, panelId, `
      (() => {
        const actions = document.querySelector('[data-testid="spectrolite-mobile-actions"]');
        if (!(actions instanceof HTMLElement)) return false;
        return actions.querySelector('[data-testid="spectrolite-send-to-scribe"]') instanceof HTMLElement;
      })()
    `), {
      timeout: 60000,
    }).toBe(true);
  });
});
