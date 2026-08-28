import {
  IROH_WIRE_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_ENVELOPE_FRAME_BYTES,
  readFrame,
  readIrohStreamPreamble,
  writeFrame,
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
      expect(open).toMatchObject({ t: IROH_SESSION_OPEN, sid: "shell", token: "token" });
      await writeFrame(
        control.send,
        encodeIrohSessionControlFrame({
          t: IROH_SESSION_OPEN_RESULT,
          sid: "shell",
          success: true,
          callerId: "shell:device",
          callerKind: "shell",
          serverBootId: "boot-one",
        }),
        MAX_CONTROL_FRAME_BYTES
      );

      const requestStream = await server.acceptBi();
      expect(await readIrohStreamPreamble(requestStream.recv)).toEqual({
        k: "envelope",
        sid: "shell",
        v: IROH_WIRE_VERSION,
      });
      const requestEnvelope = JSON.parse(
        new TextDecoder().decode(await readFrame(requestStream.recv, MAX_ENVELOPE_FRAME_BYTES))
      ) as RpcEnvelope;
      const request = requestEnvelope.message as RpcRequest;
      expect(request).toMatchObject({ type: "request", method: "echo", args: ["hello"] });
      const response: RpcEnvelope = {
        from: "main",
        target: request.fromId,
        delivery: { caller: { callerId: "main", callerKind: "shell" } },
        provenance: [],
        message: { type: "response", requestId: request.requestId, result: request.args[0] },
      };
      await writeFrame(
        requestStream.send,
        new TextEncoder().encode(JSON.stringify(response)),
        MAX_ENVELOPE_FRAME_BYTES
      );
      await requestStream.send.finish();
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
    const session = pipe.openSession({ sid: "shell", getToken: () => "token" });
    const rpc = createRpcClient({
      selfId: "shell:device",
      callerKind: "shell",
      transport: session,
    });
    await expect(rpc.call("main", "echo", ["hello"])).resolves.toBe("hello");
    await serverTask;
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
        sid: "shell",
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
      await requestStream.send.writeAll([...responseBody]);
      await requestStream.send.finish();
    })();

    const pipe = createIrohClientPipe(client);
    const session = pipe.openSession({ sid: "shell", getToken: () => "token" });
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
    await serverTask;
    await pipe.close();
  });
});
