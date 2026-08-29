import type {
  Connection,
  Endpoint,
  RecvStream,
  SecretKey as SecretKeyType,
  SendStream,
} from "@number0/iroh";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeLengthPrefix,
  FrameLimitError,
  readFrame,
  writeFrame,
  type FrameReceiveStream,
  type FrameSendStream,
} from "./framing.js";
import { loadIrohNodeBinding, resolveIrohNodeBinding } from "./nodeBinding.js";
import {
  bindNodeEndpoint,
  configureNodeConnection,
  IROH_CONCURRENT_BI_STREAM_WINDOW,
  VIBESTUDIO_IROH_ALPN,
  VIBESTUDIO_IROH_ALPN_TEXT,
} from "./nodeEndpoint.js";
import { NodePhysicalConnection } from "./nodePhysical.js";

const MAX_FIXTURE_FRAME_BYTES = 64 * 1024;
const OVERSIZED_FRAME_CODE = 0x10n;
const CANCEL_SEND_CODE = 0x20n;
const CANCEL_RECEIVE_CODE = 0x21n;
const { Connecting, SecretKey } = loadIrohNodeBinding();

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function typedSend(stream: SendStream): FrameSendStream {
  return { writeAll: (bytes) => stream.writeAll(Array.from(bytes)) };
}

