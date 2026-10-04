import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { attemptCleanup, ownChild } from "./ownedChild.js";

function child() {
  const process = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return { process, owner: ownChild(process as unknown as ChildProcess) };
}

it("joins close rather than exit before declaring child retirement", async () => {
  const { process, owner } = child();
  let joined = false;
  const retiring = owner.retire().then(() => {
    joined = true;
  });
  expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  process.exitCode = 0;
  process.emit("exit", 0, null);
  await Promise.resolve();
  expect(joined).toBe(false);
  process.emit("close", 0, null);
  await retiring;
});
it("retains a close already observed before cleanup starts", async () => {
  const { process, owner } = child();
  process.emit("close", 0, null);
  await owner.retire();
  expect(process.kill).not.toHaveBeenCalled();
});
it("propagates original signal refusal without pretending the child closed", async () => {
  const { process, owner } = child();
  const original = new Error("original permission refusal");
  process.kill.mockImplementation(() => {
    process.emit("error", original);
    return false;
  });
  await expect(owner.retire()).rejects.toBe(original);
});
it("propagates original synchronous signal failure", async () => {
  const { process, owner } = child();
  const original = new Error("original kill failure");
  process.kill.mockImplementation(() => {
    throw original;
  });
  await expect(owner.retire()).rejects.toBe(original);
});
it("attempts and joins independent cleanup while preserving original failures", async () => {
  const original = new Error("original resource cleanup failure");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const independent = vi.fn(async () => {
    await gate;
  });
  const cleanup = attemptCleanup([
    () => {
      throw original;
    },
    independent,
  ]);
  void cleanup.catch(() => undefined);
  await Promise.resolve();
  expect(independent).toHaveBeenCalledOnce();
  release();
  await expect(cleanup).rejects.toBe(original);
});
