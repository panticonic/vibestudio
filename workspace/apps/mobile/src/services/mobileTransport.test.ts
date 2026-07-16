import type { RpcClient, RpcConnectionStatus, RpcEventContext } from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { ReconnectProgress, WebRtcSession } from "@vibestudio/rpc/transports/webrtcClient";
import {
  loadShellCredential,
  MobileConnectionAggregateError,
  reconnectMobileSession,
  type StoredShellCredential,
  type WebRtcConnection,
} from "@vibestudio/mobile-webrtc";
import { MobileRpcClient } from "./mobileTransport";

jest.mock("@vibestudio/mobile-webrtc", () => ({
  loadShellCredential: jest.fn(),
  MobileConnectionAggregateError: class MobileConnectionAggregateError extends Error {
    errors: readonly unknown[];
    constructor(errors: readonly unknown[], message: string) {
      super(message);
      this.errors = errors;
    }
  },
  reconnectMobileSession: jest.fn(),
}));

const mockLoadShellCredential = loadShellCredential as jest.MockedFunction<
  typeof loadShellCredential
>;
const mockReconnectMobileSession = reconnectMobileSession as jest.MockedFunction<
  typeof reconnectMobileSession
>;
const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);

const storedCredential: StoredShellCredential = {
  schemaVersion: 3,
  deviceId: DEVICE_ID,
  refreshToken: REFRESH_TOKEN,
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "ws://127.0.0.1:8798",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-123",
    fp: "AA".repeat(32),
    sig: "ws://127.0.0.1:8798",
    v: 2,
    ice: "all",
  },
  pairedAt: 123,
};

function makeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    selfId: `shell:${DEVICE_ID}`,
    call: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ...overrides,
  } as unknown as RpcClient;
}

