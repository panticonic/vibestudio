import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CdpHostProvider, type CdpHostProviderSocket } from "./cdpHostProvider.js";

class FakeSocket extends EventEmitter implements CdpHostProviderSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function createHarness(serverUrl = "ws://127.0.0.1:1234") {
  const socket = new FakeSocket();
  const openDevTools = vi.fn();
  let socketUrl = "";
  const sendCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (method: unknown) =>
    method === "Accessibility.getFullAXTree" ? { nodes: [{ nodeId: 1 }] } : { ok: true }
  );
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand,
  });
  const contents = {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    stop: vi.fn(),
    debugger: debuggerApi,
  };
  const provider = new CdpHostProvider({
    serverUrl,
    authToken: "token",
    hostConnectionId: "host-a",
    getViewManager: () =>
      ({
        getWebContents: vi.fn(() => contents),
        openDevTools,
      }) as never,
    socketFactory: (url) => {
      socketUrl = url;
      return socket;
    },
  });
  return {
    provider,
    socket,
    contents,
    debuggerApi,
    openDevTools,
    getSocketUrl: () => socketUrl,
  };
}

describe("CdpHostProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("authenticates and registers targets after broker auth", () => {
    const { provider, socket } = createHarness();

    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "natstack:cdp-auth", token: "token" },
      { type: "cdp:register", targetId: "panel-1", tabId: 42 },
    ]);
  });

  it("connects to the WebSocket form of the gateway URL", () => {
    const { provider, socket, getSocketUrl } = createHarness();

    provider.start();
    socket.emit("open");

    expect(getSocketUrl()).toBe("ws://127.0.0.1:1234/api/cdp-host?hostConnectionId=host-a");
  });

  it("uses wss for an https gateway URL", () => {
    const { provider, socket, getSocketUrl } = createHarness("https://server.example:443");

    provider.start();
    socket.emit("open");

    expect(getSocketUrl()).toBe("wss://server.example/api/cdp-host?hostConnectionId=host-a");
  });

  it("forwards broker CDP commands to webContents.debugger", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
      params: { expression: "2 + 2" },
    });

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "2 + 2" },
      undefined
    );
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "cdp:result",
      targetId: "panel-1",
      requestId: "r1",
      result: { ok: true },
    });
  });

  it("forwards screenshot capture through the same serialized debugger command path", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    debuggerApi.sendCommand.mockImplementationOnce(async () => ({ data: "base64-png" }));
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "s1",
      method: "Page.captureScreenshot",
      params: { format: "png" },
    });

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      { format: "png" },
      undefined
    );
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "cdp:result",
      targetId: "panel-1",
      requestId: "s1",
      result: { data: "base64-png" },
    });
  });

  it("does not mark targets attached when debugger attach fails unexpectedly", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));
    debuggerApi.attach.mockImplementationOnce(() => {
      throw new Error("debugger backend unavailable");
    });

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });

    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "cdp:error",
      targetId: "panel-1",
      requestId: "r1",
      error: "debugger backend unavailable",
    });

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r2",
      method: "Runtime.evaluate",
    });

    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "cdp:result",
      targetId: "panel-1",
      requestId: "r2",
      result: { ok: true },
    });
  });

  it("supports host-side accessibility snapshots with debugger cleanup", async () => {
    const { provider, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);

    await expect(provider.getAccessibilityTree("panel-1")).resolves.toEqual([{ nodeId: 1 }]);

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      undefined,
      undefined
    );
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("keeps the debugger attached when host-side accessibility runs during active CDP", async () => {
    const { provider, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });
    await expect(provider.getAccessibilityTree("panel-1")).resolves.toEqual([{ nodeId: 1 }]);

    expect(debuggerApi.detach).not.toHaveBeenCalled();

    await provider.handleProviderMessageForTest({ type: "cdp:detach", targetId: "panel-1" });

    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("detaches on broker detach", async () => {
    const { provider, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });
    await provider.handleProviderMessageForTest({ type: "cdp:detach", targetId: "panel-1" });

    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("removes debugger event forwarding when detached", async () => {
    const { provider, debuggerApi, socket } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });
    await provider.handleProviderMessageForTest({ type: "cdp:detach", targetId: "panel-1" });
    debuggerApi.emit("message", {}, "Runtime.consoleAPICalled", {});

    expect(socket.sent.map((entry) => JSON.parse(entry))).not.toContainEqual({
      type: "cdp:event",
      targetId: "panel-1",
      method: "Runtime.consoleAPICalled",
      params: {},
    });
  });

  it("forgets unknown-panel registration rejections so stale targets are not re-advertised", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });
    await provider.handleProviderMessageForTest({
      type: "cdp:register-rejected",
      targetId: "panel-1",
      reason: "unknown_panel",
    });

    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);

    socket.sent = [];
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([]);
  });

  it("keeps lease-rejected registrations so live targets can be advertised again", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel-1",
      requestId: "r1",
      method: "Runtime.evaluate",
    });
    await provider.handleProviderMessageForTest({
      type: "cdp:register-rejected",
      targetId: "panel-1",
      reason: "lease_mismatch",
    });

    expect(debuggerApi.detach).not.toHaveBeenCalled();

    socket.sent = [];
    socket.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "cdp:register", targetId: "panel-1", tabId: 42 },
    ]);
  });

  it("runs built-in host commands and returns broker results", async () => {
    const { provider, socket, openDevTools } = createHarness();
    provider.start();
    socket.emit("open");

    await provider.handleProviderMessageForTest({
      type: "host:command",
      targetId: "panel-1",
      requestId: "h1",
      action: "openDevTools",
      args: ["bottom"],
    });

    expect(openDevTools).toHaveBeenCalledWith("panel-1", "bottom");
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "host:result",
      targetId: "panel-1",
      requestId: "h1",
      result: null,
    });
  });

  it("serves accessibility trees as a built-in host command", async () => {
    const { provider, socket, debuggerApi } = createHarness();
    provider.registerTarget("panel-1", 42);
    provider.start();
    socket.emit("open");

    await provider.handleProviderMessageForTest({
      type: "host:command",
      targetId: "panel-1",
      requestId: "h2",
      action: "accessibilityTree",
      args: [],
    });

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      undefined,
      undefined
    );
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "host:result",
      targetId: "panel-1",
      requestId: "h2",
      result: [{ nodeId: 1 }],
    });
  });

  it("runs broker navigation commands against the target webContents", async () => {
    const { provider, socket, contents } = createHarness();
    provider.start();
    socket.emit("open");

    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n1",
      action: "navigate",
      url: "https://example.com",
    });
    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n2",
      action: "reload",
    });
    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n3",
      action: "goBack",
    });
    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n4",
      action: "goForward",
    });
    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n5",
      action: "stop",
    });

    expect(contents.loadURL).toHaveBeenCalledWith("https://example.com");
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(contents.goBack).toHaveBeenCalledTimes(1);
    expect(contents.goForward).toHaveBeenCalledTimes(1);
    expect(contents.stop).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual(
      expect.arrayContaining([
        { type: "nav:result", targetId: "panel-1", requestId: "n1" },
        { type: "nav:result", targetId: "panel-1", requestId: "n2" },
        { type: "nav:result", targetId: "panel-1", requestId: "n3" },
        { type: "nav:result", targetId: "panel-1", requestId: "n4" },
        { type: "nav:result", targetId: "panel-1", requestId: "n5" },
      ])
    );
  });

  it("treats superseded Electron navigations as successful broker navigation commands", async () => {
    const { provider, socket, contents } = createHarness();
    contents.loadURL.mockRejectedValueOnce(
      Object.assign(new Error("ERR_ABORTED"), { code: "ERR_ABORTED" })
    );
    provider.start();
    socket.emit("open");

    await provider.handleProviderMessageForTest({
      type: "nav:command",
      targetId: "panel-1",
      requestId: "n-abort",
      action: "navigate",
      url: "https://example.com/next",
    });

    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "nav:result",
      targetId: "panel-1",
      requestId: "n-abort",
    });
    expect(socket.sent.map((entry) => JSON.parse(entry))).not.toContainEqual(
      expect.objectContaining({
        type: "nav:error",
        requestId: "n-abort",
      })
    );
  });

  it("delegates custom host commands for orchestrator-backed operations", async () => {
    const socket = new FakeSocket();
    const onHostCommand = vi.fn(async () => ({ rebuilt: true }));
    const provider = new CdpHostProvider({
      serverUrl: "ws://127.0.0.1:1234",
      authToken: "token",
      hostConnectionId: "host-a",
      getViewManager: () => null,
      onHostCommand,
      socketFactory: () => socket,
    });
    provider.start();
    socket.emit("open");

    await provider.handleProviderMessageForTest({
      type: "host:command",
      targetId: "panel-1",
      requestId: "h2",
      action: "rebuildPanel",
      args: [],
    });

    expect(onHostCommand).toHaveBeenCalledWith("panel-1", "rebuildPanel", []);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "host:result",
      targetId: "panel-1",
      requestId: "h2",
      result: { rebuilt: true },
    });
  });

  it("reconnects after the broker socket closes and re-registers held targets", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const provider = new CdpHostProvider({
      serverUrl: "ws://127.0.0.1:1234",
      authToken: "token",
      hostConnectionId: "host-a",
      getViewManager: () => null,
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    provider.registerTarget("panel-1", 42);
    provider.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));
    sockets[0]!.close();

    await vi.advanceTimersByTimeAsync(25);
    expect(sockets).toHaveLength(2);

    sockets[1]!.emit("open");
    sockets[1]!.emit("message", JSON.stringify({ type: "natstack:cdp-auth-ok" }));

    expect(sockets[1]!.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "natstack:cdp-auth", token: "token" },
      { type: "cdp:register", targetId: "panel-1", tabId: 42 },
    ]);

    provider.stop();
  });

  it("does not reconnect after stop", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const provider = new CdpHostProvider({
      serverUrl: "ws://127.0.0.1:1234",
      authToken: "token",
      hostConnectionId: "host-a",
      getViewManager: () => null,
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    provider.start();
    provider.stop();

    await vi.advanceTimersByTimeAsync(25);

    expect(sockets).toHaveLength(1);
  });
});
