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
  readonly sid: string;
  readonly sent: RpcEnvelope[] = [];
  private readonly messages = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statuses = new Set<(status: RpcConnectionStatus) => void>();

  constructor(readonly options: IrohClientSessionOptions) {
    this.sid = options.sid ?? "missing-sid";
  }

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

  ready(): Promise<void> {
    return Promise.resolve();
  }
  status(): RpcConnectionStatus {
    return this.currentStatus;
  }
  diagnostics(): null {
    return null;
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
  it("redials proactively and reopens every desired logical session with the same sid", async () => {
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
    const session = owner.openSession({ sid: "workspace:alpha", getToken: () => "credential" });
    const reconnect = vi.fn();
    owner.onReconnectProgress(reconnect);
    const received: RpcEnvelope[] = [];
    session.onMessage((envelope) => received.push(envelope));

    await session.ready?.();
    expect(first.sessions.map((candidate) => candidate.sid)).toEqual(["workspace:alpha"]);
    first.sessions[0]?.emit(eventEnvelope);
    expect(received).toEqual([eventEnvelope]);

    first.disconnect();
    await eventually(() => expect(dial).toHaveBeenCalledTimes(2));
    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(reconnect).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, phase: "scheduled", nextRetryInMs: 0 })
    );
    expect(second.sessions[0]?.sid).toBe("workspace:alpha");
    second.sessions[0]?.emit(eventEnvelope);
    expect(received).toEqual([eventEnvelope, eventEnvelope]);

    await owner.close();
    expect(closeEndpoint).toHaveBeenCalledOnce();
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
      sid: "shell",
      getToken: () => "revoked",
      onTerminalClose: terminal,
    });
    const live = owner.openSession({ sid: "workspace", getToken: () => "live" });
    await Promise.all([revoked.ready?.(), live.ready?.()]);
    first.sessions.find((session) => session.sid === "shell")?.terminate();
    first.disconnect();

    await eventually(() => expect(second.sessions).toHaveLength(1));
    expect(second.sessions[0]?.sid).toBe("workspace");
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
    const session = owner.openSession({ sid: "mobile", getToken: () => "credential" });
    await session.ready?.();

    await owner.suspend();
    expect(suspendEndpoint).toHaveBeenCalledOnce();
    expect(owner.status()).toBe("disconnected");
    await owner.resume();
    await eventually(() =>
      expect(second.sessions.map((candidate) => candidate.sid)).toEqual(["mobile"])
    );
    expect(owner.peerEndpointId).toBe("server-endpoint");
    await owner.close();
  });
});
