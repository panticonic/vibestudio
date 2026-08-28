import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Panel } from "@vibestudio/shared/types";
import { PanelView } from "./panelView.js";

function makePanel(id: string, source = "about/new"): Panel {
  return {
    id,
    title: id,
    children: [],
    snapshot: {
      source,
      contextId: "ctx-current",
      options: {},
    },
    artifacts: {},
    runtimeEntityId: "panel:nav-current",
  };
}

function makeWebContents() {
  type WindowOpenHandler = (details: {
    url: string;
    disposition?: Electron.HandlerDetails["disposition"];
  }) => { action: "deny" };
  let windowOpenHandler: WindowOpenHandler | null = null;
  const webContents = Object.assign(new EventEmitter(), {
    id: 10,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "http://127.0.0.1:1234/about/new/"),
    loadURL: vi.fn(async () => undefined),
    setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
      windowOpenHandler = handler;
    }),
  });
  return {
    webContents,
    windowOpen(details: { url: string; disposition?: Electron.HandlerDetails["disposition"] }) {
      if (!windowOpenHandler) throw new Error("window open handler not registered");
      return windowOpenHandler(details);
    },
  };
}

function createHarness(
  options: {
    viewType?: "panel" | "app";
    externalHost?: string;
    gatewayServerUrl?: string;
    managedNavigationInFlight?: boolean;
  } = {}
) {
  const panelId = options.viewType === "app" ? "@workspace-apps/shell" : "panel:tree/current";
  const panel = makePanel(panelId);
  const wc = makeWebContents();
  const viewManager = {
    hasView: vi.fn(() => false),
    getViewUrl: vi.fn(() => null),
    isManagedNavigationInFlight: vi.fn(() => options.managedNavigationInFlight ?? false),
    navigateView: vi.fn(async (): Promise<void> => undefined),
    updateCodeIdentity: vi.fn(),
    updateAppView: vi.fn(async () => undefined),
    createView: vi.fn(() => ({ webContents: wc.webContents })),
    getWebContents: vi.fn(() => wc.webContents),
    getViewInfo: vi.fn((id: string) =>
      id === panelId
        ? {
            type: options.viewType ?? "panel",
            visible: true,
            hostChrome: options.viewType === "app",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            capabilities: options.viewType === "app" ? ["panel-hosting"] : [],
          }
        : null
    ),
  };
  const panelRegistry = {
    findParentId: vi.fn(() => null),
    getPanel: vi.fn((id: string) => (id === panelId && options.viewType !== "app" ? panel : null)),
    notifyPanelTreeUpdate: vi.fn(),
  };
  const panelOrchestrator = {
    createPanel: vi.fn(async () => ({ id: "panel:tree/created", title: "Created" })),
    createBrowserUrlPanel: vi.fn(async () => ({ id: "panel:tree/browser", title: "Browser" })),
    navigatePanel: vi.fn(async () => ({ id: panelId, title: "Navigated" })),
    replaceCurrentSnapshot: vi.fn(async () => undefined),
    updatePanelTitle: vi.fn(async () => undefined),
    closePanel: vi.fn(async () => undefined),
  };
  const sendPanelEvent = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  const panelView = new PanelView({
    viewManager,
    panelRegistry,
    serverInfo: {
      gatewayConfig: { serverUrl: options.gatewayServerUrl ?? "http://127.0.0.1:1234" },
      gatewayPort: 1234,
      externalHost: options.externalHost ?? "127.0.0.1",
    },
    cdpHost: {
      registerTarget: vi.fn(),
      unregisterTarget: vi.fn(),
      cleanupPanelAccess: vi.fn(),
    },
    panelOrchestrator,
    sendPanelEvent,
    openExternal,
    requestSiteCapability: vi.fn(async () => true),
    appPreloadPath: "/app-preload.js",
  } as never);

  return {
    panelId,
    panel,
    panelView,
    viewManager,
    panelOrchestrator,
    sendPanelEvent,
    openExternal,
    ...wc,
  };
}

