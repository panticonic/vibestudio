import { createRpcClient } from "@vibestudio/rpc";
import {
  IROH_WIRE_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  writeFrame,
  writeIrohStreamPreamble,
} from "@vibestudio/iroh-transport";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import {
  encodeIrohSessionControlFrame,
  IROH_SESSION_DELEGATE,
  IROH_SESSION_HELLO,
} from "@vibestudio/rpc/protocol/irohSession";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  bindNodeEndpoint,
  configureNodeConnection,
  loadIrohNodeBinding,
  NodePhysicalConnection,
  signEndpointDelegation,
  VIBESTUDIO_IROH_ALPN,
} from "@vibestudio/iroh-transport/node";

import { createIrohClientPipe } from "@vibestudio/rpc/transports/irohClient";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { RpcServer } from "./rpcServer.js";
import { z } from "zod";

const { SecretKey } = loadIrohNodeBinding();
const irohServerTestMethods = createRpcMethods(
  "test",
  defineServiceMethods({
    echo: {
      website: { kind: "closed", reason: "Iroh server transport test receiver." },
      args: z.tuple([z.string()]),
      returns: z.unknown(),
    },
    large: {
      website: { kind: "closed", reason: "Iroh server transport test receiver." },
      args: z.tuple([]),
      returns: z.unknown(),
    },
  })
);

