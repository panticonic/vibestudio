import { describe, expect, it, vi } from "vitest";
import { isTransientConnectionError, retryAfterConnectionLoss } from "./connectionRecovery.js";

describe("mobile connection recovery", () => {
  it("retries the bootstrap operation on the same session after a pipe loss", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("Connection lost"), { code: "CONNECTION_LOST" })
      )
      .mockResolvedValueOnce("ready");
    const waitUntilConnected = vi.fn(async () => {});
    const onRetry = vi.fn();

    await expect(
      retryAfterConnectionLoss(operation, {
        timeoutMs: 60_000,
        waitUntilConnected,
        onRetry,
      })
    ).resolves.toBe("ready");
    expect(waitUntilConnected).toHaveBeenCalledWith(30_000);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting when one bounded reconnect wait expires", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("WebRTC pipe down: keepalive timeout"))
      .mockResolvedValueOnce("ready");
    const waitUntilConnected = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("The secure workspace connection did not recover in time"));

    await expect(
      retryAfterConnectionLoss(operation, { timeoutMs: 60_000, waitUntilConnected })
    ).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a semantic launch failure", async () => {
    const error = new Error("No react-native app is configured or selected");
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(
      retryAfterConnectionLoss(operation, {
        timeoutMs: 60_000,
        waitUntilConnected: vi.fn(async () => {}),
      })
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(isTransientConnectionError(error)).toBe(false);
  });
});
