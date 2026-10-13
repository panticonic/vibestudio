import { describe, expect, it, vi } from "vitest";
import { beginIrohLogicalRetirement, settleIrohPhysicalClosure } from "./irohAttachmentLifetime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function connectionLoss(message = "ConnectionLost(LocallyClosed)"): Error {
  return Object.assign(new Error(message), {
    code: "CONNECTION_LOST",
    errorKind: "transport",
  });
}

describe("settleIrohPhysicalClosure", () => {
  it.each([
    ["a control-loop failure", "control stream failed"],
    ["explicit attachment retirement", "server is stopping"],
  ])(
    "observes logical cleanup immediately after %s and preserves its failure for final settlement",
    async (_trigger, reason) => {
      const closure = deferred<string>();
      const retirement = deferred<void>();
      const original = new Error("logical session retirement failed");
      const retireLogical = vi.fn(() => retirement.promise);
      const lifetime = settleIrohPhysicalClosure(closure.promise, retireLogical);
      const lifetimeFailure = lifetime.catch((error: unknown) => error);

      beginIrohLogicalRetirement(retireLogical, reason);
      retirement.reject(original);
      // Cross the host's unhandled-rejection turn before physical closure lets
      // final settlement attach to the cached logical retirement promise.
      await new Promise<void>((resolve) => setImmediate(resolve));
      closure.resolve(reason);

      expect(await lifetimeFailure).toBe(original);
      expect(retireLogical).toHaveBeenNthCalledWith(1, reason);
      expect(retireLogical).toHaveBeenNthCalledWith(2, reason);
      expect(retireLogical.mock.results[0]?.value).toBe(retirement.promise);
      expect(retireLogical.mock.results[1]?.value).toBe(retirement.promise);
    }
  );

  it("joins logical retirement and settles a routine connection-loss receipt", async () => {
    const loss = connectionLoss();
    const retireLogical = vi.fn(async () => undefined);

    await expect(
      settleIrohPhysicalClosure(Promise.reject(loss), retireLogical)
    ).resolves.toBeUndefined();
    expect(retireLogical).toHaveBeenCalledExactlyOnceWith(loss.message);
  });

  it("preserves a non-routine physical closure failure after logical retirement", async () => {
    const original = new Error("native closure invariant failed");
    const retireLogical = vi.fn(async () => undefined);

    await expect(settleIrohPhysicalClosure(Promise.reject(original), retireLogical)).rejects.toBe(
      original
    );
    expect(retireLogical).toHaveBeenCalledExactlyOnceWith(original.message);
  });

  it("retains physical and logical failures with the physical failure as cause", async () => {
    const physical = new Error("native closure invariant failed");
    const logical = new Error("logical session retirement failed");
    const failure = await settleIrohPhysicalClosure(Promise.reject(physical), async () => {
      throw logical;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([physical, logical]);
    expect((failure as AggregateError).cause).toBe(physical);
  });

  it("does not hide logical failure beneath routine physical connection loss", async () => {
    const logical = new Error("logical session retirement failed");

    await expect(
      settleIrohPhysicalClosure(Promise.reject(connectionLoss()), async () => {
        throw logical;
      })
    ).rejects.toBe(logical);
  });
});
