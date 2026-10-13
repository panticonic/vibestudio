import { describe, expect, it, vi } from "vitest";
import {
  DurableObservationStoppedError,
  observeDurableProjection,
} from "./durableObservation.js";

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
  it("admits before reading and discards a read superseded by an event", async () => {
    const admitted = deferred<void>();
    const first = deferred<string>();
    const second = deferred<string>();
    let changed!: () => void;
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
      DurableObservationStoppedError,
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
    let changed!: () => void;
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

    changed();
    await Promise.resolve();
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
    admitted.resolve();
    await first;
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
