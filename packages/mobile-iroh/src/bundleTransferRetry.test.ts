import { describe, expect, it, vi } from "vitest";
import { isRetryableBundleTransferError, retryBundleTransfer } from "./bundleTransferRetry.js";

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("mobile Iroh bundle transfer retry", () => {
  it.each([
    "CONNECTION_LOST",
    "bundle_append_failed",
    "bundle_finalize_failed",
    "BUNDLE_RANGE_INCOMPLETE",
  ])("retries the current transfer for %s", async (code) => {
    const failure = codedError(code);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("prepared");
    const wait = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await expect(retryBundleTransfer(operation, { wait, onRetry })).resolves.toBe("prepared");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(failure, 2);
  });

  it("does not retry semantic failures or obsolete transport-shaped messages", async () => {
    for (const error of [
      new Error("Mobile app artifact is missing integrity or URL"),
      new Error("WebRTC pipe down: keepalive timeout"),
      codedError("INVALID_MANIFEST"),
    ]) {
      const operation = vi.fn(async () => Promise.reject(error));
      await expect(retryBundleTransfer(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledOnce();
      expect(isRetryableBundleTransferError(error)).toBe(false);
    }
  });

  it("honors the catastrophic attempt fallback when recovery never succeeds", async () => {
    const error = codedError("CONNECTION_LOST");
    const operation = vi.fn(async () => Promise.reject(error));
    const wait = vi.fn(async () => undefined);

    await expect(retryBundleTransfer(operation, { attempts: 3, wait })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
