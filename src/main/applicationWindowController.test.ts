import { EventEmitter } from "node:events";
import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PanelView } from "./panelView.js";
import { AppOrchestrator } from "./appOrchestrator.js";

type WindowEvent = "focus" | "close" | "closed";

interface MockWindow {
  destroyed: boolean;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  flashFrame: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit(event: WindowEvent): void;
}

interface MockViewManager {
  findViewIdByWebContentsId: ReturnType<typeof vi.fn>;
  getViewInfo: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getShellWebContents: ReturnType<typeof vi.fn>;
  onNativeSlotFocused: ReturnType<typeof vi.fn>;
  onViewCrashed: ReturnType<typeof vi.fn>;
  getViewIds: ReturnType<typeof vi.fn>;
  setWorkspaceProtectedViews: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const lifecycleEvents: string[] = [];
  const windows: MockWindow[] = [];
  const viewManagers: MockViewManager[] = [];

  const BaseWindow = vi.fn(() => {
    const listeners = new Map<string, Array<() => void>>();
    const window: MockWindow = {
      destroyed: false,
      isDestroyed: vi.fn(() => window.destroyed),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      setTitle: vi.fn(),
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
      }),
      emit(event: WindowEvent) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener();
      },
    };
    windows.push(window);
    return window;
  });

  const ViewManager = vi.fn(() => {
    const viewManager = {
      findViewIdByWebContentsId: vi.fn(),
      getViewInfo: vi.fn(),
      destroy: vi.fn(() => lifecycleEvents.push("view:destroy")),
      onNativeSlotFocused: vi.fn(),
      onViewCrashed: vi.fn(),
      getViewIds: vi.fn(() => []),
      setWorkspaceProtectedViews: vi.fn(),
      getShellWebContents: vi.fn(() => ({ id: `shell-${viewManagers.length}` })),
    } satisfies MockViewManager;
    viewManagers.push(viewManager);
    return viewManager;
  });

  return {
    lifecycleEvents,
    windows,
    viewManagers,
    BaseWindow,
    ViewManager,
    setBadgeCount: vi.fn(),
    setMemoryMonitorViewManager: vi.fn((viewManager: unknown) => {
      lifecycleEvents.push(viewManager ? "memory:set" : "memory:clear");
    }),
    setMemoryPressureHandler: vi.fn(),
    startMemoryMonitor: vi.fn(),
    setMenuViewManager: vi.fn((viewManager: unknown) => {
      lifecycleEvents.push(viewManager ? "menu:set" : "menu:clear");
    }),
    setMenuEventService: vi.fn(),
    setupMenu: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { setBadgeCount: mocks.setBadgeCount },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  nativeImage: {},
  BaseWindow: mocks.BaseWindow,
  nativeTheme: { shouldUseDarkColors: false },
}));

