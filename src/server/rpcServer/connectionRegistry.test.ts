import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { createVerifiedCaller, type CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { WebSocket } from "ws";
import type { WsServerTransportInternal } from "../wsServerTransport.js";
import { ConnectionRegistry, type WsClientState } from "./connectionRegistry.js";

function createSocket(readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    close: vi.fn(),
  } as unknown as WebSocket;
}

function createClient(options: {
  callerId: string;
  connectionId: string;
  userId: string;
  authenticatedAt: number;
  callerKind?: CallerKind;
  ws?: WebSocket;
}): WsClientState {
  return {
    ws: options.ws ?? createSocket(),
    caller: createVerifiedCaller(options.callerId, options.callerKind ?? "panel"),
    connectionId: options.connectionId,
    authenticated: true,
    authenticatedAt: options.authenticatedAt,
    userId: options.userId,
  };
}

function createRegistry(onError = vi.fn()): ConnectionRegistry {
  return new ConnectionRegistry({ onConnectionsChangedListenerError: onError });
}

describe("ConnectionRegistry", () => {
  it("keeps socket, caller, user, and primary-connection indexes coherent", () => {
    const registry = createRegistry();
    const changed = vi.fn();
    registry.onConnectionsChanged(changed);
    const later = createClient({
      callerId: "panel-a",
      connectionId: "conn-b",
      userId: "user-a",
      authenticatedAt: 20,
    });
    const earlier = createClient({
      callerId: "panel-a",
      connectionId: "conn-a",
      userId: "user-a",
      authenticatedAt: 10,
    });

    registry.addClient(later);
    registry.addClient(earlier);

    expect(registry.getBySocket(later.ws)).toBe(later);
    expect(registry.getConnection("panel-a", "conn-a")).toBe(earlier);
    expect(registry.pickPrimary("panel-a")).toBe(earlier);
    expect(registry.getUserConnections("user-a")).toEqual([later, earlier]);
    expect(registry.listUsersWithLiveConnections()).toEqual(["user-a"]);
    expect(changed).toHaveBeenCalledTimes(2);

    (earlier.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
    expect(registry.getConnection("panel-a", "conn-a")).toBeUndefined();
    expect(registry.pickPrimary("panel-a")).toBe(later);
  });

  it("atomically replaces a reused connection id and closes its bridge transport", () => {
    const registry = createRegistry();
    const oldClient = createClient({
      callerId: "panel-a",
      connectionId: "conn-a",
      userId: "user-old",
      authenticatedAt: 1,
    });
    const replacement = createClient({
      callerId: "panel-a",
      connectionId: "conn-a",
      userId: "user-new",
      authenticatedAt: 2,
    });
    const transport = { close: vi.fn() } as unknown as WsServerTransportInternal;
    const bridge = {} as RpcClient;
    registry.addClient(oldClient);
    registry.setBridge("panel-a", "conn-a", bridge, transport);

    registry.addClient(replacement);

    expect(transport.close).toHaveBeenCalledOnce();
    expect(registry.getBySocket(oldClient.ws)).toBeUndefined();
    expect(registry.getConnection("panel-a", "conn-a")).toBe(replacement);
    expect(registry.getBridge("panel-a", "conn-a")).toBeUndefined();
    expect(registry.isUserOnline("user-old")).toBe(false);
    expect(registry.isUserOnline("user-new")).toBe(true);
    expect(registry.removeClient(oldClient)).toBe(false);
    expect(registry.getConnection("panel-a", "conn-a")).toBe(replacement);
  });

  it("isolates connection-change listener failures and reports them through the injected sink", () => {
    const onError = vi.fn();
    const registry = createRegistry(onError);
    const failure = new Error("listener failed");
    const healthyListener = vi.fn();
    registry.onConnectionsChanged(() => {
      throw failure;
    });
    registry.onConnectionsChanged(healthyListener);

    registry.notifyConnectionsChanged();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(healthyListener).toHaveBeenCalledOnce();
  });

  it("closes every bridge and socket and clears all indexes", () => {
    const registry = createRegistry();
    const panel = createClient({
      callerId: "panel-a",
      connectionId: "panel-conn",
      userId: "user-a",
      authenticatedAt: 1,
    });
    const shell = createClient({
      callerId: "shell-a",
      connectionId: "shell-conn",
      userId: "user-a",
      authenticatedAt: 2,
      callerKind: "shell",
    });
    const panelTransport = { close: vi.fn() } as unknown as WsServerTransportInternal;
    const shellTransport = { close: vi.fn() } as unknown as WsServerTransportInternal;
    registry.addClient(panel);
    registry.addClient(shell);
    registry.setBridge("panel-a", "panel-conn", {} as RpcClient, panelTransport);
    registry.setBridge("shell-a", "shell-conn", {} as RpcClient, shellTransport);

    registry.closeAll(1012, "server restarting");

    expect(panelTransport.close).toHaveBeenCalledOnce();
    expect(shellTransport.close).toHaveBeenCalledOnce();
    expect(panel.ws.close).toHaveBeenCalledWith(1012, "server restarting");
    expect(shell.ws.close).toHaveBeenCalledWith(1012, "server restarting");
    expect(registry.getCallerConnections("panel-a")).toEqual([]);
    expect(registry.listUsersWithLiveConnections()).toEqual([]);
    expect(registry.getBridge("shell-a", "shell-conn")).toBeUndefined();
  });
});
