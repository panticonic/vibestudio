import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CapabilityGrantStore } from "./services/capabilityGrantStore.js";
import { mintUnitClearanceGrants } from "./services/unitClearanceGrants.js";
import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { awaitRpcAdmissionResolution, RpcServer } from "./rpcServer.js";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WsClientState } from "./rpcServer/connectionRegistry.js";
import { encodeWebSocketStreamFrame, type RpcSessionChannel } from "./rpcServer/sessionChannel.js";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import {
  createVerifiedCaller,
  type CallerKind,
  type ServiceContext,
  type ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import {
  envelopeFromMessage,
  responseEnvelopeFor,
  type RpcEnvelope,
  type RpcMessage,
} from "@vibestudio/rpc";
import {
  bindVerifiedExternalContext,
  type AttestedCaller,
  type InternalRpcRequest,
} from "@vibestudio/rpc/internal";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
} from "@vibestudio/rpc/protocol/streamCodec";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { EventService } from "@vibestudio/shared/eventsService";
import {
  RPC_MAX_PENDING_AUTHENTICATIONS,
  RPC_WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "./ingressLimits.js";
import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";
import { fixedPreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import { RPC_WEBSOCKET_ADMISSION_PATH } from "@vibestudio/rpc/protocol/rpcWebSocketAdmission";
import { WsUploadBodies } from "./rpcServer/wsUploadBodies.js";
import { bytesToBase64 } from "@vibestudio/rpc";
import type { StreamFrame } from "./services/egressProxy.js";

const originalAppRoot = process.env["VIBESTUDIO_APP_ROOT"];
const testProductAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-product-root-"));

beforeAll(() => {
  fs.mkdirSync(path.join(testProductAppRoot, "dist"));
  fs.writeFileSync(
    path.join(testProductAppRoot, "dist", "host-build-fingerprint.json"),
    JSON.stringify({ fingerprint: "ab".repeat(32) })
  );
  process.env["VIBESTUDIO_APP_ROOT"] = testProductAppRoot;
});

afterAll(() => {
  if (originalAppRoot === undefined) delete process.env["VIBESTUDIO_APP_ROOT"];
  else process.env["VIBESTUDIO_APP_ROOT"] = originalAppRoot;
  fs.rmSync(testProductAppRoot, { recursive: true, force: true });
});

describe("RPC WebSocket admission resolution deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("releases the caller at the deadline and ignores a later result", async () => {
    vi.useFakeTimers();
    let resolveCredential!: (value: string) => void;
    const credential = new Promise<string>((resolve) => {
      resolveCredential = resolve;
    });
    const pending = awaitRpcAdmissionResolution(credential, 250);

    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ status: "timed-out" });

    resolveCredential("too-late");
    await Promise.resolve();
    await expect(pending).resolves.toEqual({ status: "timed-out" });
  });
});

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
      // Executable entities always carry a real source identity in production:
      // the path and effective version together are their authority subject.
      repoPath: opts?.repoPath ?? (executable ? `tests/${kind}` : ""),
      effectiveVersion: opts?.effectiveVersion ?? (executable ? "ev-test" : ""),
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
        ? { activeAuthority: { requests: [], provides: [] } }
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
    inheritedTestPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy | null,
    executionSessionNonce?: string
  ): ReturnType<typeof createVerifiedCaller>;
  beginAuthorityParent(
    receiverRuntimeId: string,
    authorization: import("@vibestudio/rpc/internal").DirectAuthorityAttestation,
    authorizingCaller?: ReturnType<typeof createVerifiedCaller> | null
  ): () => void;
  authorityParentFor(
    callerRuntimeId: string,
    authorityParentNonce: string | undefined
  ): {
    testPolicy: import("@vibestudio/rpc").AgentExecutionTestPolicy | null;
    requested: readonly import("@vibestudio/rpc").CapabilityScope[] | null;
    authorizingCaller: ReturnType<typeof createVerifiedCaller> | null;
    contextIntegrity: import("@vibestudio/rpc").ContextIntegrityFact | null;
  } | null;
  connectionReconnectWaiters: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
  reconnectWaiters: Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }
  >;
  handleAuth(ws: unknown, token: string | null, connectionId: string): Promise<void>;
  handleConnection(ws: unknown): void;
  handleMessage(client: WsClientState, message: WsClientMessage): void;
  handleRoute(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): Promise<void> | void;
  handleClose(client: WsClientState, code: number, reason: string): void;
  handleRpc(client: WsClientState, message: RpcMessage, envelope: RpcEnvelope): Promise<void>;
  handleEnvelopeRequest(
    callerId: string,
    callerKind: CallerKind,
    agentBinding: undefined,
    envelope: RpcEnvelope,
    message: InternalRpcRequest,
    signal: AbortSignal
  ): Promise<unknown>;
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
    args: unknown[],
    meta?: {
      requestId?: string;
      idempotencyKey?: string;
      readOnly?: boolean;
      causalParent?: import("@vibestudio/rpc").RpcCausalParent;
      signal?: AbortSignal;
    },
    relayCallerScope?: {
      authenticatedCaller: ReturnType<typeof createVerifiedCaller>;
      authorizingCaller: ReturnType<typeof createVerifiedCaller>;
    }
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
  sendToSession(ws: unknown, msg: unknown): void;
  resolveCausalInvocation(
    caller: ReturnType<typeof createVerifiedCaller>,
    message: {
      causalParent?: import("@vibestudio/rpc").RpcCausalParent;
      parentRequestId?: string;
    }
  ): Promise<
    | {
        parent: import("@vibestudio/rpc").RpcCausalParent;
        initiatingUser: import("@vibestudio/identity/types").UserSubject | null;
        taskAuthority: import("@vibestudio/rpc").TaskGrantPrincipal | null;
      }
    | undefined
  >;
};

async function resolveCausalParent(
  server: RpcServer,
  caller: ReturnType<typeof createVerifiedCaller>,
  message: {
    causalParent?: import("@vibestudio/rpc").RpcCausalParent;
    parentRequestId?: string;
  }
): Promise<import("@vibestudio/rpc").RpcCausalParent | undefined> {
  return (await testServer(server).resolveCausalInvocation(caller, message))?.parent;
}

function testServer(server: RpcServer): TestRpcServer {
  return server as unknown as TestRpcServer;
}

/**
 * A real grant store, because admission alone grants nothing.
 *
 * Installed code's authority now comes from stored clearance grants, so a test
 * that wants a part to be allowed something mints the grant its review would
 * have minted rather than relying on a manifest to authorize itself.
 */
function createTestGrantStore(): CapabilityGrantStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-grants-"));
  const store = new CapabilityGrantStore({ statePath: root });
  grantStoreCleanups.push(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

const grantStoreCleanups: Array<() => void> = [];

afterEach(() => {
  while (grantStoreCleanups.length > 0) grantStoreCleanups.pop()!();
});

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
      ensureUserlandDoReady: async () => undefined,
      resolveExactCausalInvocation: async () => ({ initiatingUser: null }),
      ...opts,
    }),
  };
}

