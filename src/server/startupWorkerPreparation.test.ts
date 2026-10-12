import { describe, expect, it, vi } from "vitest";
import type { BuildSystemV2, BuildUnitCatalogEntry } from "./buildV2/index.js";
import type { StoredBuildResult } from "./buildV2/buildStore.js";
import { prepareStartupWorkers, type StartupWorkerBuilds } from "./startupWorkerPreparation.js";

const units = ["workers/one", "workers/two"].map((unitPath) => ({
  unitPath,
  unitName: unitPath,
  kind: "worker",
  stateHash: "state:original",
  effectiveVersion: "ev",
  manifest: { durable: { classes: [{ className: "WorkerOwner" }] } },
})) as BuildUnitCatalogEntry[];

function setup() {
  const listBuildUnits = vi.fn<BuildSystemV2["listBuildUnits"]>().mockResolvedValue(units);
  const storedBuild: StoredBuildResult = {
    dir: "/cache/builds/build-key",
    buildKey: "build-key",
    sourceStateHash: null,
    metadata: {
      kind: "worker",
      name: "workers/one",
      buildKey: "build-key",
      sourcePath: null,
      ev: "ev-worker",
      sourceStateHash: null,
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [],
  };
  const getStoredBuild = vi
    .fn<StartupWorkerBuilds["getStoredBuild"]>()
    .mockResolvedValue(storedBuild);
  return { listBuildUnits, getStoredBuild, storedBuild };
}

function setupPreparation() {
  return vi
    .fn<(build: StoredBuildResult, classes: readonly string[]) => Promise<void>>()
    .mockResolvedValue(undefined);
}

describe("startup worker preparation", () => {
  it("prepares workers at the discovered immutable frontier with speculative priority", async () => {
    const builds = setup();
    const prepare = setupPreparation();
    await prepareStartupWorkers(builds, prepare, new AbortController().signal);
    expect(prepare.mock.calls).toEqual([
      [builds.storedBuild, ["WorkerOwner"]],
      [builds.storedBuild, ["WorkerOwner"]],
    ]);
    expect(builds.getStoredBuild.mock.calls).toEqual([
      ["workers/one", "state:original", { priority: "speculative" }],
      ["workers/two", "state:original", { priority: "speculative" }],
    ]);
  });

  it("joins schema preparation on shutdown and does not admit another worker", async () => {
    const builds = setup();
    const lifetime = new AbortController();
    const prepare = setupPreparation();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    prepare.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    let settled = false;
    const pending = prepareStartupWorkers(builds, prepare, lifetime.signal).catch((error) => {
      settled = true;
      return error;
    });
    await started;
    const shutdown = new Error("shutdown");
    lifetime.abort(shutdown);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await pending).toBe(shutdown);
    expect(builds.getStoredBuild).toHaveBeenCalledTimes(1);
  });

  it("joins admitted work on shutdown and admits no further builds", async () => {
    const builds = setup();
    const lifetime = new AbortController();
    let finish!: () => void;
    builds.getStoredBuild.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(builds.storedBuild);
        })
    );
    let settled = false;
    const pending = prepareStartupWorkers(builds, setupPreparation(), lifetime.signal);
    const result = pending.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(builds.getStoredBuild).toHaveBeenCalledTimes(1));
    const shutdown = new Error("shutdown");
    lifetime.abort(shutdown);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await result).toBe(shutdown);
    expect(builds.getStoredBuild).toHaveBeenCalledTimes(1);
  });

  it("retains the original schema failure while preparing independent workers", async () => {
    const builds = setup();
    const prepare = setupPreparation();
    const failure = new Error("schema admission refused");
    prepare.mockRejectedValueOnce(failure);
    const result = await prepareStartupWorkers(builds, prepare, new AbortController().signal).catch(
      (error) => error
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([failure]);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("retains the original build failure while preparing independent workers", async () => {
    const builds = setup();
    const failure = new Error("source does not compile");
    builds.getStoredBuild.mockRejectedValueOnce(failure);
    const result = await prepareStartupWorkers(
      builds,
      setupPreparation(),
      new AbortController().signal
    ).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([failure]);
    expect(builds.getStoredBuild).toHaveBeenCalledTimes(2);
  });
});
