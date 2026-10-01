import { describe, expect, it, vi } from "vitest";
import { createRecoveryCoordinator } from "./recoveryCoordinator.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("RecoveryCoordinator", () => {
  it("propagates the original failure without retrying or claiming completion", async () => {
    const coordinator = createRecoveryCoordinator();
    const error = new Error("Snapshot could not be restored");
    const failed = vi.fn(() => {
      throw error;
    });
    const after = vi.fn();
    const release = coordinator.registerResubscribeHandler("snapshot", failed);
    coordinator.registerResubscribeHandler("after", after);
    await expect(coordinator.run("resubscribe")).rejects.toBe(error);
    expect(failed).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
    release();
    await coordinator.run("resubscribe");
    expect(after).toHaveBeenCalledOnce();
  });

  it("propagates connection loss and permits the next authoritative generation", async () => {
    const coordinator = createRecoveryCoordinator();
    const error = Object.assign(new Error("Connection lost"), { code: "CONNECTION_LOST" });
    const handler = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    coordinator.registerResubscribeHandler("watch", handler);
    await expect(coordinator.run("resubscribe")).rejects.toBe(error);
    await coordinator.run("resubscribe");
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it("runs newly registered resubscribe handlers after resubscribe completed for the current generation", async () => {
    const coordinator = createRecoveryCoordinator();
    await coordinator.run("resubscribe");

    const handler = vi.fn();
    coordinator.registerResubscribeHandler("late-resubscribe", handler);
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not replay the current generation to a self-bootstrapped resource", async () => {
    const coordinator = createRecoveryCoordinator();
    await coordinator.run("resubscribe");

    const handler = vi.fn();
    coordinator.registerResubscribeHandler("future-resubscribe", handler, {
      includeCurrentGeneration: false,
    });
    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
    await coordinator.run("resubscribe");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not run newly registered cold-recover handlers after cold recovery completed", async () => {
    const coordinator = createRecoveryCoordinator();
    await coordinator.run("resubscribe");
    await coordinator.run("cold-recover");

    const handler = vi.fn();
    coordinator.registerColdRecoverHandler("late-cold-recover", handler);
    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not include cold-recover handlers registered during an active cold recovery", async () => {
    const coordinator = createRecoveryCoordinator();
    const lateHandler = vi.fn();

    coordinator.registerColdRecoverHandler("registers-late", () => {
      coordinator.registerColdRecoverHandler("late-cold-recover", lateHandler);
    });

    await coordinator.run("cold-recover");

    expect(lateHandler).not.toHaveBeenCalled();
  });
});
