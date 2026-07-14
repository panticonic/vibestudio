import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import {
  approvePendingStartupWork,
  clickPanelSelector,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  executePanelScript,
  getExtensionRegistry,
  getPanelHtml,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  isPanelLoaded,
  launchTestApp,
  removeManagedTestWorkspace,
  resolvePendingShellApprovals,
  startPanelDiagnostics,
  type TestApp,
  testRpcCall as rpcCall,
  createManagedTestWorkspace,
  typePanelText,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function e2eVaultContextId(vaultWorkspaceRoot: string): string {
  const input = vaultWorkspaceRoot.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
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

function replaceInitPanels(workspacePath: string, stateArgs: Record<string, unknown>): void {
  const configPath = path.join(workspacePath, "source", "meta", "vibestudio.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [
    Object.keys(stateArgs).length > 0
      ? {
          source: "panels/spectrolite",
          env: { VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS: "1" },
          stateArgs,
        }
      : {
          source: "panels/spectrolite",
          env: { VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS: "1" },
        },
  ];
  config.apps = [{ source: "apps/shell" }];
  config.hostTargets = {
    electron: { app: "apps/shell" },
  };
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
    ["---", "title: Linked", "---", "", "# Linked", "", "This note points at [[E2E]].", ""].join(
      "\n"
    )
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
    const area = Math.floor(i / 50)
      .toString()
      .padStart(2, "0");
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
        linksHub
          ? `This generated note links to [[Hub]].`
          : "This generated note has no hub backlink.",
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

async function findLoadedSpectrolitePanelId(
  app: TestApp,
  options: { approveStartup?: boolean } = {}
): Promise<string> {
  const approveStartup = options.approveStartup ?? true;
  if (approveStartup) await approvePendingStartupWork(app.app);
  else await resolvePendingShellApprovals(app.app);
  const panels = flattenPanels(await getPanelTree(app.app));
  for (const panel of panels) {
    const source = panel.snapshot?.source ?? panel.source;
    if (source !== "panels/spectrolite") {
      continue;
    }
    if (typeof panel.id === "string") {
      const loaded = await isPanelLoaded(app.app, panel.id).catch(() => false);
      const html = loaded ? await getPanelHtml(app.app, panel.id).catch(() => "") : "";
      if (html.includes('data-testid="spectrolite')) {
        return panel.id;
      }
    }
  }
  return "";
}

async function waitForSpectrolitePanel(
  app: TestApp,
  options: { approveStartup?: boolean } = {}
): Promise<string> {
  let panelId = "";
  await expect
    .poll(
      async () => {
        try {
          panelId = await findLoadedSpectrolitePanelId(app, options);
          return panelId;
        } catch {
          return "";
        }
      },
      {
        timeout: 180000,
      }
    )
    .not.toBe("");
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

async function clickPanelElement(
  app: TestApp,
  panelId: string,
  selector: string
): Promise<boolean> {
  const nativeClick = await clickPanelSelector(app.app, panelId, selector).catch(() => false);
  if (nativeClick) return true;
  return executePanelScript<boolean>(
    app.app,
    panelId,
    `
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
  `
  );
}

async function isPanelElementVisible(
  app: TestApp,
  panelId: string,
  selector: string
): Promise<boolean> {
  return executePanelScript<boolean>(
    app.app,
    panelId,
    `
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
  `
  ).catch(() => false);
}

async function getSpectroliteViewHookState(
  app: TestApp,
  panelId: string
): Promise<{
  backlinksOpen: boolean | null;
  filesOpen: boolean | null;
  settingsOpen: boolean | null;
  sidebarOpen: boolean | null;
} | null> {
  return executePanelScript<{
    backlinksOpen: boolean | null;
    filesOpen: boolean | null;
    settingsOpen: boolean | null;
    sidebarOpen: boolean | null;
  } | null>(
    app.app,
    panelId,
    `
    (() => {
      const hook = globalThis.__spectroliteE2EView__;
      if (!hook) return null;
      const toValue = (value?: () => boolean) => (
        typeof value === "function" ? Boolean(value()) : null
      );
      return {
        backlinksOpen: toValue(hook.isBacklinksOpen),
        filesOpen: toValue(hook.isFilesOpen),
        settingsOpen: toValue(hook.isSettingsOpen),
        sidebarOpen: toValue(hook.isSidebarOpen),
      };
    })()
  `
  ).catch(() => null);
}

async function openSpectroliteViewDrawer(
  app: TestApp,
  panelId: string,
  method: "openBacklinks" | "openFiles" | "openSettings"
): Promise<boolean> {
  return executePanelScript<boolean>(
    app.app,
    panelId,
    `
    (() => {
      const view = globalThis.__spectroliteE2EView__;
      const open = view?.[${JSON.stringify(method)}];
      if (typeof open !== "function") return false;
      open();
      return true;
    })()
  `
  ).catch(() => false);
}

async function isMobileSpectroliteLayout(app: TestApp, panelId: string): Promise<boolean> {
  return executePanelScript<boolean>(
    app.app,
    panelId,
    `
    (() => {
      const isVisible = (node) => {
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
      };
      const hasDesktopFiles = isVisible(document.querySelector('[data-testid="spectrolite-files-trigger"]'));
      const hasDesktopBacklinks = isVisible(document.querySelector('[data-testid="spectrolite-backlinks-trigger"]'));
      if (hasDesktopFiles || hasDesktopBacklinks) return false;
      if (isVisible(document.querySelector('[aria-label="Open files"]')) ||
        isVisible(document.querySelector('[data-testid="spectrolite-mobile-actions"]'))) {
        return true;
      }
      return window.matchMedia("(max-width: 767px)").matches;
    })()
  `
  );
}

async function ensureMobileShellStackMode(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const clicked = await contents.executeJavaScript(
          `(() => {
            const labels = ["Close panel tree", "Switch to breadcrumb navigation"];
            const button = Array.from(document.querySelectorAll("[aria-label]"))
              .find((node) => labels.includes(node.getAttribute("aria-label") ?? ""));
            if (!(button instanceof HTMLElement)) return false;
            button.click();
            return true;
          })()`,
          true
        );
        if (clicked) return;
      } catch {
        // Ignore non-DOM webContents and transient navigation races.
      }
    }
  });
}

