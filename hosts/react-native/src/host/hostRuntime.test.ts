import { describe, expect, it, vi } from "vitest";
import { encodeRpcJson } from "@vibestudio/rpc";
import { sha256Integrity } from "@vibestudio/client-host-core";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type { SupervisionChange } from "@vibestudio/shared/events";
import { HostRuntime, type HostEvents, type HostRuntimePorts } from "./hostRuntime";
import { HostState } from "./hostState";
import type { DeviceConnection } from "./deviceConnection";
import type { HostRuntimeEvent } from "./nativeHostRuntime";
import type { KeyValueStore } from "./ports";
import { FakeSession } from "./testSupport";
import { MemoryStore } from "../../../core/src/testing";

const DIGEST = "e".repeat(64);
const TAG = "client:browser:react-native:dev1";
const enc = (text: string) => new TextEncoder().encode(text);

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    remove: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
  };
}

/** What the server answers `clients.launch`, and the bytes it serves for each route. */
interface Build {
  buildKey: string;
  bundle: string;
  servedBundle?: string;
}

async function readyOf(build: Build, over: Record<string, unknown> = {}) {
  return {
    state: "ready",
    client: {
      source: "clients/mobile-browser",
      id: "browser",
      runtime: "react-native",
      title: "Vibestudio",
      buildKey: build.buildKey,
      executionDigest: DIGEST,
      effectiveVersion: `v-${build.buildKey}`,
      hostAbi: "rn-host-6",
      artifacts: [
        {
          path: "android/index.bundle",
          role: "primary",
          contentType: "application/javascript",
          platform: "android",
          integrity: await sha256Integrity(enc(build.bundle)),
        },
        {
          path: "ios/index.bundle",
          role: "primary",
          contentType: "application/javascript",
          platform: "ios",
          integrity: await sha256Integrity(enc(build.bundle)),
        },
      ],
      grantedCapabilities: ["device-session", "panel-hosting"],
      deniedOptional: [],
      ...over,
    },
  };
}

function change(buildKey: string, over: Partial<SupervisionChange> = {}): SupervisionChange {
  return {
    identity: { kind: "client", entityId: "browser" },
    source: "clients/mobile-browser",
    status: "running",
    lastError: null,
    artifact: { effectiveVersion: `v-${buildKey}`, buildKey, executionDigest: DIGEST },
    canRollback: true,
    change: "adopted",
    previousBuildKey: "bk-1",
    previousEffectiveVersion: "v-bk-1",
    client: { id: "browser", runtime: "react-native", grantedCapabilities: ["device-session", "panel-hosting"] },
    ...over,
  } as SupervisionChange;
}

