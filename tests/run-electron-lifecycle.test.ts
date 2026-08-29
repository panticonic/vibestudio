import { describe, expect, it, vi } from "vitest";
import { createRunnerShutdown, signalExitCode } from "../scripts/run-electron-lifecycle.mjs";

function child() {
  return {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  };
}

describe("Electron development runner lifecycle", () => {
  it("exits immediately when signalled without a live Electron child", () => {
    const exit = vi.fn();
    const shutdown = createRunnerShutdown({ activeChildren: new Set(), exit });

    shutdown.request("SIGTERM");

    expect(exit).toHaveBeenCalledWith(143);
  });

  it("forwards one signal and exits after the child is reaped", () => {
    const electron = child();
    const activeChildren = new Set([electron]);
    const exit = vi.fn();
    const shutdown = createRunnerShutdown({ activeChildren, exit });

    shutdown.request("SIGINT");
    shutdown.request("SIGINT");
    expect(electron.kill).toHaveBeenCalledTimes(1);
    expect(electron.kill).toHaveBeenCalledWith("SIGINT");
    expect(exit).not.toHaveBeenCalled();

    electron.signalCode = "SIGINT";
    activeChildren.delete(electron);
    shutdown.childExited();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("force-reaps an Electron child that ignores graceful shutdown", () => {
    vi.useFakeTimers();
    try {
      const electron = child();
      const exit = vi.fn();
      const shutdown = createRunnerShutdown({
        activeChildren: new Set([electron]),
        exit,
        graceMs: 100,
      });

      shutdown.request("SIGTERM");
      vi.advanceTimersByTime(100);

      expect(electron.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(electron.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(exit).toHaveBeenCalledWith(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the runner to request application-owned graceful shutdown", () => {
    const electron = child();
    const requestGracefulStop = vi.fn();
    const shutdown = createRunnerShutdown({
      activeChildren: new Set([electron]),
      exit: vi.fn(),
      requestGracefulStop,
    });

    shutdown.request("SIGTERM");

    expect(requestGracefulStop).toHaveBeenCalledWith(electron, "SIGTERM");
    expect(electron.kill).not.toHaveBeenCalled();
  });

  it("maps conventional shell signal exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGTRAP")).toBe(133);
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode("SIGSEGV")).toBe(139);
  });
});
