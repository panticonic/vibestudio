import { describe, expect, it, vi } from "vitest";
import { RootBootstrapInviteLifecycle } from "./rootBootstrapInviteLifecycle.js";

describe("RootBootstrapInviteLifecycle", () => {
  it("rotates an expired invite until a root claims the server", async () => {
    let now = 1_000;
    let rootExists = false;
    let sequence = 0;
    let scheduled: (() => void) | null = null;
    const publish = vi.fn();
    const lifecycle = new RootBootstrapInviteLifecycle({
      hasRoot: () => rootExists,
      createPairing: () => ({ id: ++sequence, expiresAt: now + 60_000 }),
      armPairing: async (pairing) => ({ id: pairing.id, expiresAt: pairing.expiresAt }),
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

    await expect(lifecycle.start()).resolves.toMatchObject({ id: 1 });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }));

    now += 60_000;
    const renew = scheduled;
    expect(renew).not.toBeNull();
    await (renew as unknown as () => Promise<void>)();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }))
    );

    rootExists = true;
    lifecycle.complete();
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(scheduled).toBeNull();
  });

  it("retries a failed renewal without publishing an unusable invite", async () => {
    let sequence = 0;
    let scheduled: (() => void) | null = null;
    const publish = vi.fn();
    const onRenewalError = vi.fn();
    const lifecycle = new RootBootstrapInviteLifecycle({
      hasRoot: () => false,
      createPairing: () => ({ id: ++sequence, expiresAt: 2_000 }),
      armPairing: async (pairing) => {
        if (pairing.id === 2) throw new Error("signaling unavailable");
        return { id: pairing.id };
      },
      cancelPairing: async () => undefined,
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
    expect(scheduled).not.toBeNull();
    (scheduled as unknown as () => void)();
    await vi.waitFor(() => expect(onRenewalError).toHaveBeenCalledWith(expect.any(Error)));
    expect(publish).toHaveBeenCalledTimes(1);

    expect(scheduled).not.toBeNull();
    (scheduled as unknown as () => void)();
    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith({ id: 3 }));
    lifecycle.stop();
  });
});
