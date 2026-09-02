import { wsClientTransport } from "./wsClient.js";
import type { WsLike } from "../protocol/wsAdapter.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import { webSocketAuthProtocol } from "../protocol/webSocketAuthProtocol.js";
import { bytesToBase64 } from "../base64.js";
import { FRAME_DATA, FRAME_END, FRAME_HEAD } from "../protocol/streamCodec.js";
import { WS_STREAM_REQUEST_BODY_CAPABILITY } from "../protocol/wsProtocol.js";

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
    extras: {
      serverBootId?: string;
      sessionDirty?: boolean;
      transportCapabilities?: Array<typeof WS_STREAM_REQUEST_BODY_CAPABILITY>;
    } = {}
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

  it("uses refreshed connection metadata consistently for admission and authentication", async () => {
    const sockets: FakeSocket[] = [];
    const requests: Array<{ clientLabel?: string; clientPlatform?: string }> = [];
    const transport = wsClientTransport({
      adapter: {
        requestAdmission: async (_url, request) => {
          requests.push(request);
          return { ok: true, grant: "grant", expiresAt: Date.now() + 15_000 };
        },
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        getAuthToken: async () => "token",
        now: () => Date.now(),
      },
      getWsUrl: () => "wss://server.example/rpc",
      selfId: "panel:nav-test",
      connectionId: "stale-connection",
      getAuthMessageFields: () => ({
        connectionId: "refreshed-connection",
        clientLabel: "",
        clientPlatform: "desktop",
      }),
    });

    transport.connect();
    await flushAsyncWork();
    sockets[0]!.open();

    expect(requests).toEqual([
      {
        credential: "token",
        clientPlatform: "desktop",
      },
    ]);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      connectionId: "refreshed-connection",
      clientPlatform: "desktop",
    });
    expect(JSON.parse(sockets[0]!.sent[0]!)).not.toHaveProperty("clientLabel");
  });

  it("aborts an in-flight admission attempt when the transport closes", async () => {
    let admissionSignal: AbortSignal | undefined;
    const transport = wsClientTransport({
      adapter: {
        requestAdmission: async (_url, _request, options) => {
          admissionSignal = options?.signal;
          return await new Promise(() => {});
        },
        createSocket: () => new FakeSocket(),
        getAuthToken: async () => "token",
        now: () => Date.now(),
      },
      getWsUrl: () => "wss://server.example/rpc",
      selfId: "app:mobile:test",
    });

    transport.connect();
    await flushAsyncWork();
    expect(admissionSignal?.aborted).toBe(false);

    await transport.close();
    expect(admissionSignal?.aborted).toBe(true);
  });

  it("closes a socket whose upgrade is still connecting", async () => {
    const { sockets, transport } = createTransportHarness();
    transport.connect();
    await flushAsyncWork();

    expect(sockets[0]?.readyState).toBe(0);
    await transport.close();
    expect(sockets[0]?.readyState).toBe(3);
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

    await expect(connected).rejects.toThrow(
      "Server auth failed: Invalid token; auth refresh returned the rejected token"
    );
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

  it("streams request bodies and responses over the ordered loopback WebSocket", async () => {
    vi.useRealTimers();
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await flushAsyncWork();
    const socket = sockets[0]!;
    socket.open();
    socket.authenticate(RPC_CONTRACT_VERSION, {
      transportCapabilities: [WS_STREAM_REQUEST_BODY_CAPABILITY],
    });
    await connected;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const responsePromise = transport.streamReadable!(
      {
        from: "panel:nav-test",
        target: "main",
        delivery: { caller: { callerId: "panel:nav-test", callerKind: "panel" } },
        provenance: [{ callerId: "panel:nav-test", callerKind: "panel" }],
        message: {
          type: "stream-request",
          requestId: "stream-1",
          fromId: "panel:nav-test",
          method: "gateway.fetch",
          args: [{}],
        },
      },
      null,
      body
    );
    await flushAsyncWork();

    expect(socket.sent.slice(1).map((raw) => JSON.parse(raw).type)).toEqual([
      "ws:rpc",
      "ws:stream-body-chunk",
    ]);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "ws:rpc",
      streamBody: true,
      envelope: { message: { type: "stream-request", requestId: "stream-1" } },
    });
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      requestId: "stream-1",
      seq: 0,
      payload: bytesToBase64(new Uint8Array([1, 2, 3])),
    });
    socket.onmessage?.({
      data: JSON.stringify({ type: "ws:stream-body-ack", requestId: "stream-1", seq: 0 }),
    });
    await flushAsyncWork();
    expect(JSON.parse(socket.sent[3]!)).toMatchObject({
      type: "ws:stream-body-chunk",
      requestId: "stream-1",
      seq: 1,
      done: true,
    });
    socket.onmessage?.({
      data: JSON.stringify({ type: "ws:stream-body-ack", requestId: "stream-1", seq: 1 }),
    });

    const deliverFrame = (frameType: number, payload: string) =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "ws:rpc",
          envelope: {
            from: "main",
            target: "panel:nav-test",
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: {
              type: "stream-frame",
              requestId: "stream-1",
              fromId: "main",
              frameType,
              payload,
            },
          },
        }),
      });
    deliverFrame(
      FRAME_HEAD,
      JSON.stringify({ status: 201, statusText: "Created", headerPairs: [], finalUrl: "" })
    );
    const response = await responsePromise;
    deliverFrame(FRAME_DATA, bytesToBase64(new Uint8Array([9, 8])));
    deliverFrame(FRAME_END, JSON.stringify({ bytesIn: 2 }));

    const reader = response.body.getReader();
    await expect(reader.read()).resolves.toEqual({ value: new Uint8Array([9, 8]), done: false });
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects an upload before dispatch when the server did not advertise support", async () => {
    vi.useRealTimers();
    const { sockets, transport } = createTransportHarness();
    const connected = transport.connectAndWait();
    await flushAsyncWork();
    const socket = sockets[0]!;
    socket.open();
    socket.authenticate();
    await connected;
    const sentBeforeUpload = socket.sent.length;

    await expect(
      transport.streamReadable!(
        {
          from: "panel:nav-test",
          target: "main",
          delivery: { caller: { callerId: "panel:nav-test", callerKind: "panel" } },
          provenance: [{ callerId: "panel:nav-test", callerKind: "panel" }],
          message: {
            type: "stream-request",
            requestId: "unsupported-upload",
            fromId: "panel:nav-test",
            method: "gateway.fetch",
            args: [{}],
          },
        },
        null,
        new ReadableStream<Uint8Array>()
      )
    ).rejects.toThrow(/does not support WebSocket streaming request bodies/);
    expect(socket.sent).toHaveLength(sentBeforeUpload);
  });
});
