import { describe, expect, it, vi } from "vitest";
import { finishSessionOpening } from "./sessionOpening.js";

describe("session opening ownership", () => {
  it("cancels authentication and joins transport cleanup before rejecting", async () => {
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const abort = new AbortController();
    const original = new Error("renderer destroyed");
    const session = {
      close: vi.fn(() => {
        rejectReady(original);
        return cleanup;
      }),
    };
    let settled = false;
    const opening = finishSessionOpening(session, () => ready, abort.signal);
    const rejected = expect(
      opening.finally(() => {
        settled = true;
      })
    ).rejects.toBe(original);
    try {
      abort.abort(original);
      expect(session.close).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      finishCleanup();
      await rejected;
    }
  });
});
