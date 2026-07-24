import { app, dialog, Menu, MenuItemConstructorOptions, type WebContents } from "electron";
import type { EventName, EventPayloads, EventService } from "@vibestudio/shared/eventsService";
import type { ViewManager } from "./viewManager.js";
import type { BridgePanelLifecycle } from "@vibestudio/shared/panelInterfaces";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { PANEL_KEYBOARD_ACCELERATORS } from "@vibestudio/shared/panelCommands";
import { assertPresent } from "../lintHelpers";
// These page ids identify workspace-provided units under `about/` that the menu
// assumes exist. The `navigate-about` payload is a page id (not a source); the
// shell resolves it to the `about/<page>` unit and creates a privileged panel.
import { ABOUT_PAGES } from "@vibestudio/workspace-contracts/aboutNamespace";

// Set during initialization — always non-null after startup
let _menuPanelLifecycle: BridgePanelLifecycle | null = null;
let _menuPanelRegistry: PanelRegistry | null = null;
let _menuViewManager: ViewManager | null = null;
let _menuEventService: EventService | null = null;
const panelDevToolsShortcutInterceptors = new WeakSet<WebContents>();

/** Set the event service for menu operations. Called from index.ts. */
export function setMenuEventService(es: EventService): void {
  _menuEventService = es;
}

function emitMenuEvent<E extends EventName>(event: E, payload?: EventPayloads[E]): boolean {
  if (!_menuEventService) {
    console.warn(`[Menu] event service is not ready for "${event}"`);
    return false;
  }
  _menuEventService.emit(event, payload);
  return true;
}

/** Set or clear the window-owned view manager used by menu operations. */
export function setMenuViewManager(vm: ViewManager | null): void {
  _menuViewManager = vm;
}

/** Set the panel lifecycle for menu operations. Called from index.ts. */
export function setMenuPanelLifecycle(lc: BridgePanelLifecycle): void {
  _menuPanelLifecycle = lc;
}

/** Set the panel registry for menu operations. Called from index.ts. */
export function setMenuPanelRegistry(reg: PanelRegistry): void {
  _menuPanelRegistry = reg;
}

/** Close the currently focused panel. Falls back to window close if no panel is focused. */
async function archiveFocusedPanel(mainWindow: Electron.BaseWindow | null): Promise<void> {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (focusedId && _menuPanelLifecycle) {
    const panel = _menuPanelRegistry?.getPanel(focusedId);
    const descendantCount = panel ? countPanelDescendants(panel) : 0;
    if (descendantCount > 0) {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Close panel tree?",
        message: `Close “${panel?.title ?? "this panel"}” and ${descendantCount} child panel${descendantCount === 1 ? "" : "s"}?`,
        detail: "All panels below it will also be archived.",
        buttons: ["Cancel", "Close panels"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return;
    }
    await _menuPanelLifecycle.closePanel(focusedId);
  } else {
    // No focused panel: the app-menu entry falls back to closing the window.
    // The hamburger has no window handle and simply does nothing.
    mainWindow?.close();
  }
}

function countPanelDescendants(panel: { children: Array<{ children: unknown[] }> }): number {
  return panel.children.reduce(
    (count, child) => count + 1 + countPanelDescendants(child as never),
    0
  );
}

function reloadFocusedPanel(force = false): void {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager) return;
  if (force) _menuViewManager.forceReload(focusedId);
  else _menuViewManager.reload(focusedId);
}

function dispatchChromeCommand(command: "reload-panel" | "force-reload-view" | "stop"): void {
  if (!emitMenuEvent("panel-chrome-command", { command })) {
    if (command === "reload-panel") reloadFocusedPanel(false);
    if (command === "force-reload-view") reloadFocusedPanel(true);
    if (command === "stop") stopFocusedPanel();
  }
}

function stopFocusedPanel(): void {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager) return;
  _menuViewManager.stop(focusedId);
}

function openFocusedPanelDevTools(): boolean {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager?.hasView(focusedId)) {
    return false;
  }
  _menuViewManager.openDevTools(focusedId);
  return true;
}

function togglePanelDevTools(): void {
  if (!openFocusedPanelDevTools()) {
    emitMenuEvent("toggle-panel-devtools");
  }
}

