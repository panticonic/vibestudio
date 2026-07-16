import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type { WebRtcSession, WebRtcSessionOptions, WebRtcTransport } from "./webrtcClient.js";
import {
  createPairedConnection,
  type CreatePairedConnectionOptions,
  type DeviceCredential,
  type PairingContext,
} from "./pairedConnection.js";

// ---------------------------------------------------------------------------
// Fake transport + session (no native module, no signaling)
// ---------------------------------------------------------------------------

interface FakeOpts {
  connectError?: Error;
  readyError?: Error;
  /** Delivered to the session's onPaired on the first open (like a pairing open-result). */
  deviceCredential?: DeviceCredential;
  pairingContext?: PairingContext;
}

interface FakeSession extends WebRtcSession {
  /** Re-fire the session's recovery signal (drives the fan-out under test). */
  fireRecovery(kind: RecoveryKind): void;
  readonly closeSpy: ReturnType<typeof vi.fn>;
}

function makeFakeSession(opts: WebRtcSessionOptions, fake: FakeOpts): FakeSession {
  let closed = false;
  const closeSpy = vi.fn(() => {
    closed = true;
  });
  const session = {
    sid: opts.sid ?? opts.connectionId ?? "sid",
    callerId: () => "shell:test",
    ready: async () => {
      // Mirror the real session: fire recovery + onPaired on the (first) open,
      // then settle — reject when the fake is configured to fail auth.
      opts.onRecovery?.("resubscribe");
      if (fake.deviceCredential) {
        await opts.onPaired?.(fake.deviceCredential, fake.pairingContext);
      }
      if (fake.readyError) throw fake.readyError;
    },
    isClosed: () => closed,
    close: closeSpy,
    closeSpy,
    send: async () => undefined,
    onMessage: () => () => undefined,
    status: () => "connected" as const,
    fireRecovery: (kind: RecoveryKind) => opts.onRecovery?.(kind),
  } as unknown as FakeSession;
  return session;
}

function makeFakeTransport(fake: FakeOpts = {}) {
  let status: "connected" | "disconnected" = "disconnected";
  const opened: FakeSession[] = [];
  const connect = vi.fn(async () => {
    if (fake.connectError) throw fake.connectError;
    status = "connected";
  });
  const close = vi.fn(async () => {
    status = "disconnected";
  });
  const nudge = vi.fn();
  const transport = {
    connect,
    ready: async () => undefined,
    status: () => status,
    onStatusChange: () => () => undefined,
    openSession: (opts: WebRtcSessionOptions): WebRtcSession => {
      const session = makeFakeSession(opts, fake);
      opened.push(session);
      return session;
    },
    candidateType: () => null,
    onCandidateType: () => () => undefined,
    sendBulkFrame: async () => undefined,
    nudge,
    close,
  } as unknown as WebRtcTransport;
  return { transport, opened, connect, close, nudge };
}

