import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, anySignal, delay, throwIfAborted } from "./async.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("credential abort helpers", () => {
  it("fails immediately with the credential cancellation error", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      expect.objectContaining({ code: "approval_denied" })
    );
  });

  it("rejects an in-flight promise and runs its abort cleanup", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const pending = abortable(new Promise<never>(() => {}), controller.signal, cleanup);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "approval_denied" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("combines abort signals and makes delay abortable", async () => {
    vi.useFakeTimers();
    const first = new AbortController();
    const second = new AbortController();
    const combined = anySignal([first.signal, second.signal]);
    const pending = delay(1_000, combined);
    second.abort();
    expect(combined?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "approval_denied" });
  });
});
