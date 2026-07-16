import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import type { BrowserShellBridgeGlobals } from "./browserShellBridge.js";

const mocks = vi.hoisted(() => ({
  createWsTransport: vi.fn(),
  send: vi.fn(),
  onMessage: vi.fn(),
  onRecovery: vi.fn(),
}));

vi.mock("../preload/wsTransport.js", () => ({
  createWsTransport: mocks.createWsTransport,
}));

const { installFallbackShellBridge } = await import("./browserShellBridge.js");

describe("installFallbackShellBridge", () => {
  beforeEach(() => {
    mocks.createWsTransport.mockReset();
    mocks.send.mockReset();
    mocks.onMessage.mockReset();
    mocks.onRecovery.mockReset();
  });

  it("installs a panel WebSocket-backed shell bridge when host injection is absent", async () => {
    mocks.createWsTransport.mockReturnValue({
      send: mocks.send,
      onMessage: mocks.onMessage,
      onRecovery: mocks.onRecovery,
    });
    const globals = {
      __vibestudioPanelInit: {
        entityId: "panel:nav-entry-a",
        slotId: "panel:tree/slot-a",
        gatewayConfig: {
          serverUrl: "http://127.0.0.1:4567/_workspace/test",
          token: "grant-token",
        },
        connectionId: "runtime-conn",
        clientLabel: "Headless",
      },
    } as BrowserShellBridgeGlobals;

    const shell = installFallbackShellBridge(globals);

    expect(mocks.createWsTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: "panel:nav-entry-a",
        wsUrl: "ws://127.0.0.1:4567/_workspace/test/rpc",
        authToken: "grant-token",
        connectionId: "runtime-conn",
        clientLabel: "Headless",
        reconnect: false,
      })
    );
    expect(globals.__vibestudioShell).toBe(shell);

    const envelope = {
      from: "panel:nav-entry-a",
      target: "main",
      delivery: { caller: { callerId: "panel:nav-entry-a", callerKind: "panel" } },
      provenance: [{ callerId: "panel:nav-entry-a", callerKind: "panel" }],
      message: { type: "event", fromId: "panel:nav-entry-a", event: "x", payload: null },
    } satisfies RpcEnvelope;
    await shell?.postEnvelope?.(envelope);
    expect(mocks.send).toHaveBeenCalledWith(envelope);
    expect(await shell?.getPanelInit?.()).toMatchObject({
      entityId: "panel:nav-entry-a",
      slotId: "panel:tree/slot-a",
      connectionId: "runtime-conn",
    });
  });

  it("exposes runtime host helpers over the same panel RPC session", async () => {
    const handlers = new Set<(envelope: RpcEnvelope) => void>();
    mocks.onMessage.mockImplementation((handler: (envelope: RpcEnvelope) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    });
    mocks.send.mockImplementation(async (envelope: RpcEnvelope) => {
      if (envelope.message.type !== "request") return;
      const request = envelope.message;
      const method = request.method;
      const result =
        method === "panelTree.metadata"
          ? { id: "panel:tree/slot-a", title: "Slot A" }
          : { panelId: "panel:tree/slot-b", status: "focused" };
      queueMicrotask(() => {
        for (const handler of handlers) {
          handler({
            from: "main",
            target: envelope.from,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: {
              type: "response",
              requestId: request.requestId,
              result,
            },
          });
        }
      });
    });
    mocks.createWsTransport.mockReturnValue({
      send: mocks.send,
      onMessage: mocks.onMessage,
      onRecovery: mocks.onRecovery,
    });
    const shell = installFallbackShellBridge({
      __vibestudioPanelInit: {
        entityId: "panel:nav-entry-a",
        slotId: "panel:tree/slot-a",
        gatewayConfig: { serverUrl: "http://127.0.0.1:4567", token: "grant-token" },
        connectionId: "runtime-conn",
      },
    } as BrowserShellBridgeGlobals);

    await expect(shell?.getInfo?.()).resolves.toEqual({
      id: "panel:tree/slot-a",
      title: "Slot A",
    });
    await expect(shell?.focusPanel?.("panel:tree/slot-b")).resolves.toEqual({
      panelId: "panel:tree/slot-b",
      status: "focused",
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "main",
        message: expect.objectContaining({ method: "panelTree.metadata" }),
      })
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "main",
        message: expect.objectContaining({
          method: "panelTree.focus",
          args: ["panel:tree/slot-b"],
        }),
      })
    );
  });

  it("dispatches host events through addEventListener/removeEventListener", () => {
    let handler: ((envelope: RpcEnvelope) => void) | undefined;
    mocks.onMessage.mockImplementation((next: (envelope: RpcEnvelope) => void) => {
      handler = next;
      return () => undefined;
    });
    mocks.createWsTransport.mockReturnValue({
      send: mocks.send,
      onMessage: mocks.onMessage,
      onRecovery: mocks.onRecovery,
    });
    const shell = installFallbackShellBridge({
      __vibestudioPanelInit: {
        entityId: "panel:nav-entry-a",
        slotId: "panel:tree/slot-a",
        gatewayConfig: { serverUrl: "http://127.0.0.1:4567", token: "grant-token" },
        connectionId: "runtime-conn",
      },
    } as BrowserShellBridgeGlobals);
    const listener = vi.fn();

    const id = shell?.addEventListener?.(listener);
    handler?.({
      from: "main",
      target: "panel:nav-entry-a",
      delivery: { caller: { callerId: "main", callerKind: "server" } },
      provenance: [{ callerId: "main", callerKind: "server" }],
      message: { type: "event", fromId: "main", event: "runtime:focus", payload: null },
    });
    if (id !== undefined) shell?.removeEventListener?.(id);
    handler?.({
      from: "main",
      target: "panel:nav-entry-a",
      delivery: { caller: { callerId: "main", callerKind: "server" } },
      provenance: [{ callerId: "main", callerKind: "server" }],
      message: { type: "event", fromId: "main", event: "runtime:focus", payload: null },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("runtime:focus", null);
  });

  it("leaves an existing complete host bridge in place", () => {
    const existing = {
      postEnvelope: vi.fn(),
      onEnvelope: vi.fn(),
    };
    const globals = { __vibestudioShell: existing } as unknown as BrowserShellBridgeGlobals;

    expect(installFallbackShellBridge(globals)).toBe(existing);
    expect(mocks.createWsTransport).not.toHaveBeenCalled();
  });

  it("does not install a fallback bridge without a runtime lease connection id", () => {
    const globals = {
      __vibestudioPanelInit: {
        entityId: "panel:nav-entry-a",
        slotId: "panel:tree/slot-a",
        gatewayConfig: { serverUrl: "http://127.0.0.1:4567", token: "grant-token" },
      },
    } as BrowserShellBridgeGlobals;

    expect(installFallbackShellBridge(globals)).toBeUndefined();
    expect(globals.__vibestudioShell).toBeUndefined();
    expect(mocks.createWsTransport).not.toHaveBeenCalled();
  });
});
