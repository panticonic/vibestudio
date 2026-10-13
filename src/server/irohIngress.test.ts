import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "@vibestudio/iroh-transport";
import { describe, expect, it, vi } from "vitest";
import { startIrohIngress } from "./irohIngress.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function connection(peerEndpointId: string, settleOnClose = true) {
  const closed = deferred<string>();
  return {
    peerEndpointId,
    openBi: vi.fn(),
    acceptBi: vi.fn(),
    close: vi.fn(() => {
      if (settleOnClose) closed.resolve("closed");
    }),
    closed: () => closed.promise,
    settleClosed: (reason = "closed") => closed.resolve(reason),
  } as unknown as IrohPhysicalConnection & { settleClosed(reason?: string): void };
}

describe("Iroh server ingress", () => {
  it("atomically replaces an admitted physical peer and ignores its late closure", async () => {
    const peerId = "a".repeat(64);
    const first = connection(peerId, false);
    const second = connection(peerId, false);
    const third = connection(peerId, false);
    const thirdAdmission = deferred<IrohPhysicalConnection | null>();
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockImplementationOnce(() => thirdAdmission.promise)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
      expect(first.close).toHaveBeenCalledWith(0x213n, expect.any(Uint8Array));

      // The predecessor can report closure after its successor is active. That
      // receipt must retire only the exact old generation.
      first.settleClosed("late predecessor close");
      thirdAdmission.resolve(third);
      await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
      expect(second.close).toHaveBeenCalledWith(0x213n, expect.any(Uint8Array));
    } finally {
      thirdAdmission.resolve(null);
      first.settleClosed();
      second.settleClosed();
      third.settleClosed();
      await ingress.stop();
    }
  });

  it("keeps distinct physical peers active until ingress shutdown", async () => {
    const first = connection("a".repeat(64));
    const second = connection("b".repeat(64));
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await ingress.ready;
    await vi.waitFor(() => expect(endpoint.accept).toHaveBeenCalledTimes(3));
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    await ingress.stop();
    expect(first.close).toHaveBeenCalledWith(0x211n, expect.any(Uint8Array));
    expect(second.close).toHaveBeenCalledWith(0x211n, expect.any(Uint8Array));
  });

  it("joins a replaced physical peer through its terminal receipt during shutdown", async () => {
    const peerId = "a".repeat(64);
    const first = connection(peerId, false);
    const second = connection(peerId, false);
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    let stopping: Promise<void> | undefined;
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());

      let stopped = false;
      stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await vi.waitFor(() =>
        expect(second.close).toHaveBeenCalledWith(0x211n, expect.any(Uint8Array))
      );
      await Promise.resolve();
      expect(stopped).toBe(false);
      first.settleClosed();
      await Promise.resolve();
      expect(stopped).toBe(false);
      second.settleClosed();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      first.settleClosed();
      second.settleClosed();
      await (stopping ?? ingress.stop());
    }
  });

  it("proves a successor control handshake before fencing the active peer", async () => {
    const peerId = "a".repeat(64);
    const first = connection(peerId, false);
    const second = connection(peerId, false);
    const secondHandshake = deferred<void>();
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const attach = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => secondHandshake.promise);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach,
    });
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
      expect(first.close).not.toHaveBeenCalled();
      secondHandshake.resolve();
      await vi.waitFor(() =>
        expect(first.close).toHaveBeenCalledWith(0x213n, expect.any(Uint8Array))
      );
    } finally {
      secondHandshake.resolve();
      first.settleClosed();
      second.settleClosed();
      await ingress.stop();
    }
  });

  it("keeps same-peer replacement overlap inside the total physical ceiling", async () => {
    const peerId = "a".repeat(64);
    const first = connection(peerId, false);
    const second = connection(peerId, false);
    const excess = connection(peerId, false);
    const nextExcess = connection(peerId);
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce(excess)
        .mockResolvedValueOnce(nextExcess)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const attach = vi.fn(async () => undefined);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      maxConnections: 2,
      admitPeer: () => true,
      attach,
    });
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(excess.close).toHaveBeenCalledOnce());
      expect(first.close).toHaveBeenCalledWith(0x213n, expect.any(Uint8Array));
      expect(excess.close).toHaveBeenCalledWith(0x212n, expect.any(Uint8Array));
      expect(attach).toHaveBeenCalledTimes(2);
      expect(second.close).not.toHaveBeenCalled();
      expect(endpoint.accept).toHaveBeenCalledTimes(3);

      excess.settleClosed();
      await vi.waitFor(() => expect(nextExcess.close).toHaveBeenCalledOnce());
      expect(nextExcess.close).toHaveBeenCalledWith(0x212n, expect.any(Uint8Array));
    } finally {
      excess.settleClosed();
      first.settleClosed();
      second.settleClosed();
      await ingress.stop();
    }
  });

  it("waits for asynchronous startup admission and checks current membership before attachment", async () => {
    const peer = connection("a".repeat(64));
    const startup = deferred<boolean>();
    const waiting = deferred<IrohPhysicalConnection | null>();
    let member = true;
    const endpoint = {
      endpointId: "c".repeat(64),
      connect: vi.fn(),
      accept: vi
        .fn()
        .mockResolvedValueOnce(peer)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const attach = vi.fn(async () => undefined);
    const admitPeer = vi.fn(async () => (await startup.promise) && member);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer,
      attach,
    });
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(admitPeer).toHaveBeenCalledOnce());
      expect(attach).not.toHaveBeenCalled();
      member = false;
      startup.resolve(true);
      await vi.waitFor(() => expect(peer.close).toHaveBeenCalled());
      expect(attach).not.toHaveBeenCalled();
      expect(peer.close).toHaveBeenCalledWith(0x210n, expect.any(Uint8Array));
    } finally {
      startup.resolve(false);
      await ingress.stop();
    }
  });

  it.each([false, true])(
    "does not attach a pending admission after stop even if it settles %s",
    async (admitted) => {
      const peer = connection("a".repeat(64));
      const startup = deferred<boolean>();
      const waiting = deferred<IrohPhysicalConnection | null>();
      const endpoint = {
        endpointId: "c".repeat(64),
        connect: vi.fn(),
        accept: vi
          .fn()
          .mockResolvedValueOnce(peer)
          .mockImplementation(() => waiting.promise),
        close: vi.fn(async () => waiting.resolve(null)),
      } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
      const attach = vi.fn(async () => undefined);
      const admitPeer = vi.fn(() => startup.promise);
      const ingress = startIrohIngress({
        binding: { bind: async () => endpoint },
        admitPeer,
        attach,
      });
      try {
        await ingress.ready;
        await vi.waitFor(() => expect(admitPeer).toHaveBeenCalledOnce());
        const stopping = ingress.stop();
        startup.resolve(admitted);
        await stopping;
        expect(attach).not.toHaveBeenCalled();
        expect(peer.close).toHaveBeenCalledWith(0x211n, expect.any(Uint8Array));
        expect(endpoint.close).toHaveBeenCalledOnce();
      } finally {
        startup.resolve(false);
        await ingress.stop();
      }
    }
  );

  it("admits only after binding and rejects peers before attachment", async () => {
    const allowed = connection("a".repeat(64));
    const denied = connection("b".repeat(64));
    const waiting = deferred<IrohPhysicalConnection | null>();
    const queue: Array<IrohPhysicalConnection | Promise<IrohPhysicalConnection | null>> = [
      allowed,
      denied,
      waiting.promise,
    ];
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi.fn(async () => await (queue.shift() ?? waiting.promise)),
      close: vi.fn(async () => undefined),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const binding = {
      bind: vi.fn(async () => endpoint),
    } as IrohEndpointBinding<IrohPhysicalConnection, IrohPhysicalEndpoint<IrohPhysicalConnection>>;
    const attach = vi.fn(async () => undefined);
    const ingress = startIrohIngress({
      binding,
      admitPeer: (peer) => peer === allowed.peerEndpointId,
      attach,
    });
    await ingress.ready;
    await expect(ingress.waitUntilOnline()).rejects.toThrow(
      "Iroh endpoint binding cannot report home-relay readiness"
    );
    await vi.waitFor(() => expect(endpoint.accept).toHaveBeenCalledTimes(3));

    expect(ingress.endpointId).toBe(endpoint.endpointId);
    expect(attach).toHaveBeenCalledWith(allowed);
    expect(attach).not.toHaveBeenCalledWith(denied);
    expect(denied.close).toHaveBeenCalledWith(0x210n, expect.any(Uint8Array));
    waiting.resolve(null);
    await ingress.stop();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("rebinds after an established accept loop fails while preserving endpoint identity", async () => {
    const accepted = connection("a".repeat(64));
    const secondWait = deferred<IrohPhysicalConnection | null>();
    const first = {
      endpointId: "c".repeat(64),
      accept: vi.fn(async () => {
        throw new Error("transient accept failure");
      }),
      close: vi.fn(async () => undefined),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    let secondAccept = 0;
    const second = {
      endpointId: first.endpointId,
      accept: vi.fn(async () => {
        secondAccept += 1;
        return secondAccept === 1 ? accepted : await secondWait.promise;
      }),
      close: vi.fn(async () => secondWait.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const binding = {
      bind: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second),
    } as IrohEndpointBinding<IrohPhysicalConnection, IrohPhysicalEndpoint<IrohPhysicalConnection>>;
    const attach = vi.fn(async () => undefined);
    const ingress = startIrohIngress({ binding, admitPeer: () => true, attach });
    await ingress.ready;
    await vi.waitFor(() => expect(attach).toHaveBeenCalledWith(accepted));
    expect(binding.bind).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledOnce();
    expect(ingress.endpoint).toBe(second);
    await ingress.stop();
    expect(() => ingress.endpoint).toThrow("not bound");
  });

  it("accepts direct peers while relay connectivity is unavailable", async () => {
    const peer = connection("a".repeat(64));
    const waiting = deferred<IrohPhysicalConnection | null>();
    const online = vi.fn(() => new Promise<void>(() => undefined));
    const endpoint = {
      endpointId: "d".repeat(64),
      connect: vi.fn(),
      accept: vi
        .fn()
        .mockResolvedValueOnce(peer)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
      native: { online },
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection> & {
      native: { online: typeof online };
    };
    const attach = vi.fn(async () => undefined);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach,
    });
    try {
      await ingress.ready;
      await vi.waitFor(() => expect(attach).toHaveBeenCalledWith(peer));
      expect(online).not.toHaveBeenCalled();
      expect(ingress.endpoint).toBe(endpoint);
    } finally {
      await ingress.stop();
    }
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("keeps bind readiness and direct admission independent from reach readiness", async () => {
    const peer = connection("a".repeat(64));
    const waiting = deferred<IrohPhysicalConnection | null>();
    const online = deferred<void>();
    const endpoint = {
      endpointId: "e".repeat(64),
      connect: vi.fn(),
      accept: vi
        .fn()
        .mockResolvedValueOnce(peer)
        .mockImplementation(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const attach = vi.fn(async () => undefined);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint, waitUntilOnline: () => online.promise },
      admitPeer: () => true,
      attach,
    });
    try {
      await ingress.ready;
      expect(ingress.isOnline).toBe(false);
      const reach = ingress.waitUntilOnline();
      await vi.waitFor(() => expect(attach).toHaveBeenCalledWith(peer));
      expect(ingress.isOnline).toBe(false);
      online.resolve();
      await expect(reach).resolves.toBe(endpoint);
      expect(ingress.isOnline).toBe(true);
    } finally {
      await ingress.stop();
    }
  });

  it("settles a pending reach as owner-stop after joining online without failing stop", async () => {
    const waiting = deferred<IrohPhysicalConnection | null>();
    const online = deferred<void>();
    const closeError = new Error("Endpoint closed before becoming online");
    let onlineSettled = false;
    const endpoint = {
      endpointId: "f".repeat(64),
      connect: vi.fn(),
      accept: vi.fn().mockImplementation(() => waiting.promise),
      close: vi.fn(async () => {
        waiting.resolve(null);
        online.reject(closeError);
      }),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: {
        bind: async () => endpoint,
        waitUntilOnline: () => online.promise.finally(() => (onlineSettled = true)),
      },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await ingress.ready;
    const reach = ingress.waitUntilOnline();
    const stopping = ingress.stop();
    await expect(reach).rejects.toThrow("Iroh ingress stopped before reach became ready");
    await expect(stopping).resolves.toBeUndefined();
    expect(onlineSettled).toBe(true);
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("preserves the online failure and endpoint-close failure for a pending reach", async () => {
    const accept = deferred<IrohPhysicalConnection | null>();
    const online = deferred<void>();
    const onlineError = new Error("home relay discovery failed");
    const acceptError = new Error("accept operation failed independently");
    const closeError = new Error("endpoint close failed");
    const endpoint = {
      endpointId: "h".repeat(64),
      connect: vi.fn(),
      accept: vi.fn().mockImplementation(() => accept.promise),
      close: vi.fn(async () => {
        throw closeError;
      }),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint, waitUntilOnline: () => online.promise },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await ingress.ready;
    const reach = ingress.waitUntilOnline();
    accept.reject(acceptError);
    online.reject(onlineError);
    const failure = await reach.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(onlineError);
    expect((failure as AggregateError).errors).toContain(acceptError);
    expect((failure as AggregateError).errors).toContain(closeError);
    expect(endpoint.close).toHaveBeenCalledOnce();
    await expect(ingress.stop()).rejects.toBe(failure);
  });

  it("joins failed-generation cleanup before rejecting later reach callers", async () => {
    const accept = deferred<IrohPhysicalConnection | null>();
    const online = deferred<void>();
    const close = deferred<void>();
    const acceptError = new Error("accept operation failed");
    const closeError = new Error("endpoint close failed");
    const endpoint = {
      endpointId: "i".repeat(64),
      connect: vi.fn(),
      accept: vi.fn(() => accept.promise),
      close: vi.fn(async () => await close.promise),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint, waitUntilOnline: () => online.promise },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await ingress.ready;
    online.resolve();
    await expect(ingress.waitUntilOnline()).resolves.toBe(endpoint);

    accept.reject(acceptError);
    await vi.waitFor(() => expect(endpoint.close).toHaveBeenCalledOnce());
    let reachSettled = false;
    const failedReach = ingress.waitUntilOnline().finally(() => {
      reachSettled = true;
    });
    await Promise.resolve();
    expect(reachSettled).toBe(false);
    close.reject(closeError);

    const failure = await failedReach.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(acceptError);
    expect((failure as AggregateError).errors).toContain(closeError);
    await expect(ingress.stop()).rejects.toBe(failure);
  });

  it("does not carry a failed generation's reach wait into its replacement", async () => {
    const firstAccept = deferred<IrohPhysicalConnection | null>();
    const secondAccept = deferred<IrohPhysicalConnection | null>();
    const firstOnline = deferred<void>();
    const secondOnline = deferred<void>();
    const onlineError = new Error("home relay discovery failed");
    const first = {
      endpointId: "g".repeat(64),
      connect: vi.fn(),
      accept: vi.fn(() => firstAccept.promise),
      close: vi.fn(async () => firstAccept.resolve(null)),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const second = {
      endpointId: first.endpointId,
      connect: vi.fn(),
      accept: vi.fn(() => secondAccept.promise),
      close: vi.fn(async () => secondAccept.resolve(null)),
    } satisfies IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const binding = {
      bind: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second),
      waitUntilOnline: vi.fn((owner: typeof first) =>
        owner === first ? firstOnline.promise : secondOnline.promise
      ),
    };
    const ingress = startIrohIngress({
      binding,
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await ingress.ready;
    const firstReach = ingress.waitUntilOnline();
    firstOnline.reject(onlineError);
    await expect(firstReach).rejects.toBe(onlineError);
    await vi.waitFor(() => expect(ingress.endpoint).toBe(second));

    const secondReach = ingress.waitUntilOnline();
    secondOnline.resolve();
    await expect(secondReach).resolves.toBe(second);
    await ingress.stop();
    expect(binding.bind).toHaveBeenCalledTimes(2);
  });

  it("joins pending binding and rejects startup when stopped before binding completes", async () => {
    const bound = deferred<IrohPhysicalEndpoint<IrohPhysicalConnection>>();
    const endpoint = {
      endpointId: "d".repeat(64),
      accept: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const ingress = startIrohIngress({
      binding: { bind: () => bound.promise },
      admitPeer: () => true,
      attach: async () => undefined,
    });
    const rejected = expect(ingress.ready).rejects.toThrow("stopped before becoming ready");
    const stopping = ingress.stop();
    bound.resolve(endpoint);
    await stopping;
    await rejected;
    await ingress.stop();
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(endpoint.accept).not.toHaveBeenCalled();
  });

  it("reports a binding failure without retrying a broken configuration", async () => {
    const binding = {
      bind: vi.fn(async () => {
        throw new Error("invalid relay configuration");
      }),
    };
    const ingress = startIrohIngress({
      binding,
      admitPeer: () => true,
      attach: async () => undefined,
    });
    await expect(ingress.ready).rejects.toThrow("invalid relay configuration");
    await ingress.stop();
    expect(binding.bind).toHaveBeenCalledOnce();
  });
});
