import { describe, expect, it, vi } from "vitest";
import { ConnectionSupervisor } from "./connectionSupervisor.js";
import type { ConnectionProcessExit, ConnectionProcessHandle } from "./connectionProcess.js";

function process() {
  let exit!: (value: ConnectionProcessExit) => void;
  const exited = new Promise<ConnectionProcessExit>((resolve) => (exit = resolve));
  const handle = {
    channel: {} as never,
    exited,
    dispose: vi.fn(async () => {
      exit({ code: 0, requested: true, reason: "stopped" });
      return exited;
    }),
  } satisfies ConnectionProcessHandle;
  return {
    handle,
    crash: (code = 11) =>
      exit({ code, requested: false, reason: `exited unexpectedly (code ${code})` }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(reestablish: (next: ConnectionProcessHandle) => Promise<void> = async () => {}) {
  const processes = [process()];
  const events: string[] = [];
  const deps = {
    launch: vi.fn(() => {
      const next = process();
      processes.push(next);
      events.push("launch");
      return next.handle;
    }),
    reestablish: vi.fn(async (next: ConnectionProcessHandle) => {
      events.push("reestablish");
      await reestablish(next);
    }),
    lost: vi.fn(() => void events.push("lost")),
    restored: vi.fn(() => void events.push("restored")),
    failed: vi.fn(() => void events.push("failed")),
  };
  const supervisor = new ConnectionSupervisor(deps, processes[0]!.handle);
  return { supervisor, processes, deps, events };
}

describe("ConnectionSupervisor", () => {
  it("replaces a process that exited unexpectedly, in order, and watches the replacement", async () => {
    const { supervisor, processes, deps, events } = setup();
    processes[0]!.crash();
    await settle();
    expect(events).toEqual(["lost", "launch", "reestablish", "restored"]);
    expect(supervisor.handle).toBe(processes[1]!.handle);
    processes[1]!.crash(12);
    await settle();
    expect(deps.launch).toHaveBeenCalledTimes(2);
    expect(supervisor.handle).toBe(processes[2]!.handle);
  });

  it("does not restart a process it was asked to stop", async () => {
    const { supervisor, deps } = setup();
    await supervisor.dispose();
    await settle();
    expect(deps.lost).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("reports a replacement that cannot establish, stops it, and does not retry", async () => {
    const failure = new Error("exited unexpectedly (code 1)");
    const { processes, deps, events } = setup(async () => {
      throw failure;
    });
    processes[0]!.crash();
    await settle();
    expect(events).toEqual(["lost", "launch", "reestablish", "failed"]);
    expect(deps.failed).toHaveBeenCalledWith(failure, expect.objectContaining({ code: 11 }));
    expect(processes[1]!.handle.dispose).toHaveBeenCalled();
    await settle();
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it("recovers from a replacement that exits right after it was established", async () => {
    const { processes, deps } = setup(async () => {
      processes[1]!.crash(5);
    });
    processes[0]!.crash();
    await settle();
    expect(deps.launch).toHaveBeenCalledTimes(2);
    expect(deps.restored).toHaveBeenCalled();
  });
});
