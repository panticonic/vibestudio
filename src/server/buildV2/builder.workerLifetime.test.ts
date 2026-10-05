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
});
