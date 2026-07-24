import { afterEach, describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { RpcServer } from "./rpcServer.js";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WsClientState } from "./rpcServer/connectionRegistry.js";
import {
  createVerifiedCaller,
  type CallerKind,
  type ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { envelopeFromMessage, type RpcEnvelope, type RpcMessage } from "@vibestudio/rpc";
import type { AttestedCaller } from "@vibestudio/rpc/internal";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
} from "@vibestudio/rpc/protocol/streamCodec";
import {
  decodeControlFrame,
  encodeControlFrame,
  SESSION_NOT_OPEN_CLOSE_CODE,
  type SessionControlFrame,
} from "@vibestudio/rpc/protocol/sessionNegotiation";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { SessionWebSocketShim, type PipeChannels } from "./webrtcSessionShim.js";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { EventService } from "@vibestudio/shared/eventsService";

function makeRecord(
  id: string,
  kind: EntityKind,
  opts?: {
    contextId?: string;
    repoPath?: string;
    effectiveVersion?: string;
    agentBinding?: EntityRecord["agentBinding"];
    activeBuildKey?: string;
    activeExecutionDigest?: string;
    activeAuthority?: EntityRecord["activeAuthority"];
  }
): EntityRecord {
  const executable = kind === "panel" || kind === "app" || kind === "worker" || kind === "do";
  return {
    id,
    kind,
    source: {
      repoPath: opts?.repoPath ?? "",
      effectiveVersion: opts?.effectiveVersion ?? "",
    },
    contextId: opts?.contextId ?? "",
    ...(opts?.agentBinding ? { agentBinding: opts.agentBinding } : {}),
    ...(opts?.activeBuildKey
      ? { activeBuildKey: opts.activeBuildKey }
      : executable
        ? { activeBuildKey: `build:${id}` }
        : {}),
    ...(opts?.activeExecutionDigest
      ? { activeExecutionDigest: opts.activeExecutionDigest }
      : executable
        ? { activeExecutionDigest: "a".repeat(64) }
        : {}),
    ...(opts?.activeAuthority
      ? { activeAuthority: opts.activeAuthority }
      : executable
        ? { activeAuthority: { requests: [] } }
        : {}),
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

type MockDispatcher = ServiceDispatcher & {
  dispatch: ReturnType<typeof vi.fn>;
  assertAuthority: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
  getMethodPolicy: ReturnType<typeof vi.fn>;
};

type TestRpcServer = {
  dispatcher: MockDispatcher;
  connections: {
    addClient(client: WsClientState): void;
    removeClient(client: WsClientState): boolean;
    getCallerConnections(callerId: string): WsClientState[];
  };
  sessions: { hasSession(callerId: string): boolean };
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingAuthentications: Map<unknown, ReturnType<typeof setTimeout> | null>;
  verifiedCallerFor(
    callerId: string,
    callerKind: CallerKind,
    agentBinding?: undefined,
    subject?: undefined,
    inheritedTestPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy | null
  ): ReturnType<typeof createVerifiedCaller>;
  beginAuthorityParent(
    receiverRuntimeId: string,
    authorization: import("@vibestudio/rpc/internal").DirectAuthorityAttestation
  ): () => void;
  testPolicyFromAuthorityParent(
    callerRuntimeId: string,
    authorityParentNonce: string | undefined
  ): import("@vibestudio/rpc").AgentExecutionTestPolicy | null;
  connectionReconnectWaiters: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
  reconnectWaiters: Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }
  >;
  handleAuth(ws: unknown, token: string | null, connectionId: string): Promise<void>;
  handleConnection(ws: unknown): void;
  handleMessage(client: WsClientState, data: Buffer): void;
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
  directDOAuthorization(input: {
    caller: ReturnType<typeof createVerifiedCaller>;
    ref: { source: string; className: string; objectKey: string };
    method: string;
    args: readonly unknown[];
    readOnly?: boolean;
    waitForAuthority?: boolean;
    signal?: AbortSignal;
  }): Promise<import("@vibestudio/rpc/internal").DirectAuthorityAttestation>;
  streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response>;
  relayTargetStream(
    caller: ReturnType<typeof createVerifiedCaller>,
    envelope: RpcEnvelope,
    request: Extract<RpcMessage, { type: "stream-request" }>,
    causalParent: import("@vibestudio/rpc").RpcCausalParent | undefined,
    signal: AbortSignal
  ): Promise<Response>;
  streamingRelay: {
    cancel(client: WsClientState, requestId: string): void;
  };
  checkRelayAuth(
    callerId: string,
    callerKind: string,
    targetId: string,
    method?: string
  ): { ok: boolean; reason?: string };
  sendToWs(ws: unknown, msg: unknown): void;
  resolveCausalParent(
    caller: ReturnType<typeof createVerifiedCaller>,
    message: {
      causalParent?: import("@vibestudio/rpc").RpcCausalParent;
      parentRequestId?: string;
    }
  ): Promise<import("@vibestudio/rpc").RpcCausalParent | undefined>;
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
    assertAuthority: vi.fn().mockResolvedValue(undefined),
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
      workspaceId: "test-workspace",
      entityCache,
      connectionGrants,
      runtimeCoordinator,
      // WP4 §5.2: connection admission now resolves each caller's owning user via
      // userSubjectSource (hub-backed in production, "fakeable in tests" per its
      // contract). Panel lineage callers resolve to their owner; bootstrap
      // principals (server/electron-main/headless-host) stay subject-less and are
      // mapped to the synthetic system user by assertBootstrapSubject.
      userSubjectSource: {
        resolve: (_callerId: string, callerKind: CallerKind) =>
          callerKind === "panel" || callerKind === "extension"
            ? { userId: "user-1", handle: "user1" }
            : null,
      },
      resolveExtensionCodeIdentity: (callerId: string) =>
        callerId.startsWith("@workspace-extensions/")
          ? {
              callerId,
              callerKind: "extension" as const,
              repoPath: callerId.slice("@workspace-extensions/".length),
              effectiveVersion: "ev-test",
            }
          : null,
      verifyExactCausalInvocation: async () => true,
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
    // Mirror of caller.subject?.userId (WsClientState, WP4 §2.1), stamped at
    // admission. These panel connections model one owning user in these tests.
    userId: "user-1",
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

describe("RpcServer attachWebRtcPipe — negative handshake fails closed (un-authed open)", () => {
  // A redeemer that (like the real transport-specific redeemers) assumes a string token
  // — its presence proves the missing/non-string-token guard runs BEFORE any
  // downstream string operation (`token.startsWith(...)`) that would otherwise
  // throw uncaught / into a swallowing catch that strands the session.
  const stringAssumingRedeemer = ((token: string) => {
    if (token.startsWith("refresh:") || token.startsWith("agent:")) return null;
    return null;
  }) as unknown as ConstructorParameters<typeof RpcServer>[0]["redeemPairingCredential"];

  it("an open with a MISSING token yields open-result success:false terminal:true and never throws", () => {
    const { server } = createServer({ redeemPairingCredential: stringAssumingRedeemer });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    // decodeControlFrame requires only `sid`, not `token` — a missing token must
    // fail closed at the handshake, never throw into the pipe.
    expect(() =>
      p.sendControl({ t: "open", sid: "s1" } as unknown as SessionControlFrame)
    ).not.toThrow();

    const openResult = p.controlOfType("open-result");
    expect(openResult).toHaveLength(1);
    expect(openResult[0]!.frame).toMatchObject({
      t: "open-result",
      sid: "s1",
      success: false,
      terminal: true,
    });
  });

  it("an open with a non-string token yields open-result success:false terminal:true and never throws", () => {
    const { server } = createServer({ redeemPairingCredential: stringAssumingRedeemer });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    expect(() =>
      p.sendControl({ t: "open", sid: "s1", token: 42 } as unknown as SessionControlFrame)
    ).not.toThrow();
    expect(p.controlOfType("open-result")[0]!.frame).toMatchObject({
      success: false,
      terminal: true,
    });
  });

  it("an open with an INVALID (unknown) token yields open-result success:false terminal:true", async () => {
    const { server } = createServer({ redeemPairingCredential: stringAssumingRedeemer });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    p.sendControl({ t: "open", sid: "s1", token: "not-a-real-grant" });
    await flushAsync();
    expect(p.controlOfType("open-result")[0]!.frame).toMatchObject({
      success: false,
      terminal: true,
    });
  });

  it("caps concurrent logical sessions per pipe (pre-auth flood backstop)", () => {
    const { server } = createServer();
    // Stub handleConnection so opens accumulate shims without real auth work.
    const stub = vi.fn(() => {});
    testServer(server).handleConnection = stub;
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);

    const CAP = 512; // matches RpcServer.MAX_SESSIONS_PER_PIPE
    for (let i = 0; i < CAP; i++) {
      p.sendControl({ t: "open", sid: `s${i}`, token: "grant" });
    }
    // Up to the cap, opens are accepted (handleConnection stubbed → no result).
    expect(p.controlOfType("open-result")).toHaveLength(0);
    // The (cap+1)th DISTINCT sid is refused with a terminal open-result…
    p.sendControl({ t: "open", sid: "over", token: "grant" });
    const rejected = p.controlOfType("open-result");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.frame).toMatchObject({ sid: "over", success: false, terminal: true });
    // …and handleConnection was NOT driven for the refused open.
    expect(stub).toHaveBeenCalledTimes(CAP);
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

  it("returns a body-less panel bridge stream on its envelope lane", async () => {
    const { server, dispatcher } = setupStreamingServer();
    dispatcher.dispatch.mockResolvedValue(new Response("hello!", { status: 200 }));

    const control: SessionControlFrame[] = [];
    const bulk: Array<{ streamId: number; type: number; payload: Uint8Array }> = [];
    const shim = new SessionWebSocketShim(
      "panel-session",
      {
        writeControl: (bytes) => {
          control.push(decodeControlFrame(new TextDecoder().decode(bytes)));
          return Promise.resolve();
        },
        writeBulkFrame: (streamId, type, payload) => {
          bulk.push({ streamId, type, payload });
          return Promise.resolve();
        },
        dropBulkStream: () => {},
        bulkPendingBytes: () => 0,
      },
      () => {}
    );
    const client = createClient();
    client.ws = shim as unknown as WebSocket;

    await handleRpc(server, client, streamRequest("bridge-stream"));

    const frames = control
      .filter((frame): frame is Extract<SessionControlFrame, { t: "rpc" }> => frame.t === "rpc")
      .map((frame) => frame.envelope.message)
      .filter((message) => message.type === "stream-frame");
    expect(frames.map((frame) => frame.frameType)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_END]);
    expect(Buffer.from(frames[1]!.payload, "base64").toString()).toBe("hello!");
    expect(bulk).toHaveLength(0);
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

  it("an abrupt close cancels only that connection generation's active streams", async () => {
    const { server, dispatcher } = setupStreamingServer();
    let oldCancelled = false;
    let replacementCancelled = false;
    const stalledResponse = (onCancel: () => void) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("open"));
          },
          cancel: onCancel,
        })
      );
    dispatcher.dispatch
      .mockResolvedValueOnce(stalledResponse(() => (oldCancelled = true)))
      .mockResolvedValueOnce(stalledResponse(() => (replacementCancelled = true)));

    // A reconnect may preserve its logical connection id while replacing the
    // concrete socket/session object. Stream ownership follows that concrete
    // generation, not the reusable route label.
    const oldClient = createClientWithConnection("panel:nav-a", "conn-stable");
    const replacement = createClientWithConnection("panel:nav-a", "conn-stable");
    const oldDone = handleRpc(server, oldClient, streamRequest("old-stream"));
    const replacementDone = handleRpc(server, replacement, streamRequest("new-stream"));
    await flushAsync();

    testServer(server).handleClose(oldClient, 1006, "ICE failed");
    await oldDone;
    expect(oldCancelled).toBe(true);
    expect(replacementCancelled).toBe(false);

    testServer(server).handleClose(replacement, 1006, "replacement closed");
    await replacementDone;
    expect(replacementCancelled).toBe(true);
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

    testServer(server).sendToWs(shim, {
      type: "ws:routed",
      envelope: {
        from: "main",
        target: "panel:test",
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [{ callerId: "main", callerKind: "server" }],
        message: { type: "event", fromId: "main", event: "test", payload: 1 },
      },
    });

    expect(shim.readyState).toBe(3); // terminated — the slow session, not the pipe
    expect(control.some((frame) => frame.t === "closed")).toBe(true);
  });
});

