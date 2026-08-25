import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  WORKERD_INSPECTOR_PENDING_COMMAND_MAX_BYTES,
  WorkerdInspectorBridge,
} from "./workerdInspectorBridge.js";
import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";

class FakeInspectorSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  send(data: string): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
}

describe("WorkerdInspectorBridge", () => {
  let bridge: WorkerdInspectorBridge | null = null;

  afterEach(() => {
    bridge?.stop();
    bridge = null;
    vi.restoreAllMocks();
  });

  it("returns no targets and no endpoint when the inspector is disabled", async () => {
    bridge = new WorkerdInspectorBridge({ getInspectorUrl: () => null, port: 4100 });
    expect(await bridge.listTargets()).toEqual([]);
    expect(bridge.getEndpoint("core:user:worker-host", "panel:x")).toBeNull();
  });

  it("lists targets from /json/list, deriving target paths from debugger URLs", async () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "core:user:worker-host",
            title: "worker-host",
            type: "node",
            webSocketDebuggerUrl: "ws://127.0.0.1:9229/core:user:worker-host",
          },
          { title: "no-path" },
        ])
      )
    );
    const targets = await bridge.listTargets();
    expect(targets).toEqual([
      {
        id: "core:user:worker-host",
        title: "worker-host",
        type: "node",
        targetPath: "core:user:worker-host",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:9229/json/list");
  });

  it("mints endpoints on the external host with encoded target paths", () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      protocol: "https",
      externalHost: "vibestudio.local",
      port: 4100,
    });
    const endpoint = bridge.getEndpoint("core:user/worker host", "panel:x");
    expect(endpoint?.wsEndpoint).toBe(
      "wss://vibestudio.local:4100/workerd-inspector/core%3Auser%2Fworker%20host"
    );
    expect(endpoint?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an invalid credential before allocating a WebSocket receiver", () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
    });
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const wss = { handleUpgrade: vi.fn() };

    bridge.handleUpgrade(
      {
        url: "/workerd-inspector/core%3Auser%3Aworker-host",
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("inspection", "invalid"),
        },
      } as never,
      socket as never,
      Buffer.alloc(0),
      wss as never
    );

    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"
    );
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("redeems a valid grant before handing the upgrade to ws", () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
    });
    const endpoint = bridge.getEndpoint("core:user:worker-host", "panel:x");
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const wss = { handleUpgrade: vi.fn() };

    bridge.handleUpgrade(
      {
        url: "/workerd-inspector/core%3Auser%3Aworker-host",
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("inspection", endpoint?.token ?? ""),
        },
      } as never,
      socket as never,
      Buffer.alloc(0),
      wss as never
    );

    expect(wss.handleUpgrade).toHaveBeenCalledOnce();
    expect(socket.write).not.toHaveBeenCalled();
  });

  it("preserves commands sent while the upstream inspector socket is opening", () => {
    const client = new FakeInspectorSocket();
    client.readyState = WebSocket.OPEN;
    const upstream = new FakeInspectorSocket();
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
      createUpstreamSocket: (url) => {
        expect(url).toBe("ws://127.0.0.1:9229/core:user:worker-host");
        return upstream as never;
      },
    });
    const endpoint = bridge.getEndpoint("core:user:worker-host", "panel:x");
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const wss = {
      handleUpgrade: vi.fn((_req, _socket, _head, accept) => accept(client)),
    };

    bridge.handleUpgrade(
      {
        url: "/workerd-inspector/core%3Auser%3Aworker-host",
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("inspection", endpoint?.token ?? ""),
        },
      } as never,
      socket as never,
      Buffer.alloc(0),
      wss as never
    );

    client.emit("message", JSON.stringify({ id: 1, method: "Runtime.enable" }));
    expect(upstream.sent).toEqual([]);

    upstream.open();
    expect(upstream.sent).toEqual([JSON.stringify({ id: 1, method: "Runtime.enable" })]);
  });

  it("closes a client that exceeds the bounded pre-ready command queue", () => {
    const client = new FakeInspectorSocket();
    client.readyState = WebSocket.OPEN;
    const upstream = new FakeInspectorSocket();
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
      createUpstreamSocket: () => upstream as never,
    });
    const endpoint = bridge.getEndpoint("core:user:worker-host", "panel:x");
    const wss = {
      handleUpgrade: vi.fn((_req, _socket, _head, accept) => accept(client)),
    };

    bridge.handleUpgrade(
      {
        url: "/workerd-inspector/core%3Auser%3Aworker-host",
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("inspection", endpoint?.token ?? ""),
        },
      } as never,
      { write: vi.fn(), destroy: vi.fn() } as never,
      Buffer.alloc(0),
      wss as never
    );
    client.emit("message", "x".repeat(WORKERD_INSPECTOR_PENDING_COMMAND_MAX_BYTES + 1));

    expect(client.close).toHaveBeenCalledWith(
      1009,
      "Inspector command queue exceeded readiness limit"
    );
    expect(upstream.terminate).toHaveBeenCalledOnce();
  });

  it("severs an open upstream inspector socket when its workerd generation closes", () => {
    const client = new FakeInspectorSocket();
    client.readyState = WebSocket.OPEN;
    const upstream = new FakeInspectorSocket();
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
      createUpstreamSocket: () => upstream as never,
    });
    const endpoint = bridge.getEndpoint("core:user:worker-host", "panel:x");
    const wss = {
      handleUpgrade: vi.fn((_req, _socket, _head, accept) => accept(client)),
    };
    bridge.handleUpgrade(
      {
        url: "/workerd-inspector/core%3Auser%3Aworker-host",
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("inspection", endpoint?.token ?? ""),
        },
      } as never,
      { write: vi.fn(), destroy: vi.fn() } as never,
      Buffer.alloc(0),
      wss as never
    );
    upstream.open();

    bridge.closeAll();

    expect(client.close).toHaveBeenCalledWith(1012, "workerd restarting");
    expect(upstream.terminate).toHaveBeenCalledOnce();
    expect(upstream.close).not.toHaveBeenCalled();
  });
});
