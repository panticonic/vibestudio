import { describe, expect, it, vi } from "vitest";
import type { IrohPhysicalBiStream, IrohPhysicalConnection } from "@vibestudio/iroh-transport";
import type { RpcEnvelope } from "@vibestudio/rpc";
import { IrohRpcSessionChannel } from "./irohRpcSessionChannel.js";

function fakeStream(): IrohPhysicalBiStream & {
  send: IrohPhysicalBiStream["send"] & { finish: ReturnType<typeof vi.fn> };
  recv: IrohPhysicalBiStream["recv"] & { read: ReturnType<typeof vi.fn> };
} {
  const finish = vi.fn(async () => undefined);
  const read = vi.fn(async () => new Uint8Array(0));
  return {
    send: {
      writeAll: vi.fn(async () => undefined),
      finish,
      reset: vi.fn(async () => undefined),
      stopped: vi.fn(async () => null),
    },
    recv: {
      read,
      readExact: vi.fn(async () => new Uint8Array(0)),
      stop: vi.fn(async () => undefined),
      receivedReset: vi.fn(async () => null),
    },
  };
}

function eventEnvelope(from = "shell:device"): RpcEnvelope {
  return {
    from,
    target: "main",
    delivery: { caller: { callerId: from, callerKind: "shell" } },
    provenance: [],
    message: { type: "event", fromId: from, event: "ready", payload: null },
  };
}

function requestEnvelope(from = "shell:device"): RpcEnvelope {
  return {
    from,
    target: "main",
    delivery: { caller: { callerId: from, callerKind: "shell" } },
    provenance: [],
    message: {
      type: "request",
      requestId: "request-1",
      fromId: from,
      method: "app.getInfo",
      args: [],
    },
  };
}

describe("IrohRpcSessionChannel one-way stream lifecycle", () => {
  it("consumes the clean request FIN independently of unary response work", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();

    channel.deliverEnvelope(requestEnvelope(), stream);

    await vi.waitFor(() => expect(stream.recv.read).toHaveBeenCalled());
    expect(stream.send.finish).not.toHaveBeenCalled();
  });

  it("retires both halves of a client-originated event stream", async () => {
    const connection = {
      peerEndpointId: "peer",
    } as IrohPhysicalConnection;
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();

    channel.deliverEnvelope(eventEnvelope(), stream);

    await vi.waitFor(() => expect(stream.send.finish).toHaveBeenCalledTimes(1));
    expect(stream.recv.read).toHaveBeenCalled();
  });

  it("drains the peer FIN after a server-originated event", async () => {
    const stream = fakeStream();
    const connection = {
      peerEndpointId: "peer",
      openBi: vi.fn(async () => stream),
    } as unknown as IrohPhysicalConnection;
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });

    channel.sendMessage({ type: "ws:rpc", envelope: eventEnvelope("main") });

    await vi.waitFor(() => {
      expect(stream.send.finish).toHaveBeenCalledTimes(1);
      expect(stream.recv.read).toHaveBeenCalled();
    });
  });

  it("settles a server-originated request when its native stream resets", async () => {
    const stream = fakeStream();
    stream.recv.read.mockRejectedValueOnce(new Error("ReadError(Reset(514))"));
    const connection = {
      peerEndpointId: "peer",
      openBi: vi.fn(async () => stream),
    } as unknown as IrohPhysicalConnection;
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const delivered: unknown[] = [];
    channel.onMessage((message) => delivered.push(message));
    const envelope = requestEnvelope("main");
    envelope.target = "shell:device";

    channel.sendMessage({ type: "ws:rpc", envelope });

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toMatchObject({
      type: "ws:rpc",
      envelope: {
        from: "shell:device",
        target: "main",
        message: {
          type: "response",
          requestId: "request-1",
          errorKind: "transport",
          errorCode: "CONNECTION_LOST",
        },
      },
    });
  });
});
