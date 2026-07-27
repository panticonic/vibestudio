import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CdpHostBridgeClient,
  type CdpHostBridgeSocket,
  type HostBridgeHandlers,
} from "./hostBridge.js";
import {
  parseWebSocketAuthProtocol,
  webSocketAuthProtocol,
} from "@vibestudio/rpc/protocol/webSocketAuthProtocol";

/** Minimal fake of the server's cdpBridge /api/cdp-host endpoint. */
class FakeBridgeServer {
  readonly wss: WebSocketServer;
  socket: WebSocket | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  authToken = "good-token";
  private waiters: Array<(message: Record<string, unknown>) => void> = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({
      port,
      path: undefined,
      verifyClient: ({ req }) =>
        parseWebSocketAuthProtocol(req.headers["sec-websocket-protocol"], "cdp-host") ===
        this.authToken,
    });
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.received.push(message);
      });
    });
  }

  next(): Promise<Record<string, unknown>> {
    const pending = this.received.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

function handlers(overrides: Partial<HostBridgeHandlers> = {}): HostBridgeHandlers {
  return {
    cdpCommand: vi.fn(async () => ({ ok: true })),
    navCommand: vi.fn(async () => undefined),
    hostCommand: vi.fn(async () => ({ nodes: [] })),
    detach: vi.fn(async () => undefined),
    registerRejected: vi.fn(),
    ...overrides,
  };
}

class FakeBridgeSocket extends EventEmitter implements CdpHostBridgeSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(message: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(message));
  }
}

