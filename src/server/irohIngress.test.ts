import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "@vibestudio/iroh-transport";
import { describe, expect, it, vi } from "vitest";
import { startIrohIngress } from "./irohIngress.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function connection(peerEndpointId: string) {
  const closed = deferred<string>();
  return {
    peerEndpointId,
    openBi: vi.fn(),
    acceptBi: vi.fn(),
    close: vi.fn(() => closed.resolve("closed")),
    closed: () => closed.promise,
  } as unknown as IrohPhysicalConnection;
}

describe("Iroh server ingress", () => {
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
    await ingress.stop();
  });

  it("keeps the same endpoint through a relay outage and becomes ready on recovery", async () => {
    vi.useFakeTimers();
    const online = deferred<void>();
    const waiting = deferred<IrohPhysicalConnection | null>();
    const endpoint = {
      endpointId: "d".repeat(64),
      accept: vi.fn(() => waiting.promise),
      close: vi.fn(async () => waiting.resolve(null)),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const binding = {
      bind: vi.fn(async () => endpoint),
    } as IrohEndpointBinding<IrohPhysicalConnection, IrohPhysicalEndpoint<IrohPhysicalConnection>>;
    const ingress = startIrohIngress({
      binding,
      admitPeer: () => true,
      attach: async () => undefined,
      waitUntilOnline: () => online.promise,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(endpoint.accept).not.toHaveBeenCalled();
      expect(endpoint.close).not.toHaveBeenCalled();
      expect(binding.bind).toHaveBeenCalledOnce();
      online.resolve();
      await ingress.ready;
      expect(endpoint.accept).toHaveBeenCalledOnce();
    } finally {
      online.resolve();
      await ingress.stop();
      vi.useRealTimers();
    }
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("cancels pending relay discovery and settles readiness when stopped", async () => {
    let rejectOnline!: (error: Error) => void;
    const online = new Promise<void>((_resolve, reject) => {
      rejectOnline = reject;
    });
    const endpoint = {
      endpointId: "d".repeat(64),
      accept: vi.fn(),
      close: vi.fn(async () => rejectOnline(new Error("endpoint closed"))),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const waitUntilOnline = vi.fn(() => online);
    const ingress = startIrohIngress({
      binding: { bind: async () => endpoint },
      admitPeer: () => true,
      attach: async () => undefined,
      waitUntilOnline,
    });
    const rejected = expect(ingress.ready).rejects.toThrow("stopped before becoming ready");
    await vi.waitFor(() => expect(waitUntilOnline).toHaveBeenCalledOnce());
    await ingress.stop();
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
