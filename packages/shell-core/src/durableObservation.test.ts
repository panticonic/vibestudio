import { describe, expect, it, vi } from "vitest";
import { rpcCallerAbortedError } from "@vibestudio/rpc";
import { DurableObservationStoppedError, observeDurableProjection } from "./durableObservation.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("observeDurableProjection", () => {
  it.each(["admission", "read"] as const)(
    "uses the exact retiring owner's reason through pending %s",
    async (phase) => {
      const admission = deferred<void>();
      const read = deferred<string>();
      const reading = deferred<void>();
      const reason = new Error("browser quit");
      const observation = observeDurableProjection({
        listen: () => () => {},
        admit: () => admission.promise,
        read: () => {
          reading.resolve();
          return read.promise;
        },
        apply: vi.fn(),
        error: vi.fn(),
      });
      const ready = expect(observation.ready).rejects.toBe(reason);
      if (phase === "read") {
        admission.resolve();
        await reading.promise;
      }
      const stopped = observation.stop(reason);
      admission.resolve();
      read.resolve("late snapshot");
      await stopped;
      await ready;
      await expect(observation.refresh()).rejects.toBe(reason);
    }
  );

  it("joins an owned read cancellation without misclassifying it as a cleanup failure", async () => {
    const read = deferred<string>();
    const reading = deferred<void>();
    const reason = new Error("browser quit");
    const error = vi.fn();
    const observation = observeDurableProjection({
      listen: () => () => {},
      read: () => {
        reading.resolve();
        return read.promise;
      },
      apply: vi.fn(),
      error,
      leave: async () => {
        throw rpcCallerAbortedError(reason);
      },
    });
    await reading.promise;
    const ready = expect(observation.ready).rejects.toBe(reason);
    const stopped = observation.stop(reason);
    read.reject(rpcCallerAbortedError(reason));
    await stopped;
    await ready;
    expect(error).not.toHaveBeenCalled();
  });

  it("retains independent read, leave and listener failures after authoritative stop", async () => {
    const read = deferred<string>();
    const reading = deferred<void>();
    const reason = new Error("browser quit");
    const readFailure = new Error("snapshot failed independently");
    const leaveFailure = new Error("remote leave failed");
    const localFailure = new Error("local listener failed to retire");
    const observation = observeDurableProjection({
      listen: () => () => {
        throw localFailure;
      },
      read: () => {
        reading.resolve();
        return read.promise;
      },
      apply: vi.fn(),
      error: vi.fn(),
      leave: async () => {
        throw leaveFailure;
      },
    });
    await reading.promise;
    const ready = expect(observation.ready).rejects.toBe(reason);
    const rejected = expect(observation.stop(reason)).rejects.toMatchObject({
      errors: [localFailure, readFailure, leaveFailure],
    });
    read.reject(readFailure);
    await rejected;
    await ready;
  });
  it("admits before reading and discards a read superseded by an event", async () => {
    const admitted = deferred<void>();
    const first = deferred<string>();
    const second = deferred<string>();
    let changed!: () => Promise<void>;
    const apply = vi.fn();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const observation = observeDurableProjection({
      listen: (listener) => {
        changed = listener;
        return vi.fn();
      },
      admit: () => admitted.promise,
      read,
      apply,
      error: vi.fn(),
    });

    expect(read).not.toHaveBeenCalled();
    admitted.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    changed();
    first.resolve("stale");
    await Promise.resolve();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    second.resolve("current");
    await observation.ready;
    expect(apply).toHaveBeenCalledWith("current");
  });

  it("preserves admission and read failures for their owners", async () => {
    const admissionError = new Error("watch refused");
    const admissionObservation = observeDurableProjection({
      listen: () => vi.fn(),
      admit: () => Promise.reject(admissionError),
      read: vi.fn(),
      apply: vi.fn(),
      error: vi.fn(),
    });
    await expect(admissionObservation.ready).rejects.toBe(admissionError);

    const readError = new Error("snapshot failed");
    const error = vi.fn();
    const readObservation = observeDurableProjection({
      listen: () => vi.fn(),
      read: () => Promise.reject(readError),
      apply: vi.fn(),
      error,
    });
    await expect(readObservation.ready).rejects.toBe(readError);
    expect(error).toHaveBeenCalledWith(readError);
  });

  it("retires an attempted watch after admission rejects", async () => {
    const failure = new Error("watch refused");
    const leave = vi.fn().mockResolvedValue(undefined);
    const observation = observeDurableProjection({
      listen: () => vi.fn(),
      admit: () => Promise.reject(failure),
      leave,
      read: vi.fn(),
      apply: vi.fn(),
      error: vi.fn(),
    });
    await expect(observation.ready).rejects.toBe(failure);
    await expect(observation.stop()).rejects.toBe(failure);
    expect(leave).toHaveBeenCalledOnce();
  });

  it("rejects refresh receipts and joins read and leave during retirement", async () => {
    const read = deferred<string>();
    const leave = deferred<void>();
    const observation = observeDurableProjection({
      listen: () => vi.fn(),
      admit: () => Promise.resolve(),
      leave: () => leave.promise,
      read: () => read.promise,
      apply: vi.fn(),
      error: vi.fn(),
    });
    await Promise.resolve();
    const stoppedReady = expect(observation.ready).rejects.toBeInstanceOf(
      DurableObservationStoppedError
    );
    const stopping = observation.stop();
    let retired = false;
    void stopping.then(() => {
      retired = true;
    });
    leave.resolve();
    await Promise.resolve();
    expect(retired).toBe(false);
    read.resolve("late");
    await stopping;
    await stoppedReady;
    expect(retired).toBe(true);
  });

  it("ignores a captured listener after retirement", async () => {
    let changed!: () => Promise<void>;
    const read = vi.fn(async () => "current");
    const observation = observeDurableProjection({
      listen: (listener) => {
        changed = listener;
        return () => undefined;
      },
      read,
      apply: vi.fn(),
      error: vi.fn(),
    });
    await observation.ready;
    await observation.stop();

    await changed();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves exactly once when stopped before admission completes", async () => {
    const admitted = deferred<void>();
    const leave = vi.fn().mockResolvedValue(undefined);
    const observation = observeDurableProjection({
      listen: () => vi.fn(),
      admit: () => admitted.promise,
      leave,
      read: vi.fn(),
      apply: vi.fn(),
      error: vi.fn(),
    });
    const first = observation.stop();
    const second = observation.stop();
    expect(first).toBe(second);
    const stoppedReady = expect(observation.ready).rejects.toBeInstanceOf(
      DurableObservationStoppedError
    );
    admitted.resolve();
    await first;
    await stoppedReady;
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