function toggleAppDevTools(shellContents: WebContents): void {
  if (_menuViewManager?.openHostChromeAppDevTools()) {
    return;
  }
  if (shellContents && !shellContents.isDestroyed()) {
    shellContents.toggleDevTools();
  }
}

function isPanelDevToolsInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown") {
    return false;
  }
  if (input.key.toLowerCase() !== "i" && input.code !== "KeyI") {
    return false;
  }
  const hasPrimary = process.platform === "darwin" ? input.meta : input.control;
  return hasPrimary && input.shift && !input.alt;
}

function interceptPanelDevToolsShortcut(shellContents: WebContents): void {
  if (panelDevToolsShortcutInterceptors.has(shellContents)) {
    return;
  }
  panelDevToolsShortcutInterceptors.add(shellContents);

  shellContents.on("before-input-event", (event, input) => {
    if (!isPanelDevToolsInput(input)) {
      return;
    }
    event.preventDefault();
    togglePanelDevTools();
  });
}

function refreshPanelDisplay(): void {
  if (!_menuViewManager) return;
  const vm = assertPresent(_menuViewManager);
  vm.refreshVisiblePanel();
  vm.forceRepaintVisiblePanel();
}

function copyPanelDisplayDiagnostics(): void {
  if (!_menuViewManager) return;
  void assertPresent(_menuViewManager).copyPanelDisplayDiagnosticsToClipboard();
}

/**
 * Build the hamburger popup menu template.
 *
 * On Windows and Linux the shell window is a `BaseWindow` with a custom
 * titlebar, so the application menu built by `setupMenu` never renders — this
 * popup is the only menu the user can reach and has to stay complete. Complete
 * is not the same as flat, though: everything below the first group is filed
 * under a task-named submenu, so the popup opens as ~10 rows rather than the
 * thirty-odd it used to spill.
 */
