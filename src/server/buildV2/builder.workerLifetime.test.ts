import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { closeBuilder, initBuilder, withBuilderWorkers } from "./builder.js";
import { LibraryLoweringWorkerClient } from "./libraryLoweringWorkerClient.js";
import { WorkspaceRpcCatalogWorkerClient } from "./workspaceRpcCatalogWorkerClient.js";
import { ImmutableTreeWorkerClient } from "./immutableTreeWorkerClient.js";

afterEach(async () => {
  await closeBuilder();
  vi.restoreAllMocks();
});

describe("build-owned compiler residency", () => {
  it("closes admission, joins admitted work, then permits a new explicit lifetime", async () => {
    const appRoot = process.cwd();
    initBuilder(path.join(appRoot, "node_modules"), appRoot, async () => {
      throw new Error("unused");
    });
    const close = vi
      .spyOn(LibraryLoweringWorkerClient.prototype, "close")
      .mockResolvedValue(undefined);
    let started!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const admitted = withBuilderWorkers(async () => {
      started();
      await gate;
    });
    await workStarted;

    let retired = false;
    const retirement = closeBuilder().then(() => {
      retired = true;
    });
    await expect(withBuilderWorkers(async () => undefined)).rejects.toThrow("shutting down");
    expect(retired).toBe(false);
    finish();
    await Promise.all([admitted, retirement]);
    expect(close).toHaveBeenCalledOnce();

    initBuilder(path.join(appRoot, "node_modules"), appRoot, async () => {
      throw new Error("unused");
    });
    await expect(withBuilderWorkers(async () => "reopened")).resolves.toBe("reopened");
  });

  it("does not reinitialize until auxiliary worker retirement reaches terminal", async () => {
    const appRoot = process.cwd();
    initBuilder(path.join(appRoot, "node_modules"), appRoot, async () => {
      throw new Error("unused");
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    vi.spyOn(LibraryLoweringWorkerClient.prototype, "close").mockImplementation(async () => {
      closeStarted();
      await closeGate;
    });

    const closing = closeBuilder();
    await started;
    expect(() =>
      initBuilder(path.join(appRoot, "node_modules"), appRoot, async () => {
        throw new Error("unused");
      })
    ).toThrow("retiring");
    finishClose();
    await closing;

    expect(() =>
      initBuilder(path.join(appRoot, "node_modules"), appRoot, async () => {
        throw new Error("unused");
      })
    ).not.toThrow();
  });

  it("shares workers across overlapping closures and joins last-owner retirement", async () => {
    initBuilder(path.join(process.cwd(), "node_modules"), process.cwd(), async () => {
      throw new Error("unused");
    });
    const lowering = vi
      .spyOn(LibraryLoweringWorkerClient.prototype, "close")
      .mockResolvedValue(undefined);
    const catalog = vi
      .spyOn(WorkspaceRpcCatalogWorkerClient.prototype, "close")
      .mockResolvedValue(undefined);
    const immutable = vi
      .spyOn(ImmutableTreeWorkerClient.prototype, "close")
      .mockResolvedValue(undefined);
    let firstDone!: () => void;
    let secondDone!: () => void;
    const first = withBuilderWorkers(
      () =>
        new Promise<void>((resolve) => {
          firstDone = resolve;
        })
    );
    const second = withBuilderWorkers(
      () =>
        new Promise<void>((resolve) => {
          secondDone = resolve;
        })
    );
    // Resolve the initialization retirement before either owned operation starts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstDone();
    await first;
    expect(lowering).not.toHaveBeenCalled();
    secondDone();
    await second;
    expect(lowering).toHaveBeenCalledOnce();
    expect(catalog).toHaveBeenCalledOnce();
    expect(immutable).toHaveBeenCalledOnce();
    const failure = new Error("original build failure");
    await expect(
      withBuilderWorkers(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(lowering).toHaveBeenCalledTimes(2);
  });

  it("preserves every worker retirement error and the failed build that owned them", async () => {
    initBuilder(path.join(process.cwd(), "node_modules"), process.cwd(), async () => {
      throw new Error("unused");
    });
    const loweringFailure = new Error("lowering worker close failed");
    const catalogFailure = new Error("catalog worker close failed");
    vi.spyOn(LibraryLoweringWorkerClient.prototype, "close").mockRejectedValue(loweringFailure);
    vi.spyOn(WorkspaceRpcCatalogWorkerClient.prototype, "close").mockRejectedValue(catalogFailure);
    vi.spyOn(ImmutableTreeWorkerClient.prototype, "close").mockResolvedValue(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const buildFailure = new Error("build failed");
    let caught: unknown;
    try {
      await withBuilderWorkers(async () => {
        throw buildFailure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const combined = caught as AggregateError;
    expect(combined.errors).toEqual([
      buildFailure,
      expect.objectContaining({
        errors: [loweringFailure, catalogFailure],
        cause: loweringFailure,
      }),
    ]);
    expect(combined.cause).toBe(buildFailure);
    vi.restoreAllMocks();
  });
});