async function setup(options: { launches: unknown[]; served?: Record<string, string> }) {
  const launches = [...options.launches];
  const served: Record<string, string> = { ...options.served };
  const fetched: string[] = [];
  const principalSession = new FakeSession(TAG);
  const principalHandlers: { onTerminalClose?: (error: Error) => void } = {};
  const rpcCalls: Array<{ name: string; args: unknown[] }> = [];
  let grants = 0;

  const handle = async (name: string, args: unknown[]): Promise<unknown> => {
    rpcCalls.push({ name, args });
    switch (name) {
      case "clients.launch":
        return launches.shift();
      case "auth.grantClientPrincipal":
        grants += 1;
        return {
          connectionGrant: `grant-${grants}`,
          expiresAt: 1,
          principalId: TAG,
          deviceId: "dev1",
          serverId: "srv",
          serverBootId: "boot",
          workspaceId: "ws-system",
        };
      case "shellApproval.resolveBootstrap":
        return [];
      default:
        return undefined;
    }
  };
  const rpc = {
    call: (_target: string, method: { name: string; invoke: Function }, args: unknown[]) =>
      method.invoke(args, (wire: unknown[]) => handle(method.name, wire)),
  };
  const launch = {
    rpc,
    deviceId: "dev1",
    serverId: "srv",
    transport: { onReconnectProgress: () => () => undefined },
    waitUntilConnected: async () => undefined,
    openAuxiliarySession: (
      _label: string,
      opts: { onTerminalClose?: (error: Error) => void }
    ) => {
      principalHandlers.onTerminalClose = opts.onTerminalClose;
      return principalSession.asSession();
    },
    close: async () => undefined,
  };
  const connection = {
    account: { control: launch, openWorkspace: async () => launch },
    launch,
    systemWorkspaceId: "ws-system",
    recovery: createRecoveryCoordinator(),
    close: vi.fn(async () => undefined),
  } as unknown as DeviceConnection;

  const listeners = new Map<string, Set<(payload: never) => void>>();
  const events: HostEvents = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as never);
      listeners.set(event, set);
      return () => set.delete(listener as never);
    },
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
    unsubscribeAll: async () => undefined,
  };
  const emitServerEvent = async (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload as never);
    await vi.waitFor(() => undefined);
  };

  let nativeHandler: ((event: HostRuntimeEvent) => void) | null = null;
  const native = {
    markReady: vi.fn(async () => undefined),
    startClient: vi.fn(async () => undefined),
    reloadClient: vi.fn(async () => undefined),
    stopClient: vi.fn(async () => undefined),
    focusClient: vi.fn(async () => undefined),
    showHostSurface: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    emit: vi.fn(async () => undefined),
    artifactMaterializeBuild: vi.fn(async (buildKey: string) => `/builds/${buildKey}`),
    artifactRetainBuilds: vi.fn(async () => undefined),
  };
  const store = new MemoryStore();
  const forget = vi.fn(async () => undefined);
  const notifications = {
    handlers: {} as never,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    onEvent: () => () => undefined,
    drain: vi.fn(async () => undefined),
  };
  const state = new HostState(memoryStore());
  const ports: HostRuntimePorts = {
    native,
    onNativeEvent(handler) {
      nativeHandler = handler;
      return () => undefined;
    },
    device: {
      isPaired: async () => true,
      connect: async () => connection,
      pair: async () => undefined,
      forget,
    },
    events: () => events,
    artifactStore: store,
    artifactFetch: () => async (route) => {
      fetched.push(route);
      const body = served[route];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(enc(body), { status: 200 });
    },
    state,
    deviceCapabilities: {} as never,
    notifications,
    links: {
      isConnectLink: () => false,
      parseConnectLink: () => {
        throw new Error("unused");
      },
      consumeReplay: async () => false,
      markConsumed: async () => undefined,
      consumeUsbApproval: async () => false,
    },
    linkSource: { onUrl: () => () => undefined, initialUrl: async () => null },
    platform: "android",
    hostVersion: "1.0.0",
  };
  const runtime = new HostRuntime(ports);
  const request = async (method: string, args: unknown[] = [], requestId = `r-${Math.random()}`) => {
    nativeHandler!({
      type: "client-request",
      tag: TAG,
      requestId,
      method,
      argsJson: encodeRpcJson(args),
    });
    await vi.waitFor(() => {
      const answered =
        native.respond.mock.calls.some((c) => c[1] === requestId) ||
        native.reject.mock.calls.some((c) => c[1] === requestId);
      if (!answered) throw new Error("not answered yet");
    });
    return {
      responded: native.respond.mock.calls.find((c) => c[1] === requestId),
      rejected: native.reject.mock.calls.find((c) => c[1] === requestId),
    };
  };
  return {
    runtime,
    native,
    store,
    fetched,
    served,
    rpcCalls,
    forget,
    state,
    principalSession,
    principalHandlers,
    emitServerEvent,
    request,
    connection,
    queue: (...more: unknown[]) => launches.push(...more),
  };
}

const route = (buildKey: string) => `/_a/${buildKey}/android/index.bundle`;

