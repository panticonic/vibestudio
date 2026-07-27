import { wsClientTransport } from "./wsClient.js";
import type { WsLike } from "../protocol/wsAdapter.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import { webSocketAuthProtocol } from "../protocol/webSocketAuthProtocol.js";

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

  authenticate(
    contractVersion: number = RPC_CONTRACT_VERSION,
    extras: { serverBootId?: string; sessionDirty?: boolean } = {}
  ): void {
    this.onmessage?.({
      data: JSON.stringify({
        success: true,
        type: "ws:auth-result",
        contractVersion,
        ...extras,
      }),
    });
  }
}

function createTransportHarness() {
  const sockets: FakeSocket[] = [];
  const socketProtocols: string[][] = [];
  const admissionRequests: string[] = [];
  let nextGrant = 0;
  const transport = wsClientTransport({
    adapter: {
      requestAdmission: async (_url, request) => {
        admissionRequests.push(request.credential);
        nextGrant += 1;
        return { ok: true, grant: `grant-${nextGrant}`, expiresAt: Date.now() + 15_000 };
      },
      createSocket: (_url, protocols) => {
        socketProtocols.push(protocols);
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
  return { admissionRequests, socketProtocols, sockets, transport };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
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

    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
  });

  it("waits without a first-connect deadline when timeout is null", async () => {
    const { sockets, transport } = createTransportHarness();
    let settled = false;
    const promise = transport.connectAndWait(null).finally(() => {
      settled = true;
    });

    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
    sockets[0]?.open();
    sockets[0]?.authenticate();

    await expect(promise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("declares the RPC contract version in its authentication handshake", async () => {
    const { socketProtocols, sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await flushAsyncWork();
    sockets[0]?.open();

    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: "ws:auth",
      contractVersion: RPC_CONTRACT_VERSION,
    });
    expect(socketProtocols[0]).toEqual([webSocketAuthProtocol("rpc", "grant-1")]);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ token: "grant-1" });

    sockets[0]?.authenticate();
    await connected;
  });

  it("rejects a server with a mismatched RPC contract", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    const rejected = expect(connected).rejects.toThrow(
      `RPC contract mismatch: server ${RPC_CONTRACT_VERSION + 1} (want ${RPC_CONTRACT_VERSION})`
    );
    await flushAsyncWork();
    sockets[0]?.open();
    sockets[0]?.authenticate(RPC_CONTRACT_VERSION + 1);

    await rejected;
    expect(transport.status?.()).toBe("disconnected");
  });

  it("does not reconnect after a terminal invalid-token close by default", async () => {
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await flushAsyncWork();
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
    const transport = wsClientTransport({
      adapter: {
        requestAdmission: async () => ({
          ok: false,
          code: "invalid_credential",
          message: "Invalid token",
        }),
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

    const connected = transport.connectAndWait();
    await flushAsyncWork();

    await expect(connected).rejects.toThrow("Auth refresh returned the rejected token");
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    expect(transport.status?.()).toBe("disconnected");
  });

  it("honors typed admission retry timing without refreshing or opening a socket", async () => {
    const sockets: FakeSocket[] = [];
    const requestAdmission = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: "admission_saturated",
        message: "busy",
        retryAfterMs: 2_500,
      })
      .mockResolvedValueOnce({
        ok: true,
        grant: "after-retry",
        expiresAt: Date.now() + 15_000,
      });
    const refreshAuthToken = vi.fn(async () => "fresh");
    const transport = wsClientTransport({
      adapter: {
        requestAdmission,
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
    await flushAsyncWork();
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(requestAdmission).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestAdmission).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(refreshAuthToken).not.toHaveBeenCalled();
  });

  it("retries a first-connect pre-open transport failure with a fresh admission grant", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { admissionRequests, sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await flushAsyncWork();

    expect(sockets).toHaveLength(1);
    sockets[0]!.onerror?.(new Error("upgrade race"));
    sockets[0]!.onclose?.({ code: 1006, reason: "upgrade failed" });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(admissionRequests).toEqual(["token", "token"]);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.authenticate();
    await expect(connected).resolves.toBeUndefined();
    random.mockRestore();
  });

  it("refreshes a stale post-restart token and emits cold recovery after reconnect", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const stale = "a".repeat(64);
    const fresh = "b".repeat(64);
    let admissionAttempt = 0;
    const sockets: FakeSocket[] = [];
    const refreshAuthToken = vi.fn(async () => fresh);
    const recovery: string[] = [];
    const transport = wsClientTransport({
      adapter: {
        requestAdmission: async (_url, request) => {
          admissionAttempt += 1;
          if (admissionAttempt === 2 && request.credential === stale) {
            return {
              ok: false,
              code: "invalid_credential",
              message: "Invalid token",
            };
          }
          return {
            ok: true,
            grant: `grant-${admissionAttempt}`,
            expiresAt: Date.now() + 15_000,
          };
        },
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        getAuthToken: async () => stale,
        refreshAuthToken,
        now: () => Date.now(),
      },
      getWsUrl: () => "wss://server.example/rpc",
      selfId: "panel:nav-test",
      onRecovery: (kind) => {
        recovery.push(kind);
      },
    });

    const connected = transport.connectAndWait();
    await flushAsyncWork();
    sockets[0]!.open();
    sockets[0]!.authenticate(RPC_CONTRACT_VERSION, { serverBootId: "boot-old" });
    await connected;
    expect(recovery).toEqual(["resubscribe"]);

    sockets[0]!.onclose?.({ code: 1006, reason: "server restart" });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    await vi.runOnlyPendingTimersAsync();
    await flushAsyncWork();

    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.authenticate(RPC_CONTRACT_VERSION, { serverBootId: "boot-new" });
    expect(recovery).toEqual(["resubscribe", "cold-recover"]);
    random.mockRestore();
  });

  it("synthesizes a rejecting response envelope from ws:routed-response-error", async () => {
    const { sockets, transport } = createTransportHarness();
    const delivered: Array<{ from: string; message: unknown }> = [];
    transport.onMessage((envelope) => {
      delivered.push({ from: envelope.from, message: envelope.message });
    });

    const connected = transport.connectAndWait();
    await flushAsyncWork();
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
    await flushAsyncWork();
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
    await flushAsyncWork();
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
