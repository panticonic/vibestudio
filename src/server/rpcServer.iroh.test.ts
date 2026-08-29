import {
  bindNodeEndpoint,
  configureNodeConnection,
  loadIrohNodeBinding,
  NodePhysicalConnection,
  VIBESTUDIO_IROH_ALPN,
} from "@vibestudio/iroh-transport/node";
import { createRpcClient } from "@vibestudio/rpc";
import { createIrohClientPipe } from "@vibestudio/rpc/transports/irohClient";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { RpcServer } from "./rpcServer.js";

const { SecretKey } = loadIrohNodeBinding();

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
      async (_token: string, _context: { transport: { kind: string; endpointId?: string } }) => ({
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
      resolveExtensionCodeIdentity: () => null,
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
    const pipe = createIrohClientPipe(clientConnection);
    await Promise.all([
      server.attachIrohConnection(new NodePhysicalConnection(serverNative)),
      pipe.ready(),
    ]);
    const session = pipe.openSession({ sid: "shell", getToken: () => token });
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

    const result = rpc.call("main", "test.echo", ["through-iroh"]);
    await vi.waitFor(() => expect(dispatcher.dispatch).toHaveBeenCalled(), { timeout: 2_000 });
    await expect(result).resolves.toBe("through-iroh");

    // Unary results use the QUIC stream's FIN as their payload boundary. A
    // large result therefore retains QUIC backpressure without inheriting the
    // old 8 MiB metadata-frame ceiling, and it cannot head-of-line block an
    // independent request on another stream.
    const [receivedLarge, concurrentEcho] = await Promise.all([
      rpc.call<string>("main", "test.large", []),
      rpc.call<string>("main", "test.echo", ["concurrent"]),
    ]);
    expect(receivedLarge).toHaveLength(largeResult.length);
    expect(receivedLarge.startsWith("large:")).toBe(true);
    expect(concurrentEcho).toBe("concurrent");
    expect(redeemPairingCredential).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        transport: {
          kind: "iroh",
          endpointId: clientEndpoint.id().toString(),
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
  });
});
