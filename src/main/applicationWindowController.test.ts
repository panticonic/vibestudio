import { beforeEach, describe, expect, it, vi } from "vitest";

type WindowEvent = "focus" | "closed";

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
  destroy: ReturnType<typeof vi.fn>;
  getShellWebContents: ReturnType<typeof vi.fn>;
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
      destroy: vi.fn(() => lifecycleEvents.push("view:destroy")),
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
  BaseWindow: mocks.BaseWindow,
  nativeTheme: { shouldUseDarkColors: false },
}));

vi.mock("./viewManager.js", () => ({ ViewManager: mocks.ViewManager }));
vi.mock("./panelView.js", () => ({ PanelView: vi.fn() }));
vi.mock("./browserHistoryRecorder.js", () => ({ BrowserHistoryRecorder: vi.fn() }));
vi.mock("./appOrchestrator.js", () => ({ AppOrchestrator: vi.fn() }));
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
} from "./applicationWindowController.js";

function createHarness() {
  const stopElectronHostTargetLaunchLoop = vi.fn();
  const onWindowClosed = vi.fn(() => mocks.lifecycleEvents.push("controller:closed"));
  const deps: ApplicationWindowControllerDeps = {
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
});

function expectPresent<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
