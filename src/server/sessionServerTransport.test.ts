import { describe, it, expect } from "vitest";
import { createRpcClient, envelopeFromMessage, type RpcEnvelope } from "@vibestudio/rpc";
import type { RpcSessionChannel } from "./rpcServer/sessionChannel.js";
import {
  createSessionServerTransport,
  CONNECTION_LOST_CODE,
  type SessionServerTransportInternal,
} from "./sessionServerTransport.js";

/** Minimal fake of the `ws` WebSocket the transport needs. */
class FakeWs {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  readonly bufferedAmount = 0;
  readonly transportBinding = { kind: "local" } as const;
  sent: string[] = [];
  private closeHandlers = new Set<() => void>();

  send(data: string): void {
    this.sent.push(data);
  }

  sendMessage(message: Parameters<RpcSessionChannel["sendMessage"]>[0]): void {
    this.send(JSON.stringify(message));
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  on(event: string, handler: () => void): this {
    if (event === "close") this.closeHandlers.add(handler);
    return this;
  }

  off(event: string, handler: () => void): this {
    if (event === "close") this.closeHandlers.delete(handler);
    return this;
  }

  close(): void {
    this.emitClose();
  }

  terminate(): void {
    this.emitClose();
  }

  emitClose(): void {
    this.readyState = 3;
    for (const handler of this.closeHandlers) handler();
  }
}

/** Wrap the server transport in an RpcClient bridge, as RpcServer does. */
function makeBridge(transport: SessionServerTransportInternal) {
  return createRpcClient({
    selfId: "server",
    callerKind: "server",
    transport: {
      async send(envelope) {
        await transport.sendEnvelope(envelope);
      },
      onMessage(handler) {
        return transport.onAnyMessage((sourceId, message, callerKind) => {
          handler(
            envelopeFromMessage({
              selfId: "server",
              from: sourceId,
              target: "server",
              message,
              callerKind: callerKind ?? "unknown",
            }) as RpcEnvelope
          );
        });
      },
    },
  });
}

describe("createSessionServerTransport", () => {
  it("rejects an in-flight bridge.call when the WebSocket closes", async () => {
    const ws = new FakeWs();
    const transport = createSessionServerTransport({
      ws: ws as unknown as RpcSessionChannel,
      clientId: "panel:1:conn-a",
    });
    const bridge = makeBridge(transport);

    const call = bridge.call("panel:1", "slowMethod", []);
    // The request must have been sent over the socket before we close it.
    expect(ws.sent.length).toBe(1);

    ws.emitClose();

    await expect(call).rejects.toMatchObject({ code: CONNECTION_LOST_CODE });
  });

  it("rejects in-flight calls when close() is invoked directly (removeBridge path)", async () => {
    const ws = new FakeWs();
    const transport = createSessionServerTransport({
      ws: ws as unknown as RpcSessionChannel,
      clientId: "panel:2:conn-b",
    });
    const bridge = makeBridge(transport);

    const call = bridge.call("panel:2", "slowMethod", []);
    transport.close();

    await expect(call).rejects.toMatchObject({ code: CONNECTION_LOST_CODE });
  });

  it("throws CONNECTION_LOST when sending after the socket is closed", async () => {
    const ws = new FakeWs();
    const transport = createSessionServerTransport({
      ws: ws as unknown as RpcSessionChannel,
      clientId: "panel:3:conn-c",
    });
    const bridge = makeBridge(transport);
    ws.emitClose();

    await expect(bridge.call("panel:3", "anything", [])).rejects.toMatchObject({
      code: CONNECTION_LOST_CODE,
    });
  });

  it("does not double-settle a call that already got a real response", async () => {
    const ws = new FakeWs();
    const transport = createSessionServerTransport({
      ws: ws as unknown as RpcSessionChannel,
      clientId: "panel:4:conn-d",
    });
    const bridge = makeBridge(transport);

    const call = bridge.call<number>("panel:4", "echo", [7]);
    // Pull the requestId out of the sent frame and deliver a genuine response.
    const frame = JSON.parse(ws.sent[0] ?? "{}") as {
      envelope: RpcEnvelope;
    };
    expect(frame).not.toHaveProperty("message");
    transport.deliver("panel:4", {
      type: "response",
      requestId: frame.envelope.message.type === "request" ? frame.envelope.message.requestId : "",
      result: 7,
    });
    await expect(call).resolves.toBe(7);

    // Closing afterwards must not throw / re-settle anything.
    expect(() => ws.emitClose()).not.toThrow();
  });

  it("includes delivery metadata when the bridge sends a call envelope", async () => {
    const ws = new FakeWs();
    const transport = createSessionServerTransport({
      ws: ws as unknown as RpcSessionChannel,
      clientId: "panel:5:conn-e",
    });
    const bridge = makeBridge(transport);

    const call = bridge.call<number>("panel:5", "inspect", [], {
      idempotencyKey: "idem-1",
      readOnly: true,
    });
    const frame = JSON.parse(ws.sent[0] ?? "{}") as {
      envelope: RpcEnvelope;
    };

    expect(frame.envelope.delivery).toMatchObject({
      idempotencyKey: "idem-1",
      readOnly: true,
    });
    expect(frame).not.toHaveProperty("message");

    transport.deliver("panel:5", {
      type: "response",
      requestId: frame.envelope.message.type === "request" ? frame.envelope.message.requestId : "",
      result: 5,
    });

    await expect(call).resolves.toBe(5);
  });
});
