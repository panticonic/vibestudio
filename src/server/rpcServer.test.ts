import { afterEach, describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { RpcServer } from "./rpcServer.js";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WsClientState } from "./rpcServer.js";
import { createVerifiedCaller, type ServiceDispatcher } from "@vibez1/shared/serviceDispatcher";
import { EntityCache } from "@vibez1/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibez1/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@vibez1/shared/connectionGrants";
import { envelopeFromMessage, type RpcEnvelope, type RpcMessage } from "@vibez1/rpc";
import { FRAME_DATA, FRAME_END, FRAME_ERROR, FRAME_HEAD } from "@vibez1/rpc/protocol/streamCodec";
import {
  decodeControlFrame,
  encodeControlFrame,
  SESSION_NOT_OPEN_CLOSE_CODE,
  type SessionControlFrame,
} from "@vibez1/rpc/protocol/sessionNegotiation";
import { SessionWebSocketShim, type PipeChannels } from "./webrtcSessionShim.js";

function makeRecord(
  id: string,
  kind: EntityKind,
  opts?: { contextId?: string; repoPath?: string; effectiveVersion?: string }
): EntityRecord {
  return {
    id,
    kind,
    source: {
      repoPath: opts?.repoPath ?? "",
      effectiveVersion: opts?.effectiveVersion ?? "",
    },
    contextId: opts?.contextId ?? "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

type MockDispatcher = ServiceDispatcher & {
  dispatch: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
  getMethodPolicy: ReturnType<typeof vi.fn>;
};

type TestRpcServer = {
  dispatcher: MockDispatcher;
  connections: {
    addClient(client: WsClientState): void;
    getCallerConnections(callerId: string): WsClientState[];
  };
  connectionReconnectWaiters: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
  reconnectWaiters: Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }
  >;
  handleAuth(ws: unknown, token: string | null, connectionId: string): void;
  handleConnection(ws: unknown): void;
  handleRoute(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): Promise<void> | void;
  handleClose(client: WsClientState, code: number, reason: string): void;
  handleRpc(client: WsClientState, message: RpcMessage, envelope: RpcEnvelope): Promise<void>;
  relayCall(
    sourceId: string,
    callerKind: string,
    targetId: string,
    method: string,
    args: unknown[],
    targetConnectionId?: string,
    meta?: { requestId?: string; idempotencyKey?: string; readOnly?: boolean }
  ): Promise<unknown>;
  relayToDO(
    callerId: string,
    callerKind: string,
    targetId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
  streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response>;
  checkRelayAuth(
    callerId: string,
    callerKind: string,
    targetId: string
  ): { ok: boolean; reason?: string };
  sendToWs(ws: unknown, msg: unknown): void;
};

function testServer(server: RpcServer): TestRpcServer {
  return server as unknown as TestRpcServer;
}

function createServer(opts: Partial<ConstructorParameters<typeof RpcServer>[0]> = {}) {
  const tokenManager = new TokenManager();
  const entityCache = new EntityCache();
  entityCache._onActivate(makeRecord("panel:nav-a", "panel"));
  entityCache._onActivate(makeRecord("panel:nav-b", "panel"));
  const connectionGrants = new ConnectionGrantService({ entityCache });

  const dispatcher = {
    dispatch: vi.fn(),
    getPolicy: vi.fn(),
    getMethodPolicy: vi.fn(),
  } as unknown as MockDispatcher;
  const runtimeCoordinator = new PanelRuntimeCoordinator();
  runtimeCoordinator.registerClient({
    clientSessionId: "test-desktop",
    label: "Desktop",
    platform: "desktop",
  });
  runtimeCoordinator.acquire("panel:nav-a", {
    slotId: "panel:tree/slot-a",
    clientSessionId: "test-desktop",
    connectionId: "conn-1",
  });

  return {
    tokenManager,
    entityCache,
    connectionGrants,
    runtimeCoordinator,
    grantPanel: (panelId: string) => connectionGrants.grant(panelId, "shell:test").token,
    server: new RpcServer({
      tokenManager,
      dispatcher,
      entityCache,
      connectionGrants,
      runtimeCoordinator,
      ...opts,
    }),
  };
}

function createClient(callerId = "panel:nav-a"): WsClientState {
  return {
    caller: createVerifiedCaller(callerId, "panel"),
    connectionId: "conn-1",
    authenticated: true,
    authenticatedAt: Date.now(),
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as WebSocket,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function createClientWithConnection(callerId: string, connectionId: string): WsClientState {
  const client = createClient(callerId);
  client.connectionId = connectionId;
  client.authenticatedAt = connectionId === "conn-1" ? 1 : 2;
  return client;
}

function createSignalDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEnvelope(
  from: string,
  target: string,
  callerKind: RpcEnvelope["delivery"]["caller"]["callerKind"],
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: from,
    from,
    target,
    callerKind,
    message,
  });
}

function clientEnvelope(client: WsClientState, targetId: string, message: RpcMessage): RpcEnvelope {
  return makeEnvelope(client.caller.runtime.id, targetId, client.caller.runtime.kind, message);
}

function handleRoute(
  server: RpcServer,
  client: WsClientState,
  targetId: string,
  message: RpcMessage,
  targetConnectionId?: string
): Promise<void> | void {
  return testServer(server).handleRoute(
    client,
    targetId,
    message,
    targetConnectionId,
    clientEnvelope(client, targetId, message)
  );
}

function handleRpc(server: RpcServer, client: WsClientState, message: RpcMessage): Promise<void> {
  return testServer(server).handleRpc(client, message, clientEnvelope(client, "main", message));
}

function createTestWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    OPEN: WebSocket.OPEN as number,
    readyState: WebSocket.OPEN as number,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    emitMessage(message: unknown) {
      handlers.get("message")?.(Buffer.from(JSON.stringify(message)));
    },
    emitClose(code = 1006, reason = "network") {
      this.readyState = WebSocket.CLOSED;
      handlers.get("close")?.(code, Buffer.from(reason));
    },
  };
}

function registerClient(server: RpcServer, client: WsClientState): void {
  testServer(server).connections.addClient(client);
}

/** Let queued promise callbacks (frame pumps, metering settles) run. */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake answerer pipe implementing the v2 AttachablePipe contract. */
function createFakePipe() {
  const control: Array<{ frame: SessionControlFrame; lane: string | undefined }> = [];
  const bulk: Array<{ streamId: number; type: number; payload: Uint8Array }> = [];
  let controlHandler: ((data: Uint8Array) => void) | null = null;
  let bulkFrameHandler: ((streamId: number, type: number, payload: Uint8Array) => void) | null =
    null;
  let downHandler: ((reason: string) => void) | null = null;
  const pipe = {
    writeControl: (data: Uint8Array, lane?: string): Promise<void> => {
      control.push({ frame: decodeControlFrame(new TextDecoder().decode(data)), lane });
      return Promise.resolve();
    },
    writeBulkFrame: (streamId: number, type: number, payload: Uint8Array): Promise<void> => {
      bulk.push({ streamId, type, payload });
      return Promise.resolve();
    },
    dropBulkStream: vi.fn(),
    bulkPendingBytes: () => 0,
    controlBufferedAmount: () => 0,
    onControl: (handler: (data: Uint8Array) => void): void => {
      controlHandler = handler;
    },
    onBulkFrame: (handler: (streamId: number, type: number, payload: Uint8Array) => void): void => {
      bulkFrameHandler = handler;
    },
    onDown: (handler: (reason: string) => void): (() => void) => {
      downHandler = handler;
      return () => {
        if (downHandler === handler) downHandler = null;
      };
    },
  };
  return {
    pipe: pipe as unknown as Parameters<RpcServer["attachWebRtcPipe"]>[0],
    control,
    bulk,
    controlOfType: (t: string) => control.filter((w) => w.frame.t === t),
    sendControl: (frame: SessionControlFrame) =>
      controlHandler!(new TextEncoder().encode(encodeControlFrame(frame))),
    emitDown: (reason: string) => downHandler!(reason),
    hasBulkHandler: () => bulkFrameHandler !== null,
    emitBulk: (streamId: number, type: number, payload: Uint8Array) =>
      bulkFrameHandler!(streamId, type, payload),
  };
}