describe("CdpHostBridgeClient", () => {
  let server: FakeBridgeServer;
  let client: CdpHostBridgeClient | null = null;
  let port: number;

  beforeEach(async () => {
    server = new FakeBridgeServer(0);
    await new Promise<void>((resolve) => server.wss.once("listening", () => resolve()));
    port = (server.wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    await server.close();
  });

  function startClient(h: HostBridgeHandlers): Promise<void> {
    return new Promise((resolve) => {
      client = new CdpHostBridgeClient({
        serverUrl: `http://127.0.0.1:${port}`,
        hostConnectionId: "headless-test",
        getToken: () => "good-token",
        handlers: h,
        onAuthenticated: () => resolve(),
      });
      client.start();
    });
  }

  it("preserves selected workspace paths in the bridge URL", () => {
    client = new CdpHostBridgeClient({
      serverUrl: "https://server.example/_workspace/dev/",
      hostConnectionId: "headless test",
      getToken: () => "good-token",
      handlers: handlers(),
    });

    expect((client as unknown as { wsUrl(): string }).wsUrl()).toBe(
      "wss://server.example/_workspace/dev/api/cdp-host?hostConnectionId=headless+test"
    );
  });

  it("authenticates during upgrade and re-registers targets on reconnect", async () => {
    const h = handlers();
    await startClient(h);
    client!.registerTarget("panel-1", 7);
    const registered = await server.next();
    expect(registered).toEqual({ type: "cdp:register", targetId: "panel-1", tabId: 7 });

    // Force a reconnect: server closes the socket; client reconnects (1s),
    // re-auths and re-registers the known target automatically.
    server.socket?.close();
    const reRegistered = await server.next();
    expect(reRegistered).toEqual({ type: "cdp:register", targetId: "panel-1", tabId: 7 });
  }, 15_000);

  it("re-registers targets when an injected bridge socket reconnects", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeBridgeSocket[] = [];
      const protocols: string[][] = [];
      client = new CdpHostBridgeClient({
        serverUrl: "https://server.example/_workspace/dev",
        hostConnectionId: "headless-rpc",
        getToken: () => "good-token",
        handlers: handlers(),
        socketFactory: (_url, socketProtocols) => {
          protocols.push(socketProtocols);
          const socket = new FakeBridgeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      client.start();
      await Promise.resolve();
      sockets[0]?.open();
      expect(protocols[0]).toEqual([webSocketAuthProtocol("cdp-host", "good-token")]);
      client.registerTarget("panel-1", 7);
      expect(sockets[0]?.sent.at(-1)).toEqual({
        type: "cdp:register",
        targetId: "panel-1",
        tabId: 7,
      });

      sockets[0]?.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      sockets[1]?.open();

      expect(sockets[1]?.sent).toEqual([{ type: "cdp:register", targetId: "panel-1", tabId: 7 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits truthful credential, connection, admission, and retry phases", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeBridgeSocket[] = [];
      const diagnostics: Array<ReturnType<CdpHostBridgeClient["getDiagnostic"]>> = [];
      client = new CdpHostBridgeClient({
        serverUrl: "https://server.example/_workspace/dev",
        hostConnectionId: "headless-rpc",
        getToken: () => "good-token",
        handlers: handlers(),
        socketFactory: () => {
          const socket = new FakeBridgeSocket();
          sockets.push(socket);
          return socket;
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      client.start();
      expect(diagnostics.at(-1)).toMatchObject({
        state: "acquiring-credential",
        attempt: 1,
        url: "wss://server.example/_workspace/dev/api/cdp-host?hostConnectionId=headless-rpc",
      });

      await Promise.resolve();
      expect(diagnostics.at(-1)).toMatchObject({ state: "connecting", attempt: 1 });
      sockets[0]?.open();
      expect(diagnostics.at(-1)).toMatchObject({ state: "admitted", attempt: 1 });
      expect(diagnostics.at(-1)).not.toHaveProperty("authSent");
      expect(diagnostics.at(-1)).not.toHaveProperty("authenticated");

      sockets[0]?.close(4401, "Invalid CDP token");
      expect(diagnostics.at(-1)).toMatchObject({
        state: "retrying",
        lastCloseCode: 4401,
        lastCloseReason: "Invalid CDP token",
        nextRetryMs: 1_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes credential acquisition failure from connection failure", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: Array<ReturnType<CdpHostBridgeClient["getDiagnostic"]>> = [];
      client = new CdpHostBridgeClient({
        serverUrl: "https://server.example",
        hostConnectionId: "headless-rpc",
        getToken: async () => {
          throw new Error("credential store unavailable");
        },
        handlers: handlers(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      client.start();
      expect(diagnostics.at(-1)?.state).toBe("acquiring-credential");
      await Promise.resolve();
      expect(diagnostics.map((diagnostic) => diagnostic.state)).toEqual([
        "acquiring-credential",
        "error",
        "retrying",
      ]);
      expect(diagnostics.at(-1)).toMatchObject({
        state: "retrying",
        lastError: "failed to get token: credential store unavailable",
        nextRetryMs: 1_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays cdp:command to the handler and returns cdp:result", async () => {
    const h = handlers({
      cdpCommand: vi.fn(async (_t, method) => ({ echoed: method })),
    });
    await startClient(h);
    server.send({
      type: "cdp:command",
      requestId: "r1",
      targetId: "panel-1",
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      sessionId: "s9",
    });
    const result = await server.next();
    expect(result).toEqual({
      type: "cdp:result",
      requestId: "r1",
      targetId: "panel-1",
      result: { echoed: "Runtime.evaluate" },
    });
    expect(h.cdpCommand).toHaveBeenCalledWith(
      "panel-1",
      "Runtime.evaluate",
      { expression: "1+1" },
      "s9"
    );
  });

  it("maps handler failures to cdp:error / nav:error / host:error", async () => {
    const h = handlers({
      cdpCommand: vi.fn(async () => {
        throw new Error("boom");
      }),
      navCommand: vi.fn(async () => {
        throw new Error("nav-fail");
      }),
    });
    await startClient(h);
    server.send({ type: "cdp:command", requestId: "r1", targetId: "p", method: "X" });
    expect(await server.next()).toMatchObject({
      type: "cdp:error",
      requestId: "r1",
      error: "boom",
    });
    server.send({ type: "nav:command", requestId: "r2", targetId: "p", action: "reload" });
    expect(await server.next()).toMatchObject({
      type: "nav:error",
      requestId: "r2",
      error: "nav-fail",
    });
  });

  it("handles host:command, cdp:detach and register rejection", async () => {
    const h = handlers();
    await startClient(h);
    client!.registerTarget("panel-1", 1);
    await server.next(); // consume register

    server.send({
      type: "host:command",
      requestId: "r3",
      targetId: "panel-1",
      action: "accessibilityTree",
      args: [],
    });
    expect(await server.next()).toMatchObject({ type: "host:result", requestId: "r3" });
    expect(h.hostCommand).toHaveBeenCalledWith("panel-1", "accessibilityTree", []);

    server.send({ type: "cdp:detach", targetId: "panel-1" });
    server.send({ type: "cdp:register-rejected", targetId: "panel-1", reason: "lease_mismatch" });
    // Round-trip another message so the detach/rejection have been processed.
    server.send({ type: "host:command", requestId: "r4", targetId: "x", action: "noop", args: [] });
    await server.next();
    expect(h.detach).toHaveBeenCalledWith("panel-1");
    expect(h.registerRejected).toHaveBeenCalledWith("panel-1", "lease_mismatch");
  });

  it("forwards cdp:event with optional sessionId", async () => {
    const h = handlers();
    await startClient(h);
    client!.sendEvent("panel-1", "Runtime.consoleAPICalled", { type: "log" });
    expect(await server.next()).toEqual({
      type: "cdp:event",
      targetId: "panel-1",
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });
    client!.sendEvent("panel-1", "Target.attachedToTarget", {}, "child-session");
    expect(await server.next()).toMatchObject({ sessionId: "child-session" });
  });
});
