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
  it("admits only after binding and rejects peers before attachment", async () => {
    const allowed = connection("a".repeat(64));
    const denied = connection("b".repeat(64));
    const queue = [allowed, denied, null];
    const endpoint = {
      endpointId: "c".repeat(64),
      accept: vi.fn(async () => queue.shift() ?? null),
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
    await ingress.stop();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("bounds relay discovery and releases an endpoint that cannot become online", async () => {
    const endpoint = {
      endpointId: "d".repeat(64),
      accept: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as IrohPhysicalEndpoint<IrohPhysicalConnection>;
    const binding = {
      bind: vi.fn(async () => endpoint),
    } as IrohEndpointBinding<IrohPhysicalConnection, IrohPhysicalEndpoint<IrohPhysicalConnection>>;
    const ingress = startIrohIngress({
      binding,
      admitPeer: () => true,
      attach: async () => undefined,
      waitUntilOnline: () => new Promise(() => undefined),
      onlineTimeoutMs: 5,
    });

    await expect(ingress.ready).rejects.toThrow(/did not become online within 5ms/u);
    expect(endpoint.accept).not.toHaveBeenCalled();
    expect(endpoint.close).toHaveBeenCalledOnce();
    await ingress.stop();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("rejects an invalid online deadline before binding", () => {
    const binding = { bind: vi.fn() } as unknown as IrohEndpointBinding<
      IrohPhysicalConnection,
      IrohPhysicalEndpoint<IrohPhysicalConnection>
    >;
    expect(() =>
      startIrohIngress({
        binding,
        admitPeer: () => true,
        attach: async () => undefined,
        onlineTimeoutMs: 0,
      })
    ).toThrow(/onlineTimeoutMs must be a positive safe integer/u);
    expect(binding.bind).not.toHaveBeenCalled();
  });
});
