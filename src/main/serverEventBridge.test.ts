import { describe, expect, it, vi } from "vitest";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { createServerEventBridge, notificationAttention } from "./serverEventBridge.js";

function createHarness(
  opts: {
    resolveAppAvailableEvent?: (payload: unknown) => unknown;
    onCredentialCaptureRequest?: (
      payload: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    onNotificationAction?: (id: string, actionId: string) => void | Promise<void>;
  } = {}
) {
  const eventService = { emit: vi.fn() };
  const panelOrchestrator = {
    applyBuildComplete: vi.fn(),
    handleRuntimeLeaseChanged: vi.fn(async () => {}),
    applyServerPanelTreeSnapshot: vi.fn(async () => undefined),
    applyServerPanelTitleUpdate: vi.fn(),
    recoverShellSnapshot: vi.fn(async () => undefined),
  };
  const appOrchestrator = {
    applyAppAvailable: vi.fn(async () => {}),
  };
  const serverClient = {
    call: vi.fn(async () => undefined),
  };
  const warn = vi.fn();
  const onAppHostTargetChanged = vi.fn();
  const handle = createServerEventBridge({
    eventService: eventService as never,
    getPanelOrchestrator: () => panelOrchestrator as never,
    getAppOrchestrator: () => appOrchestrator as never,
    getServerClient: () => serverClient as never,
    openExternal: vi.fn(async () => {}),
    onAppHostTargetChanged,
    resolveAppAvailableEvent: opts.resolveAppAvailableEvent,
    onCredentialCaptureRequest: opts.onCredentialCaptureRequest,
    onNotificationAction: opts.onNotificationAction,
    warn,
  });
  return {
    handle,
    eventService,
    panelOrchestrator,
    appOrchestrator,
    serverClient,
    onAppHostTargetChanged,
    warn,
  };
}

describe("createServerEventBridge", () => {
  it("normalizes build completion into orchestrator state updates instead of emitting raw events", () => {
    const { handle, eventService, panelOrchestrator } = createHarness();

    handle("build:complete", { source: "panels/chat", error: "failed" });

    expect(panelOrchestrator.applyBuildComplete).toHaveBeenCalledWith("panels/chat", "failed");
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("normalizes runtime lease changes through the orchestrator", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const payload = {
      type: "panel:runtimeLeaseChanged" as const,
      version: { epoch: "test", counter: 1 },
      slotId: asPanelSlotId("panel:tree/slot-a"),
      runtimeEntityId: asPanelEntityId("panel:nav-a"),
      previous: null,
      next: null,
      reason: "released" as const,
    };

    handle("panel:runtimeLeaseChanged", payload);
    await Promise.resolve();

    expect(panelOrchestrator.handleRuntimeLeaseChanged).toHaveBeenCalledWith(payload);
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("answers credential:capture-request with credentials.completeCapture", async () => {
    const onCredentialCaptureRequest = vi.fn(async () => ({ cookieHeader: "a=b" }));
    const { handle, serverClient } = createHarness({ onCredentialCaptureRequest });

    handle("credential:capture-request", {
      captureId: "cap-1",
      kind: "cookies",
      signInUrl: "https://example.test/login",
    });
    await vi.waitFor(() =>
      expect(serverClient.call).toHaveBeenCalledWith("credentials", "completeCapture", [
        "cap-1",
        { cookieHeader: "a=b" },
      ])
    );
    expect(onCredentialCaptureRequest).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: "cap-1", kind: "cookies" })
    );
  });

  it("reports a capture handler failure back as an error completion", async () => {
    const onCredentialCaptureRequest = vi.fn(async () => {
      throw new Error("browser unavailable");
    });
    const { handle, serverClient } = createHarness({ onCredentialCaptureRequest });

    handle("credential:capture-request", { captureId: "cap-2", kind: "cookies" });

    await vi.waitFor(() =>
      expect(serverClient.call).toHaveBeenCalledWith("credentials", "completeCapture", [
        "cap-2",
        { error: "browser unavailable" },
      ])
    );
  });

  it("re-emits ordinary server EventService events as local shell events", () => {
    const { handle, eventService } = createHarness();

    handle("notification:show", { id: "n1", type: "info", title: "Hello" });

    expect(eventService.emit).toHaveBeenCalledWith("notification:show", {
      id: "n1",
      type: "info",
      title: "Hello",
    });
  });

  it("projects notification actions to their desktop implementation", async () => {
    const onNotificationAction = vi.fn(async () => undefined);
    const { handle, eventService } = createHarness({ onNotificationAction });

    handle("notification:action", { id: "update", actionId: "desktop-update-download" });

    await vi.waitFor(() =>
      expect(onNotificationAction).toHaveBeenCalledWith("update", "desktop-update-download")
    );
    expect(eventService.emit).toHaveBeenCalledWith("notification:action", {
      id: "update",
      actionId: "desktop-update-download",
    });
  });

  it("applies server panel tree snapshots without reloading the tree", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const snapshot = { revision: 2, rootPanels: [] };

    handle("panel-tree-updated", snapshot);
    await Promise.resolve();

    expect(panelOrchestrator.applyServerPanelTreeSnapshot).toHaveBeenCalledWith(snapshot);
    expect(panelOrchestrator.recoverShellSnapshot).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("applies server panel title updates without forwarding raw events", () => {
    const { handle, eventService, panelOrchestrator } = createHarness();

    handle("panel-title-updated", {
      panelId: "panel:tree/panel-1",
      title: "New title",
      explicit: true,
    });

    expect(panelOrchestrator.applyServerPanelTitleUpdate).toHaveBeenCalledWith({
      panelId: "panel:tree/panel-1",
      title: "New title",
      explicit: true,
    });
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("rejects browser-panel open events instead of proxying panel creation", async () => {
    const { handle, eventService, warn } = createHarness();

    handle("browser-panel:open", {
      url: "https://example.com/",
      parentPanelId: "panel:tree/slot-a",
    });
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "[browserPanel] Ignoring browser-panel:open; panel creation must go through authenticated panelTree RPC"
    );
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("applies app availability locally and still forwards the app event to shell UI", async () => {
    const { handle, eventService, appOrchestrator, onAppHostTargetChanged } = createHarness();
    const payload = {
      appId: "@workspace-apps/shell",
      target: "electron",
      url: "http://127.0.0.1/_a/app/index.html",
      adoptionPolicy: "prompt",
    };

    handle("apps:available", payload);
    await Promise.resolve();

    expect(appOrchestrator.applyAppAvailable).toHaveBeenCalledWith(payload);
    expect(onAppHostTargetChanged).toHaveBeenCalledWith({ event: "apps:available", payload });
    expect(eventService.emit).toHaveBeenCalledWith("apps:available", payload);
  });

  it("normalizes app availability before local apply, host sync, and shell emit", async () => {
    const resolvedPayload = {
      appId: "@workspace-apps/shell",
      target: "electron",
      artifactRoute: "/_a/app/index.html",
      url: "http://127.0.0.1:39479/_a/app/index.html",
      adoptionPolicy: "prompt",
    };
    const { handle, eventService, appOrchestrator, onAppHostTargetChanged } = createHarness({
      resolveAppAvailableEvent: () => resolvedPayload,
    });
    const payload = {
      appId: "@workspace-apps/shell",
      target: "electron",
      artifactRoute: "/_a/app/index.html",
      adoptionPolicy: "prompt",
    };

    handle("apps:available", payload);
    await Promise.resolve();

    expect(appOrchestrator.applyAppAvailable).toHaveBeenCalledWith(resolvedPayload);
    expect(onAppHostTargetChanged).toHaveBeenCalledWith({
      event: "apps:available",
      payload: resolvedPayload,
    });
    expect(eventService.emit).toHaveBeenCalledWith("apps:available", resolvedPayload);
  });

  it("drops app availability rejected by the local resolver", async () => {
    const { handle, eventService, appOrchestrator, onAppHostTargetChanged } = createHarness({
      resolveAppAvailableEvent: () => null,
    });

    handle("apps:available", {
      appId: "@workspace-apps/shell",
      target: "electron",
      url: "https://old.example/_a/app/index.html",
    });
    await Promise.resolve();

    expect(appOrchestrator.applyAppAvailable).not.toHaveBeenCalled();
    expect(onAppHostTargetChanged).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("only wakes desktop host sync for host-target changes that can affect Electron", () => {
    const { handle, onAppHostTargetChanged } = createHarness();

    handle("host-targets:changed", { target: "react-native", reason: "app-status" });
    expect(onAppHostTargetChanged).not.toHaveBeenCalled();

    const payload = { target: "electron", reason: "selection-changed" };
    handle("host-targets:changed", payload);

    expect(onAppHostTargetChanged).toHaveBeenCalledWith({
      event: "host-targets:changed",
      payload,
    });
  });
});

describe("notificationAttention", () => {
  it("recognizes chat attention for watched and direct delivery without changing transport", () => {
    expect(
      notificationAttention("notification:show", {
        id: "chat-attention:channel:one",
        title: "Agent replied",
        message: "The task needs you.",
      })
    ).toEqual({ title: "Agent replied", message: "The task needs you." });
    expect(
      notificationAttention("notification:show", { id: "ordinary", title: "Saved" })
    ).toBeNull();
    expect(notificationAttention("notification:dismiss", { id: "chat-attention:x" })).toBeNull();
  });
});
