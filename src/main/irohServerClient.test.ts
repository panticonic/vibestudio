import {
  IROH_REACH_VERSION,
  type IrohConnectionDiagnostics,
  type IrohReach,
} from "@vibestudio/iroh-transport";
import type {
  IrohClientPipe,
  IrohClientSession,
  IrohClientSessionOptions,
} from "@vibestudio/rpc/transports/irohClient";
import type { RpcConnectionStatus, RpcEnvelope } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import { createIrohServerClient } from "./irohServerClient.js";

const reach: IrohReach = {
  endpointId: "ab".repeat(32),
  relays: ["https://relay.example/"],
  v: IROH_REACH_VERSION,
};

class FakeSession implements IrohClientSession {
  closed = false;
  constructor(private readonly closeOrder: string[]) {}

  callerId(): string {
    return "shell:device";
  }

  isClosed(): boolean {
    return this.closed;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  status(): RpcConnectionStatus {
    return "connected";
  }

  onStatusChange(_handler: (status: RpcConnectionStatus) => void): () => void {
    return () => undefined;
  }

  send(_envelope: RpcEnvelope): Promise<void> {
    return Promise.resolve();
  }

  onMessage(_handler: (envelope: RpcEnvelope) => void): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    this.closeOrder.push("session");
    return Promise.resolve();
  }
}

class FakePipe implements IrohClientPipe {
  readonly peerEndpointId = reach.endpointId;
  private readonly session: FakeSession;
  private readonly diagnosticsListeners = new Set<
    (diagnostics: IrohConnectionDiagnostics | null) => void
  >();

  constructor(private readonly closeOrder: string[]) {
    this.session = new FakeSession(closeOrder);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  openSession(_options: IrohClientSessionOptions): IrohClientSession {
    return this.session;
  }

  status(): RpcConnectionStatus {
    return "connected";
  }

  onStatusChange(_handler: (status: RpcConnectionStatus) => void): () => void {
    return () => undefined;
  }

  diagnostics(): IrohConnectionDiagnostics {
    return {
      endpointGeneration: 4,
      dialAttempts: 2,
      dialRelayUrl: reach.relays[0],
      transmittedBytes: 101,
      receivedBytes: 202,
      lostBytes: 3,
      logicalSessions: 1,
      activeRequests: 5,
      paths: [
        {
          selected: true,
          kind: "relay",
          remoteAddress: "relay.example:443",
          rttMs: 17,
        },
      ],
    };
  }

  onDiagnosticsChange(
    handler: (diagnostics: IrohConnectionDiagnostics | null) => void
  ): () => void {
    this.diagnosticsListeners.add(handler);
    handler(this.diagnostics());
    return () => this.diagnosticsListeners.delete(handler);
  }

  close(): Promise<void> {
    this.closeOrder.push("pipe");
    return Promise.resolve();
  }
}

describe("Iroh server client lifecycle", () => {
  it("joins native retirement before wrapper closure can write another session control frame", async () => {
    const pipe = new FakePipe([]);
    const session = new FakeSession([]);
    let release!: () => void;
    const retiring = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gone = false;
    vi.spyOn(pipe, "openSession").mockReturnValue(session);
    vi.spyOn(pipe, "close").mockImplementation(async () => {
      await retiring;
      gone = true;
    });
    const closeSession = vi.spyOn(session, "close").mockImplementation(async () => {
      if (!gone) throw new Error("Session control write raced its physical owner's closure");
    });
    const client = await createIrohServerClient({
      reach,
      callerId: "shell:device",
      getShellToken: () => "token",
      pipe,
    });
    const closing = client.close();
    void closing.catch(() => undefined);
    try {
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(closeSession).not.toHaveBeenCalled();
    } finally {
      release();
      await closing;
    }
    expect(closeSession).toHaveBeenCalledOnce();
  });
  it("retires the pipe before joining session I/O and retains cleanup failures", async () => {
    const pipe = new FakePipe([]);
    let release!: () => void;
    const physicalClosed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new FakeSession([]);
    const originalFailure = new Error("Original session retirement failure");
    vi.spyOn(session, "close").mockImplementation(async () => {
      await physicalClosed;
      throw originalFailure;
    });
    vi.spyOn(pipe, "openSession").mockReturnValue(session);
    const closePipe = vi.spyOn(pipe, "close").mockImplementation(async () => {
      release();
    });
    const client = await createIrohServerClient({
      reach,
      callerId: "shell:device",
      getShellToken: () => "token",
      pipe,
    });
    const closing = client.close();
    void closing.catch(() => undefined);
    try {
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(closePipe).toHaveBeenCalledOnce();
      await expect(closing).rejects.toMatchObject({ errors: [originalFailure] });
      expect(client.close()).toBe(closing);
    } finally {
      release();
      await closing.catch(() => undefined);
    }
  });
  it("publishes complete transport diagnostics and retires pipe I/O before joining sessions", async () => {
    const closeOrder: string[] = [];
    const observed: unknown[] = [];
    const client = await createIrohServerClient({
      reach,
      callerId: "shell:device",
      getShellToken: () => "token",
      pipe: new FakePipe(closeOrder),
      onTransportDiagnosticsChanged: (diagnostics) => observed.push(diagnostics),
    });

    const expected = {
      path: "relay",
      rttMs: 17,
      remoteAddress: "relay.example:443",
      relayUrl: "https://relay.example/",
      endpointGeneration: 4,
      dialAttempts: 2,
      transmittedBytes: 101,
      receivedBytes: 202,
      lostBytes: 3,
      logicalSessions: 1,
      activeRequests: 5,
    };
    expect(observed).toEqual([expected]);
    expect(client.transportDiagnostics()).toEqual(expected);

    await client.close();
    expect(closeOrder).toEqual(["pipe", "session"]);
    expect(client.isClosed()).toBe(true);
  });
});

describe("Iroh trusted workspace UI transport", () => {
  it("opens a separate device-authenticated session and joins it during pipe retirement", async () => {
    const closeOrder: string[] = [];
    const pipe = new FakePipe(closeOrder);
    const options: IrohClientSessionOptions[] = [];
    const sessions: FakeSession[] = [];
    vi.spyOn(pipe, "openSession").mockImplementation((entry) => {
      options.push(entry);
      const session = new FakeSession(closeOrder);
      sessions.push(session);
      return session;
    });
    const client = await createIrohServerClient({
      reach,
      callerId: "shell:device",
      getShellToken: () => "user-device-token",
      pipe,
    });
    const ui = await client.openHostUiSession();
    expect(options).toHaveLength(2);
    expect(await options[1]!.getToken()).toBe("user-device-token");
    expect(options[1]!.connectionId).not.toBe(options[0]!.connectionId);
    const send = vi.spyOn(sessions[1]!, "send");
    const envelope: RpcEnvelope = {
      from: "ui",
      target: "runtime-entity",
      delivery: { caller: { callerId: "ui", callerKind: "shell" } },
      provenance: [],
      message: { type: "event", fromId: "ui", event: "channel:send", payload: { text: "hello" } },
    };
    await ui.send(envelope);
    expect(send).toHaveBeenCalledWith(envelope);
    await client.close();
    expect(ui.isClosed?.()).toBe(true);
    expect(closeOrder).toEqual(["pipe", "session", "session"]);
    await expect(client.openHostUiSession()).rejects.toThrow("closing");
  });
});
