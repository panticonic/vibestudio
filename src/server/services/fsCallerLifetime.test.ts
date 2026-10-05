import { describe, expect, it, vi } from "vitest";
import { FsCallerLifetime, joinFsCleanup } from "./fsCallerLifetime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("filesystem caller ownership", () => {
  it("joins admitted work before cleanup and denies new admissions while retiring", async () => {
    const lifetime = new FsCallerLifetime();
    const work = deferred<number>();
    const cleanup = vi.fn(async () => {});
    const call = lifetime.run(["owner"], () => work.promise);
    const retired = lifetime.retire("owner", cleanup);
    expect(lifetime.retire("owner", cleanup)).toBe(retired);
    expect(() => lifetime.run(["owner"], async () => 2)).toThrow(/retiring/);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    work.resolve(1);
    await expect(call).resolves.toBe(1);
    await retired;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("joins a delegated call when either actual owner retires", async () => {
    const lifetime = new FsCallerLifetime();
    const work = deferred<void>();
    const cleanups = [vi.fn(async () => {}), vi.fn(async () => {})];
    const call = lifetime.run(["extension", "agent"], () => work.promise);
    const retirements = cleanups.map((cleanup, i) =>
      lifetime.retire(i ? "agent" : "extension", cleanup)
    );
    await Promise.resolve();
    for (const cleanup of cleanups) expect(cleanup).not.toHaveBeenCalled();
    work.resolve();
    await call;
    await Promise.all(retirements);
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
  });

  it("retains failed ownership and propagates the original error until explicit cleanup succeeds", async () => {
    const lifetime = new FsCallerLifetime();
    const original = new Error("native close failed");
    await expect(
      lifetime.retire("owner", async () => {
        throw original;
      })
    ).rejects.toBe(original);
    expect(() => lifetime.run(["owner"], async () => 1)).toThrow(/retiring/);
    await lifetime.retire("owner", async () => {});
    await expect(lifetime.run(["owner"], async () => 1)).resolves.toBe(1);
  });

  it("shutdown joins work for every owner before reporting cleanup failure", async () => {
    const lifetime = new FsCallerLifetime();
    const work = deferred<void>();
    const original = new Error("one owner's close failed");
    const pending = lifetime.run(["slow"], () => work.promise);
    await lifetime.run(["failed"], async () => {});
    const cleanup = vi.fn(async (owner: string) => {
      if (owner === "failed") throw original;
    });
    const shutdown = lifetime.stop(cleanup);
    const observed = shutdown.catch((error) => error);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    expect(lifetime.stop(cleanup)).toBe(shutdown);
    expect(() => lifetime.run(["new"], async () => {})).toThrow(/stopping/);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    work.resolve();
    await pending;
    expect(await observed).toBe(original);
    expect(cleanup.mock.calls.map(([owner]) => owner).sort()).toEqual(["failed", "slow"]);
    await lifetime.stop(async () => {});
  });

  it("delivers a call's failure to its caller without preventing retirement", async () => {
    const lifetime = new FsCallerLifetime();
    const original = new Error("open failed");
    const call = lifetime.run(["owner"], async () => {
      throw original;
    });
    const retired = lifetime.retire("owner", async () => {});
    await expect(call).rejects.toBe(original);
    await retired;
  });

  it("joins every close before aggregating distinct original failures", async () => {
    const last = deferred<void>();
    const first = new Error("first");
    const second = new Error("second");
    const cleanup = joinFsCleanup([
      Promise.reject(first),
      Promise.reject(first),
      Promise.reject(second),
      last.promise,
    ]);
    const observed = cleanup.catch((error) => error);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    last.resolve();
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([first, second]);
  });
});
