import { describe, expect, it, vi } from "vitest";
import { isRetryableBundleTransferError, retryBundleTransfer } from "./bundleTransferRetry.js";

describe("workspace bundle transfer retry", () => {
  it("restarts a transfer whose gzip trailer was truncated by a pipe failure", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("java.util.zip.ZipException: Corrupt GZIP trailer"))
      .mockResolvedValueOnce("prepared");
    const onRetry = vi.fn();

    await expect(retryBundleTransfer(operation, { onRetry })).resolves.toBe("prepared");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
  });

  it("does not retry a semantic manifest error", async () => {
    const error = new Error("Mobile app artifact is missing integrity or URL");
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(retryBundleTransfer(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(isRetryableBundleTransferError(error)).toBe(false);
  });

  it("retries when an RPC starts while the canonical transport is still recovering", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Not connected to server"))
      .mockResolvedValueOnce("prepared");
    const wait = vi.fn(async () => {});

    await expect(retryBundleTransfer(operation, { wait })).resolves.toBe("prepared");
    expect(wait).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
