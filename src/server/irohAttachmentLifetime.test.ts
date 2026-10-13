import { describe, expect, it, vi } from "vitest";
import { settleIrohPhysicalClosure } from "./irohAttachmentLifetime.js";

function connectionLoss(message = "ConnectionLost(LocallyClosed)"): Error {
  return Object.assign(new Error(message), {
    code: "CONNECTION_LOST",
    errorKind: "transport",
  });
}

describe("settleIrohPhysicalClosure", () => {
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