function createClient(callerId = "panel:nav-a"): WsClientState {
  const channel = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    transportBinding: { kind: "local" } as const,
    sendMessage: vi.fn(),
    takeInboundBody: vi.fn(() => undefined),
    sendStreamFrame: vi.fn(async (envelope: RpcEnvelope, frame: StreamFrame) =>
      channel.sendMessage(encodeWebSocketStreamFrame(envelope, frame))
    ),
    close: vi.fn(),
    terminate: vi.fn(),
    onMessage: vi.fn(() => () => undefined),
    onClose: vi.fn(() => () => undefined),
    onError: vi.fn(() => () => undefined),
  };
  return {
    caller: createVerifiedCaller(callerId, "panel"),
    connectionId: "conn-1",
    authenticated: true,
    authenticatedAt: Date.now(),
    // Mirror of caller.subject?.userId (WsClientState, WP4 §2.1), stamped at
    // admission. These panel connections model one owning user in these tests.
    userId: "user-1",
    ws: channel as RpcSessionChannel,
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
  const messageHandlers = new Set<(message: WsClientMessage, encodedBytes: number) => void>();
  const closeHandlers = new Set<(code: number, reason: string) => void>();
  const errorHandlers = new Set<(error: unknown) => void>();
  const send = vi.fn();
  return {
    OPEN: WebSocket.OPEN as number,
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    transportBinding: { kind: "local" } as const,
    send,
    sendMessage: vi.fn((message: WsServerMessage) => send(JSON.stringify(message))),
    takeInboundBody: vi.fn(() => undefined),
    sendStreamFrame: vi.fn(async (envelope: RpcEnvelope, frame: StreamFrame) =>
      send(JSON.stringify(encodeWebSocketStreamFrame(envelope, frame)))
    ),
    close: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    onMessage(handler: (message: WsClientMessage, encodedBytes: number) => void) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler: (code: number, reason: string) => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onError(handler: (error: unknown) => void) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    emitMessage(message: unknown) {
      const encodedBytes = Buffer.byteLength(JSON.stringify(message));
      for (const handler of messageHandlers) handler(message as WsClientMessage, encodedBytes);
    },
    emitClose(code = 1006, reason = "network") {
      this.readyState = WebSocket.CLOSED;
      for (const handler of closeHandlers) handler(code, reason);
    },
  };
}

function registerClient(server: RpcServer, client: WsClientState): void {
  testServer(server).connections.addClient(client);
}

