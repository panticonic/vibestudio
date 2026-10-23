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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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
      deviceKey: "d".repeat(64),
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

  it("settles a nested cancellation-observer aggregate caused entirely by physical closure", async () => {
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
      log,
    });
    const stream = fakeStream();
    const readFailure = Object.assign(new Error("ConnectionLost(ApplicationClosed)"), {
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    const resetFailure = Object.assign(new Error("ClosedStream { _private: () }"), {
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    stream.recv.read.mockRejectedValueOnce(readFailure);
    vi.mocked(stream.recv.receivedReset).mockRejectedValueOnce(resetFailure);
    const onError = vi.fn();
    const removedHandler = vi.fn();
    channel.onError(onError);
    channel.onError(removedHandler)();

    channel.deliverEnvelope(requestEnvelope(), stream);
    const retirement = channel.remoteClosed(1006, "physical connection closed");

    await vi.waitFor(() => expect(stream.recv.receivedReset).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(removedHandler).not.toHaveBeenCalled();
    await expect(retirement).resolves.toBeUndefined();
  });

  it.each([
    ["a request the peer cancelled", "Stopped(514)"],
    ["a session the peer closed", "Stopped(513)"],
  ])("does not fail retirement for a response to %s", async (_label, native) => {
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
      log,
    });
    const stream = fakeStream();
    vi.mocked(stream.send.writeAll).mockRejectedValueOnce(
      Object.assign(new Error(native), { code: "GenericFailure" })
    );
    const original = requestEnvelope("shell:device");
    channel.deliverEnvelope(original, stream);
    channel.sendMessage({
      type: "ws:rpc",
      envelope: {
        ...original,
        from: "main",
        target: "shell:device",
        message: { type: "response", requestId: "request-1", result: "late" },
      },
    });
    await vi.waitFor(() => expect(stream.send.writeAll).toHaveBeenCalledOnce());

    await expect(channel.remoteClosed(1006, "physical connection closed")).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("still fails retirement for a response the peer stopped with a code that is not the protocol's", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();
    const stopped = Object.assign(new Error("Stopped(7)"), { code: "GenericFailure" });
    vi.mocked(stream.send.writeAll).mockRejectedValueOnce(stopped);
    const original = requestEnvelope("shell:device");
    channel.deliverEnvelope(original, stream);
    channel.sendMessage({
      type: "ws:rpc",
      envelope: {
        ...original,
        from: "main",
        target: "shell:device",
        message: { type: "response", requestId: "request-1", result: "late" },
      },
    });
    await vi.waitFor(() => expect(stream.send.writeAll).toHaveBeenCalledOnce());

    const failure = await channel
      .remoteClosed(1006, "physical connection closed")
      .catch((error: unknown) => error);
    expect((failure as AggregateError).errors).toEqual([stopped]);
  });

  it("preserves a non-closure failure nested beside connection retirement", async () => {
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => undefined),
      onClosed: vi.fn(),
    });
    const stream = fakeStream();
    const connectionLoss = Object.assign(new Error("ClosedStream { _private: () }"), {
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    const original = new Error("reset observer invariant failed");
    stream.recv.read.mockRejectedValueOnce(connectionLoss);
    vi.mocked(stream.recv.receivedReset).mockRejectedValueOnce(original);

    channel.deliverEnvelope(requestEnvelope(), stream);
    const failure = await channel
      .remoteClosed(1006, "physical connection closed")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const observerFailure = (failure as AggregateError).errors[0] as AggregateError;
    expect((failure as AggregateError).cause).toBe(observerFailure);
    expect(observerFailure.errors).toEqual([connectionLoss, original]);
    expect(observerFailure.cause).toBe(connectionLoss);
  });

  it("closes locally when the peer is already gone before the close notification", async () => {
    const onClosed = vi.fn();
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => {
        throw Object.assign(new Error("ConnectionLost(LocallyClosed)"), {
          code: "CONNECTION_LOST",
          errorKind: "transport",
        });
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
      "Iroh session shell close notification failed: ConnectionLost(LocallyClosed)"
    );
  });

  it("settles a rejected termination notification without delaying local termination", async () => {
    const onClosed = vi.fn();
    const log = vi.fn();
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => {
        throw Object.assign(new Error("ConnectionLost(LocallyClosed)"), {
          code: "CONNECTION_LOST",
          errorKind: "transport",
        });
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
        "Iroh session shell termination notification failed: ConnectionLost(LocallyClosed)"
      )
    );
    await completedRetirement;
  });

  it("preserves a non-connection close-notification failure", async () => {
    const original = new Error("control frame encoding failed");
    const channel = new IrohRpcSessionChannel({
      sid: "shell",
      deviceKey: "d".repeat(64),
      connection: { peerEndpointId: "peer" } as IrohPhysicalConnection,
      writeControl: vi.fn(async () => {
        throw original;
      }),
      onClosed: vi.fn(),
    });

    const failure = await channel.close(4001, "authentication rejected").catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original]);
    expect((failure as AggregateError).cause).toBe(original);
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
        deviceKey: "d".repeat(64),
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
      rejectWrite(
        Object.assign(new Error("ConnectionLost(ApplicationClosed)"), {
          code: "CONNECTION_LOST",
          errorKind: "transport",
        })
      );
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