function unknownSidRpcRequest(sid: string, requestId: string): SessionControlFrame {
  return {
    t: "rpc",
    sid,
    envelope: makeEnvelope("panel:c1", "main", "panel", {
      type: "request",
      requestId,
      fromId: "panel:c1",
      method: "fs.read",
      args: [],
    }),
  };
}

describe("RpcServer attachWebRtcPipe (v2 pipe contract)", () => {
  it("closes all WebRTC logical sessions when the underlying pipe goes down", () => {
    const { server } = createServer();
    const closeArgs: unknown[][] = [];
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      (ws as { on(event: string, handler: (...args: unknown[]) => void): unknown }).on(
        "close",
        (...args) => closeArgs.push(args)
      );
    });

    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    // The upload passthrough seam is armed even before uploads land (§1.6).
    expect(p.hasBulkHandler()).toBe(true);

    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });
    expect(testServer(server).handleConnection).toHaveBeenCalledTimes(1);

    p.emitDown("ICE failed");
    expect(closeArgs).toHaveLength(1);
    expect(closeArgs[0]![0]).toBe(1006);
    expect((closeArgs[0]![1] as Buffer).toString()).toBe("ICE failed");

    p.emitDown("late duplicate");
    expect(closeArgs).toHaveLength(1);
  });

  it("answers an unknown-sid rpc request with SESSION_NOT_OPEN plus a non-terminal closed(4008)", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl(unknownSidRpcRequest("missing", "req-1"));

    // The pending call settles now …
    expect(p.controlOfType("rpc")[0]!.frame).toMatchObject({
      t: "rpc",
      sid: "missing",
      envelope: {
        message: { type: "response", requestId: "req-1", errorCode: "SESSION_NOT_OPEN" },
      },
    });
    // … and the self-healing closed tells the client to reopen the session.
    const closed = p.controlOfType("closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.frame).toMatchObject({
      t: "closed",
      sid: "missing",
      code: SESSION_NOT_OPEN_CLOSE_CODE,
      reason: "session not open",
      terminal: false,
    });
    // Control frames ride the frame's session lane.
    expect(closed[0]!.lane).toBe("missing");
  });

  it("sends closed(4008) — and nothing else — for an unknown-sid event-carrying frame", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({
      t: "rpc",
      sid: "ghost",
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "event",
        fromId: "panel:c1",
        event: "state-changed",
        payload: 1,
      }),
    });

    expect(p.controlOfType("rpc")).toHaveLength(0); // nothing to respond to
    expect(p.controlOfType("closed")).toHaveLength(1);
    expect(p.controlOfType("closed")[0]!.frame).toMatchObject({
      sid: "ghost",
      code: SESSION_NOT_OPEN_CLOSE_CODE,
      terminal: false,
    });
  });

  it("rate-limits closed(4008) per sid — two rapid unknown frames produce one closed each sid", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl(unknownSidRpcRequest("missing", "req-1"));
    p.sendControl(unknownSidRpcRequest("missing", "req-2"));
    p.sendControl(unknownSidRpcRequest("other", "req-3"));

    // Per-request responses are NOT rate-limited (every pending call settles) …
    expect(p.controlOfType("rpc")).toHaveLength(3);
    // … but the closed self-heal frame is one per sid per window.
    const closedSids = p.controlOfType("closed").map((w) => (w.frame as { sid: string }).sid);
    expect(closedSids).toEqual(["missing", "other"]);
  });

  it("fails an unknown-sid stream-open with a bulk FRAME_ERROR the stream decoder can parse, plus closed(4008)", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({
      t: "stream-open",
      sid: "missing",
      streamId: 42,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "stream-1",
        fromId: "panel:c1",
        method: "credentials.proxyFetch",
        args: [],
      }),
    });

    expect(p.bulk).toHaveLength(1);
    expect(p.bulk[0]).toMatchObject({ streamId: 42, type: FRAME_ERROR });
    // Exactly the ErrorFramePayload shape parseErrorFrame/decodeFramedStream expects.
    expect(JSON.parse(new TextDecoder().decode(p.bulk[0]!.payload))).toEqual({
      status: 409,
      message: "WebRTC session is not open",
      code: "SESSION_NOT_OPEN",
    });
    expect(p.controlOfType("closed")).toHaveLength(1);
    expect(p.controlOfType("closed")[0]!.frame).toMatchObject({
      sid: "missing",
      code: SESSION_NOT_OPEN_CLOSE_CODE,
      terminal: false,
    });
  });

  it("sends closed(4008) for an unknown-sid stream-cancel", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({ t: "stream-cancel", sid: "missing", streamId: 9 });
    expect(p.controlOfType("closed")).toHaveLength(1);
  });

  it("does NOT answer pings — keepalive lives inside the answerer transport now", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({ t: "ping", ts: 123 });
    expect(p.control).toHaveLength(0); // no pong, no closed (pipe-level, no sid)
  });

  it("does not echo closed(4008) for an unknown-sid close (the client is discarding the session)", () => {
    const { server } = createServer();
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({ t: "close", sid: "already-gone", code: 1000, reason: "bye" });
    expect(p.control).toHaveLength(0); // a closed reply would trigger a spurious reopen
  });
});

