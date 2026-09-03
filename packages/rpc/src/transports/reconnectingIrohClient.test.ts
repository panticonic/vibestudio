import { describe, expect, it, vi } from "vitest";
import type { RpcConnectionStatus, RpcEnvelope } from "../types.js";
import type { IrohClientPipe, IrohClientSession, IrohClientSessionOptions } from "./irohClient.js";
import { createReconnectingIrohClientPipe } from "./reconnectingIrohClient.js";

const eventEnvelope: RpcEnvelope = {
  from: "main",
  target: "shell:device",
  delivery: { caller: { callerId: "main", callerKind: "shell" } },
  provenance: [],
  message: { type: "event", fromId: "main", event: "changed", payload: 1 },
};

class FakeSession implements IrohClientSession {
  readonly sent: RpcEnvelope[] = [];
  private readonly messages = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statuses = new Set<(status: RpcConnectionStatus) => void>();

  constructor(readonly options: IrohClientSessionOptions) {}

  callerId(): string | null {
    return "shell:device";
  }
  isClosed(): boolean {
    return false;
  }
  status(): RpcConnectionStatus {
    return "connected";
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  send(envelope: RpcEnvelope): Promise<void> {
    this.sent.push(envelope);
    return Promise.resolve();
  }
  onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statuses.add(handler);
    return () => this.statuses.delete(handler);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  emit(envelope: RpcEnvelope): void {
    for (const handler of this.messages) handler(envelope);
  }
  terminate(message = "credential revoked"): void {
    this.options.onTerminalClose?.(new Error(message));
  }
}

class FakePipe implements IrohClientPipe {
  readonly peerEndpointId = "server-endpoint";
  readonly sessions: FakeSession[] = [];
  private currentStatus: RpcConnectionStatus = "connected";
  private readonly statuses = new Set<(status: RpcConnectionStatus) => void>();
  private readonly diagnosticListeners = new Set<
    (diagnostics: ReturnType<FakePipe["diagnostics"]>) => void
  >();

  constructor(private readonly endpointGeneration: number | null = null) {}

  ready(): Promise<void> {
    return Promise.resolve();
  }
  status(): RpcConnectionStatus {
    return this.currentStatus;
  }
  diagnostics() {
    return this.endpointGeneration === null
      ? null
      : { paths: [], endpointGeneration: this.endpointGeneration };
  }
  onDiagnosticsChange(
    handler: (diagnostics: ReturnType<FakePipe["diagnostics"]>) => void
  ): () => void {
    this.diagnosticListeners.add(handler);
    handler(this.diagnostics());
    return () => this.diagnosticListeners.delete(handler);
  }
  openSession(options: IrohClientSessionOptions): IrohClientSession {
    const session = new FakeSession(options);
    this.sessions.push(session);
    return session;
  }
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statuses.add(handler);
    return () => this.statuses.delete(handler);
  }
  close(): Promise<void> {
    this.currentStatus = "disconnected";
    return Promise.resolve();
  }
  disconnect(): void {
    this.currentStatus = "disconnected";
    for (const handler of this.statuses) handler("disconnected");
  }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  assertion();
}

