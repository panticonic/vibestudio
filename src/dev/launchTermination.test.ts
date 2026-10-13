import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  LaunchTerminated,
  LaunchTermination,
  joinProducer,
  runOwnedChild,
} from "./launchTermination.js";

describe("LaunchTermination", () => {
  it("turns the first termination signal into one cancellation", () => {
    const processLike = new EventEmitter();
    const termination = new LaunchTermination(processLike);
    const stop = vi.fn();
    termination.onRequest(stop);
    expect(termination.requested).toBeNull();

    processLike.emit("SIGHUP");
    processLike.emit("SIGINT");

    expect(termination.requested).toBe("SIGHUP");
    expect(termination.signal.reason).toBeInstanceOf(LaunchTerminated);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith("SIGHUP");
  });

  it("stops a resource registered after the request at once", () => {
    const processLike = new EventEmitter();
    const termination = new LaunchTermination(processLike);
    processLike.emit("SIGTERM");
    const stop = vi.fn();
    termination.onRequest(stop);
    expect(stop).toHaveBeenCalledWith("SIGTERM");
  });

  it("restores the default signal actions when its scope ends", () => {
    const processLike = new EventEmitter();
    const termination = new LaunchTermination(processLike);
    expect(processLike.listenerCount("SIGHUP")).toBe(1);
    termination.dispose();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(processLike.listenerCount(signal)).toBe(0);
    }
  });
});

describe("runOwnedChild", () => {
  it("stops a running child on termination and settles only after it exited", async () => {
    const processLike = new EventEmitter();
    const termination = new LaunchTermination(processLike);
    const child = runOwnedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: process.env,
      termination,
    });
    processLike.emit("SIGHUP");
    await expect(child).rejects.toBeInstanceOf(LaunchTerminated);
  });

  it("does not start a child once termination was requested", async () => {
    const processLike = new EventEmitter();
    const termination = new LaunchTermination(processLike);
    processLike.emit("SIGINT");
    await expect(
      runOwnedChild(process.execPath, ["-e", ""], { env: process.env, termination })
    ).rejects.toBeInstanceOf(LaunchTerminated);
  });

  it("reports a child's own failure", async () => {
    await expect(
      runOwnedChild(process.execPath, ["-e", "process.exit(3)"], { env: process.env })
    ).rejects.toThrow("exited with code 3");
  });
});

describe("joinProducer", () => {
  it("joins a producer whose own outcome was a failure without reporting a retirement failure", async () => {
    const stop = vi.fn(() => Promise.reject(new Error("terminated by SIGHUP")));
    await expect(joinProducer({ stop })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("has nothing to join before a producer started", async () => {
    await expect(joinProducer(undefined)).resolves.toBeUndefined();
  });
});
