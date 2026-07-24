import { describe, expect, it, vi } from "vitest";
import {
  isTransientEvalStatusReadError,
  readEvalStatusWithRetry,
} from "./eval-status-retry.js";

describe("system-test runner eval status reads", () => {
  it("retries a transient workerd socket close", async () => {
    const read = vi
      .fn<() => Promise<{ status: string }>>()
      .mockRejectedValueOnce(
        new Error(
          "DO dispatch fetch failed: fetch failed (cause: SocketError: other side closed code=UND_ERR_SOCKET)"
        )
      )
      .mockResolvedValue({ status: "running" });
    const pause = vi.fn(async () => {});

    await expect(readEvalStatusWithRetry(read, { pause })).resolves.toEqual({
      status: "running",
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(500);
  });

  it("does not retry semantic eval errors", async () => {
    const failure = new Error("system-test eval returned an invalid record");
    const read = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(readEvalStatusWithRetry(read)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledOnce();
  });

  it("recognizes transport codes through nested causes", () => {
    expect(
      isTransientEvalStatusReadError(
        new Error("eval status failed", { cause: { code: "ECONNRESET" } })
      )
    ).toBe(true);
  });
});