export function buildHamburgerMenuTemplate(
  shellContents: WebContents,
  clearBuildCache: () => Promise<void>,
  options?: {
    onHistoryBack?: () => void;
    onHistoryForward?: () => void;
  }
): MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  const reloadPanelAccelerator = isMac ? "Cmd+R" : "Ctrl+Shift+R";
  const forceReloadAccelerator = isMac ? "Cmd+Shift+R" : "Ctrl+Alt+R";
  const addressBarAccelerator = isMac ? "Cmd+L" : "Ctrl+Shift+L";
  const commandPaletteAccelerator = isMac ? "Cmd+K" : "Ctrl+Shift+K";
  const redoAccelerator = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";

  // Panel: everything acting on the panel in the focused pane.
  const panel: MenuItemConstructorOptions[] = [];
  if (options?.onHistoryBack) {
    panel.push({ label: "Back", click: () => options.onHistoryBack?.() });
  }
  if (options?.onHistoryForward) {
    panel.push({ label: "Forward", click: () => options.onHistoryForward?.() });
  }
  if (panel.length > 0) panel.push({ type: "separator" });
  panel.push(
    {
      label: "Reload Panel",
      accelerator: reloadPanelAccelerator,
      click: () => dispatchChromeCommand("reload-panel"),
    },
    {
      label: "Force Reload View",
      accelerator: forceReloadAccelerator,
      click: () => dispatchChromeCommand("force-reload-view"),
    },
    { label: "Stop Loading", click: () => dispatchChromeCommand("stop") },
    { type: "separator" },
    {
      label: "Toggle Address Bar",
      accelerator: addressBarAccelerator,
      click: () => emitMenuEvent("toggle-address-bar"),
    },
    {
      label: "Find in Page…",
      accelerator: "CmdOrCtrl+F",
      click: () => emitMenuEvent("toggle-find-in-page"),
    },
    { type: "separator" },
    {
      label: "Close Panel",
      accelerator: PANEL_KEYBOARD_ACCELERATORS.closePanel,
      click: () => void archiveFocusedPanel(null),
    }
  );

  const edit: MenuItemConstructorOptions[] = [
    { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
    { label: "Redo", accelerator: redoAccelerator, role: "redo" },
    { type: "separator" },
    { label: "Cut", accelerator: "CmdOrCtrl+X", role: "cut" },
    { label: "Copy", accelerator: "CmdOrCtrl+C", role: "copy" },
    { label: "Paste", accelerator: "CmdOrCtrl+V", role: "paste" },
    { label: "Select All", accelerator: "CmdOrCtrl+A", role: "selectAll" },
  ];

  // View: how the window itself is presented, plus the display escape hatches.
  const view: MenuItemConstructorOptions[] = [
    { label: "Zoom In", role: "zoomIn" },
    { label: "Zoom Out", role: "zoomOut" },
    { label: "Reset Zoom", role: "resetZoom" },
    { type: "separator" },
    { label: "Toggle Full Screen", role: "togglefullscreen" },
    { label: "Minimize", role: "minimize" },
    { type: "separator" },
    { label: "Refresh Panel Display", click: () => refreshPanelDisplay() },
    { label: "Copy Panel Display Diagnostics", click: () => copyPanelDisplayDiagnostics() },
  ];

  // Workspace: the about/* pages and settings that outlive any one panel.
  const workspace: MenuItemConstructorOptions[] = [
    {
      label: "Switch Workspace…",
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => emitMenuEvent("open-workspace-switcher"),
    },
    {
      label: "Connection & Devices…",
      click: () => emitMenuEvent("open-connection-settings"),
    },
    { type: "separator" },
    {
      label: "Bookmarks…",
      accelerator: "CmdOrCtrl+Shift+B",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.BOOKMARKS }),
    },
    {
      label: "History…",
      accelerator: "CmdOrCtrl+Y",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.HISTORY }),
    },
    {
      label: "Downloads…",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.DOWNLOADS }),
    },
    { type: "separator" },
    {
      label: "Credentials…",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.CREDENTIALS }),
    },
    {
      label: "Permissions…",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.PERMISSIONS }),
    },
  ];

  const developer: MenuItemConstructorOptions[] = [
    {
      label: "Toggle Panel DevTools",
      accelerator: "CmdOrCtrl+Shift+I",
      click: () => togglePanelDevTools(),
    },
    {
      label: "Toggle App DevTools",
      accelerator: "CmdOrCtrl+Alt+I",
      click: () => toggleAppDevTools(shellContents),
    },
    { type: "separator" },
    { label: "Clear Build Cache", click: () => void clearBuildCache() },
  ];

  const help: MenuItemConstructorOptions[] = [
    {
      // Filed with the other "how do I reach things" entries rather than at the
      // top: it is a discovery surface, not a frequent menu click.
      label: "Command Palette…",
      accelerator: commandPaletteAccelerator,
      click: () => emitMenuEvent("open-command-palette"),
    },
    {
      label: "Keyboard Shortcuts",
      accelerator: "CmdOrCtrl+/",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.KEYBOARD_SHORTCUTS }),
    },
    {
      label: "Documentation",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.HELP }),
    },
    { type: "separator" },
    {
      label: "About Vibestudio",
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.ABOUT }),
    },
  ];

  return [
    // The two actions worth a click without hunting through a submenu.
    {
      label: "New Panel",
      accelerator: PANEL_KEYBOARD_ACCELERATORS.newPanel,
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.NEW }),
    },
    {
      label: "Focus Pending Approval",
      accelerator: "CmdOrCtrl+Shift+A",
      click: () => emitMenuEvent("focus-approval-card"),
    },
    { type: "separator" },
    { label: "Panel", submenu: panel },
    { label: "Edit", submenu: edit },
    { label: "View", submenu: view },
    { label: "Workspace", submenu: workspace },
    { label: "Developer", submenu: developer },
    { label: "Help", submenu: help },
    { type: "separator" },
    { label: "Exit", accelerator: "CmdOrCtrl+Q", role: "quit" },
  ];
}

/**
 * Setup application menu.
 * @param mainWindow - The main BaseWindow (for window operations)
 * @param shellContents - WebContents for the shell view (for IPC and devtools)
 */
