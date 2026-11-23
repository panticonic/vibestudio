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
    const dispatchHeldWithSignal = vi.fn().mockReturnValue(held);
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeldWithSignal },
      { idleMs: 123_000, onError: vi.fn() }
    );

    await coordinator.touch(ref);
    await coordinator.touch(ref);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(1);
    const first = dispatch.mock.calls[0]![2] as { leaseId: string; idleMs: number };
    const second = dispatch.mock.calls[2]![2] as { leaseId: string; idleMs: number };
    expect(first).toEqual({ leaseId: expect.any(String), idleMs: 123_000 });
    expect(second).toEqual(first);
    expect(dispatchHeldWithSignal).toHaveBeenCalledWith(
      ref,
      expect.any(AbortSignal),
      "holdKernelLease",
      first.leaseId
    );

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
    const dispatchHeldWithSignal = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeldWithSignal },
      { onError: vi.fn() }
    );

    await Promise.all([coordinator.touch(ref), coordinator.touch(ref), coordinator.touch(ref)]);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(1);
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
    const dispatchHeldWithSignal = vi
      .fn()
      .mockImplementationOnce(() => {
        holderAttached = false;
        return Promise.reject(new Error("workerd restarted"));
      })
      .mockReturnValueOnce(new Promise<void>(() => undefined));
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeldWithSignal },
      { onError }
    );

    await coordinator.touch(ref);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await coordinator.touch(ref);

    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2);
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
    const dispatchHeldWithSignal = vi.fn(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ promise, release });
      return promise;
    });
    const coordinator = new EvalKernelLeaseCoordinator(
      { dispatch, dispatchHeldWithSignal },
      { onError: vi.fn() }
    );

    await coordinator.touch(ref);
    const firstLeaseId = activeLeaseId;
    holderAttached = false;
    await coordinator.touch(ref);
    const replacementLeaseId = activeLeaseId;

    expect(replacementLeaseId).not.toBe(firstLeaseId);
    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2);

    holds[0]!.release();
    await holds[0]!.promise;
    await coordinator.touch(ref);
    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2);
    holds[1]!.release();
  });

  it("aborts and joins the held host request when the coordinator closes", async () => {
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
    let markCancellationDelivered!: () => void;
    const cancellationDelivered = new Promise<void>((resolve) => {
      markCancellationDelivered = resolve;
    });
    let releaseTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const dispatchHeldWithSignal = vi.fn(async (_ref, signal: AbortSignal): Promise<void> => {
      observedSignal = signal;
      signal.addEventListener("abort", markCancellationDelivered, { once: true });
      await terminal;
    });
    const coordinator = new EvalKernelLeaseCoordinator(
      {
        dispatch,
        dispatchHeldWithSignal,
      },
      { onError: vi.fn() }
    );

    await coordinator.touch(ref);
    let closeSettled = false;
    const closing = coordinator.close().then(
      () => {
        closeSettled = true;
      },
      (error: unknown) => {
        closeSettled = true;
        throw error;
      }
    );
    try {
      await cancellationDelivered;
      expect(observedSignal.aborted).toBe(true);
      expect(closeSettled).toBe(false);
      releaseTerminal();
      await closing;
      expect(closeSettled).toBe(true);
    } finally {
      releaseTerminal();
      await closing;
    }

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
      { dispatch, dispatchHeldWithSignal },
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

it("closes after a failed holder attach instead of retaining an admission with no settlement", async () => {
  const dispatch = vi.fn(async (_ref, method: string) => {
    if (method === "acquireKernelLease")
      return { leaseId: "lease", expiresAt: 1, holderAttached: false };
    throw new Error("native attach failed");
  });
  const held = vi.fn();
  const coordinator = new EvalKernelLeaseCoordinator({ dispatch, dispatchHeldWithSignal: held });
  await expect(coordinator.touch(ref)).rejects.toThrow("native attach failed");
  await expect(coordinator.close()).resolves.toBeUndefined();
  expect(held).not.toHaveBeenCalled();
});

it("aborts a superseded hold and still joins its native settlement on close", async () => {
  let holderAttached = false;
  const dispatch = vi.fn(async (_ref, method: string) => {
    if (method === "acquireKernelLease") return { leaseId: "lease", expiresAt: 1, holderAttached };
    holderAttached = true;
    return { attached: true };
  });
  const holds: Array<{ signal: AbortSignal; release: () => void }> = [];
  const dispatchHeldWithSignal = vi.fn(
    (_ref, signal: AbortSignal) =>
      new Promise<void>((release) => {
        holds.push({ signal, release });
      })
  );
  const coordinator = new EvalKernelLeaseCoordinator({ dispatch, dispatchHeldWithSignal });
  await coordinator.touch(ref);
  holderAttached = false;
  await coordinator.touch(ref);
  expect(holds).toHaveLength(2);
  expect(holds[0]!.signal.aborted).toBe(true);
  let closed = false;
  const closing = coordinator.close().then(() => {
    closed = true;
  });
  holds[1]!.release();
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  holds[0]!.release();
  await closing;
  expect(closed).toBe(true);
});

it("retains and aborts the old native hold when refresh fails", async () => {
  let fail = false;
  const dispatch = vi.fn(async (_ref, method: string) => {
    if (fail) throw new Error("native acquire failed");
    return method === "acquireKernelLease"
      ? { leaseId: "lease", expiresAt: 1, holderAttached: false }
      : { attached: true };
  });
  let signal!: AbortSignal, release!: () => void;
  const dispatchHeldWithSignal = vi.fn((_ref, observed: AbortSignal) => {
    signal = observed;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const coordinator = new EvalKernelLeaseCoordinator({ dispatch, dispatchHeldWithSignal });
  await coordinator.touch(ref);
  fail = true;
  await expect(coordinator.touch(ref)).rejects.toThrow("native acquire failed");
  expect(signal.aborted).toBe(true);
  let closed = false;
  const closing = coordinator.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await closing;
});
