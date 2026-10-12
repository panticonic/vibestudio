import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBuilderWorkers } from "./builder.js";
import { createBuilderTestSession } from "./builderTestSession.js";
import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import { LibraryLoweringWorkerClient } from "./libraryLoweringWorkerClient.js";
import { WorkspaceRpcCatalogWorkerClient } from "./workspaceRpcCatalogWorkerClient.js";
import { ImmutableTreeWorkerClient } from "./immutableTreeWorkerClient.js";
import { materializeImmutableTree } from "./immutableTreeMaterializer.js";

const contexts: Array<Awaited<ReturnType<typeof createBuilderTestSession>>> = [];
const roots: string[] = [];

async function openSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-builder-lifetime-"));
  roots.push(root);
  const context = await createBuilderTestSession({
    appRoot: process.cwd(),
    workspaceRoot: root,
    stateRoot: path.join(root, "state"),
    runNativeJob: runIsolatedBuildJob,
  });
  contexts.push(context);
  return context;
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const context of contexts.splice(0)) {
    try {
      await context.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Builder lifetime fixture cleanup failed");
});

describe("build-owned compiler residency", () => {
  it("joins cached readers to the producer's dependency projection before they can replace it", async () => {
    const context = await openSession();
    const root = roots.at(-1)!;
    const source = path.join(root, "dependencies");
    const target = path.join(root, "build", "node_modules");
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, "package.js"), "installed");
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const producer = context.processOwner.projectExtensionRuntimeDeps(target, async () => {
      started();
      await gate;
      await materializeImmutableTree(source, target);
    });
    await admitted;
    const cachedProjection = vi.fn(async () => {
      await fs.promises.rm(target, { recursive: true, force: true });
      throw new Error("cached reader must not replace an active projection");
    });
    const reader = context.processOwner.projectExtensionRuntimeDeps(target, cachedProjection);
    complete();
    await Promise.all([producer, reader]);
    expect(cachedProjection).not.toHaveBeenCalled();
    await expect(fs.promises.readFile(path.join(target, "package.js"), "utf8")).resolves.toBe(
      "installed"
    );
  });

  it("closes admission and joins admitted work before process-owned worker retirement", async () => {
    const context = await openSession();
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
    const admitted = withBuilderWorkers(context.session, async () => {
      started();
      await gate;
    });
    await workStarted;

    let retired = false;
    const retirement = context.processOwner.shutdown().then(() => {
      retired = true;
    });
    await expect(withBuilderWorkers(context.session, async () => undefined)).rejects.toThrow(
      "shutting down"
    );
    expect(retired).toBe(false);
    finish();
    await Promise.all([admitted, retirement]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps each process owner closed after auxiliary worker retirement", async () => {
    const context = await openSession();
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

    const closing = context.processOwner.shutdown();
    await started;
    await expect(withBuilderWorkers(context.session, async () => undefined)).rejects.toThrow(
      "shutting down"
    );
    finishClose();
    await closing;
    await expect(context.processOwner.withWorkers(async () => "closed")).rejects.toThrow(
      "shutting down"
    );
  });

  it("shares workers across overlapping operations and joins every worker on shutdown", async () => {
    const context = await openSession();
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
      context.session,
      () => new Promise<void>((resolve) => (firstDone = resolve))
    );
    const second = withBuilderWorkers(
      context.session,
      () => new Promise<void>((resolve) => (secondDone = resolve))
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstDone();
    await first;
    expect(lowering).not.toHaveBeenCalled();
    secondDone();
    await second;
    await context.processOwner.shutdown();
    expect(lowering).toHaveBeenCalledOnce();
    expect(catalog).toHaveBeenCalledOnce();
    expect(immutable).toHaveBeenCalledOnce();
  });

  it("preserves every worker retirement error and the failed build that owned them", async () => {
    const context = await openSession();
    const loweringFailure = new Error("lowering worker close failed");
    const catalogFailure = new Error("catalog worker close failed");
    vi.spyOn(LibraryLoweringWorkerClient.prototype, "close").mockRejectedValue(loweringFailure);
    vi.spyOn(WorkspaceRpcCatalogWorkerClient.prototype, "close").mockRejectedValue(catalogFailure);
    vi.spyOn(ImmutableTreeWorkerClient.prototype, "close").mockResolvedValue(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const buildFailure = new Error("build failed");
    await expect(
      context.processOwner.withWorkers(async () => {
        throw buildFailure;
      })
    ).rejects.toMatchObject({
      errors: [
        buildFailure,
        expect.objectContaining({
          errors: [loweringFailure, catalogFailure],
          cause: loweringFailure,
        }),
      ],
      cause: buildFailure,
    });

    vi.restoreAllMocks();
  });
});