describe("RpcServer relay behavior", () => {
  it("routes canonical worker handles through their loader instance name", async () => {
    const { server } = createServer();
    server.setWorkerdUrl("http://127.0.0.1:8787");
    server.setWorkerInstanceResolver((targetId) =>
      targetId === "worker:workers/runtime-fixture:key-with-source" ? "key-with-source" : null
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { type: "response", requestId: "req", fromId: "worker", result: "ok" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      testServer(server).relayCall(
        "panel:nav-a",
        "panel",
        "worker:workers/runtime-fixture:key-with-source",
        "probe",
        []
      )
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/key-with-source/__rpc",
      expect.objectContaining({ method: "POST" })
    );
    await expect(
      testServer(server).relayCall(
        "panel:nav-a",
        "panel",
        "worker:workers/runtime-fixture:retired",
        "probe",
        []
      )
    ).rejects.toThrow("Worker not found: worker:workers/runtime-fixture:retired");
  });

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

    expect(
      testServer(server).checkRelayAuth(
        "main",
        "server",
        "@workspace-extensions/git-bridge",
        "extension.invoke"
      )
    ).toEqual({ ok: true });
  });

  it("composes a host relay boundary with the invariant extension boundary", () => {
    const relayAuthorization = vi.fn(({ targetId }: { targetId: string }) =>
      targetId === "panel:allowed"
        ? ({ ok: true } as const)
        : ({ ok: false, reason: `Host denies relay to ${targetId}` } as const)
    );
    const { server } = createServer({ relayAuthorization });

    expect(
      testServer(server).checkRelayAuth("panel:nav-a", "panel", "panel:allowed", "tools.invoke")
    ).toEqual({ ok: true });
    expect(
      testServer(server).checkRelayAuth(
        "panel:nav-a",
        "panel",
        "do:workers/example:Store:key",
        "tools.invoke"
      )
    ).toEqual({
      ok: false,
      reason: "Host denies relay to do:workers/example:Store:key",
    });

    relayAuthorization.mockClear();
    expect(
      testServer(server).checkRelayAuth(
        "panel:nav-a",
        "panel",
        "@workspace-extensions/git-bridge",
        "extension.invoke"
      )
    ).toEqual({
      ok: false,
      reason: expect.stringContaining("cannot directly relay host-control method"),
    });
    expect(relayAuthorization).not.toHaveBeenCalled();
  });

  it("replaces forged WS route identity with the authenticated panel principal", () => {
    const { server, grantPanel } = createServer();
    const sourceWs = createTestWs();
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, target);
    testServer(server).handleAuth(sourceWs, grantPanel("panel:nav-a"), "conn-1");

    sourceWs.emitMessage({
      type: "ws:route",
      envelope: {
        from: "main",
        target: "panel:nav-b",
        delivery: {
          caller: { callerId: "main", callerKind: "server" },
          idempotencyKey: "idem-forged-route",
          readOnly: true,
        },
        provenance: [{ callerId: "main", callerKind: "server" }],
        message: {
          type: "request",
          requestId: "req-forged-route",
          fromId: "main",
          method: "tools.invoke",
          args: ["publishRepo", []],
        },
      },
    });

    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toEqual({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        target: "panel:nav-b",
        delivery: {
          caller: { callerId: "panel:nav-a", callerKind: "panel", userId: "user-1" },
          idempotencyKey: "idem-forged-route",
          readOnly: true,
        },
        provenance: [{ callerId: "panel:nav-a", callerKind: "panel", userId: "user-1" }],
        message: {
          type: "request",
          requestId: "req-forged-route",
          fromId: "panel:nav-a",
          method: "tools.invoke",
          args: ["publishRepo", []],
        },
      },
    });
  });

  it("replaces forged WS RPC identity before service dispatch and response attribution", async () => {
    const { server, grantPanel } = createServer();
    const sourceWs = createTestWs();
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockResolvedValue({ ok: true });
    testServer(server).handleAuth(sourceWs, grantPanel("panel:nav-a"), "conn-1");

    sourceWs.emitMessage({
      type: "ws:rpc",
      envelope: {
        from: "main",
        target: "main",
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [{ callerId: "main", callerKind: "server" }],
        message: {
          type: "request",
          requestId: "req-forged-rpc",
          fromId: "main",
          method: "workspace.getInfo",
          args: [],
        },
      },
    });

    await vi.waitFor(() => expect(testServer(server).dispatcher.dispatch).toHaveBeenCalled());
    expect(testServer(server).dispatcher.dispatch.mock.calls[0]![0]).toMatchObject({
      caller: { runtime: { id: "panel:nav-a", kind: "panel" } },
    });
    const response = sourceWs.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .find(
        (message) => message.type === "ws:rpc" && message.envelope?.message?.type === "response"
      );
    expect(response).toMatchObject({
      type: "ws:rpc",
      envelope: {
        from: "main",
        target: "panel:nav-a",
        provenance: [{ callerId: "panel:nav-a", callerKind: "panel" }],
        message: { requestId: "req-forged-rpc", result: { ok: true } },
      },
    });
  });

  it("rejects a forged WS relay to an extension host-control method before delivery", () => {
    const { server, grantPanel } = createServer();
    const extensionId = "@workspace-extensions/git-bridge";
    const sourceWs = createTestWs();
    const target = createClientWithConnection(extensionId, "extension-conn");
    target.caller = createVerifiedCaller(extensionId, "extension");
    registerClient(server, target);
    testServer(server).handleAuth(sourceWs, grantPanel("panel:nav-a"), "conn-1");

    sourceWs.emitMessage({
      type: "ws:route",
      envelope: {
        from: "main",
        target: extensionId,
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [{ callerId: "main", callerKind: "server" }],
        message: {
          type: "request",
          requestId: "req-host-control",
          fromId: "main",
          method: "extension.invoke",
          args: ["publishRepo", [{ repoPath: "projects/demo" }]],
        },
      },
    });

    expect(target.ws.send).not.toHaveBeenCalled();
    const rejection = sourceWs.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .find(
        (message) =>
          message.type === "ws:routed" &&
          message.envelope?.message?.requestId === "req-host-control"
      );
    expect(rejection).toMatchObject({
      type: "ws:routed",
      envelope: {
        message: {
          type: "response",
          requestId: "req-host-control",
          errorCode: "EACCES",
          error: expect.stringContaining("cannot directly relay host-control method"),
        },
      },
    });
  });

  it("rejects a forged WS stream relay to an extension host-control method before delivery", async () => {
    const { server, grantPanel } = createServer();
    const extensionId = "@workspace-extensions/git-bridge";
    const sourceWs = createTestWs();
    const target = createClientWithConnection(extensionId, "extension-conn");
    target.caller = createVerifiedCaller(extensionId, "extension");
    registerClient(server, target);
    testServer(server).handleAuth(sourceWs, grantPanel("panel:nav-a"), "conn-1");

    sourceWs.emitMessage({
      type: "ws:route",
      envelope: {
        from: "main",
        target: extensionId,
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [{ callerId: "main", callerKind: "server" }],
        message: {
          type: "stream-request",
          requestId: "stream-host-control",
          fromId: "main",
          method: "extension.invokeStream",
          args: ["publishRepo", [{ repoPath: "projects/demo" }]],
        },
      },
    });

    expect(target.ws.send).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        sourceWs.send.mock.calls
          .map(([raw]) => JSON.parse(String(raw)))
          .find(
            (message) =>
              message.type === "ws:rpc" &&
              message.envelope?.message?.requestId === "stream-host-control"
          )
      ).toBeDefined()
    );
    const rejection = sourceWs.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .find(
        (message) =>
          message.type === "ws:rpc" &&
          message.envelope?.message?.requestId === "stream-host-control"
      );
    expect(rejection).toMatchObject({
      type: "ws:rpc",
      envelope: {
        message: {
          type: "stream-frame",
          requestId: "stream-host-control",
          frameType: FRAME_ERROR,
        },
      },
    });
    expect(JSON.parse(rejection.envelope.message.payload)).toMatchObject({
      status: 403,
      code: "EACCES",
      message: expect.stringContaining("cannot directly relay host-control method"),
    });
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

  it("does not replay a DO relay when the target retires during the failed dispatch", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:workers/example:Store:key";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      entityCache._onRetire({
        ...makeRecord(targetId, "do"),
        status: "retired",
        retiredAt: Date.now(),
      });
      throw fetchError;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testServer(server).relayToDO("panel:nav-a", "panel", targetId, "ping", [])
    ).rejects.toMatchObject({ cause: fetchError });

    expect(entityCache.resolveActive(targetId)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:1111\//);
  });

  it("verifies and preserves an exact causal parent across WS ingress into a DO relay", async () => {
    const verifyExactCausalInvocation = vi.fn(async () => true);
    const { server, entityCache } = createServer({ verifyExactCausalInvocation });
    const targetId = "do:workers/example:Store:key";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          from: targetId,
          target: "main",
          delivery: { caller: { callerId: targetId, callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "do-response", result: { ok: true } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const binding = {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId: "channel:agent",
      agentId: "agent:stable",
      userId: "user:one",
    };
    const client = createClient("do:agents:Agent:one");
    client.caller = createVerifiedCaller(client.caller.runtime.id, "do", null, binding);
    registerClient(server, client);
    const causalParent = {
      kind: "trajectory-invocation" as const,
      ...channelTrajectoryFor(binding.channelId),
      invocationId: "invocation:tool",
    };
    const request: RpcMessage = {
      type: "request",
      requestId: "do-causal-relay",
      fromId: client.caller.runtime.id,
      method: "store.write",
      args: [{ value: 1 }],
      causalParent,
    };

    await testServer(server).handleRoute(
      client,
      targetId,
      request,
      undefined,
      clientEnvelope(client, targetId, request)
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(verifyExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const relayed = JSON.parse(String(init.body)) as { message: { causalParent?: unknown } };
    expect(relayed.message.causalParent).toEqual(causalParent);
  });

  it("projects the host-verified account subject into DO caller attribution", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(
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

    await testServer(server).relayToDO("panel:nav-a", "panel", targetId, "ping", []);

    const envelope = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(envelope.delivery.caller).toMatchObject({
      callerId: "panel:nav-a",
      callerKind: "panel",
      userId: "user-1",
    });
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
      contractVersion: RPC_CONTRACT_VERSION,
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
    handleRoute(server, createClient(), "do:vibestudio/internal:EvalDO:k", {
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

  it("dispatches a routed DO stream through the canonical streaming relay", async () => {
    const { server } = createServer();
    const client = createClient();
    const relayTargetStream = vi
      .spyOn(testServer(server), "relayTargetStream")
      .mockResolvedValue(new Response("streamed", { status: 200 }));
    const request: RpcMessage = {
      type: "stream-request",
      requestId: "routed-stream-1",
      fromId: "panel:nav-a",
      method: "channel.subscribe",
      args: [],
    };

    await handleRoute(server, client, "do:workers/pubsub-channel:PubSubChannel:chat-a", request);

    expect(relayTargetStream).toHaveBeenCalledOnce();
    expect(relayTargetStream.mock.calls[0]?.[1].target).toBe(
      "do:workers/pubsub-channel:PubSubChannel:chat-a"
    );
    const frames = (client.ws.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .filter((message) => message.envelope?.message?.type === "stream-frame")
      .map((message) => message.envelope.message as { frameType: number; payload: string });
    expect(frames.map((frame) => frame.frameType)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_END]);
    expect(Buffer.from(frames[1]!.payload, "base64").toString()).toBe("streamed");
  });

  it("retains the admission-bound sealed panel identity for a routed DO stream", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:workers/pubsub-channel:PubSubChannel:chat-a";
    entityCache._onActivate(
      makeRecord("panel:nav-a", "panel", {
        repoPath: "panels/chat",
        effectiveVersion: "ev-chat",
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: {
          requests: [
            {
              capability: "rpc:subscribe",
              resource: { kind: "prefix", prefix: "" },
              tier: "gated",
              evidence: "intentional-broad",
            },
          ],
        },
      })
    );
    entityCache._onActivate(
      makeRecord(targetId, "do", {
        repoPath: "workers/pubsub-channel",
        effectiveVersion: "ev-channel",
      })
    );
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response("streamed", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    client.caller = createVerifiedCaller("panel:nav-a", "panel", {
      callerId: "panel:nav-a",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-chat",
      executionDigest: "a".repeat(64),
      requested: [{ capability: "rpc:subscribe", resource: { kind: "prefix", prefix: "" } }],
    });
    client.caller.codeApproved = true;
    const request = {
      type: "stream-request" as const,
      requestId: "routed-stream-authority-1",
      fromId: "panel:nav-a",
      method: "subscribe",
      args: ["panel:tree/slot-a", { contextId: "ctx-a" }],
    };
    await handleRoute(server, client, targetId, request);

    const [, init] = fetchMock.mock.calls[0]!;
    const relayed = JSON.parse(String((init as RequestInit).body)) as RpcEnvelope;
    expect((relayed.delivery.caller as AttestedCaller).authorization).toMatchObject({
      audience: targetId,
      method: "subscribe",
      resourceKey: targetId,
      context: {
        authorizingOrigin: {
          kind: "code",
          principal: `code:panels/chat@${"a".repeat(64)}`,
        },
      },
      grants: [
        expect.objectContaining({
          subject: `code:panels/chat@${"a".repeat(64)}`,
          capability: "rpc:subscribe",
        }),
      ],
    });
  });

  it("routes missing critical direct authority through the shared acquisition protocol", async () => {
    const request = vi.fn(() => ({
      acquisitionId: "acq:remove-member",
      ownerRuntimeId: "panel:nav-a",
      snapshotDigest: "d".repeat(64),
      capability: "channel.members.remove",
      resourceKey: "do:workers/pubsub-channel:PubSubChannel:chat-a",
      tier: "critical" as const,
      cardType: "confirm.critical" as const,
      renderedAction: "remove someone from a shared conversation",
      pending: true,
    }));
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:channel",
          methodEffect: { kind: "semantic", capability: "channel.members.remove" },
          methodCapability: "channel.members.remove",
          methodTier: "critical",
          principals: ["code"],
          presentation: { domain: "sharing", verb: "act" },
          title: "Conversations",
          action: "remove someone from a conversation",
          declaredBy: "workers/pubsub-channel",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const caller = createVerifiedCaller("panel:nav-a", "panel", {
      callerId: "panel:nav-a",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-chat",
      executionDigest: "a".repeat(64),
      requested: [
        { capability: "channel.members.remove", resource: { kind: "prefix", prefix: "" } },
        { capability: "workspace-service:channel", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    delete caller.codeApproved;

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: "chat-a",
        },
        method: "removeMember",
        args: [{ userId: "user-2" }],
      })
    ).rejects.toMatchObject({
      code: "EACQUIRE",
      errorData: {
        acquisition: { acquisitionId: "acq:remove-member" },
        authorityFailure: {
          reasonCode: "approval-required",
          capability: "channel.members.remove",
          remediation: { kind: "request-user-approval" },
        },
      },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "critical",
        renderedAction: "remove a person from a shared conversation",
        snapshot: expect.objectContaining({
          capability: "channel.members.remove",
          targetCapability: "workspace-service:channel",
        }),
      })
    );
  });

  it("returns a manifest remediation instead of prompting for unrequested direct authority", async () => {
    const request = vi.fn();
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:channel",
          methodEffect: { kind: "workspace-service" },
          methodCapability: "workspace-service:channel",
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "sharing", verb: "act" },
          title: "Conversations",
          action: "use conversations",
          declaredBy: "workers/pubsub-channel",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const caller = createVerifiedCaller("panel:news", "panel", {
      callerId: "panel:news",
      callerKind: "panel",
      repoPath: "panels/news",
      effectiveVersion: "ev-news",
      executionDigest: "a".repeat(64),
      requested: [],
    });
    caller.codeApproved = true;

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: "news",
        },
        method: "subscribe",
        args: ["panel:news", {}],
      })
    ).rejects.toMatchObject({
      code: "EACCES",
      errorKind: "access",
      errorData: {
        authorityFailure: {
          reasonCode: "fixed-code-not-requested",
          capability: "workspace-service:channel",
          remediation: {
            kind: "update-installed-code-manifest",
            request: {
              capability: "workspace-service:channel",
              resource: {
                kind: "exact",
                key: "do:workers/pubsub-channel:PubSubChannel:news",
              },
              tier: "gated",
            },
          },
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves the active build's exact runtime-intrinsic effect in direct attestations", async () => {
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:probe",
          methodEffect: { kind: "runtime-intrinsic" },
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "automation", verb: "act" },
          title: "Probe",
          action: "use the probe",
          declaredBy: "workers/probe",
        },
      ],
    });
    const caller = createVerifiedCaller("panel:nav-a", "panel", {
      callerId: "panel:nav-a",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-chat",
      executionDigest: "a".repeat(64),
      requested: [
        { capability: "workspace-service:probe", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    caller.codeApproved = true;

    const attestation = await testServer(server).directDOAuthorization({
      caller,
      ref: {
        source: "workers/probe",
        className: "ProbeDO",
        objectKey: "probe-a",
      },
      method: "seedRows",
      args: [],
    });

    expect(attestation).toMatchObject({
      effect: { kind: "runtime-intrinsic" },
      capability: "workspace-service:probe",
      targetCapability: "workspace-service:probe",
    });
  });

  it("enforces gated workspace-service admission even when the direct method is open", async () => {
    const request = vi.fn(() => ({
      acquisitionId: "acq:channel",
      ownerRuntimeId: "panel:nav-a",
      snapshotDigest: "d".repeat(64),
      capability: "workspace-service:channel",
      resourceKey: "do:workers/pubsub-channel:PubSubChannel:chat-a",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "use a workspace service",
      pending: true,
    }));
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:channel",
          methodEffect: { kind: "workspace-service" },
          methodCapability: "workspace-service:channel",
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "sharing", verb: "act" },
          title: "Conversations",
          action: "use conversations",
          declaredBy: "workers/pubsub-channel",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const caller = createVerifiedCaller("panel:nav-a", "panel", {
      callerId: "panel:nav-a",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-chat",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "workspace-service:channel",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });
    delete caller.codeApproved;

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: "chat-a",
        },
        method: "subscribe",
        args: ["panel:nav-a", {}],
      })
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "gated",
        snapshot: expect.objectContaining({ capability: "workspace-service:channel" }),
      })
    );
  });

  it("preserves admitted test-session policy in direct workspace-service acquisitions", async () => {
    const request = vi.fn(() => ({
      acquisitionId: "acq:test-models",
      ownerRuntimeId: "do:vibestudio/internal:EvalDO:test-run",
      snapshotDigest: "d".repeat(64),
      capability: "workspace-service:models",
      resourceKey: "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "use model settings",
      pending: false,
    }));
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:models",
          methodEffect: { kind: "workspace-service" },
          methodTier: "open",
          principals: ["session"],
          presentation: { domain: "automation", verb: "manage" },
          title: "AI model settings",
          action: "use model settings",
          declaredBy: "workers/model-settings",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const runtimeId = "do:vibestudio/internal:EvalDO:test-run";
    const digest = "a".repeat(64);
    const caller = createVerifiedCaller(
      runtimeId,
      "do",
      {
        callerId: runtimeId,
        callerKind: "do",
        repoPath: "workers/system-test-runner",
        effectiveVersion: "ev-runner",
        executionDigest: digest,
        requested: [
          { capability: "workspace-service:models", resource: { kind: "prefix", prefix: "" } },
        ],
      },
      null,
      { userId: "user-1", handle: "user1" },
      {
        v: 1,
        authoritySessionId: "authority:test-run",
        authoritySessionVersion: 1,
        mode: "test",
        ownerUser: "user:user-1",
        workspaceId: "test-workspace",
        contextId: "ctx-test",
        agentBinding: null,
        taskRef: "eval:test-run",
        harness: {
          principal: `code:workers/system-test-runner@${digest}`,
          repoPath: "workers/system-test-runner",
          effectiveVersion: "ev-runner",
        },
        eval: { runtimeId, runId: "doctor" },
        causalParent: null,
        testPolicy: {
          policyId: "test:doctor:test-run",
          kind: "orchestrator",
        },
        issuedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
        nonce: "test-session-nonce",
      }
    );

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "workers/model-settings",
          className: "ModelSettingsDO",
          objectKey: "workspace-model-settings",
        },
        method: "inspectModels",
        args: [["openai-codex:gpt-5.4-mini"]],
      })
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          executionMode: "test",
          testPolicyId: "test:doctor:test-run",
        }),
      })
    );
  });

  it("inherits a canonical test-context policy without changing manifest-confined code into a session", async () => {
    const policy = {
      policyId: "test:st_context_inheritance",
      kind: "orchestrator" as const,
    };
    const request = vi.fn(() => ({
      acquisitionId: "acq:test-channel-gad",
      ownerRuntimeId: "do:workers/pubsub-channel:PubSubChannel:headless-test",
      snapshotDigest: "d".repeat(64),
      capability: "workspace-service:gad.workspace",
      resourceKey: "do:workers/gad-workspace:GadWorkspaceDO:workspace",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "use workspace history",
      pending: false,
    }));
    const { server, entityCache } = createServer({
      testPolicyForContext: (contextId) => (contextId === "ctx:test-child" ? policy : null),
      userSubjectSource: {
        resolve: () => ({ userId: "user-1", handle: "user1" }),
      },
      isCodeApproved: () => false,
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:gad.workspace",
          methodEffect: { kind: "workspace-service" },
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "automation", verb: "act" },
          title: "Workspace history",
          action: "use workspace history",
          declaredBy: "workers/gad-workspace",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const runtimeId = "do:workers/pubsub-channel:PubSubChannel:headless-test";
    entityCache._onActivate(
      makeRecord(runtimeId, "do", {
        contextId: "ctx:test-child",
        repoPath: "workers/pubsub-channel",
        activeExecutionDigest: "b".repeat(64),
        activeAuthority: {
          requests: [
            {
              capability: "workspace-service:gad.workspace",
              resource: { kind: "prefix", prefix: "" },
              tier: "gated",
              evidence: "intentional-broad",
            },
          ],
        },
      })
    );
    const caller = testServer(server).verifiedCallerFor(runtimeId, "do");
    expect(caller.executionSession).toBeUndefined();
    expect(caller.testPolicy).toEqual(policy);

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "workers/gad-workspace",
          className: "GadWorkspaceDO",
          objectKey: "workspace",
        },
        method: "appendLogEvent",
        args: [{ logId: "headless-test", events: [] }],
      })
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          callerPrincipal: `code:workers/pubsub-channel@${"b".repeat(64)}`,
          executionMode: "test",
          testPolicyId: policy.policyId,
        }),
      })
    );
  });

  it("delegates a test policy only for the exact active invocation without mutating receiver context", () => {
    const { server, entityCache } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "user-1", handle: "user1" }),
      },
    });
    const receiver = "do:workers/pubsub-channel:PubSubChannel:headless-test";
    entityCache._onActivate(
      makeRecord(receiver, "do", {
        contextId: "ctx:test-receiver",
        repoPath: "workers/pubsub-channel",
        activeExecutionDigest: "b".repeat(64),
        activeAuthority: { requests: [] },
      })
    );
    const policy = {
      policyId: "test:st_invocation_parent",
      kind: "orchestrator" as const,
    };
    const nonce = "host-minted-direct-authority-nonce";
    const release = testServer(server).beginAuthorityParent(receiver, {
      nonce,
      context: { testPolicy: policy },
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);

    expect(testServer(server).testPolicyFromAuthorityParent(receiver, nonce)).toEqual(policy);
    expect(() =>
      testServer(server).testPolicyFromAuthorityParent(
        "do:workers/other:OtherDO:headless-test",
        nonce
      )
    ).toThrow(/another runtime/);
    const caller = testServer(server).verifiedCallerFor(
      receiver,
      "do",
      undefined,
      undefined,
      testServer(server).testPolicyFromAuthorityParent(receiver, nonce)
    );
    expect(caller.executionSession).toBeUndefined();
    expect(caller.testPolicy).toEqual(policy);

    release();
    expect(() => testServer(server).testPolicyFromAuthorityParent(receiver, nonce)).toThrow(
      /not active/
    );
  });

  it("keeps a receiver's exact case policy when its orchestrator invokes it", () => {
    const orchestrator = {
      policyId: "test:st_invocation_parent",
      kind: "orchestrator" as const,
    };
    const casePolicy: import("@vibestudio/rpc").AgentExecutionTestPolicy = {
      policyId: `${orchestrator.policyId}:case:approval:abc`,
      kind: "case",
      orchestratorPolicyId: orchestrator.policyId,
      case: {
        testId: "approval",
        authority: [],
        userland: [],
        unexpectedPrompts: "fail",
      },
    };
    const { server, entityCache } = createServer({
      testPolicyForContext: () => casePolicy,
    });
    const receiver = "do:workers/pubsub-channel:PubSubChannel:headless-case";
    entityCache._onActivate(
      makeRecord(receiver, "do", {
        contextId: "ctx:test-case",
        repoPath: "workers/pubsub-channel",
        activeExecutionDigest: "b".repeat(64),
        activeAuthority: { requests: [] },
      })
    );
    const nonce = "host-minted-direct-authority-case-nonce";
    const release = testServer(server).beginAuthorityParent(receiver, {
      nonce,
      context: { testPolicy: orchestrator },
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);

    expect(testServer(server).testPolicyFromAuthorityParent(receiver, nonce)).toBe(casePolicy);
    expect(
      testServer(server).verifiedCallerFor(
        receiver,
        "do",
        undefined,
        undefined,
        testServer(server).testPolicyFromAuthorityParent(receiver, nonce)
      ).testPolicy
    ).toBe(casePolicy);
    release();
  });

  it("does not poison a shared orchestrator receiver when sequential cases invoke it", () => {
    const orchestrator = {
      policyId: "test:st_shared_receiver",
      kind: "orchestrator" as const,
    };
    const casePolicy = (testId: string): import("@vibestudio/rpc").AgentExecutionTestPolicy => ({
      policyId: `${orchestrator.policyId}:case:${testId}`,
      kind: "case",
      orchestratorPolicyId: orchestrator.policyId,
      case: {
        testId,
        authority: [],
        userland: [],
        unexpectedPrompts: "fail",
      },
    });
    const { server, entityCache } = createServer({
      testPolicyForContext: () => orchestrator,
    });
    const receiver = "do:workers/pubsub-channel:PubSubChannel:shared";
    entityCache._onActivate(
      makeRecord(receiver, "do", {
        contextId: "ctx:system-test-orchestrator",
        repoPath: "workers/pubsub-channel",
        activeExecutionDigest: "b".repeat(64),
        activeAuthority: { requests: [] },
      })
    );

    for (const [index, policy] of [casePolicy("first"), casePolicy("second")].entries()) {
      const nonce = `host-minted-shared-receiver-nonce-${index}`;
      const release = testServer(server).beginAuthorityParent(receiver, {
        nonce,
        context: { testPolicy: policy },
      } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);
      expect(testServer(server).testPolicyFromAuthorityParent(receiver, nonce)).toBe(policy);
      release();
    }

    expect(testServer(server).verifiedCallerFor(receiver, "do").testPolicy).toBe(orchestrator);
  });

  it("keeps an agent binding as a relationship fact rather than inventing a session origin", async () => {
    const mission = {
      missionId: "mission-local-model",
      closureDigest: "closure-1",
      harness: { unit: "workers/agent-worker", ev: "ev-agent" },
    };
    const contextIntegrity = {
      class: "external" as const,
      latchEpoch: 3,
      externalKeys: ["web:models.example"],
    };
    const { server, entityCache } = createServer({
      missionFactForSession: (sessionId) => (sessionId === "channel-stable" ? mission : null),
      contextIntegrityFactForSession: (sessionId) => {
        expect(sessionId).toBe("channel-stable");
        return contextIntegrity;
      },
    });
    const targetId = "do:workers/local-model:AiChatWorker:model-a";
    entityCache._onActivate(makeRecord(targetId, "do", { repoPath: "workers/local-model" }));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response("streamed", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("agent:local-model");
    client.caller = createVerifiedCaller(
      "agent:local-model",
      "agent",
      null,
      {
        agentId: "agent:local-model",
        entityId: "agent:local-model",
        contextId: "ctx-model",
        channelId: "channel-stable",
      },
      { userId: "user-1", handle: "user1" }
    );
    await handleRoute(server, client, targetId, {
      type: "stream-request",
      requestId: "transport-request-is-not-session",
      fromId: "agent:local-model",
      method: "chat",
      args: [],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const relayed = JSON.parse(String((init as RequestInit).body)) as RpcEnvelope;
    expect((relayed.delivery.caller as AttestedCaller).authorization?.context).toMatchObject({
      authorizingOrigin: { kind: "user", principal: "user:user-1" },
      session: { id: "channel-stable", mission },
      contextIntegrity,
    });
  });

  it("cancels a routed stream in the same caller-owned streaming relay", async () => {
    const { server } = createServer();
    const client = createClient();
    const cancel = vi.spyOn(testServer(server).streamingRelay, "cancel");

    await handleRoute(server, client, "do:workers/pubsub-channel:PubSubChannel:chat-a", {
      type: "stream-cancel",
      requestId: "routed-stream-1",
      fromId: "panel:nav-a",
    });

    expect(cancel).toHaveBeenCalledWith(client, "routed-stream-1");
    expect(client.ws.send).not.toHaveBeenCalled();
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

describe("RpcServer live caller gate", () => {
  it.each(["user revocation", "device revocation"])(
    "denies the next RPC after failed %s socket teardown",
    (reason) => {
      let live = true;
      const { server } = createServer({ liveCallerGate: () => live });
      const dispatcher = testServer(server).dispatcher;
      const client = createClient();
      registerClient(server, client);

      // Administrative cleanup attempted to close the socket, but the
      // transport stayed open. The authoritative live store has already
      // changed, so the next frame must still fail closed.
      client.ws.close(4001, reason);
      live = false;
      const request = {
        type: "request" as const,
        requestId: `after-${reason}`,
        fromId: client.caller.runtime.id,
        method: "fs.stat",
        args: ["ctx_1", "/x"],
      };
      testServer(server).handleMessage(
        client,
        Buffer.from(
          JSON.stringify({
            type: "ws:rpc",
            envelope: clientEnvelope(client, "main", request),
          })
        )
      );

      expect(dispatcher.dispatch).not.toHaveBeenCalled();
      expect(client.ws.close).toHaveBeenLastCalledWith(
        4403,
        "Caller identity or workspace membership is no longer active"
      );
    }
  );
});

describe("RpcServer caller identity", () => {
  it("retains sealed code attribution without granting an unapproved exact version", () => {
    const isCodeApproved = vi.fn(() => false);
    const { server, entityCache } = createServer({ isCodeApproved });
    entityCache._onActivate(
      makeRecord("worker:review-me", "worker", {
        repoPath: "workers/review-me",
        effectiveVersion: "ev-review-me",
        activeAuthority: {
          requests: [
            {
              capability: "notifications",
              resource: { kind: "exact", key: "workspace" },
              tier: "gated",
              evidence: "exact",
            },
          ],
        },
      })
    );

    const caller = testServer(server).verifiedCallerFor("worker:review-me", "worker");

    expect(caller.code).toMatchObject({
      repoPath: "workers/review-me",
      effectiveVersion: "ev-review-me",
    });
    expect(caller.codeApproved).toBeUndefined();
    expect(isCodeApproved).toHaveBeenCalledWith(caller.code);
  });

  it("accepts an existing exact causal parent only for the presenter's bound trajectory", async () => {
    const { server, entityCache } = createServer();
    const binding = {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId: "channel:agent",
      agentId: "agent:stable",
      userId: "user:one",
    };
    const caller = createVerifiedCaller("do:agents:Agent:one", "do", null, binding);
    const trajectory = channelTrajectoryFor(binding.channelId);
    const causalParent = {
      kind: "trajectory-invocation" as const,
      ...trajectory,
      invocationId: "invocation:tool",
    };

    await expect(testServer(server).resolveCausalParent(caller, { causalParent })).resolves.toEqual(
      causalParent
    );
    await expect(
      testServer(server).resolveCausalParent(caller, {
        causalParent: {
          ...causalParent,
          ...channelTrajectoryFor("channel:sibling"),
        },
      })
    ).rejects.toThrow(/does not match/);
    await expect(
      testServer(server).resolveCausalParent(createVerifiedCaller("worker:one", "worker"), {
        causalParent,
      })
    ).rejects.toThrow(/host-bound agent trajectory/);

    const vesselId = "do:workers/agent-worker:AiChatWorker:headless-one";
    entityCache._onActivate(
      makeRecord(vesselId, "do", {
        contextId: binding.contextId,
        agentBinding: {
          entityId: binding.entityId,
          contextId: binding.contextId,
          channelId: binding.channelId,
        },
      })
    );
    await expect(
      testServer(server).resolveCausalParent(createVerifiedCaller(vesselId, "do"), {
        causalParent,
      })
    ).resolves.toEqual(causalParent);
  });

  it("fails closed when exact causal invocation evidence is unavailable or missing", async () => {
    const binding = {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId: "channel:agent",
      agentId: "agent:stable",
      userId: "user:one",
    };
    const caller = createVerifiedCaller("do:agents:Agent:one", "do", null, binding);
    const causalParent = {
      kind: "trajectory-invocation" as const,
      ...channelTrajectoryFor(binding.channelId),
      invocationId: "invocation:missing",
    };
    const unavailable = createServer({ verifyExactCausalInvocation: undefined }).server;
    await expect(
      testServer(unavailable).resolveCausalParent(caller, { causalParent })
    ).rejects.toThrow(/verification is unavailable/);

    const verifyExactCausalInvocation = vi.fn(async () => false);
    const missing = createServer({ verifyExactCausalInvocation }).server;
    await expect(testServer(missing).resolveCausalParent(caller, { causalParent })).rejects.toThrow(
      /does not exist/
    );
    expect(verifyExactCausalInvocation).toHaveBeenCalledWith(causalParent);
  });

  it("rejects nonexistent causal parents before unary and streaming service dispatch", async () => {
    const verifyExactCausalInvocation = vi.fn(async () => false);
    const { server } = createServer({ verifyExactCausalInvocation });
    const dispatcher = testServer(server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["do"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    const binding = {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId: "channel:agent",
      agentId: "agent:stable",
      userId: "user:one",
    };
    const client = createClient();
    client.caller = createVerifiedCaller("do:agents:Agent:one", "do", null, binding);
    const causalParent = {
      kind: "trajectory-invocation" as const,
      ...channelTrajectoryFor(binding.channelId),
      invocationId: "invocation:missing",
    };

    await handleRpc(server, client, {
      ...rpcRequest("unary-missing-cause", "vcs.status"),
      causalParent,
    });
    await handleRpc(server, client, {
      type: "stream-request",
      requestId: "stream-missing-cause",
      fromId: client.caller.runtime.id,
      method: "files.stream",
      args: [],
      causalParent,
    });

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    const messages = (client.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) =>
      JSON.parse(String(raw))
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          envelope: expect.objectContaining({
            message: expect.objectContaining({
              requestId: "unary-missing-cause",
              error: expect.stringContaining("does not exist"),
              errorCode: "EACCES",
            }),
          }),
        }),
        expect.objectContaining({
          envelope: expect.objectContaining({
            message: expect.objectContaining({
              requestId: "stream-missing-cause",
              frameType: FRAME_ERROR,
            }),
          }),
        }),
      ])
    );
    expect(verifyExactCausalInvocation).toHaveBeenCalledTimes(2);
  });

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

  it("indexes shared-app connections by their concrete authorized user", () => {
    const { server } = createServer();
    const alice = createClientWithConnection("app:shared", "alice-connection");
    alice.caller = createVerifiedCaller("app:shared", "app", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });
    alice.userId = "usr_alice";
    const bob = createClientWithConnection("app:shared", "bob-connection");
    bob.caller = createVerifiedCaller("app:shared", "app", null, null, {
      userId: "usr_bob",
      handle: "bob",
    });
    bob.userId = "usr_bob";

    registerClient(server, alice);
    registerClient(server, bob);
    expect(server.getUserConnections("usr_alice")).toEqual([alice]);
    expect(server.getUserConnections("usr_bob")).toEqual([bob]);

    expect(testServer(server).connections.removeClient(alice)).toBe(true);
    expect(server.getUserConnections("usr_alice")).toEqual([]);
    expect(server.getUserConnections("usr_bob")).toEqual([bob]);
  });

  it("rejects WS authentication for the reserved in-process shell caller id", () => {
    const { server, tokenManager } = createServer();
    const shellToken = tokenManager.createToken("shell", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, shellToken, "conn-shell");

    expect(ws.close).toHaveBeenCalledWith(4006, expect.stringContaining("shell"));
    expect(testServer(server).connections.getCallerConnections("shell")).toHaveLength(0);
  });

  it("rejects a mismatched RPC contract before authenticating the socket", () => {
    const { server, tokenManager } = createServer();
    const token = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();
    testServer(server).handleConnection(ws);

    ws.emitMessage({
      type: "ws:auth",
      contractVersion: RPC_CONTRACT_VERSION + 1,
      token,
      connectionId: "mismatched-contract",
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:auth-result",
        success: false,
        contractVersion: RPC_CONTRACT_VERSION,
        error: `Incompatible RPC contract: peer ${RPC_CONTRACT_VERSION + 1}; server requires ${RPC_CONTRACT_VERSION}`,
      })
    );
    expect(ws.close).toHaveBeenCalledWith(4005, "Incompatible RPC contract");
    expect(testServer(server).connections.getCallerConnections("electron-main")).toHaveLength(0);
  });

  it("does not admit a socket that closes while pairing redemption is in flight", async () => {
    let resolvePairing!: (value: {
      callerId: string;
      callerKind: "shell";
      subject: { userId: string; handle: string };
    }) => void;
    const pairing = new Promise<{
      callerId: string;
      callerKind: "shell";
      subject: { userId: string; handle: string };
    }>((resolve) => {
      resolvePairing = resolve;
    });
    const onClientAuthenticate = vi.fn();
    const { server } = createServer({
      redeemPairingCredential: () => pairing,
      onClientAuthenticate,
    });
    const ws = createTestWs();
    testServer(server).handleConnection(ws);

    ws.emitMessage({
      type: "ws:auth",
      contractVersion: 2,
      token: "pairing-code",
      connectionId: "pairing-conn",
    });
    ws.emitClose();
    resolvePairing({
      callerId: "shell:dev_delayed",
      callerKind: "shell",
      subject: { userId: "usr_alice", handle: "alice" },
    });
    await flushAsync();

    expect(server.getPrincipalConnections("shell:dev_delayed")).toHaveLength(0);
    expect(testServer(server).sessions.hasSession("shell:dev_delayed")).toBe(false);
    expect(onClientAuthenticate).not.toHaveBeenCalled();
    const authResults = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(authResults).not.toContainEqual(expect.objectContaining({ success: true }));
  });

  it("returns the fresh pairing target with the issued credential", async () => {
    const { server } = createServer({
      redeemPairingCredential: async () => ({
        callerId: "shell:dev_fresh",
        callerKind: "shell",
        deviceCredential: { deviceId: "dev_fresh", refreshToken: "refresh-secret" },
        pairingContext: { workspaceId: "workspace-1" },
        subject: { userId: "usr_alice", handle: "alice" },
      }),
    });
    const ws = createTestWs();
    testServer(server).handleConnection(ws);

    ws.emitMessage({
      type: "ws:auth",
      contractVersion: 2,
      token: "pairing-code",
      connectionId: "pairing-conn",
    });
    await flushAsync();

    const authResults = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(authResults).toContainEqual(
      expect.objectContaining({
        type: "ws:auth-result",
        success: true,
        deviceCredential: { deviceId: "dev_fresh", refreshToken: "refresh-secret" },
        pairingContext: { workspaceId: "workspace-1" },
      })
    );
  });

  it("rolls back every admission registry when an asynchronous auth task fails", async () => {
    const { server, tokenManager } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
      onClientAuthenticate: () => {
        throw new Error("host integration failed");
      },
      sessionTtlMs: { shell: 1 },
    });
    const token = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();
    testServer(server).handleConnection(ws);

    ws.emitMessage({
      type: "ws:auth",
      contractVersion: 2,
      token,
      connectionId: "failed-admission",
    });
    await flushAsync();

    expect(server.getPrincipalConnections("electron-main")).toHaveLength(0);
    expect(ws.close).toHaveBeenCalledWith(1011, "Authentication failed");
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toEqual([
      expect.objectContaining({ type: "ws:auth-result", success: false }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(testServer(server).sessions.hasSession("electron-main")).toBe(false);
  });

  it("accepts WS authentication for concrete shell host callers", () => {
    const { server, tokenManager } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
    });
    const remoteToken = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, remoteToken, "conn-shell-host");

    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("registers one direct event session for the authenticated transport lifetime", () => {
    const eventService = new EventService();
    const { server, tokenManager } = createServer({
      eventService,
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
    });
    const remoteToken = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, remoteToken, "conn-events");
    expect(eventService.emitToConnection("electron-main", "conn-events", "focus-address-bar")).toBe(
      true
    );

    const messages = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(messages.filter((message) => message.type === "ws:rpc")).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          message: {
            type: "event",
            fromId: "main",
            event: "focus-address-bar",
          },
        }),
      }),
    ]);

    const admitted = testServer(server).connections.getCallerConnections("electron-main")[0]!;
    testServer(server).handleClose(admitted, 1006, "network");
    expect(eventService.emitToConnection("electron-main", "conn-events", "focus-address-bar")).toBe(
      false
    );
  });

  it("accepts WS authentication when a connection grant resolves to a shell host principal", () => {
    const { server, connectionGrants, entityCache } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
    });
    entityCache._onActivate(makeRecord("electron-main", "shell"));
    const grant = connectionGrants.grant("electron-main", "shell:test").token;
    const ws = createTestWs();

    testServer(server).handleAuth(ws, grant, "conn-grant");
    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("accepts reconnects with a redeemed connection grant until the principal is revoked", () => {
    const { server, connectionGrants, entityCache } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
    });
    entityCache._onActivate(makeRecord("electron-main", "shell"));
    const grant = connectionGrants.grant("electron-main", "shell:test").token;
    const first = createTestWs();
    const reconnected = createTestWs();

    testServer(server).handleAuth(first, grant, "conn-grant-first");
    testServer(server).handleAuth(reconnected, grant, "conn-grant-reconnected");

    expect(first.close).not.toHaveBeenCalled();
    expect(reconnected.close).not.toHaveBeenCalled();
    expect(testServer(server).connections.getCallerConnections("electron-main")).toHaveLength(2);
  });

  it("attributes a server-spawned app grant to the canonical system subject", () => {
    const membershipGate = vi.fn((subject) => subject?.userId === "system");
    const { server, connectionGrants, entityCache } = createServer({ membershipGate });
    entityCache._onActivate(makeRecord("@workspace-apps/remote-cli", "app"));
    const grant = connectionGrants.grant("@workspace-apps/remote-cli", "server").token;
    const ws = createTestWs();

    testServer(server).handleAuth(ws, grant, "terminal-app");

    expect(ws.close).not.toHaveBeenCalled();
    expect(membershipGate).toHaveBeenCalledWith({ userId: "system", handle: "system" });
    expect(
      testServer(server).connections.getCallerConnections("@workspace-apps/remote-cli")[0]?.caller
        .subject
    ).toEqual({ userId: "system", handle: "system" });
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
    testServer(server).dispatcher.dispatch.mockRejectedValue(
      new Error("Service 'internal' is not accessible to worker callers")
    );

    await handleRpc(server, client, rpcRequest("req-3", "internal.shellOnly"));

    expect(testServer(server).dispatcher.dispatch).toHaveBeenCalledTimes(1);
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
    const authorizingCaller = createVerifiedCaller(
      "@workspace-apps/shell",
      "app",
      {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      },
      null,
      { userId: "usr_alice", handle: "alice" }
    );
    const { server } = createServer({
      resolveExtensionInvocation: vi.fn(() => ({
        caller: {
          callerId: "@workspace-apps/shell",
          callerKind: "app" as const,
        },
        chainCaller: {
          callerId: "@workspace-apps/shell",
          callerKind: "app" as const,
          repoPath: "apps/shell",
          effectiveVersion: "ev-shell",
        },
        authorizingCaller,
        causalParent: null,
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
      parentRequestId: "request:app",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: "@workspace-extensions/tools", kind: "extension" } },
      chainCaller: {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      },
      authorizingCaller,
    });
    expect(dispatched[0]).not.toHaveProperty("causalParent");
  });

  it("preserves a verified shell subject across a nested extension host call", async () => {
    const authorizingCaller = createVerifiedCaller("shell:dev_alice", "shell", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });
    const { server } = createServer({
      resolveExtensionInvocation: vi.fn(() => ({
        caller: {
          callerId: "shell:dev_alice",
          callerKind: "shell" as const,
          userId: "usr_alice",
        },
        authorizingCaller,
        causalParent: null,
      })),
    });
    const client = createClient("@workspace-extensions/browser-data");
    client.caller = createVerifiedCaller("@workspace-extensions/browser-data", "extension");
    const dispatched: unknown[] = [];
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["extension"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await handleRpc(server, client, {
      ...rpcRequest("req-browser-data", "workers.resolveDurableObject"),
      parentRequestId: "request:shell-browser-data",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: {
        runtime: { id: "@workspace-extensions/browser-data", kind: "extension" },
      },
      authorizingCaller: {
        runtime: { id: "shell:dev_alice", kind: "shell" },
        subject: { userId: "usr_alice", handle: "alice" },
      },
    });
    expect(dispatched[0]).not.toHaveProperty("chainCaller");
  });

  it("derives a nested extension VCS call's causal parent from its host invocation", async () => {
    const causalParent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:channel:agent-1",
      head: "main",
      invocationId: "invocation:tool-1",
    };
    const resolveExtensionInvocation = vi.fn(() => ({
      caller: {
        callerId: "do:agents/AgentDO:agent-1",
        callerKind: "do" as const,
      },
      authorizingCaller: createVerifiedCaller("do:agents/AgentDO:agent-1", "do"),
      causalParent,
    }));
    const verifyExactCausalInvocation = vi.fn(async () => true);
    const { server } = createServer({
      resolveExtensionInvocation,
      verifyExactCausalInvocation,
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
      ...rpcRequest("req-agent-extension-vcs", "vcs.status"),
      parentRequestId: "request:agent-tool",
    });

    expect(resolveExtensionInvocation).toHaveBeenCalledWith(
      "@workspace-extensions/tools",
      "request:agent-tool"
    );
    expect(verifyExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: "@workspace-extensions/tools", kind: "extension" } },
      causalParent,
    });
  });

  it("propagates an authenticated WebSocket unary cancellation to the service context", async () => {
    const { server } = createServer();
    const client = createClient("panel:cancel-source");
    client.caller = createVerifiedCaller("panel:cancel-source", "panel");
    const dispatcher = testServer(server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let observedAbort = false;
    dispatcher.dispatch.mockImplementation(
      async (ctx: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          resolveEntered();
          ctx.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve(null);
            },
            { once: true }
          );
        })
    );
    const pending = handleRpc(server, client, rpcRequest("cancel-me", "docs.listServices"));
    await entered;

    await handleRpc(server, client, {
      type: "request-cancel",
      requestId: "cancel-me",
      fromId: client.caller.runtime.id,
    });
    await pending;

    expect(observedAbort).toBe(true);
  });
});