function makeSession(overrides: Partial<WebRtcSession> = {}): WebRtcSession {
  return {
    sid: "shell-session",
    callerId: jest.fn(() => `shell:${DEVICE_ID}`),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send: jest.fn(),
    status: jest.fn(() => "connected" as RpcConnectionStatus),
    onStatusChange: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ready: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as WebRtcSession;
}

function makeConnection(overrides: Partial<WebRtcConnection> = {}): WebRtcConnection {
  const session = overrides.session ?? makeSession();
  return {
    callerId: `shell:${DEVICE_ID}`,
    deviceId: DEVICE_ID,
    rpc: overrides.rpc ?? makeRpc(),
    hubControlRpc: overrides.hubControlRpc ?? makeRpc(),
    session,
    transport:
      overrides.transport ??
      ({
        openSession: jest.fn(),
      } as unknown as WebRtcConnection["transport"]),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe("MobileRpcClient WebRTC transport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadShellCredential.mockResolvedValue(storedCredential);
  });

  it("loads the stored WebRTC credential, reconnects, and delegates RPC calls", async () => {
    const rpc = makeRpc({
      call: jest.fn(async () => ({ ok: true })),
    });
    const connection = makeConnection({ rpc });
    mockReconnectMobileSession.mockResolvedValue(connection);
    const client = new MobileRpcClient({});

    await client.connectAndWait();

    expect(mockLoadShellCredential).toHaveBeenCalledTimes(1);
    expect(mockReconnectMobileSession).toHaveBeenCalledWith(storedCredential, expect.any(Function));
    expect(client.selfId).toBe(`shell:${DEVICE_ID}`);
    expect(client.status).toBe("connected");
    await expect(client.call("main", "demo.hello", ["world"])).resolves.toEqual({ ok: true });
    expect(rpc.call).toHaveBeenCalledWith("main", "demo.hello", ["world"], undefined);
  });

  it("routes only hubControl calls over the retained stable hub pipe", async () => {
    const workspaceCall = jest.fn(async () => ({ workspace: true }));
    const hubCall = jest.fn(async () => ({ hub: true }));
    mockReconnectMobileSession.mockResolvedValue(
      makeConnection({
        rpc: makeRpc({ call: workspaceCall }),
        hubControlRpc: makeRpc({ call: hubCall }),
      })
    );
    const client = new MobileRpcClient({});

    await client.connectAndWait();

    await expect(client.call("main", "workspace.getInfo", [])).resolves.toEqual({
      workspace: true,
    });
    await expect(client.call("main", "hubControl.listWorkspaces", [])).resolves.toEqual({
      hub: true,
    });
    expect(workspaceCall).toHaveBeenCalledWith("main", "workspace.getInfo", [], undefined);
    expect(hubCall).toHaveBeenCalledWith("main", "hubControl.listWorkspaces", [], undefined);
  });

  it("retries transient initial WebRTC reconnect failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const connection = makeConnection();
    mockReconnectMobileSession
      .mockRejectedValueOnce(new Error("signaling warming up"))
      .mockResolvedValueOnce(connection);
    const client = new MobileRpcClient({
      initialConnectionRetry: { maxMs: 1_000, delayMs: 1, maxDelayMs: 1 },
    });

    try {
      await expect(client.connectAndWait()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockReconnectMobileSession).toHaveBeenCalledTimes(2);
    expect(client.status).toBe("connected");
  });

  it("forwards transport reconnect progress when that optional hook is available", async () => {
    let emitProgress: ((progress: ReconnectProgress) => void) | undefined;
    const transport = {
      openSession: jest.fn(),
      onReconnectProgress: jest.fn((listener) => {
        emitProgress = listener;
        return jest.fn();
      }),
    } as unknown as WebRtcConnection["transport"];
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ transport }));
    const client = new MobileRpcClient({});
    const listener = jest.fn();
    client.onReconnectProgress(listener);

    await client.connectAndWait();
    emitProgress?.({ attempt: 3, phase: "scheduled", reason: "network unavailable", layer: null });

    expect(listener).toHaveBeenCalledWith({
      attempt: 3,
      phase: "scheduled",
      reason: "network unavailable",
      layer: null,
    });
  });

  it("dispatches server events to subscribed local listeners and unsubscribes cleanly", async () => {
    const eventCallbacks = new Map<string, (event: RpcEventContext) => void>();
    const activeUnsub = jest.fn();
    const rpc = makeRpc({
      on: jest.fn((event: string, callback: (event: RpcEventContext) => void) => {
        eventCallbacks.set(event, callback);
        return activeUnsub;
      }),
    });
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ rpc }));
    const client = new MobileRpcClient({});
    const listener = jest.fn();

    const unsubscribe = client.on("shell-approval:pending-changed", listener);
    await client.connectAndWait();
    eventCallbacks.get("shell-approval:pending-changed")!({
      payload: { pending: ["approval-1"] },
    } as RpcEventContext);

    expect(listener).toHaveBeenCalledWith({ payload: { pending: ["approval-1"] } });
    unsubscribe();
    expect(activeUnsub).toHaveBeenCalledTimes(1);
  });

  it("opens panel sessions over the existing pipe with fresh grant tokens", async () => {
    let openedOptions: Parameters<WebRtcConnection["transport"]["openSession"]>[0] | null = null;
    let tokenSeenByReady = "";
    const rpc = makeRpc({
      call: jest.fn(async () => ({ token: "panel-grant-123" })),
    });
    const panelSession = makeSession({
      ready: jest.fn(async () => {
        tokenSeenByReady = await openedOptions!.getToken();
      }),
    });
    const transport = {
      openSession: jest.fn((options) => {
        openedOptions = options;
        return panelSession;
      }),
    } as unknown as WebRtcConnection["transport"];
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ rpc, transport }));
    const client = new MobileRpcClient({});

    await expect(client.openPanelSession("panel:runtime-1", "panel-conn-1")).resolves.toBe(
      panelSession
    );

    expect(transport.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "panel-conn-1",
        clientPlatform: "mobile",
      })
    );
    expect(rpc.call).toHaveBeenCalledWith("main", "auth.grantConnection", ["panel:runtime-1"]);
    expect(tokenSeenByReady).toBe("panel-grant-123");
  });

  it("closes the pipe (no leak) when disconnect() races an in-flight connect", async () => {
    // Handshake that only resolves when we let it — models a disconnect landing
    // mid-connect (background / dispose-during-connect).
    let resolveConnect!: (connection: WebRtcConnection) => void;
    const connection = makeConnection();
    mockReconnectMobileSession.mockImplementation(
      () => new Promise<WebRtcConnection>((resolve) => (resolveConnect = resolve))
    );
    const client = new MobileRpcClient({});

    client.connect(); // fire-and-forget; handshake now pending
    // Let establishConnection() await loadShellCredential and reach the
    // (still-pending) reconnectMobileSession handshake.
    await new Promise((r) => setTimeout(r, 0));
    client.disconnect(); // teardown lands before the handshake resolves
    resolveConnect(connection);
    await new Promise((r) => setTimeout(r, 0)); // let the pending handshake settle

    // The produced pipe is closed (keepalive gone), not adopted as "connected".
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(client.status).not.toBe("connected");
  });

  it("surfaces composed teardown failures through reconnect progress", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = makeConnection({
      close: jest.fn(async () => {
        throw new MobileConnectionAggregateError(
          [new Error("workspace close"), new Error("hub close")],
          "connections failed to close"
        );
      }),
    });
    mockReconnectMobileSession.mockResolvedValue(connection);
    const client = new MobileRpcClient({});
    const progress = jest.fn();
    client.onReconnectProgress(progress);

    try {
      await client.connectAndWait();
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errorSpy.mockRestore();
    }

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 0,
        phase: "failed",
        reason: expect.stringContaining("Disconnect teardown failed"),
      })
    );
    expect(client.status).toBe("disconnected");
  });

  it("forwards WebRTC recovery notifications to registered listeners", async () => {
    let emitRecovery: ((kind: RecoveryKind) => void | Promise<void>) | undefined;
    mockReconnectMobileSession.mockImplementation(async (_stored, onRecovery) => {
      emitRecovery = onRecovery;
      return makeConnection();
    });
    const client = new MobileRpcClient({});
    const coldRecover = jest.fn();
    const resubscribe = jest.fn();
    client.onRecovery("cold-recover", coldRecover);
    client.onRecovery("resubscribe", resubscribe);

    await client.connectAndWait();
    await emitRecovery?.("cold-recover");
    await emitRecovery?.("resubscribe");

    expect(coldRecover).toHaveBeenCalledTimes(1);
    expect(resubscribe).toHaveBeenCalledTimes(1);
  });
});
