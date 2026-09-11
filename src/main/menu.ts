import { app, dialog, Menu, MenuItemConstructorOptions, type WebContents } from "electron";
import type { EventName, EventPayloads, EventService } from "@vibestudio/shared/eventsService";
import type { ViewManager } from "./viewManager.js";
import type { BridgePanelLifecycle } from "@vibestudio/shared/panelInterfaces";
import { workspaceNativeViewId } from "./workspaceNativeViews.js";
import type { PanelCycler } from "./panelCycleController.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import {
  desktopAccelerator,
  desktopBindingFor,
  desktopKeyPlatform,
  type DesktopBindingId,
  type DesktopKeyInput,
} from "@vibestudio/shared/desktopKeymap";
import { assertPresent } from "../lintHelpers";
// These page ids identify workspace-provided units under `about/` that the menu
// assumes exist. The `navigate-about` payload is a page id (not a source); the
// shell resolves it to the `about/<page>` unit and creates a privileged panel.
import { ABOUT_PAGES } from "@vibestudio/workspace-contracts/aboutNamespace";

// Set during initialization — always non-null after startup
export interface MenuWorkspace {
  workspaceId: string;
  registry: PanelRegistry;
  orchestrator: BridgePanelLifecycle;
  eventService: EventService;
}
let resolveMenuWorkspace: () => MenuWorkspace | null = () => null;
export function setMenuWorkspaceResolver(resolve: () => MenuWorkspace | null): void {
  resolveMenuWorkspace = resolve;
}
let _menuViewManager: ViewManager | null = null;
let _menuEventService: EventService | null = null;
let _menuPanelCycler: PanelCycler | null = null;

/**
 * Give the menu the cycler that can walk panels across workspaces.
 *
 * The menu cannot compute the walk itself: it resolves one workspace, the
 * focused one, and cycling is explicitly not confined to that.
 */
export function setMenuPanelCycler(cycler: PanelCycler): void {
  _menuPanelCycler = cycler;
}
const chromeShortcutInterceptors = new WeakSet<WebContents>();

const KEY_PLATFORM = desktopKeyPlatform(process.platform);

/** The accelerator for a binding, from the one table that decides them. */
function key(id: DesktopBindingId): string {
  return desktopAccelerator(id, KEY_PLATFORM);
}

/** Set the event service for menu operations. Called from index.ts. */
export function setMenuEventService(es: EventService): void {
  _menuEventService = es;
}

function emitMenuEvent<E extends EventName>(event: E, payload?: EventPayloads[E]): boolean {
  const target =
    event === "open-settings" || event === "open-workspace-switcher"
      ? _menuEventService
      : resolveMenuWorkspace()?.eventService;
  if (!target) {
    console.warn(`[Menu] event service is not ready for "${event}"`);
    return false;
  }
  target.emit(event, payload);
  return true;
}

/** Set or clear the window-owned view manager used by menu operations. */
export function setMenuViewManager(vm: ViewManager | null): void {
  _menuViewManager = vm;
}

