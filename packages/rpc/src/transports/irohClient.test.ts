import {
  IROH_WIRE_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_ENVELOPE_FRAME_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  readFrame,
  readIrohStreamPreamble,
  writeChunked,
  writeFrame,
  writeIrohStreamPreamble,
} from "@vibestudio/iroh-transport";
import {
  bindNodeEndpoint,
  configureNodeConnection,
  loadIrohNodeBinding,
  NodePhysicalConnection,
  VIBESTUDIO_IROH_ALPN,
} from "@vibestudio/iroh-transport/node";
import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { createRpcClient } from "../client.js";
import { isRpcConnectionLost } from "../errors.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import { encodeIrohStreamResponseHead } from "../protocol/irohStreamResponse.js";
import {
  decodeIrohSessionControlFrame,
  encodeIrohSessionControlFrame,
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
  IROH_SESSION_CLOSE,
} from "../protocol/irohSession.js";
import type { RpcEnvelope, RpcRequest } from "../types.js";
import {
  createIrohClientPipe,
  irohReceiveStreamBody,
  IrohResponseHeadTimeoutError,
} from "./irohClient.js";

const { SecretKey } = loadIrohNodeBinding();

describe("Iroh RPC client over real local QUIC", () => {
  const endpoints = new Set<Awaited<ReturnType<typeof bindNodeEndpoint>>>();

  afterEach(async () => {
    await Promise.all([...endpoints].map((endpoint) => endpoint.close().catch(() => undefined)));
    endpoints.clear();
  });

  async function bind() {
    const endpoint = await bindNodeEndpoint({ secretKey: SecretKey.generate() });
    endpoints.add(endpoint);
    return endpoint;
  }

  it("retires an unused pipe without opening a handshake or leaking a rejection", async () => {
    const connection = {
      peerEndpointId: "unused-peer",
      openBi: vi.fn(async () => {
        throw new Error("Unused pipe must not open a stream");
      }),
      acceptBi: vi.fn(async () => {
        throw new Error("Unused pipe must not accept a stream");
      }),
      close: vi.fn(),
      closed: vi.fn(async () => "closed"),
    };
    const pipe = createIrohClientPipe(connection);
    await pipe.close();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.openBi).not.toHaveBeenCalled();
    // Vitest treats a rejected, unobserved private handshake as a test failure.
  });

  it.each(["pipe", "session"] as const)(
    "rejects readiness when the %s closes before the peer handshake",
    async (owner) => {
      const serverEndpoint = await bind();
      const clientEndpoint = await bind();
      const incomingPromise = serverEndpoint.acceptNext();
      const connecting = clientEndpoint.connect(serverEndpoint.addr(), [...VIBESTUDIO_IROH_ALPN]);
      const incoming = await incomingPromise;
      if (!incoming) throw new Error("Server closed before connection");
      const accepting = await incoming.accept();
      const [serverNative, clientNative] = await Promise.all([accepting.connect(), connecting]);
      configureNodeConnection(serverNative);
      configureNodeConnection(clientNative);
      const server = new NodePhysicalConnection(serverNative);
      const pipe = createIrohClientPipe(new NodePhysicalConnection(clientNative));
      const physical = vi.fn();
      const logical = vi.fn();
      const physicalReady = pipe.ready().catch(physical);
      const getToken = vi.fn(() => "credential");
      const session = pipe.openSession({ getToken });
      const logicalReady = session.ready!().catch(logical);
      try {
        const control = await server.acceptBi();
        await readIrohStreamPreamble(control.recv);
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES);
        // The peer deliberately has not returned HELLO. Explicit close must
        // terminate that readiness owner as well as the native connection.
        await (owner === "pipe" ? pipe : session).close();
        for (let index = 0; index < 10; index++) await Promise.resolve();
        expect(logical).toHaveBeenCalledWith(expect.objectContaining({ code: "CONNECTION_LOST" }));
        if (owner === "pipe") {
          expect(physical).toHaveBeenCalledWith(
            expect.objectContaining({ code: "CONNECTION_LOST" })
          );
        } else {
          expect(physical).not.toHaveBeenCalled();
          await writeFrame(
            control.send,
            encodeIrohSessionControlFrame({
              t: IROH_SESSION_HELLO,
              protocolVersion: IROH_WIRE_VERSION,
              contractVersion: RPC_CONTRACT_VERSION,
            }),
            MAX_CONTROL_FRAME_BYTES
          );
          await pipe.ready();
          expect(pipe.status()).toBe("connected");
          expect(getToken).not.toHaveBeenCalled();
        }
        await Promise.all([physicalReady, logicalReady]);
      } finally {
        await pipe.close();
        server.close(0n, new TextEncoder().encode("fixture cleanup"));
      }
    }
  );

  it("propagates the owner failure when a cancelled native read resolves as EOF", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    const pendingRead = new Promise<Uint8Array>((resolve) => {
      finishRead = resolve;
    });
    let failure: unknown;
    const cancel = vi.fn(async () => {});
    const settled = vi.fn();
    const reader = irohReceiveStreamBody(
      {
        read: vi
          .fn()
          .mockResolvedValueOnce(new Uint8Array([1]))
          .mockReturnValue(pendingRead),
        readExact: vi.fn(),
        stop: vi.fn(),
        receivedReset: vi.fn(),
      },
      { cancel, failure: () => failure, settled }
    ).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const original = new Error("Original duplex upload failure");
    const rejected = expect(reader.read()).rejects.toBe(original);
    failure = original;
    finishRead(new Uint8Array());
    await rejected;
    expect(cancel).toHaveBeenCalledWith(original);
    expect(settled).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it.each(["pipe", "session"] as const)(
    "rejects session readiness when the %s closes during credential refresh",
    async (owner) => {
      const serverEndpoint = await bind();
      const clientEndpoint = await bind();
      const incomingPromise = serverEndpoint.acceptNext();
      const clientConnecting = clientEndpoint.connect(serverEndpoint.addr(), [
        ...VIBESTUDIO_IROH_ALPN,
      ]);
      const incoming = await incomingPromise;
      if (!incoming) throw new Error("server endpoint closed before connection");
      const accepting = await incoming.accept();
      const [serverNative, clientNative] = await Promise.all([
        accepting.connect(),
        clientConnecting,
      ]);
      configureNodeConnection(serverNative);
      configureNodeConnection(clientNative);
      const server = new NodePhysicalConnection(serverNative);
      const serverTask = (async () => {
        const control = await server.acceptBi();
        await readIrohStreamPreamble(control.recv);
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES);
        await writeFrame(
          control.send,
          encodeIrohSessionControlFrame({
            t: IROH_SESSION_HELLO,
            protocolVersion: IROH_WIRE_VERSION,
            contractVersion: RPC_CONTRACT_VERSION,
          }),
          MAX_CONTROL_FRAME_BYTES
        );
      })();
      const pipe = createIrohClientPipe(new NodePhysicalConnection(clientNative));
      let releaseToken!: (value: string) => void;
      let requestedToken!: () => void;
      const tokenRequested = new Promise<void>((resolve) => {
        requestedToken = resolve;
      });
      const token = new Promise<string>((resolve) => {
        releaseToken = resolve;
      });
      const session = pipe.openSession({
        getToken: () => {
          requestedToken();
          return token;
        },
      });
      const rejected = session.ready?.().catch((reason: unknown) => reason);
      try {
        await tokenRequested;
        await (owner === "pipe" ? pipe : session).close();
        // Readiness settles even while token retrieval remains pending. Vitest
        // also rejects any unhandled rejection from the pending open result.
        const error = await rejected;
        expect(error).toMatchObject({
          message:
            owner === "pipe"
              ? "Iroh pipe closed"
              : expect.stringMatching(/^Iroh session .* closed$/),
          errorKind: "transport",
          code: "CONNECTION_LOST",
        });
        expect(isRpcConnectionLost(error)).toBe(true);
      } finally {
        releaseToken("expired-credential");
        await serverTask;
        await pipe.close();
      }
    }
  );

  it("exposes response-head timeouts as a structured transient transport error", () => {
    const error = new IrohResponseHeadTimeoutError(20_000);
    expect(error).toMatchObject({
      code: "IROH_RESPONSE_HEAD_TIMEOUT",
      timeoutMs: 20_000,
      name: "IrohResponseHeadTimeoutError",
    });
  });

  it("keeps sibling sessions usable after a retired session's authentication reply arrives", async () => {
    const serverEndpoint = await bind();
    const clientEndpoint = await bind();
    const incomingPromise = serverEndpoint.acceptNext();
    const connecting = clientEndpoint.connect(serverEndpoint.addr(), [...VIBESTUDIO_IROH_ALPN]);
    const incoming = await incomingPromise;
    if (!incoming) throw new Error("server endpoint closed before connection");
    const accepting = await incoming.accept();
    const [serverNative, clientNative] = await Promise.all([accepting.connect(), connecting]);
    configureNodeConnection(serverNative);
    configureNodeConnection(clientNative);
    const server = new NodePhysicalConnection(serverNative);
    const pipe = createIrohClientPipe(new NodePhysicalConnection(clientNative));
    let firstAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      firstAdmitted = resolve;
    });
    const serverTask = (async () => {
      const control = await server.acceptBi();
      await readIrohStreamPreamble(control.recv);
      await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES);
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_HELLO,
          protocolVersion: IROH_WIRE_VERSION,
          contractVersion: RPC_CONTRACT_VERSION,
        }),
        MAX_CONTROL_FRAME_BYTES
      );
      const first = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      if (first.t !== IROH_SESSION_OPEN) throw new Error("Expected first session authentication");
      firstAdmitted();
      const closed = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      expect(closed).toMatchObject({ t: IROH_SESSION_CLOSE, sid: first.sid });
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_OPEN_RESULT,
          sid: first.sid,
          success: true,
          callerId: "retired",
        }),
        MAX_CONTROL_FRAME_BYTES
      );
      const sibling = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      if (sibling.t !== IROH_SESSION_OPEN) throw new Error("Expected sibling authentication");
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_OPEN_RESULT,
          sid: sibling.sid,
          success: true,
          callerId: "sibling",
        }),
        MAX_CONTROL_FRAME_BYTES
      );
    })();
    void serverTask.catch(() => {});
    const first = pipe.openSession({ getToken: () => "credential" });
    const opening = first.ready!().catch((error: unknown) => error);
    try {
      await admitted;
      await first.close();
      expect(await opening).toMatchObject({ code: "CONNECTION_LOST" });
      const sibling = pipe.openSession({ getToken: () => "credential" });
      await sibling.ready!();
      expect(sibling.callerId()).toBe("sibling");
      expect(pipe.status()).toBe("connected");
      await serverTask;
    } finally {
      await pipe.close();
      await serverTask.catch(() => {});
      await opening;
    }
  });

  it("authenticates one session and completes a unary request on its own QUIC stream", async () => {
    const serverEndpoint = await bind();
    const clientEndpoint = await bind();
    const incomingPromise = serverEndpoint.acceptNext();
    const clientConnectionPromise = clientEndpoint.connect(serverEndpoint.addr(), [
      ...VIBESTUDIO_IROH_ALPN,
    ]);
    const incoming = await incomingPromise;
    if (!incoming) throw new Error("server endpoint closed before connection");
    const accepting = await incoming.accept();
    const [serverNative, clientNative] = await Promise.all([
      accepting.connect(),
      clientConnectionPromise,
    ]);
    configureNodeConnection(serverNative);
    configureNodeConnection(clientNative);

    const server = new NodePhysicalConnection(serverNative);
    const client = new NodePhysicalConnection(clientNative);
    const connectionId = `default-cdp-${"nested-panel/".repeat(32)}`;
    const serverMessagePayload = `independent:${"x".repeat(9 * 1024 * 1024)}`;
    const serverTask = (async () => {
      const control = await server.acceptBi();
      expect(await readIrohStreamPreamble(control.recv)).toEqual({
        k: "control",
        v: IROH_WIRE_VERSION,
      });
      const hello = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      expect(hello).toEqual({
        t: IROH_SESSION_HELLO,
        protocolVersion: IROH_WIRE_VERSION,
        contractVersion: RPC_CONTRACT_VERSION,
      });
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_HELLO,
          protocolVersion: IROH_WIRE_VERSION,
          contractVersion: RPC_CONTRACT_VERSION,
        }),
        MAX_CONTROL_FRAME_BYTES
      );

      const open = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      expect(open).toMatchObject({ t: IROH_SESSION_OPEN, token: "token", connectionId });
      if (open.t !== IROH_SESSION_OPEN) throw new Error("expected session open");
      expect(open.sid).not.toBe(connectionId);
      expect(new TextEncoder().encode(open.sid).byteLength).toBeLessThanOrEqual(128);
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_OPEN_RESULT,
          sid: open.sid,
          success: true,
          callerId: "shell:device",
          callerKind: "shell",
          serverBootId: "boot-one",
        }),
        MAX_CONTROL_FRAME_BYTES
      );

      // A server-opened stream can stall before its bounded preamble is
      // complete. It must not head-of-line block a later independent event
      // stream admitted on the same QUIC connection.
      const stalled = await server.openBi();
      await stalled.send.writeAll(new Uint8Array([0, 0, 0, 16]));
      // A busy cold-start scheduler can legitimately delay the JS writer for
      // longer than the former ten-second admission lease. The stalled stream
      // remains independently flow-controlled; elapsed wall time must not turn
      // it into a reset or affect the later event stream.
      await new Promise((resolve) => setTimeout(resolve, 10_250));
      const eventStream = await server.openBi();
      await writeIrohStreamPreamble(eventStream.send, {
        k: "message",
        sid: open.sid,
        v: IROH_WIRE_VERSION,
      });
      await writeChunked(
        eventStream.send,
        new TextEncoder().encode(
          JSON.stringify({
            from: "main",
            target: "shell:device",
            delivery: { caller: { callerId: "main", callerKind: "shell" } },
            provenance: [],
            message: {
              type: "event",
              fromId: "main",
              event: "ready",
              payload: serverMessagePayload,
            },
          } satisfies RpcEnvelope)
        ),
        MAX_STREAM_CHUNK_BYTES
      );
      await eventStream.send.finish();
      expect(await eventStream.recv.read(1)).toHaveLength(0);

      const clientEventStream = await server.acceptBi();
      expect(await readIrohStreamPreamble(clientEventStream.recv)).toEqual({
        k: "envelope",
        sid: open.sid,
        v: IROH_WIRE_VERSION,
      });
      const clientEvent = JSON.parse(
        new TextDecoder().decode(await readFrame(clientEventStream.recv, MAX_ENVELOPE_FRAME_BYTES))
      ) as RpcEnvelope;
      expect(clientEvent.message).toMatchObject({ type: "event", event: "client-ready" });
      await clientEventStream.send.finish();

      const requestStream = await server.acceptBi();
      expect(await readIrohStreamPreamble(requestStream.recv)).toEqual({
        k: "envelope",
        sid: open.sid,
        v: IROH_WIRE_VERSION,
      });
      const requestEnvelope = JSON.parse(
        new TextDecoder().decode(await readFrame(requestStream.recv, MAX_ENVELOPE_FRAME_BYTES))
      ) as RpcEnvelope;
      const request = requestEnvelope.message as RpcRequest;
      expect(request).toMatchObject({ type: "request", method: "echo", args: ["hello"] });
      // Unary request bytes end with the envelope. The request half must be
      // cleanly closed before the response is produced so completed calls do
      // not retain QUIC stream credit under concurrent polling.
      expect(await requestStream.recv.read(1)).toHaveLength(0);
      const response: RpcEnvelope = {
        from: "main",
        target: request.fromId,
        delivery: { caller: { callerId: "main", callerKind: "shell" } },
        provenance: [],
        message: { type: "response", requestId: request.requestId, result: request.args[0] },
      };
      await writeChunked(
        requestStream.send,
        new TextEncoder().encode(JSON.stringify(response)),
        MAX_STREAM_CHUNK_BYTES
      );
      await requestStream.send.finish();
      await Promise.all([
        stalled.send.reset(0x202n).catch(() => undefined),
        stalled.recv.stop(0x202n).catch(() => undefined),
      ]);
    })();

    const pipe = createIrohClientPipe(client, {
      relayUrl: "https://relay.example/",
      attempts: 2,
      generation: 3,
    });
    expect(pipe.diagnostics()).toMatchObject({
      dialRelayUrl: "https://relay.example/",
      dialAttempts: 2,
      endpointGeneration: 3,
    });
    const diagnostics: Array<NonNullable<ReturnType<typeof pipe.diagnostics>>> = [];
    const unsubscribeDiagnostics = pipe.onDiagnosticsChange((snapshot) => {
      if (snapshot) diagnostics.push(snapshot);
    });
    const session = pipe.openSession({ connectionId, getToken: () => "token" });
    const independentEvent = new Promise<RpcEnvelope>((resolve) => {
      session.onMessage((envelope) => {
        if (envelope.message.type === "event" && envelope.message.event === "ready") {
          resolve(envelope);
        }
      });
    });
    const rpc = createRpcClient({
      selfId: "shell:device",
      callerKind: "shell",
      transport: session,
    });
    await session.send({
      from: "shell:device",
      target: "main",
      delivery: { caller: { callerId: "shell:device", callerKind: "shell" } },
      provenance: [],
      message: {
        type: "event",
        fromId: "shell:device",
        event: "client-ready",
        payload: null,
      },
    });
    await expect(rpc.call("main", "echo", ["hello"])).resolves.toBe("hello");
    await Promise.resolve();
    expect(diagnostics.some((snapshot) => snapshot.logicalSessions === 1)).toBe(true);
    expect(diagnostics.some((snapshot) => snapshot.activeRequests === 1)).toBe(true);
    expect(pipe.diagnostics()).toMatchObject({
      logicalSessions: 1,
      activeRequests: 0,
      transmittedBytes: expect.any(Number),
      receivedBytes: expect.any(Number),
      lostBytes: expect.any(Number),
    });
    const receivedEvent = await independentEvent;
    expect(receivedEvent.message).toMatchObject({ type: "event", event: "ready" });
    expect((receivedEvent.message as { payload: string }).payload).toHaveLength(
      serverMessagePayload.length
    );
    await serverTask;
    const openBi = client.openBi.bind(client);
    vi.spyOn(client, "openBi").mockImplementationOnce(async () => {
      const opened = await openBi();
      const writeAll = opened.send.writeAll.bind(opened.send);
      vi.spyOn(opened.send, "writeAll").mockImplementationOnce(async (bytes) => {
        // Teardown between acquiring the native stream and its first write
        // must find the request owner and cancel both native halves.
        expect(pipe.diagnostics()?.activeRequests).toBe(1);
        await session.close();
        await writeAll(bytes);
      });
      return opened;
    });
    await expect(rpc.call("main", "closed-before-first-write", [])).rejects.toThrow("closed");
    const canceledRequest = await server.acceptBi();
    await expect(readIrohStreamPreamble(canceledRequest.recv)).rejects.toThrow();
    expect(await canceledRequest.send.stopped()).toBe(0x201);
    await expect.poll(() => pipe.diagnostics()?.activeRequests).toBe(0);
    expect(pipe.status()).toBe("connected");
    unsubscribeDiagnostics();
    await pipe.close();
  });

  async function verifyStreamingOwnership(closeOwner: "session" | "pipe") {
    const progress = { server: "endpoint binding", client: "endpoint binding" };
    onTestFailed(() => {
      console.error("Streaming ownership failure", closeOwner, progress);
    });
    const serverEndpoint = await bind();
    const clientEndpoint = await bind();
    progress.server = "native connection admission";
    progress.client = "native connection establishment";
    const incomingPromise = serverEndpoint.acceptNext();
    const clientConnectionPromise = clientEndpoint.connect(serverEndpoint.addr(), [
      ...VIBESTUDIO_IROH_ALPN,
    ]);
    const incoming = await incomingPromise;
    if (!incoming) throw new Error("server endpoint closed before connection");
    const accepting = await incoming.accept();
    const [serverNative, clientNative] = await Promise.all([
      accepting.connect(),
      clientConnectionPromise,
    ]);
    progress.server = "session handshake";
    progress.client = "session handshake";
    configureNodeConnection(serverNative);
    configureNodeConnection(clientNative);

    const server = new NodePhysicalConnection(serverNative);
    const client = new NodePhysicalConnection(clientNative);
    let headRequested!: () => void;
    let releaseHead!: () => void;
    const waitingForHead = new Promise<void>((resolve) => {
      headRequested = resolve;
    });
    const headAdmission = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    // Every manually held completion belongs to this test's scope, including
    // failure cleanup. Otherwise the first assertion failure can strand a
    // sibling task and hide itself behind the runner's deadline.
    const releaseGates: (() => void)[] = [headRequested, releaseHead];
    const deadlineAdmissions = [false, true].map(() => {
      let admit!: () => void;
      const ready = new Promise<void>((resolve) => {
        admit = resolve;
      });
      releaseGates.push(admit);
      let releaseWrite!: () => void;
      const writeCompletion = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      releaseGates.push(releaseWrite);
      return { ready, admit, writeCompletion, releaseWrite };
    });
    const serverTask = (async () => {
      const control = await server.acceptBi();
      expect((await readIrohStreamPreamble(control.recv)).k).toBe("control");
      expect(
        decodeIrohSessionControlFrame(await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)).t
      ).toBe(IROH_SESSION_HELLO);
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_HELLO,
          protocolVersion: IROH_WIRE_VERSION,
          contractVersion: RPC_CONTRACT_VERSION,
        }),
        MAX_CONTROL_FRAME_BYTES
      );
      const open = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      if (open.t !== IROH_SESSION_OPEN) throw new Error("expected session open");
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_OPEN_RESULT,
          sid: open.sid,
          success: true,
          callerId: "shell:device",
          callerKind: "shell",
          serverBootId: "boot-one",
        }),
        MAX_CONTROL_FRAME_BYTES
      );

      progress.server = "upload-and-download admission";
      const requestStream = await server.acceptBi();
      expect(await readIrohStreamPreamble(requestStream.recv)).toMatchObject({
        body: true,
        k: "stream",
        sid: open.sid,
      });
      const requestEnvelope = JSON.parse(
        new TextDecoder().decode(await readFrame(requestStream.recv, MAX_ENVELOPE_FRAME_BYTES))
      ) as RpcEnvelope;
      expect(requestEnvelope.message).toMatchObject({
        type: "stream-request",
        method: "upload-and-download",
      });
      const upload: number[] = [];
      while (true) {
        const chunk = await requestStream.recv.read(64 * 1024);
        if (chunk.length === 0) break;
        upload.push(...chunk);
      }
      expect(new TextDecoder().decode(Uint8Array.from(upload))).toBe("request-body");
      headRequested();
      await headAdmission;

      const responseBody = new TextEncoder().encode("response-body");
      await writeFrame(
        requestStream.send,
        encodeIrohStreamResponseHead({
          status: 201,
          statusText: "Created",
          headerPairs: [["content-type", "text/plain"]],
          finalUrl: "https://example.test/result",
        }),
        MAX_ENVELOPE_FRAME_BYTES
      );
      await requestStream.send.writeAll(responseBody);
      await requestStream.send.finish();

      progress.server = "failed upload cancellation receipt";
      const failedUpload = await server.acceptBi();
      // An immediate upload failure may reset before buffered envelope bytes
      // reach the peer. Its authoritative outcome is both halves' cancellation.
      expect(await failedUpload.send.stopped()).toBe(0x202);
      expect(await failedUpload.recv.receivedReset()).toBe(0x202);

      progress.server = "bodyless download admission";
      const bodyless = await server.acceptBi();
      expect(await readIrohStreamPreamble(bodyless.recv)).toMatchObject({
        body: false,
        k: "stream",
        sid: open.sid,
      });
      const bodylessEnvelope = JSON.parse(
        new TextDecoder().decode(await readFrame(bodyless.recv, MAX_ENVELOPE_FRAME_BYTES))
      ) as RpcEnvelope;
      expect(bodylessEnvelope.message).toMatchObject({
        type: "stream-request",
        method: "download-only",
      });
      // The upload half is complete before response consumption. A caller that
      // trusts Content-Length is not required to pull one extra EOF chunk just
      // to release native QUIC stream credit.
      expect(await bodyless.recv.read(1)).toHaveLength(0);
      await writeFrame(
        bodyless.send,
        encodeIrohStreamResponseHead({
          status: 200,
          statusText: "OK",
          headerPairs: [["content-length", "5"]],
          finalUrl: "https://example.test/download",
        }),
        MAX_ENVELOPE_FRAME_BYTES
      );
      await bodyless.send.writeAll(new TextEncoder().encode("hello"));
      await bodyless.send.finish();

      for (const body of [false, true]) {
        progress.server = "deadline stream admission";
        const timedOut = await server.acceptBi();
        expect(await readIrohStreamPreamble(timedOut.recv)).toMatchObject({
          k: "stream",
          body,
          sid: open.sid,
        });
        await readFrame(timedOut.recv, MAX_ENVELOPE_FRAME_BYTES);
        deadlineAdmissions[body ? 1 : 0]!.admit();
        // Deliberately send no response head. The caller's timeout must stop
        // this request-owned stream without closing its sibling sessions.
        expect(await timedOut.send.stopped()).toBe(0x202);
        if (body) expect(await timedOut.recv.receivedReset()).toBe(0x202);
      }
      // The stream reset during open is visible to the peer even though no
      // application preamble was sent. It must carry only cancellation.
      progress.server = "aborted native open receipt";
      const abortedOpen = await server.acceptBi();
      await expect(readIrohStreamPreamble(abortedOpen.recv)).rejects.toThrow();
      for (const [finishResponse, cancellationCode] of [
        [true, 0x202],
        [false, 0x202],
        [false, 0x201],
      ] as const) {
        progress.server = "duplex upload admission";
        const duplex = await server.acceptBi();
        expect(await readIrohStreamPreamble(duplex.recv)).toMatchObject({
          body: true,
          k: "stream",
        });
        await readFrame(duplex.recv, MAX_ENVELOPE_FRAME_BYTES);
        await writeFrame(
          duplex.send,
          encodeIrohStreamResponseHead({
            status: 200,
            statusText: "OK",
            headerPairs: [],
            finalUrl: "",
          }),
          MAX_ENVELOPE_FRAME_BYTES
        );
        if (finishResponse) await duplex.send.finish();
        else await duplex.send.writeAll(new Uint8Array([1]));
        progress.server = "duplex cancellation receipt";
        if (closeOwner === "pipe" && cancellationCode === 0x201) {
          // Physical retirement owns the whole connection, so its terminal
          // event is the authoritative peer receipt rather than a stream code.
          await server.closed();
        } else expect(await duplex.recv.receivedReset()).toBe(cancellationCode);
      }
    })();

    const pipe = createIrohClientPipe(client);
    const session = pipe.openSession({ getToken: () => "token" });
    const rpc = createRpcClient({
      selfId: "shell:device",
      callerKind: "shell",
      transport: session,
    });
    const clientTask = (async () => {
      await session.ready?.();
      const uploadBytes = new TextEncoder().encode("request-body");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let responseSettled = false;
      const pendingResponse = rpc
        .stream("main", "upload-and-download", [], {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(uploadBytes.subarray(0, 4));
              controller.enqueue(uploadBytes.subarray(4));
              controller.close();
            },
          }),
        })
        .finally(() => {
          responseSettled = true;
        });
      void pendingResponse.catch(() => {});
      try {
        progress.client = "initial response head admission";
        await waitingForHead;
        vi.advanceTimersByTime(30_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(responseSettled).toBe(false);
        expect(pipe.diagnostics()?.activeRequests).toBe(1);
      } finally {
        vi.useRealTimers();
        releaseHead();
      }
      progress.client = "initial response consumption";
      const response = await pendingResponse;
      expect(response.status).toBe(201);
      expect(response.url).toBe("https://example.test/result");
      expect(await response.text()).toBe("response-body");
      const uploadFailure = new Error("Original upload provider failure");
      await expect(
        rpc.stream("main", "failed-upload", [], {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(uploadFailure);
            },
          }),
        })
      ).rejects.toBe(uploadFailure);
      expect(pipe.diagnostics()?.activeRequests).toBe(0);
      progress.client = "bodyless download";
      const download = await rpc.stream("main", "download-only", []);
      const reader = download.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("hello");
      reader.releaseLock();
      const nativeOpenBi = client.openBi.bind(client);
      const holdRequestWriteCompletion = (admission: (typeof deadlineAdmissions)[number]) => {
        vi.spyOn(client, "openBi").mockImplementationOnce(async () => {
          const stream = await nativeOpenBi();
          const writeAll = stream.send.writeAll.bind(stream.send);
          vi.spyOn(stream.send, "writeAll").mockImplementation(async (bytes) => {
            await writeAll(bytes);
            if (new TextDecoder().decode(bytes).includes('"method":'))
              await admission.writeCompletion;
          });
          return stream;
        });
      };
      const observeResponseDeadline = () => {
        let installed!: () => void;
        const ready = new Promise<void>((resolve) => {
          installed = resolve;
        });
        const schedule = globalThis.setTimeout;
        const observer = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((handler, delay, ...args) => {
            const timer = schedule(handler, delay, ...args);
            if (delay === 100) installed();
            return timer;
          });
        return { ready, restore: () => observer.mockRestore() };
      };
      holdRequestWriteCompletion(deadlineAdmissions[0]!);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const headDeadline = observeResponseDeadline();
      try {
        const rejected = expect(
          rpc.stream("main", "no-response", [], { headTimeoutMs: 100 })
        ).rejects.toMatchObject({ code: "IROH_RESPONSE_HEAD_TIMEOUT" });
        // The peer can receive an envelope before its native write promise
        // resolves. Hold that completion to exercise the ordering explicitly;
        // only the client's installed timer admits clock advancement.
        progress.client = "bodyless deadline peer admission";
        await deadlineAdmissions[0]!.ready;
        expect(vi.getTimerCount()).toBe(0);
        deadlineAdmissions[0]!.releaseWrite();
        progress.client = "bodyless deadline timer installation";
        await headDeadline.ready;
        vi.advanceTimersByTime(100);
        progress.client = "bodyless deadline cancellation joining";
        await rejected;
      } finally {
        headDeadline.restore();
        vi.useRealTimers();
      }
      let releaseUploadCancellation!: () => void;
      const cancellationReceipt = new Promise<void>((resolve) => {
        releaseUploadCancellation = resolve;
      });
      releaseGates.push(releaseUploadCancellation);
      const cancelUpload = vi.fn(() => cancellationReceipt);
      const pendingUpload = new ReadableStream<Uint8Array>({ cancel: cancelUpload });
      let deadlineSettled = false;
      holdRequestWriteCompletion(deadlineAdmissions[1]!);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const uploadDeadline = observeResponseDeadline();
      const deadline = rpc
        .stream("main", "no-response-upload", [], {
          headTimeoutMs: 100,
          body: pendingUpload,
        })
        .finally(() => {
          deadlineSettled = true;
        });
      const rejectedDeadline = expect(deadline).rejects.toMatchObject({
        code: "IROH_RESPONSE_HEAD_TIMEOUT",
      });
      try {
        progress.client = "upload deadline peer admission";
        await deadlineAdmissions[1]!.ready;
        expect(vi.getTimerCount()).toBe(0);
        deadlineAdmissions[1]!.releaseWrite();
        progress.client = "upload deadline timer installation";
        await uploadDeadline.ready;
        vi.advanceTimersByTime(100);
      } finally {
        uploadDeadline.restore();
        vi.useRealTimers();
      }
      await expect.poll(() => cancelUpload.mock.calls.length).toBe(1);
      expect(deadlineSettled).toBe(false);
      expect(pipe.diagnostics()?.activeRequests).toBe(1);
      releaseUploadCancellation();
      progress.client = "upload deadline cancellation joining";
      await rejectedDeadline;
      await expect.poll(() => pendingUpload.locked).toBe(false);
      await expect.poll(() => pipe.diagnostics()?.activeRequests).toBe(0);
      expect(session.isClosed()).toBe(false);
      const abort = new AbortController();
      const abortReason = new Error("Request canceled during native stream opening");
      const openBi = client.openBi.bind(client);
      vi.spyOn(client, "openBi").mockImplementationOnce(async () => {
        const opened = await openBi();
        abort.abort(abortReason);
        return opened;
      });
      await expect(
        rpc.stream("main", "aborted-during-open", [], { signal: abort.signal })
      ).rejects.toBe(abortReason);
      expect(pipe.diagnostics()?.activeRequests).toBe(0);
      expect(session.isClosed()).toBe(false);

      const afterEofAbort = new AbortController();
      const eofCancelUpload = vi.fn();
      const eofUpload = new ReadableStream<Uint8Array>({ cancel: eofCancelUpload });
      progress.client = "early response with pending upload";
      const earlyResponse = await rpc.stream("main", "response-before-upload", [], {
        body: eofUpload,
        signal: afterEofAbort.signal,
      });
      expect(await earlyResponse.text()).toBe("");
      expect(pipe.diagnostics()?.activeRequests).toBe(1);
      expect(eofCancelUpload).not.toHaveBeenCalled();
      afterEofAbort.abort();
      await expect.poll(() => eofCancelUpload.mock.calls.length).toBe(1);
      await expect.poll(() => eofUpload.locked).toBe(false);

      let uploadController!: ReadableStreamDefaultController<Uint8Array>;
      progress.client = "duplex response before upload failure";
      const failedResponse = await rpc.stream("main", "upload-fails-after-head", [], {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            uploadController = controller;
          },
        }),
      });
      const failedReader = failedResponse.body!.getReader();
      expect((await failedReader.read()).value).toEqual(new Uint8Array([1]));
      const bodyFailure = new Error("Original duplex upload failure");
      const failedRead = expect(failedReader.read()).rejects.toBe(bodyFailure);
      uploadController.error(bodyFailure);
      progress.client = "duplex response failure propagation";
      await failedRead;
      failedReader.releaseLock();
      expect(pipe.diagnostics()?.activeRequests).toBe(0);
      expect(session.isClosed()).toBe(false);

      let finishSessionCancellation!: () => void;
      let sessionCancellationStarted!: () => void;
      const sessionCancellationReady = new Promise<void>((resolve) => {
        sessionCancellationStarted = resolve;
      });
      const sessionCancellation = new Promise<void>((resolve) => {
        finishSessionCancellation = resolve;
      });
      releaseGates.push(sessionCancellationStarted, finishSessionCancellation);
      const sessionCancelUpload = vi.fn(() => {
        sessionCancellationStarted();
        return sessionCancellation;
      });
      const sessionUpload = new ReadableStream<Uint8Array>({ cancel: sessionCancelUpload });
      progress.client = "session pending upload admission";
      await rpc.stream("main", "close-with-pending-upload", [], { body: sessionUpload });
      expect(pipe.diagnostics()?.activeRequests).toBe(1);
      let sessionCloseSettled = false;
      vi.spyOn(client, "openBi").mockImplementationOnce(async () => {
        const opened = await openBi();
        await (closeOwner === "session" ? session.close() : pipe.close());
        sessionCloseSettled = true;
        return opened;
      });
      const openingCancelUpload = vi.fn();
      const openingRejected = expect(
        rpc.stream("main", "closed-during-open", [], {
          body: new ReadableStream<Uint8Array>({ cancel: openingCancelUpload }),
        })
      ).rejects.toThrow("closed while opening request");
      try {
        progress.client = "session upload cancellation hook";
        await sessionCancellationReady;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sessionCloseSettled).toBe(false);
        expect(pipe.diagnostics()?.activeRequests).toBe(1);
      } finally {
        finishSessionCancellation();
        progress.client = "closed native open joining";
        await openingRejected;
      }
      await expect.poll(() => sessionCancelUpload.mock.calls.length).toBe(1);
      await expect.poll(() => sessionUpload.locked).toBe(false);
      expect(openingCancelUpload).toHaveBeenCalledOnce();
      expect(pipe.diagnostics()?.activeRequests).toBe(0);
    })();
    try {
      await Promise.all([serverTask, clientTask]);
    } finally {
      for (const release of releaseGates) release();
      await pipe.close();
      await Promise.allSettled([serverTask, clientTask]);
    }
  }

  it.each(["session", "pipe"] as const)(
    "owns slow streaming heads and explicit caller deadlines through %s close",
    verifyStreamingOwnership
  );
});
