import { problemReportingConversation } from "@vibestudio/shared/problemReportingConversation";
import { app, Menu, MenuItemConstructorOptions, type WebContents } from "electron";
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
let _menuAboutNavigator: ((page: string) => void) | null = null;
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

/** Route standard about pages through their owning workspace. */
export function setMenuAboutNavigator(navigate: (page: string) => void): void {
  _menuAboutNavigator = navigate;
}

function navigateAbout(page: string): void {
  if (!_menuAboutNavigator) throw new Error("About-page navigation is not initialized");
  _menuAboutNavigator(page);
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
    await workspace.orchestrator.closePanel(focusedId);
  } else {
    // No focused panel: the app-menu entry falls back to closing the window.
    // The hamburger has no window handle and simply does nothing.
    mainWindow?.close();
  }
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
  "toggleFullScreen",
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

function performChromeBinding(id: DesktopBindingId): void {
  switch (id) {
    case "toggleFullScreen":
      void _menuViewManager
        ?.toggleWindowFullscreen()
        .catch((error) => console.error("[Menu] Failed to change fullscreen", error));
      return;
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
      navigateAbout(ABOUT_PAGES.NEW);
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

interface MenuHistoryOptions {
  onHistoryBack?: () => void;
  onHistoryForward?: () => void;
}

/**
 * Every app command the menus offer, defined once. The hamburger popup and the
 * macOS menubar arrange these differently, but a command has one label, one
 * accelerator, and one action wherever it appears.
 */
function menuCommands(input: {
  shellContents: WebContents;
  window: Electron.BaseWindow | null;
  history?: MenuHistoryOptions;
  clearBuildCache?: () => Promise<void>;
}) {
  const { shellContents, history } = input;
  const item = (options: MenuItemConstructorOptions) => options;
  const clearBuildCache = input.clearBuildCache;
  return {
    back: history?.onHistoryBack
      ? item({ label: "Back", accelerator: key("back"), click: () => history.onHistoryBack?.() })
      : null,
    forward: history?.onHistoryForward
      ? item({
          label: "Forward",
          accelerator: key("forward"),
          click: () => history.onHistoryForward?.(),
        })
      : null,
    reloadPanel: item({
      label: "Reload Panel",
      accelerator: key("reload"),
      click: () => dispatchChromeCommand("reload-panel"),
    }),
    forceReloadView: item({
      label: "Force Reload View",
      accelerator: key("forceReload"),
      click: () => dispatchChromeCommand("force-reload-view"),
    }),
    stopLoading: item({ label: "Stop Loading", click: () => dispatchChromeCommand("stop") }),
    toggleAddressBar: item({
      label: "Toggle Address Bar",
      accelerator: key("focusAddress"),
      click: () => emitMenuEvent("toggle-address-bar"),
    }),
    findInPage: item({
      label: "Find in Page…",
      accelerator: key("findInPage"),
      click: () => emitMenuEvent("toggle-find-in-page"),
    }),
    nextPanel: item({
      label: "Next Panel",
      accelerator: key("nextPanel"),
      click: () => cyclePanel(true),
    }),
    previousPanel: item({
      label: "Previous Panel",
      accelerator: key("previousPanel"),
      click: () => cyclePanel(false),
    }),
    closePanel: item({
      label: "Close Panel",
      accelerator: key("closePanel"),
      click: () =>
        void archiveFocusedPanel(input.window).catch((error) =>
          reportMenuActionError("Close panel", error)
        ),
    }),
    zoomIn: item({
      label: "Zoom In",
      accelerator: key("zoomIn"),
      click: () => zoomFocusedPanel(1),
    }),
    zoomOut: item({
      label: "Zoom Out",
      accelerator: key("zoomOut"),
      click: () => zoomFocusedPanel(-1),
    }),
    resetZoom: item({
      label: "Reset Zoom",
      accelerator: key("resetZoom"),
      click: () => resetFocusedPanelZoom(),
    }),
    toggleFullScreen: item({
      label: "Toggle Full Screen",
      accelerator: key("toggleFullScreen"),
      click: () => performChromeBinding("toggleFullScreen"),
    }),
    togglePanelFullScreen: item({
      label: "Toggle Panel Full Screen",
      click: () => {
        const id = focusedPanelViewId();
        if (id)
          void _menuViewManager
            ?.togglePanelFullscreen(id)
            .catch((error) => console.error("[Menu] Failed to change panel fullscreen", error));
      },
    }),
    refreshPanelDisplay: item({ label: "Refresh Panel Display", click: refreshPanelDisplay }),
    copyPanelDisplayDiagnostics: item({
      label: "Copy Panel Display Diagnostics",
      click: copyPanelDisplayDiagnostics,
    }),
    newPanel: item({
      label: "New Panel",
      accelerator: key("newPanel"),
      click: () => navigateAbout(ABOUT_PAGES.NEW),
    }),
    command: item({
      label: "Command…",
      accelerator: key("commandPalette"),
      click: () => emitMenuEvent("open-command-palette"),
    }),
    focusApproval: item({
      label: "Focus Pending Approval",
      accelerator: key("focusApproval"),
      click: () => emitMenuEvent("focus-approval-card"),
    }),
    switchWorkspace: item({
      label: "Switch Workspace…",
      accelerator: key("switchWorkspace"),
      click: () => emitMenuEvent("open-workspace-switcher"),
    }),
    // The connection badge lives in the panel tree, which breadcrumb mode
    // hides, so the menus must reach these settings too.
    settings: item({
      label: "Settings…",
      click: () => emitMenuEvent("open-settings", { section: "connection" }),
    }),
    bookmarks: item({
      label: "Bookmarks…",
      accelerator: key("bookmarks"),
      click: () => navigateAbout(ABOUT_PAGES.BOOKMARKS),
    }),
    history: item({
      label: "History…",
      accelerator: key("history"),
      click: () => navigateAbout(ABOUT_PAGES.HISTORY),
    }),
    downloads: item({
      label: "Downloads…",
      click: () => navigateAbout(ABOUT_PAGES.DOWNLOADS),
    }),
    credentials: item({
      label: "Credentials…",
      click: () => navigateAbout(ABOUT_PAGES.CREDENTIALS),
    }),
    permissions: item({
      label: "Permissions…",
      click: () => navigateAbout(ABOUT_PAGES.PERMISSIONS),
    }),
    panelDevTools: item({
      label: "Toggle Panel DevTools",
      accelerator: key("panelDevTools"),
      click: () => togglePanelDevTools(),
    }),
    appDevTools: item({
      label: "Toggle App DevTools",
      accelerator: key("appDevTools"),
      click: () => toggleAppDevTools(shellContents),
    }),
    clearBuildCache: clearBuildCache
      ? item({
          label: "Clear Build Cache",
          click: () =>
            void clearBuildCache().catch((error) =>
              reportMenuActionError("Clear build cache", error)
            ),
        })
      : null,
    keyboardShortcuts: item({
      label: "Keyboard Shortcuts",
      accelerator: key("keyboardShortcuts"),
      click: () => navigateAbout(ABOUT_PAGES.KEYBOARD_SHORTCUTS),
    }),
    documentation: item({
      label: "Documentation",
      click: () => navigateAbout(ABOUT_PAGES.HELP),
    }),
    reportProblem: item({
      label: "Report a problem",
      click: () => emitMenuEvent("open-command-agent", { prompt: problemReportingConversation() }),
    }),
    about: item({
      label: "About Vibestudio",
      click: () => navigateAbout(ABOUT_PAGES.ABOUT),
    }),
  };
}

const separator: MenuItemConstructorOptions = { type: "separator" };

/** Items present in this build, with a separator only between non-empty groups. */
function groups(
  ...sections: Array<Array<MenuItemConstructorOptions | null>>
): MenuItemConstructorOptions[] {
  const present = sections
    .map((section) => section.filter((entry): entry is MenuItemConstructorOptions => !!entry))
    .filter((section) => section.length > 0);
  return present.flatMap((section, index) => (index === 0 ? section : [separator, ...section]));
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
  options?: MenuHistoryOptions
): MenuItemConstructorOptions[] {
  const c = menuCommands({ shellContents, window: null, history: options, clearBuildCache });
  const redoAccelerator = KEY_PLATFORM === "mac" ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";
  return [
    // The two actions worth a click without hunting through a submenu.
    c.newPanel,
    c.focusApproval,
    separator,
    {
      label: "Panel",
      submenu: groups(
        [c.back, c.forward],
        [c.reloadPanel, c.forceReloadView, c.stopLoading],
        [c.toggleAddressBar, c.findInPage],
        [c.nextPanel, c.previousPanel],
        [c.closePanel]
      ),
    },
    {
      label: "Edit",
      submenu: groups(
        [
          { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
          { label: "Redo", accelerator: redoAccelerator, role: "redo" },
        ],
        [
          { label: "Cut", accelerator: "CmdOrCtrl+X", role: "cut" },
          { label: "Copy", accelerator: "CmdOrCtrl+C", role: "copy" },
          { label: "Paste", accelerator: "CmdOrCtrl+V", role: "paste" },
          { label: "Select All", accelerator: "CmdOrCtrl+A", role: "selectAll" },
        ]
      ),
    },
    {
      label: "View",
      submenu: groups(
        [c.zoomIn, c.zoomOut, c.resetZoom],
        [c.toggleFullScreen, c.togglePanelFullScreen, { label: "Minimize", role: "minimize" }],
        [c.refreshPanelDisplay, c.copyPanelDisplayDiagnostics]
      ),
    },
    {
      label: "Workspace",
      submenu: groups(
        [c.switchWorkspace, c.settings],
        [c.bookmarks, c.history, c.downloads],
        [c.credentials, c.permissions]
      ),
    },
    {
      label: "Developer",
      submenu: groups([c.panelDevTools, c.appDevTools], [c.clearBuildCache]),
    },
    {
      label: "Help",
      submenu: groups(
        // Discovery surfaces, filed with the other "how do I reach things" entries.
        [c.command, c.keyboardShortcuts, c.documentation],
        [c.reportProblem, c.about]
      ),
    },
    separator,
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
  options?: MenuHistoryOptions
): void {
  interceptChromeShortcuts(shellContents);

  const isMac = KEY_PLATFORM === "mac";
  const redoAccelerator = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";
  const c = menuCommands({ shellContents, window: mainWindow, history: options });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              c.settings,
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
    {
      label: "File",
      submenu: groups(
        [c.newPanel],
        [c.command, c.focusApproval],
        [c.switchWorkspace, isMac ? null : c.settings],
        [c.bookmarks, c.history, c.downloads],
        [c.nextPanel, c.previousPanel],
        [isMac ? c.closePanel : { role: "quit" }]
      ),
    },
    {
      label: "Edit",
      submenu: groups(
        [{ role: "undo" }, { label: "Redo", accelerator: redoAccelerator, role: "redo" }],
        isMac
          ? [
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ]
          : [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "delete" }],
        [isMac ? null : { role: "selectAll" }, c.findInPage],
        isMac
          ? [{ label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }]
          : []
      ),
    },
    {
      label: "View",
      submenu: groups(
        [c.back, c.forward],
        [c.reloadPanel, c.forceReloadView, c.stopLoading],
        [c.toggleAddressBar],
        [c.refreshPanelDisplay, c.copyPanelDisplayDiagnostics],
        [c.resetZoom, c.zoomIn, c.zoomOut],
        [c.toggleFullScreen, c.togglePanelFullScreen],
        [c.panelDevTools, c.appDevTools]
      ),
    },
    {
      label: "Window",
      submenu: groups(
        [{ role: "minimize" }, { role: "zoom" }],
        isMac ? [{ role: "front" }] : [c.closePanel],
        isMac ? [{ role: "window" }] : []
      ),
    },
    {
      role: "help",
      submenu: groups(
        [c.keyboardShortcuts],
        [c.documentation, c.credentials, c.permissions, c.reportProblem, c.about]
      ),
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
