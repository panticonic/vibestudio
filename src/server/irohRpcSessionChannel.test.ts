import { describe, expect, it, vi } from "vitest";
import type { IrohPhysicalBiStream, IrohPhysicalConnection } from "@vibestudio/iroh-transport";
import type { RpcEnvelope } from "@vibestudio/rpc";
import { IrohRpcSessionChannel } from "./irohRpcSessionChannel.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

  it("keeps the original response route and authenticated caller after unary cancellation", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();
    stream.recv.read.mockRejectedValueOnce(new Error("ReadError(Reset(514))"));
    vi.mocked(stream.recv.receivedReset).mockResolvedValueOnce(514);
    const delivered: unknown[] = [];
    channel.onMessage((message) => delivered.push(message));
    const original = requestEnvelope("shell:device");

    channel.deliverEnvelope(original, stream);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered[1]).toMatchObject({
      type: "ws:rpc",
      envelope: {
        from: "shell:device",
        target: "main",
        delivery: { caller: { callerId: "shell:device", callerKind: "shell" } },
        message: { type: "request-cancel", requestId: "request-1", fromId: "shell:device" },
      },
    });

    channel.sendMessage({
      type: "ws:rpc",
      envelope: {
        ...original,
        from: "main",
        target: "shell:device",
        message: { type: "response", requestId: "request-1", result: "cleanup complete" },
      },
    });
    await vi.waitFor(() => expect(stream.send.finish).toHaveBeenCalledOnce());
    expect(stream.send.writeAll).toHaveBeenCalledOnce();
  });

  it("keeps routed unary cancellation on the routed dispatch path", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();
    stream.recv.read.mockRejectedValueOnce(new Error("ReadError(Reset(514))"));
    vi.mocked(stream.recv.receivedReset).mockResolvedValueOnce(514);
    const delivered: unknown[] = [];
    channel.onMessage((message) => delivered.push(message));
    const original = { ...requestEnvelope(), target: "do:workers/agent:Chat:key" };

    channel.deliverEnvelope(original, stream);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered).toEqual([
      { type: "ws:route", envelope: original },
      expect.objectContaining({
        type: "ws:route",
        envelope: expect.objectContaining({
          target: original.target,
          delivery: original.delivery,
          message: { type: "request-cancel", requestId: "request-1", fromId: "shell:device" },
        }),
      }),
    ]);
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
          error: {
            errorKind: "transport",
            code: "CONNECTION_LOST",
          },
        },
      },
    });
  });
});

describe("IrohRpcSessionChannel shutdown lifecycle", () => {
  it("fences dispatch immediately and joins outstanding drains, resets, and stops", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();
    const drain = deferred<Uint8Array>();
    const reset = deferred<void>();
    const stop = deferred<void>();
    stream.recv.read.mockImplementationOnce(() => drain.promise);
    vi.mocked(stream.send.reset).mockImplementationOnce(() => reset.promise);
    vi.mocked(stream.recv.stop).mockImplementationOnce(() => stop.promise);
    channel.deliverEnvelope(requestEnvelope(), stream);

    let retired = false;
    const retirement = channel.remoteClosed(1006, "physical connection closed").then(() => {
      retired = true;
    });
    expect(channel.readyState).toBe(channel.CLOSED);
    expect(retired).toBe(false);
    drain.resolve(new Uint8Array(0));
    await Promise.resolve();
    expect(retired).toBe(false);
    reset.resolve();
    stop.resolve();
    await retirement;
    expect(retired).toBe(true);
  });

  it("owns a cancellation observer when connection closure also rejects reset observation", async () => {
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
      log,
    });
    const stream = fakeStream();
    const readFailure = new Error("ConnectionLost(ApplicationClosed)");
    const resetFailure = new Error("ConnectionLost(LocallyClosed)");
    stream.recv.read.mockRejectedValueOnce(readFailure);
    vi.mocked(stream.recv.receivedReset).mockRejectedValueOnce(resetFailure);
    const onError = vi.fn();
    const removedHandler = vi.fn();
    channel.onError(onError);
    channel.onError(removedHandler)();

    channel.deliverEnvelope(requestEnvelope(), stream);
    const retirement = channel.remoteClosed(1006, "physical connection closed");
    const retirementFailure = retirement.catch((error: unknown) => error);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const failure = onError.mock.calls[0]![0] as AggregateError;
    expect(failure.errors).toEqual([readFailure, resetFailure]);
    expect(failure.cause).toBe(readFailure);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(resetFailure.message));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(readFailure.message));
    expect(removedHandler).not.toHaveBeenCalled();
    const lifetimeFailure = await retirementFailure;
    expect(lifetimeFailure).toBeInstanceOf(AggregateError);
    expect((lifetimeFailure as AggregateError).errors).toEqual([failure]);
  });

  it("closes locally when the peer is already gone before the close notification", async () => {
    const onClosed = vi.fn();
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => {
        throw new Error("connection closed");
      }),
      onClosed,
      log,
    });

    const retirement = channel.close(4001, "authentication rejected");
    const completedRetirement = expect(retirement).resolves.toBeUndefined();

    expect(onClosed).toHaveBeenCalledWith("shell");
    expect(channel.readyState).toBe(channel.CLOSED);
    await completedRetirement;
    expect(log).toHaveBeenCalledWith(
      "Iroh session shell close notification failed: connection closed"
    );
  });

  it("settles a rejected termination notification without delaying local termination", async () => {
    const onClosed = vi.fn();
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => {
        throw new Error("connection closed");
      }),
      onClosed,
      log,
    });

    const retirement = channel.terminate();
    const completedRetirement = expect(retirement).resolves.toBeUndefined();

    expect(onClosed).toHaveBeenCalledWith("shell");
    expect(channel.readyState).toBe(channel.CLOSED);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "Iroh session shell termination notification failed: connection closed"
      )
    );
    await completedRetirement;
  });
});

describe("IrohRpcSessionChannel close notification ownership", () => {
  it.each(["close", "terminate"] as const)(
    "retires locally when %s races a peer connection shutdown",
    async (operation) => {
      let rejectWrite!: (error: Error) => void;
      const write = new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      });
      const onClosed = vi.fn();
      const log = vi.fn();
      const channel = new IrohRpcSessionChannel({
        sid: "replay",
        connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
        writeControl: vi.fn(() => write),
        onClosed,
        log,
      });
      const onClose = vi.fn();
      channel.onClose(onClose);
      const retirement =
        operation === "close" ? channel.close(4001, "pairing rejected") : channel.terminate();
      const completedRetirement = expect(retirement).resolves.toBeUndefined();
      expect(onClosed).toHaveBeenCalledOnce();
      rejectWrite(new Error("ConnectionLost(ApplicationClosed)"));
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          `Iroh session replay ${operation === "close" ? "close" : "termination"} notification failed: ConnectionLost(ApplicationClosed)`
        )
      );
      expect(channel.readyState).toBe(channel.CLOSED);
      expect(onClosed).toHaveBeenCalledExactlyOnceWith("replay");
      expect(onClose).toHaveBeenCalledExactlyOnceWith(
        operation === "close" ? 4001 : 1006,
        operation === "close" ? "pairing rejected" : "terminated"
      );
      await completedRetirement;
      channel.remoteClosed(1006, "physical connection closed");
      expect(onClosed).toHaveBeenCalledOnce();
    }
  );
});
