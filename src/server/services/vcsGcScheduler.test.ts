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

  const gcResult = async () => ({
    keptStates: 0,
    sweptStates: 0,
    sweptManifests: 0,
    sweptFileVersions: 0,
    sweptBlobs: 0,
    sweptTreeObjects: 0,
  });

  type SchedulerVcs = Pick<
    WorkspaceVcs,
    "attached" | "runGc" | "reindexKnownRepos" | "pruneProvenanceSoftState"
  >;

  it("runs GC + reindex + soft-state prune after the initial delay and then periodically", async () => {
    const runGc = vi.fn(gcResult);
    const reindexKnownRepos = vi.fn(async () => {});
    const pruneProvenanceSoftState = vi.fn(async () => {});
    const scheduler = new VcsGcScheduler({
      workspaceVcs: {
        attached: true,
        runGc,
        reindexKnownRepos,
        pruneProvenanceSoftState,
      } as SchedulerVcs,
      initialDelayMs: 25,
      intervalMs: 100,
      minAgeMs: 1234,
    });

    scheduler.start();
    expect(runGc).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(runGc).toHaveBeenCalledTimes(1);
    expect(runGc).toHaveBeenLastCalledWith({ minAgeMs: 1234 });
    expect(reindexKnownRepos).toHaveBeenCalledTimes(1);
    expect(pruneProvenanceSoftState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(runGc).toHaveBeenCalledTimes(2);
    expect(reindexKnownRepos).toHaveBeenCalledTimes(2);
    expect(pruneProvenanceSoftState).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not start its initial delay until interactive startup work completes", async () => {
    let releaseStartup!: () => void;
    const startupBarrier = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const runGc = vi.fn(gcResult);
    const scheduler = new VcsGcScheduler({
      workspaceVcs: {
        attached: true,
        runGc,
        reindexKnownRepos: vi.fn(async () => {}),
        pruneProvenanceSoftState: vi.fn(async () => {}),
      } as SchedulerVcs,
      startupBarrier,
      initialDelayMs: 25,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runGc).not.toHaveBeenCalled();

    releaseStartup();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24);
    expect(runGc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runGc).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("runs the reindex + prune passes even when GC throws (independently guarded)", async () => {
    const runGc = vi.fn(async () => {
      throw new Error("gc boom");
    });
    const reindexKnownRepos = vi.fn(async () => {});
    const pruneProvenanceSoftState = vi.fn(async () => {});
    const warn = vi.fn();
    const scheduler = new VcsGcScheduler({
      workspaceVcs: {
        attached: true,
        runGc,
        reindexKnownRepos,
        pruneProvenanceSoftState,
      } as SchedulerVcs,
      initialDelayMs: 5,
      intervalMs: 100,
      logger: { warn },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(runGc).toHaveBeenCalledTimes(1);
    expect(reindexKnownRepos).toHaveBeenCalledTimes(1);
    expect(pruneProvenanceSoftState).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    scheduler.stop();
  });

  it("skips runs until the VCS store is attached", async () => {
    let attached = false;
    const runGc = vi.fn(gcResult);
    const reindexKnownRepos = vi.fn(async () => {});
    const pruneProvenanceSoftState = vi.fn(async () => {});
    const scheduler = new VcsGcScheduler({
      workspaceVcs: {
        get attached() {
          return attached;
        },
        runGc,
        reindexKnownRepos,
        pruneProvenanceSoftState,
      } as SchedulerVcs,
      initialDelayMs: 10,
      intervalMs: 50,
      minAgeMs: 2000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(runGc).not.toHaveBeenCalled();
    expect(reindexKnownRepos).not.toHaveBeenCalled();

    attached = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(runGc).toHaveBeenCalledTimes(1);
    expect(runGc).toHaveBeenLastCalledWith({ minAgeMs: 2000 });
    expect(reindexKnownRepos).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
