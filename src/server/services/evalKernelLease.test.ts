import { describe, expect, it, vi } from "vitest";
import { EvalKernelLeaseCoordinator } from "./evalKernelLease.js";

const ref = {
  source: "vibestudio/internal",
  className: "EvalDO",
  objectKey: "owner",
};

describe("EvalKernelLeaseCoordinator", () => {
  it("opens one held kernel request and refreshes that lease on later cells", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let activeLeaseId: string | undefined;
    let holderAttached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        if (lease.leaseId !== activeLeaseId) {
          activeLeaseId = lease.leaseId;
          holderAttached = false;
        }
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dispatchHeld = vi.fn().mockReturnValue(held);
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeld },
      { idleMs: 123_000, onError: vi.fn() }
    );

    await coordinator.touch(ref);
    await coordinator.touch(ref);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatchHeld).toHaveBeenCalledTimes(1);
    const first = dispatch.mock.calls[0]![2] as { leaseId: string; idleMs: number };
    const second = dispatch.mock.calls[2]![2] as { leaseId: string; idleMs: number };
    expect(first).toEqual({ leaseId: expect.any(String), idleMs: 123_000 });
    expect(second).toEqual(first);
    expect(dispatchHeld).toHaveBeenCalledWith(ref, "holdKernelLease", first.leaseId);

    release();
    await held;
  });

  it("serializes concurrent first touches so they cannot open competing holds", async () => {
    let release!: () => void;
    let activeLeaseId: string | undefined;
    let holderAttached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        if (lease.leaseId !== activeLeaseId) {
          activeLeaseId = lease.leaseId;
          holderAttached = false;
        }
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dispatchHeld = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeld },
      { onError: vi.fn() }
    );

    await Promise.all([coordinator.touch(ref), coordinator.touch(ref), coordinator.touch(ref)]);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatchHeld).toHaveBeenCalledTimes(1);
    expect(
      new Set(
        dispatch.mock.calls
          .filter((call) => call[1] === "acquireKernelLease")
          .map((call) => (call[2] as { leaseId: string }).leaseId)
      ).size
    ).toBe(1);
    release();
  });

  it("forgets a failed hold so a later cell establishes a fresh lease", async () => {
    const onError = vi.fn();
    let activeLeaseId: string | undefined;
    let holderAttached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        if (lease.leaseId !== activeLeaseId) {
          activeLeaseId = lease.leaseId;
          holderAttached = false;
        }
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dispatchHeld = vi
      .fn()
      .mockImplementationOnce(() => {
        holderAttached = false;
        return Promise.reject(new Error("workerd restarted"));
      })
      .mockReturnValueOnce(new Promise<void>(() => undefined));
    const coordinator = new EvalKernelLeaseCoordinator({ dispatch, dispatchHeld }, { onError });

    await coordinator.touch(ref);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await coordinator.touch(ref);

    expect(dispatchHeld).toHaveBeenCalledTimes(2);
    const acquiredIds = dispatch.mock.calls
      .filter((call) => call[1] === "acquireKernelLease")
      .map((call) => (call[2] as { leaseId: string }).leaseId);
    expect(acquiredIds[0]).not.toBe(acquiredIds[1]);
  });

  it("replaces a stale local hold when the EvalDO reports that no holder exists", async () => {
    let activeLeaseId: string | undefined;
    let holderAttached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        if (lease.leaseId !== activeLeaseId) {
          activeLeaseId = lease.leaseId;
          holderAttached = false;
        }
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const holds: Array<{ promise: Promise<void>; release: () => void }> = [];
    const dispatchHeld = vi.fn(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ promise, release });
      return promise;
    });
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeld },
      { onError: vi.fn() }
    );

    await coordinator.touch(ref);
    const firstLeaseId = activeLeaseId;
    holderAttached = false;
    await coordinator.touch(ref);
    const replacementLeaseId = activeLeaseId;

    expect(replacementLeaseId).not.toBe(firstLeaseId);
    expect(dispatchHeld).toHaveBeenCalledTimes(2);

    holds[0]!.release();
    await holds[0]!.promise;
    await coordinator.touch(ref);
    expect(dispatchHeld).toHaveBeenCalledTimes(2);
    holds[1]!.release();
  });

  it("aborts the host transport when the coordinator closes", async () => {
    let holderAttached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    let observedSignal!: AbortSignal;
    const dispatchHeldWithSignal = vi.fn(async (_ref, signal: AbortSignal): Promise<void> => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const coordinator = new EvalKernelLeaseCoordinator(
      {
        dispatch,
        dispatchHeld: vi.fn(),
        dispatchHeldWithSignal,
      },
      { onError: vi.fn() }
    );

    await coordinator.touch(ref);
    await coordinator.close();

    expect(dispatchHeldWithSignal).toHaveBeenCalledOnce();
    expect(observedSignal.aborted).toBe(true);
  });

  it("does not report the expected held-request rejection during shutdown", async () => {
    let holderAttached = false;
    const onError = vi.fn();
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        const lease = input as { leaseId: string };
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached };
      }
      if (method === "attachKernelLeaseHolder") {
        holderAttached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dispatchHeldWithSignal = vi.fn(
      async (_ref, signal: AbortSignal): Promise<void> =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), {
            once: true,
          });
        })
    );
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeld: vi.fn(), dispatchHeldWithSignal },
      { onError }
    );

    await coordinator.touch(ref);
    await coordinator.close();

    expect(onError).not.toHaveBeenCalled();
  });

  it("quiesces a touch that was already acquiring during close", async () => {
    let releaseAcquire!: () => void;
    const acquire = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let attached = false;
    const dispatch = vi.fn(async (_ref, method: string, input: unknown) => {
      if (method === "acquireKernelLease") {
        await acquire;
        const lease = input as { leaseId: string };
        return { leaseId: lease.leaseId, expiresAt: 1, holderAttached: false };
      }
      if (method === "attachKernelLeaseHolder") {
        attached = true;
        return { attached: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dispatchHeldWithSignal = vi.fn(async (): Promise<void> => undefined);
    const coordinator = new EvalKernelLeaseCoordinator({
      dispatch,
      dispatchHeld: vi.fn(),
      dispatchHeldWithSignal,
    });

    const touch = coordinator.touch(ref);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const closing = coordinator.close();

    releaseAcquire();
    await expect(touch).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(attached).toBe(false);
    expect(dispatchHeldWithSignal).not.toHaveBeenCalled();
  });
});
