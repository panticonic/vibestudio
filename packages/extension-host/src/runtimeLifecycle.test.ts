import { describe, expect, it, vi } from "vitest";
import { ExtensionRuntimeLifecycle } from "./runtimeLifecycle.js";
import { restoreShutdownError, shutdownError } from "./shutdownProtocol.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("extension activation shutdown ownership", () => {
  it("joins all disposers despite original failures and rejects new admission while joining", async () => {
    const lifecycle = new ExtensionRuntimeLifecycle();
    const held = gate();
    const original = new Error("Original release failed");
    const disposers = [
      {
        dispose: () => {
          throw original;
        },
      },
      { dispose: () => held.promise },
    ];
    const closing = lifecycle.shutdown(disposers);
    let settled = false;
    void closing.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(
      lifecycle.run(new AbortController().signal, async () => "new work")
    ).rejects.toThrow("shutting down");
    held.resolve();
    await expect(closing).rejects.toBe(original);
    expect(disposers).toHaveLength(1);
  });

  it("aborts and joins an admitted call including work it retains while settling", async () => {
    const lifecycle = new ExtensionRuntimeLifecycle();
    const started = gate();
    const cleanup = gate();
    const background = gate();
    const call = lifecycle.run(new AbortController().signal, async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      await cleanup.promise;
      lifecycle.retain(background.promise);
    });
    await started.promise;
    let closed = false;
    const closing = lifecycle.shutdown([]).then(() => {
      closed = true;
    });
    cleanup.resolve();
    await call;
    expect(closed).toBe(false);
    background.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  it("retries only failed disposal and never repeats successful deactivation or release", async () => {
    const lifecycle = new ExtensionRuntimeLifecycle();
    const original = new Error("Original stop refused");
    let refuse = true;
    const completed = vi.fn();
    const retry = vi.fn(() => {
      if (refuse) throw original;
    });
    const deactivate = vi.fn();
    const disposers = [{ dispose: completed }, { dispose: retry }];
    await expect(lifecycle.shutdown(disposers, deactivate)).rejects.toBe(original);
    refuse = false;
    await lifecycle.shutdown(disposers, deactivate);
    expect(completed).toHaveBeenCalledOnce();
    expect(deactivate).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(disposers).toHaveLength(0);
  });

  it("preserves original cause and independent cleanup errors across actual control serialization", () => {
    const original = new Error("Original provider stop failed");
    const aggregate = new AggregateError(
      [original, new Error("Lease close failed")],
      "Release failed",
      { cause: original }
    );
    const restored = restoreShutdownError(JSON.parse(JSON.stringify(shutdownError(aggregate))));
    expect(restored).toBeInstanceOf(AggregateError);
    expect(restored).toMatchObject({
      cause: { message: original.message },
      errors: [{ message: original.message }, { message: "Lease close failed" }],
    });
  });
});
