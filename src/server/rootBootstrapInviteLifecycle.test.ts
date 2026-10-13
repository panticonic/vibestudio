import { describe, expect, it, vi } from "vitest";
import { RootBootstrapInviteLifecycle } from "./rootBootstrapInviteLifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const armed = deferred<{ id: number; ready: boolean }>();
  let sequence = 0;
  let rootExists = false;
  let scheduled: (() => void) | null = null;
  const publish = vi.fn();
  const onRenewalError = vi.fn();
  const cancelPairing = vi.fn(async () => {
    armed.reject(new Error("invitation canceled"));
  });
  const lifecycle = new RootBootstrapInviteLifecycle({
    hasRoot: () => rootExists,
    createPairing: () => ({ id: ++sequence, expiresAt: 61_000 }),
    describePairing: (pairing) => ({ id: pairing.id, ready: false }),
    armPairing: () => armed.promise,
    cancelPairing,
    publish,
    onRenewalError,
    now: () => 1_000,
    schedule: (callback) => {
      scheduled = callback;
      return () => {
        scheduled = null;
      };
    },
  });
  return {
    lifecycle,
    armed,
    publish,
    onRenewalError,
    cancelPairing,
    complete: () => {
      rootExists = true;
      lifecycle.complete();
    },
    scheduled: () => scheduled,
  };
}

describe("RootBootstrapInviteLifecycle", () => {
  it("rotates expired credentials and their reach until a root claims the server", async () => {
    let now = 1_000;
    let sequence = 0;
    let scheduled: (() => void) | null = null;
    const publish = vi.fn();
    const lifecycle = new RootBootstrapInviteLifecycle({
      hasRoot: () => false,
      createPairing: () => ({ id: ++sequence, expiresAt: now + 60_000 }),
      describePairing: (pairing) => ({ id: pairing.id, ready: false }),
      armPairing: async (pairing) => ({ id: pairing.id, ready: true }),
      cancelPairing: async () => undefined,
      publish,
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
        return () => {
          scheduled = null;
        };
      },
    });
    await lifecycle.start();
    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ id: 1, ready: true }));
    now += 60_000;
    (scheduled as unknown as () => void)();
    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ id: 2, ready: true }));
    await lifecycle.stop();
  });

  it("retires a failed renewal and retries issuance without a stale ready publication", async () => {
    let sequence = 0;
    let scheduled: (() => void) | null = null;
    const publish = vi.fn();
    const onRenewalError = vi.fn();
    const cancelPairing = vi.fn(async () => undefined);
    const lifecycle = new RootBootstrapInviteLifecycle({
      hasRoot: () => false,
      createPairing: () => ({ id: ++sequence, expiresAt: 2_000 }),
      describePairing: (pairing) => ({ id: pairing.id, ready: false }),
      armPairing: async (pairing) => {
        if (pairing.id === 2) throw new Error("endpoint destroyed");
        return { id: pairing.id, ready: true };
      },
      cancelPairing,
      publish,
      onRenewalError,
      now: () => 1_000,
      schedule: (callback) => {
        scheduled = callback;
        return () => {
          scheduled = null;
        };
      },
    });
    await lifecycle.start();
    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ id: 1, ready: true }));
    (scheduled as unknown as () => void)();
    await vi.waitFor(() => expect(onRenewalError).toHaveBeenCalled());
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(cancelPairing).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(publish).not.toHaveBeenCalledWith({ id: 2, ready: true });
    (scheduled as unknown as () => void)();
    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ id: 3, ready: true }));
    await lifecycle.stop();
  });

  it("publishes the same issued credential before remote reach, then publishes ready reach", async () => {
    const f = fixture();
    await expect(f.lifecycle.start()).resolves.toEqual({ id: 1, ready: false });
    expect(f.publish).toHaveBeenLastCalledWith({ id: 1, ready: false });
    f.armed.resolve({ id: 1, ready: true });
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith({ id: 1, ready: true }));
    await f.lifecycle.stop();
  });

  it("cancels and joins remote reach when local pairing claims root", async () => {
    const f = fixture();
    await f.lifecycle.start();
    f.complete();
    await f.lifecycle.stop();
    expect(f.cancelPairing).toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(null);
    expect(f.onRenewalError).not.toHaveBeenCalled();
    expect(f.scheduled()).toBeNull();
  });

  it("joins canceled remote work during shutdown", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.stop();
    expect(f.cancelPairing).toHaveBeenCalled();
    expect(f.onRenewalError).not.toHaveBeenCalled();
  });

  it("does not publish late reach after another local device claims root", async () => {
    const f = fixture();
    f.cancelPairing.mockImplementation(async () => undefined);
    await f.lifecycle.start();
    f.complete();
    f.armed.resolve({ id: 1, ready: true });
    await f.lifecycle.stop();
    expect(f.publish).toHaveBeenLastCalledWith(null);
    expect(f.publish).not.toHaveBeenCalledWith({ id: 1, ready: true });
    expect(f.cancelPairing).toHaveBeenCalledTimes(1);
  });

  it("retains the original reach failure and retirement failure", async () => {
    const failure = new Error("endpoint destroyed");
    const cleanup = new Error("retirement failed");
    const f = fixture();
    f.cancelPairing.mockImplementation(async () => {
      throw cleanup;
    });
    await f.lifecycle.start();
    f.armed.reject(failure);
    await vi.waitFor(() => expect(f.onRenewalError).toHaveBeenCalled());
    expect((f.onRenewalError.mock.calls[0]![0] as AggregateError).errors).toEqual([
      failure,
      cleanup,
    ]);
    expect(f.publish).toHaveBeenLastCalledWith(null);
    await expect(f.lifecycle.stop()).rejects.toThrow("Root invitation retirement failed");
  });
});