function baseOptions(transport: WebRtcTransport): CreatePairedConnectionOptions {
  return {
    pairing: { room: "room-1", fingerprint: "AA:BB:CC" },
    getShellToken: () => "shell-token",
    transport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("createPairedConnection", () => {
  it("resolves with a connected, authenticated main session", async () => {
    const { transport, opened, connect } = makeFakeTransport();
    const paired = await createPairedConnection(baseOptions(transport));
    expect(connect).toHaveBeenCalledOnce();
    expect(paired.transport).toBe(transport);
    expect(paired.mainSession).toBe(opened[0]);
    expect(opened).toHaveLength(1);
    await paired.close();
  });

  it("closes the transport when connect() fails (no leaked reconnect loop)", async () => {
    const { transport, close } = makeFakeTransport({ connectError: new Error("peer unreachable") });
    await expect(createPairedConnection(baseOptions(transport))).rejects.toThrow("peer unreachable");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the transport when mainSession.ready() auth fails — the divergence bug", async () => {
    // The exact seam that leaked before: a CONNECTED transport whose main session
    // never authenticates must be closed, not left running its keepalive loop.
    const { transport, close } = makeFakeTransport({ readyError: new Error("SESSION_AUTH_FAILED") });
    await expect(createPairedConnection(baseOptions(transport))).rejects.toThrow("SESSION_AUTH_FAILED");
    expect(close).toHaveBeenCalledOnce();
  });

  it("close() tears down the main session AND the transport", async () => {
    const { transport, opened, close } = makeFakeTransport();
    const paired = await createPairedConnection(baseOptions(transport));
    await paired.close();
    expect(opened[0]!.closeSpy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("nudge() passes through to the transport", async () => {
    const { transport, nudge } = makeFakeTransport();
    const paired = await createPairedConnection(baseOptions(transport));
    paired.nudge();
    expect(nudge).toHaveBeenCalledOnce();
    await paired.close();
  });

  it("delivers the first-open recovery to the onRecovery option AND later subscribers", async () => {
    const { transport, opened } = makeFakeTransport();
    const optionKinds: RecoveryKind[] = [];
    const paired = await createPairedConnection({
      ...baseOptions(transport),
      onRecovery: (kind) => optionKinds.push(kind),
    });
    // The option was registered before the first open, so it caught it.
    expect(optionKinds).toEqual(["resubscribe"]);

    // A subscription (e.g. createRpcClient's §3.4 seam) added after resolve gets
    // subsequent events; the option keeps getting them too.
    const subKinds: RecoveryKind[] = [];
    const off = paired.onRecovery((kind) => subKinds.push(kind));
    opened[0]!.fireRecovery("cold-recover");
    expect(subKinds).toEqual(["cold-recover"]);
    expect(optionKinds).toEqual(["resubscribe", "cold-recover"]);

    // Unsubscribe stops delivery to that subscriber only.
    off();
    opened[0]!.fireRecovery("resubscribe");
    expect(subKinds).toEqual(["cold-recover"]);
    await paired.close();
  });

  it("awaits onPaired, retries on failure, then succeeds without surfacing an error", async () => {
    vi.useFakeTimers();
    const { transport } = makeFakeTransport({
      deviceCredential: { deviceId: "d1", refreshToken: "r1" },
      pairingContext: { workspaceId: "workspace-1" },
    });
    const onPaired = vi
      .fn<(cred: DeviceCredential, context?: PairingContext) => Promise<void>>()
      .mockRejectedValueOnce(new Error("keychain busy"))
      .mockResolvedValueOnce(undefined);
    const onPersistError = vi.fn();
    const pairedPromise = createPairedConnection({
      ...baseOptions(transport),
      onPaired,
      onPersistError,
    });
    // Attempt 1 fired synchronously during ready().
    await vi.advanceTimersByTimeAsync(0);
    expect(onPaired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250); // backoff → attempt 2 (succeeds)
    const paired = await pairedPromise;
    expect(onPaired).toHaveBeenCalledTimes(2);
    expect(onPaired).toHaveBeenNthCalledWith(
      1,
      { deviceId: "d1", refreshToken: "r1" },
      { workspaceId: "workspace-1" }
    );
    expect(onPaired).toHaveBeenNthCalledWith(
      2,
      { deviceId: "d1", refreshToken: "r1" },
      { workspaceId: "workspace-1" }
    );
    expect(onPersistError).not.toHaveBeenCalled();
    await paired.close();
  });

  it("surfaces a persistent onPaired failure via onPersistError after 3 attempts — never a void'd rejection", async () => {
    vi.useFakeTimers();
    const { transport } = makeFakeTransport({
      deviceCredential: { deviceId: "d2", refreshToken: "r2" },
    });
    const onPaired = vi.fn().mockRejectedValue(new Error("keychain locked"));
    const onPersistError = vi.fn();
    const pairedPromise = createPairedConnection({
      ...baseOptions(transport),
      onPaired,
      onPersistError,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onPaired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250); // → attempt 2
    expect(onPaired).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500); // → attempt 3
    expect(onPaired).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0); // let the final rejection settle
    const paired = await pairedPromise;
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(onPersistError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onPersistError.mock.calls[0]![0] as Error).message).toBe("keychain locked");
    await paired.close();
  });

  it("throws when neither a transport nor a provider is supplied", async () => {
    await expect(
      createPairedConnection({
        pairing: { room: "r", fingerprint: "AA" },
        getShellToken: () => "t",
        sig: "wss://sig.example/",
      }),
    ).rejects.toThrow(/provider/);
  });
});