describe("RpcServer stream-request emit path (§2.3 binary surface, §2.4 cancellation)", () => {
  function streamRequest(requestId: string, method = "files.stream"): RpcMessage {
    return { type: "stream-request", requestId, fromId: "panel:nav-a", method, args: [] };
  }

  function setupStreamingServer() {
    const created = createServer();
    const dispatcher = testServer(created.server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    return { ...created, dispatcher };
  }

  function sentStreamFrames(client: WsClientState) {
    return (client.ws.send as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((msg) => msg.envelope?.message?.type === "stream-frame")
      .map((msg) => msg.envelope.message as { frameType: number; payload: string });
  }

  it("uses the binary sendStreamFrame surface (raw bytes, no base64) when the transport exposes it", async () => {
    const { server, dispatcher } = setupStreamingServer();
    dispatcher.dispatch.mockResolvedValue(new Response("hello!", { status: 200 }));

    const client = createClient();
    const sends: Array<{ requestId: string; type: number; payload: Uint8Array }> = [];
    const sendStreamFrame = vi.fn(
      (requestId: string, type: number, payload: Uint8Array): Promise<void> | false => {
        sends.push({ requestId, type, payload });
        return Promise.resolve();
      }
    );
    (client.ws as unknown as { sendStreamFrame: unknown }).sendStreamFrame = sendStreamFrame;

    await handleRpc(server, client, streamRequest("sr-1"));

    expect(sends.map((s) => s.type)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_END]);
    expect(sends.every((s) => s.requestId === "sr-1")).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(sends[0]!.payload))).toMatchObject({
      status: 200,
    });
    // DATA is the RAW body bytes — no base64, no JSON envelope.
    expect(new TextDecoder().decode(sends[1]!.payload)).toBe("hello!");
    expect(JSON.parse(new TextDecoder().decode(sends[2]!.payload))).toEqual({ bytesIn: 6 });
    // Nothing went over the JSON ws.send path.
    expect(sentStreamFrames(client)).toHaveLength(0);
  });

  it("keeps the base64-JSON path when the transport has no sendStreamFrame (plain WS unchanged)", async () => {
    const { server, dispatcher } = setupStreamingServer();
    dispatcher.dispatch.mockResolvedValue(new Response("hello!", { status: 200 }));

    const client = createClient();
    await handleRpc(server, client, streamRequest("sr-1"));

    const frames = sentStreamFrames(client);
    expect(frames.map((f) => f.frameType)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_END]);
    expect(Buffer.from(frames[1]!.payload, "base64").toString()).toBe("hello!");
  });

  it("AWAITS each binary frame send — the producer loop suspends until the pipe accepts the frame", async () => {
    const { server, dispatcher } = setupStreamingServer();
    const encoderUtf8 = new TextEncoder();
    dispatcher.dispatch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoderUtf8.encode("a"));
            controller.enqueue(encoderUtf8.encode("b"));
            controller.close();
          },
        }),
        { status: 200 }
      )
    );

    const client = createClient();
    const gates: Array<() => void> = [];
    const sendStreamFrame = vi.fn((): Promise<void> => {
      return new Promise<void>((resolve) => gates.push(resolve));
    });
    (client.ws as unknown as { sendStreamFrame: unknown }).sendStreamFrame = sendStreamFrame;

    const done = handleRpc(server, client, streamRequest("sr-1"));
    await flushAsync();
    expect(sendStreamFrame).toHaveBeenCalledTimes(1); // HEAD in flight, loop parked

    gates[0]!();
    await flushAsync();
    expect(sendStreamFrame).toHaveBeenCalledTimes(2); // DATA "a"

    gates[1]!();
    await flushAsync();
    expect(sendStreamFrame).toHaveBeenCalledTimes(3); // DATA "b"

    gates[2]!();
    await flushAsync();
    expect(sendStreamFrame).toHaveBeenCalledTimes(4); // END

    gates[3]!();
    await done;
  });

  it("registers parsed-service streams in wsStreamAborts — a client stream-cancel stops the service read", async () => {
    const { server, dispatcher } = setupStreamingServer();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        // Never closes — only a cancel can end this stream.
      },
      cancel() {
        cancelled = true;
      },
    });
    dispatcher.dispatch.mockResolvedValue(new Response(body, { status: 200 }));

    const client = createClient();
    const done = handleRpc(server, client, streamRequest("sr-2"));
    await flushAsync();
    // HEAD + first chunk are out; the read loop is now parked on a stalled producer.
    expect(sentStreamFrames(client).map((f) => f.frameType)).toEqual([FRAME_HEAD, FRAME_DATA]);

    await handleRpc(server, client, {
      type: "stream-cancel",
      requestId: "sr-2",
      fromId: "panel:nav-a",
    });
    await done;

    expect(cancelled).toBe(true); // ReadableStream cancel propagated to the producer
    const frames = sentStreamFrames(client);
    expect(frames[frames.length - 1]!.frameType).toBe(FRAME_ERROR); // no END masquerade
    expect(frames.some((f) => f.frameType === FRAME_END)).toBe(false);
  });

  it("terminates a session whose bufferedAmount (incl. bulk backlog) exceeds the hard limit", () => {
    const { server } = createServer();
    const control: SessionControlFrame[] = [];
    const pipe: PipeChannels = {
      writeControl: (data) => {
        control.push(decodeControlFrame(new TextDecoder().decode(data)));
        return Promise.resolve();
      },
      // Never settles — the bulk backlog stays metered.
      writeBulkFrame: () => new Promise<void>(() => {}),
      dropBulkStream: () => {},
      bulkPendingBytes: () => 0,
    };
    const shim = new SessionWebSocketShim("s1", pipe, () => {});
    shim.registerStream("req-1", 7);
    // Meter 129 MiB of un-drained bulk without allocating it: the shim only
    // reads byteLength and hands the payload to the (fake) pipe.
    const written = shim.sendStreamFrame("req-1", FRAME_DATA, {
      byteLength: 129 * 1024 * 1024,
    } as unknown as Uint8Array);
    expect(written).not.toBe(false);
    expect(shim.bufferedAmount).toBeGreaterThan(128 * 1024 * 1024);

    testServer(server).sendToWs(shim, { type: "ws:event", event: "x", payload: 1 });

    expect(shim.readyState).toBe(3); // terminated — the slow session, not the pipe
    expect(control.some((frame) => frame.t === "closed")).toBe(true);
  });
});

