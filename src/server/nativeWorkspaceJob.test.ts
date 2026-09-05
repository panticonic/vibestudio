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
  it("drains trailing stderr before reporting a failed exit", async () => {
    const process = fixture();
    const result = waitForNativeJob(process);

    process.emit("exit", 17);
    process.stderr.end("failure delivered after exit\n");
    process.stdout.end();

    await expect(result).rejects.toThrow("Native job exited 17: failure delivered after exit");
  });

  it("bounds a command whose output streams never close after exit", async () => {
    vi.useFakeTimers();
    try {
      const process = fixture();
      const result = waitForNativeJob(process);
      process.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBeUndefined();

      process.stdout.write("late output");
      process.stderr.write("late diagnostics");
      expect(process.stdout.readableLength).toBeLessThan(1024);
      expect(process.stderr.readableLength).toBeLessThan(1024);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards output and consumes errors after timeout without retaining job buffers", async () => {
    vi.useFakeTimers();
    try {
      const process = fixture();
      const result = waitForNativeJob(process, 10);
      const rejected = expect(result).rejects.toThrow("Native job timed out");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      process.stdout.write(Buffer.alloc(64 * 1024));
      process.stderr.write("late diagnostic");
      expect(() => process.emit("error", new Error("late adapter error"))).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(process.stdout.readableLength).toBe(0);
      expect(process.stderr.readableLength).toBe(0);
      process.stdout.end();
      process.stderr.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps consuming output that arrives after the byte limit rejects", async () => {
    const process = fixture();
    const result = waitForNativeJob(process);

    process.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    await expect(result).rejects.toThrow("Native job output exceeds byte limit");

    expect(process.stdout.readableLength).toBeLessThan(1024);
    expect(() => process.stdout.write("late output")).not.toThrow();
    expect(process.stdout.readableLength).toBeLessThan(1024);
  });
});
