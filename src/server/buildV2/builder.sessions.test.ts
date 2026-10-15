import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuildStore } from "./buildStore.js";
import type { RootDependencyFingerprintInfo } from "./effectiveVersion.js";
import { BuildProcessOwner, createBuilderSession, withBuilderWorkers } from "./builder.js";
import { BuildFlight } from "./builderLifetime.js";
import type { StoredBuildResult } from "./buildStore.js";
import type { BuildSourceProvider } from "./buildSource.js";

const ownedRoots = new Set<string>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sourceFor(workspaceId: string): BuildSourceProvider & { workspaceId: string } {
  return {
    workspaceId,
    async materializeForBuild() {
      throw new Error("This scheduler test must not compile or materialize sources");
    },
  };
}

function storedBuildResult(buildKey: string): StoredBuildResult {
  return {
    dir: "/build/shared-result",
    buildKey,
    sourceStateHash: null,
    metadata: {
      kind: "worker",
      name: "workers/shared",
      buildKey,
      sourcePath: null,
      ev: "shared-ev",
      sourceStateHash: null,
      sourcemap: false,
      authority: { requests: [], provides: [] },
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [],
  };
}

describe("Build V2 process and role ownership", () => {
  afterEach(() => {
    for (const root of ownedRoots) fs.rmSync(root, { recursive: true, force: true });
    ownedRoots.clear();
  });

  it("shares one bounded build admission queue while keeping role inputs and stores isolated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-builder-sessions-"));
    ownedRoots.add(root);
    const processOwner = new BuildProcessOwner({
      appRoot: process.cwd(),
      appNodeModules: [],
      buildConcurrency: 1,
    });
    const rootFingerprint: RootDependencyFingerprintInfo = Object.freeze({
      root: process.cwd(),
      workspaceRoot: null,
      rootSource: "injected",
      value: "a".repeat(64),
      files: Object.freeze([]),
    });
    const sessionFor = (role: string) => {
      const stateRoot = path.join(root, role, "state");
      const store = createBuildStore(
        {
          stateRoot,
          sharedArtifactPoolRoot: null,
          sharedBuildResultCacheRoot: null,
          releaseBuildRoot: null,
          executionIdentity: {
            workspaceId: role,
            executionStateForContent: () => null,
            serviceAuthorityForSource: async () => "a".repeat(64),
          },
        },
        processOwner.buildStoreProcessOwner
      );
      return createBuilderSession({
        processOwner,
        runNativeJob: async () => {
          throw new Error("This scheduler test must not run native jobs");
        },
        source: sourceFor(role),
        store,
        sharedBuildResultCacheRoot: null,
        rootFingerprint,
      });
    };
    const first = sessionFor("base");
    const second = sessionFor("personal");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let secondEntered = false;

    const firstWork = withBuilderWorkers(first, () =>
      processOwner.withBuildSlot(first.signal, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      })
    );
    let secondWork: Promise<void> | undefined;
    try {
      await firstEntered.promise;
      secondWork = withBuilderWorkers(second, () =>
        processOwner.withBuildSlot(second.signal, async () => {
          secondEntered = true;
        })
      );

      expect(first.store).not.toBe(second.store);
      expect(first.source.workspaceId).toBe("base");
      expect(second.source.workspaceId).toBe("personal");
      expect(secondEntered).toBe(false);
      releaseFirst.resolve();
      await Promise.all([firstWork, secondWork]);
      expect(secondEntered).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([firstWork, ...(secondWork ? [secondWork] : [])]);
      await Promise.allSettled([first.close(), second.close()]);
      await processOwner.shutdown();
    }
  });

  it("coalesces an identical shared-cache build and promotes its queued priority", async () => {
    const processOwner = new BuildProcessOwner({
      appRoot: process.cwd(),
      appNodeModules: [],
      buildConcurrency: 1,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    let starts = 0;
    const result = storedBuildResult("a".repeat(64));
    const create = () =>
      new BuildFlight<StoredBuildResult>("speculative", async () => {
        starts++;
        entered.resolve();
        await release.promise;
        return result;
      });

    try {
      const producer = processOwner.admitSharedBuild("/shared-cache\0build-key", create);
      const adopter = processOwner.admitSharedBuild("/shared-cache\0build-key", () => {
        throw new Error("A coalesced build must not start a second compiler operation");
      });
      expect(producer.owner).toBe(true);
      expect(adopter.owner).toBe(false);
      expect(adopter.entry).toBe(producer.entry);
      const adopted = processOwner.borrowSharedBuild(
        adopter.entry,
        new AbortController().signal,
        "interactive"
      );
      await entered.promise;
      expect(starts).toBe(1);
      expect(producer.entry.flight.priority.priority).toBe("interactive");
      release.resolve();
      await expect(adopted).resolves.toBe(result);
    } finally {
      release.resolve();
      await processOwner.shutdown();
    }
  });

  it("withdraws an aborted producer request without canceling a live adopter", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-flight-cancel-"));
    ownedRoots.add(root);
    const processOwner = new BuildProcessOwner({ appRoot: process.cwd(), appNodeModules: [] });
    const rootFingerprint: RootDependencyFingerprintInfo = Object.freeze({
      root: process.cwd(),
      workspaceRoot: null,
      rootSource: "injected",
      value: "a".repeat(64),
      files: Object.freeze([]),
    });
    const sessionFor = (role: string, signal?: AbortSignal) =>
      createBuilderSession({
        processOwner,
        ...(signal ? { signal } : {}),
        runNativeJob: async () => {
          throw new Error("This ownership test must not run native jobs");
        },
        source: sourceFor(role),
        store: createBuildStore(
          {
            stateRoot: path.join(root, role, "state"),
            sharedArtifactPoolRoot: null,
            sharedBuildResultCacheRoot: null,
            releaseBuildRoot: null,
            executionIdentity: null,
          },
          processOwner.buildStoreProcessOwner
        ),
        sharedBuildResultCacheRoot: null,
        rootFingerprint,
      });
    const producerRequest = new AbortController();
    const producer = sessionFor("producer", producerRequest.signal);
    const adopter = sessionFor("adopter");
    const entered = deferred<void>();
    const release = deferred<void>();
    const result = storedBuildResult("a".repeat(64));
    const admitted = processOwner.admitSharedBuild(
      "/shared-cache\0same-build-key",
      (sharedSignal) =>
        new BuildFlight("interactive", () =>
          withBuilderWorkers(producer, async () => {
            entered.resolve();
            await new Promise<void>((resolve, reject) => {
              sharedSignal.addEventListener("abort", () => reject(sharedSignal.reason), {
                once: true,
              });
              void release.promise.then(resolve);
            });
            return result;
          })
        )
    );
    const adopterAdmission = processOwner.admitSharedBuild("/shared-cache\0same-build-key", () => {
      throw new Error("A coalesced build must retain the producer's operation");
    });
    const producerWork = withBuilderWorkers(producer, () =>
      processOwner.borrowSharedBuild(admitted.entry, producer.signal, "interactive")
    );
    const adopterWork = withBuilderWorkers(adopter, () =>
      processOwner.borrowSharedBuild(adopterAdmission.entry, adopter.signal, "interactive")
    );
    let producerClosed = false;
    let closeProducer: Promise<void> | undefined;

    try {
      await entered.promise;
      producerRequest.abort(new Error("Producer request was canceled"));
      await expect(producerWork).rejects.toThrow("Producer request was canceled");
      expect(admitted.entry.controller.signal.aborted).toBe(false);
      closeProducer = producer.close().then(() => {
        producerClosed = true;
      });
      await Promise.resolve();
      expect(producerClosed).toBe(false);

      release.resolve();
      await expect(adopterWork).resolves.toBe(result);
      await closeProducer;
      expect(producerClosed).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([
        producerWork,
        adopterWork,
        ...(closeProducer ? [closeProducer] : []),
        producer.close(),
        adopter.close(),
      ]);
      await processOwner.shutdown();
    }
  });

  it("cancels the process-owned operation after its last requester withdraws", async () => {
    const processOwner = new BuildProcessOwner({ appRoot: process.cwd(), appNodeModules: [] });
    const entered = deferred<void>();
    const requester = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const admitted = processOwner.admitSharedBuild("/shared-cache\0cancel-last", (signal) => {
      sharedSignal = signal;
      return new BuildFlight<StoredBuildResult>("interactive", async () => {
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return storedBuildResult("b".repeat(64));
      });
    });
    const work = processOwner.borrowSharedBuild(admitted.entry, requester.signal, "interactive");

    try {
      await entered.promise;
      requester.abort(new Error("Only requester canceled"));
      await expect(work).rejects.toBe(requester.signal.reason);
      await expect(admitted.entry.flight.promise).rejects.toBe(requester.signal.reason);
      expect(sharedSignal?.reason).toBe(requester.signal.reason);
      expect(sharedSignal?.aborted).toBe(true);
    } finally {
      await Promise.allSettled([work, admitted.entry.flight.promise]);
      await processOwner.shutdown();
    }
  });

  it("cancels and joins shared work when its process owner shuts down", async () => {
    const processOwner = new BuildProcessOwner({ appRoot: process.cwd(), appNodeModules: [] });
    const entered = deferred<void>();
    let sharedSignal: AbortSignal | undefined;
    const admitted = processOwner.admitSharedBuild("/shared-cache\0process-stop", (signal) => {
      sharedSignal = signal;
      return new BuildFlight<StoredBuildResult>("interactive", async () => {
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return storedBuildResult("c".repeat(64));
      });
    });
    const borrower = processOwner.borrowSharedBuild(
      admitted.entry,
      new AbortController().signal,
      "interactive"
    );

    await entered.promise;
    const shutdown = processOwner.shutdown();
    await expect(borrower).rejects.toThrow("Build process owner is shutting down");
    expect(sharedSignal?.aborted).toBe(true);
    await expect(shutdown).rejects.toThrow("Build process owner is shutting down");
  });

  it("preserves the producer's exact cancellation while joining its shared work", async () => {
    const processOwner = new BuildProcessOwner({ appRoot: process.cwd(), appNodeModules: [] });
    const entered = deferred<void>();
    const cancellation = Object.assign(new Error("Template preparation cancelled"), {
      code: "ECANCELLED",
    });
    const admitted = processOwner.admitSharedBuild(
      "/shared-cache\0producer-stop",
      (signal) =>
        new BuildFlight<StoredBuildResult>("background", async () => {
          entered.resolve();
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        })
    );
    // Observe both owners before delivering cancellation; neither rejection
    // may become a new failure disconnected from the producer's lifecycle.
    const work = admitted.entry.flight.promise.catch((error: unknown) => error);
    await entered.promise;
    const shutdown = processOwner.shutdown(cancellation).catch((error: unknown) => error);
    await expect(work).resolves.toBe(cancellation);
    await expect(shutdown).resolves.toBe(cancellation);
    expect(processOwner.lifetime.isDrained).toBe(true);
  });
});