describe("launching a client", () => {
  it("starts the client from a verified bundle laid out for native, after readiness is signalled", async () => {
    const build = { buildKey: "bk-1", bundle: "client bundle 1" };
    const t = await setup({
      launches: [await readyOf(build)],
      served: { [route("bk-1")]: build.bundle, "/_a/bk-1/ios/index.bundle": build.bundle },
    });

    await t.runtime.start();

    expect(t.native.markReady).toHaveBeenCalledTimes(1);
    // Listeners are attached and native released before the first client starts.
    expect(t.native.markReady.mock.invocationCallOrder[0]!).toBeLessThan(
      t.native.startClient.mock.invocationCallOrder[0]!
    );
    expect(t.native.artifactMaterializeBuild).toHaveBeenCalledWith("bk-1", [
      { path: "android/index.bundle", integrity: await sha256Integrity(enc(build.bundle)) },
    ]);
    expect(t.native.startClient).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: TAG,
        clientId: "browser",
        bundlePath: "/builds/bk-1/android/index.bundle",
        assetsRoot: "/builds/bk-1",
        integrity: await sha256Integrity(enc(build.bundle)),
        buildKey: "bk-1",
        grantedCapabilities: ["device-session", "panel-hosting"],
      })
    );
    expect(t.runtime.ui.get()).toMatchObject({ phase: "running" });
    expect(t.runtime.ui.get().running).toEqual([{ tag: TAG, title: "Vibestudio" }]);
  });

  it("never loads a bundle whose bytes do not match the integrity the server sealed", async () => {
    const build = { buildKey: "bk-1", bundle: "the real bundle" };
    const t = await setup({
      launches: [await readyOf(build)],
      served: {
        [route("bk-1")]: "tampered bundle",
        "/_a/bk-1/ios/index.bundle": "tampered bundle",
      },
    });

    await t.runtime.start();

    expect(t.native.startClient).not.toHaveBeenCalled();
    expect(t.native.artifactMaterializeBuild).not.toHaveBeenCalled();
    expect(t.store.writes).toBe(0);
    expect(t.runtime.ui.get().phase).toBe("failed");
    expect(t.runtime.ui.get().message).toMatch(/integrity/i);
  });

  it("shows the review on the host surface and starts the client only once it is approved", async () => {
    const build = { buildKey: "bk-1", bundle: "client bundle 1" };
    const t = await setup({
      launches: [
        { state: "approval-required", approvals: [{ kind: "unit-install-review", approvalId: "ap1", parts: [] }] },
        await readyOf(build),
      ],
      served: { [route("bk-1")]: build.bundle, "/_a/bk-1/ios/index.bundle": build.bundle },
    });

    await t.runtime.start();

    expect(t.native.startClient).not.toHaveBeenCalled();
    expect(t.native.showHostSurface).toHaveBeenCalled();
    expect(t.runtime.ui.get()).toMatchObject({ phase: "launching", launchStatus: "approval-required" });

    await t.runtime.resolveApprovals("once");

    expect(t.rpcCalls.some((call) => call.name === "shellApproval.resolveBootstrap")).toBe(true);
    expect(t.native.startClient).toHaveBeenCalledTimes(1);
  });

  it("continues a launch that was preparing when the server reports a change, not on a timer", async () => {
    const build = { buildKey: "bk-1", bundle: "client bundle 1" };
    const t = await setup({
      launches: [
        { state: "preparing", phase: "build", reason: "Building the client" },
        await readyOf(build),
      ],
      served: { [route("bk-1")]: build.bundle, "/_a/bk-1/ios/index.bundle": build.bundle },
    });

    await t.runtime.start();
    expect(t.runtime.ui.get()).toMatchObject({ launchStatus: "preparing" });
    expect(t.native.startClient).not.toHaveBeenCalled();

    await t.emitServerEvent("clients:changed", { reason: "build" });
    await vi.waitFor(() => expect(t.native.startClient).toHaveBeenCalledTimes(1));
  });
});

