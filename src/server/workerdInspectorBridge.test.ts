import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerdInspectorBridge } from "./workerdInspectorBridge.js";
import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";

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
});