/** Close the currently focused panel. Falls back to window close if no panel is focused. */
async function archiveFocusedPanel(mainWindow: Electron.BaseWindow | null): Promise<void> {
  const workspace = resolveMenuWorkspace();
  const focusedId = workspace?.registry.getFocusedPanelId();
  if (focusedId && workspace) {
    const panel = workspace.registry.getPanel(focusedId);
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
    await workspace.orchestrator.closePanel(focusedId);
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
  const workspace = resolveMenuWorkspace();
  const focusedId = workspace?.registry.getFocusedPanelId();
  if (!focusedId || !workspace || !_menuViewManager) return;
  const nativeId = workspaceNativeViewId({
    workspaceId: workspace.workspaceId,
    runtimeId: focusedId,
  });
  if (force) _menuViewManager.forceReload(nativeId);
  else _menuViewManager.reload(nativeId);
}

function dispatchChromeCommand(command: "reload-panel" | "force-reload-view" | "stop"): void {
  if (!emitMenuEvent("panel-chrome-command", { command })) {
    if (command === "reload-panel") reloadFocusedPanel(false);
    if (command === "force-reload-view") reloadFocusedPanel(true);
    if (command === "stop") stopFocusedPanel();
  }
}

function stopFocusedPanel(): void {
  const workspace = resolveMenuWorkspace();
  const focusedId = workspace?.registry.getFocusedPanelId();
  if (!focusedId || !workspace || !_menuViewManager) return;
  const nativeId = workspaceNativeViewId({
    workspaceId: workspace.workspaceId,
    runtimeId: focusedId,
  });
  _menuViewManager.stop(nativeId);
}

/** The native view id of the panel in the focused pane, if there is one. */
function focusedPanelViewId(): string | null {
  const workspace = resolveMenuWorkspace();
  const focusedId = workspace?.registry.getFocusedPanelId();
  if (!focusedId || !workspace) return null;
  return workspaceNativeViewId({ workspaceId: workspace.workspaceId, runtimeId: focusedId });
}

/**
 * Zoom acts on the panel, not on the window.
 *
 * Electron's zoom roles operate on the focused window's own web contents, and
 * the shell window is a `BaseWindow` that has none — so the Zoom In, Zoom Out
 * and Reset Zoom items were no-ops with accelerators attached. What a person
 * means by zoom here is the panel they are reading.
 */
function zoomFocusedPanel(direction: 1 | -1): void {
  const viewId = focusedPanelViewId();
  if (viewId && _menuViewManager) _menuViewManager.stepZoom(viewId, direction);
}

function resetFocusedPanelZoom(): void {
  const viewId = focusedPanelViewId();
  if (viewId && _menuViewManager) _menuViewManager.resetZoom(viewId);
}

function cyclePanel(forward: boolean): void {
  if (!_menuPanelCycler) {
    console.warn("[Menu] panel cycler is not ready");
    return;
  }
  _menuPanelCycler.cycle(forward);
}

function openFocusedPanelDevTools(): boolean {
  const workspace = resolveMenuWorkspace();
  const focusedId = workspace?.registry.getFocusedPanelId();
  if (!focusedId || !workspace) return false;
  const nativeId = workspaceNativeViewId({
    workspaceId: workspace.workspaceId,
    runtimeId: focusedId,
  });
  if (!_menuViewManager?.hasView(nativeId)) {
    return false;
  }
  _menuViewManager.openDevTools(nativeId);
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

/**
 * The chords the chrome owns no matter what has keyboard focus.
 *
 * This is the difference between an app that has browser shortcuts and an app
 * where they work. A menu accelerator reaches the menu; a page that has focus
 * reaches the page first, and a page is perfectly capable of consuming
 * `Ctrl+R`, `Ctrl+L` or `Ctrl+F` and doing something else with it. In a
 * browser the chrome wins those, because they are how you get *out* of a page
 * that is misbehaving. Here they now win too.
 *
 * `closePanel` is deliberately not in this list. Every other chord here is
 * recoverable — the worst case is a reload — and closing the panel a person is
 * typing in is not, so it stays with the menu, which is reached deliberately.
 */
const CHROME_OWNED_BINDINGS = [
  "commandPalette",
  "panelDevTools",
  "back",
  "forward",
  "forceReload",
  "reload",
  "focusAddress",
  "findInPage",
  "findNext",
  "findPrevious",
  "newPanel",
  "nextPanel",
  "previousPanel",
] as const satisfies readonly DesktopBindingId[];

function keyInputOf(input: Electron.Input): DesktopKeyInput {
  return {
    key: input.key,
    code: input.code,
    ctrl: input.control,
    shift: input.shift,
    alt: input.alt,
    meta: input.meta,
  };
}

/** The chrome-owned binding this key event performs, if any. */
export function chromeOwnedBinding(input: Electron.Input): DesktopBindingId | null {
  if (input.type !== "keyDown") return null;
  // `forceReload` is listed before `reload` on purpose: the shifted chord is a
  // superset match and must be resolved first.
  return desktopBindingFor(keyInputOf(input), KEY_PLATFORM, CHROME_OWNED_BINDINGS);
}

/**
 * True when the chrome, not the panel, is the addressee of this key event.
 *
 * The shell forwards its own keystrokes into the focused panel, so without
 * this a chrome chord typed while the chrome has focus would be delivered to
 * the page as well as acted on.
 */
export function isChromeOwnedInput(input: Electron.Input): boolean {
  return chromeOwnedBinding(input) !== null;
}

/** Kept as the narrow question the overlay forwarding guard asks. */
export function isCommandOverlayInput(input: Electron.Input): boolean {
  return chromeOwnedBinding(input) === "commandPalette";
}

function performChromeBinding(id: DesktopBindingId): void {
  switch (id) {
    case "commandPalette":
      emitMenuEvent("open-command-palette");
      return;
    case "panelDevTools":
      togglePanelDevTools();
      return;
    case "back":
    case "forward":
      emitMenuEvent("panel-chrome-command", { command: id });
      return;
    case "reload":
      dispatchChromeCommand("reload-panel");
      return;
    case "forceReload":
      dispatchChromeCommand("force-reload-view");
      return;
    case "focusAddress":
      emitMenuEvent("panel-chrome-command", { command: "focus-address" });
      return;
    case "findInPage":
      emitMenuEvent("toggle-find-in-page");
      return;
    case "findNext":
      emitMenuEvent("find-in-page-step", { forward: true });
      return;
    case "findPrevious":
      emitMenuEvent("find-in-page-step", { forward: false });
      return;
    case "newPanel":
      emitMenuEvent("navigate-about", { page: ABOUT_PAGES.NEW });
      return;
    case "nextPanel":
      cyclePanel(true);
      return;
    case "previousPanel":
      cyclePanel(false);
      return;
    default:
      return;
  }
}

/**
 * Give the chrome its chords back from any web contents that could eat them.
 *
 * `preventDefault` both keeps the page from seeing the chord and keeps the
 * menu accelerator from firing a second time for the same press.
 */
export function interceptChromeShortcuts(contents: WebContents): void {
  if (chromeShortcutInterceptors.has(contents)) return;
  chromeShortcutInterceptors.add(contents);
  contents.on("before-input-event", (event, input) => {
    const binding = chromeOwnedBinding(input);
    if (!binding) return;
    event.preventDefault();
    performChromeBinding(binding);
  });
}

/** @deprecated Use `interceptChromeShortcuts`, which owns the whole family. */
export function interceptCommandOverlayShortcut(contents: WebContents): void {
  interceptChromeShortcuts(contents);
}

function refreshPanelDisplay(): void {
  if (!_menuViewManager) return;
  const vm = assertPresent(_menuViewManager);
  vm.refreshVisiblePanel();
  vm.forceRepaintVisiblePanel();
}

function copyPanelDisplayDiagnostics(): void {
  if (!_menuViewManager) return;
  void assertPresent(_menuViewManager)
    .copyPanelDisplayDiagnosticsToClipboard()
    .catch((error) => console.error("[Menu] Failed to copy panel diagnostics:", error));
}

function reportMenuActionError(action: string, error: unknown): void {
  console.error(`[Menu] ${action} failed:`, error);
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
  const isMac = KEY_PLATFORM === "mac";
  const redoAccelerator = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";

  // Panel: everything acting on the panel in the focused pane.
  const panel: MenuItemConstructorOptions[] = [];
  if (options?.onHistoryBack) {
    panel.push({
      label: "Back",
      accelerator: key("back"),
      click: () => options.onHistoryBack?.(),
    });
  }
  if (options?.onHistoryForward) {
    panel.push({
      label: "Forward",
      accelerator: key("forward"),
      click: () => options.onHistoryForward?.(),
    });
  }
  if (panel.length > 0) panel.push({ type: "separator" });
  panel.push(
    {
      label: "Reload Panel",
      accelerator: key("reload"),
      click: () => dispatchChromeCommand("reload-panel"),
    },
    {
      label: "Force Reload View",
      accelerator: key("forceReload"),
      click: () => dispatchChromeCommand("force-reload-view"),
    },
    { label: "Stop Loading", click: () => dispatchChromeCommand("stop") },
    { type: "separator" },
    {
      label: "Toggle Address Bar",
      accelerator: key("focusAddress"),
      click: () => emitMenuEvent("toggle-address-bar"),
    },
    {
      label: "Find in Page…",
      accelerator: key("findInPage"),
      click: () => emitMenuEvent("toggle-find-in-page"),
    },
    { type: "separator" },
    {
      label: "Next Panel",
      accelerator: key("nextPanel"),
      click: () => cyclePanel(true),
    },
    {
      label: "Previous Panel",
      accelerator: key("previousPanel"),
      click: () => cyclePanel(false),
    },
    { type: "separator" },
    {
      label: "Close Panel",
      accelerator: key("closePanel"),
      click: () =>
        void archiveFocusedPanel(null).catch((error) =>
          reportMenuActionError("Close panel", error)
        ),
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
    { label: "Zoom In", accelerator: key("zoomIn"), click: () => zoomFocusedPanel(1) },
    { label: "Zoom Out", accelerator: key("zoomOut"), click: () => zoomFocusedPanel(-1) },
    { label: "Reset Zoom", accelerator: key("resetZoom"), click: () => resetFocusedPanelZoom() },
    { type: "separator" },
    { label: "Toggle Full Screen", role: "togglefullscreen", accelerator: key("toggleFullScreen") },
    { label: "Minimize", role: "minimize" },
    { type: "separator" },
    { label: "Refresh Panel Display", click: () => refreshPanelDisplay() },
    { label: "Copy Panel Display Diagnostics", click: () => copyPanelDisplayDiagnostics() },
  ];

  // Workspace: the about/* pages and settings that outlive any one panel.
  const workspace: MenuItemConstructorOptions[] = [
    {
      label: "Switch Workspace…",
      accelerator: key("switchWorkspace"),
      click: () => emitMenuEvent("open-workspace-switcher"),
    },
    {
      label: "Settings…",
      click: () => emitMenuEvent("open-settings", { section: "connection" }),
    },
    { type: "separator" },
    {
      label: "Bookmarks…",
      accelerator: key("bookmarks"),
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.BOOKMARKS }),
    },
    {
      label: "History…",
      accelerator: key("history"),
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
      accelerator: key("panelDevTools"),
      click: () => togglePanelDevTools(),
    },
    {
      label: "Toggle App DevTools",
      accelerator: key("appDevTools"),
      click: () => toggleAppDevTools(shellContents),
    },
    { type: "separator" },
    {
      label: "Clear Build Cache",
      click: () =>
        void clearBuildCache().catch((error) => reportMenuActionError("Clear build cache", error)),
    },
  ];

  const help: MenuItemConstructorOptions[] = [
    {
      // Filed with the other "how do I reach things" entries rather than at the
      // top: it is a discovery surface, not a frequent menu click.
      label: "Command…",
      accelerator: key("commandPalette"),
      click: () => emitMenuEvent("open-command-palette"),
    },
    {
      label: "Keyboard Shortcuts",
      accelerator: key("keyboardShortcuts"),
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
      accelerator: key("newPanel"),
      click: () => emitMenuEvent("navigate-about", { page: ABOUT_PAGES.NEW }),
    },
    {
      label: "Focus Pending Approval",
      accelerator: key("focusApproval"),
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
  interceptChromeShortcuts(shellContents);

  const isMac = KEY_PLATFORM === "mac";
  const redoAccelerator = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";
  const viewSubmenu: MenuItemConstructorOptions[] = [];

  if (options?.onHistoryBack) {
    viewSubmenu.push({
      label: "Back",
      accelerator: key("back"),
      click: () => options.onHistoryBack?.(),
    });
  }
  if (options?.onHistoryForward) {
    viewSubmenu.push({
      label: "Forward",
      accelerator: key("forward"),
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
          accelerator: key("newPanel"),
          click: () => {
            emitMenuEvent("navigate-about", { page: ABOUT_PAGES.NEW });
          },
        },
        { type: "separator" },
        {
          label: "Command...",
          accelerator: key("commandPalette"),
          click: () => emitMenuEvent("open-command-palette"),
        },
        {
          label: "Focus Pending Approval",
          accelerator: key("focusApproval"),
          click: () => emitMenuEvent("focus-approval-card"),
        },
        { type: "separator" },
        {
          label: "Switch Workspace...",
          accelerator: key("switchWorkspace"),
          click: () => {
            emitMenuEvent("open-workspace-switcher");
          },
        },
        {
          // The connection badge lives in the panel tree, which breadcrumb mode
          // hides — so the menu has to be able to reach these settings too.
          label: "Settings…",
          click: () => {
            emitMenuEvent("open-settings", { section: "connection" });
          },
        },
        { type: "separator" },
        {
          label: "Next Panel",
          accelerator: key("nextPanel"),
          click: () => cyclePanel(true),
        },
        {
          label: "Previous Panel",
          accelerator: key("previousPanel"),
          click: () => cyclePanel(false),
        },
        { type: "separator" },
        isMac
          ? {
              label: "Close Panel",
              accelerator: key("closePanel"),
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
          accelerator: key("reload"),
          click: () => dispatchChromeCommand("reload-panel"),
        },
        {
          label: "Force Reload View",
          accelerator: key("forceReload"),
          click: () => dispatchChromeCommand("force-reload-view"),
        },
        { label: "Stop Loading", click: () => dispatchChromeCommand("stop") },
        { type: "separator" },
        {
          label: "Toggle Address Bar",
          accelerator: key("focusAddress"),
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
              void assertPresent(_menuViewManager)
                .copyPanelDisplayDiagnosticsToClipboard()
                .catch((error) => reportMenuActionError("Copy panel diagnostics", error));
            }
          },
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: key("resetZoom"),
          click: () => resetFocusedPanelZoom(),
        },
        { label: "Zoom In", accelerator: key("zoomIn"), click: () => zoomFocusedPanel(1) },
        { label: "Zoom Out", accelerator: key("zoomOut"), click: () => zoomFocusedPanel(-1) },
        { type: "separator" },
        { role: "togglefullscreen", accelerator: key("toggleFullScreen") },
        { type: "separator" },
        {
          label: "Toggle Panel Developer Tools",
          accelerator: key("panelDevTools"),
          click: () => togglePanelDevTools(),
        },
        {
          label: "Toggle App Developer Tools",
          accelerator: key("appDevTools"),
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
                accelerator: key("closePanel"),
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
          accelerator: key("keyboardShortcuts"),
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