describe("updates", () => {
  async function running(development = false) {
    const first = { buildKey: "bk-1", bundle: "client bundle 1" };
    const second = { buildKey: "bk-2", bundle: "client bundle 2" };
    const t = await setup({
      launches: [await readyOf(first)],
      served: {
        [route("bk-1")]: first.bundle,
        "/_a/bk-1/ios/index.bundle": first.bundle,
        [route("bk-2")]: second.bundle,
        "/_a/bk-2/ios/index.bundle": second.bundle,
      },
    });
    if (development) await t.state.setDevelopment("browser", true);
    await t.runtime.start();
    t.queue(await readyOf(second));
    return { t, second };
  }

  it("offers the build to the client and reloads only its instance when the client asks", async () => {
    const { t, second } = await running();

    await t.emitServerEvent("supervision:changed", change("bk-2"));

    expect(t.native.reloadClient).not.toHaveBeenCalled();
    const offer = t.native.emit.mock.calls
      .map(([, json]) => JSON.parse(json as string))
      .find((event) => event.type === "update");
    expect(offer.update.buildKey).toBe("bk-2");

    const { responded } = await t.request("updates.restartAtSafePoint");
    expect(responded).toBeDefined();
    expect(t.native.reloadClient).toHaveBeenCalledTimes(1);
    expect(t.native.reloadClient).toHaveBeenCalledWith(
      TAG,
      expect.objectContaining({
        bundlePath: "/builds/bk-2/android/index.bundle",
        integrity: await sha256Integrity(enc(second.bundle)),
        buildKey: "bk-2",
      })
    );
    // The host never restarted the process or the other instances.
    expect(t.native.startClient).toHaveBeenCalledTimes(1);
    expect(t.native.stopClient).not.toHaveBeenCalled();
    expect(t.native.artifactRetainBuilds).toHaveBeenLastCalledWith(["bk-2"]);
  });

  it("reloads at once in development mode, without waiting for the client", async () => {
    const { t } = await running(true);

    await t.emitServerEvent("supervision:changed", change("bk-2"));

    await vi.waitFor(() => expect(t.native.reloadClient).toHaveBeenCalledTimes(1));
  });

  it("does not reload onto a build whose bytes fail verification, and says so to the client", async () => {
    const { t } = await running();
    t.served[route("bk-2")] = "tampered";
    t.served["/_a/bk-2/ios/index.bundle"] = "tampered";

    await t.emitServerEvent("supervision:changed", change("bk-2"));
    const { rejected } = await t.request("updates.restartAtSafePoint");

    expect(rejected?.[3]).toMatch(/integrity/i);
    expect(t.native.reloadClient).not.toHaveBeenCalled();
  });
});

describe("a client that loses its standing", () => {
  it("is torn down with a clear message when the server closes its session as trust-revoked", async () => {
    const build = { buildKey: "bk-1", bundle: "client bundle 1" };
    const t = await setup({
      launches: [await readyOf(build)],
      served: { [route("bk-1")]: build.bundle, "/_a/bk-1/ios/index.bundle": build.bundle },
    });
    await t.runtime.start();
    await t.request("session.openPrincipal", ["s-trust-revoked-1"]);

    t.principalHandlers.onTerminalClose!(new Error("trust-revoked"));

    await vi.waitFor(() => expect(t.native.stopClient).toHaveBeenCalledWith(TAG, "trust-revoked"));
    expect(t.runtime.ui.get().message).toMatch(/removed from your trusted clients/);
    expect(t.runtime.ui.get().running).toEqual([]);
    expect(t.native.showHostSurface).toHaveBeenCalled();
    // The client was told why its session ended before it was torn down.
    const closed = t.native.emit.mock.calls
      .map(([, json]) => JSON.parse(json as string))
      .find((event) => event.type === "session-closed");
    expect(closed).toMatchObject({ reason: "trust-revoked" });
  });

  it("answers requests of a client that is not running with a typed refusal", async () => {
    const t = await setup({ launches: [] });
    await t.runtime.start();
    const { rejected } = await t.request("state.get", ["k"]);
    expect(rejected?.[2]).toBe("CLIENT_STOPPED");
  });
});

describe("forgetting the device", () => {
  it("stops every client and forgets the credential when a client asks to reset", async () => {
    const build = { buildKey: "bk-1", bundle: "client bundle 1" };
    const t = await setup({
      launches: [await readyOf(build)],
      served: { [route("bk-1")]: build.bundle, "/_a/bk-1/ios/index.bundle": build.bundle },
    });
    await t.runtime.start();

    await t.request("device.reset");

    expect(t.native.stopClient).toHaveBeenCalledWith(TAG, "device-reset");
    expect(t.forget).toHaveBeenCalledTimes(1);
    expect(t.connection.close).toHaveBeenCalled();
    expect(t.runtime.ui.get().phase).toBe("needs-pairing");
  });
});