vi.mock("./viewManager.js", () => ({ ViewManager: mocks.ViewManager }));
vi.mock("./panelView.js", () => ({ PanelView: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock("./browserHistoryRecorder.js", () => ({ BrowserHistoryRecorder: vi.fn() }));
vi.mock("./appOrchestrator.js", () => ({
  AppOrchestrator: vi.fn(() => ({ loadBakedApp: vi.fn(async () => false) })),
}));
vi.mock("./memoryMonitor.js", () => ({
  setMemoryMonitorViewManager: mocks.setMemoryMonitorViewManager,
  setMemoryPressureHandler: mocks.setMemoryPressureHandler,
  startMemoryMonitor: mocks.startMemoryMonitor,
}));
vi.mock("./menu.js", () => ({
  setMenuEventService: mocks.setMenuEventService,
  setMenuViewManager: mocks.setMenuViewManager,
  setupMenu: mocks.setupMenu,
}));
vi.mock("./testApi.js", () => ({ setupTestApi: vi.fn() }));
vi.mock("./paths.js", () => ({ getResourcesPath: () => "/resources" }));
vi.mock("@vibestudio/dev-log", () => ({
  createDevLogger: () => ({
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import {
  ApplicationWindowController,
  type ApplicationWindowControllerDeps,
  type WorkspaceWindowServices,
} from "./applicationWindowController.js";

function createHarness() {
  const stopElectronHostTargetLaunchLoop = vi.fn();
  const onWindowClosed = vi.fn(() => mocks.lifecycleEvents.push("controller:closed"));
  const deps: ApplicationWindowControllerDeps = {
    getSystemWorkspaceId: () => "system",
    eventService: { emit: vi.fn() } as never,
    isHeadlessHost: false,
    getWindowTitle: () => "Vibestudio test",
    getApprovalAttention: () => null,
    stopElectronHostTargetLaunchLoop,
    startElectronHostTargetLaunchLoop: vi.fn(),
    drainPendingReadyElectronLaunch: vi.fn(async () => undefined),
    initializePanelTreeOnce: vi.fn(),
    onWindowClosed,
  };
  return {
    eventService: deps.eventService,
    controller: new ApplicationWindowController(deps),
    stopElectronHostTargetLaunchLoop,
    onWindowClosed,
  };
}

describe("ApplicationWindowController window lifetime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lifecycleEvents.length = 0;
    mocks.windows.length = 0;
    mocks.viewManagers.length = 0;
  });

  it("routes browser notification IPC through native workspace ownership without Personal", async () => {
    const harness = createHarness();
    harness.controller.create();
    const manager = mocks.viewManagers[0]!;
    const sources = ["system", "shared"].map((workspaceId, id) => {
      const frame = {
        url: "https://site.test/",
        origin: "https://site.test",
        detached: false,
        isDestroyed: () => false,
        send: vi.fn(),
      };
      const contents = Object.assign(new EventEmitter(), {
        id,
        mainFrame: frame,
        isDestroyed: () => false,
        getURL: () => frame.url,
      });
      const eventService = { emit: vi.fn() };
      const permissions = {
        refresh: vi.fn(async () => undefined),
        isGranted: vi.fn(() => true),
        ownsContents: (candidate: unknown) => candidate === contents,
      };
      harness.controller.attachWorkspaceServices({
        serverSession: { workspaceId },
        eventService,
        getBrowserPermissionController: () => permissions,
      } as unknown as WorkspaceWindowServices);
      return { workspaceId, frame, contents, eventService, permissions };
    });
    manager.findViewIdByWebContentsId.mockImplementation((id: number) => `native-${id}`);
    manager.getViewInfo.mockImplementation((id: string) => ({
      workspaceIdentity: {
        workspaceId: sources[Number(id.slice(7))]!.workspaceId,
        runtimeId: "same-panel",
      },
    }));
    const show = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === "vibestudio:website-notification:show")![1];
    for (const source of sources) {
      const id = await show(
        { sender: source.contents, senderFrame: source.frame } as never,
        "Hello",
        {}
      );
      expect(source.permissions.refresh).toHaveBeenCalledOnce();
      expect(source.eventService.emit).toHaveBeenCalledWith(
        "notification:show",
        expect.objectContaining({ id, sourcePanelId: "same-panel" })
      );
      harness.controller.handleWebsiteNotificationAction("absent", id, "website-open");
      expect(source.frame.send).not.toHaveBeenCalled();
      harness.controller.handleWebsiteNotificationAction(source.workspaceId, id, "website-open");
      expect(source.frame.send).toHaveBeenCalledTimes(2);
    }
    mocks.windows[0]!.emit("closed");
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("vibestudio:website-notification:show");
    harness.controller.create();
    expect(
      vi
        .mocked(ipcMain.handle)
        .mock.calls.filter(([name]) => name === "vibestudio:website-notification:show")
    ).toHaveLength(2);
    mocks.windows[1]!.emit("closed");
  });

  it("keeps panel link failures with their originating workspace", () => {
    const harness = createHarness();
    harness.controller.create();
    const emitters = [vi.fn(), vi.fn()];
    for (const [index, workspaceId] of ["personal", "shared"].entries()) {
      harness.controller.attachWorkspaceServices({
        serverSession: { workspaceId },
        eventService: { emit: emitters[index] },
      } as unknown as WorkspaceWindowServices);
    }
    const personalOptions = vi.mocked(PanelView).mock.calls[0]![0];
    const sharedOptions = vi.mocked(PanelView).mock.calls[1]![0];
    personalOptions.onPanelLinkError?.("same-panel-id", "https://personal.example", "Unavailable");
    sharedOptions.onPanelLinkError?.("same-panel-id", "https://shared.example", "Denied");
    expect(emitters[0]).toHaveBeenCalledExactlyOnceWith(
      "notification:show",
      expect.objectContaining({ message: "Unavailable (https://personal.example)" })
    );
    expect(emitters[1]).toHaveBeenCalledExactlyOnceWith(
      "notification:show",
      expect.objectContaining({ message: "Denied (https://shared.example)" })
    );
    expect(harness.eventService.emit).not.toHaveBeenCalled();
  });

  it("retires System through normal workspace cleanup without duplicating window callbacks", () => {
    const harness = createHarness();
    harness.controller.create();
    const services = {
      serverSession: { workspaceId: "system" },
      eventService: { emit: vi.fn() },
    } as unknown as WorkspaceWindowServices;
    harness.controller.attachWorkspaceServices(services);
    const firstAppOwner = harness.controller.appOrchestrator;
    const oldViewLookup = vi.mocked(AppOrchestrator).mock.calls[0]![0].getPanelView;
    const firstPanelView = harness.controller.getWorkspacePanelView("system");
    expect(oldViewLookup()).toBe(firstPanelView);
    expect(firstAppOwner).not.toBeNull();
    harness.controller.detachWorkspace("system");
    expect(harness.controller.getWorkspacePanelView("system")).toBeNull();
    expect(harness.controller.appOrchestrator).toBeNull();
    expect(harness.stopElectronHostTargetLaunchLoop).toHaveBeenCalledOnce();

    harness.controller.attachWorkspaceServices(services);
    expect(harness.controller.appOrchestrator).not.toBe(firstAppOwner);
    expect(oldViewLookup()).toBeNull();
    expect(vi.mocked(AppOrchestrator).mock.calls[1]![0].getPanelView()).toBe(
      harness.controller.getWorkspacePanelView("system")
    );
    const manager = expectPresent(mocks.viewManagers[0]);
    expect(manager.onNativeSlotFocused).toHaveBeenCalledOnce();
    expect(manager.onViewCrashed).toHaveBeenCalledOnce();
  });

  it("destroys the ViewManager exactly once before clearing owned references and globals", () => {
    const harness = createHarness();
    harness.controller.create();
    const window = expectPresent(mocks.windows[0]);
    const viewManager = expectPresent(mocks.viewManagers[0]);
    mocks.lifecycleEvents.length = 0;
    viewManager.destroy.mockImplementation(() => {
      expect(harness.controller.window).toBe(window);
      expect(harness.controller.viewManager).toBe(viewManager);
      expect(mocks.setMenuViewManager).not.toHaveBeenCalledWith(null);
      expect(mocks.setMemoryMonitorViewManager).not.toHaveBeenCalledWith(null);
      mocks.lifecycleEvents.push("view:destroy");
    });

    window.emit("closed");
    window.emit("closed");

    expect(viewManager.destroy).toHaveBeenCalledOnce();
    expect(mocks.lifecycleEvents).toEqual([
      "view:destroy",
      "menu:clear",
      "memory:clear",
      "controller:closed",
    ]);
    expect(harness.controller.window).toBeNull();
    expect(harness.controller.viewManager).toBeNull();
    expect(harness.stopElectronHostTargetLaunchLoop).toHaveBeenCalledOnce();
    expect(harness.onWindowClosed).toHaveBeenCalledOnce();
  });

  it("does not let a delayed close callback clear a reopened window generation", () => {
    const harness = createHarness();
    harness.controller.create();
    const firstWindow = expectPresent(mocks.windows[0]);
    const firstViewManager = expectPresent(mocks.viewManagers[0]);

    // Model Electron reporting destruction before dispatching the queued
    // `closed` callback. create() must retire this generation and proceed.
    firstWindow.destroyed = true;
    harness.controller.create();
    const secondWindow = expectPresent(mocks.windows[1]);
    const secondViewManager = expectPresent(mocks.viewManagers[1]);

    expect(firstViewManager.destroy).toHaveBeenCalledOnce();
    expect(harness.controller.window).toBe(secondWindow);
    expect(harness.controller.viewManager).toBe(secondViewManager);
    expect(harness.onWindowClosed).toHaveBeenCalledOnce();

    firstWindow.emit("closed");

    expect(firstViewManager.destroy).toHaveBeenCalledOnce();
    expect(secondViewManager.destroy).not.toHaveBeenCalled();
    expect(harness.controller.window).toBe(secondWindow);
    expect(harness.stopElectronHostTargetLaunchLoop).toHaveBeenCalledOnce();

    secondWindow.emit("closed");
    expect(secondViewManager.destroy).toHaveBeenCalledOnce();
    expect(harness.controller.window).toBeNull();
    expect(harness.stopElectronHostTargetLaunchLoop).toHaveBeenCalledTimes(2);
    expect(harness.onWindowClosed).toHaveBeenCalledTimes(2);
  });

  it("clears the generation without retrying when ViewManager teardown throws", () => {
    const harness = createHarness();
    harness.controller.create();
    const window = expectPresent(mocks.windows[0]);
    const viewManager = expectPresent(mocks.viewManagers[0]);
    viewManager.destroy.mockImplementation(() => {
      throw new Error("native teardown failed");
    });

    window.emit("closed");
    window.emit("closed");

    expect(viewManager.destroy).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      "[window] Failed to destroy ViewManager: native teardown failed"
    );
    expect(mocks.setMenuViewManager).toHaveBeenCalledWith(null);
    expect(mocks.setMemoryMonitorViewManager).toHaveBeenCalledWith(null);
    expect(harness.controller.window).toBeNull();
    expect(harness.onWindowClosed).toHaveBeenCalledOnce();
  });

  it("tears down native child views before window destruction and treats closed as a fallback", () => {
    const harness = createHarness();
    harness.controller.create();
    const window = expectPresent(mocks.windows[0]);
    const viewManager = expectPresent(mocks.viewManagers[0]);

    window.emit("close");
    window.emit("closed");

    expect(viewManager.destroy).toHaveBeenCalledOnce();
    expect(harness.stopElectronHostTargetLaunchLoop).toHaveBeenCalledOnce();
    expect(harness.onWindowClosed).toHaveBeenCalledOnce();
    expect(harness.controller.window).toBeNull();
  });

  it("disarms PanelView intent before destroying native child views", () => {
    const harness = createHarness();
    harness.controller.create();
    const window = expectPresent(mocks.windows[0]);
    const panelView = {
      dispose: vi.fn(() => mocks.lifecycleEvents.push("panel:dispose")),
    };
    const internal = harness.controller as unknown as {
      currentLifetime: { panelViews: Map<string, typeof panelView> } | null;
    };
    expect(internal.currentLifetime).not.toBeNull();
    internal.currentLifetime!.panelViews.set("system", panelView);
    mocks.lifecycleEvents.length = 0;

    window.emit("close");

    expect(panelView.dispose).toHaveBeenCalledOnce();
    expect(mocks.lifecycleEvents.slice(0, 2)).toEqual(["panel:dispose", "view:destroy"]);
  });
});

function expectPresent<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
