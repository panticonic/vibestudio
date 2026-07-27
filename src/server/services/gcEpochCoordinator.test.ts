import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildRetentionReport } from "../buildV2/index.js";
import { GcEpochCoordinator } from "./gcEpochCoordinator.js";

const state = (letter: string) => `state:${letter.repeat(64)}`;

function rootedBuild(key: string, sourceStateHash = state("a")) {
  return {
    buildKey: key,
    sourceStateHash,
    metadata: {
      buildKey: key,
      sourceStateHash,
      sourcePath: "panels/example",
    },
  };
}

function retention(
  rootBuildKeys: string[],
  complete = true
): BuildRetentionReport & {
  mode: "sweep";
} {
  return {
    epoch: 1,
    mode: "sweep" as const,
    complete,
    roots: rootBuildKeys.length,
    rootBuildKeys,
    storedRootBuildKeys: rootBuildKeys,
    unresolvedAuthoritativeRootBuildKeys: [],
    reachableBuilds: rootBuildKeys.length,
    unreferenced: 0,
    unreferencedBytes: 0,
    quarantined: 0,
    deleted: 0,
    retainedForGrace: 0,
    notReconstructible: 0,
    notReconstructibleDetails: [],
    providerFailures: complete ? [] : [{ provider: "app-registry", error: "offline" }],
    cleanupFailures: [],
    retainedSourceRoots: [],
  };
}

function publicationJournal() {
  let epoch = 0;
  return {
    beginEpoch: vi.fn(() => ++epoch),
    protectedBuildKeys: vi.fn(() => new Set<string>()),
    commitArtifactDeletion: vi.fn((_epoch, _buildKey, commit: () => void) => {
      commit();
      return true;
    }),
    completeEpoch: vi.fn(),
  };
}

function preparedBuild(report = retention([])) {
  const commit = vi.fn(async () => ({ ...report, mode: "sweep" as const }));
  return { epoch: report.epoch, report, commit };
}

function preparedContent() {
  const commit = vi.fn(async () => ({ scanned: 1, swept: 0, bytes: 0 }));
  return { epoch: 1, commit };
}

describe("GcEpochCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("snapshots rooted build metadata before preserving its source composition root", async () => {
    const key = "build:retained";
    const content = preparedContent();
    const prepareGc = vi.fn(async () => content);
    const build = preparedBuild(retention([key]));
    const buildSystem = {
      prepareGc: vi.fn(async () => build),
      peekBuildByKey: vi.fn(() => rootedBuild(key)),
    };
    const coordinator = new GcEpochCoordinator({
      buildSystem: buildSystem as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      minAgeMs: 123,
    });

    await expect(coordinator.runOnce()).resolves.toBe(true);
    expect(buildSystem.prepareGc).toHaveBeenCalledBefore(buildSystem.peekBuildByKey as never);
    expect(prepareGc).toHaveBeenCalledWith({
      minAgeMs: 123,
      epoch: 1,
      executionSourceRoots: [{ repoPath: "panels/example", stateHash: state("a") }],
    });
    expect(build.commit).toHaveBeenCalledOnce();
    expect(content.commit).toHaveBeenCalledOnce();
  });

  it("fails closed when a rooted build has no verified metadata", async () => {
    const prepareGc = vi.fn(async () => preparedContent());
    const build = preparedBuild(retention(["missing"]));
    const logger = { warn: vi.fn() };
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey: vi.fn(() => null),
      } as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      logger,
    });

    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(prepareGc).not.toHaveBeenCalled();
    expect(build.commit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[GcEpochCoordinator] GC run failed",
      expect.objectContaining({ message: expect.stringContaining("no verified build metadata") })
    );
  });

  it("suppresses the content sweep when a mandatory root provider fails", async () => {
    const prepareGc = vi.fn(async () => preparedContent());
    const build = preparedBuild(retention([], false));
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey: vi.fn(),
      } as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(prepareGc).not.toHaveBeenCalled();
    expect(build.commit).not.toHaveBeenCalled();
  });

  it("does not mistake an unmaterialized graph unit for a missing execution artifact", async () => {
    const content = preparedContent();
    const prepareGc = vi.fn(async () => content);
    const peekBuildByKey = vi.fn(() => null);
    const build = preparedBuild({ ...retention(["graph-only"]), storedRootBuildKeys: [] });
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey,
      } as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
    });

    await expect(coordinator.runOnce()).resolves.toBe(true);
    expect(peekBuildByKey).not.toHaveBeenCalled();
    expect(prepareGc).toHaveBeenCalledWith(
      expect.objectContaining({ executionSourceRoots: [], epoch: 1 })
    );
    expect(content.commit).toHaveBeenCalledOnce();
  });

  it("suppresses the content sweep for an unresolved authoritative artifact root", async () => {
    const prepareGc = vi.fn(async () => preparedContent());
    const build = preparedBuild({
      ...retention(["registry-owned"]),
      unresolvedAuthoritativeRootBuildKeys: ["registry-owned"],
    });
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey: vi.fn(),
      } as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(prepareGc).not.toHaveBeenCalled();
    expect(build.commit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "GC root is missing from the content store"],
    ["corrupt", "Content object missing from store"],
  ])("deletes no artifact when a retained source closure is %s", async (_condition, message) => {
    const key = "build:retained";
    const build = preparedBuild(retention([key]));
    const prepareGc = vi.fn(async () => {
      throw new Error(message);
    });
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey: vi.fn(() => rootedBuild(key)),
      } as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(prepareGc).toHaveBeenCalledOnce();
    expect(build.commit).not.toHaveBeenCalled();
  });

  it("does not sweep content when the artifact collector cannot commit cleanly", async () => {
    const build = preparedBuild(retention([]));
    build.commit.mockResolvedValue({
      ...retention([]),
      mode: "sweep",
      cleanupFailures: [{ buildKey: "broken", error: "rename failed" }],
    });
    const content = preparedContent();
    const coordinator = new GcEpochCoordinator({
      buildSystem: {
        prepareGc: vi.fn(async () => build),
        peekBuildByKey: vi.fn(),
      } as never,
      workspaceVcs: {
        attached: true,
        prepareGc: vi.fn(async () => content),
      } as never,
      publicationJournal: publicationJournal(),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(build.commit).toHaveBeenCalledOnce();
    expect(content.commit).not.toHaveBeenCalled();
  });

  it("runs periodically without overlapping epochs", async () => {
    let releaseBuildSnapshot: (() => void) | undefined;
    const buildSystem = {
      prepareGc: vi.fn(
        () =>
          new Promise<ReturnType<typeof preparedBuild>>((resolve) => {
            releaseBuildSnapshot = () => resolve(preparedBuild(retention([])));
          })
      ),
      peekBuildByKey: vi.fn(),
    };
    const prepareGc = vi.fn(async () => preparedContent());
    const coordinator = new GcEpochCoordinator({
      buildSystem: buildSystem as never,
      workspaceVcs: { attached: true, prepareGc } as never,
      publicationJournal: publicationJournal(),
      initialDelayMs: 5,
      intervalMs: 20,
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(buildSystem.prepareGc).toHaveBeenCalledOnce();
    expect(prepareGc).not.toHaveBeenCalled();
    await expect(coordinator.runOnce()).resolves.toBe(false);
    expect(buildSystem.prepareGc).toHaveBeenCalledOnce();

    releaseBuildSnapshot?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareGc).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(buildSystem.prepareGc).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });
});
