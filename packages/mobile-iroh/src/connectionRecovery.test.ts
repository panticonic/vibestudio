import { describe, expect, it, vi } from "vitest";
import {
  isTransientConnectionError,
  mobileConnectionRecoveryTimeoutError,
  retryAfterConnectionLoss,
} from "./connectionRecovery.js";

function connectionLost(): Error & { code: string } {
  return Object.assign(new Error("Connection lost before the response arrived"), {
    code: "CONNECTION_LOST",
  });
}

describe("mobile Iroh launch recovery", () => {
  it("retries the idempotent launch operation on the same authenticated session", async () => {
    const failure = connectionLost();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("ready");
    const waitUntilConnected = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await expect(
      retryAfterConnectionLoss(operation, {
        timeoutMs: 60_000,
        waitUntilConnected,
        onRetry,
      })
    ).resolves.toBe("ready");
    expect(waitUntilConnected).toHaveBeenCalledWith(30_000);
    expect(onRetry).toHaveBeenCalledWith(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("continues after one bounded Iroh reconnect wait expires", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(connectionLost())
      .mockResolvedValueOnce("ready");
    const waitUntilConnected = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(mobileConnectionRecoveryTimeoutError());

    await expect(
      retryAfterConnectionLoss(operation, { timeoutMs: 60_000, waitUntilConnected })
    ).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not mistake semantic failures or retired WebRTC wording for recovery", async () => {
    for (const error of [
      new Error("No react-native app is configured or selected"),
      new Error("WebRTC pipe down: keepalive timeout"),
      Object.assign(new Error("closed"), { code: "PIPE_CLOSED" }),
    ]) {
      const operation = vi.fn(async () => Promise.reject(error));
      const waitUntilConnected = vi.fn(async () => undefined);
      await expect(
        retryAfterConnectionLoss(operation, { timeoutMs: 60_000, waitUntilConnected })
      ).rejects.toBe(error);
      expect(operation).toHaveBeenCalledOnce();
      expect(waitUntilConnected).not.toHaveBeenCalled();
      expect(isTransientConnectionError(error)).toBe(false);
    }
  });

  it("stops at the overall recovery deadline", async () => {
    const failure = connectionLost();
    const operation = vi.fn(async () => Promise.reject(failure));
    const waitUntilConnected = vi.fn(async () => undefined);
    let now = 0;

    await expect(
      retryAfterConnectionLoss(operation, {
        timeoutMs: 100,
        reconnectWaitMs: 1_000,
        waitUntilConnected,
        now: () => {
          const current = now;
          now += 100;
          return current;
        },
      })
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
    expect(waitUntilConnected).not.toHaveBeenCalled();
  });
});
