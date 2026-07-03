import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VcsGcScheduler } from "./vcsGcScheduler.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";

describe("VcsGcScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs GC after the initial delay and then periodically", async () => {
    const runGc = vi.fn(async () => ({
      keptStates: 0,
      sweptStates: 0,
      sweptManifests: 0,
      sweptFileVersions: 0,
      sweptBlobs: 0,
      sweptTreeObjects: 0,
    }));
    const scheduler = new VcsGcScheduler({
      workspaceVcs: { attached: true, runGc } as Pick<WorkspaceVcs, "attached" | "runGc">,
      initialDelayMs: 25,
      intervalMs: 100,
      minAgeMs: 1234,
    });

    scheduler.start();
    expect(runGc).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(runGc).toHaveBeenCalledTimes(1);
    expect(runGc).toHaveBeenLastCalledWith({ minAgeMs: 1234 });

    await vi.advanceTimersByTimeAsync(100);
    expect(runGc).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("skips runs until the VCS store is attached", async () => {
    let attached = false;
    const runGc = vi.fn(async () => ({
      keptStates: 0,
      sweptStates: 0,
      sweptManifests: 0,
      sweptFileVersions: 0,
      sweptBlobs: 0,
      sweptTreeObjects: 0,
    }));
    const scheduler = new VcsGcScheduler({
      workspaceVcs: {
        get attached() {
          return attached;
        },
        runGc,
      } as Pick<WorkspaceVcs, "attached" | "runGc">,
      initialDelayMs: 10,
      intervalMs: 50,
      minAgeMs: 2000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(runGc).not.toHaveBeenCalled();

    attached = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(runGc).toHaveBeenCalledTimes(1);
    expect(runGc).toHaveBeenLastCalledWith({ minAgeMs: 2000 });
    scheduler.stop();
  });
});
