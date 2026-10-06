import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProcessAdapter } from "@vibestudio/process-adapter";
import { waitForNativeJob } from "./nativeWorkspaceJob.js";

function fixture() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    postMessage: vi.fn(),
    pid: 123,
  });
  return process as typeof process & ProcessAdapter;
}

describe("waitForNativeJob", () => {
  it("keeps slow work owned until the command actually exits", async () => {
    vi.useFakeTimers();
    const process = fixture();
    const result = waitForNativeJob(process);
    const settled = vi.fn();
    void result.then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      process.emit("exit", 0);
      process.stdout.end();
      process.stderr.end();
      await result.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("joins the failed command before delivering its original error", async () => {
    const process = fixture();
    const failure = new Error("Native control failed");
    const result = waitForNativeJob(process);
    const settled = vi.fn();
    void result.then(settled, settled);
    process.emit("error", failure);
    await Promise.resolve();
    try {
      expect(settled).not.toHaveBeenCalled();
      expect(process.kill).toHaveBeenCalledOnce();
    } finally {
      process.emit("exit", null);
      process.stdout.end();
      process.stderr.end();
    }
    await expect(result).rejects.toBe(failure);
  });

  it("joins process exit when an output stream fails and closes without end", async () => {
    const process = fixture();
    const failure = new Error("Native output failed");
    const result = waitForNativeJob(process);
    const settled = vi.fn();
    void result.then(settled, settled);
    process.stdout.destroy(failure);
    process.stderr.end();
    await new Promise<void>((resolve) => process.stdout.once("close", resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledOnce();
    process.emit("exit", null);
    await expect(result).rejects.toBe(failure);
  });
  it("drains trailing stderr before reporting a failed exit", async () => {
    const process = fixture();
    const result = waitForNativeJob(process);

    process.emit("exit", 17);
    process.stderr.end("failure delivered after exit\n");
    process.stdout.end();

    await expect(result).rejects.toThrow("Native job exited 17: failure delivered after exit");
  });

  it("waits for the adapter to drain output after exit", async () => {
    vi.useFakeTimers();
    try {
      const process = fixture();
      const result = waitForNativeJob(process);
      const settled = vi.fn();
      void result.then(settled, settled);
      process.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).not.toHaveBeenCalled();

      process.stdout.write("late output");
      process.stderr.write("late diagnostics");
      expect(process.stdout.readableLength).toBeLessThan(1024);
      expect(process.stderr.readableLength).toBeLessThan(1024);

      process.stdout.end();
      process.stderr.end();
      await expect(result).resolves.toBeUndefined();
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards output and consumes errors after joining failed work without retaining buffers", async () => {
    const process = fixture();
    const result = waitForNativeJob(process);
    const failure = new Error("Native command failed");
    const rejected = expect(result).rejects.toBe(failure);
    process.emit("error", failure);
    process.stdout.write(Buffer.alloc(64 * 1024));
    process.stderr.write("late diagnostic");
    expect(() => process.emit("error", new Error("late adapter error"))).not.toThrow();
    process.emit("exit", null);
    process.stdout.end();
    process.stderr.end();
    await rejected;
    expect(process.stdout.readableLength).toBe(0);
    expect(process.stderr.readableLength).toBe(0);
    expect(() => process.emit("error", new Error("error after join"))).not.toThrow();
  });

  it("keeps consuming output that arrives after the byte limit rejects", async () => {
    const process = fixture();
    const result = waitForNativeJob(process);

    process.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    expect(process.kill).toHaveBeenCalledOnce();

    expect(process.stdout.readableLength).toBeLessThan(1024);
    expect(() => process.stdout.write("late output")).not.toThrow();
    expect(process.stdout.readableLength).toBeLessThan(1024);
    process.emit("exit", null);
    process.stdout.end();
    process.stderr.end();
    await expect(result).rejects.toThrow("Native job output exceeds byte limit");
  });
});