describe("RpcServer Iroh ingress over real local QUIC", () => {
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

  it("authenticates and dispatches a unary RPC through the production server adapter", async () => {
    const tokenManager = new TokenManager();
    const token = "refresh:dev_test:" + "r".repeat(43);
    const redeemPairingCredential = vi.fn(
      async (_token: string, _context: { transport: { kind: string; deviceKey?: string } }) => ({
        callerId: "electron-main",
        callerKind: "shell" as const,
        subject: { userId: "usr_root", handle: "root" },
      })
    );
    const entityCache = new EntityCache();
    const largeResult = `large:${"x".repeat(20 * 1024 * 1024)}`;
    const dispatcher = {
      dispatch: vi.fn(async (_context, _service, method, args: unknown[]) =>
        method === "large" ? largeResult : args[0]
      ),
      assertAuthority: vi.fn().mockResolvedValue(undefined),
      getPolicy: vi.fn(() => ({ allowed: ["shell"] })),
      getMethodPolicy: vi.fn(() => undefined),
    } as unknown as ServiceDispatcher;
    const server = new RpcServer({
      tokenManager,
      dispatcher,
      workspaceId: "test-workspace",
      entityCache,
      connectionGrants: new ConnectionGrantService({ entityCache }),
      runtimeCoordinator: new PanelRuntimeCoordinator(),
      userSubjectSource: {
        resolve: () => ({ userId: "usr_root", handle: "root" }),
      },
      resolveExtensionCodeIdentity: async () => null,
      ensureUserlandDoReady: async () => undefined,
      resolveExactCausalInvocation: async () => ({ initiatingUser: null }),
      redeemPairingCredential,
    });

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

    const clientConnection = new NodePhysicalConnection(clientNative);
    const device = SecretKey.generate();
    const pipe = createIrohClientPipe(
      clientConnection,
      signEndpointDelegation(device, clientEndpoint.id().toString())
    );
    const [attachment] = await Promise.all([
      server.attachIrohConnection(new NodePhysicalConnection(serverNative), () => true),
      pipe.ready(),
    ]);
    attachment.activate();
    const session = pipe.openSession({ getToken: () => token });
    const rpc = createRpcClient({
      selfId: "electron-main",
      callerKind: "shell",
      transport: session,
    });

    // A peer can open a stream and then stall halfway through its bounded
    // preamble. That stream consumes one negotiated stream slot, but it must
    // not block admission and dispatch of an independent later RPC stream.
    const stalled = await clientConnection.openBi();
    await stalled.send.writeAll(new Uint8Array([0, 0, 0, 16]));
    // Admission has byte/frame bounds and QUIC has a finite replenishing stream
    // window. A wall-clock lease added a second, harmful scheduling policy:
    // cold-start JS work could reset an otherwise valid independent stream.
    await new Promise((resolve) => setTimeout(resolve, 10_250));

    const result = rpc.call("main", irohServerTestMethods.echo, ["through-iroh"]);
    await vi.waitFor(() => expect(dispatcher.dispatch).toHaveBeenCalled(), { timeout: 2_000 });
    await expect(result).resolves.toBe("through-iroh");

    // Unary results use the QUIC stream's FIN as their payload boundary. A
    // large result therefore retains QUIC backpressure without inheriting the
    // old 8 MiB metadata-frame ceiling, and it cannot head-of-line block an
    // independent request on another stream.
    const [receivedLarge, concurrentEcho] = await Promise.all([
      rpc.call("main", irohServerTestMethods.large, []),
      rpc.call("main", irohServerTestMethods.echo, ["concurrent"]),
    ]);
    expect(receivedLarge).toHaveLength(largeResult.length);
    expect(typeof receivedLarge).toBe("string");
    if (typeof receivedLarge !== "string")
      throw new Error("Expected the large wire result to be text");
    expect(receivedLarge.startsWith("large:")).toBe(true);
    expect(concurrentEcho).toBe("concurrent");
    expect(redeemPairingCredential).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        transport: {
          kind: "iroh",
          deviceKey: device.public().toString(),
        },
      })
    );
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({ runtime: { id: "electron-main", kind: "shell" } }),
      }),
      "test",
      "echo",
      ["through-iroh"]
    );
    await Promise.all([
      stalled.send.reset(0x202n).catch(() => undefined),
      stalled.recv.stop(0x202n).catch(() => undefined),
    ]);
    await pipe.close();
    await attachment.lifetime;
  });

  it("closes concurrent peer connections through one terminal owner each", async () => {
    const server = new RpcServer({
      tokenManager: new TokenManager(),
      dispatcher: {
        dispatch: vi.fn(),
        assertAuthority: vi.fn().mockResolvedValue(undefined),
        getPolicy: vi.fn(() => ({ allowed: ["shell"] })),
        getMethodPolicy: vi.fn(() => undefined),
      } as unknown as ServiceDispatcher,
      workspaceId: "test-workspace",
      entityCache: new EntityCache(),
      runtimeCoordinator: new PanelRuntimeCoordinator(),
      userSubjectSource: { resolve: () => ({ userId: "usr_root", handle: "root" }) },
      resolveExtensionCodeIdentity: async () => null,
      ensureUserlandDoReady: async () => undefined,
      resolveExactCausalInvocation: async () => ({ initiatingUser: null }),
      redeemPairingCredential: async () => ({
        callerId: "electron-main",
        callerKind: "shell" as const,
        subject: { userId: "usr_root", handle: "root" },
      }),
    });
    const serverEndpoint = await bind();
    const clients: Array<{
      connection: NodePhysicalConnection;
      pipe: ReturnType<typeof createIrohClientPipe>;
      attachment?: Awaited<ReturnType<RpcServer["attachIrohConnection"]>>;
    }> = [];
    try {
      const connect = async () => {
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

        const connection = new NodePhysicalConnection(serverNative);
        const pipe = createIrohClientPipe(
          new NodePhysicalConnection(clientNative),
          signEndpointDelegation(SecretKey.generate(), clientEndpoint.id().toString())
        );
        const client: (typeof clients)[number] = { connection, pipe };
        clients.push(client);
        const [attachment] = await Promise.all([
          server.attachIrohConnection(connection, () => true),
          pipe.ready(),
        ]);
        client.attachment = attachment;
        attachment.activate();
      };

      await Promise.all([connect(), connect()]);
      const serverClosed = clients.map(({ connection }) => connection.closed());
      await Promise.all(clients.map(({ pipe }) => pipe.close()));
      await Promise.all(serverClosed);
      await Promise.all(clients.map(({ attachment }) => attachment?.lifetime));
    } finally {
      await Promise.all(clients.map(({ pipe }) => pipe.close()));
      await server.stop();
    }
  });

  it("rejects attachment lifetime with the original control-loop failure", async () => {
    const server = new RpcServer({
      tokenManager: new TokenManager(),
      dispatcher: {
        dispatch: vi.fn(),
        assertAuthority: vi.fn().mockResolvedValue(undefined),
        getPolicy: vi.fn(() => ({ allowed: ["shell"] })),
        getMethodPolicy: vi.fn(() => undefined),
      } as unknown as ServiceDispatcher,
      workspaceId: "test-workspace",
      entityCache: new EntityCache(),
      runtimeCoordinator: new PanelRuntimeCoordinator(),
      userSubjectSource: { resolve: () => ({ userId: "usr_root", handle: "root" }) },
      resolveExtensionCodeIdentity: async () => null,
      ensureUserlandDoReady: async () => undefined,
      resolveExactCausalInvocation: async () => ({ initiatingUser: null }),
    });
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
    const clientConnection = new NodePhysicalConnection(clientNative);
    const attaching = server.attachIrohConnection(
      new NodePhysicalConnection(serverNative),
      () => true
    );
    const control = await clientConnection.openBi();
    await writeIrohStreamPreamble(control.send, { k: "control", v: IROH_WIRE_VERSION });
    const hello = encodeIrohSessionControlFrame({
      t: IROH_SESSION_HELLO,
      protocolVersion: IROH_WIRE_VERSION,
      contractVersion: RPC_CONTRACT_VERSION,
    });
    await writeFrame(control.send, hello, MAX_CONTROL_FRAME_BYTES);
    await writeFrame(
      control.send,
      encodeIrohSessionControlFrame({
        t: IROH_SESSION_DELEGATE,
        ...signEndpointDelegation(SecretKey.generate(), clientEndpoint.id().toString()),
      }),
      MAX_CONTROL_FRAME_BYTES
    );
    const attachment = await attaching;
    attachment.activate();
    const lifetimeFailure = attachment.lifetime.catch((error: unknown) => error);

    await writeFrame(control.send, hello, MAX_CONTROL_FRAME_BYTES);
    const failure = await lifetimeFailure;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Duplicate Iroh session hello" }),
    ]);
    expect((failure as AggregateError).cause).toBe((failure as AggregateError).errors[0]);
    await server.stop();
  });
});

