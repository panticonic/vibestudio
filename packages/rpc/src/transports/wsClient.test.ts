import { wsClientTransport } from "./wsClient.js";
import type { WsLike } from "../protocol/wsAdapter.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";

class FakeSocket implements WsLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  authenticate(contractVersion: number = RPC_CONTRACT_VERSION): void {
    this.onmessage?.({
      data: JSON.stringify({
        success: true,
        type: "ws:auth-result",
        contractVersion,
      }),
    });
  }
}

function createTransportHarness() {
  const sockets: FakeSocket[] = [];
  const transport = wsClientTransport({
    adapter: {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      getAuthToken: async () => "token",
      now: () => Date.now(),
    },
    getWsUrl: () => "wss://server.example/rpc",
    selfId: "app:mobile:test",
  });
  return { sockets, transport };
}

describe("wsClientTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the default first-connect timeout", async () => {
    const { transport } = createTransportHarness();
    const promise = transport.connectAndWait();
    const assertion = expect(promise).rejects.toThrow(
      "Server WS connection timeout (10000ms): wss://server.example/rpc"
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
  });

  it("waits without a first-connect deadline when timeout is null", async () => {
    const { sockets, transport } = createTransportHarness();
    let settled = false;
    const promise = transport.connectAndWait(null).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
    sockets[0]?.open();
    sockets[0]?.authenticate();

    await expect(promise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("declares the RPC contract version in its authentication handshake", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();

    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: "ws:auth",
      contractVersion: RPC_CONTRACT_VERSION,
    });

    sockets[0]?.authenticate();
    await connected;
  });

  it("rejects a server with a mismatched RPC contract", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    const rejected = expect(connected).rejects.toThrow(
      `RPC contract mismatch: server ${RPC_CONTRACT_VERSION + 1} (want ${RPC_CONTRACT_VERSION})`
    );
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate(RPC_CONTRACT_VERSION + 1);

    await rejected;
    expect(transport.status?.()).toBe("disconnected");
  });

  it("does not reconnect after a terminal invalid-token close by default", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    sockets[0]?.close(4006, "Authentication failed");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
  });

  it("does not spin when auth refresh returns the rejected token", async () => {
    const sockets: FakeSocket[] = [];
    const refreshAuthToken = vi.fn(async () => "token");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = wsClientTransport({
      adapter: {
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        getAuthToken: async () => "token",
        refreshAuthToken,
        now: () => Date.now(),
      },
      getWsUrl: () => "wss://server.example/rpc",
      selfId: "panel:nav-test",
    });

    transport.connect();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:auth-result",
        success: false,
        error: "Invalid token",
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(transport.status?.()).toBe("disconnected");
    expect(warn).toHaveBeenCalledWith(
      "[wsClientTransport] Auth refresh failed:",
      expect.objectContaining({ message: "Auth refresh returned the rejected token" })
    );
    warn.mockRestore();
  });

  it("synthesizes a rejecting response envelope from ws:routed-response-error", async () => {
    const { sockets, transport } = createTransportHarness();
    const delivered: Array<{ from: string; message: unknown }> = [];
    transport.onMessage((envelope) => {
      delivered.push({ from: envelope.from, message: envelope.message });
    });

    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:routed-response-error",
        targetId: "do:notes:Bucket:key",
        requestId: "req-123",
        error: "Target not reachable: do:notes:Bucket:key",
        errorKind: "transport",
        errorCode: "TARGET_NOT_REACHABLE",
      }),
    });

    expect(delivered).toEqual([
      {
        from: "do:notes:Bucket:key",
        message: {
          type: "response",
          requestId: "req-123",
          error: "Target not reachable: do:notes:Bucket:key",
          errorKind: "transport",
          errorCode: "TARGET_NOT_REACHABLE",
        },
      },
    ]);
  });

  it("does not synthesize a response for ws:routed-event-error (logs only)", async () => {
    const { sockets, transport } = createTransportHarness();
    const delivered: unknown[] = [];
    transport.onMessage((envelope) => delivered.push(envelope));

    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:routed-event-error",
        targetId: "panel:gone",
        event: "ping",
        error: "Target not reachable: panel:gone",
        errorKind: "transport",
        errorCode: "TARGET_NOT_REACHABLE",
      }),
    });

    expect(delivered).toEqual([]);
  });

  it("returns server-initiated responses through ws:rpc", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    await transport.send({
      from: "panel:test",
      target: "server",
      delivery: { caller: { callerId: "panel:test", callerKind: "panel" } },
      provenance: [],
      message: { type: "response", requestId: "server-request-1", result: { ok: true } },
    });

    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "ws:rpc",
      envelope: { target: "server", message: { requestId: "server-request-1" } },
    });
  });
});