describe("RpcServer relay behavior", () => {
  it("allows authenticated panels to relay to panel, DO, and worker targets", () => {
    const { server } = createServer();

    expect(testServer(server).checkRelayAuth("panel:nav-a", "panel", "panel:nav-b")).toEqual({
      ok: true,
    });

    expect(
      testServer(server).checkRelayAuth("panel:nav-a", "panel", "do:workers/example:Store:key")
    ).toEqual({ ok: true });

    expect(
      testServer(server).checkRelayAuth("panel:nav-a", "panel", "worker:workers/example")
    ).toEqual({ ok: true });
  });

  it("throws DO_NOT_CREATED when relaying to a DO with no registered entity record", async () => {
    const tokenManager = new TokenManager();
    const dispatcher = {
      dispatch: vi.fn(),
      getPolicy: vi.fn(),
      getMethodPolicy: vi.fn(),
    } as unknown as MockDispatcher;
    const entityCache = new EntityCache();
    entityCache._onActivate(makeRecord("panel:nav-a", "panel", { contextId: "ctx-1" }));
    const server = new RpcServer({ tokenManager, dispatcher, entityCache });

    await expect(
      testServer(server).relayToDO(
        "panel:nav-a",
        "panel",
        "do:workers/example:Store:key",
        "ping",
        []
      )
    ).rejects.toMatchObject({ code: "DO_NOT_CREATED" });
  });

  it("refreshes workerd connection details after ensureDO before retrying DO relay", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:workers/example:Store:key";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce(
        // Envelope-native: the DO replies with a response envelope; relayToDO unwraps result.
        new Response(
          JSON.stringify({
            from: "do",
            target: "main",
            delivery: { caller: { callerId: "do", callerKind: "do" } },
            provenance: [],
            message: { type: "response", requestId: "x", result: { ok: true } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    server.setEnsureDO(
      vi.fn(async () => {
        server.setWorkerdUrl("http://127.0.0.1:2222");
      })
    );

    await expect(
      testServer(server).relayToDO("panel:nav-a", "panel", targetId, "ping", [])
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:1111\//);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:2222\//);
  });

  it("mints a vcsPush invocation token resolving to the ORIGINATING caller (§4)", async () => {
    // Narrow-host P3 attribution: a userland `vcsPush` dispatch to the
    // single-writer DO (targetId === vcsWriterIdentity) mints an on-behalf-of
    // token recording the ORIGINATING caller. The DO threads it back into
    // refs.updateMains, which resolves it against THIS table to attribute the
    // advance — the whole reason the push flip must be client-side (a
    // host-service forward would erase the originating principal here).
    const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
    const vcsInvocations = new VcsInvocationTable();
    const targetId = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
    const { server, entityCache } = createServer({
      vcsInvocations,
      getVcsWriterIdentity: () => targetId,
    });
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    let tokenSeen: string | undefined;
    let resolvedCallerId: string | undefined;
    let sizeDuringDispatch = -1;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { message?: { invocationToken?: string } };
      tokenSeen = envelope.message?.invocationToken;
      if (tokenSeen) {
        // Resolve WHILE the dispatch is in flight (the token window is open).
        resolvedCallerId = vcsInvocations.resolve(tokenSeen)?.caller.runtime.id;
        sizeDuringDispatch = vcsInvocations.size();
      }
      return new Response(
        JSON.stringify({
          from: "do",
          target: "main",
          delivery: { caller: { callerId: "do", callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "x", result: { status: "pushed" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await testServer(server).relayToDO("panel:nav-a", "panel", targetId, "vcsPush", [
      { repoPaths: ["packages/a"], sourceHead: "ctx:c1" },
    ]);

    // Minted, threaded, and resolved to the originating caller (NOT the DO).
    expect(tokenSeen).toBeTruthy();
    expect(resolvedCallerId).toBe("panel:nav-a");
    expect(sizeDuringDispatch).toBe(1);
    // The window closes when the dispatch settles — replay fails closed.
    expect(vcsInvocations.size()).toBe(0);
    expect(vcsInvocations.resolve(tokenSeen!)).toBeNull();
  });

  it("attributes routed extension VCS writer dispatches to the parent invocation caller", async () => {
    const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
    const vcsInvocations = new VcsInvocationTable();
    const targetId = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
    const parentCaller = {
      callerId: "@workspace-apps/shell",
      callerKind: "app" as const,
      repoPath: "apps/shell",
      effectiveVersion: "ev-parent",
      contextId: "ctx-parent",
    };
    const resolveExtensionInvocation = vi.fn(() => ({
      caller: {
        callerId: "@workspace-extensions/git-bridge",
        callerKind: "extension" as const,
      },
      chainCaller: parentCaller,
    }));
    const { server, entityCache } = createServer({
      vcsInvocations,
      getVcsWriterIdentity: () => targetId,
      resolveExtensionInvocation,
    });
    entityCache._onActivate(makeRecord(targetId, "do"));
    entityCache._onActivate(
      makeRecord(parentCaller.callerId, "app", {
        contextId: parentCaller.contextId,
        repoPath: parentCaller.repoPath,
        effectiveVersion: parentCaller.effectiveVersion,
      })
    );
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    let tokenSeen: string | undefined;
    let contextSeen: string | undefined;
    let resolvedCallerId: string | undefined;
    let resolvedRepoPath: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as {
        message?: { invocationToken?: string; callerContextId?: string };
      };
      tokenSeen = envelope.message?.invocationToken;
      contextSeen = envelope.message?.callerContextId;
      const record = tokenSeen ? vcsInvocations.resolve(tokenSeen) : null;
      resolvedCallerId = record?.caller.runtime.id;
      resolvedRepoPath = record?.caller.code?.repoPath;
      return new Response(
        JSON.stringify({
          from: "do",
          target: "main",
          delivery: { caller: { callerId: "do", callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "req-ext-vcs", result: { status: "pushed" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const extensionClient = createClient("@workspace-extensions/git-bridge");
    extensionClient.caller = createVerifiedCaller("@workspace-extensions/git-bridge", "extension");

    handleRoute(server, extensionClient, targetId, {
      type: "request",
      requestId: "req-ext-vcs",
      fromId: extensionClient.caller.runtime.id,
      method: "vcsPush",
      args: [{ repoPaths: ["packages/a"], sourceHead: "ctx:ctx-parent" }],
      parentInvocationToken: "parent-token",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(resolveExtensionInvocation).toHaveBeenCalledWith(
      "@workspace-extensions/git-bridge",
      "parent-token"
    );
    expect(tokenSeen).toBeTruthy();
    expect(resolvedCallerId).toBe(parentCaller.callerId);
    expect(resolvedRepoPath).toBe(parentCaller.repoPath);
    expect(contextSeen).toBe(parentCaller.contextId);
    await vi.waitFor(() => expect(vcsInvocations.size()).toBe(0));
  });

  it("threads the caller's HOST-RESOLVED context id to the writer DO (row 11)", async () => {
    // Source-head confinement: the relay resolves the ORIGINATING caller's
    // context registration (`entityCache.resolveContext`) at the same chokepoint
    // that mints the token, and threads it as `message.callerContextId`. The
    // writer DO uses it to confine a sandboxed push to its own `ctx:` head. Never
    // client-asserted — resolved host-side here.
    const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
    const vcsInvocations = new VcsInvocationTable();
    const targetId = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
    const { server, entityCache } = createServer({
      vcsInvocations,
      getVcsWriterIdentity: () => targetId,
    });
    // Register the caller with a context registration.
    entityCache._onActivate(makeRecord("panel:ctx-a", "panel", { contextId: "ctx-42" }));
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    let contextSeen: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { message?: { callerContextId?: string } };
      contextSeen = envelope.message?.callerContextId;
      return new Response(
        JSON.stringify({
          from: "do",
          target: "main",
          delivery: { caller: { callerId: "do", callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "x", result: { status: "pushed" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await testServer(server).relayToDO("panel:ctx-a", "panel", targetId, "vcsPush", [
      { repoPaths: ["packages/a"], sourceHead: "ctx:ctx-42" },
    ]);
    expect(contextSeen).toBe("ctx-42");
  });

  it("does NOT thread a context id to a NON-writer DO dispatch (row 11)", async () => {
    const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
    const vcsInvocations = new VcsInvocationTable();
    const writerId = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
    const otherId = "do:workers/example:Store:key";
    const { server, entityCache } = createServer({
      vcsInvocations,
      getVcsWriterIdentity: () => writerId,
    });
    entityCache._onActivate(makeRecord("panel:ctx-a", "panel", { contextId: "ctx-42" }));
    entityCache._onActivate(makeRecord(otherId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    let contextSeen: string | undefined = "unset";
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { message?: { callerContextId?: string } };
      contextSeen = envelope.message?.callerContextId;
      return new Response(
        JSON.stringify({
          from: "do",
          target: "main",
          delivery: { caller: { callerId: "do", callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "x", result: { ok: true } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await testServer(server).relayToDO("panel:ctx-a", "panel", otherId, "ping", []);
    expect(contextSeen).toBeUndefined();
  });

  it("does NOT mint an invocation token for a NON-writer DO dispatch", async () => {
    // Only the single-writer DO identity mints a token; any other DO target
    // (targetId !== vcsWriterIdentity) relays without one.
    const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
    const vcsInvocations = new VcsInvocationTable();
    const writerId = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
    const otherId = "do:workers/example:Store:key";
    const { server, entityCache } = createServer({
      vcsInvocations,
      getVcsWriterIdentity: () => writerId,
    });
    entityCache._onActivate(makeRecord(otherId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    let tokenSeen: string | undefined = "unset";
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { message?: { invocationToken?: string } };
      tokenSeen = envelope.message?.invocationToken;
      return new Response(
        JSON.stringify({
          from: "do",
          target: "main",
          delivery: { caller: { callerId: "do", callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "x", result: { ok: true } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await testServer(server).relayToDO("panel:nav-a", "panel", otherId, "ping", []);
    expect(tokenSeen).toBeUndefined();
    expect(vcsInvocations.size()).toBe(0);
  });

  it("rejects distinct live panel runtime connections for the same caller", () => {
    const { server, grantPanel } = createServer();
    const ws1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const ws2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-2");

    expect(ws1.close).not.toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalledWith(4090, "Panel runtime lease denied");
    expect(testServer(server).connections.getCallerConnections("panel:nav-a")).toHaveLength(1);
    expect(JSON.parse(ws1.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: true,
      connectionId: "conn-1",
      serverBootId: expect.any(String),
    });
    expect(JSON.parse(ws2.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: false,
      error: expect.stringContaining("Panel runtime is leased by"),
    });
  });

  it("keeps the replacement bridge and lease when the old same-connection socket closes late", () => {
    const { server, grantPanel, runtimeCoordinator } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    const firstBridge = server.getClientBridge("panel:nav-a");
    expect(firstBridge).toBeTruthy();

    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-1");
    const replacementBridge = server.getClientBridge("panel:nav-a");
    expect(replacementBridge).toBeTruthy();
    expect(replacementBridge).not.toBe(firstBridge);
    expect(ws1.close).toHaveBeenCalledWith(4002, "Replaced by new connection");

    ws1.emitClose(4002, "Replaced by new connection");

    expect(server.getClientBridge("panel:nav-a")).toBe(replacementBridge);
    expect(testServer(server).connections.getCallerConnections("panel:nav-a")).toEqual([
      expect.objectContaining({ connectionId: "conn-1", ws: ws2 }),
    ]);
    expect(runtimeCoordinator.getLease("panel:nav-a")).toEqual(
      expect.objectContaining({ connectionId: "conn-1" })
    );
    expect(runtimeCoordinator.getLease("panel:nav-a")).not.toHaveProperty("expiresAt");
  });

  it("ignores late frames from a replaced same-connection socket", async () => {
    const { server, grantPanel } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    testServer(server).dispatcher.dispatch.mockResolvedValue("ok");

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-1");

    const lateMessage: RpcMessage = {
      type: "request",
      requestId: "late-old-frame",
      fromId: "panel:nav-a",
      method: "workspace.ping",
      args: [],
    };
    ws1.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("panel:nav-a", "main", "panel", lateMessage),
    });
    await Promise.resolve();

    expect(testServer(server).dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("routes server-initiated stream frames from a connected extension back to the pending stream", async () => {
    const { server, tokenManager } = createServer();
    const extensionToken = tokenManager.ensureToken("@workspace-extensions/shell", "extension");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, extensionToken, "ext-conn-1");

    const responsePromise = testServer(server).streamCallTarget(
      "@workspace-extensions/shell",
      "extension.invokeStream",
      "attach",
      ["session-1"],
      { caller: { callerId: "panel:nav-a", callerKind: "panel" } }
    );
    const sent = ws.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find(
        (message) =>
          message.type === "ws:rpc" && message.envelope?.message?.type === "stream-request"
      );
    expect(sent).toBeTruthy();
    const requestId = sent.envelope.message.requestId as string;

    const headFrame: RpcMessage = {
      type: "stream-frame",
      requestId,
      fromId: "@workspace-extensions/shell",
      frameType: 0x01,
      payload: JSON.stringify({
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "text/plain"]],
        finalUrl: "",
      }),
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", headFrame),
    });
    const response = await responsePromise;

    const chunkFrame: RpcMessage = {
      type: "stream-frame",
      requestId,
      fromId: "@workspace-extensions/shell",
      frameType: 0x02,
      payload: Buffer.from("hello").toString("base64"),
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", chunkFrame),
    });
    const endFrame: RpcMessage = {
      type: "stream-frame",
      requestId,
      fromId: "@workspace-extensions/shell",
      frameType: 0x03,
      payload: JSON.stringify({ bytesIn: 5 }),
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", endFrame),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello");
  });

  it("rejects server bridge calls when a client routes a response to server", async () => {
    const { server, tokenManager } = createServer();
    const extensionId = "@workspace-extensions/process-test";
    const extensionToken = tokenManager.ensureToken(extensionId, "extension");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, extensionToken, "ext-conn-1");
    const bridge = server.getClientBridge(extensionId);
    expect(bridge).toBeTruthy();

    const call = bridge!.call(extensionId, "extension.invoke", ["ping", []]);
    await Promise.resolve();

    const sent = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find(
        (message) => message.type === "ws:rpc" && message.envelope?.message?.type === "request"
      );
    expect(sent).toBeTruthy();
    const requestId = sent.envelope.message.requestId as string;

    ws.emitMessage({
      type: "ws:route",
      envelope: {
        from: extensionId,
        target: "server",
        delivery: { caller: { callerId: extensionId, callerKind: "extension" } },
        provenance: [{ callerId: extensionId, callerKind: "extension" }],
        message: {
          type: "response",
          requestId,
          result: "pong",
        },
      },
    });

    await expect(call).rejects.toMatchObject({
      message: expect.stringContaining("was sent via ws:route"),
      code: "RPC_PROTOCOL_ERROR",
    });

    const routedError = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((message) => message.type === "ws:routed-response-error");
    expect(routedError).toMatchObject({
      type: "ws:routed-response-error",
      targetId: "server",
      requestId,
      error: expect.stringContaining("was sent via ws:route"),
      errorCode: "RPC_PROTOCOL_ERROR",
    });
  });

  it("fans routed events out to every live connection for the target caller", () => {
    const { server } = createServer();
    const source = createClientWithConnection("panel:nav-a", "source-conn");
    const target1 = createClientWithConnection("panel:nav-b", "conn-1");
    const target2 = createClientWithConnection("panel:nav-b", "conn-2");
    registerClient(server, target1);
    registerClient(server, target2);

    handleRoute(server, source, "panel:nav-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target1.ws.send).toHaveBeenCalledTimes(1);
    expect(target2.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("steers routed responses back to the origin connection", async () => {
    const { server } = createServer();
    const origin1 = createClientWithConnection("panel:nav-a", "conn-1");
    const origin2 = createClientWithConnection("panel:nav-a", "conn-2");
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, origin1);
    registerClient(server, origin2);
    registerClient(server, target);

    handleRoute(server, origin2, "panel:nav-b", {
      type: "request",
      requestId: "req-origin-2",
      fromId: "panel:nav-a",
      method: "test.method",
      args: [],
    });
    (target.ws.send as ReturnType<typeof vi.fn>).mockClear();

    handleRoute(server, target, "panel:nav-a", {
      type: "response",
      requestId: "req-origin-2",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(origin1.ws.send).not.toHaveBeenCalled();
    expect(origin2.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((origin2.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-b",
        message: { type: "response", requestId: "req-origin-2", result: { ok: true } },
      },
    });
  });

  it("keeps routed response origins while the origin connection reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { server, grantPanel, runtimeCoordinator } = createServer();
      const origin1 = createClientWithConnection("panel:nav-a", "conn-1");
      const origin2 = createClientWithConnection("panel:nav-a", "conn-2");
      const target = createClientWithConnection("panel:nav-b", "target-conn");
      registerClient(server, origin1);
      registerClient(server, origin2);
      registerClient(server, target);

      handleRoute(server, origin2, "panel:nav-b", {
        type: "request",
        requestId: "req-reconnect",
        fromId: "panel:nav-a",
        method: "test.method",
        args: [],
      });
      testServer(server).handleClose(origin2, 1006, "network");

      handleRoute(server, target, "panel:nav-a", {
        type: "response",
        requestId: "req-reconnect",
        result: { ok: true },
      });
      await Promise.resolve();

      const reconnectedWs = createTestWs();
      runtimeCoordinator.takeOver("panel:nav-a", {
        slotId: "panel:tree/slot-a",
        clientSessionId: "test-desktop",
        connectionId: "conn-2",
      });
      testServer(server).handleAuth(reconnectedWs, grantPanel("panel:nav-a"), "conn-2");
      await Promise.resolve();
      await Promise.resolve();

      expect(origin1.ws.send).not.toHaveBeenCalled();
      const routedCall = reconnectedWs.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .find((msg) => msg.type === "ws:routed");
      expect(routedCall).toMatchObject({
        type: "ws:routed",
        envelope: {
          from: "panel:nav-b",
          message: { type: "response", requestId: "req-reconnect", result: { ok: true } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the caller when a delivered routed request's callee terminally dies", async () => {
    vi.useFakeTimers();
    try {
      const { server } = createServer();
      const origin = createClientWithConnection("panel:nav-a", "conn-1");
      const target = createClientWithConnection("panel:nav-b", "target-conn");
      registerClient(server, origin);
      registerClient(server, target);

      handleRoute(server, origin, "panel:nav-b", {
        type: "request",
        requestId: "req-stranded",
        fromId: "panel:nav-a",
        method: "test.method",
        args: [],
      });
      // Delivered to the callee — inbox replay / re-drive can no longer help.
      expect(target.ws.send).toHaveBeenCalledTimes(1);

      testServer(server).handleClose(target, 1006, "network");
      await vi.advanceTimersByTimeAsync(3001);

      const originMessages = (origin.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw as string) as { type: string }
      );
      expect(originMessages.filter((m) => m.type === "ws:routed-response-error")).toHaveLength(1);
      expect(originMessages.find((m) => m.type === "ws:routed-response-error")).toMatchObject({
        type: "ws:routed-response-error",
        targetId: "panel:nav-b",
        requestId: "req-stranded",
        error: "Target panel:nav-b did not reconnect within grace window",
        errorCode: "RECONNECT_GRACE_EXPIRED",
      });

      // A late response after teardown must NOT settle the caller a second
      // time — the origin entry was consumed; the responder gets the bounce.
      handleRoute(server, target, "panel:nav-a", {
        type: "response",
        requestId: "req-stranded",
        result: { ok: true },
      });
      await vi.advanceTimersByTimeAsync(1);
      const originAfter = (origin.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw as string) as { type: string }
      );
      expect(originAfter.filter((m) => m.type === "ws:routed")).toHaveLength(0);
      const responderBounce = (target.ws.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([raw]) => JSON.parse(raw as string) as { type: string })
        .find((m) => m.type === "ws:routed-response-error");
      expect(responderBounce).toMatchObject({ errorCode: "TARGET_NOT_REACHABLE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not error delivered routed requests when the callee reconnects within grace", async () => {
    vi.useFakeTimers();
    try {
      const { server, grantPanel, runtimeCoordinator } = createServer();
      const origin = createClientWithConnection("panel:nav-a", "conn-1");
      const target = createClientWithConnection("panel:nav-b", "target-conn");
      registerClient(server, origin);
      registerClient(server, target);

      handleRoute(server, origin, "panel:nav-b", {
        type: "request",
        requestId: "req-survives",
        fromId: "panel:nav-a",
        method: "test.method",
        args: [],
      });
      expect(target.ws.send).toHaveBeenCalledTimes(1);

      // Transient pipe-down: the callee resumes the SAME connectionId within
      // the grace window (resubscribe) — the pending must be left alone.
      testServer(server).handleClose(target, 1006, "network");
      const reconnectedWs = createTestWs();
      runtimeCoordinator.acquire("panel:nav-b", {
        slotId: "panel:tree/slot-b",
        clientSessionId: "test-desktop",
        connectionId: "target-conn",
      });
      testServer(server).handleAuth(reconnectedWs, grantPanel("panel:nav-b"), "target-conn");
      await vi.advanceTimersByTimeAsync(3001);

      const originMessages = (origin.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw as string) as { type: string }
      );
      expect(originMessages.filter((m) => m.type === "ws:routed-response-error")).toHaveLength(0);

      // The callee's (replayed/re-driven) response still reaches the caller.
      handleRoute(server, createClientWithConnection("panel:nav-b", "target-conn"), "panel:nav-a", {
        type: "response",
        requestId: "req-survives",
        result: { ok: true },
      });
      await vi.advanceTimersByTimeAsync(1);
      const routed = (origin.ws.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([raw]) => JSON.parse(raw as string) as { type: string })
        .find((m) => m.type === "ws:routed");
      expect(routed).toMatchObject({
        type: "ws:routed",
        envelope: {
          message: { type: "response", requestId: "req-survives", result: { ok: true } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the caller exactly once when a response races callee teardown", async () => {
    vi.useFakeTimers();
    try {
      const { server } = createServer();
      const origin = createClientWithConnection("panel:nav-a", "conn-1");
      const target = createClientWithConnection("panel:nav-b", "target-conn");
      registerClient(server, origin);
      registerClient(server, target);

      handleRoute(server, origin, "panel:nav-b", {
        type: "request",
        requestId: "req-race",
        fromId: "panel:nav-a",
        method: "test.method",
        args: [],
      });

      // Response lands during the grace window, BEFORE terminal expiry: it
      // consumes the origin entry, so expiry must not produce a second settle.
      testServer(server).handleClose(target, 1006, "network");
      handleRoute(server, target, "panel:nav-a", {
        type: "response",
        requestId: "req-race",
        result: { ok: true },
      });
      await vi.advanceTimersByTimeAsync(3001);

      const originMessages = (origin.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw as string) as { type: string }
      );
      expect(originMessages.filter((m) => m.type === "ws:routed")).toHaveLength(1);
      expect(originMessages.filter((m) => m.type === "ws:routed-response-error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes events between unrelated authenticated panels", () => {
    const { server } = createServer();
    const client = createClient();
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, target);

    handleRoute(server, client, "panel:nav-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(client.ws.send).not.toHaveBeenCalled();
    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("delivers a routed event to a connectionless DO target via postToDO (no silent drop)", async () => {
    const { server } = createServer();
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // A connectionless DO participant (e.g. an EvalDO subscribed to a channel via
    // connectViaRpc) holds NO ws connection. Pre-fix, this event was silently dropped
    // (getCallerConnections empty → the WS loop no-ops), hanging the subscriber.
    handleRoute(server, createClient(), "do:vibez1/internal:EvalDO:k", {
      type: "event",
      fromId: "panel:nav-a",
      event: "channel:message",
      payload: { hello: "world" },
    });

    // Fire-and-forget HTTP delivery — assert the postToDO actually happened.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("EvalDO");
    const body = String((init as RequestInit | undefined)?.body ?? "");
    expect(body).toContain("channel:message");
    expect(body).toContain("world");
  });

  it("routes stable panel slot events to the current runtime entity connection", () => {
    const { server, runtimeCoordinator } = createServer();
    runtimeCoordinator.acquire("panel:nav-b", {
      slotId: "panel:tree/slot-b",
      clientSessionId: "test-desktop",
      connectionId: "target-conn",
    });
    const client = createClient();
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, target);

    handleRoute(server, client, "panel:tree/slot-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("routes stable panel slot RPC calls to the current runtime entity bridge", async () => {
    const { server, grantPanel, runtimeCoordinator } = createServer();
    runtimeCoordinator.acquire("panel:nav-b", {
      slotId: "panel:tree/slot-b",
      clientSessionId: "test-desktop",
      connectionId: "target-conn",
    });
    const targetWs = createTestWs();
    testServer(server).handleAuth(targetWs, grantPanel("panel:nav-b"), "target-conn");

    const relay = testServer(server).relayCall(
      "do:channel",
      "do",
      "panel:tree/slot-b",
      "onMethodCall",
      ["channel-1", "call-1", "eval", { code: "1 + 1" }],
      undefined,
      { idempotencyKey: "idem-1", readOnly: true }
    );

    const sent = targetWs.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find(
        (message) => message.type === "ws:rpc" && message.envelope?.message?.type === "request"
      ) as { envelope: RpcEnvelope } | undefined;
    expect(sent).toMatchObject({
      type: "ws:rpc",
      envelope: {
        delivery: { idempotencyKey: "idem-1", readOnly: true },
        message: { method: "onMethodCall" },
      },
    });
    expect(sent).not.toHaveProperty("message");
    expect(sent?.envelope.message).not.toHaveProperty("idempotencyKey");
    expect(sent?.envelope.message).not.toHaveProperty("readOnly");
    expect(sent).toBeTruthy();

    const responseMessage: RpcMessage = {
      type: "response",
      requestId: sent!.envelope.message.type === "request" ? sent!.envelope.message.requestId : "",
      result: { ok: true },
    };
    targetWs.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("panel:nav-b", "server", "panel", responseMessage),
    });

    await expect(relay).resolves.toEqual({ ok: true });
  });

  it("throws TARGET_NOT_REACHABLE when a panel target is disconnected", async () => {
    const { server } = createServer();

    await expect(
      testServer(server).relayCall("panel:nav-a", "panel", "panel:nav-b", "test.method", [])
    ).rejects.toMatchObject({
      message: "Target not reachable: panel:nav-b",
      code: "TARGET_NOT_REACHABLE",
    });
  });

  it("preserves reconnect grace expiry on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
    deferred.reject(
      Object.assign(new Error("Client did not reconnect within grace window"), {
        code: "RECONNECT_GRACE_EXPIRED",
      })
    );

    await expect(relay).rejects.toMatchObject({
      message: "Target panel:nav-b did not reconnect within grace window",
      code: "RECONNECT_GRACE_EXPIRED",
    });
  });

  it("preserves server shutdown on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
    deferred.reject(
      Object.assign(new Error("Server shutting down"), {
        code: "SERVER_SHUTTING_DOWN",
      })
    );

    await expect(relay).rejects.toMatchObject({
      message: "Server shutting down",
      code: "SERVER_SHUTTING_DOWN",
    });
  });

  it("throws an invariant error when a reconnect waiter resolves without a client", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
    deferred.resolve();

    await expect(relay).rejects.toThrow(
      "Invariant violated: reconnect waiter resolved for panel:nav-b but no client found"
    );
  });

  it("surfaces response relay failures with ws:routed-response-error", async () => {
    const { server } = createServer();
    const client = createClient();

    handleRoute(server, client, "panel:nav-b", {
      type: "response",
      requestId: "req-123",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((client.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed-response-error",
      targetId: "panel:nav-b",
      requestId: "req-123",
      error: "Target not reachable: panel:nav-b",
      errorCode: "TARGET_NOT_REACHABLE",
    });
  });
});

describe("RpcServer caller identity", () => {
  function rpcRequest(requestId: string, method: string) {
    return {
      type: "request" as const,
      requestId,
      fromId: "test",
      method,
      args: [],
    };
  }

  function sentResponse(client: WsClientState) {
    const calls = (client.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const raw = calls[calls.length - 1]![0] as string;
    return JSON.parse(raw) as { envelope: { message: { result?: unknown; error?: string } } };
  }

  it("rejects WS authentication for the reserved in-process shell caller id", () => {
    const { server, tokenManager } = createServer();
    const shellToken = tokenManager.createToken("shell", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, shellToken, "conn-shell");

    expect(ws.close).toHaveBeenCalledWith(4006, expect.stringContaining("shell"));
    expect(testServer(server).connections.getCallerConnections("shell")).toHaveLength(0);
  });

  it("accepts WS authentication for concrete shell host callers", () => {
    const { server, tokenManager } = createServer();
    const remoteToken = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, remoteToken, "conn-shell-host");

    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("accepts WS authentication when a connection grant resolves to a shell host principal", () => {
    const { server, connectionGrants, entityCache } = createServer();
    entityCache._onActivate(makeRecord("electron-main", "shell"));
    const grant = connectionGrants.grant("electron-main", "shell:test").token;
    const ws = createTestWs();

    testServer(server).handleAuth(ws, grant, "conn-grant");
    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("rejects WS authentication when a connection grant has no runtime entity kind", () => {
    const { server, connectionGrants, entityCache } = createServer();
    const principal = makeRecord("missing-principal", "app");
    entityCache._onActivate(principal);
    const grant = connectionGrants.grant(principal.id, "shell:test").token;
    entityCache._onRetire({ ...principal, status: "retired", retiredAt: Date.now() });
    const ws = createTestWs();

    testServer(server).handleAuth(ws, grant, "conn-missing-principal");

    expect(ws.close).toHaveBeenCalledWith(4006, "Invalid token");
    expect(testServer(server).connections.getCallerConnections("missing-principal")).toHaveLength(
      0
    );
  });

  it("denies worker callers for shell-only methods", async () => {
    const { server } = createServer();
    const client = createClient("worker-1");
    client.caller = createVerifiedCaller("worker-1", "worker");
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue({ allowed: ["shell"] });

    await handleRpc(server, client, rpcRequest("req-3", "internal.shellOnly"));

    expect(testServer(server).dispatcher.dispatch).not.toHaveBeenCalled();
    expect(sentResponse(client).envelope.message.error).toContain(
      "not accessible to worker callers"
    );
  });

  it("dispatches server callers using their own server identity", async () => {
    const { server } = createServer();
    const client = createClient("server");
    client.caller = createVerifiedCaller("server", "server");
    const dispatched: unknown[] = [];
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await handleRpc(server, client, rpcRequest("req-4", "internal.ping"));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: client.caller.runtime.id, kind: "server" } },
    });
    expect(sentResponse(client).envelope.message.result).toEqual({ ok: true });
  });

  it("preserves app chain caller attribution for extension parent invocations", async () => {
    const { server } = createServer({
      resolveExtensionInvocation: vi.fn(() => ({
        caller: {
          callerId: "@workspace-apps/shell",
          callerKind: "app" as const,
        },
      })),
    });
    const client = createClient("@workspace-extensions/tools");
    client.caller = createVerifiedCaller("@workspace-extensions/tools", "extension");
    const dispatched: unknown[] = [];
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["extension"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await handleRpc(server, client, {
      ...rpcRequest("req-app-chain", "workspace.getInfo"),
      parentInvocationToken: "inv-app",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: "@workspace-extensions/tools", kind: "extension" } },
      chainCaller: {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "",
        effectiveVersion: "",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// §1.6 uploads — inbound request bodies on the bulk channel
// ---------------------------------------------------------------------------

describe("RpcServer attachWebRtcPipe — inbound request bodies (§1.6)", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  /** Attach a pipe with a captured shim and an open session + body stream-open. */
  function setupUpload(opts: { bodyStreamId?: number; requestId?: string } = {}) {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });
    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: opts.bodyStreamId ?? 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: opts.requestId ?? "up-1",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    return { server, shim: shim!, p };
  }

  it("assembles DATA…END bulk frames into the request body stream (single take)", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1");
    expect(body).toBeDefined();
    expect(shim.takeInboundBody("up-1")).toBeUndefined(); // single consumption

    p.emitBulk(8, FRAME_DATA, utf8("hello "));
    p.emitBulk(8, FRAME_DATA, utf8("world"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 11 })));
    await expect(readAll(body!)).resolves.toBe("hello world");
  });

  it("an ERROR bulk frame errors the body with the client's message + code", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("partial"));
    p.emitBulk(
      8,
      FRAME_ERROR,
      utf8(JSON.stringify({ message: "upload died", code: "UPLOAD_ABORTED" }))
    );
    await expect(readAll(body)).rejects.toMatchObject({
      message: "upload died",
      code: "UPLOAD_ABORTED",
    });
  });

  it("errors the body loudly past 8 MiB unconsumed (SCTP can't be paused)", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 9; i++) p.emitBulk(8, FRAME_DATA, chunk); // 9 MiB, nothing consumed
    await expect(readAll(body)).rejects.toThrow(/receive buffer/);
    // Late frames for the errored stream drop silently (no throw, no revival).
    p.emitBulk(8, FRAME_DATA, chunk);
  });

  it("bytes the consumer has read do NOT count against the cap", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    const reader = body.getReader();
    const chunk = new Uint8Array(1024 * 1024);
    // 24 MiB total, but consumed as it arrives — never near the cap.
    for (let i = 0; i < 24; i++) {
      p.emitBulk(8, FRAME_DATA, chunk);
      const { value } = await reader.read();
      expect(value!.byteLength).toBe(chunk.byteLength);
    }
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 24 * 1024 * 1024 })));
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("pipe-down errors every unfinished body (teardown, no leaks)", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("half-"));
    p.emitDown("ICE failed");
    await expect(readAll(body)).rejects.toThrow(/upload/);
    // A frame arriving after teardown routes nowhere (registry cleaned).
    p.emitBulk(8, FRAME_DATA, utf8("late"));
  });

  it("reaps the body when the response settles (END/ERROR emitted) before the upload finished", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("still-uploading"));
    // The producer path emits the response END — the request is over.
    const written = shim.sendStreamFrame("up-1", FRAME_END, utf8(JSON.stringify({ bytesIn: 0 })));
    expect(written).not.toBe(false);
    await expect(readAll(body)).rejects.toThrow(/request settled/);
  });

  it("a session close errors its inbound bodies", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.sendControl({ t: "close", sid: "s1", code: 1000, reason: "bye" });
    await expect(readAll(body)).rejects.toThrow(/upload/);
  });

  it("a stream-open WITHOUT bodyStreamId registers no body", () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });
    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "no-body",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x" }],
      }),
    });
    expect(shim!.takeInboundBody("no-body")).toBeUndefined();
    // Bulk frames for an id with no body sit in the pre-open buffer (no throw)
    // and are TTL-reaped if the open never comes.
    p.emitBulk(99, FRAME_DATA, new TextEncoder().encode("void"));
  });

  // -- OPEN/DATA cross-channel race (control and bulk are independent SCTP
  //    streams: the client sends stream-open first, but DATA can ARRIVE first).

  it("buffers DATA/END arriving BEFORE the stream-open and completes the body intact", async () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    // The whole upload beats its stream-open across the channel boundary.
    p.emitBulk(8, FRAME_DATA, utf8("early "));
    p.emitBulk(8, FRAME_DATA, utf8("bird"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 10 })));

    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-1",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const body = shim!.takeInboundBody("up-1")!;
    await expect(readAll(body)).resolves.toBe("early bird");
  });

  it("flushes pre-open frames ahead of post-open frames, preserving order", async () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    // Only the LEADING frame raced ahead of the open.
    p.emitBulk(8, FRAME_DATA, utf8("lead-"));
    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-1",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    p.emitBulk(8, FRAME_DATA, utf8("tail"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 9 })));
    const body = shim!.takeInboundBody("up-1")!;
    await expect(readAll(body)).resolves.toBe("lead-tail");
  });

  it("errors the body when END's bytesIn disagrees with the received count (lost DATA)", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("only-half"));
    // Sender counted 18 bytes out; only 9 arrived — must fail, never truncate.
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 18 })));
    await expect(readAll(body)).rejects.toThrow(/truncated.*declared 18 bytes, received 9/);
  });

  it("errors the body on an END frame with no bytesIn (protocol violation)", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("data"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({})));
    await expect(readAll(body)).rejects.toThrow(/no bytesIn/);
  });

  it("TTL-reaps pre-open frames for a never-opened stream, then fails a pathologically late open loud", async () => {
    vi.useFakeTimers();
    try {
      const { server } = createServer();
      let shim: SessionWebSocketShim | undefined;
      testServer(server).handleConnection = vi.fn((ws: unknown) => {
        shim = ws as SessionWebSocketShim;
      });
      const p = createFakePipe();
      server.attachWebRtcPipe(p.pipe);
      p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

      p.emitBulk(8, FRAME_DATA, utf8("orphaned"));
      vi.advanceTimersByTime(5001); // UPLOAD_PREOPEN_TTL_MS — frames discarded
      // Frames after expiry drop against the condemnation marker (no regrowth).
      p.emitBulk(8, FRAME_DATA, utf8("more"));

      // If the open DOES arrive after expiry, the body must fail loudly —
      // its leading bytes are gone, completing would silently truncate.
      p.sendControl({
        t: "stream-open",
        sid: "s1",
        streamId: 7,
        bodyStreamId: 8,
        envelope: makeEnvelope("panel:c1", "main", "panel", {
          type: "stream-request",
          requestId: "up-1",
          fromId: "panel:c1",
          method: "gateway.fetch",
          args: [{ path: "/x", method: "POST" }],
        }),
      });
      const body = shim!.takeInboundBody("up-1")!;
      await expect(readAll(body)).rejects.toThrow(/expired.*before its stream-open/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("condemns a pre-open buffer past 8 MiB and fails the eventual open loud", async () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 9; i++) p.emitBulk(8, FRAME_DATA, chunk); // 9 MiB pre-open

    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-1",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const body = shim!.takeInboundBody("up-1")!;
    await expect(readAll(body)).rejects.toThrow(/pre-open buffer/);
  });

  it("frames pumped after the body settles drop (retired id) instead of buffering as pre-open", async () => {
    const { shim, p } = setupUpload();
    const body = shim.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("all"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 3 })));
    await expect(readAll(body)).resolves.toBe("all");
    // Late frames for the settled id drop silently — no pre-open buffer growth,
    // no throw.
    p.emitBulk(8, FRAME_DATA, utf8("late"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 4 })));
  });

  it("does not carry retired body ids across pipe down and session reopen", async () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });
    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-1",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const firstBody = shim!.takeInboundBody("up-1")!;
    p.emitBulk(8, FRAME_DATA, utf8("old"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 3 })));
    await expect(readAll(firstBody)).resolves.toBe("old");

    p.emitDown("ICE failed");
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c2" });

    // A fresh client transport starts body stream ids from 1 again. If the old
    // retired-id map survived pipe-down, these early frames would be dropped
    // before the new stream-open arrives.
    p.emitBulk(8, FRAME_DATA, utf8("new"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 3 })));
    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 9,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-2",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });

    const secondBody = shim!.takeInboundBody("up-2")!;
    await expect(readAll(secondBody)).resolves.toBe("new");
  });
});

describe("RpcServer stream-request dispatch — body threading (§1.6)", () => {
  function bodyStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  }

  function streamRequest(requestId: string, method: string, args: unknown[] = []): RpcMessage {
    return { type: "stream-request", requestId, fromId: "panel:nav-a", method, args };
  }

  function setupStreamingServer(opts: Parameters<typeof createServer>[0] = {}) {
    const created = createServer(opts);
    const dispatcher = testServer(created.server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    return { ...created, dispatcher };
  }

  it("threads the shim-assembled body into the parsed-service ServiceContext", async () => {
    const { server, dispatcher } = setupStreamingServer();
    let seenBody: unknown;
    dispatcher.dispatch.mockImplementation(async (ctx: { body?: unknown }) => {
      seenBody = ctx.body;
      return new Response("ok", { status: 200 });
    });

    const client = createClient();
    const body = bodyStream("upload");
    (client.ws as unknown as Record<string, unknown>)["sendStreamFrame"] = vi.fn(() =>
      Promise.resolve()
    );
    const takeInboundBody = vi.fn((requestId: string) =>
      requestId === "sr-up" ? body : undefined
    );
    (client.ws as unknown as Record<string, unknown>)["takeInboundBody"] = takeInboundBody;

    await handleRpc(server, client, streamRequest("sr-up", "gateway.fetch", [{ path: "/x" }]));

    expect(takeInboundBody).toHaveBeenCalledWith("sr-up");
    expect(seenBody).toBe(body);
  });

  it("passes the inbound body to forwardProxyFetchStream for credentials.proxyFetch", async () => {
    const forward = vi.fn(
      async (
        _params: unknown,
        sink: (frame: { kind: string; [k: string]: unknown }) => Promise<void> | void
      ) => {
        await sink({ kind: "head", status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        await sink({ kind: "end", bytesIn: 0 });
        return { status: 200, bytesIn: 0 };
      }
    );
    const { server, dispatcher } = setupStreamingServer({
      egressProxy: { forwardProxyFetchStream: forward } as never,
    });
    dispatcher.getMethodSchema = vi.fn().mockReturnValue(undefined);

    const client = createClient();
    const body = bodyStream("proxied-upload");
    (client.ws as unknown as Record<string, unknown>)["sendStreamFrame"] = vi.fn(() =>
      Promise.resolve()
    );
    (client.ws as unknown as Record<string, unknown>)["takeInboundBody"] = vi.fn(() => body);

    await handleRpc(
      server,
      client,
      streamRequest("sr-px", "credentials.proxyFetch", [
        { url: "https://api.example/upload", method: "POST" },
      ])
    );

    expect(forward).toHaveBeenCalledTimes(1);
    expect((forward.mock.calls[0]![0] as { body?: unknown }).body).toBe(body);
  });

  it("rejects a proxyFetch that declares BOTH a streamed body and an args body (fail loud)", async () => {
    const forward = vi.fn();
    const { server } = setupStreamingServer({
      egressProxy: { forwardProxyFetchStream: forward } as never,
    });

    const client = createClient();
    const sends: Array<{ type: number; payload: Uint8Array }> = [];
    (client.ws as unknown as Record<string, unknown>)["sendStreamFrame"] = vi.fn(
      (_requestId: string, frameType: number, payload: Uint8Array) => {
        sends.push({ type: frameType, payload });
        return Promise.resolve();
      }
    );
    (client.ws as unknown as Record<string, unknown>)["takeInboundBody"] = vi.fn(() =>
      bodyStream("streamed")
    );

    await handleRpc(
      server,
      client,
      streamRequest("sr-both", "credentials.proxyFetch", [
        { url: "https://api.example/upload", method: "POST", body: "args-body" },
      ])
    );

    expect(forward).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.type).toBe(FRAME_ERROR);
    expect(new TextDecoder().decode(sends[0]!.payload)).toContain("exactly one");
  });

  it("plain WS (no takeInboundBody) dispatches with no ctx.body — wire unchanged", async () => {
    const { server, dispatcher } = setupStreamingServer();
    let seenBody: unknown = "unset";
    dispatcher.dispatch.mockImplementation(async (ctx: { body?: unknown }) => {
      seenBody = ctx.body;
      return new Response("ok", { status: 200 });
    });
    const client = createClient();
    await handleRpc(server, client, streamRequest("sr-ws", "gateway.fetch", [{ path: "/x" }]));
    expect(seenBody).toBeUndefined();
  });
});