describe("RpcServer caller retirement", () => {
  it("queues a self-revocation response before closing and skips reconnect grace", async () => {
    const onClientDisconnect = vi.fn();
    const { server, tokenManager } = createServer({ onClientDisconnect });
    server.initHandlers();
    const callerId = "shell:device-self";
    tokenManager.ensureToken(callerId, "shell");
    const client = createClient(callerId);
    client.caller = createVerifiedCaller(callerId, "shell", null, null, {
      userId: "user-1",
      handle: "user1",
    });
    const order: string[] = [];
    client.ws.send = vi.fn(() => order.push("response"));
    client.ws.close = vi.fn(() => order.push("close"));
    registerClient(server, client);
    const dispatcher = testServer(server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["shell"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    dispatcher.dispatch.mockImplementation(async () => {
      expect(tokenManager.revokeToken(callerId)).toBe(true);
      expect(client.ws.close).not.toHaveBeenCalled();
      return { revoked: true };
    });

    await handleRpc(server, client, {
      type: "request",
      requestId: "revoke-self",
      fromId: callerId,
      method: "hubControl.revokeDevice",
      args: [],
    });

    expect(order).toEqual(["response", "close"]);
    const retirement = server.retireCaller(callerId);
    expect(server.retireCaller(callerId)).toBe(retirement);
    let settled = false;
    void retirement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    testServer(server).handleClose(client, 4001, "Token revoked");
    await retirement;
    expect(testServer(server).disconnectTimers.size).toBe(0);
    expect(testServer(server).reconnectWaiters.size).toBe(0);
    expect(testServer(server).connectionReconnectWaiters.size).toBe(0);
    expect(onClientDisconnect).toHaveBeenCalledOnce();
  });

  it("closes idle sibling connections immediately but lets the active response drain", async () => {
    const { server, tokenManager } = createServer();
    server.initHandlers();
    const callerId = "shell:device-many";
    tokenManager.ensureToken(callerId, "shell");
    const active = createClientWithConnection(callerId, "conn-active");
    active.caller = createVerifiedCaller(callerId, "shell", null, null, {
      userId: "user-1",
      handle: "user1",
    });
    const idle = createClientWithConnection(callerId, "conn-idle");
    idle.caller = active.caller;
    registerClient(server, active);
    registerClient(server, idle);
    const dispatcher = testServer(server).dispatcher;
    dispatcher.getPolicy.mockReturnValue({ allowed: ["shell"] });
    dispatcher.getMethodPolicy.mockReturnValue(undefined);
    dispatcher.dispatch.mockImplementation(async () => {
      tokenManager.revokeToken(callerId);
      expect(idle.ws.close).toHaveBeenCalledWith(4001, "Token revoked");
      expect(active.ws.close).not.toHaveBeenCalled();
      return true;
    });

    await handleRpc(server, active, {
      type: "request",
      requestId: "revoke-many",
      fromId: callerId,
      method: "hubControl.revokeDevice",
      args: [],
    });
    expect(active.ws.send).toHaveBeenCalledOnce();
    expect(active.ws.close).toHaveBeenCalledWith(4001, "Token revoked");

    const retired = server.retireCaller(callerId);
    testServer(server).handleClose(idle, 4001, "Token revoked");
    testServer(server).handleClose(active, 4001, "Token revoked");
    await retired;
  });

  it("allows a fresh credential generation after the old transport fully retires", async () => {
    const { server, tokenManager } = createServer({
      userSubjectSource: {
        resolve: () => ({ userId: "user-1", handle: "user1" }),
      },
    });
    server.initHandlers();
    const callerId = "shell:device-stable";
    tokenManager.ensureToken(callerId, "shell");
    const first = createClient(callerId);
    first.caller = createVerifiedCaller(callerId, "shell", null, null, {
      userId: "user-1",
      handle: "user1",
    });
    registerClient(server, first);

    tokenManager.revokeToken(callerId);
    const retired = server.retireCaller(callerId);
    testServer(server).handleClose(first, 4001, "Token revoked");
    await retired;

    const nextToken = tokenManager.ensureToken(callerId, "shell");
    const next = createTestWs();
    await testServer(server).handleAuth(next, nextToken, "next");

    const authResults = next.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(authResults).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "ws:auth-result", success: true })])
    );
  });
});

