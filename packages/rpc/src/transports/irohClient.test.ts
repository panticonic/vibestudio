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
import { afterEach, describe, expect, it } from "vitest";
import { createRpcClient } from "../client.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import { encodeIrohStreamResponseHead } from "../protocol/irohStreamResponse.js";
import {
  decodeIrohSessionControlFrame,
  encodeIrohSessionControlFrame,
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
} from "../protocol/irohSession.js";
import type { RpcEnvelope, RpcRequest } from "../types.js";
import { createIrohClientPipe } from "./irohClient.js";

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
    unsubscribeDiagnostics();
    await pipe.close();
  });

  it("carries a streaming upload, bounded response head, and raw body on one QUIC stream", async () => {
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
    })();

    const pipe = createIrohClientPipe(client);
    const session = pipe.openSession({ getToken: () => "token" });
    const rpc = createRpcClient({
      selfId: "shell:device",
      callerKind: "shell",
      transport: session,
    });
    const uploadBytes = new TextEncoder().encode("request-body");
    const response = await rpc.stream("main", "upload-and-download", [], {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(uploadBytes.subarray(0, 4));
          controller.enqueue(uploadBytes.subarray(4));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(response.url).toBe("https://example.test/result");
    expect(await response.text()).toBe("response-body");
    const download = await rpc.stream("main", "download-only", []);
    const reader = download.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("hello");
    reader.releaseLock();
    await serverTask;
    await pipe.close();
  });
});
