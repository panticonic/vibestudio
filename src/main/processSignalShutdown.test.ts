import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installProcessSignalShutdown } from "./processSignalShutdown.js";

describe("installProcessSignalShutdown", () => {
  it("enters canonical Electron quit once for termination signals", () => {
    const target = new EventEmitter();
    const quit = vi.fn();
    installProcessSignalShutdown(target, quit);

    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("enters canonical Electron quit for the development runner IPC request", () => {
    const target = new EventEmitter();
    const quit = vi.fn();
    installProcessSignalShutdown(target, quit);

    target.emit("message", { type: "vibestudio:dev-shutdown", signal: "SIGINT" });

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
