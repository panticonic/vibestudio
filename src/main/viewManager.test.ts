/**
 * ViewManager Unit Tests
 *
 * These tests use mocked Electron APIs to verify ViewManager logic.
 * For integration testing with real Electron, use Playwright or Spectron.
 *
 * Run with: npx vitest run src/main/viewManager.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock Electron modules before importing ViewManager
vi.mock("electron", () => {
  // Create a fresh webContents mock for each view
  const createMockWebContents = () => ({
    id: Math.random(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    openDevTools: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue(""),
    getTitle: vi.fn().mockReturnValue("Mock Title"),
    isLoading: vi.fn().mockReturnValue(false),
    getOSProcessId: vi.fn().mockReturnValue(1234),
    navigationHistory: {
      canGoBack: vi.fn().mockReturnValue(false),
      canGoForward: vi.fn().mockReturnValue(false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    reload: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue("css-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    capturePage: vi.fn().mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 100 }),
    }),
    invalidate: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    setBackgroundThrottling: vi.fn(),
  });

  const createMockWebContentsView = () => ({
    webContents: createMockWebContents(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 100, height: 100 }),
  });

  const children: unknown[] = [];
  const mockContentView = {
    children,
    addChildView: vi.fn((view: unknown) => {
      const index = children.indexOf(view);
      if (index !== -1) children.splice(index, 1);
      children.push(view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const index = children.indexOf(view);
      if (index !== -1) children.splice(index, 1);
    }),
  };

  const mockBaseWindow = {
    contentView: mockContentView,
    getContentSize: vi.fn().mockReturnValue([1200, 800]),
    isDestroyed: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(true),
    isFocused: vi.fn().mockReturnValue(true),
    showInactive: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    on: vi.fn(),
  };

  const mockSession = {
    protocol: {
      handle: vi.fn(),
    },
  };

  return {
    app: {
      getAppMetrics: vi.fn(() => [
        {
          pid: 1234,
          type: "Tab",
          memory: { workingSetSize: 20480 },
          cpu: { percentCPUUsage: 1.25 },
        },
      ]),
    },
    BaseWindow: vi.fn(() => mockBaseWindow),
    WebContentsView: vi.fn(createMockWebContentsView),
    ipcMain: {
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    session: {
      fromPartition: vi.fn(() => mockSession),
      defaultSession: mockSession,
    },
  };
});

// Import after mocks are set up
import { ViewManager } from "./viewManager.js";

function declareAndAttachPanelSlot(
  manager: ViewManager,
  ownerViewId: string,
  request: Omit<
    Parameters<ViewManager["bindPanelSlot"]>[1],
    "rendererInstanceId" | "bindingSequence" | "operationSequence"
  > &
    Partial<
      Pick<
        Parameters<ViewManager["bindPanelSlot"]>[1],
        "rendererInstanceId" | "bindingSequence" | "operationSequence"
      >
    >
) {
  const rendererInstanceId = request.rendererInstanceId ?? "renderer-test";
  manager.setHostedShellReady(ownerViewId, true, rendererInstanceId);
  const result = manager.bindPanelSlot(ownerViewId, {
    bindingSequence: 1,
    operationSequence: 1,
    ...request,
    rendererInstanceId,
  });
  if (result.status === "bound") manager.attachDeclaredPanelSlot(request.panelId);
  return result;
}
import { BaseWindow, WebContentsView, ipcMain } from "electron";

type MockBaseWindow = InstanceType<typeof BaseWindow>;

describe("ViewManager", () => {
  let mockWindow: MockBaseWindow;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWindow = new BaseWindow();
  });

  describe("initialization", () => {
    it("creates shell view on construction", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });

      expect(WebContentsView).toHaveBeenCalled();
      expect(mockWindow.contentView.addChildView).toHaveBeenCalled();
      expect(vm.hasView("shell")).toBe(true);
    });

    it("opens devtools when devTools option is true", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
        devTools: true,
      });

      const shellContents = vm.getShellWebContents();
      expect(shellContents.openDevTools).toHaveBeenCalled();
    });

    it("keeps host chrome and hidden panel boot runtimes schedulable", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });

      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.createView({ id: "panel-1", type: "panel" });

      const calls = (WebContentsView as unknown as Mock).mock.calls;
      expect(calls[1]?.[0]?.webPreferences?.backgroundThrottling).toBe(false);
      expect(calls[2]?.[0]?.webPreferences?.backgroundThrottling).toBe(false);
      const results = (WebContentsView as unknown as Mock).mock.results;
      expect(results[1]?.value.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
      expect(results[2]?.value.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    });

    it("destroys content overlay IPC listeners with the manager", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");
      // Overlay instances are created per surface on first show, so there are
      // no listeners to remove until a surface has actually been used.
      vm.showContentOverlay({
        surface: "approval-card",
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        props: null,
        theme: { appearance: "light" },
      });

      vm.destroy();

      expect(ipcMain.removeListener).toHaveBeenCalledWith(
        "vibestudio:content-overlay:size",
        expect.any(Function)
      );
      expect(ipcMain.removeListener).toHaveBeenCalledWith(
        "vibestudio:content-overlay:intent",
        expect.any(Function)
      );
      expect(ipcMain.removeListener).toHaveBeenCalledWith(
        "vibestudio:content-overlay:ready",
        expect.any(Function)
      );
    });

    it("keeps one instance per surface so the approval card survives quickfire", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");
      const bounds = { x: 0, y: 0, width: 800, height: 600 };

      vm.showContentOverlay({
        surface: "approval-card",
        bounds,
        props: { approvalId: "approval-1" },
        theme: { appearance: "light" },
      });
      const results = (WebContentsView as unknown as Mock).mock.results;
      const cardView = results[results.length - 1]?.value;

      vm.showContentOverlay({
        surface: "quickfire",
        bounds,
        props: { mode: "all" },
        theme: { appearance: "light" },
      });
      const quickfireView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;

      // Two distinct native views, each loading its own surface — showing the
      // second must not replace the surface loaded in the first.
      expect(quickfireView).not.toBe(cardView);
      expect(cardView.webContents.loadURL).toHaveBeenCalledWith(
        "file:///shell/index.html#overlaySurface=approval-card"
      );
      expect(quickfireView.webContents.loadURL).toHaveBeenCalledWith(
        "file:///shell/index.html#overlaySurface=quickfire"
      );

      // Quickfire is the higher of the fixed-order pair.
      const children = mockWindow.contentView.children as unknown[];
      expect(children.indexOf(quickfireView)).toBeGreaterThan(children.indexOf(cardView));

      // Hiding one surface leaves the other visible.
      vm.hideContentOverlay("quickfire");
      expect(quickfireView.setVisible).toHaveBeenLastCalledWith(false);
      expect(cardView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("routes an update to the named surface only", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");
      const bounds = { x: 0, y: 0, width: 800, height: 600 };
      vm.showContentOverlay({
        surface: "approval-card",
        bounds,
        props: { approvalId: "approval-1" },
        theme: { appearance: "light" },
      });
      const cardView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;
      vm.showContentOverlay({
        surface: "quickfire",
        bounds,
        props: { mode: "all" },
        theme: { appearance: "light" },
      });
      const quickfireView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;
      const readyHandlers = (ipcMain.on as Mock).mock.calls
        .filter(([channel]) => channel === "vibestudio:content-overlay:ready")
        .map(([, handler]) => handler as (event: { sender: { id: number } }) => void);
      for (const handler of readyHandlers) {
        handler({ sender: { id: cardView.webContents.id } });
        handler({ sender: { id: quickfireView.webContents.id } });
      }
      cardView.webContents.send.mockClear();
      quickfireView.webContents.send.mockClear();

      vm.updateContentOverlay("quickfire", { props: { mode: "commands" } });

      expect(quickfireView.webContents.send).toHaveBeenCalledWith(
        "vibestudio:content-overlay:render",
        expect.objectContaining({ surface: "quickfire", props: { mode: "commands" } })
      );
      expect(cardView.webContents.send).not.toHaveBeenCalled();
    });

    it("ignores an update or hide for a surface that was never shown", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      expect(() => vm.updateContentOverlay("quickfire", { props: {} })).not.toThrow();
      expect(() => vm.hideContentOverlay("quickfire")).not.toThrow();
    });
  });

  describe("createView", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("creates a panel view ready for owned navigation", () => {
      const view = vm.createView({
        id: "test-panel",
        type: "panel",
        preload: null,
      });

      expect(view).toBeDefined();
      expect(vm.hasView("test-panel")).toBe(true);
    });

    it("tracks views by webContents id without scanning", () => {
      const view = vm.createView({
        id: "test-panel",
        type: "panel",
      });

      expect(vm.findViewIdByWebContentsId(view.webContents.id)).toBe("test-panel");

      vm.destroyView("test-panel");

      expect(vm.findViewIdByWebContentsId(view.webContents.id)).toBeNull();
    });

    it("creates a browser view with default session", () => {
      const view = vm.createView({
        id: "test-browser",
        type: "panel",
        preload: null,
      });

      expect(view).toBeDefined();
      expect(vm.hasView("test-browser")).toBe(true);
    });

    it("throws when creating duplicate view", () => {
      vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      expect(() => {
        vm.createView({
          id: "test-view",
          type: "panel",
          preload: null,
        });
      }).toThrow("View already exists: test-view");
    });
  });

  describe("native shell overlays", () => {
    it("creates a bounded overlay view above panel views", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellOverlayPreload: "/path/to/shellOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });

      vm.setViewVisible("panel-1", true);
      vm.showNativeShellOverlay({
        id: "menu-1",
        rows: [{ label: "Menu", type: "select" }],
        empty: "No items",
        bounds: { x: 20, y: 40, width: 240, height: 180 },
      });

      const results = (WebContentsView as unknown as Mock).mock.results;
      const overlayView = results[results.length - 1]?.value;
      expect(overlayView).toBeTruthy();
      expect(overlayView.setBounds).toHaveBeenCalledWith({ x: 20, y: 40, width: 240, height: 180 });
      expect(overlayView.setVisible).toHaveBeenCalledWith(true);
      expect(overlayView.webContents.loadURL).toHaveBeenCalledWith(
        expect.stringContaining("data:text/html")
      );
      const loadedUrl = overlayView.webContents.loadURL.mock.calls[0]?.[0] as string;
      const overlayHtml = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(",") + 1));
      expect(overlayHtml).toContain("Content-Security-Policy");
      expect(overlayHtml).toContain("script-src 'none'");
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalledWith(overlayView);
      expect(mockWindow.contentView.addChildView).toHaveBeenCalledWith(overlayView);
      expect(panelView.setVisible).toHaveBeenCalledWith(true);
    });

    it("applies content overlay focus after the first surface load completes", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");

      vm.showContentOverlay({
        surface: "approval-card",
        bounds: { x: 20, y: 40, width: 420, height: 300 },
        props: { approvalId: "approval-1" },
        theme: { appearance: "light" },
        focus: true,
      });

      const results = (WebContentsView as unknown as Mock).mock.results;
      const overlayView = results[results.length - 1]?.value;
      expect(overlayView).toBeTruthy();
      expect(overlayView.webContents.loadURL).toHaveBeenCalledWith(
        "file:///shell/index.html#overlaySurface=approval-card"
      );
      expect(overlayView.webContents.focus).not.toHaveBeenCalled();

      const didFinishLoad = (overlayView.webContents.on as Mock).mock.calls.find(
        ([event]) => event === "did-finish-load"
      )?.[1] as (() => void) | undefined;
      expect(didFinishLoad).toEqual(expect.any(Function));

      const readyHandler = (ipcMain.on as Mock).mock.calls.find(
        ([channel]) => channel === "vibestudio:content-overlay:ready"
      )?.[1] as ((event: { sender: { id: number } }, payload: unknown) => void) | undefined;
      expect(readyHandler).toEqual(expect.any(Function));

      readyHandler?.(
        { sender: { id: overlayView.webContents.id } },
        { url: "file:///shell/index.html#overlaySurface=approval-card" }
      );

      expect(overlayView.webContents.send).toHaveBeenCalledWith(
        "vibestudio:content-overlay:render",
        expect.objectContaining({ maxWidth: 396, maxHeight: 276 })
      );

      didFinishLoad?.();

      expect(overlayView.webContents.send).toHaveBeenCalledWith(
        "vibestudio:content-overlay:render",
        expect.objectContaining({ maxWidth: 396, maxHeight: 276 })
      );
      expect(overlayView.webContents.focus).toHaveBeenCalledTimes(1);
    });

    it("applies a reopened overlay focus request after its final stacking pass", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");

      const options = {
        surface: "quickfire",
        bounds: { x: 20, y: 40, width: 420, height: 300 },
        props: { mode: "all" },
        theme: { appearance: "light" as const },
        focus: true,
      };
      vm.showContentOverlay(options);

      const overlayView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;
      const readyHandler = (ipcMain.on as Mock).mock.calls.find(
        ([channel]) => channel === "vibestudio:content-overlay:ready"
      )?.[1] as ((event: { sender: { id: number } }, payload: unknown) => void) | undefined;
      readyHandler?.(
        { sender: { id: overlayView.webContents.id } },
        { url: "file:///shell/index.html#overlaySurface=quickfire" }
      );
      vm.hideContentOverlay("quickfire");

      overlayView.webContents.focus.mockClear();
      const addChildView = mockWindow.contentView.addChildView as unknown as Mock;
      addChildView.mockClear();
      vm.showContentOverlay(options);

      expect(overlayView.webContents.focus).toHaveBeenCalledTimes(1);
      const lastRaise = addChildView.mock.invocationCallOrder.at(-1);
      const focus = overlayView.webContents.focus.mock.invocationCallOrder.at(-1);
      expect(lastRaise).toBeDefined();
      expect(focus).toBeDefined();
      expect(focus).toBeGreaterThan(lastRaise!);
    });

    it("prewarms quickfire when the hosted shell becomes ready", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const hostedShellView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      (hostedShellView.webContents.getURL as unknown as Mock).mockReturnValue(
        "file:///hosted-shell/index.html"
      );

      vm.setHostedShellReady("@workspace-apps/shell", true);

      const overlayView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;
      expect(overlayView.webContents.loadURL).toHaveBeenCalledWith(
        "file:///hosted-shell/index.html#overlaySurface=quickfire"
      );
      expect(overlayView.setVisible).toHaveBeenCalledWith(false);
      expect(overlayView.setVisible).not.toHaveBeenCalledWith(true);
      expect(overlayView.webContents.focus).not.toHaveBeenCalled();
    });

    it("retries surface navigation after the hosted-shell URL becomes available", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("");

      vm.showContentOverlay({
        surface: "quickfire",
        bounds: { x: 20, y: 40, width: 420, height: 300 },
        props: { mode: "all" },
        theme: { appearance: "light" },
      });
      const overlayView = (WebContentsView as unknown as Mock).mock.results.at(-1)?.value;
      expect(overlayView.webContents.loadURL).not.toHaveBeenCalled();

      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");
      vm.updateContentOverlay("quickfire", { props: { mode: "commands" } });

      expect(overlayView.webContents.loadURL).toHaveBeenCalledWith(
        "file:///shell/index.html#overlaySurface=quickfire"
      );
    });

    it("forwards an outside pointer press without consuming the clicked view's event", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostedShellView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      (hostedShellView.webContents.getURL as unknown as Mock).mockReturnValue(
        "file:///hosted-shell/index.html"
      );
      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.showContentOverlay({
        surface: "quickfire",
        bounds: { x: 20, y: 40, width: 420, height: 300 },
        props: { mode: "all" },
        theme: { appearance: "light" },
      });
      (hostedShellView.webContents.send as unknown as Mock).mockClear();

      const mouseHandler = (panelView.webContents.on as Mock).mock.calls.find(
        ([event]) => event === "before-mouse-event"
      )?.[1] as ((event: { preventDefault: Mock }, mouse: { type: string }) => void) | undefined;
      const event = { preventDefault: vi.fn() };
      mouseHandler?.(event, { type: "mouseDown" });

      expect(hostedShellView.webContents.send).toHaveBeenCalledWith(
        "vibestudio:content-overlay:forward",
        { type: "host-pointer-down" }
      );
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("keeps content overlays top-left anchored while expanding to reported content size", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const shellContents = vm.getShellWebContents();
      (shellContents.getURL as unknown as Mock).mockReturnValue("file:///shell/index.html");

      vm.showContentOverlay({
        surface: "approval-card",
        bounds: { x: 20, y: 40, width: 700, height: 480 },
        props: { approvalId: "approval-1" },
        theme: { appearance: "light" },
      });

      const results = (WebContentsView as unknown as Mock).mock.results;
      const overlayView = results[results.length - 1]?.value;
      expect(overlayView).toBeTruthy();
      expect(overlayView.setBounds).toHaveBeenCalledWith({
        x: 32,
        y: 52,
        width: 472,
        height: 64,
      });

      const sizeHandler = (ipcMain.on as Mock).mock.calls.find(
        ([channel]) => channel === "vibestudio:content-overlay:size"
      )?.[1] as ((event: { sender: { id: number } }, payload: unknown) => void) | undefined;
      expect(sizeHandler).toEqual(expect.any(Function));

      sizeHandler?.({ sender: { id: overlayView.webContents.id } }, { width: 620, height: 240 });

      expect(overlayView.setBounds).toHaveBeenCalledWith({
        x: 32,
        y: 52,
        width: 620,
        height: 240,
      });

      sizeHandler?.({ sender: { id: overlayView.webContents.id } }, { width: 1200, height: 260 });

      expect(overlayView.setBounds).toHaveBeenCalledWith({
        x: 32,
        y: 52,
        width: 676,
        height: 260,
      });
    });

    it("keeps a visible content overlay above a panel appended later", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        contentOverlayPreload: "/path/to/contentOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostedShellView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 260, y: 32, width: 940, height: 768 },
      });
      (hostedShellView.webContents.getURL as unknown as Mock).mockReturnValue(
        "file:///shell/index.html"
      );
      vm.showContentOverlay({
        surface: "approval-card",
        bounds: { x: 260, y: 32, width: 940, height: 768 },
        props: { approvalId: "approval-1" },
        theme: { appearance: "dark" },
      });

      const results = (WebContentsView as unknown as Mock).mock.results;
      const overlayView = results[results.length - 1]?.value;
      const children = mockWindow.contentView.children as unknown[];
      expect(children.indexOf(overlayView)).toBeGreaterThan(children.indexOf(panelView));

      // A recreated or late-loaded panel is appended at the top. Its managed
      // order is still valid, but it must not cover the already-open overlay.
      mockWindow.contentView.addChildView(panelView);
      vm.updatePanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        rendererInstanceId: "renderer-test",
        bindingId: "binding-test",
        bindingSequence: 1,
        operationSequence: 2,
        bounds: { x: 260, y: 32, width: 940, height: 768 },
      });

      expect(children.indexOf(overlayView)).toBeGreaterThan(children.indexOf(panelView));
    });
  });

  describe("native panel slots", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("targets shell events at the active hosted shell document", () => {
      expect(vm.getHostedShellWebContents()).toBeNull();
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);

      expect(vm.getHostedShellWebContents()).toBe(hostView.webContents);
    });

    it("converges complete desired snapshots and rejects stale revisions", () => {
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.createView({ id: "panel-1", type: "panel" });
      vm.setHostedShellReady("@workspace-apps/shell", true, "renderer-1");

      expect(
        vm.syncPanelSlots("@workspace-apps/shell", {
          rendererInstanceId: "renderer-1",
          revision: 1,
          slots: [
            {
              nativeSlotId: "slot-1",
              bindingId: "binding-1",
              bindingSequence: 1,
              panelId: "panel-1",
              bounds: { x: 10, y: 20, width: 300, height: 200 },
              focused: true,
            },
          ],
        })
      ).toEqual({ revision: 1, slots: { "slot-1": { status: "bound" } } });
      expect(vm.isPanelSlotted("panel-1")).toBe(true);

      expect(
        vm.syncPanelSlots("@workspace-apps/shell", {
          rendererInstanceId: "renderer-1",
          revision: 2,
          slots: [],
        })
      ).toEqual({ revision: 2, slots: {} });
      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(() =>
        vm.syncPanelSlots("@workspace-apps/shell", {
          rendererInstanceId: "renderer-1",
          revision: 1,
          slots: [],
        })
      ).toThrow(/stale native panel snapshot revision/);
    });

    it("implements the generation-fenced panel-host protocol at the Electron boundary", async () => {
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const connected = vm.connectNativePanelAdapter("@workspace-apps/shell", {
        sealedLaunchIdentity: "@workspace-apps/shell",
        supportedProtocolVersions: [1],
      });
      expect(connected.accepted).toBe(true);
      if (!connected.accepted) throw new Error("expected Electron panel host handshake");
      const desired = {
        protocolVersion: 1 as const,
        hostGeneration: connected.handshake.hostGeneration,
        shellGeneration: connected.handshake.shellGeneration,
        revision: 1,
        surfaces: [
          {
            surfaceId: "slot-1",
            materialization: {
              runtimeEntityId: "panel-1",
              leaseConnectionId: "lease-1",
            },
            visible: true,
            focused: true,
            bounds: { x: 10, y: 20, width: 300, height: 200 },
          },
        ],
      };

      await expect(
        vm.applyNativePanelSurfaces("@workspace-apps/shell", desired)
      ).resolves.toMatchObject({
        accepted: true,
        observation: {
          desiredRevision: 1,
          surfaces: [{ surfaceId: "slot-1" }],
        },
      });
      expect(panelView.webContents.focus).not.toHaveBeenCalled();
      await expect(
        vm.applyNativePanelSurfaces("@workspace-apps/shell", desired)
      ).resolves.toMatchObject({ accepted: true });
      await expect(
        vm.applyNativePanelSurfaces("@workspace-apps/shell", {
          ...desired,
          hostGeneration: "foreign-host",
          revision: 2,
        })
      ).resolves.toEqual({ accepted: false, reason: "foreign-host-generation" });

      const replacement = vm.connectNativePanelAdapter("@workspace-apps/shell", {
        sealedLaunchIdentity: "@workspace-apps/shell",
        supportedProtocolVersions: [1],
      });
      expect(replacement.accepted).toBe(true);
      await expect(vm.applyNativePanelSurfaces("@workspace-apps/shell", desired)).resolves.toEqual({
        accepted: false,
        reason: "stale-shell-generation",
      });
    });

    it("keeps an unbound panel hidden until hosted shell binds its measured slot", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.setViewVisible("panel-1", true);
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      (panelView.setVisible as Mock).mockClear();
      vm.setViewVisible("panel-1", true);

      expect(vm.isViewVisible("panel-1")).toBe(true);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);

      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("binds a panel slot with measured bounds and focus", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 11.4, y: 23.6, width: 500.2, height: 300.8 },
        focused: true,
      });

      expect(hostView.setVisible).toHaveBeenCalledWith(true);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 11,
        y: 24,
        width: 500,
        height: 301,
      });
      expect(panelView.setVisible).toHaveBeenCalledWith(true);
      expect(panelView.webContents.focus).not.toHaveBeenCalled();
      expect(vm.isPanelSlotted("panel-1")).toBe(true);
    });

    it("preserves measured slot bounds when a bound panel becomes visible", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      const bounds = { x: 267, y: 32, width: 933, height: 768 };
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds,
      });
      (panelView.setBounds as Mock).mockClear();

      vm.setViewVisible("panel-1", true);

      expect(panelView.setBounds).toHaveBeenLastCalledWith(bounds);
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("does not steal focus while a focused declaration attaches or resyncs", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      const request = {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-old",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      };

      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", request);
      expect(panelView.webContents.focus).not.toHaveBeenCalled();

      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        ...request,
        bindingId: "binding-new",
      });
      vm.updatePanelSlot("@workspace-apps/shell", {
        nativeSlotId: request.nativeSlotId,
        rendererInstanceId: "renderer-test",
        bindingId: "binding-new",
        bindingSequence: 1,
        operationSequence: 2,
        focused: true,
      });

      expect(panelView.webContents.focus).not.toHaveBeenCalled();
    });

    it("updates and clears a panel slot", async () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(
        vm.updatePanelSlot("@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          rendererInstanceId: "renderer-test",
          bindingId: "binding-test",
          bindingSequence: 1,
          operationSequence: 2,
          bounds: { x: 12, y: 24, width: 320, height: 220 },
        })
      ).toEqual({ status: "updated" });

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 12,
        y: 24,
        width: 320,
        height: 220,
      });

      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary", "binding-test", {
        rendererInstanceId: "renderer-test",
        bindingSequence: 1,
        operationSequence: 3,
      });

      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-1")).toBe(false);

      const diagnostics = await vm.getPanelDisplayDiagnostics();
      expect(diagnostics.manager.visiblePanelId).toBeNull();

      expect(vm.getProcessPerformanceSnapshot()).toMatchObject({
        version: 1,
        familyWorkingSetBytes: 20 * 1024 * 1024,
        processes: [
          {
            pid: 1234,
            type: "Tab",
            workingSetBytes: 20 * 1024 * 1024,
            cpuPercent: 1.25,
          },
        ],
      });
    });

    it("ignores a stale release after a newer binding incarnation takes over the slot", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-old",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-new",
        panelId: "panel-1",
        bounds: { x: 12, y: 24, width: 320, height: 220 },
      });

      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary", "binding-old", {
        rendererInstanceId: "renderer-test",
        bindingSequence: 1,
        operationSequence: 2,
      });

      expect(vm.isPanelSlotted("panel-1")).toBe(true);
      expect(panelView.setVisible).not.toHaveBeenLastCalledWith(false);
      expect(
        vm.updatePanelSlot("@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          rendererInstanceId: "renderer-test",
          bindingId: "binding-new",
          bindingSequence: 1,
          operationSequence: 2,
          focused: true,
        })
      ).toEqual({ status: "updated" });
    });

    it("rejects reuse of a complete desired-state revision with different content", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true, "renderer-test");
      const first = {
        rendererInstanceId: "renderer-test",
        revision: 1,
        slots: [
          {
            nativeSlotId: "panel-stack:primary",
            bindingId: "binding-a",
            bindingSequence: 1,
            panelId: "panel-1",
            bounds: { x: 10, y: 20, width: 300, height: 200 },
            focused: true,
          },
        ],
      };
      expect(vm.syncPanelSlots("@workspace-apps/shell", first)).toMatchObject({ revision: 1 });
      expect(() =>
        vm.syncPanelSlots("@workspace-apps/shell", {
          ...first,
          slots: [],
        })
      ).toThrow(/stale native panel snapshot revision/);
      expect(vm.isPanelSlotted("panel-1")).toBe(true);
    });

    it("accepts an empty complete snapshot as the sole clear operation", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true, "renderer-test");
      expect(
        vm.syncPanelSlots("@workspace-apps/shell", {
          rendererInstanceId: "renderer-test",
          revision: 1,
          slots: [],
        })
      ).toEqual({ revision: 1, slots: {} });
      expect(vm.isPanelSlotted("panel-1")).toBe(false);
    });

    it("keeps the newest binding when an older claim is delivered late", () => {
      vm.createView({ id: "panel-a", type: "panel" });
      vm.createView({ id: "panel-b", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);

      expect(
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-b",
          bindingSequence: 2,
          operationSequence: 1,
          panelId: "panel-b",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        })
      ).toEqual({ status: "bound" });
      expect(
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-a",
          bindingSequence: 1,
          operationSequence: 1,
          panelId: "panel-a",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        })
      ).toMatchObject({ status: "missing" });

      expect(vm.isPanelSlotted("panel-a")).toBe(false);
      expect(vm.isPanelSlotted("panel-b")).toBe(true);
    });

    it("hides the previous surface when a newer owner is not materialized yet", () => {
      const previousView = vm.createView({ id: "panel-old", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-old",
        bindingSequence: 1,
        operationSequence: 1,
        panelId: "panel-old",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      expect(
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-new",
          bindingSequence: 2,
          operationSequence: 1,
          panelId: "panel-new",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        })
      ).toEqual({ status: "bound" });

      expect(previousView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-old")).toBe(false);

      // Cleanup from the superseded surface remains stale, but that is safe:
      // accepting the newer desired owner already removed its pixels.
      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary", "binding-old", {
        rendererInstanceId: "renderer-test",
        bindingSequence: 1,
        operationSequence: 2,
      });
      expect(vm.isPanelSlotted("panel-old")).toBe(false);

      vm.createView({ id: "panel-new", type: "panel" });
      vm.attachDeclaredPanelSlot("panel-new");
      expect(vm.isPanelSlotted("panel-new")).toBe(true);
    });

    it("relinquishes the previous surface when the newer owner is already slotted elsewhere", () => {
      const previousView = vm.createView({ id: "panel-old", type: "panel" });
      vm.createView({ id: "panel-new", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-old",
        bindingSequence: 1,
        operationSequence: 1,
        panelId: "panel-old",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:secondary",
        bindingId: "binding-new-secondary",
        bindingSequence: 2,
        operationSequence: 1,
        panelId: "panel-new",
        bounds: { x: 320, y: 20, width: 300, height: 200 },
      });

      expect(() =>
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-new-primary",
          bindingSequence: 3,
          operationSequence: 1,
          panelId: "panel-new",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        })
      ).toThrow(/already bound to native slot panel-stack:secondary/);

      expect(previousView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-old")).toBe(false);
      expect(vm.isPanelSlotted("panel-new")).toBe(true);
    });

    it("starts a fresh ordering epoch for a replacement shell document", () => {
      vm.createView({ id: "panel-a", type: "panel" });
      vm.createView({ id: "panel-b", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true, "renderer-old");
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        rendererInstanceId: "renderer-old",
        bindingId: "binding-old",
        bindingSequence: 50,
        operationSequence: 1,
        panelId: "panel-a",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.setHostedShellReady("@workspace-apps/shell", true, "renderer-new");
      expect(
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          rendererInstanceId: "renderer-new",
          bindingId: "binding-new",
          bindingSequence: 1,
          operationSequence: 1,
          panelId: "panel-b",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        })
      ).toEqual({ status: "bound" });

      vm.setHostedShellReady("@workspace-apps/shell", false, "renderer-old");
      expect(vm.isPanelSlotted("panel-a")).toBe(false);
      expect(vm.isPanelSlotted("panel-b")).toBe(true);
    });

    it("emits native-slot-focused and updates focus state when a bound view's WebContents gains focus", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:pane-a",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      const focused: Array<{ nativeSlotId: string; panelId: string }> = [];
      const unsubscribe = vm.onNativeSlotFocused((payload) => focused.push(payload));

      const onCalls = (panelView.webContents.on as Mock).mock.calls as Array<[string, () => void]>;
      const focusHandler = onCalls.find(([event]) => event === "focus")?.[1];
      expect(focusHandler).toBeDefined();
      focusHandler?.();

      expect(focused).toEqual([{ nativeSlotId: "panel-stack:pane-a", panelId: "panel-1" }]);
      expect(vm.getSlotBoundPanelIds()).toEqual(["panel-1"]);

      // Clearing the slot detaches the listener; a late native focus event
      // must not resurrect focus state for an unbound slot.
      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:pane-a", "binding-test", {
        rendererInstanceId: "renderer-test",
        bindingSequence: 1,
        operationSequence: 2,
      });
      expect(panelView.webContents.off).toHaveBeenCalledWith("focus", focusHandler);
      focusHandler?.();
      expect(focused).toHaveLength(1);
      expect(vm.getSlotBoundPanelIds()).toEqual([]);
      unsubscribe();
    });

    it("reasserts active slot surfaces when a hidden window is shown again", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      (panelView.setBounds as Mock).mockClear();
      (panelView.setVisible as Mock).mockClear();
      const showHandler = (mockWindow.on as Mock).mock.calls.find(
        (call: unknown[]) => call[0] === "show"
      )?.[1] as (() => void) | undefined;
      expect(showHandler).toBeDefined();
      showHandler?.();

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("reasserts active slot visibility when shell overlay state changes", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const transitioningPanelView = vm.createView({ id: "panel-transitioning", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });
      vm.setViewVisible("panel-transitioning", true);

      vm.setShellOverlayActive(true);
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      expect(transitioningPanelView.setVisible).toHaveBeenLastCalledWith(false);
      vm.setShellOverlayActive(false);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("rejects binding one panel to two native slots", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "slot-a",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });

      expect(() =>
        declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
          nativeSlotId: "slot-b",
          bindingId: "binding-test",
          panelId: "panel-1",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        })
      ).toThrow(/already bound/);
      warnSpy.mockRestore();
    });

    it("hosted shell not-ready clears active slots", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });
      vm.setHostedShellReady("@workspace-apps/shell", false);

      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      expect(hostView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(vm.getVisibleHostChromeAppId()).toBeNull();
    });

    it("keeps active slots when the hosted shell reasserts readiness", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      (panelView.setVisible as Mock).mockClear();
      vm.setHostedShellReady("@workspace-apps/shell", true);

      expect(vm.isPanelSlotted("panel-1")).toBe(true);
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("restacks slotted panels above the hosted shell when it is re-shown", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      // Late app-update mount re-shows the hosted shell (bringToFront).
      vm.setViewVisible("@workspace-apps/shell", true);

      const children = mockWindow.contentView.children as unknown[];
      expect(children.indexOf(panelView)).toBeGreaterThan(children.indexOf(hostView));
    });

    it("keepalive restacks a slotted panel occluded by the hosted shell", () => {
      vi.useFakeTimers();
      try {
        const localVm = new ViewManager({
          window: mockWindow,
          shellPreload: "/path/to/preload.js",
          shellHtmlPath: "/path/to/index.html",
        });
        const panelView = localVm.createView({ id: "panel-1", type: "panel" });
        const hostView = localVm.createView({
          id: "@workspace-apps/shell",
          type: "app",
          hostChrome: true,
          appCapabilities: ["panel-hosting"],
        });

        localVm.setHostedShellReady("@workspace-apps/shell", true);
        declareAndAttachPanelSlot(localVm, "@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-test",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        });

        // Simulate external layer corruption stacking the shell above the
        // slotted panel (no ViewManager API does this anymore).
        mockWindow.contentView.addChildView(hostView);
        const children = mockWindow.contentView.children as unknown[];
        expect(children.indexOf(panelView)).toBeLessThan(children.indexOf(hostView));

        vi.advanceTimersByTime(5000);

        expect(children.indexOf(panelView)).toBeGreaterThan(children.indexOf(hostView));
      } finally {
        vi.useRealTimers();
      }
    });

    it("reattaches a retained slot declaration and focus listener after recreation", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      });

      const focused: Array<{ nativeSlotId: string; panelId: string }> = [];
      vm.onNativeSlotFocused((payload) => focused.push(payload));

      vm.destroyView("panel-1");
      expect(vm.isPanelSlotted("panel-1")).toBe(false);

      const recreated = vm.createView({ id: "panel-1", type: "panel" });
      vm.attachDeclaredPanelSlot("panel-1");

      expect(vm.isPanelSlotted("panel-1")).toBe(true);
      expect(recreated.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(recreated.setVisible).toHaveBeenLastCalledWith(true);
      expect(recreated.webContents.focus).not.toHaveBeenCalled();

      const focusHandler = (recreated.webContents.on as Mock).mock.calls.find(
        ([event]) => event === "focus"
      )?.[1] as (() => void) | undefined;
      expect(focusHandler).toBeDefined();
      focusHandler?.();
      expect(focused).toEqual([{ nativeSlotId: "panel-stack:primary", panelId: "panel-1" }]);
    });

    it("does not restore a slot the shell explicitly cleared", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.destroyView("panel-1");
      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary", "binding-test", {
        rendererInstanceId: "renderer-test",
        bindingSequence: 1,
        operationSequence: 2,
      });

      const recreated = vm.createView({ id: "panel-1", type: "panel" });

      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(recreated.setVisible).not.toHaveBeenCalledWith(true);
    });

    it("does not restore a slot across a hosted shell generation change", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.destroyView("panel-1");
      vm.setHostedShellReady("@workspace-apps/shell", false);
      vm.setHostedShellReady("@workspace-apps/shell", true);

      const recreated = vm.createView({ id: "panel-1", type: "panel" });

      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(recreated.setVisible).not.toHaveBeenCalledWith(true);
    });

    it("captures display diagnostics for slotted panels", async () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      (hostView.webContents.executeJavaScript as Mock).mockResolvedValue([
        {
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
      ]);

      vm.setHostedShellReady("@workspace-apps/shell", true);
      declareAndAttachPanelSlot(vm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      });

      const diagnostics = await vm.getPanelDisplayDiagnostics();

      expect(diagnostics.nativePanelSlots.slots).toEqual([
        expect.objectContaining({
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          focused: true,
        }),
      ]);
      expect(diagnostics.hostedShellSurfaces).toEqual([
        {
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
      ]);
      expect(diagnostics.views).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "panel-1",
            managedVisible: true,
            webContents: expect.objectContaining({ osProcessId: 1234, memoryMb: 20 }),
          }),
        ])
      );
      expect(diagnostics.captures).toEqual([
        {
          id: "panel-1",
          ok: true,
          empty: false,
          size: { width: 100, height: 100 },
        },
      ]);
      expect(panelView.webContents.capturePage).toHaveBeenCalled();
    });
  });

  describe("view lifecycle", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("destroyView removes view from window and map", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      expect(vm.hasView("test-view")).toBe(true);

      vm.destroyView("test-view");

      expect(vm.hasView("test-view")).toBe(false);
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalledWith(view);
    });

    it("destroyView is safe to call on non-existent view", () => {
      expect(() => vm.destroyView("non-existent")).not.toThrow();
    });
  });

  describe("view bounds and visibility", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("setViewBounds updates view bounds", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      const bounds = { x: 100, y: 50, width: 400, height: 300 };
      vm.setViewBounds("test-view", bounds);

      expect(view.setBounds).toHaveBeenCalledWith(bounds);
    });

    it("uses reported panel viewport bounds over reconstructed shell chrome layout", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.updateLayout({
        titleBarHeight: 32,
        sidebarVisible: true,
        sidebarWidth: 260,
        consentBarHeight: 0,
      });
      vm.setPanelViewportBounds({ x: 8.4, y: 164.6, width: 1180.2, height: 620.7 });
      vm.setViewVisible("test-view", true);

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 8,
        y: 165,
        width: 1180,
        height: 621,
      });

      vm.updateLayout({ sidebarVisible: false, consentBarHeight: 0 });

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 8,
        y: 165,
        width: 1180,
        height: 621,
      });
    });

    it("clamps stale reported panel viewport bounds below host chrome", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.setPanelViewportBounds({ x: 248, y: 32, width: 952, height: 768 });
      vm.setViewVisible("test-view", true);
      vm.updateLayout({
        titleBarHeight: 32,
        notificationBarHeight: 0,
        saveBarHeight: 0,
        consentBarHeight: 130,
      });

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 248,
        y: 162,
        width: 952,
        height: 638,
      });
    });

    it("falls back to chrome layout when no panel viewport bounds are reported", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.setPanelViewportBounds({ x: 8, y: 164, width: 1180, height: 620 });
      vm.setPanelViewportBounds(null);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });
      vm.setViewVisible("test-view", true);

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 260,
        y: 32,
        width: 940,
        height: 768,
      });
    });

    it("setViewVisible shows and hides view", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      expect(vm.isViewVisible("test-view")).toBe(false);

      vm.setViewVisible("test-view", true);
      expect(view.setVisible).toHaveBeenCalledWith(true);
      expect(vm.isViewVisible("test-view")).toBe(true);
      expect(view.webContents.focus).not.toHaveBeenCalled();

      expect(vm.focusView("test-view")).toBe(true);
      expect(view.webContents.focus).toHaveBeenCalledTimes(1);

      vm.setViewVisible("test-view", false);
      expect(view.setVisible).toHaveBeenCalledWith(false);
      expect(vm.isViewVisible("test-view")).toBe(false);
    });

    it("does not steal OS focus when focus arrives after the window deactivates", () => {
      const view = vm.createView({
        id: "delayed-panel",
        type: "panel",
      });
      vm.setViewVisible("delayed-panel", true);
      (mockWindow.isFocused as Mock).mockReturnValueOnce(false);

      expect(vm.focusView("delayed-panel")).toBe(true);

      expect(view.setVisible).toHaveBeenCalledWith(true);
      expect(view.webContents.focus).not.toHaveBeenCalled();
    });

    it("keeps host chrome app views full-window and out of panel layout", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const panelView = vm.createView({
        id: "panel-1",
        type: "panel",
      });

      vm.setViewVisible("@workspace-apps/shell", true);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });

      expect(hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });

      vm.setViewVisible("panel-1", true);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });

      expect(hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 260,
        y: 32,
        width: 940,
        height: 768,
      });
    });

    it("keeps bootstrap launch gate above fallback panels until hosted shell is ready", () => {
      const panelView = vm.createView({
        id: "panel-1",
        type: "panel",
      });
      const children = (mockWindow.contentView as unknown as { children: unknown[] }).children;
      const matchingShellViews = (children as Array<{ webContents?: unknown }>).filter(
        (view) => view.webContents === vm.getShellWebContents()
      );
      const shellView = matchingShellViews[matchingShellViews.length - 1];

      vm.setViewVisible("panel-1", true);

      expect(shellView).toBeDefined();
      expect(children[children.length - 1]).toBe(shellView);
      expect(children[children.length - 1]).not.toBe(panelView);
    });

    it("keeps panel views natively hidden behind the bootstrap launch gate when configured", () => {
      const gatedVm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
        hidePanelViewsUntilHostedShellReady: true,
      });
      const panelView = gatedVm.createView({
        id: "panel-1",
        type: "panel",
      });
      (panelView.setVisible as Mock).mockClear();

      gatedVm.setViewVisible("panel-1", true);

      expect(gatedVm.isViewVisible("panel-1")).toBe(true);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);

      gatedVm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      gatedVm.setHostedShellReady("@workspace-apps/shell", true);
      (panelView.setVisible as Mock).mockClear();

      gatedVm.setViewVisible("panel-1", true);

      expect(panelView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);

      declareAndAttachPanelSlot(gatedVm, "@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        bindingId: "binding-test",
        panelId: "panel-1",
        bounds: {
          x: 0,
          y: 32,
          width: 1200,
          height: 768,
        },
      });

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 32,
        width: 1200,
        height: 768,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("opens devtools on the visible host chrome app instead of the bootstrap shell", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const shellContents = vm.getShellWebContents();

      expect(vm.openHostChromeAppDevTools()).toBe(false);

      vm.setViewVisible("@workspace-apps/shell", true);

      expect(vm.getVisibleHostChromeAppId()).toBe("@workspace-apps/shell");
      expect(vm.openHostChromeAppDevTools()).toBe(true);
      expect(hostView.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
      expect(shellContents.openDevTools).not.toHaveBeenCalled();
    });

    it("ignores hiding a missing view", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => vm.setViewVisible("missing-view", false)).not.toThrow();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("warns when showing a missing view", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vm.setViewVisible("missing-view", true);

      expect(warnSpy).toHaveBeenCalledWith("[ViewManager] View not found: missing-view");
      warnSpy.mockRestore();
    });
  });

  describe("getWebContents", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("returns webContents for existing view", () => {
      vm.createView({
        id: "test-view",
        type: "panel",
      });

      const contents = vm.getWebContents("test-view");
      expect(contents).toBeDefined();
    });

    it("returns null for non-existent view", () => {
      const contents = vm.getWebContents("non-existent");
      expect(contents).toBeNull();
    });

    it("returns null for destroyed webContents", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      (view.webContents.isDestroyed as Mock).mockReturnValue(true);

      const contents = vm.getWebContents("test-view");
      expect(contents).toBeNull();
    });
  });

  describe("navigation", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("navigateView loads URL", async () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      await vm.navigateView("test-view", "https://example.com");

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("absorbs ERR_ABORTED only when a newer navigation supersedes it", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      let rejectFirst!: (error: unknown) => void;
      const firstLoad = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      (view.webContents.loadURL as Mock)
        .mockReturnValueOnce(firstLoad)
        .mockResolvedValueOnce(undefined);

      const superseded = vm.navigateView("test-view", "https://example.com/old");
      await vm.navigateView("test-view", "https://example.com/new");
      rejectFirst(Object.assign(new Error("ERR_ABORTED (-3)"), { code: -3 }));

      await expect(superseded).resolves.toBeUndefined();
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(2, "https://example.com/new");
    });

    it("rejects ERR_ABORTED when the latest requested navigation did not commit", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      const aborted = Object.assign(new Error("ERR_ABORTED (-3)"), { code: -3 });
      (view.webContents.loadURL as Mock).mockRejectedValueOnce(aborted);

      await expect(vm.navigateView("test-view", "https://example.com/latest")).rejects.toBe(
        aborted
      );
    });

    it("coalesces concurrent requests for the same desired URL", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      let resolveLoad!: () => void;
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      (view.webContents.loadURL as Mock).mockReturnValueOnce(load);

      const first = vm.navigateView("test-view", "https://example.com/desired");
      const second = vm.navigateView("test-view", "https://example.com/desired");
      expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
      resolveLoad();

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    });

    it("does not reload an already committed desired URL", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      (view.webContents.getURL as Mock).mockReturnValue("https://example.com/committed");
      (view.webContents.isLoading as Mock).mockReturnValue(false);

      await vm.navigateView("test-view", "https://example.com/committed", "runtime:current");
      await vm.navigateView("test-view", "https://example.com/committed", "runtime:current");

      expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    });

    it("restarts a committed URL when its document incarnation changes", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      (view.webContents.getURL as Mock).mockReturnValue("https://example.com/committed");
      (view.webContents.isLoading as Mock).mockReturnValue(false);

      await vm.navigateView("test-view", "https://example.com/committed", "runtime:first");
      await vm.navigateView("test-view", "https://example.com/committed", "runtime:replacement");

      expect(view.webContents.loadURL).toHaveBeenCalledTimes(2);
    });

    it("lets the committed URL supersede a different in-flight desired URL", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      let rejectFirst!: (error: unknown) => void;
      const firstLoad = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      (view.webContents.getURL as Mock).mockReturnValue("https://example.com/committed");
      (view.webContents.isLoading as Mock).mockReturnValue(false);
      (view.webContents.loadURL as Mock)
        .mockReturnValueOnce(firstLoad)
        .mockResolvedValueOnce(undefined);

      const superseded = vm.navigateView("test-view", "https://example.com/other");
      const latest = vm.navigateView("test-view", "https://example.com/committed");
      rejectFirst(Object.assign(new Error("ERR_ABORTED (-3)"), { code: -3 }));

      await expect(Promise.all([superseded, latest])).resolves.toEqual([undefined, undefined]);
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(2, "https://example.com/committed");
    });

    it("restarts the latest desired URL when reload races an in-flight navigation", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      let rejectFirst!: (error: unknown) => void;
      const firstLoad = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      (view.webContents.loadURL as Mock)
        .mockReturnValueOnce(firstLoad)
        .mockResolvedValueOnce(undefined);

      const first = vm.navigateView("test-view", "https://example.com/desired");
      const reload = vm.reloadView("test-view");
      rejectFirst(Object.assign(new Error("ERR_ABORTED (-3)"), { code: -3 }));

      await expect(first).resolves.toBeUndefined();
      await expect(reload).resolves.toBe(true);
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(1, "https://example.com/desired");
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(2, "https://example.com/desired");
      expect(view.webContents.reload).not.toHaveBeenCalled();
    });

    it("retries a failed load only while its URL remains desired", async () => {
      const view = vm.createView({ id: "test-view", type: "panel", preload: null });
      (view.webContents.getURL as Mock).mockReturnValue("https://example.com/desired");
      (view.webContents.isLoading as Mock).mockReturnValue(false);

      await vm.navigateView("test-view", "https://example.com/desired");
      await expect(
        vm.retryViewNavigation("test-view", "https://example.com/desired")
      ).resolves.toBe(true);
      await vm.navigateView("test-view", "data:text/html,error");
      await expect(
        vm.retryViewNavigation("test-view", "https://example.com/desired")
      ).resolves.toBe(false);

      expect(view.webContents.loadURL).toHaveBeenCalledTimes(2);
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(1, "https://example.com/desired");
      expect(view.webContents.loadURL).toHaveBeenNthCalledWith(2, "data:text/html,error");
    });

    it("getViewUrl returns current URL", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      (view.webContents.getURL as Mock).mockReturnValue("https://example.com");

      expect(vm.getViewUrl("test-view")).toBe("https://example.com");
    });

    it("navigation methods delegate to webContents", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      (view.webContents.navigationHistory.canGoBack as Mock).mockReturnValue(true);
      (view.webContents.navigationHistory.canGoForward as Mock).mockReturnValue(true);

      expect(vm.canGoBack("test-view")).toBe(true);
      expect(vm.canGoForward("test-view")).toBe(true);

      vm.goBack("test-view");
      expect(view.webContents.navigationHistory.goBack).toHaveBeenCalled();

      vm.goForward("test-view");
      expect(view.webContents.navigationHistory.goForward).toHaveBeenCalled();

      vm.reload("test-view");
      expect(view.webContents.reload).toHaveBeenCalled();

      vm.stop("test-view");
      expect(view.webContents.stop).toHaveBeenCalled();
    });
  });

  describe("theme CSS", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("setThemeCss stores CSS for new views", () => {
      vm.setThemeCss(":root { --color: red; }");

      // Create a view after setting theme
      vm.createView({
        id: "test-view",
        type: "panel",
        injectHostThemeVariables: true,
      });

      // Theme will be applied on dom-ready event
      expect(vm.hasView("test-view")).toBe(true);
    });
  });

  describe("compositor visibility cycling", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("refreshVisiblePanel reasserts visible state without cycling visibility", () => {
      const view = vm.createView({
        id: "panel-1",
        type: "panel",
      });

      // Make it the visible panel
      vm.setViewVisible("panel-1", true);
      (view.setVisible as Mock).mockClear();

      vm.refreshVisiblePanel();

      // setVisible(true) is reasserted, but there is no false/true cycle.
      expect(view.setVisible).toHaveBeenCalledTimes(1);
      expect(view.setVisible).toHaveBeenCalledWith(true);
      // But bounds should have been refreshed
      expect(view.setBounds).toHaveBeenCalled();
    });

    it("forceRepaint cycles visibility for visible views", () => {
      const view = vm.createView({
        id: "panel-2",
        type: "panel",
      });

      vm.setViewVisible("panel-2", true);
      (view.setVisible as Mock).mockClear();
      (view.setBounds as Mock).mockClear();

      vm.forceRepaint("panel-2");

      // Should cycle visibility (first call passes cooldown)
      const visibleCalls = (view.setVisible as Mock).mock.calls;
      const falseIdx = visibleCalls.findIndex((c: unknown[]) => c[0] === false);
      const trueIdx = visibleCalls.findIndex(
        (c: unknown[], i: number) => i > falseIdx && c[0] === true
      );
      expect(falseIdx).toBeGreaterThanOrEqual(0);
      expect(trueIdx).toBeGreaterThan(falseIdx);
    });

    it("visibility cycle does not change tracked isViewVisible() state", () => {
      vm.createView({
        id: "panel-3",
        type: "panel",
      });

      vm.setViewVisible("panel-3", true);
      expect(vm.isViewVisible("panel-3")).toBe(true);

      vm.forceRepaint("panel-3");
      expect(vm.isViewVisible("panel-3")).toBe(true);
    });
  });

  describe("compositor keepalive", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vi.useFakeTimers();
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keepalive invalidates and re-applies bounds without stealing focus", () => {
      const view = vm.createView({
        id: "keepalive-panel",
        type: "panel",
      });

      vm.setViewVisible("keepalive-panel", true);
      (view.setVisible as Mock).mockClear();
      (view.setBounds as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      // Advance past the keepalive interval (5s)
      vi.advanceTimersByTime(5000);

      // Should have refreshed bounds and invalidated
      expect(view.setBounds).toHaveBeenCalled();
      expect(view.webContents.invalidate).toHaveBeenCalled();
      // Should NOT have cycled visibility (would steal focus)
      expect(view.setVisible).not.toHaveBeenCalled();
    });

    it("keepalive skips when no panel is visible", () => {
      // No panel made visible — keepalive should be a no-op
      vi.advanceTimersByTime(5000);
      // No errors thrown = pass
    });

    it("keepalive skips when window is hidden", () => {
      const view = vm.createView({
        id: "hidden-window-panel",
        type: "panel",
      });

      vm.setViewVisible("hidden-window-panel", true);

      // Simulate window hide via the event handler
      const hideHandler = (mockWindow.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === "hide"
      )?.[1] as (() => void) | undefined;
      hideHandler?.();

      (view.setVisible as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      vi.advanceTimersByTime(5000);

      // Should not have done anything (window hidden)
      expect(view.webContents.invalidate).not.toHaveBeenCalled();
    });

    it("cooldown prevents rapid successive visibility cycles", () => {
      const view = vm.createView({
        id: "cooldown-panel",
        type: "panel",
      });

      vm.setViewVisible("cooldown-panel", true);
      (view.setVisible as Mock).mockClear();

      // First forceRepaint should cycle
      vm.forceRepaint("cooldown-panel");
      expect(view.setVisible).toHaveBeenCalledTimes(2); // false + true

      (view.setVisible as Mock).mockClear();

      // Second call within 1s should be suppressed by cooldown
      vm.forceRepaint("cooldown-panel");
      const calls = (view.setVisible as Mock).mock.calls;
      const falseIdx = calls.findIndex((c: unknown[]) => c[0] === false);
      expect(falseIdx).toBe(-1); // no visibility cycle

      // Advance past cooldown
      vi.advanceTimersByTime(1000);
      (view.setVisible as Mock).mockClear();

      // Third call after cooldown should cycle again
      vm.forceRepaint("cooldown-panel");
      expect(view.setVisible).toHaveBeenCalledTimes(2); // false + true
    });

    it("visibility cycle cooldown is scoped per view", () => {
      const firstView = vm.createView({
        id: "cooldown-panel-a",
        type: "panel",
      });
      const secondView = vm.createView({
        id: "cooldown-panel-b",
        type: "panel",
      });

      vm.setViewVisible("cooldown-panel-a", true);
      vm.setViewVisible("cooldown-panel-b", true);
      (firstView.setVisible as Mock).mockClear();
      (secondView.setVisible as Mock).mockClear();

      vm.forceRepaint("cooldown-panel-a");
      vm.forceRepaint("cooldown-panel-b");

      expect(firstView.setVisible).toHaveBeenCalledTimes(2);
      expect(secondView.setVisible).toHaveBeenCalledTimes(2);
    });

    it("forceRepaintVisiblePanel delegates to forceRepaint with visible panel ID", () => {
      const view = vm.createView({
        id: "visible-panel",
        type: "panel",
      });

      vm.setViewVisible("visible-panel", true);
      (view.setVisible as Mock).mockClear();

      const result = vm.forceRepaintVisiblePanel();

      expect(result).toBe(true);
      // Should have cycled visibility via forceRepaint
      const calls = (view.setVisible as Mock).mock.calls;
      const falseIdx = calls.findIndex((c: unknown[]) => c[0] === false);
      const trueIdx = calls.findIndex((c: unknown[], i: number) => i > falseIdx && c[0] === true);
      expect(falseIdx).toBeGreaterThanOrEqual(0);
      expect(trueIdx).toBeGreaterThan(falseIdx);
    });

    it("forceRepaintVisiblePanel returns false when no panel is visible", () => {
      expect(vm.forceRepaintVisiblePanel()).toBe(false);
    });
  });

  describe("captureView", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("force-paints and captures an unslotted hidden panel", async () => {
      // Programmatically-opened panels on the headless host are hidden and never
      // slotted into a UI. captureView must force-paint them via withViewVisible
      // (show at bounds + waitForRender), not refuse — otherwise the headless
      // screenshot path returns nothing.
      const view = vm.createView({ id: "headless-panel", type: "panel" });
      expect(vm.isViewVisible("headless-panel")).toBe(false);
      expect(vm.isPanelSlotted("headless-panel")).toBe(false);

      const captured = { isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }) };
      (view.webContents.capturePage as Mock).mockResolvedValue(captured);

      const image = await vm.captureView("headless-panel");

      expect(image).toBe(captured);
      // Force-painted: shown for the capture, then restored to hidden.
      expect(view.setVisible).toHaveBeenCalledWith(true);
      expect(view.setVisible).toHaveBeenLastCalledWith(false);
      expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
      expect(vm.isViewVisible("headless-panel")).toBe(false);
    });

    it("reveals a hidden parent window without activating it for capture", async () => {
      vm.createView({ id: "background-panel", type: "panel" });
      (mockWindow.isVisible as Mock).mockReturnValue(false);

      await vm.captureView("background-panel");

      expect(mockWindow.showInactive).toHaveBeenCalledTimes(1);
      expect(mockWindow.hide).toHaveBeenCalledTimes(1);
    });

    it("returns null for a destroyed panel view without capturing", async () => {
      const view = vm.createView({ id: "dead-panel", type: "panel" });
      (view.webContents.isDestroyed as Mock).mockReturnValue(true);

      const image = await vm.captureView("dead-panel");

      expect(image).toBeNull();
      expect(view.webContents.capturePage).not.toHaveBeenCalled();
    });

    it("returns null for a missing view", async () => {
      const image = await vm.captureView("nonexistent");
      expect(image).toBeNull();
    });
  });
});
