import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { forwardTerminationSignals, holdThroughTerminationSignals } from "./terminationSignals.js";

const asProcess = (emitter: EventEmitter) => emitter as unknown as NodeJS.Process;

describe("termination signals", () => {
  it("hands a signal to the child that owns the work, instead of ending this process", () => {
    const target = new EventEmitter();
    const child = { kill: vi.fn(() => true) };
    const release = forwardTerminationSignals(child, asProcess(target));

    target.emit("SIGTERM", "SIGTERM");
    target.emit("SIGINT", "SIGINT");
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);

    release();
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGHUP")).toBe(0);
  });

  it("holds this process through signals while it retires what it owns, then lets go", () => {
    const target = new EventEmitter();
    const retiring = vi.fn();
    const release = holdThroughTerminationSignals(retiring, asProcess(target));

    target.emit("SIGHUP", "SIGHUP");
    expect(retiring).toHaveBeenCalledTimes(1);

    release();
    expect(target.listenerCount("SIGHUP")).toBe(0);
  });
});