async function openFilesDrawer(app: TestApp, panelId: string): Promise<void> {
  const isMobile = await isMobileSpectroliteLayout(app, panelId);
  const state = await getSpectroliteViewHookState(app, panelId);
  const alreadyOpenState = state ? (isMobile ? state.sidebarOpen : state.filesOpen) : null;
  const alreadyOpen = alreadyOpenState === true;
  if (alreadyOpen) {
    return;
  }
  const triggerSelector = isMobile
    ? '[aria-label="Open files"]'
    : '[data-testid="spectrolite-files-trigger"]';
  const drawerSelector = isMobile
    ? '[aria-label="Close files"]'
    : '[data-testid="spectrolite-files-drawer"]';
  await expect
    .poll(() => getPanelHtml(app.app, panelId), {
      timeout: 60000,
    })
    .toContain(isMobile ? 'aria-label="Open files"' : 'data-testid="spectrolite-files-trigger"');
  try {
    await expect
      .poll(
        async () => {
          const state = await getSpectroliteViewHookState(app, panelId);
          if (isMobile ? state?.sidebarOpen === true : state?.filesOpen === true) return true;
          if (await isPanelElementVisible(app, panelId, drawerSelector)) return true;

          // Prefer the panel's controlled-state test seam once it is installed.
          // Dispatching a synthetic click and a state update in the same turn
          // can carry the closing Radix dialog's pointer event into the drawer.
          // Non-instrumented panels retain the native click fallback.
          const hooked = await openSpectroliteViewDrawer(app, panelId, "openFiles");
          if (!hooked) {
            const clicked = await clickPanelSelector(app.app, panelId, triggerSelector).catch(
              () => false
            );
            if (!clicked) {
              await clickPanelElement(app, panelId, triggerSelector).catch(() => false);
            }
          }
          return false;
        },
        {
          timeout: 30000,
        }
      )
      .toBe(true);
  } catch (error) {
    const diagnostics = await executePanelScript<Record<string, unknown>>(
      app.app,
      panelId,
      `
      (() => {
        const view = globalThis.__spectroliteE2EView__;
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        const drawer = document.querySelector(${JSON.stringify(drawerSelector)});
        return {
          href: location.href,
          visibility: document.visibilityState,
          hookKeys: view ? Object.keys(view) : [],
          hookState: view ? {
            files: typeof view.isFilesOpen === "function" ? view.isFilesOpen() : null,
            sidebar: typeof view.isSidebarOpen === "function" ? view.isSidebarOpen() : null,
          } : null,
          triggerConnected: trigger instanceof HTMLElement ? trigger.isConnected : false,
          triggerDisabled: trigger instanceof HTMLButtonElement ? trigger.disabled : null,
          triggerState: trigger?.getAttribute("data-state") ?? null,
          drawerConnected: drawer instanceof HTMLElement ? drawer.isConnected : false,
          drawerState: drawer?.getAttribute("data-state") ?? null,
          bodyPointerEvents: document.body.style.pointerEvents,
          activeElement: document.activeElement?.getAttribute("data-testid") ??
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.tagName ?? null,
        };
      })()
    `
    ).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`Files drawer did not open: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
}

async function openFileFromFilesDrawer(
  app: TestApp,
  panelId: string,
  fileName: string
): Promise<void> {
  const isMobile = await isMobileSpectroliteLayout(app, panelId);
  await openFilesDrawer(app, panelId);
  const refreshPressed = await executePanelScript<boolean>(
    app.app,
    panelId,
    `
    (() => {
      const drawer = document.querySelector('[data-testid="spectrolite-files-drawer"]');
      const button = (drawer ?? document).querySelector('[aria-label="Refresh"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `
  ).catch(() => false);
  expect(refreshPressed).toBe(true);
  await expect
    .poll(() => getPanelHtml(app.app, panelId), {
      timeout: 60000,
    })
    .toContain(fileName);
  const opened = await executePanelScript<boolean>(
    app.app,
    panelId,
    `
    (() => {
      const target = ${JSON.stringify(fileName)};
      const drawer = document.querySelector('[data-testid="spectrolite-files-drawer"]') ?? document;
      const link = Array.from(drawer.querySelectorAll('button, a'))
        .find((node) => node instanceof HTMLElement && node.textContent?.includes(target));
      if (!(link instanceof HTMLElement)) return false;
      link.click();
      return true;
    })()
  `
  );
  expect(opened).toBe(true);
  const closeSelector = isMobile
    ? '[aria-label="Close files"]'
    : '[data-testid="spectrolite-files-drawer"]';
  await expect
    .poll(
      () =>
        executePanelScript<boolean>(
          app.app,
          panelId,
          `
    (() => {
      const selector = ${JSON.stringify(closeSelector)};
      return !Boolean(document.querySelector(selector));
    })()
  `
        ),
      {
        timeout: 10000,
      }
    )
    .toBe(true);
}

async function openBacklinksDrawer(app: TestApp, panelId: string): Promise<void> {
  const isMobile = await isMobileSpectroliteLayout(app, panelId);
  const isOpen = async (): Promise<boolean> => {
    const state = await getSpectroliteViewHookState(app, panelId);
    if (state) {
      if (isMobile) {
        if (state.sidebarOpen === true) return true;
      } else if (state.backlinksOpen === true) {
        return true;
      }
    }
    return executePanelScript<boolean>(
      app.app,
      panelId,
      `
      (() => {
        const backlinksPanel = document.querySelector('[data-testid="spectrolite-backlinks"]');
        if (backlinksPanel instanceof HTMLElement) return true;
        const drawer = document.querySelector('[data-testid="spectrolite-backlinks-drawer"]');
        if (${isMobile}) {
          if (document.querySelector('[aria-label="Close files"]')) return true;
          return drawer instanceof HTMLElement ||
            document.querySelectorAll('[data-testid^="spectrolite-backlink-"]').length > 0;
        }
        if (drawer instanceof HTMLElement) return true;
        return false;
      })()
    `
    ).catch(() => false);
  };
  if (await isOpen()) return;

  await expect
    .poll(
      async () => {
        const html = await getPanelHtml(app.app, panelId);
        if (isMobile) {
          return (
            html.includes('aria-label="Open files"') ||
            html.includes('data-testid="spectrolite-mobile-actions"')
          );
        }
        return (
          html.includes('data-testid="spectrolite-backlinks-trigger"') ||
          html.includes('aria-label="Backlinks"') ||
          html.includes('title="Backlinks"')
        );
      },
      {
        timeout: 60000,
      }
    )
    .toBe(true);
  if (isMobile) {
    await openFilesDrawer(app, panelId);
    await expect.poll(() => isOpen(), { timeout: 30000 }).toBe(true);
    return;
  }

  // A bridge-level click result only confirms dispatch. Radix can still be
  // restoring focus from the previous dialog, so retry the user gesture until
  // controlled state or visible DOM confirms that React accepted it.
  await expect
    .poll(
      async () => {
        if (await isOpen()) return true;
        const clicked = await clickPanelSelector(
          app.app,
          panelId,
          '[data-testid="spectrolite-backlinks-trigger"]'
        ).catch(() => false);
        if (!clicked) {
          await clickPanelElement(
            app,
            panelId,
            '[data-testid="spectrolite-backlinks-trigger"]'
          ).catch(() => false);
        }
        return isOpen();
      },
      { timeout: 30000 }
    )
    .toBe(true);
}

async function openWorkspaceSettings(app: TestApp, panelId: string): Promise<void> {
  const isMobile = await isMobileSpectroliteLayout(app, panelId);
  await expect
    .poll(() => getPanelHtml(app.app, panelId), {
      timeout: 60000,
    })
    .toContain(
      isMobile ? 'aria-label="Workspace settings"' : 'data-testid="spectrolite-workspace-settings"'
    );
  let opened =
    (await openSpectroliteViewDrawer(app, panelId, "openSettings")) ||
    (await clickPanelSelector(
      app.app,
      panelId,
      '[data-testid="spectrolite-workspace-settings"]'
    ).catch(() => false)) ||
    (await executePanelScript<boolean>(
      app.app,
      panelId,
      `
      (() => {
        const button = document.querySelector('[data-testid="spectrolite-workspace-settings"], [aria-label="Workspace settings"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `
    ));
  if (!opened && isMobile) {
    opened = await clickPanelElement(app, panelId, '[aria-label="Workspace settings"]').catch(
      () => false
    );
  }
  expect(opened).toBe(true);
  await expect
    .poll(
      () =>
        executePanelScript<boolean>(
          app.app,
          panelId,
          `
    Boolean(document.querySelector('[data-testid="spectrolite-workspace-settings-drawer"]'))
  `
        ),
      {
        timeout: 30000,
      }
    )
    .toBe(true);
}

async function closeTopDialog(app: TestApp, panelId: string): Promise<void> {
  const closed = await executePanelScript<boolean>(
    app.app,
    panelId,
    `
    (() => {
      const buttons = Array.from(document.querySelectorAll('[aria-label="Close"], [aria-label="Done"]'))
        .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      const button = buttons.at(-1);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `
  );
  expect(closed).toBe(true);
  await expect
    .poll(
      async () => {
        const anyVisible = await executePanelScript<boolean>(
          app.app,
          panelId,
          `
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
    `
        );
        return !anyVisible;
      },
      {
        timeout: 10000,
      }
    )
    .toBe(true);
}

async function getPanelLayoutIssues(app: TestApp, panelId: string): Promise<string[]> {
  return executePanelScript<string[]>(
    app.app,
    panelId,
    `
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
  `
  );
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Note");

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

    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-vault-default"');
    expect(await getPanelText(testApp.app, panelId)).not.toContain("@scribe");

    expect(
      await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-vault-default"]')
    ).toBe(true);

    await expect
      .poll(
        async () => {
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
        },
        {
          timeout: 180000,
        }
      )
      .toMatch(/Loading files\.\.\.|Open a file to start editing\.|This vault is empty/);
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Note");
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('contenteditable="true"');

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nOld vault dirty line must stay in default");
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Old vault dirty line must stay in default");

    await openWorkspaceSettings(testApp, panelId);
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-agent-add-trigger"');
    await expect
      .poll(
        async () =>
          executePanelScript<boolean>(
            testApp!.app,
            panelId,
            `
      (() => {
        const addButton = document.querySelector('[data-testid="spectrolite-agent-add-trigger"]');
        if (!(addButton instanceof HTMLButtonElement)) return false;
        return !addButton.disabled;
      })()
    `
          ),
        {
          timeout: 60000,
        }
      )
      .toBe(true);
    const removeCountBeforeAdd = await executePanelScript<number>(
      testApp.app,
      panelId,
      `
      (() => {
        return document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length;
      })()
    `
    );
    const removeIdsBeforeAdd = await executePanelScript<string[]>(
      testApp.app,
      panelId,
      `
      (() => {
        return Array.from(document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]'))
          .map((node) => node.getAttribute("data-testid"))
          .filter((id) => Boolean(id));
      })()
    `
    );
    expect(
      await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-agent-add-trigger"]')
    ).toBe(true);
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            testApp!.app,
            panelId,
            `
      (() => {
        return document.querySelectorAll('[data-testid^="spectrolite-agent-option-"]').length > 0;
      })()
    `
          ),
        {
          timeout: 10000,
        }
      )
      .toBe(true);
    const addOptions = await executePanelScript<Array<{ id: string; label: string }>>(
      testApp.app,
      panelId,
      `
      (() => {
        return Array.from(document.querySelectorAll('[data-testid^="spectrolite-agent-option-"]'))
          .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
          .map((node) => ({
            id: node.getAttribute("data-testid") ?? "",
            label: (node.textContent ?? "").toLowerCase(),
          }))
          .filter((item) => item.id.length > 0);
      })()
    `
    );
    const selected = addOptions.find((item) => !item.label.includes("scribe")) ?? addOptions[0];
    if (!selected) {
      throw new Error("No agent option available");
    }
    const selectedAgentClicked =
      (await clickPanelSelector(testApp.app, panelId, `[data-testid="${selected.id}"]`).catch(
        () => false
      )) ||
      (await clickPanelElement(testApp, panelId, `[data-testid="${selected.id}"]`).catch(
        () => false
      ));
    expect(selectedAgentClicked).toBe(true);
    await expect
      .poll(
        async () => {
          await resolvePendingShellApprovals(testApp!.app);
          return executePanelScript<number>(
            testApp!.app,
            panelId,
            `
        document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
      `
          );
        },
        {
          timeout: 120000,
        }
      )
      .toBeGreaterThan(removeCountBeforeAdd);

    const removeIdsAfterAdd = await executePanelScript<string[]>(
      testApp.app,
      panelId,
      `
      (() => {
        return Array.from(document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]'))
          .map((node) => node.getAttribute("data-testid"))
          .filter((id) => Boolean(id));
      })()
    `
    );
    const removableId =
      removeIdsAfterAdd.find((id) => !removeIdsBeforeAdd.includes(id) && !id.endsWith("-scribe")) ??
      removeIdsAfterAdd.find((id) => !removeIdsBeforeAdd.includes(id)) ??
      removeIdsAfterAdd.find((id) => !id.endsWith("-scribe"));
    if (!removableId) {
      throw new Error("Could not find a removable agent entry");
    }
    await expect
      .poll(
        async () =>
          executePanelScript<boolean>(
            testApp!.app,
            panelId,
            `
      (() => {
        const button = document.querySelector(${JSON.stringify(`[data-testid="${removableId}"]`)});
        return button instanceof HTMLButtonElement && !button.disabled;
      })()
    `
          ),
        { timeout: 60000 }
      )
      .toBe(true);
    const removedManualAgent = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const selector = ${JSON.stringify(`[data-testid="${removableId}"]`)};
        const button = document.querySelector(selector);
        const action = button instanceof HTMLElement ? button : button?.closest("button");
        if (!(action instanceof HTMLElement)) return false;
        action.click();
        return true;
      })()
    `
    );
    expect(removedManualAgent).toBe(true);
    await expect
      .poll(
        async () =>
          executePanelScript<number>(
            testApp!.app,
            panelId,
            `
      document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
    `
          ),
        {
          timeout: 60000,
        }
      )
      .toBeLessThan(removeCountBeforeAdd + 1);
    await closeTopDialog(testApp, panelId);

    await openWorkspaceSettings(testApp, panelId);
    const startedVaultSwitch = await clickPanelElement(
      testApp,
      panelId,
      '[data-testid="spectrolite-settings-switch-vault"]'
    );
    expect(startedVaultSwitch).toBe(true);
    await expect
      .poll(
        async () => {
          const nextPanelId = await findLoadedSpectrolitePanelId(testApp!, {
            approveStartup: false,
          }).catch(() => "");
          if (nextPanelId) panelId = nextPanelId;
          return getPanelHtml(testApp!.app, panelId).catch(() => "");
        },
        {
          timeout: 60000,
        }
      )
      .toContain('data-testid="spectrolite-vault-second"');

    // Selecting a vault reopens the panel under a new context (panel reloads).
    await rpcCall(testApp.app, "panelTree", "navigate", [
      panelId,
      "panels/spectrolite",
      {
        contextId: e2eVaultContextId("projects/second"),
        stateArgs: { repoRoot: "projects/second" },
      },
    ]);
    await expect
      .poll(
        async () => {
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
        },
        {
          timeout: 180000,
        }
      )
      .toMatch(/Loading files\.\.\.|Open a file to start editing\.|This vault is empty/);

    await openFilesDrawer(testApp, panelId);
    expect(
      await executePanelScript<boolean>(
        testApp.app,
        panelId,
        `
      (() => {
        const button = document.querySelector('[aria-label="Refresh"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `
      )
    ).toBe(true);
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Second.mdx");

    await openFileFromFilesDrawer(testApp, panelId, "Second.mdx");
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Second Vault");
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

    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toMatch(/This vault is empty|No\.mdx files yet|Open files/);
    const createdStarter = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Create starter note"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `
    );
    expect(createdStarter).toBe(true);

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Welcome to Spectrolite");
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Welcome.mdx");
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nUser keeps this unflushed line");

    const installedE2EHook = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const install = globalThis.__spectroliteInstallE2E__;
        return typeof install === "function" ? install() : false;
      })()
    `
    );
    expect(installedE2EHook).toBe(true);

    const externalWrite = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
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
    `
    );
    expect(externalWrite).toBe(true);
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-disk-conflict"');

    const keptMine = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Keep my edits"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `
    );
    expect(keptMine).toBe(true);

    await openFilesDrawer(testApp, panelId);
    const openedLinked = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("Linked.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `
    );
    expect(openedLinked).toBe(true);
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("This note points at");

    const externalDelete = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return false;
        await api.unlink("Linked.mdx");
        return true;
      })()
    `
    );
    expect(externalDelete).toBe(true);
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-file-missing"');
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Your in-memory buffer is the only copy");
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Recreate file");
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nE2E Spectrolite edit");

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Spectrolite edit");

    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-publish-bar"');
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nCommitted by e2e");

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Committed by e2e");

    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-publish-button"');
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
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-backlink-Linked.mdx"');
    await closeTopDialog(testApp, panelId);

    await openFileFromFilesDrawer(testApp, panelId, "LiveError.mdx");
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-live-jsx-error"');
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

    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Large Hub");

    await openFilesDrawer(testApp, panelId);
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Bulk-1999.mdx");

    const fileMetrics = await executePanelScript<{ files: number; responsive: boolean }>(
      testApp.app,
      panelId,
      `
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
    `
    );
    expect(fileMetrics.files).toBeGreaterThanOrEqual(2001);
    expect(fileMetrics.responsive).toBe(true);
    await closeTopDialog(testApp, panelId);

    await openBacklinksDrawer(testApp, panelId);
    await expect
      .poll(
        async () => {
          await openSpectroliteViewDrawer(testApp!, panelId, "openBacklinks");
          return getPanelHtml(testApp!.app, panelId);
        },
        {
          timeout: 180000,
        }
      )
      .toContain("spectrolite-backlink-bulk/area-39/Bulk-1999.mdx");

    const metrics = await executePanelScript<{ backlinks: number; responsive: boolean }>(
      testApp.app,
      panelId,
      `
      (() => {
        const backlinkLinks = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'));
        return {
          backlinks: backlinkLinks.length,
          responsive: document.querySelector('[data-testid="spectrolite-editor"]') instanceof HTMLElement,
        };
      })()
    `
    );
    expect(metrics.backlinks).toBeGreaterThanOrEqual(21);
    expect(metrics.responsive).toBe(true);

    const openedFarBacklink = await executePanelScript<boolean>(
      testApp.app,
      panelId,
      `
      (() => {
        const link = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Bulk-1999.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `
    );
    expect(openedFarBacklink).toBe(true);
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Bulk-1999");
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
    await ensureMobileShellStackMode(testApp.app);
    await expect
      .poll(() => executePanelScript<number>(testApp!.app, panelId, "window.innerWidth"), {
        timeout: 30000,
        intervals: [250, 500, 1000],
      })
      .toBeGreaterThan(300);
    await testApp.window.waitForTimeout(1000);

    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-mobile-actions"');
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-editor"');
    const issues = await getPanelLayoutIssues(testApp, panelId);
    expect(issues).toEqual([]);

    await openFilesDrawer(testApp, panelId);
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            testApp!.app,
            panelId,
            `
      (() => {
        const close = document.querySelector('[aria-label="Close files"]');
        return close instanceof HTMLElement;
      })()
    `
          ),
        {
          timeout: 60000,
        }
      )
      .toBe(true);
    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close files"]')).toBe(true);

    await openWorkspaceSettings(testApp, panelId);
    await expect
      .poll(() => getPanelText(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain("Workspace");
    await expect
      .poll(() => getPanelHtml(testApp!.app, panelId), {
        timeout: 60000,
      })
      .toContain('data-testid="spectrolite-vcs-head"');

    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close"]')).toBe(true);
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            testApp!.app,
            panelId,
            `
      (() => {
        const actions = document.querySelector('[data-testid="spectrolite-mobile-actions"]');
        if (!(actions instanceof HTMLElement)) return false;
        return actions.querySelector('[data-testid="spectrolite-send-to-scribe"]') instanceof HTMLElement;
      })()
    `
          ),
        {
          timeout: 60000,
        }
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const extensions = await getExtensionRegistry(testApp!.app);
          const devHost = extensions.find(
            (entry) => entry.name === "@workspace-extensions/dev-host"
          );
          return devHost ? { status: devHost.status, lastError: devHost.lastError } : null;
        },
        { timeout: 120_000 }
      )
      .toEqual({ status: "running", lastError: null });
    await expect(testApp.window.getByText("Extension stopped", { exact: true })).toHaveCount(0);
  });
});