describe("PanelView plain panel links", () => {
  it("materializes a workspace panel at DOM readiness without waiting for all subresources", async () => {
    const { panelId, panelView, viewManager, webContents } = createHarness();
    let finishNavigation!: () => void;
    viewManager.navigateView.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishNavigation = resolve))
    );

    const creating = panelView.createViewForPanel(
      panelId,
      "http://127.0.0.1:1234/about/new/",
      "ctx-current"
    );
    await Promise.resolve();
    webContents.emit("dom-ready");

    await expect(creating).resolves.toBeUndefined();
    finishNavigation();
  });

  it("starts a new document when the runtime incarnation changes at the same build URL", async () => {
    const { panelId, panel, panelView, viewManager } = createHarness();
    const url = "http://127.0.0.1:1234/about/new/";

    await panelView.createViewForPanel(panelId, url, "ctx-current");
    viewManager.hasView.mockReturnValue(true);
    panel.runtimeEntityId = "panel:nav-replacement";
    await panelView.createViewForPanel(panelId, url, "ctx-current");

    expect(viewManager.navigateView).toHaveBeenNthCalledWith(1, panelId, url, "panel:nav-current");
    expect(viewManager.navigateView).toHaveBeenNthCalledWith(
      2,
      panelId,
      url,
      "panel:nav-replacement"
    );
  });

  it("navigates the current panel slot for same-frame managed links", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "http://127.0.0.1:1234/panels/chat/?stateArgs=%7B%22initialPrompt%22%3A%22hi%22%7D"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.navigatePanel).toHaveBeenCalledWith(panelId, "panels/chat", {
        stateArgs: { initialPrompt: "hi" },
      });
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(panelOrchestrator.createPanel).not.toHaveBeenCalled();
  });

  it("reports an in-place navigation transaction failure back to the launcher", async () => {
    const { panelId, panelView, webContents, panelOrchestrator, sendPanelEvent } = createHarness();
    vi.mocked(panelOrchestrator.navigatePanel).mockRejectedValueOnce(
      new Error("durable navigation commit failed: workspace state unavailable")
    );
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const url = "http://127.0.0.1:1234/panels/news/";
    webContents.emit("will-navigate", { preventDefault: vi.fn() }, url);

    await vi.waitFor(() => {
      expect(sendPanelEvent).toHaveBeenCalledWith(panelId, "runtime:child-creation-error", {
        url,
        error: "durable navigation commit failed: workspace state unavailable",
      });
    });
  });

  it("treats the gateway server URL host as managed when it differs from externalHost", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness({
      externalHost: "localhost",
      gatewayServerUrl: "http://127.0.0.1:1234",
    });
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "http://127.0.0.1:1234/panels/chat/?stateArgs=%7B%22initialPrompt%22%3A%22hi%22%7D"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.navigatePanel).toHaveBeenCalledWith(panelId, "panels/chat", {
        stateArgs: { initialPrompt: "hi" },
      });
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(panelOrchestrator.createBrowserUrlPanel).not.toHaveBeenCalled();
  });

  it("navigates prefixed workspace links across equivalent loopback hostnames", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness({
      externalHost: "localhost",
      gatewayServerUrl: "http://localhost:43873/_workspace/dev-123",
    });
    await panelView.createViewForPanel(
      panelId,
      "http://127.0.0.1:43873/_workspace/dev-123/about/new/",
      "ctx-current"
    );

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "http://127.0.0.1:43873/_workspace/dev-123/about/server-logs/"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.navigatePanel).toHaveBeenCalledWith(
        panelId,
        "about/server-logs",
        {}
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(panelOrchestrator.createPanel).not.toHaveBeenCalled();
    expect(panelOrchestrator.createBrowserUrlPanel).not.toHaveBeenCalled();
  });

  it("navigates canonical panel links in place with ref, context, and state", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness({
      gatewayServerUrl: "http://127.0.0.1:1234/_workspace/dev-123",
    });
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "vibestudio://panel?v=1&source=panels%2Fchat&workspace=dev-123&ref=state%3Aabc&contextId=ctx-next&stateArgs=%7B%22prompt%22%3A%22hi%22%7D&disposition=current"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.navigatePanel).toHaveBeenCalledWith(panelId, "panels/chat", {
        ref: "state:abc",
        contextId: "ctx-next",
        stateArgs: { prompt: "hi" },
      });
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(panelOrchestrator.createPanel).not.toHaveBeenCalled();
  });

  it("honors explicit root placement from a panel", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "vibestudio://panel?v=1&source=about%2Fserver-logs&disposition=root"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "about/server-logs",
        { isRoot: true },
        undefined,
        undefined
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not warn for initial managed navigations served through a gateway URL alias", async () => {
    const { panelId, panelView, webContents, sendPanelEvent } = createHarness({
      externalHost: "localhost",
      gatewayServerUrl: "http://127.0.0.1:1234",
    });
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    webContents.emit("did-navigate", {}, "http://127.0.0.1:1234/about/new/");

    expect(sendPanelEvent).not.toHaveBeenCalledWith(
      panelId,
      "runtime:child-creation-error",
      expect.anything()
    );
  });

  it("accepts an external-classified URL while the host owns that navigation", async () => {
    const { panelId, panelView, webContents, sendPanelEvent } = createHarness({
      managedNavigationInFlight: true,
    });
    await panelView.createViewForPanel(panelId, "about:blank", "ctx-current");

    webContents.emit("did-navigate", {}, "about:blank");

    expect(sendPanelEvent).not.toHaveBeenCalledWith(
      panelId,
      "runtime:child-creation-error",
      expect.anything()
    );
  });

  it("still rejects the same raw external navigation without host ownership", async () => {
    const { panelId, panelView, webContents, sendPanelEvent } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    webContents.emit("did-navigate", {}, "about:blank");

    expect(sendPanelEvent).toHaveBeenCalledWith(
      panelId,
      "runtime:child-creation-error",
      expect.objectContaining({
        error: expect.stringContaining("Unexpected raw external main-frame navigation"),
      })
    );
  });

  it("creates child panels for managed window-open links", async () => {
    const { panelId, panelView, windowOpen, panelOrchestrator, sendPanelEvent } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const result = windowOpen({ url: "http://127.0.0.1:1234/panels/chat/?name=chat-link" });

    expect(result).toEqual({ action: "deny" });
    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "panels/chat",
        {},
        undefined,
        undefined
      );
    });
    expect(sendPanelEvent).toHaveBeenCalledWith(panelId, "runtime:child-created", {
      childId: "panel:tree/created",
      url: "http://127.0.0.1:1234/panels/chat/?name=chat-link",
    });
  });

  it("passes managed link layout hints into child creation", async () => {
    const { panelId, panelView, windowOpen, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    windowOpen({
      url: "http://127.0.0.1:1234/panels/chat/?disposition=child&placement=side&preferredWidth=640&minWidth=440",
    });

    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "panels/chat",
        {
          placement: { disposition: "side", preferredWidth: 640, minWidth: 440 },
        },
        undefined,
        undefined
      );
    });
  });

  it("creates browser child panels for same-frame external links", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", event, "https://example.com/");

    await vi.waitFor(() => {
      expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
        panelId,
        "https://example.com/",
        { focus: true, placement: "child" },
        undefined
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("opens middle-clicked web links as unfocused child panels", async () => {
    const { panelId, panelView, windowOpen, panelOrchestrator } = createHarness();
    await panelView.createViewForBrowser(
      panelId,
      "https://source.example/",
      "ctx-current",
      "persist:browser-test"
    );

    const result = windowOpen({
      url: "http://127.0.0.1:1234/panels/chat/",
      disposition: "background-tab",
    });

    expect(result).toEqual({ action: "deny" });
    await vi.waitFor(() => {
      expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
        panelId,
        "http://127.0.0.1:1234/panels/chat/",
        { focus: false, placement: "child" },
        undefined
      );
    });
    expect(panelOrchestrator.createPanel).not.toHaveBeenCalled();
  });

  it("opens browser window popups as child panels", async () => {
    const { panelId, panelView, windowOpen, panelOrchestrator } = createHarness();
    await panelView.createViewForBrowser(
      panelId,
      "https://claude.ai/",
      "ctx-current",
      "persist:browser-test"
    );

    expect(windowOpen({ url: "https://accounts.google.com/", disposition: "new-window" })).toEqual({
      action: "deny",
    });

    await vi.waitFor(() => {
      expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
        panelId,
        "https://accounts.google.com/",
        { focus: true, placement: "child" },
        undefined
      );
    });
  });

  it("closes the durable panel when a popup closes its own window", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForBrowser(
      panelId,
      "https://accounts.google.com/",
      "ctx-current",
      "persist:browser-test"
    );

    webContents.emit("destroyed");

    await vi.waitFor(() => {
      expect(panelOrchestrator.closePanel).toHaveBeenCalledWith(panelId);
    });
  });

  it("hands OS protocol links to the confirmed external-open path", async () => {
    const { panelId, panelView, windowOpen, openExternal, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    expect(windowOpen({ url: "mailto:hello@example.com" })).toEqual({ action: "deny" });

    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("mailto:hello@example.com");
    });
    expect(panelOrchestrator.createBrowserUrlPanel).not.toHaveBeenCalled();
  });

  it("refuses file and JavaScript links without navigating or opening externally", async () => {
    const { panelId, panelView, windowOpen, openExternal, panelOrchestrator, sendPanelEvent } =
      createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    expect(windowOpen({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(windowOpen({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });

    expect(openExternal).not.toHaveBeenCalled();
    expect(panelOrchestrator.createBrowserUrlPanel).not.toHaveBeenCalled();
    expect(sendPanelEvent).toHaveBeenCalledWith(
      panelId,
      "runtime:child-creation-error",
      expect.objectContaining({ url: "file:///etc/passwd" })
    );
  });

  it("opens managed links from app views as app-scoped root panels", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness({
      viewType: "app",
    });
    await panelView.createViewForApp(
      panelId,
      "http://127.0.0.1:1234/_a/shell/index.html",
      undefined,
      ["panel-hosting"],
      { source: "apps/shell", effectiveVersion: "ev" }
    );

    const event = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", event, "http://127.0.0.1:1234/about/help/");

    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "about/help",
        { isRoot: true },
        undefined,
        { callerId: "@workspace-apps/shell", callerKind: "app" }
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