describe("RpcServer terminal lifecycle", () => {
  it("can own a gateway WebSocket upgrade without a second RPC path", () => {
    const { server } = createServer();
    server.initHandlers();
    const waitingSocket = createTestWs();
    const internal = server as unknown as {
      wss: {
        handleUpgrade(
          req: IncomingMessage,
          socket: Duplex,
          head: Buffer,
          done: (ws: WebSocket) => void
        ): void;
      };
    };
    const upgrade = vi
      .spyOn(internal.wss, "handleUpgrade")
      .mockImplementation((_req, _socket, _head, done) => done(waitingSocket as never));

    server.handleGatewayWsUpgrade({} as IncomingMessage, {} as Duplex, Buffer.alloc(0));

    expect(upgrade).toHaveBeenCalledOnce();
    expect(testServer(server).pendingAuthentications.has(waitingSocket)).toBe(true);
  });

  it("releases owned work and ignores delayed socket closes after idempotent stop", async () => {
    const { server, tokenManager } = createServer();
    const disposeRevocation = vi.fn();
    vi.spyOn(tokenManager, "onRevoke").mockReturnValue(disposeRevocation);
    server.initHandlers();

    const waitingSocket = createTestWs();
    server.handleGatewayWsConnection(waitingSocket as never);
    expect(testServer(server).pendingAuthentications.size).toBe(1);

    const client = createClient("panel:nav-a");
    registerClient(server, client);
    await server.stop();
    await server.stop();

    expect(disposeRevocation).toHaveBeenCalledTimes(1);
    expect(waitingSocket.close).toHaveBeenCalledWith(1001, "Server shutting down");
    expect(testServer(server).pendingAuthentications.size).toBe(0);
    expect(testServer(server).sessions.hasSession("panel:nav-a")).toBe(false);

    // A real WebSocket emits close asynchronously after closeAll(). That late
    // callback must remain pure cleanup and must not recreate grace state.
    testServer(server).handleClose(client, 1001, "Server shutting down");
    expect(testServer(server).disconnectTimers.size).toBe(0);
    expect(testServer(server).reconnectWaiters.size).toBe(0);
    expect(testServer(server).connectionReconnectWaiters.size).toBe(0);
    expect(testServer(server).sessions.hasSession("panel:nav-a")).toBe(false);

    expect(() => server.initHandlers()).toThrow("cannot be restarted");
    const lateSocket = createTestWs();
    server.handleGatewayWsConnection(lateSocket as never);
    expect(lateSocket.close).toHaveBeenCalledWith(1001, "Server shutting down");
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

  it("does not resurrect a successfully retired bodyStreamId on a duplicate stream-open", async () => {
    const { server } = createServer();
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    p.emitBulk(8, FRAME_DATA, utf8("done"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 4 })));
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
    await expect(readAll(firstBody)).resolves.toBe("done");

    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 8,
      bodyStreamId: 8,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "up-2",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const duplicateBody = shim!.takeInboundBody("up-2")!;
    p.emitBulk(8, FRAME_DATA, utf8("late"));
    p.emitBulk(8, FRAME_END, utf8(JSON.stringify({ bytesIn: 4 })));
    await expect(readAll(duplicateBody)).resolves.toBe("");
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

  it("caps the total bytes buffered across pre-open upload streams", async () => {
    const { server } = createServer({
      uploadPreopenLimits: { maxBufferedBytes: 3 },
    });
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    p.emitBulk(1, FRAME_DATA, new Uint8Array([1, 2]));
    p.emitBulk(2, FRAME_DATA, new Uint8Array([3, 4]));

    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 2,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "aggregate-cap",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const body = shim!.takeInboundBody("aggregate-cap")!;
    await expect(readAll(body)).rejects.toThrow(/aggregate cap/);
    p.emitDown("test complete");
  });

  it("caps the number of pending pre-open upload stream ids", async () => {
    const { server } = createServer({
      uploadPreopenLimits: { maxPendingStreams: 2 },
    });
    let shim: SessionWebSocketShim | undefined;
    testServer(server).handleConnection = vi.fn((ws: unknown) => {
      shim = ws as SessionWebSocketShim;
    });
    const p = createFakePipe();
    server.attachWebRtcPipe(p.pipe);
    p.sendControl({ t: "open", sid: "s1", token: "grant", connectionId: "c1" });

    p.emitBulk(1, FRAME_DATA, utf8("x"));
    p.emitBulk(2, FRAME_DATA, utf8("x"));
    p.emitBulk(3, FRAME_DATA, utf8("x"));

    p.sendControl({
      t: "stream-open",
      sid: "s1",
      streamId: 7,
      bodyStreamId: 3,
      envelope: makeEnvelope("panel:c1", "main", "panel", {
        type: "stream-request",
        requestId: "stream-cap",
        fromId: "panel:c1",
        method: "gateway.fetch",
        args: [{ path: "/x", method: "POST" }],
      }),
    });
    const body = shim!.takeInboundBody("stream-cap")!;
    await expect(readAll(body)).rejects.toThrow(/too many pending streams/);
    p.emitDown("test complete");
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