export function setupMenu(
  mainWindow: Electron.BaseWindow,
  shellContents: WebContents,
  options?: { onHistoryBack?: () => void; onHistoryForward?: () => void }
): void {
  interceptPanelDevToolsShortcut(shellContents);

  const isMac = process.platform === "darwin";
  const newPanelAccelerator = PANEL_KEYBOARD_ACCELERATORS.newPanel;
  const reloadPanelAccelerator = isMac ? "Cmd+R" : "Ctrl+Shift+R";
  const forceReloadAccelerator = isMac ? "Cmd+Shift+R" : "Ctrl+Alt+R";
  const addressBarAccelerator = isMac ? "Cmd+L" : "Ctrl+Shift+L";
  const closePanelAccelerator = PANEL_KEYBOARD_ACCELERATORS.closePanel;
  const commandPaletteAccelerator = isMac ? "Cmd+K" : "Ctrl+Shift+K";
  const redoAccelerator = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";
  const viewSubmenu: MenuItemConstructorOptions[] = [];

  if (options?.onHistoryBack) {
    viewSubmenu.push({
      label: "Back",
      click: () => options.onHistoryBack?.(),
    });
  }
  if (options?.onHistoryForward) {
    viewSubmenu.push({
      label: "Forward",
      click: () => options.onHistoryForward?.(),
    });
  }
  if (viewSubmenu.length > 0) {
    viewSubmenu.push({ type: "separator" });
  }

  const template: MenuItemConstructorOptions[] = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: "File",
      submenu: [
        {
          label: "New Panel",
          accelerator: newPanelAccelerator,
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.NEW });
          },
        },
        { type: "separator" },
        {
          label: "Command Palette...",
          accelerator: commandPaletteAccelerator,
          click: () => emitMenuEvent("open-command-palette"),
        },
        {
          label: "Focus Pending Approval",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => emitMenuEvent("focus-approval-card"),
        },
        { type: "separator" },
        {
          label: "Switch Workspace...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            emitMenuEvent("open-workspace-switcher");
          },
        },
        {
          // The connection badge lives in the panel tree, which breadcrumb mode
          // hides — so the menu has to be able to reach these settings too.
          label: "Connection & Devices…",
          click: () => {
            emitMenuEvent("open-connection-settings");
          },
        },
        { type: "separator" },
        isMac
          ? {
              label: "Close Panel",
              accelerator: closePanelAccelerator,
              click: () => archiveFocusedPanel(mainWindow),
            }
          : { role: "quit" },
      ] as MenuItemConstructorOptions[],
    },
    // { role: 'editMenu' }
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { label: "Redo", accelerator: redoAccelerator, role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ] as MenuItemConstructorOptions[],
    },
    // { role: 'viewMenu' }
    {
      label: "View",
      submenu: [
        ...viewSubmenu,
        {
          label: "Reload Panel",
          accelerator: reloadPanelAccelerator,
          click: () => dispatchChromeCommand("reload-panel"),
        },
        {
          label: "Force Reload View",
          accelerator: forceReloadAccelerator,
          click: () => dispatchChromeCommand("force-reload-view"),
        },
        { label: "Stop Loading", click: () => dispatchChromeCommand("stop") },
        { type: "separator" },
        {
          label: "Toggle Address Bar",
          accelerator: addressBarAccelerator,
          click: () => {
            emitMenuEvent("toggle-address-bar");
          },
        },
        { type: "separator" },
        {
          label: "Refresh Panel Display",
          click: () => {
            if (_menuViewManager) {
              const vm = assertPresent(_menuViewManager);
              vm.refreshVisiblePanel();
              vm.forceRepaintVisiblePanel();
            }
          },
        },
        {
          label: "Copy Panel Display Diagnostics",
          click: () => {
            if (_menuViewManager) {
              void assertPresent(_menuViewManager).copyPanelDisplayDiagnosticsToClipboard();
            }
          },
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Toggle Panel Developer Tools",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => togglePanelDevTools(),
        },
        {
          label: "Toggle App Developer Tools",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => toggleAppDevTools(shellContents),
        },
      ],
    },
    // { role: 'windowMenu' }
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }]
          : [
              {
                label: "Close Panel",
                accelerator: closePanelAccelerator,
                click: () => archiveFocusedPanel(mainWindow),
              },
            ]),
      ] as MenuItemConstructorOptions[],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          accelerator: "CmdOrCtrl+/",
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.KEYBOARD_SHORTCUTS });
          },
        },
        { type: "separator" },
        {
          label: "Documentation",
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.HELP });
          },
        },
        {
          label: "Credentials",
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.CREDENTIALS });
          },
        },
        {
          label: "Permissions",
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.PERMISSIONS });
          },
        },
        {
          label: "About Vibestudio",
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.ABOUT });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