describe("reconnecting Iroh client", () => {
  it("opens on runtimes such as Hermes that do not implement crypto.randomUUID", async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    });
    try {
      const pipe = new FakePipe();
      const owner = createReconnectingIrohClientPipe({
        peerEndpointId: pipe.peerEndpointId,
        dial: vi.fn().mockResolvedValue(pipe),
        closeEndpoint: vi.fn().mockResolvedValue(undefined),
      });

      const session = owner.openSession({ connectionId: "hermes", getToken: () => "credential" });
      await expect(session.ready?.()).resolves.toBeUndefined();
      await owner.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves an arbitrarily long routing ID without exposing it as session identity", async () => {
    const first = new FakePipe();
    const second = new FakePipe();
    const dial = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial,
      closeEndpoint: vi.fn().mockResolvedValue(undefined),
      minRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0,
    });
    const connectionId = `default-cdp-${"nested-panel/".repeat(32)}`;
    const session = owner.openSession({ connectionId, getToken: () => "credential" });

    await session.ready?.();
    expect(first.sessions[0]?.options.connectionId).toBe(connectionId);
    expect(first.sessions[0]?.options).not.toHaveProperty("sid");

    first.disconnect();
    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(second.sessions[0]?.options.connectionId).toBe(connectionId);
    expect(second.sessions[0]?.options).not.toHaveProperty("sid");
    await owner.close();
  });

  it("redials proactively and reopens every desired logical session", async () => {
    const first = new FakePipe();
    const second = new FakePipe();
    const dial = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const closeEndpoint = vi.fn().mockResolvedValue(undefined);
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial,
      closeEndpoint,
      minRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0,
    });
    const session = owner.openSession({ getToken: () => "credential" });
    const reconnect = vi.fn();
    owner.onReconnectProgress(reconnect);
    const received: RpcEnvelope[] = [];
    session.onMessage((envelope) => received.push(envelope));

    await session.ready?.();
    expect(first.sessions).toHaveLength(1);
    first.sessions[0]?.emit(eventEnvelope);
    expect(received).toEqual([eventEnvelope]);

    first.disconnect();
    await eventually(() => expect(dial).toHaveBeenCalledTimes(2));
    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(reconnect).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, phase: "scheduled", nextRetryInMs: 0 })
    );
    expect(second.sessions).toHaveLength(1);
    second.sessions[0]?.emit(eventEnvelope);
    expect(received).toEqual([eventEnvelope, eventEnvelope]);

    await owner.close();
    expect(closeEndpoint).toHaveBeenCalledOnce();
  });

  it("invalidates a matching process endpoint generation before its pipe closes independently", async () => {
    const first = new FakePipe(7);
    const second = new FakePipe(8);
    const dial = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial,
      closeEndpoint: vi.fn().mockResolvedValue(undefined),
      minRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0,
    });
    const session = owner.openSession({ getToken: () => "credential" });
    const progress = vi.fn();
    owner.onReconnectProgress(progress);
    await session.ready?.();

    owner.invalidateEndpointGeneration(6, "stale generation");
    expect(dial).toHaveBeenCalledOnce();

    owner.invalidateEndpointGeneration(7, "process endpoint replaced");
    await eventually(() => expect(dial).toHaveBeenCalledTimes(2));
    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        phase: "scheduled",
        reason: "process endpoint replaced",
        nextRetryInMs: 0,
      })
    );
    expect(second.sessions).toHaveLength(1);
    await owner.close();
  });

  it("fails work attempted during an outage immediately and resumes the same session", async () => {
    const first = new FakePipe();
    const second = new FakePipe();
    let resolveRedial!: (pipe: IrohClientPipe) => void;
    const redial = new Promise<IrohClientPipe>((resolve) => {
      resolveRedial = resolve;
    });
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(redial),
      closeEndpoint: vi.fn().mockResolvedValue(undefined),
      minRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0,
    });
    const session = owner.openSession({ getToken: () => "credential" });
    await session.ready?.();

    first.disconnect();
    await eventually(() => expect(owner.status()).toBe("connecting"));
    const attempted = session.send(eventEnvelope).catch((error: unknown) => error);
    const error = await attempted;
    expect(error).toMatchObject({
      message: "Workspace server is temporarily unavailable",
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });

    resolveRedial(second);
    await eventually(() => expect(second.sessions).toHaveLength(1));
    await session.send(eventEnvelope);
    expect(second.sessions[0]?.sent).toEqual([eventEnvelope]);
    await owner.close();
  });

  it("does not reopen a logical session after a terminal authentication close", async () => {
    const first = new FakePipe();
    const second = new FakePipe();
    const terminal = vi.fn();
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      closeEndpoint: vi.fn().mockResolvedValue(undefined),
      minRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0,
    });
    const revoked = owner.openSession({
      getToken: () => "revoked",
      onTerminalClose: terminal,
    });
    const live = owner.openSession({ getToken: () => "live" });
    await Promise.all([revoked.ready?.(), live.ready?.()]);
    first.sessions[0]?.terminate();
    first.disconnect();

    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(await second.sessions[0]?.options.getToken()).toBe("live");
    await expect(revoked.ready?.()).rejects.toThrow("terminal");
    expect(terminal).toHaveBeenCalledOnce();
    await owner.close();
  });

  it("shuts down on suspend and restores the same desired sessions on resume", async () => {
    const first = new FakePipe();
    const second = new FakePipe();
    const suspendEndpoint = vi.fn().mockResolvedValue(undefined);
    const owner = createReconnectingIrohClientPipe({
      peerEndpointId: first.peerEndpointId,
      dial: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      closeEndpoint: vi.fn().mockResolvedValue(undefined),
      suspendEndpoint,
    });
    const session = owner.openSession({ getToken: () => "credential" });
    await session.ready?.();

    await owner.suspend();
    expect(suspendEndpoint).toHaveBeenCalledOnce();
    expect(owner.status()).toBe("disconnected");
    await owner.resume();
    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(owner.peerEndpointId).toBe("server-endpoint");
    await owner.close();
  });
});