function typedReceive(stream: RecvStream): FrameReceiveStream {
  return { readExact: async (length) => Uint8Array.from(await stream.readExact(length)) };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectPair(
  server: Endpoint,
  client: Endpoint
): Promise<{ serverConnection: Connection; clientConnection: Connection }> {
  const incomingPromise = bounded(server.acceptNext(), "accept incoming");
  const clientConnectionPromise = bounded(
    client.connect(server.addr(), [...VIBESTUDIO_IROH_ALPN]),
    "client connect"
  );
  const incoming = await incomingPromise;
  if (!incoming) throw new Error("Iroh endpoint closed before accepting a connection");
  const accepting = await incoming.accept();
  const [serverConnection, clientConnection] = await Promise.all([
    bounded(accepting.connect(), "server handshake"),
    clientConnectionPromise,
  ]);
  configureNodeConnection(serverConnection);
  configureNodeConnection(clientConnection);
  return { serverConnection, clientConnection };
}

describe("Iroh Node transport fixture", () => {
  const endpoints = new Set<Endpoint>();
  const connections = new Set<Connection>();

  async function bind(secretKey: SecretKeyType = SecretKey.generate()): Promise<Endpoint> {
    const endpoint = await bindNodeEndpoint({ secretKey });
    endpoints.add(endpoint);
    return endpoint;
  }

  afterEach(async () => {
    for (const connection of connections) {
      connection.close(0n, [...utf8("fixture cleanup")]);
    }
    connections.clear();
    await Promise.all([...endpoints].map((endpoint) => endpoint.close().catch(() => undefined)));
    endpoints.clear();
  });

  it("advertises a finite, replenishing QUIC stream flow-control window", () => {
    expect(IROH_CONCURRENT_BI_STREAM_WINDOW).toBe(32_768n);
    expect(IROH_CONCURRENT_BI_STREAM_WINDOW).toBeGreaterThan(320n);
    expect(IROH_CONCURRENT_BI_STREAM_WINDOW).toBeLessThan(1n << 60n);
  });

  it("binds fixed identities with explicit minimal config and completes a verified handshake", async () => {
    const serverSecret = SecretKey.generate();
    const clientSecret = SecretKey.generate();
    const server = await bind(serverSecret);
    const client = await bind(clientSecret);
    const { serverConnection, clientConnection } = await connectPair(server, client);
    connections.add(serverConnection);
    connections.add(clientConnection);

    expect(server.id().equals(serverSecret.public())).toBe(true);
    expect(client.id().equals(clientSecret.public())).toBe(true);
    expect(serverConnection.remoteId().equals(client.id())).toBe(true);
    expect(clientConnection.remoteId().equals(server.id())).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(serverConnection.alpn()))).toBe(
      VIBESTUDIO_IROH_ALPN_TEXT
    );
    expect(serverConnection.paths().length).toBeGreaterThan(0);
    const physical = new NodePhysicalConnection(clientConnection);
    const observedDiagnostics: ReturnType<NodePhysicalConnection["diagnostics"]>[] = [];
    const unsubscribe = physical.onDiagnosticsChange((diagnostics) =>
      observedDiagnostics.push(diagnostics)
    );
    expect(observedDiagnostics[0]).toMatchObject({
      transmittedBytes: expect.any(Number),
      receivedBytes: expect.any(Number),
      lostBytes: expect.any(Number),
      paths: expect.any(Array),
    });
    unsubscribe();
  });

  it("carries one bounded request and response on one QUIC stream", async () => {
    const server = await bind();
    const client = await bind();
    const { serverConnection, clientConnection } = await connectPair(server, client);
    connections.add(serverConnection);
    connections.add(clientConnection);

    const serverTask = (async () => {
      const stream = await serverConnection.acceptBi();
      expect(text(await readFrame(typedReceive(stream.recv), MAX_FIXTURE_FRAME_BYTES))).toBe(
        "request"
      );
      await writeFrame(typedSend(stream.send), utf8("response"), MAX_FIXTURE_FRAME_BYTES);
      await stream.send.finish();
    })();
    const stream = await clientConnection.openBi();
    await writeFrame(typedSend(stream.send), utf8("request"), MAX_FIXTURE_FRAME_BYTES);
    await stream.send.finish();
    expect(text(await readFrame(typedReceive(stream.recv), MAX_FIXTURE_FRAME_BYTES))).toBe(
      "response"
    );
    await bounded(serverTask, "request round trip");
  });

  it("rejects an oversized declaration before reading or allocating its body", async () => {
    const server = await bind();
    const client = await bind();
    const { serverConnection, clientConnection } = await connectPair(server, client);
    connections.add(serverConnection);
    connections.add(clientConnection);

    const serverTask = (async () => {
      const stream = await serverConnection.acceptBi();
      await expect(readFrame(typedReceive(stream.recv), MAX_FIXTURE_FRAME_BYTES)).rejects.toEqual(
        new FrameLimitError(MAX_FIXTURE_FRAME_BYTES + 1, MAX_FIXTURE_FRAME_BYTES)
      );
      await stream.recv.stop(OVERSIZED_FRAME_CODE);
    })();
    const stream = await clientConnection.openBi();
    await stream.send.writeAll(Array.from(encodeLengthPrefix(MAX_FIXTURE_FRAME_BYTES + 1)));
    expect(await bounded(stream.send.stopped(), "oversized stop signal")).toBe(
      Number(OVERSIZED_FRAME_CODE)
    );
    await bounded(serverTask, "oversized frame rejection");
  });

  it("keeps an unrelated stream live while another stream is stalled and cancelled", async () => {
    const server = await bind();
    const client = await bind();
    const { serverConnection, clientConnection } = await connectPair(server, client);
    connections.add(serverConnection);
    connections.add(clientConnection);

    const stalledServerPromise = serverConnection.acceptBi();
    const stalledClient = await clientConnection.openBi();
    // QUIC opens streams lazily on the first byte, so materialize this stream
    // without finishing it before waiting for the peer's accept.
    await stalledClient.send.writeAll([0]);
    const stalledServer = await bounded(stalledServerPromise, "stalled stream accept");

    const fastServerTask = (async () => {
      const fastServer = await serverConnection.acceptBi();
      expect(text(await readFrame(typedReceive(fastServer.recv), MAX_FIXTURE_FRAME_BYTES))).toBe(
        "fast"
      );
      await writeFrame(typedSend(fastServer.send), utf8("fast-response"), MAX_FIXTURE_FRAME_BYTES);
      await fastServer.send.finish();
    })();
    const fastClient = await clientConnection.openBi();
    await writeFrame(typedSend(fastClient.send), utf8("fast"), MAX_FIXTURE_FRAME_BYTES);
    await fastClient.send.finish();
    expect(
      text(
        await bounded(
          readFrame(typedReceive(fastClient.recv), MAX_FIXTURE_FRAME_BYTES),
          "fast response"
        )
      )
    ).toBe("fast-response");

    const cancellation = await bounded(
      Promise.all([
        stalledServer.recv.receivedReset(),
        stalledServer.send.stopped(),
        stalledClient.send.reset(CANCEL_SEND_CODE),
        stalledClient.recv.stop(CANCEL_RECEIVE_CODE),
      ]),
      "bidirectional stream cancellation"
    );
    expect(cancellation[0]).toBe(Number(CANCEL_SEND_CODE));
    expect(cancellation[1]).toBe(Number(CANCEL_RECEIVE_CODE));
    await bounded(fastServerTask, "fast stream completion");
  });

  it("exposes neither 0-RTT nor deterministic connection-attempt cancellation", () => {
    expect(Object.getOwnPropertyNames(Connecting.prototype).sort()).toEqual([
      "alpn",
      "connect",
      "constructor",
      "remoteId",
    ]);
  });

  it("resolves the native package through the host native-external loader", () => {
    expect(resolveIrohNodeBinding()).toMatch(/@number0\/iroh\/index\.js$/);
  });

  it("rejects an ALPN mismatch during the handshake", async () => {
    const server = await bind();
    const client = await bind();
    const incomingPromise = bounded(server.acceptNext(), "mismatch incoming");
    const wrongAlpn = [...utf8("vibestudio-rpc/wrong")];
    const clientAttempt = bounded(client.connect(server.addr(), wrongAlpn), "mismatch client").then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
    const incoming = await incomingPromise;
    if (!incoming) throw new Error("Iroh endpoint closed before accepting mismatch");
    const serverAttempt = bounded(
      incoming.accept().then((accepting) => accepting.connect()),
      "mismatch server"
    ).then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
    const [clientResult, serverResult] = await Promise.all([clientAttempt, serverAttempt]);
    expect(clientResult).toBe("rejected");
    expect(serverResult).toBe("rejected");
  });

  it("deterministically cancels an in-flight dial when its endpoint generation closes", async () => {
    const server = await bind();
    const staleAddress = server.addr();
    await server.close();
    endpoints.delete(server);

    const clientSecret = SecretKey.generate();
    const client = await bind(clientSecret);
    const attempt = client.connect(staleAddress, [...VIBESTUDIO_IROH_ALPN]);
    const observed = attempt.then(
      () => "connected" as const,
      () => "cancelled" as const
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    await client.close();
    endpoints.delete(client);

    expect(await bounded(observed, "endpoint-generation dial cancellation", 1_000)).toBe(
      "cancelled"
    );

    const rebound = await bind(clientSecret);
    expect(rebound.id().equals(clientSecret.public())).toBe(true);
  });

  it("rebinds one shared client identity and restores concurrent hub and workspace peers", async () => {
    const hub = await bind();
    const workspace = await bind();
    const clientSecret = SecretKey.generate();
    const client = await bind(clientSecret);
    const firstHub = await connectPair(hub, client);
    const firstWorkspace = await connectPair(workspace, client);
    for (const connection of [
      firstHub.serverConnection,
      firstHub.clientConnection,
      firstWorkspace.serverConnection,
      firstWorkspace.clientConnection,
    ]) {
      connections.add(connection);
    }

    const hubClosed = firstHub.serverConnection.closed();
    const workspaceClosed = firstWorkspace.serverConnection.closed();
    await client.close();
    endpoints.delete(client);
    await Promise.all([
      bounded(hubClosed, "hub generation close"),
      bounded(workspaceClosed, "workspace generation close"),
    ]);

    const rebound = await bind(clientSecret);
    expect(rebound.id().equals(clientSecret.public())).toBe(true);
    const secondHub = await connectPair(hub, rebound);
    const secondWorkspace = await connectPair(workspace, rebound);
    for (const connection of [
      secondHub.serverConnection,
      secondHub.clientConnection,
      secondWorkspace.serverConnection,
      secondWorkspace.clientConnection,
    ]) {
      connections.add(connection);
    }
    expect(secondHub.serverConnection.remoteId().equals(clientSecret.public())).toBe(true);
    expect(secondWorkspace.serverConnection.remoteId().equals(clientSecret.public())).toBe(true);
  });
});
