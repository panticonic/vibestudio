import { describe, expect, it, vi } from "vitest";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import {
  bindHostDirectServerEvents,
  createServerEventBridge,
  notificationAttention,
} from "./serverEventBridge.js";

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
    applyPanelExecutionActivated: vi.fn(async () => {}),
    applyServerPanelStateArgsUpdate: vi.fn(),
    applyServerPanelTitleUpdate: vi.fn(),
    recoverShellSnapshot: vi.fn(async () => undefined),
    createBrowserUrlPanel: vi.fn(async () => ({ panelId: "panel:tree/browser" })),
  };
  const appOrchestrator = {
    applyAppAvailable: vi.fn(async () => {}),
  };
  const serverClient = {
    call: vi.fn(async (_service: string, _method: string, _args: unknown[]) => undefined),
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
  it("binds host-owned OAuth handoffs on the direct server event channel", () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const releases = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const client = {
      onDirectEvent: vi.fn((event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, listener);
        return releases[listeners.size - 1]!;
      }),
    };
    const handle = vi.fn();

    const release = bindHostDirectServerEvents(client as never, handle);
    listeners.get("external-open:open")?.({ url: "https://auth.example.test" });
    listeners.get("browser-panel:open")?.({
      url: "https://auth.example.test",
      parentPanelId: "panel:tree/slot-a",
    });
    listeners.get("panel-created")?.({
      panelId: "panel:tree/slot-b",
      parentId: null,
      focus: true,
    });
    listeners.get("navigate-to-panel")?.({ panelId: "panel:tree/slot-a" });
    listeners.get("panel:executionActivated")?.({
      panelId: "panel:tree/slot-a",
      runtimeEntityId: "panel:entity/slot-a",
    });
    listeners.get("panel:stateArgsChanged")?.({
      panelId: "panel:tree/slot-a",
      stateArgs: { channelName: "chat-1234" },
    });

    expect(handle).toHaveBeenNthCalledWith(1, "external-open:open", {
      url: "https://auth.example.test",
    });
    expect(handle).toHaveBeenNthCalledWith(2, "browser-panel:open", {
      url: "https://auth.example.test",
      parentPanelId: "panel:tree/slot-a",
    });
    expect(handle).toHaveBeenNthCalledWith(3, "panel-created", {
      panelId: "panel:tree/slot-b",
      parentId: null,
      focus: true,
    });
    expect(handle).toHaveBeenNthCalledWith(4, "navigate-to-panel", {
      panelId: "panel:tree/slot-a",
    });
    expect(handle).toHaveBeenNthCalledWith(5, "panel:executionActivated", {
      panelId: "panel:tree/slot-a",
      runtimeEntityId: "panel:entity/slot-a",
    });
    expect(handle).toHaveBeenNthCalledWith(6, "panel:stateArgsChanged", {
      panelId: "panel:tree/slot-a",
      stateArgs: { channelName: "chat-1234" },
    });

    release();
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
    expect(releases[2]).toHaveBeenCalledOnce();
    expect(releases[3]).toHaveBeenCalledOnce();
    expect(releases[4]).toHaveBeenCalledOnce();
    expect(releases[5]).toHaveBeenCalledOnce();
  });

  it("converges an activated panel execution through its native host owner", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const activation = {
      panelId: "panel:tree/slot-a",
      runtimeEntityId: "panel:entity/slot-a",
      effectiveVersion: "sha256:effective",
      buildKey: "b".repeat(64),
      executionDigest: "e".repeat(64),
      authorityRequests: [],
    };

    handle("panel:executionActivated", activation);

    await vi.waitFor(() =>
      expect(panelOrchestrator.applyPanelExecutionActivated).toHaveBeenCalledWith(activation)
    );
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("converges durable state args through the presenting host projection", () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const update = {
      panelId: "panel:tree/slot-a",
      stateArgs: { channelName: "chat-1234" },
    };

    handle("panel:stateArgsChanged", update);

    expect(panelOrchestrator.applyServerPanelStateArgsUpdate).toHaveBeenCalledWith(update);
    expect(eventService.emit).not.toHaveBeenCalled();
  });

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

  it("forwards panel-tree invalidations without reconstructing the tree", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const snapshot = {
      revision: 2,
      reset: true,
      groups: [],
      changedSlotIds: [],
      removedSlotIds: [],
    };

    handle("panel-tree-invalidated", snapshot);
    await Promise.resolve();

    expect(panelOrchestrator.recoverShellSnapshot).not.toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledWith("panel-tree-invalidated", snapshot);
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

  it("opens OAuth browser panels through the native panel orchestrator", async () => {
    const { handle, eventService, panelOrchestrator, warn } = createHarness();

    handle("browser-panel:open", {
      url: "https://example.com/",
      parentPanelId: "panel:tree/slot-a",
      transactionId: "oauth-1",
    });
    await vi.waitFor(() =>
      expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
        "panel:tree/slot-a",
        "https://example.com/",
        { focus: true, placement: "child" }
      )
    );

    expect(warn).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("cancels OAuth when authenticated browser-panel creation fails", async () => {
    const { handle, panelOrchestrator, serverClient, warn } = createHarness();
    panelOrchestrator.createBrowserUrlPanel.mockRejectedValueOnce(
      new Error("panel host unavailable")
    );

    handle("browser-panel:open", {
      url: "https://example.com/",
      parentPanelId: "panel:tree/slot-a",
      transactionId: "oauth-1",
    });

    await vi.waitFor(() =>
      expect(serverClient.call).toHaveBeenCalledWith("credentials", "cancelOAuth", [
        { transactionId: "oauth-1" },
      ])
    );
    expect(warn).toHaveBeenCalledWith(
      "[browserPanel] OAuth panel creation failed: panel host unavailable"
    );
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
