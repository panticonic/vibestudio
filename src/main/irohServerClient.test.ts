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
import { describe, expect, it } from "vitest";
import { createIrohServerClient } from "./irohServerClient.js";

const reach: IrohReach = {
  endpointId: "ab".repeat(32),
  relays: ["https://relay.example/"],
  v: IROH_REACH_VERSION,
};

class FakeSession implements IrohClientSession {
  readonly sid = "shell";

  constructor(private readonly closeOrder: string[]) {}

  callerId(): string {
    return "shell:device";
  }

  isClosed(): boolean {
    return false;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  status(): RpcConnectionStatus {
    return "connected";
  }

  send(_envelope: RpcEnvelope): Promise<void> {
    return Promise.resolve();
  }

  onMessage(_handler: (envelope: RpcEnvelope) => void): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
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
  it("publishes complete transport diagnostics and closes sessions before the pipe", async () => {
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
    expect(closeOrder).toEqual(["session", "pipe"]);
  });
});