describe("RpcServer device delegation admission over real local QUIC", () => {
  const endpoints = new Set<Awaited<ReturnType<typeof bindNodeEndpoint>>>();
  const pipes = new Set<ReturnType<typeof createIrohClientPipe>>();

  afterEach(async () => {
    await Promise.allSettled([...pipes].map((pipe) => pipe.close()));
    pipes.clear();
    await Promise.all([...endpoints].map((endpoint) => endpoint.close().catch(() => undefined)));
    endpoints.clear();
  });

  async function bind() {
    const endpoint = await bindNodeEndpoint({ secretKey: SecretKey.generate() });
    endpoints.add(endpoint);
    return endpoint;
  }

  function makeServer() {
    const dispatcher = {
      dispatch: vi.fn(async (_context, _service, _method, args: unknown[]) => args[0]),
      assertAuthority: vi.fn().mockResolvedValue(undefined),
      getPolicy: vi.fn(() => ({ allowed: ["shell"] })),
      getMethodPolicy: vi.fn(() => undefined),
    } as unknown as ServiceDispatcher;
    const redeemPairingCredential = vi.fn(async () => ({
      callerId: "electron-main",
      callerKind: "shell" as const,
      subject: { userId: "usr_root", handle: "root" },
    }));
    const server = new RpcServer({
      tokenManager: new TokenManager(),
      dispatcher,
      workspaceId: "test-workspace",
      entityCache: new EntityCache(),
      runtimeCoordinator: new PanelRuntimeCoordinator(),
      userSubjectSource: { resolve: () => ({ userId: "usr_root", handle: "root" }) },
      resolveExtensionCodeIdentity: async () => null,
      ensureUserlandDoReady: async () => undefined,
      resolveExactCausalInvocation: async () => ({ initiatingUser: null }),
      redeemPairingCredential,
    });
    return { server, redeemPairingCredential };
  }

  /** A fresh client process: its own random endpoint, delegated by `delegate(endpointId)`. */
  async function connect(
    serverEndpoint: Awaited<ReturnType<typeof bindNodeEndpoint>>,
    delegate: (endpointId: string) => ReturnType<typeof signEndpointDelegation>
  ) {
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
    const serverConnection = new NodePhysicalConnection(serverNative);
    const clientConnection = new NodePhysicalConnection(clientNative);
    const pipe = createIrohClientPipe(clientConnection, delegate(clientEndpoint.id().toString()));
    pipes.add(pipe);
    return { serverConnection, clientConnection, pipe };
  }

  async function admitted(
    server: RpcServer,
    serverEndpoint: Awaited<ReturnType<typeof bindNodeEndpoint>>,
    delegate: (endpointId: string) => ReturnType<typeof signEndpointDelegation>,
    admit: (deviceKey: string) => boolean = () => true
  ) {
    const peer = await connect(serverEndpoint, delegate);
    const [attachment] = await Promise.all([
      server.attachIrohConnection(peer.serverConnection, admit),
      peer.pipe.ready(),
    ]);
    attachment.activate();
    return { ...peer, attachment };
  }

  async function refused(
    server: RpcServer,
    serverEndpoint: Awaited<ReturnType<typeof bindNodeEndpoint>>,
    delegate: (endpointId: string) => ReturnType<typeof signEndpointDelegation>,
    admit: (deviceKey: string) => boolean
  ) {
    const peer = await connect(serverEndpoint, delegate);
    const attaching = server.attachIrohConnection(peer.serverConnection, admit);
    // A refused connection never reaches the lifecycle stream's hello reply.
    const ready = peer.pipe.ready().catch((error: unknown) => error);
    const failure = await attaching.then(
      () => null,
      (error: unknown) => error
    );
    peer.serverConnection.close(0x210n, new TextEncoder().encode("refused"));
    await ready;
    return failure;
  }

  it("refuses a delegation signed by a key other than the one it names", async () => {
    const { server } = makeServer();
    const serverEndpoint = await bind();
    const admit = vi.fn(() => true);
    const device = SecretKey.generate();
    const failure = await refused(
      server,
      serverEndpoint,
      (endpointId) => ({
        ...signEndpointDelegation(SecretKey.generate(), endpointId),
        deviceKey: device.public().toString(),
      }),
      admit
    );
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/delegation/) })
    );
    expect(admit).not.toHaveBeenCalled();
    await server.stop();
  });

  it("refuses a delegation made for a different endpoint", async () => {
    const { server } = makeServer();
    const serverEndpoint = await bind();
    const admit = vi.fn(() => true);
    const device = SecretKey.generate();
    const other = SecretKey.generate().public().toString();
    const failure = await refused(
      server,
      serverEndpoint,
      () => signEndpointDelegation(device, other),
      admit
    );
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/delegation/) })
    );
    expect(admit).not.toHaveBeenCalled();
    await server.stop();
  });

  it("refuses a device the server does not admit, such as a revoked one", async () => {
    const { server } = makeServer();
    const serverEndpoint = await bind();
    const device = SecretKey.generate();
    const admit = vi.fn(() => false);
    const failure = await refused(
      server,
      serverEndpoint,
      (endpointId) => signEndpointDelegation(device, endpointId),
      admit
    );
    expect(admit).toHaveBeenCalledWith(device.public().toString());
    expect(failure).toEqual(expect.objectContaining({ message: "Iroh device is not admitted" }));
    await server.stop();
  });

  it("refuses a peer that opens no delegation after hello", async () => {
    const { server } = makeServer();
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
    const admit = vi.fn(() => true);
    const attaching = server.attachIrohConnection(new NodePhysicalConnection(serverNative), admit);
    const control = await new NodePhysicalConnection(clientNative).openBi();
    await writeIrohStreamPreamble(control.send, { k: "control", v: IROH_WIRE_VERSION });
    const hello = encodeIrohSessionControlFrame({
      t: IROH_SESSION_HELLO,
      protocolVersion: IROH_WIRE_VERSION,
      contractVersion: RPC_CONTRACT_VERSION,
    });
    await writeFrame(control.send, hello, MAX_CONTROL_FRAME_BYTES);
    await writeFrame(control.send, hello, MAX_CONTROL_FRAME_BYTES);
    await expect(attaching).rejects.toThrow(/delegate its endpoint/);
    expect(admit).not.toHaveBeenCalled();
    await server.stop();
  });

  it("serves several connections of one device and revocation closes every one of them", async () => {
    const { server, redeemPairingCredential } = makeServer();
    const serverEndpoint = await bind();
    const device = SecretKey.generate();
    const bystander = SecretKey.generate();
    const delegate = (key: typeof device) => (endpointId: string) =>
      signEndpointDelegation(key, endpointId);

    // Two concurrent processes of the same device, each on its own endpoint.
    const first = await admitted(server, serverEndpoint, delegate(device));
    const second = await admitted(server, serverEndpoint, delegate(device));
    const other = await admitted(server, serverEndpoint, delegate(bystander));
    for (const peer of [first, second]) {
      const rpc = createRpcClient({
        selfId: "electron-main",
        callerKind: "shell",
        transport: peer.pipe.openSession({ getToken: () => "refresh:dev_test:" + "r".repeat(43) }),
      });
      await expect(rpc.call("main", irohServerTestMethods.echo, ["hi"])).resolves.toBe("hi");
    }
    // Both processes were bound to the one device, not to their own endpoints.
    expect(redeemPairingCredential).toHaveBeenCalledTimes(2);
    for (const [, context] of redeemPairingCredential.mock.calls as unknown as Array<
      [string, { transport: unknown }]
    >) {
      expect(context.transport).toEqual({ kind: "iroh", deviceKey: device.public().toString() });
    }

    const firstClosed = first.serverConnection.closed();
    const secondClosed = second.serverConnection.closed();
    await expect(
      server.closeDeviceConnections(device.public().toString(), "device revoked")
    ).resolves.toBe(2);
    await Promise.all([
      firstClosed,
      secondClosed,
      first.attachment.lifetime,
      second.attachment.lifetime,
    ]);

    // An unrelated device's connection is untouched and still serves.
    const rpc = createRpcClient({
      selfId: "electron-main",
      callerKind: "shell",
      transport: other.pipe.openSession({ getToken: () => "refresh:dev_other:" + "r".repeat(43) }),
    });
    await expect(rpc.call("main", irohServerTestMethods.echo, ["still"])).resolves.toBe("still");
    await expect(
      server.closeDeviceConnections(device.public().toString(), "device revoked")
    ).resolves.toBe(0);
    await server.stop();
  });
});
