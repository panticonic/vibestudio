import { describe, expect, it, vi } from "vitest";
import { signalHubGracefully, signalProcessTree } from "../scripts/cli/lib/pair-server.mjs";

describe("pair-server process lifecycle", () => {
  it("sends graceful shutdown only to the hub that owns descendant ordering", () => {
    const directKill = vi.fn(() => true);

    expect(signalHubGracefully({ pid: 321, kill: directKill }, "SIGTERM")).toBe(true);
    expect(directKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("delivers a repeated signal to the same hub pid without broadcasting it", () => {
    const directKill = vi.fn();
    const killProcess = vi.fn();

    expect(
      signalHubGracefully({ pid: 321, killed: true, kill: directKill }, "SIGINT", { killProcess })
    ).toBe(true);

    expect(killProcess).toHaveBeenCalledWith(321, "SIGINT");
    expect(killProcess).not.toHaveBeenCalledWith(-321, "SIGINT");
    expect(directKill).not.toHaveBeenCalled();
  });

  it("signals the POSIX process group even after ChildProcess.killed was set", () => {
    const directKill = vi.fn();
    const killProcess = vi.fn();

    expect(
      signalProcessTree({ pid: 321, killed: true, kill: directKill }, "SIGTERM", {
        platform: "linux",
        killProcess,
      })
    ).toBe(true);

    expect(killProcess).toHaveBeenCalledWith(-321, "SIGTERM");
    expect(directKill).not.toHaveBeenCalled();
  });

  it("falls back for a non-group child and on Windows", () => {
    const missingGroup = Object.assign(new Error("missing"), { code: "ESRCH" });
    const directKill = vi.fn(() => true);
    const killProcess = vi.fn(() => {
      throw missingGroup;
    });
    const child = { pid: 654, kill: directKill };

    expect(signalProcessTree(child, "SIGKILL", { platform: "linux", killProcess })).toBe(true);
    expect(directKill).toHaveBeenCalledWith("SIGKILL");

    directKill.mockClear();
    expect(signalProcessTree(child, "SIGINT", { platform: "win32", killProcess })).toBe(true);
    expect(directKill).toHaveBeenCalledWith("SIGINT");
  });

  it("does not hide process-group signaling failures", () => {
    const failure = Object.assign(new Error("not permitted"), { code: "EPERM" });
    expect(() =>
      signalProcessTree({ pid: 777, kill: vi.fn() }, "SIGTERM", {
        platform: "linux",
        killProcess: () => {
          throw failure;
        },
      })
    ).toThrow(failure);
  });
});
