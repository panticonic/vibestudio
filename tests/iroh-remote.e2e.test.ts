/**
 * Complete native Iroh remote smoke.
 *
 * This is the successor to the pre-Iroh native/system E2E suites. It
 * crosses the real native QUIC boundary and the production ingress, session,
 * authentication, dispatch, and streaming adapters. The cases deliberately
 * exercise product lifecycles rather than framing helpers:
 *
 *   native client endpoint -> Iroh ingress -> RpcServer -> ServiceDispatcher
 *
 * Run with `pnpm test:iroh-e2e`. The environment gate keeps the native sockets
 * out of broad Vitest discovery while the explicit smoke command and nightly
 * workflow always enable them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Endpoint, SecretKey as SecretKeyType } from "@number0/iroh";
import {
  bindNodeEndpoint,
  configureNodeConnection,
  loadIrohNodeBinding,
  NodePhysicalConnection,
  NodePhysicalEndpoint,
  VIBESTUDIO_IROH_ALPN,
} from "@vibestudio/iroh-transport/node";
import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import {
  createIrohClientPipe,
  type IrohClientPipe,
  type IrohClientSession,
} from "@vibestudio/rpc/transports/irohClient";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ServiceContext, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import type { DeviceCredential } from "@vibestudio/rpc/protocol/wsProtocol";
import { encodeBlobRecord } from "@vibestudio/shared/panel/blobBundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPanelAssetFacade } from "../src/node/panelAssets/panelAssetFacade.js";
import { DeviceAuthStore } from "../src/server/hostCore/deviceAuthStore.js";
import { startIrohIngress, type IrohIngress } from "../src/server/irohIngress.js";
import { PanelRuntimeCoordinator } from "../src/server/panelRuntimeCoordinator.js";
import { RpcServer } from "../src/server/rpcServer.js";
import { createHubCredentialRedeemer } from "../src/server/services/authService.js";

const RUN = process.env["VIBESTUDIO_RUN_IROH_E2E"] === "1";
const { SecretKey } = loadIrohNodeBinding();

interface ConnectedClient {
  endpoint: Endpoint;
  pipe: IrohClientPipe;
}

interface PairedClient extends ConnectedClient {
  credential: DeviceCredential;
  session: IrohClientSession;
  rpc: RpcClient;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Iroh smoke condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function within<T>(promise: Promise<T>, message: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.runIf(RUN)("Iroh complete native remote smoke", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-iroh-e2e-"));
  const clients = new Set<ConnectedClient>();
  const serverSecret = SecretKey.generate();
  let serverEndpoint: Endpoint;
  let ingress: IrohIngress;
  let rpcServer: RpcServer;
  let identityDb: IdentityDb;
  let userStore: UserStore;
  let deviceAuthStore: DeviceAuthStore;
  let workspaceId: string;
  const dispatched: Array<{ method: string; args: unknown[]; subject?: string; body?: string }> =
    [];
  let gatewayHandler: ((args: unknown[]) => Promise<Response>) | null = null;

  const createClient = async (
    secret: SecretKeyType = SecretKey.generate()
  ): Promise<ConnectedClient> => {
    const endpoint = await bindNodeEndpoint({ secretKey: secret });
    const nativeConnection = await endpoint.connect(serverEndpoint.addr(), [
      ...VIBESTUDIO_IROH_ALPN,
    ]);
    configureNodeConnection(nativeConnection);
    const pipe = createIrohClientPipe(new NodePhysicalConnection(nativeConnection));
    const client = { endpoint, pipe };
    clients.add(client);
    await pipe.ready();
    return client;
  };

  const closeClient = async (client: ConnectedClient): Promise<void> => {
    clients.delete(client);
    await client.pipe.close().catch(() => undefined);
    await client.endpoint.close().catch(() => undefined);
  };

  const mintInvite = (): string => {
    const root = userStore.getByHandle("root");
    if (!root) throw new Error("Iroh smoke root user is missing");
    return deviceAuthStore.createPairingInvite(60_000, {
      workspaceId,
      userId: root.id,
      intent: "pair-device",
    }).code;
  };

  const rpcFor = (session: IrohClientSession): RpcClient => {
    const callerId = session.callerId();
    if (!callerId) throw new Error("Iroh smoke session has no authenticated caller id");
    return createRpcClient({ selfId: callerId, callerKind: "shell", transport: session });
  };

  const pairFresh = async (
    options: {
      secret?: SecretKeyType;
      sid?: string;
      connectionId?: string;
    } = {}
  ): Promise<PairedClient> => {
    const client = await createClient(options.secret);
    const code = mintInvite();
    let credential: DeviceCredential | null = null;
    const session = client.pipe.openSession({
      sid: options.sid,
      connectionId: options.connectionId,
      clientLabel: "Iroh native smoke",
      clientPlatform: "desktop",
      getToken: () => code,
      onPaired: (issued) => {
        credential = issued;
      },
    });
    await session.ready?.();
    if (!credential) throw new Error("Fresh Iroh pairing returned no durable device credential");
    return { ...client, credential, session, rpc: rpcFor(session) };
  };

  beforeAll(async () => {
    const central = new CentralDataManager({ databasePath: path.join(tmp, "identity.db") });
    workspaceId = central.addWorkspace("iroh-smoke").workspaceId;
    central.close();
    identityDb = new IdentityDb({ path: path.join(tmp, "identity.db"), readOnly: false });
    userStore = new UserStore(identityDb);
    userStore.createRoot({ handle: "root", displayName: "Root" });
    deviceAuthStore = new DeviceAuthStore({
      db: identityDb,
      serverIdPath: path.join(tmp, "server-id.json"),
    });
    const tokenManager = new TokenManager();
    const dispatcher = {
      initialized: true,
      dispatch: async (
        context: ServiceContext,
        service: string,
        method: string,
        args: unknown[]
      ) => {
        const body = context.body ? await new Response(context.body).text() : undefined;
        dispatched.push({ method, args, subject: context.caller.subject?.userId, body });
        if (service === "gateway" && method === "fetch" && gatewayHandler) {
          return gatewayHandler(args);
        }
        if (method === "stream") {
          return new Response(`download:${body ?? ""}`, {
            status: 206,
            headers: { "content-type": "text/plain", "x-iroh-smoke": "native" },
          });
        }
        if (method === "hold") {
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          });
        }
        return { method, args, subject: context.caller.subject };
      },
      assertAuthority: async () => undefined,
      getPolicy: () => ({ allowed: ["shell"] }),
      getMethodPolicy: () => undefined,
    } as unknown as ServiceDispatcher;
    rpcServer = new RpcServer({
      tokenManager,
      dispatcher,
      workspaceId,
      entityCache: new EntityCache(),
      runtimeCoordinator: new PanelRuntimeCoordinator(),
      ensureUserlandDoReady: async () => undefined,
      userSubjectSource: {
        resolve: (callerId) => {
          const deviceId = callerId.startsWith("shell:") ? callerId.slice("shell:".length) : "";
          const device = deviceAuthStore
            .listDevices()
            .find((candidate) => candidate.deviceId === deviceId);
          const user = device ? userStore.getUser(device.userId) : null;
          return user ? { userId: user.id, handle: user.handle } : undefined;
        },
      },
      redeemPairingCredential: createHubCredentialRedeemer({
        deviceAuthStore,
        tokenManager,
        redeemPairingCode: async (code, input) =>
          deviceAuthStore.completePairing({ code, ...input }),
        resolveUser: (userId) => userStore.getUser(userId),
      }),
    });
    ingress = startIrohIngress({
      binding: {
        async bind() {
          serverEndpoint = await bindNodeEndpoint({ secretKey: serverSecret });
          return new NodePhysicalEndpoint(serverEndpoint);
        },
      },
      admitPeer: () => true,
      attach: (connection) => rpcServer.attachIrohConnection(connection),
    });
    await ingress.ready;
  }, 30_000);

  afterAll(async () => {
    await Promise.all([...clients].map(closeClient));
    await ingress?.stop().catch(() => undefined);
    await rpcServer?.stop().catch(() => undefined);
    identityDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pairs a fresh endpoint and dispatches authenticated RPC through production ingress", async () => {
    const paired = await pairFresh();
    expect(paired.credential.deviceId).toMatch(/^dev_/u);
    expect(paired.credential.refreshToken.length).toBeGreaterThan(32);
    expect(paired.session.callerId()).toBe(`shell:${paired.credential.deviceId}`);
    expect(paired.pipe.peerEndpointId).toBe(serverEndpoint.id().toString());
    expect(paired.pipe.diagnostics()?.paths.some((candidate) => candidate.selected)).toBe(true);

    await expect(paired.rpc.call("main", "demo.echo", ["hello-iroh"])).resolves.toMatchObject({
      method: "echo",
      args: ["hello-iroh"],
      subject: { handle: "root" },
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({ method: "echo", args: ["hello-iroh"] })
    );
    await closeClient(paired);
  }, 30_000);

  it("rejects replay of a consumed one-time pairing credential", async () => {
    const client = await createClient();
    const code = mintInvite();
    const first = client.pipe.openSession({ sid: "first", getToken: () => code });
    await first.ready?.();
    const devicesAfterPairing = deviceAuthStore.listDevices().length;
    const replay = client.pipe.openSession({ sid: "replay", getToken: () => code });
    await expect(replay.ready?.()).rejects.toThrow(/invalid|expired|pairing/iu);
    expect(deviceAuthStore.listDevices()).toHaveLength(devicesAfterPairing);
    await closeClient(client);
  }, 30_000);

  it("reconnects the same endpoint with its durable refresh credential", async () => {
    const secret = SecretKey.generate();
    const paired = await pairFresh({ secret, sid: "fresh", connectionId: "stable-shell" });
    const refresh = `refresh:${paired.credential.deviceId}:${paired.credential.refreshToken}`;
    const endpointId = paired.endpoint.id().toString();
    await closeClient(paired);

    const returning = await createClient(secret);
    expect(returning.endpoint.id().toString()).toBe(endpointId);
    let issuedAgain = false;
    const session = returning.pipe.openSession({
      sid: "returning",
      connectionId: "stable-shell",
      getToken: () => refresh,
      onPaired: () => {
        issuedAgain = true;
      },
    });
    await session.ready?.();
    expect(session.callerId()).toBe(`shell:${paired.credential.deviceId}`);
    expect(issuedAgain).toBe(false);
    await expect(rpcFor(session).call("main", "demo.echo", ["reconnected"])).resolves.toMatchObject(
      {
        args: ["reconnected"],
      }
    );
    await closeClient(returning);
  }, 30_000);

  it("keeps two independently paired endpoints live and dispatching concurrently", async () => {
    const [left, right] = await Promise.all([pairFresh(), pairFresh()]);
    expect(left.credential.deviceId).not.toBe(right.credential.deviceId);
    const [leftResult, rightResult] = await Promise.all([
      left.rpc.call("main", "demo.echo", ["left"]),
      right.rpc.call("main", "demo.echo", ["right"]),
    ]);
    expect(leftResult).toMatchObject({ args: ["left"] });
    expect(rightResult).toMatchObject({ args: ["right"] });
    expect(left.pipe.status()).toBe("connected");
    expect(right.pipe.status()).toBe("connected");
    await Promise.all([closeClient(left), closeClient(right)]);
  }, 30_000);

  it("deterministically replaces an old same-device session without disturbing the pipe", async () => {
    const paired = await pairFresh({ sid: "old-session", connectionId: "takeover-shell" });
    const refresh = `refresh:${paired.credential.deviceId}:${paired.credential.refreshToken}`;
    const replacement = paired.pipe.openSession({
      sid: "replacement-session",
      connectionId: "takeover-shell",
      getToken: () => refresh,
    });
    await replacement.ready?.();
    await waitFor(() => paired.session.isClosed());
    expect(replacement.isClosed()).toBe(false);
    expect(paired.pipe.status()).toBe("connected");
    await expect(
      rpcFor(replacement).call("main", "demo.echo", ["replacement"])
    ).resolves.toMatchObject({
      args: ["replacement"],
    });
    await closeClient(paired);
  }, 30_000);

  it("streams an upload and response body over a dedicated native QUIC stream", async () => {
    const paired = await pairFresh();
    const upload = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("panel-asset-request"));
        controller.close();
      },
    });
    let response: Response;
    try {
      response = await paired.rpc.stream("main", "demo.stream", ["asset"], {
        body: upload,
        trafficClass: "bulk",
      });
    } catch (error) {
      throw new Error(`opening Iroh response failed: ${String(error)}`, { cause: error });
    }
    expect(response.status).toBe(206);
    expect(response.headers.get("x-iroh-smoke")).toBe("native");
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new Error(`reading Iroh response failed: ${String(error)}`, { cause: error });
    }
    expect(responseText).toBe("download:panel-asset-request");
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        method: "stream",
        args: ["asset"],
        body: "panel-asset-request",
      })
    );
    await closeClient(paired);
  }, 30_000);

  it("keeps unrelated façade assets and RPCs live during a build prefetch", async () => {
    const paired = await pairFresh();
    const buildKey = "a".repeat(64);
    const entryPath = `/panels/chat/?contextId=remote&buildKey=${buildKey}`;
    const manifestPath = `/__vibestudio/panel-build/${buildKey}/__manifest.json`;
    const bundlePrefix = `/__vibestudio/panel-build/${buildKey}/__bundle?`;
    const artifact = "export const ready = true;";
    const artifactDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(artifact)
    );
    const artifactHash = Buffer.from(artifactDigest).toString("hex");
    const bundle = Buffer.from(encodeBlobRecord(artifactHash, Buffer.from(artifact)));
    const manifest = JSON.stringify({
      artifacts: [
        {
          path: "bundle.js",
          contentType: "application/javascript; charset=utf-8",
          integrity: `sha256-${artifactHash}`,
          initial: true,
        },
      ],
    });
    let releaseBundle!: () => void;
    const bundleReleased = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    let announceBundle!: () => void;
    const bundleStarted = new Promise<void>((resolve) => {
      announceBundle = resolve;
    });
    const requested: string[] = [];
    gatewayHandler = async (args) => {
      const descriptor = args[0] as { path: string };
      requested.push(descriptor.path);
      if (descriptor.path === manifestPath) {
        return new Response(manifest, { headers: { "content-type": "application/json" } });
      }
      if (descriptor.path.startsWith(bundlePrefix)) {
        announceBundle();
        await bundleReleased;
        return new Response(bundle, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (descriptor.path.startsWith("/__vibestudio/unit-icon?")) {
        return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
          headers: { "content-type": "image/svg+xml" },
        });
      }
      if (descriptor.path === entryPath) {
        return new Response("<!doctype html><main>chat</main>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const facade = await startPanelAssetFacade(
      {
        stream: (_service, _method, args, options) =>
          paired.rpc.stream("main", "gateway.fetch", args ?? [], options),
      },
      { stateDir: path.join(tmp, `facade-${Date.now()}`) }
    );
    try {
      const origin = `http://127.0.0.1:${facade.port}`;
      const entryUrl = `${origin}${entryPath}`;
      const entry = await fetch(entryUrl);
      expect(entry.status).toBe(200);
      expect(await entry.text()).toContain("chat");
      await within(bundleStarted, "panel prefetch never started", 2_000);

      const iconPaths = [
        "/__vibestudio/unit-icon?source=workers%2Flinked-agent&path=assets%2Ficon.svg",
        "/__vibestudio/unit-icon?source=workers%2Fagent-worker&path=assets%2Ficon.svg",
        "/__vibestudio/unit-icon?source=panels%2Fchat&path=assets%2Ficon.svg",
      ];
      const iconResponses = await within(
        Promise.all(
          iconPaths.map((iconPath) =>
            fetch(`${origin}${iconPath}`, { headers: { referer: entryUrl } })
          )
        ),
        "unrelated façade assets waited behind panel prefetch",
        2_000
      );
      expect(iconResponses.every((response) => response.status === 200)).toBe(true);
      await expect(
        within(
          paired.rpc.call("main", "demo.echo", ["beside-prefetch"]),
          "short RPC waited behind panel prefetch",
          2_000
        )
      ).resolves.toMatchObject({ args: ["beside-prefetch"] });
      expect(requested).toEqual(expect.arrayContaining(iconPaths));
    } finally {
      releaseBundle();
      gatewayHandler = null;
      await facade.close();
      await closeClient(paired);
    }
  }, 15_000);

  it("recycles native stream credit across a concurrent unary burst", async () => {
    const paired = await pairFresh();
    const calls = Array.from({ length: 96 }, (_, index) =>
      paired.rpc.call("main", "demo.echo", [`credit-${index}`])
    );

    const results = await within(
      Promise.all(calls),
      "Iroh unary stream credit was not recycled",
      5_000
    );

    expect(results).toHaveLength(96);
    expect(results[95]).toMatchObject({ args: ["credit-95"] });
    await closeClient(paired);
  }, 10_000);

  it("keeps short RPCs available beside the product's long-lived stream budget", async () => {
    const paired = await pairFresh();
    const held: Response[] = [];
    try {
      for (let index = 0; index < 96; index += 1) {
        held.push(await paired.rpc.stream("main", "demo.hold", [index]));
      }
      const calls = Array.from({ length: 8 }, (_, index) =>
        paired.rpc.call("main", "demo.echo", [`beside-hold-${index}`])
      );
      const results = await within(
        Promise.all(calls),
        "Iroh short RPCs were stream-window starved",
        2_000
      );
      expect(results).toHaveLength(8);
    } finally {
      await closeClient(paired);
    }
  }, 10_000);
});
