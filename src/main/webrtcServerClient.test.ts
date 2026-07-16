import { describe, it, expect, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import type {
  ReconnectProgress,
  WebRtcSession,
  WebRtcTransport,
} from "@vibestudio/rpc/transports/webrtcClient";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import { createWebRtcServerClient } from "./webrtcServerClient.js";

const PAIRING = {
  room: "room-1",
  fp: "AA:BB:CC",
  code: "code-1",
  sig: "ws://127.0.0.1:8787",
  ice: "all",
} as ConnectPairing;

type RpcHandler = (target: string, method: string, args: unknown[]) => unknown;

/**
 * A fake WebRtcTransport whose sessions echo RPC requests back through a handler.
 * Each openSession() answers its own send()s, so the main shell session and the
 * scoped app session are independent — exactly the production topology.
 */
function makeFakeTransport(handler: RpcHandler, options: { hangAppReady?: boolean } = {}) {
  // The caller-kind is no longer a client-supplied session option — the server
  // derives it from the redeemed grant. The fake therefore distinguishes the main
  // shell session from each scoped app/panel session by the REAL token each one
  // redeems: the shell authenticates with `getShellToken`, while every app/panel
  // principal redeems its own one-shot connection grant, so its token differs.
  const opened: Array<{
    opts: {
      connectionId?: string;
      getToken?: () => string | Promise<string>;
      onTerminalClose?: (error: Error) => void;
    };
    session: WebRtcSession;
    token?: string;
  }> = [];
  const sessionListeners = new Map<WebRtcSession, Set<(event: RpcEnvelope) => void>>();
  // Token of the first session opened — the main shell principal (createPairedConnection
  // opens it during construction). Any session whose token differs is a scoped grant.
  let shellToken: string | undefined;
  let status: "connected" | "disconnected" = "disconnected";
  const statusListeners = new Set<(status: "connected" | "disconnected") => void>();
  const emitStatus = (next: "connected" | "disconnected"): void => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };
  const candidateTypeListeners = new Set<(type: string | null) => void>();
  const emitCandidateType = (type: string | null): void => {
    for (const listener of candidateTypeListeners) listener(type);
  };
  const reconnectProgressListeners = new Set<(progress: ReconnectProgress) => void>();
  const emitReconnectProgress = (progress: ReconnectProgress): void => {
    for (const listener of reconnectProgressListeners) listener(progress);
  };
  const transport = {
    connect: vi.fn(async () => {
      status = "connected";
    }),
    ready: async () => {},
    status: () => status,
    onStatusChange: (listener: (next: "connected" | "disconnected") => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onReconnectProgress: (listener: (progress: ReconnectProgress) => void) => {
      reconnectProgressListeners.add(listener);
      return () => reconnectProgressListeners.delete(listener);
    },
    candidateType: () => null,
    onCandidateType: (listener: (type: string | null) => void) => {
      candidateTypeListeners.add(listener);
      return () => candidateTypeListeners.delete(listener);
    },
    close: vi.fn(async () => {
      status = "disconnected";
    }),
    openSession: (opts: {
      sid?: string;
      connectionId?: string;
      getToken?: () => string | Promise<string>;
      onTerminalClose?: (error: Error) => void;
    }): WebRtcSession => {
      const listeners = new Set<(e: RpcEnvelope) => void>();
      const entry: {
        opts: typeof opts;
        session: WebRtcSession;
        token?: string;
      } = { opts, session: undefined as unknown as WebRtcSession };
      // Mirror the real openSession: it invokes getToken to redeem the (one-shot)
      // connection grant during the handshake that ready() awaits. Record the
      // resolved token so the suite can tell shell from scoped sessions.
      const authReady = Promise.resolve(opts.getToken?.()).then((token) => {
        entry.token = token as string | undefined;
        if (shellToken === undefined) shellToken = entry.token; // first open = shell
        return token;
      });
      let closed = false;
      const session = {
        sid: opts.sid ?? opts.connectionId ?? "sid",
        callerId: () => "main",
        ready: async () => {
          await authReady;
          // Only a scoped app/panel session (grant token ≠ shell token) hangs here.
          if (options.hangAppReady && entry.token !== shellToken) {
            await new Promise(() => undefined);
          }
        },
        isClosed: () => closed,
        close: vi.fn(() => {
          closed = true;
        }),
        send: async (env: RpcEnvelope) => {
          const message = env.message as {
            type: string;
            requestId: string;
            method: string;
            args: unknown[];
          };
          if (message.type !== "request") return;
          const result = await handler(env.target, message.method, message.args);
          const response: RpcEnvelope = {
            from: "main",
            target: env.from,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: { type: "response", requestId: message.requestId, result } as never,
          };
          queueMicrotask(() => {
            for (const listener of listeners) listener(response);
          });
        },
        onMessage: (cb: (e: RpcEnvelope) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      } as unknown as WebRtcSession;
      entry.session = session;
      sessionListeners.set(session, listeners);
      opened.push(entry);
      return session;
    },
  } as unknown as WebRtcTransport;
  const emitEvent = (session: WebRtcSession, event: string, payload: unknown): void => {
    const envelope: RpcEnvelope = {
      from: "main",
      target: "shell:dev",
      delivery: { caller: { callerId: "main", callerKind: "server" } },
      provenance: [{ callerId: "main", callerKind: "server" }],
      message: { type: "event", fromId: "main", event, payload },
    };
    for (const listener of sessionListeners.get(session) ?? []) listener(envelope);
  };
  return {
    transport,
    opened,
    emitCandidateType,
    emitReconnectProgress,
    emitStatus,
    emitEvent,
  };
}

describe("createWebRtcServerClient", () => {
  it("builds a connected ServerClient that round-trips call() over a shell session", async () => {
    const { transport, opened } = makeFakeTransport((target, method, args) =>
      target === "main" && method === "demo.echo" ? { echoed: args[0] } : null
    );
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "shell-token",
      transport,
    });
    expect(transport.connect).toHaveBeenCalledOnce();
    // The one session opened is the main shell principal — it authenticated with
    // the shell token (getShellToken), not a redeemed connection grant.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.token).toBe("shell-token");
    expect(client.isConnected()).toBe(true);
    expect(client.getConnectionStatus()).toBe("connected");
    await expect(client.call("demo", "echo", ["hi"])).resolves.toEqual({ echoed: "hi" });
  });

  it("delivers events addressed directly to the main authenticated session", async () => {
    const { transport, opened, emitEvent } = makeFakeTransport(() => null);
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "shell-token",
      transport,
    });
    const listener = vi.fn();
    const unsubscribe = client.onDirectEvent("user-notifications-changed", listener);

    emitEvent(opened[0]!.session, "user-notifications-changed", { changedAt: 12 });
    expect(listener).toHaveBeenCalledWith({ changedAt: 12 });

    unsubscribe();
    emitEvent(opened[0]!.session, "user-notifications-changed", { changedAt: 13 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forwards reconnect progress from the transport contract", async () => {
    const { transport, emitReconnectProgress } = makeFakeTransport(() => null);
    const onReconnectProgress = vi.fn();
    await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "shell-token",
      transport,
      onReconnectProgress,
    });

    emitReconnectProgress({
      attempt: 2,
      phase: "connecting",
      reason: "retry",
      layer: "signaling",
    });
    expect(onReconnectProgress).toHaveBeenCalledWith({
      attempt: 2,
      phase: "connecting",
      reason: "retry",
      layer: "signaling",
    });
  });

  it("stays disconnected after the main session terminally closes even if the pipe reports healthy", async () => {
    const { transport, opened, emitCandidateType, emitStatus } = makeFakeTransport(() => null);
    const onConnectionStatusChanged = vi.fn();
    const onMainSessionTerminalClose = vi.fn();
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "shell-token",
      transport,
      onConnectionStatusChanged,
      onMainSessionTerminalClose,
    });

    const terminalError = new Error("device revoked");
    opened[0]!.opts.onTerminalClose?.(terminalError);
    opened[0]!.session.close();
    emitStatus("connected");
    emitCandidateType("relay");

    expect(onMainSessionTerminalClose).toHaveBeenCalledWith(terminalError);
    expect(onConnectionStatusChanged).toHaveBeenLastCalledWith("disconnected");
    expect(client.isConnected()).toBe(false);
    expect(client.getConnectionStatus()).toBe("disconnected");
  });

  it("opens a scoped app session via a one-time connection grant for callAs()", async () => {
    let grants = 0;
    const { transport, opened } = makeFakeTransport((_target, method) => {
      if (method === "auth.grantConnection") {
        grants += 1;
        return { token: "grant-tok" };
      }
      if (method === "svc.ping") return { pong: true };
      return null;
    });
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await expect(
      client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", [])
    ).resolves.toEqual({ pong: true });
    expect(grants).toBe(1);
    // main shell session (shell token) + one scoped app session that redeemed its
    // own connection grant ("grant-tok"), over the same pipe — one per principal.
    expect(opened.map((o) => o.token)).toEqual(["t", "grant-tok"]);

    // Grants are one-shot: if the scoped session dies (lease revoke / pipe drop),
    // the next callAs must RE-GRANT a fresh token, not reuse the consumed one
    // (the bug that left a listen-only app principal dead after any reconnect).
    opened.find((o) => o.token === "grant-tok")!.session.close();
    await expect(
      client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", [])
    ).resolves.toEqual({ pong: true });
    expect(grants).toBe(2);
    // A fresh grant-backed session opened for the re-grant; the shell session and
    // the dropped app entry are untouched — sessions are isolated per principal.
    expect(opened.map((o) => o.token)).toEqual(["t", "grant-tok", "grant-tok"]);
  });

  it("closes the transport when the main session fails to authenticate (no leaked pipe)", async () => {
    // Convergence guard: the wrapper now rides createPairedConnection, whose
    // close-on-ANY-failure covers a mainSession.ready() rejection — the exact
    // seam that previously leaked a connected transport's keepalive/reconnect
    // loop when session auth failed after connect.
    const { transport } = makeFakeTransport(() => null);
    await expect(
      createWebRtcServerClient({
        pairing: PAIRING,
        callerId: "shell:dev",
        getShellToken: () => Promise.reject(new Error("auth boom")),
        transport,
      })
    ).rejects.toThrow("auth boom");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("rejects scoped server RPC for non-app callers", async () => {
    const { transport } = makeFakeTransport(() => null);
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await expect(
      client.callAs({ callerId: "x", callerKind: "shell" }, "s", "m", [])
    ).rejects.toThrow(/not available/);
  });

  it("exposes the pipe's latest candidateType and warns loudly when TURN relay engages (§9.8)", async () => {
    const { transport, emitCandidateType } = makeFakeTransport(() => null);
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    expect(client.candidateType()).toBeNull(); // fake reports null before pipe-up

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitCandidateType("host");
      expect(client.candidateType()).toBe("host");
      expect(warn).not.toHaveBeenCalled(); // P2P path — no alarm

      emitCandidateType("relay");
      expect(client.candidateType()).toBe("relay");
      expect(warn).toHaveBeenCalledWith(
        "[webrtc-client] TURN relay engaged — P2P failed or forced"
      );

      emitCandidateType(null); // pipe down
      expect(client.candidateType()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("close() tears down scoped sessions, the main session, and the transport", async () => {
    const { transport, opened } = makeFakeTransport((_target, method) =>
      method === "auth.grantConnection" ? { token: "g" } : { ok: true }
    );
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", []);
    await client.close();
    expect(transport.close).toHaveBeenCalledOnce();
    for (const { session } of opened) {
      expect(session.close as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    }
  });

  it("close() does not wait forever for an in-flight scoped app session", async () => {
    const { transport } = makeFakeTransport(
      (_target, method) => (method === "auth.grantConnection" ? { token: "g" } : { ok: true }),
      { hangAppReady: true }
    );
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    void client.callAs({ callerId: "app:pending", callerKind: "app" }, "svc", "ping", []);
    await Promise.resolve();
    await client.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