/** Let queued promise callbacks (frame pumps, metering settles) run. */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake answerer pipe implementing the v3 attachable-pipe contract. */
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
    return (client.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { envelope?: { message?: RpcMessage } })
      .flatMap((msg) =>
        msg.envelope?.message?.type === "stream-frame"
          ? [msg.envelope.message as { frameType: number; payload: string }]
          : []
      );
  }

  it("uses raw bytes when the session channel is backed by an Iroh request stream", async () => {
    const { server, dispatcher } = setupStreamingServer();
    dispatcher.dispatch.mockResolvedValue(new Response("hello!", { status: 200 }));

    const client = createClient();
    const sends: Array<{ envelope: RpcEnvelope; frame: StreamFrame }> = [];
    const sendStreamFrame = vi.fn(
      (envelope: RpcEnvelope, frame: StreamFrame): Promise<void> | false => {
        sends.push({ envelope, frame });
        return Promise.resolve();
      }
    );
    (client.ws as unknown as { sendStreamFrame: unknown }).sendStreamFrame = sendStreamFrame;

    await handleRpc(server, client, streamRequest("sr-1"));

    expect(sends.map((s) => s.frame.kind)).toEqual(["head", "chunk", "end"]);
    expect(
      sends.every(
        (s) => "requestId" in s.envelope.message && s.envelope.message.requestId === "sr-1"
      )
    ).toBe(true);
    expect(sends[0]!.frame).toMatchObject({ kind: "head", status: 200 });
    const bodyFrame = sends[1]!.frame;
    expect(bodyFrame.kind).toBe("chunk");
    if (bodyFrame.kind === "chunk")
      expect(new TextDecoder().decode(bodyFrame.bytes)).toBe("hello!");
    expect(sends[2]!.frame).toEqual({ kind: "end", bytesIn: 6 });
    // Nothing went over the JSON ws.send path.
    expect(sentStreamFrames(client)).toHaveLength(0);
  });

  it("lets the loopback session channel encode streaming frames as bounded messages", async () => {
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

  it("registers parsed-service streams in sessionStreamAborts — a client stream-cancel stops the service read", async () => {
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
});

describe("RpcServer relay behavior", () => {
  it("rejects a resolved-service object with an actionable protocol error", async () => {
    const { server } = createServer();
    await expect(
      testServer(server).relayCall(
        "do:workers/eval:EvalDO:eval",
        "do",
        {
          kind: "durable-object",
          targetId: "do:workers/missions:MissionsDO:workspace-missions",
        } as never,
        "list",
        []
      )
    ).rejects.toMatchObject({
      code: "RPC_PROTOCOL_ERROR",
      message:
        "RPC target must be a target-id string; pass resolvedService.targetId, not the resolveService result object",
    });
  });

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

  it("preserves structured worker failures across the host relay", async () => {
    const { server } = createServer();
    server.setWorkerdUrl("http://127.0.0.1:8787");
    server.setWorkerInstanceResolver(() => "worker-instance");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            type: "response",
            requestId: "req",
            fromId: "worker",
            error: "approval required",
            errorKind: "access",
            errorCode: "EACQUIRE",
            errorData: {
              acquisition: { acquisitionId: "acq-worker", ownerRuntimeId: "panel:nav-a" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      testServer(server).relayCall(
        "panel:nav-a",
        "panel",
        "worker:workers/runtime-fixture:key",
        "probe",
        []
      )
    ).rejects.toMatchObject({
      name: "RemoteRpcError",
      errorKind: "access",
      code: "EACQUIRE",
      errorData: {
        acquisition: { acquisitionId: "acq-worker", ownerRuntimeId: "panel:nav-a" },
      },
    });
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

    expect(target.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((target.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
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

    expect(target.ws.sendMessage).not.toHaveBeenCalled();
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

    expect(target.ws.sendMessage).not.toHaveBeenCalled();
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
    const server = new RpcServer({
      tokenManager,
      dispatcher,
      entityCache,
      ensureUserlandDoReady: async () => undefined,
    });

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

  it("runs DO readiness before consulting the disposable entity cache", async () => {
    const ensureUserlandDoReady = vi.fn(async () => {
      throw new Error("exact execution is unavailable");
    });
    const { server } = createServer({ ensureUserlandDoReady });

    await expect(
      testServer(server).relayToDO(
        "panel:nav-a",
        "panel",
        "do:workers/example:Store:key",
        "ping",
        []
      )
    ).rejects.toThrow("exact execution is unavailable");
    expect(ensureUserlandDoReady).toHaveBeenCalledWith({
      source: "workers/example",
      className: "Store",
      objectKey: "key",
    });
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
    const resolveExactCausalInvocation = vi.fn(async () => ({ initiatingUser: null }));
    const { server, entityCache } = createServer({ resolveExactCausalInvocation });
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

    expect(resolveExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const relayed = JSON.parse(String(init.body)) as { message: { causalParent?: unknown } };
    expect(relayed.message.causalParent).toEqual(causalParent);
  });

  it("projects the host-verified account subject into DO caller attribution", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:workers/workspace-source:GadWorkspaceDO:workspace";
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

  it("uses extension code authority with the initiating panel's verified subject", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:vibestudio/internal:BrowserVaultDO:browser-data";
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
          message: { type: "response", requestId: "x", result: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const extensionCaller = createVerifiedCaller(
      "@workspace-extensions/browser-data",
      "extension",
      {
        callerId: "@workspace-extensions/browser-data",
        callerKind: "extension",
        repoPath: "extensions/browser-data",
        effectiveVersion: "ev-browser-data",
        executionDigest: "b".repeat(64),
        requested: [
          {
            capability: "browser-data.read",
            resource: { kind: "prefix", prefix: "do:vibestudio/internal:BrowserVaultDO:" },
          },
        ],
      }
    );
    extensionCaller.codeApproved = true;
    const authorizingCaller = createVerifiedCaller(
      "panel:nav-chat",
      "panel",
      {
        callerId: "panel:nav-chat",
        callerKind: "panel",
        repoPath: "panels/chat",
        effectiveVersion: "ev-chat",
        executionDigest: "c".repeat(64),
        requested: [],
      },
      null,
      { userId: "user-browser", handle: "browser-user" }
    );

    await testServer(server).relayToDO(
      extensionCaller.runtime.id,
      extensionCaller.runtime.kind,
      targetId,
      "listImportJobs",
      [],
      undefined,
      { authenticatedCaller: extensionCaller, authorizingCaller }
    );

    const envelope = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(envelope.delivery.caller).toMatchObject({
      callerId: "@workspace-extensions/browser-data",
      callerKind: "extension",
      userId: "user-browser",
      authorization: {
        context: {
          authorizingOrigin: {
            kind: "code",
            principal: "code:extensions/browser-data@ev-browser-data",
          },
        },
      },
    });
  });

  it("does not replace an exact causal user with an ambient authority subject", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:vibestudio/internal:BrowserVaultDO:causal-user";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    let inheritedAuthorizingCaller: ReturnType<typeof createVerifiedCaller> | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const outbound = JSON.parse(String(init.body));
      const nonce = outbound.delivery.caller.authorization.nonce as string;
      inheritedAuthorizingCaller =
        testServer(server).authorityParentFor(targetId, nonce)?.authorizingCaller ?? null;
      return new Response(
        JSON.stringify({
          from: targetId,
          target: "main",
          delivery: { caller: { callerId: targetId, callerKind: "do" } },
          provenance: [],
          message: { type: "response", requestId: "x", result: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const exactCausalCaller = createVerifiedCaller(
      "do:workers/agent-worker:AiChatWorker:agent-1",
      "do",
      {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-agent",
        executionDigest: "a".repeat(64),
        requested: [],
      },
      null,
      { userId: "usr_root", handle: "root" }
    );
    exactCausalCaller.codeApproved = true;
    const ambientAuthorityCaller = createVerifiedCaller("server", "server", null, null, {
      userId: "system",
      handle: "system",
    });

    await testServer(server).relayToDO(
      exactCausalCaller.runtime.id,
      exactCausalCaller.runtime.kind,
      targetId,
      "listImportJobs",
      [],
      undefined,
      {
        authenticatedCaller: exactCausalCaller,
        authorizingCaller: ambientAuthorityCaller,
      }
    );

    const envelope = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(envelope.delivery.caller).toMatchObject({
      callerId: exactCausalCaller.runtime.id,
      callerKind: "do",
      userId: "usr_root",
      authorization: {
        context: {
          authorizingOrigin: {
            kind: "code",
            principal: "code:workers/agent-worker@ev-agent",
          },
        },
      },
    });
    expect(inheritedAuthorizingCaller).toMatchObject({
      runtime: { id: "server", kind: "server" },
      subject: { userId: "usr_root", handle: "root" },
    });
  });

  it("refreshes a connected agent's self-channel binding before routed DO authority", async () => {
    const request = vi.fn();
    const { server, entityCache } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:channel",
          methodEffect: { kind: "open" },
          methodCapability: "workspace-service:channel",
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "sharing", verb: "act" },
          title: "Conversations",
          action: "send and receive messages in your conversations",
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
    const agentId = "do:workers/agent-worker:AiChatWorker:agent-1";
    const channelId = "chat-agent-1";
    const targetId = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
    entityCache._onActivate(
      makeRecord(agentId, "do", {
        contextId: "ctx-agent-1",
        repoPath: "workers/agent-worker",
        agentBinding: { entityId: agentId, contextId: "ctx-agent-1", channelId },
      })
    );
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            from: targetId,
            target: "main",
            delivery: { caller: { callerId: targetId, callerKind: "do" } },
            provenance: [],
            message: { type: "response", requestId: "x", result: { ok: true } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const admittedBeforeBinding = createVerifiedCaller(agentId, "do", {
      callerId: agentId,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-test",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "workspace-service:channel",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });
    admittedBeforeBinding.codeApproved = true;

    await testServer(server).relayToDO(agentId, "do", targetId, "subscribe", [], undefined, {
      authenticatedCaller: admittedBeforeBinding,
      authorizingCaller: admittedBeforeBinding,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("rejects distinct live panel runtime connections for the same caller", async () => {
    const { server, grantPanel } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    await testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    await testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-2");

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
    await Promise.resolve();
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

    expect(target1.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect(target2.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((target1.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
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
    (target.ws.sendMessage as ReturnType<typeof vi.fn>).mockClear();

    handleRoute(server, target, "panel:nav-a", {
      type: "response",
      requestId: "req-origin-2",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(origin1.ws.sendMessage).not.toHaveBeenCalled();
    expect(origin2.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((origin2.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
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

      expect(origin1.ws.sendMessage).not.toHaveBeenCalled();
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
      expect(target.ws.sendMessage).toHaveBeenCalledTimes(1);

      testServer(server).handleClose(target, 1006, "network");
      await vi.advanceTimersByTimeAsync(3001);

      const originMessages = (origin.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => message as { type: string }
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
      const originAfter = (origin.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => message as { type: string }
      );
      expect(originAfter.filter((m) => m.type === "ws:routed")).toHaveLength(0);
      const responderBounce = (target.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(([message]) => message as { type: string })
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
      expect(target.ws.sendMessage).toHaveBeenCalledTimes(1);

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

      const originMessages = (origin.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => message as { type: string }
      );
      expect(originMessages.filter((m) => m.type === "ws:routed-response-error")).toHaveLength(0);

      // The callee's (replayed/re-driven) response still reaches the caller.
      handleRoute(server, createClientWithConnection("panel:nav-b", "target-conn"), "panel:nav-a", {
        type: "response",
        requestId: "req-survives",
        result: { ok: true },
      });
      await vi.advanceTimersByTimeAsync(1);
      const routed = (origin.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(([message]) => message as { type: string })
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

      const originMessages = (origin.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => message as { type: string }
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

    expect(client.ws.sendMessage).not.toHaveBeenCalled();
    expect(target.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((target.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
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
    const frames = (client.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message as { envelope?: { message?: RpcMessage } })
      .flatMap((message) =>
        message.envelope?.message?.type === "stream-frame"
          ? [message.envelope.message as { frameType: number; payload: string }]
          : []
      );
    expect(frames.map((frame) => frame.frameType)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_END]);
    expect(Buffer.from(frames[1]!.payload, "base64").toString()).toBe("streamed");
  });

  it("authorizes a routed unary DO call with its verified causal task", async () => {
    const resolveExactCausalInvocation = vi.fn(async () => ({
      initiatingUser: { userId: "usr_initiator", handle: "initiator" },
      taskAuthority: "task:routed-turn" as const,
    }));
    const { server } = createServer({ resolveExactCausalInvocation });
    const relayToDO = vi.spyOn(testServer(server), "relayToDO").mockResolvedValue({ ok: true });
    const binding = {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId: "channel:agent",
    };
    const client = createClient();
    client.caller = createVerifiedCaller("do:agents:Agent:one", "do", null, binding);
    const causalParent = {
      kind: "trajectory-invocation" as const,
      ...channelTrajectoryFor(binding.channelId),
      invocationId: "invocation:routed-tool",
    };

    await handleRoute(server, client, "do:workers/example:Example:one", {
      type: "request",
      requestId: "routed-causal-task",
      fromId: client.caller.runtime.id,
      method: "example.write",
      args: [],
      causalParent,
    });

    expect(relayToDO).toHaveBeenCalledWith(
      client.caller.runtime.id,
      client.caller.runtime.kind,
      "do:workers/example:Example:one",
      "example.write",
      [],
      expect.objectContaining({ causalParent }),
      expect.objectContaining({
        authenticatedCaller: expect.objectContaining({
          subject: { userId: "usr_initiator", handle: "initiator" },
          taskAuthority: "task:routed-turn",
        }),
        authorizingCaller: expect.objectContaining({
          taskAuthority: "task:routed-turn",
        }),
      })
    );
  });

  it("retains the admission-bound sealed panel identity for a routed DO stream", async () => {
    const capabilityGrantStore = createTestGrantStore();
    // What admitting this panel would have minted: one version-bound grant per
    // install-clearable row. Admission alone grants nothing.
    mintUnitClearanceGrants({
      grantStore: capabilityGrantStore,
      units: [
        {
          repoPath: "panels/chat",
          effectiveVersion: "ev-chat",
          authority: {
            requests: [
              {
                capability: "rpc:subscribe",
                resource: { kind: "prefix", prefix: "" },
                tier: "gated",
                evidence: "intentional-broad",
              },
            ],
            provides: [],
          },
        },
      ],
      origin: "workspace-creation",
      decidedBy: "user:u1",
      issuedBy: "host:test",
    });
    const { server, entityCache } = createServer({ capabilityGrantStore });
    const targetId = "do:workers/pubsub-channel:PubSubChannel:chat-a";
    entityCache._onActivate(
      makeRecord("panel:nav-a", "panel", {
        repoPath: "panels/chat",
        effectiveVersion: "ev-chat",
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: {
          provides: [],
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
          principal: "code:panels/chat@ev-chat",
        },
      },
      grants: [
        expect.objectContaining({
          subject: "code:panels/chat@ev-chat",
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
          methodEffect: {
            kind: "userland-capability",
            capability: "channel.members.remove",
            resource: { kind: "receiver-object" },
          },
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
        substance: expect.objectContaining({
          summary: "remove a person from a shared conversation Conversations",
          detail: expect.stringContaining("Allow once permits only this call"),
          facts: expect.arrayContaining([
            {
              label: "Operation",
              value: "workers/pubsub-channel:PubSubChannel.removeMember",
            },
            { label: "Authority", value: "channel.members.remove" },
          ]),
        }),
        snapshot: expect.objectContaining({
          capability: "channel.members.remove",
          targetCapability: "workspace-service:channel",
        }),
      })
    );
  });

  it("enforces a builtin method's catalog-declared prepared context boundary", async () => {
    const request = vi.fn(() => ({
      acquisitionId: "acq:context-boundary",
      ownerRuntimeId: "panel:nav-a",
      snapshotDigest: "d".repeat(64),
      capability: "context.boundary",
      resourceKey: "context/ctx-b/requester/panel%3Anav-a",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "Move panel in",
      pending: true,
    }));
    const resolveProductBuiltinPreparedAuthority = vi.fn(() => [
      fixedPreparedAuthoritySelection({
        capability: "context.boundary",
        resourceKey: "context/ctx-b/requester/panel%3Anav-a",
        challenge: {
          title: "Move panel in another context",
          description: "Move the panel in another existing workspace branch.",
          deniedReason: "Moving the panel was denied",
          resource: { type: "context", label: "Workspace branch", value: "ctx-b" },
          operation: {
            kind: "panel",
            verb: "Move panel in",
            object: { type: "context", label: "Workspace branch", value: "ctx-b" },
          },
        },
      }),
    ]);
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [],
      resolveProductBuiltinPreparedAuthority,
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
        { capability: "context.boundary", resource: { kind: "prefix", prefix: "context/" } },
      ],
    });
    delete caller.codeApproved;

    await expect(
      testServer(server).directDOAuthorization({
        caller,
        ref: {
          source: "vibestudio/internal",
          className: "WorkspaceDO",
          objectKey: "workspace",
        },
        method: "slotMove",
        args: ["slot-a", "slot-b"],
      })
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(resolveProductBuiltinPreparedAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        method: "slotMove",
        contextBoundary: { operation: "movePanel", targetArgument: 0 },
      })
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        caller,
        renderedAction: "Move panel in",
        presentation: expect.objectContaining({ title: "Move panel in another context" }),
        resource: { kind: "exact", key: "context/ctx-b/requester/panel%3Anav-a" },
        snapshot: expect.objectContaining({
          capability: "context.boundary",
          resourceKey: "context/ctx-b/requester/panel%3Anav-a",
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
          methodEffect: { kind: "open" },
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
    const capabilityGrantStore = createTestGrantStore();
    // What admitting this panel would have minted: one version-bound grant per
    // install-clearable row. Admission alone grants nothing.
    mintUnitClearanceGrants({
      grantStore: capabilityGrantStore,
      units: [
        {
          repoPath: "panels/chat",
          effectiveVersion: "ev-chat",
          authority: {
            requests: [
              {
                capability: "workspace-service:probe",
                resource: { kind: "prefix", prefix: "" },
                tier: "gated",
                evidence: "intentional-broad",
              },
            ],
            // The receiver's declaration rides the same reviewed set, which is
            // what makes an in-workspace service call ordinary rather than
            // unknown.
            provides: [
              {
                name: "probe",
                title: "Probe",
                action: "use the probe",
                tier: "gated",
                sensitivity: "read",
                resourceType: "probe",
                presentation: { domain: "automation", verb: "act" },
                notability: "everyday",
                grantScopes: ["once", "task", "version"],
              },
            ],
          },
        },
      ],
      origin: "workspace-creation",
      decidedBy: "user:u1",
      issuedBy: "host:test",
    });
    const { server } = createServer({
      capabilityGrantStore,
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:probe",
          methodEffect: { kind: "open" },
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
      effect: { kind: "open" },
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
          methodEffect: { kind: "open" },
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
        presentation: expect.objectContaining({
          title: "Conversations",
          description: expect.stringContaining("Conversations"),
        }),
      })
    );
  });

  it("treats a declared workspace-service binding as wiring, not another consent", async () => {
    const request = vi.fn();
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:gad.workspace",
          serviceBinding: "declared",
          methodEffect: {
            kind: "host-capability",
            capability: "workspace.graph.read",
            resource: { kind: "receiver-object" },
          },
          methodCapability: "workspace.graph.read",
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "automation", verb: "manage" },
          title: "Workspace data",
          action: "use this workspace's files and history",
          declaredBy: "workers/workspace-source",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const caller = createVerifiedCaller("do:workers/pubsub-channel:PubSubChannel:chat-a", "do", {
      callerId: "do:workers/pubsub-channel:PubSubChannel:chat-a",
      callerKind: "do",
      repoPath: "workers/pubsub-channel",
      effectiveVersion: "ev-channel",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "workspace-service:gad.workspace",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });

    const attestation = await testServer(server).directDOAuthorization({
      caller,
      ref: {
        source: "workers/workspace-source",
        className: "GadWorkspaceDO",
        objectKey: "workspace",
      },
      method: "readGraph",
      args: [],
      readOnly: true,
    });

    expect(attestation).toMatchObject({
      capability: "workspace.graph.read",
      targetCapability: "workspace-service:gad.workspace",
      targetTier: "open",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a declared-for workspace-service binding as wiring only for named units", async () => {
    const request = vi.fn(() => ({
      acquisitionId: "acq:flowboard-store",
      ownerRuntimeId: "panel:other",
      snapshotDigest: "d".repeat(64),
      capability: "workspace-service:flowboard-store",
      resourceKey: "do:workers/flowboard-store:FlowboardStore:main",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "use Flowboard task storage",
      pending: true,
    }));
    const { server } = createServer({
      resolveWorkspaceDirectAuthority: async () => [
        {
          capability: "workspace-service:flowboard-store",
          serviceBinding: { declaredFor: ["panels/flowboard"] },
          methodEffect: { kind: "open" },
          methodCapability: "workspace-service:flowboard-store",
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "automation", verb: "manage" },
          title: "Flowboard task storage",
          action: "use Flowboard task storage",
          declaredBy: "workers/flowboard-store",
        },
      ],
      directAuthorityAcquirer: {
        request,
        acquire: vi.fn(),
        consume: vi.fn(() => true),
        invalidate: vi.fn(),
      },
    });
    const caller = (runtimeId: string, repoPath: string) =>
      createVerifiedCaller(runtimeId, "panel", {
        callerId: runtimeId,
        callerKind: "panel",
        repoPath,
        effectiveVersion: `ev-${runtimeId}`,
        executionDigest: "a".repeat(64),
        requested: [
          {
            capability: "workspace-service:flowboard-store",
            resource: { kind: "prefix", prefix: "" },
          },
        ],
      });
    const invoke = (verifiedCaller: ReturnType<typeof caller>) =>
      testServer(server).directDOAuthorization({
        caller: verifiedCaller,
        ref: {
          source: "workers/flowboard-store",
          className: "FlowboardStore",
          objectKey: "main",
        },
        method: "getBoard",
        args: [],
        readOnly: true,
      });

    await expect(invoke(caller("panel:flowboard", "panels/flowboard"))).resolves.toMatchObject({
      targetCapability: "workspace-service:flowboard-store",
      targetTier: "open",
    });
    expect(request).not.toHaveBeenCalled();

    await expect(invoke(caller("panel:other", "panels/other"))).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    expect(request).toHaveBeenCalledTimes(1);
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
          methodEffect: { kind: "open" },
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
        v: 2,
        authoritySessionId: "authority:test-run",
        authoritySessionVersion: 1,
        admissionKey: "test:doctor",
        controllerRuntimeId: "agent:test-controller",
        mode: "test",
        ownerUser: "user:user-1",
        workspaceId: "test-workspace",
        contextId: "ctx-test",
        agentBinding: null,
        taskRef: "eval:test-run",
        taskAuthority: "task:eval-test-run",
        executionImage: {
          principal: `code:workers/system-test-runner@ev-runner`,
          repoPath: "workers/system-test-runner",
          ref: "state:runner",
          effectiveVersion: "ev-runner",
          executionDigest: digest,
        },
        executor: {
          kind: "eval",
          runtimeId,
          evalRunId: "doctor",
          authorityManifest: {
            mode: "adaptive",
            effects: "read-write",
            approvals: "prompt",
            requests: [],
            digest: "0".repeat(64),
          },
        },
        parent: null,
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
      resourceKey: "do:workers/workspace-source:GadWorkspaceDO:workspace",
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
          methodEffect: { kind: "open" },
          methodTier: "open",
          principals: ["code"],
          presentation: { domain: "automation", verb: "act" },
          title: "Workspace history",
          action: "use workspace history",
          declaredBy: "workers/workspace-source",
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
          provides: [],
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
          source: "workers/workspace-source",
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
          callerPrincipal: "code:workers/pubsub-channel@ev-test",
          executionMode: "test",
          testPolicyId: policy.policyId,
        }),
      })
    );
  });

  it("admits hidden workspace-service test seams only for an attested system-test harness", async () => {
    const capability = "service:development.faultFailBuildAfterSnapshotRetained";
    const caller = createVerifiedCaller(
      "do:vibestudio/internal:EvalDO:test-development-fault",
      "do",
      {
        callerId: "do:vibestudio/internal:EvalDO:test-development-fault",
        callerKind: "do",
        repoPath: "workers/system-test-runner",
        effectiveVersion: "ev-runner",
        executionDigest: "c".repeat(64),
        requested: [
          { capability, resource: { kind: "prefix", prefix: "" } },
          { capability: "workspace-service:development", resource: { kind: "prefix", prefix: "" } },
        ],
      }
    );
    const ref = {
      source: "workers/development",
      className: "DevelopmentDO",
      objectKey: "workspace",
    };
    const invocation = {
      caller,
      ref,
      method: "faultFailBuildAfterSnapshotRetained",
      args: [
        {
          sessionId: "session:test",
          runId: "run:test",
          phase: "after-snapshot-retained",
        },
      ],
    } as const;

    const workspaceAuthority = {
      capability: "workspace-service:development",
      serviceBinding: "declared" as const,
      methodEffect: {
        kind: "host-capability" as const,
        capability,
        resource: { kind: "receiver-object" as const },
      },
      methodCapability: capability,
      methodTier: "open" as const,
      methodExecution: { harness: "attested-system-test" as const },
      principals: ["code" as const],
      presentation: { domain: "computer" as const, verb: "manage" as const },
      title: "System development",
      action: "manage development sessions",
      declaredBy: "workers/development",
    };
    const denied = createServer({
      isAttestedSystemTestHarness: () => false,
      resolveWorkspaceDirectAuthority: async () => [workspaceAuthority],
    }).server;
    await expect(testServer(denied).directDOAuthorization(invocation)).rejects.toMatchObject({
      code: "EACCES",
    });

    const admitted = createServer({
      isAttestedSystemTestHarness: () => true,
      resolveWorkspaceDirectAuthority: async () => [workspaceAuthority],
    }).server;
    await expect(testServer(admitted).directDOAuthorization(invocation)).resolves.toMatchObject({
      capability,
    });
  });

  it("attributes only explicitly marked EvalDO effects to the admitted execution", () => {
    const runtimeId = "do:vibestudio/internal:EvalDO:session-boundary";
    const nonce = "eval-session-nonce-1234";
    const session = {
      v: 2,
      authoritySessionId: "authority:session-boundary",
      authoritySessionVersion: 1,
      admissionKey: "eval:session-boundary",
      controllerRuntimeId: "agent:session-controller",
      mode: "interactive",
      ownerUser: "user:user-1",
      workspaceId: "test-workspace",
      contextId: "ctx:eval-session",
      agentBinding: null,
      taskRef: "eval:session-boundary",
      taskAuthority: "task:eval-session-boundary",
      executionImage: {
        principal: `code:workers/system-test-runner@ev-runner`,
        repoPath: "workers/system-test-runner",
        ref: "state:runner",
        effectiveVersion: "ev-runner",
        executionDigest: "b".repeat(64),
      },
      executor: {
        kind: "eval",
        runtimeId,
        evalRunId: "run:session-boundary",
        authorityManifest: {
          mode: "adaptive",
          effects: "read-write",
          approvals: "prompt",
          requests: [],
          digest: "0".repeat(64),
        },
      },
      parent: null,
      causalParent: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      nonce,
    } satisfies import("@vibestudio/rpc").ExecutionAdmissionFact;
    const executionSessionForRuntime = vi.fn(
      (candidateRuntimeId: string, candidateNonce: string) =>
        candidateRuntimeId === runtimeId && candidateNonce === nonce ? session : null
    );
    const { server, entityCache } = createServer({ executionSessionForRuntime });
    entityCache._onActivate(
      makeRecord(runtimeId, "do", {
        contextId: session.contextId,
        repoPath: "vibestudio/internal",
      })
    );

    const infrastructureCaller = testServer(server).verifiedCallerFor(runtimeId, "do");
    expect(infrastructureCaller.executionSession).toBeUndefined();
    expect(executionSessionForRuntime).not.toHaveBeenCalled();

    const evaluatedCaller = testServer(server).verifiedCallerFor(
      runtimeId,
      "do",
      undefined,
      undefined,
      undefined,
      nonce
    );
    expect(evaluatedCaller.executionSession).toBe(session);
    expect(executionSessionForRuntime).toHaveBeenCalledWith(runtimeId, nonce);

    expect(() =>
      testServer(server).verifiedCallerFor(
        runtimeId,
        "do",
        undefined,
        undefined,
        undefined,
        "wrong-eval-session-nonce"
      )
    ).toThrow(
      expect.objectContaining({
        code: "EVALUATED_EXECUTION_SESSION_NOT_ACTIVE",
        message: expect.stringMatching(/not active/),
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
        activeAuthority: { requests: [], provides: [] },
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

    expect(testServer(server).authorityParentFor(receiver, nonce)?.testPolicy).toEqual(policy);
    expect(() =>
      testServer(server).authorityParentFor("do:workers/other:OtherDO:headless-test", nonce)
    ).toThrow(/another runtime/);
    const caller = testServer(server).verifiedCallerFor(
      receiver,
      "do",
      undefined,
      undefined,
      testServer(server).authorityParentFor(receiver, nonce)?.testPolicy
    );
    expect(caller.executionSession).toBeUndefined();
    expect(caller.testPolicy).toEqual(policy);

    release();
    expect(() => testServer(server).authorityParentFor(receiver, nonce)).toThrow(
      expect.objectContaining({
        code: "INVOCATION_AUTHORITY_PARENT_NOT_ACTIVE",
        message: expect.stringMatching(/not active/),
      })
    );
  });

  it("retains the verified initiator only for the exact active receiver invocation", () => {
    const { server } = createServer();
    const receiver = "do:workers/development:DevelopmentDO:workspace";
    const initiator = createVerifiedCaller("shell:device-one", "shell", null, null, {
      userId: "user-1",
      handle: "user1",
    });
    const nonce = "host-minted-development-initiator-nonce";
    const release = testServer(server).beginAuthorityParent(
      receiver,
      {
        nonce,
        method: "listClientExecutors",
        context: {},
      } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation,
      initiator
    );

    expect(testServer(server).authorityParentFor(receiver, nonce)?.authorizingCaller).toBe(
      initiator
    );
    expect(() =>
      testServer(server).authorityParentFor(
        "do:workers/development:DevelopmentDO:another-workspace",
        nonce
      )
    ).toThrow(/another runtime/);

    release();
    expect(() => testServer(server).authorityParentFor(receiver, nonce)).toThrow(/not active/);
  });

  it("retains sealed webhook lineage through the exact publisher invocation and nested channel call", async () => {
    const { server, entityCache } = createServer();
    const publisher = "do:workers/github:GithubDO:publisher";
    const channel = "do:workers/pubsub-channel:PubSubChannel:channel-1";
    entityCache._onActivate(
      makeRecord(publisher, "do", { repoPath: "workers/github", contextId: "ctx-webhook" })
    );
    entityCache._onActivate(
      makeRecord(channel, "do", {
        repoPath: "workers/pubsub-channel",
        contextId: "ctx-webhook",
      })
    );
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    const envelopes: RpcEnvelope[] = [];
    const serviceContexts: ServiceContext[] = [];
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: ServiceContext) => {
      serviceContexts.push(ctx);
      return { ok: true };
    });
    let publisherNonce = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body)) as RpcEnvelope;
      envelopes.push(envelope);
      const request = envelope.message as InternalRpcRequest;
      const authorization = (envelope.delivery.caller as AttestedCaller).authorization!;
      if (envelope.target === publisher && request.method === "onPush") {
        publisherNonce = authorization.nonce;
        const nested: InternalRpcRequest = {
          type: "request",
          requestId: "nested-channel-publish",
          fromId: publisher,
          method: "publish",
          args: [{ contentClass: "internal", externalKeys: [] }],
          authorityParentNonce: publisherNonce,
        };
        const nestedEnvelope = envelopeFromMessage({
          selfId: publisher,
          from: publisher,
          target: channel,
          callerKind: "do",
          message: nested,
        });
        await testServer(server).handleEnvelopeRequest(
          publisher,
          "do",
          undefined,
          nestedEnvelope,
          nested,
          new AbortController().signal
        );
        const nestedService: InternalRpcRequest = {
          type: "request",
          requestId: "nested-host-service",
          fromId: publisher,
          method: "test.observe",
          args: [],
          authorityParentNonce: publisherNonce,
        };
        await testServer(server).handleEnvelopeRequest(
          publisher,
          "do",
          undefined,
          envelopeFromMessage({
            selfId: publisher,
            from: publisher,
            target: "main",
            callerKind: "do",
            message: nestedService,
          }),
          nestedService,
          new AbortController().signal
        );
      }
      return new Response(
        JSON.stringify(
          responseEnvelopeFor(
            envelope,
            { callerId: envelope.target, callerKind: "do" },
            { type: "response", requestId: request.requestId, result: { ok: true } }
          )
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const externalKey = `api:webhook:${"a".repeat(64)}`;
    await server.callTarget(
      publisher,
      "onPush",
      [{ contextIntegrity: { class: "internal", externalKeys: [] } }],
      bindVerifiedExternalContext(
        {},
        {
          class: "external",
          latchEpoch: 0,
          externalKeys: [externalKey],
        }
      )
    );

    expect(envelopes).toHaveLength(2);
    for (const envelope of envelopes) {
      expect(
        (envelope.delivery.caller as AttestedCaller).authorization?.context.contextIntegrity
      ).toEqual({ class: "external", latchEpoch: 0, externalKeys: [externalKey] });
    }
    expect(serviceContexts).toHaveLength(1);
    expect(serviceContexts[0]!.inheritedContextIntegrity).toEqual({
      class: "external",
      latchEpoch: 0,
      externalKeys: [externalKey],
    });
    expect(envelopes[1]).toMatchObject({
      target: channel,
      message: { args: [{ contentClass: "internal", externalKeys: [] }] },
    });

    const staleNested: InternalRpcRequest = {
      type: "request",
      requestId: "stale-channel-publish",
      fromId: publisher,
      method: "publish",
      args: [],
      authorityParentNonce: publisherNonce,
    };
    await expect(
      testServer(server).handleEnvelopeRequest(
        publisher,
        "do",
        undefined,
        envelopeFromMessage({
          selfId: publisher,
          from: publisher,
          target: channel,
          callerKind: "do",
          message: staleNested,
        }),
        staleNested,
        new AbortController().signal
      )
    ).rejects.toThrow(/not active/);

    envelopes.length = 0;
    await server.callTarget(publisher, "untrustedArgsOnly", [
      { contentClass: "external", externalKeys: [externalKey] },
    ]);
    expect(
      (envelopes[0]!.delivery.caller as AttestedCaller).authorization?.context.contextIntegrity
    ).toEqual({ class: "not-applicable", latchEpoch: 0, externalKeys: [] });

    await expect(
      server.callTarget(
        "panel:nav-a",
        "onPush",
        [],
        bindVerifiedExternalContext(
          {},
          {
            class: "external",
            latchEpoch: 0,
            externalKeys: [externalKey],
          }
        )
      )
    ).rejects.toThrow(/requires a direct Durable Object target/);
  });

  it("binds a builtin's outbound request ceiling to the exact active method", () => {
    const { server } = createServer();
    const receiver = "do:vibestudio/internal:EvalDO:owner";

    const admittedNonce = "host-minted-eval-execute-run-nonce";
    const releaseAdmitted = testServer(server).beginAuthorityParent(receiver, {
      nonce: admittedNonce,
      method: "executeRun",
      context: {},
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);
    expect(testServer(server).authorityParentFor(receiver, admittedNonce)?.requested).toEqual([
      {
        capability: "external.open",
        resource: { kind: "prefix", prefix: "" },
      },
    ]);
    releaseAdmitted();

    const deniedNonce = "host-minted-eval-inspection-nonce";
    const releaseDenied = testServer(server).beginAuthorityParent(receiver, {
      nonce: deniedNonce,
      method: "listRetainedExecutionRoots",
      context: {},
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);
    expect(testServer(server).authorityParentFor(receiver, deniedNonce)?.requested).toEqual([]);
    releaseDenied();
  });

  it("does not inherit builtin requests for a userland class-name collision", () => {
    const { server } = createServer();
    const receiver = "do:workers/untrusted:EvalDO:owner";
    const nonce = "host-minted-userland-eval-collision-nonce";
    const release = testServer(server).beginAuthorityParent(receiver, {
      nonce,
      method: "executeRun",
      context: {},
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);

    expect(testServer(server).authorityParentFor(receiver, nonce)?.requested).toBeNull();
    release();
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
        agent: {
          model: "openai-codex:gpt-5.3-codex-spark",
          approvalLevel: 2,
          fallback: "disabled",
        },
        authority: [],
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
        activeAuthority: { requests: [], provides: [] },
      })
    );
    const nonce = "host-minted-direct-authority-case-nonce";
    const release = testServer(server).beginAuthorityParent(receiver, {
      nonce,
      context: { testPolicy: orchestrator },
    } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);

    expect(testServer(server).authorityParentFor(receiver, nonce)?.testPolicy).toBe(casePolicy);
    expect(
      testServer(server).verifiedCallerFor(
        receiver,
        "do",
        undefined,
        undefined,
        testServer(server).authorityParentFor(receiver, nonce)?.testPolicy
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
        agent: {
          model: "openai-codex:gpt-5.3-codex-spark",
          approvalLevel: 2,
          fallback: "disabled",
        },
        authority: [],
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
        activeAuthority: { requests: [], provides: [] },
      })
    );

    for (const [index, policy] of [casePolicy("first"), casePolicy("second")].entries()) {
      const nonce = `host-minted-shared-receiver-nonce-${index}`;
      const release = testServer(server).beginAuthorityParent(receiver, {
        nonce,
        context: { testPolicy: policy },
      } as import("@vibestudio/rpc/internal").DirectAuthorityAttestation);
      expect(testServer(server).authorityParentFor(receiver, nonce)?.testPolicy).toBe(policy);
      release();
    }

    expect(testServer(server).verifiedCallerFor(receiver, "do").testPolicy).toBe(orchestrator);
  });

  it("keeps an agent binding as a relationship fact rather than inventing a session origin", async () => {
    const contextIntegrity = {
      class: "external" as const,
      latchEpoch: 3,
      externalKeys: ["web:models.example"],
    };
    const { server, entityCache } = createServer({
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
      session: { id: "channel-stable" },
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
    expect(client.ws.sendMessage).not.toHaveBeenCalled();
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

    expect(target.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((target.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
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

  it("reports exact panel route reachability only while its authenticated bridge is open", () => {
    const { server, grantPanel } = createServer();
    expect(server.isRuntimeRouteReachable("panel:nav-a", "conn-1")).toBe(false);

    const targetWs = createTestWs();
    testServer(server).handleAuth(targetWs, grantPanel("panel:nav-a"), "conn-1");
    expect(server.isRuntimeRouteReachable("panel:nav-a", "conn-1")).toBe(true);

    targetWs.emitClose();
    expect(server.isRuntimeRouteReachable("panel:nav-a", "conn-1")).toBe(false);
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

    expect(client.ws.sendMessage).toHaveBeenCalledTimes(1);
    expect((client.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
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
      testServer(server).handleMessage(client, {
        type: "ws:rpc",
        envelope: clientEnvelope(client, "main", request),
      });

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
          provides: [],
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

    await expect(resolveCausalParent(server, caller, { causalParent })).resolves.toEqual(
      causalParent
    );
    await expect(
      resolveCausalParent(server, caller, {
        causalParent: {
          ...causalParent,
          ...channelTrajectoryFor("channel:sibling"),
        },
      })
    ).rejects.toThrow(/does not match/);
    await expect(
      resolveCausalParent(server, createVerifiedCaller("worker:one", "worker"), {
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
      resolveCausalParent(server, createVerifiedCaller(vesselId, "do"), {
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
    const unavailable = createServer({ resolveExactCausalInvocation: undefined }).server;
    await expect(resolveCausalParent(unavailable, caller, { causalParent })).rejects.toThrow(
      /verification is unavailable/
    );

    const resolveExactCausalInvocation = vi.fn(async () => null);
    const missing = createServer({ resolveExactCausalInvocation }).server;
    await expect(resolveCausalParent(missing, caller, { causalParent })).rejects.toThrow(
      /does not exist/
    );
    expect(resolveExactCausalInvocation).toHaveBeenCalledWith(causalParent);
  });

  it("rejects nonexistent causal parents before unary and streaming service dispatch", async () => {
    const resolveExactCausalInvocation = vi.fn(async () => null);
    const { server } = createServer({ resolveExactCausalInvocation });
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
    const messages = (client.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      ([message]) => message as WsServerMessage
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
    expect(resolveExactCausalInvocation).toHaveBeenCalledTimes(2);
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
    const calls = (client.ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1]![0] as {
      envelope: { message: { result?: unknown; error?: string } };
    };
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
      contractVersion: RPC_CONTRACT_VERSION,
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
      contractVersion: RPC_CONTRACT_VERSION,
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

  it("reports an already-used or expired pairing link without exposing credential details", async () => {
    const rejection = Object.assign(new Error("internal pairing lookup detail"), {
      code: "PAIRING_CODE_INVALID_OR_EXPIRED",
    });
    const { server } = createServer({
      redeemPairingCredential: async () => Promise.reject(rejection),
    });
    const ws = createTestWs();
    testServer(server).handleConnection(ws);

    ws.emitMessage({
      type: "ws:auth",
      contractVersion: RPC_CONTRACT_VERSION,
      token: "used-pairing-code",
      connectionId: "pairing-conn",
    });
    await flushAsync();

    const authResults = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(authResults).toContainEqual({
      type: "ws:auth-result",
      success: false,
      errorCode: "pairing_invalid_or_expired",
      error:
        "This pairing link has already been used or has expired. Pairing links are one-time to prevent replay; request a fresh link from the server or a paired administrator.",
    });
    expect(JSON.stringify(authResults)).not.toContain("internal pairing lookup detail");
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
      contractVersion: RPC_CONTRACT_VERSION,
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
    const grant = connectionGrants.grant("@workspace-apps/remote-cli", "server", {
      subject: { userId: "system", handle: "system" },
    }).token;
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
    const authorizingCaller = {
      ...createVerifiedCaller("do:agents/AgentDO:agent-1", "do"),
      taskAuthority: "task:trajectory-turn" as const,
    };
    const resolveExtensionInvocation = vi.fn(() => ({
      caller: {
        callerId: "do:agents/AgentDO:agent-1",
        callerKind: "do" as const,
      },
      authorizingCaller,
      causalParent,
    }));
    const resolveExactCausalInvocation = vi.fn(async () => ({
      initiatingUser: null,
      taskAuthority: "task:trajectory-turn" as const,
    }));
    const { server } = createServer({
      resolveExtensionInvocation,
      resolveExactCausalInvocation,
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
    expect(resolveExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: {
        runtime: { id: "@workspace-extensions/tools", kind: "extension" },
        taskAuthority: "task:trajectory-turn",
      },
      authorizingCaller,
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
    client.ws.sendMessage = vi.fn(() => order.push("response"));
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
    expect(active.ws.sendMessage).toHaveBeenCalledOnce();
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
  it("keeps admission shutdown responses on the typed protocol", async () => {
    const { server } = createServer();
    server.quiesce("Server shutting down");
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await server.handleGatewayHttpRequest(
      {
        method: "POST",
        url: RPC_WEBSOCKET_ADMISSION_PATH,
        headers: {},
        resume: vi.fn(),
      } as unknown as IncomingMessage,
      response as never
    );

    expect(response.writeHead).toHaveBeenCalledWith(
      503,
      expect.objectContaining({ "Content-Type": "application/json" })
    );
    expect(JSON.parse(response.end.mock.calls[0]?.[0] as string)).toMatchObject({
      ok: false,
      code: "server_unavailable",
    });
  });

  it("can own a gateway WebSocket upgrade without a second RPC path", () => {
    const { server, tokenManager } = createServer();
    const token = tokenManager.ensureToken("worker:upgrade-test", "worker");
    const grant = "admission-grant";
    server.initHandlers();
    const waitingSocket = createTestWs();
    const internal = server as unknown as {
      wss: {
        options: { maxPayload: number };
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
    (
      server as unknown as {
        wsAdmissionGrants: Map<string, unknown>;
      }
    ).wsAdmissionGrants.set(grant, {
      grant,
      expiresAt: Date.now() + 15_000,
      resolved: {
        entry: tokenManager.validateToken(token),
        isValidAtUpgrade: () => true,
      },
    });

    server.handleGatewayWsUpgrade(
      {
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("rpc", grant),
        },
      } as IncomingMessage,
      {} as Duplex,
      Buffer.alloc(0)
    );

    expect(upgrade).toHaveBeenCalledOnce();
    expect(internal.wss.options.maxPayload).toBe(RPC_WEBSOCKET_MAX_PAYLOAD_BYTES);
    expect(testServer(server).pendingAuthentications.size).toBe(1);
  });

  it("rejects RPC upgrades without a credential before ws allocates a receiver", () => {
    const { server } = createServer();
    server.initHandlers();
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const internal = server as unknown as { wss: { handleUpgrade: ReturnType<typeof vi.fn> } };
    const upgrade = vi.spyOn(internal.wss, "handleUpgrade");

    server.handleGatewayWsUpgrade(
      { headers: {} } as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0)
    );

    expect(upgrade).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"
    );
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a valid caller bearer sent directly through the legacy upgrade path", () => {
    const { server, tokenManager } = createServer();
    const token = tokenManager.ensureToken("worker:no-direct-upgrade", "worker");
    server.initHandlers();
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const internal = server as unknown as { wss: { handleUpgrade: ReturnType<typeof vi.fn> } };
    const upgrade = vi.spyOn(internal.wss, "handleUpgrade");

    server.handleGatewayWsUpgrade(
      {
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("rpc", token),
        },
      } as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0)
    );

    expect(upgrade).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"
    );
  });

  it("prunes an expired admission grant before WebSocket receiver allocation", () => {
    const { server, tokenManager } = createServer();
    const token = tokenManager.ensureToken("worker:expired-admission", "worker");
    const grant = "expired-grant";
    server.initHandlers();
    const admissionGrants = (
      server as unknown as {
        wsAdmissionGrants: Map<string, unknown>;
      }
    ).wsAdmissionGrants;
    admissionGrants.set(grant, {
      grant,
      expiresAt: Date.now() - 1,
      resolved: {
        entry: tokenManager.validateToken(token),
        isValidAtUpgrade: () => true,
      },
    });
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const internal = server as unknown as { wss: { handleUpgrade: ReturnType<typeof vi.fn> } };
    const upgrade = vi.spyOn(internal.wss, "handleUpgrade");

    server.handleGatewayWsUpgrade(
      {
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("rpc", grant),
        },
      } as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0)
    );

    expect(upgrade).not.toHaveBeenCalled();
    expect(admissionGrants.has(grant)).toBe(false);
  });

  it("consumes an admission grant once before allocating a receiver", () => {
    const { server, tokenManager } = createServer();
    server.initHandlers();
    const token = tokenManager.ensureToken("worker:one-use-admission", "worker");
    const grant = "one-use-grant";
    (
      server as unknown as {
        wsAdmissionGrants: Map<string, unknown>;
      }
    ).wsAdmissionGrants.set(grant, {
      grant,
      expiresAt: Date.now() + 15_000,
      resolved: {
        entry: tokenManager.validateToken(token),
        isValidAtUpgrade: () => true,
      },
    });
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const internal = server as unknown as { wss: { handleUpgrade: ReturnType<typeof vi.fn> } };
    const upgrade = vi.spyOn(internal.wss, "handleUpgrade").mockImplementation(() => undefined);

    server.handleGatewayWsUpgrade(
      {
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("rpc", grant),
        },
      } as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0)
    );
    expect(upgrade).toHaveBeenCalledOnce();

    server.handleGatewayWsUpgrade(
      {
        headers: {
          "sec-websocket-protocol": webSocketAuthProtocol("rpc", grant),
        },
      } as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0)
    );
    expect(upgrade).toHaveBeenCalledOnce();
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"
    );
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("bounds unauthenticated RPC connections before allocating another timer", async () => {
    const { server } = createServer();
    for (let i = 0; i < RPC_MAX_PENDING_AUTHENTICATIONS; i += 1) {
      testServer(server).pendingAuthentications.set({ id: i }, null);
    }
    const rejected = createTestWs();

    testServer(server).handleConnection(rejected);

    expect(rejected.close).toHaveBeenCalledWith(
      1013,
      "Too many pending RPC authentications; retry shortly"
    );
    expect(testServer(server).pendingAuthentications.size).toBe(RPC_MAX_PENDING_AUTHENTICATIONS);
    testServer(server).pendingAuthentications.clear();
    await server.stop();
  });

  it("releases owned work and ignores delayed socket closes after idempotent stop", async () => {
    const { server, tokenManager } = createServer();
    const disposeRevocation = vi.fn();
    vi.spyOn(tokenManager, "onRevoke").mockReturnValue(disposeRevocation);
    server.initHandlers();

    const waitingSocket = createTestWs();
    testServer(server).handleConnection(waitingSocket);
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
    testServer(server).handleConnection(lateSocket);
    expect(lateSocket.close).toHaveBeenCalledWith(1001, "Server shutting down");
  });
});

// ---------------------------------------------------------------------------
// §1.6 uploads — inbound request bodies on the bulk channel
// ---------------------------------------------------------------------------

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

  it("threads an ordered loopback WebSocket upload into the service context", async () => {
    const { server, dispatcher } = setupStreamingServer();
    let seenBody = "";
    dispatcher.dispatch.mockImplementation(async (ctx: { body?: ReadableStream<Uint8Array> }) => {
      seenBody = await new Response(ctx.body).text();
      return new Response("ok", { status: 200 });
    });

    const client = createClient();
    client.uploadBodies = new WsUploadBodies();
    testServer(server).connections.addClient(client);
    const request = streamRequest("sr-ws-upload", "gateway.fetch", [
      { path: "/x", method: "POST" },
    ]);
    testServer(server).handleMessage(client, {
      type: "ws:rpc",
      envelope: clientEnvelope(client, "main", request),
      streamBody: true,
    });
    await client.uploadBodies.push({
      requestId: "sr-ws-upload",
      seq: 0,
      payload: bytesToBase64(new TextEncoder().encode("uploaded")),
    });
    await client.uploadBodies.push({ requestId: "sr-ws-upload", seq: 1, done: true });
    await vi.waitFor(() => expect(seenBody).toBe("uploaded"));
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
    const sends: StreamFrame[] = [];
    (client.ws as unknown as Record<string, unknown>)["sendStreamFrame"] = vi.fn(
      (_envelope: RpcEnvelope, frame: StreamFrame) => {
        sends.push(frame);
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
    expect(sends[0]).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly one"),
    });
  });

  it("a loopback session without an upload dispatches with no request body", async () => {
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
