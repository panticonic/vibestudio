import { describe, expect, it, vi } from "vitest";
import type {
  BrowserEnvironmentIdentity,
  BrowserImportProvider,
  ImportJobSnapshot,
} from "./environment.js";
import {
  BrowserImportCoordinator,
  type BrowserImportStore,
} from "./importCoordinator.js";

const identity: BrowserEnvironmentIdentity = {
  workspaceId: "workspace-a",
  ownerUserId: "user-a",
  environmentKey: "environment-a",
};

function provider(): BrowserImportProvider {
  return {
    listSources: vi.fn(async () => []),
    preview: vi.fn(async () => ({
      dataTypes: [],
      warnings: [],
      openTabCount: 0,
      localDataSetCount: 1,
    })),
    import: vi.fn(async (_sourceId, _types, sink, signal) => {
      if (signal.aborted) throw signal.reason;
      await sink.store({
        jobId: "provider-job",
        sourceId: "source-a",
        dataType: "bookmarks",
        batchIndex: 0,
        idempotencyKey: "provider-key",
        items: [{ url: "https://example.test" }],
      });
      const progress = {
        dataType: "bookmarks" as const,
        itemsProcessed: 1,
        totalItems: 1,
        stored: 1,
        skipped: 0,
        errors: 0,
      };
      await sink.progress(progress);
      return { dataTypes: [progress], warnings: [] };
    }),
    listOpenTabs: vi.fn(async () => []),
  };
}

function store() {
  const jobs = new Map<string, ImportJobSnapshot>();
  const value: BrowserImportStore = {
    storeBatch: vi.fn(async () => {}),
    persistJob: vi.fn(async (_identity, job) => {
      jobs.set(job.jobId, structuredClone(job));
    }),
    getJob: vi.fn(async (_identity, jobId) => jobs.get(jobId) ?? null),
  };
  return { value, jobs };
}

describe("BrowserImportCoordinator", () => {
  it("shows hosts only to their verified owner", () => {
    const coordinator = new BrowserImportCoordinator(store().value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "desktop",
      connected: true,
      provider: provider(),
    });
    expect(coordinator.listHosts(identity)).toHaveLength(1);
    expect(
      coordinator.listHosts({ ...identity, ownerUserId: "user-b", environmentKey: "environment-b" })
    ).toEqual([]);
  });

  it("scopes identical physical host ids by verified owner", async () => {
    const coordinator = new BrowserImportCoordinator(store().value);
    const ownerB = {
      ...identity,
      ownerUserId: "user-b",
      environmentKey: "environment-b",
    };
    const providerA = provider();
    const providerB = provider();
    coordinator.registerHost({
      hostId: "desktop",
      ownerUserId: identity.ownerUserId,
      displayName: "Owner A laptop",
      platform: "linux",
      location: "desktop",
      connected: true,
      provider: providerA,
    });
    coordinator.registerHost({
      hostId: "desktop",
      ownerUserId: ownerB.ownerUserId,
      displayName: "Owner B laptop",
      platform: "linux",
      location: "desktop",
      connected: true,
      provider: providerB,
    });

    expect(coordinator.listHosts(identity).map((host) => host.displayName)).toEqual([
      "Owner A laptop",
    ]);
    expect(coordinator.listHosts(ownerB).map((host) => host.displayName)).toEqual([
      "Owner B laptop",
    ]);
    await coordinator.listSources(ownerB, "desktop");
    expect(providerB.listSources).toHaveBeenCalledOnce();
    expect(providerA.listSources).not.toHaveBeenCalled();
  });

  it("owns batching, job identity, and terminal persistence", async () => {
    const backing = store();
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "desktop",
      connected: true,
      provider: provider(),
    });
    const started = coordinator.start(identity, {
      hostId: "desktop-a",
      sourceId: "source-a",
      dataTypes: ["bookmarks", "bookmarks"],
    });
    const completed = await coordinator.waitForJob(identity, started.jobId);
    expect(completed.phase).toBe("complete");
    expect(completed.requestedDataTypes).toEqual(["bookmarks"]);
    expect(backing.value.storeBatch).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        jobId: started.jobId,
        idempotencyKey: `${started.jobId}:bookmarks:0`,
      })
    );
    expect(backing.jobs.get(started.jobId)?.phase).toBe("complete");
  });

  it("hydrates and resumes a persisted resumable job", async () => {
    const backing = store();
    backing.jobs.set("job-a", {
      jobId: "job-a",
      hostId: "desktop-a",
      sourceId: "source-a",
      phase: "failed",
      requestedDataTypes: ["bookmarks"],
      startedAt: 1,
      updatedAt: 2,
      finishedAt: 2,
      progress: [],
      warnings: [],
      error: "disconnected",
      resumable: true,
    });
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "desktop",
      connected: true,
      provider: provider(),
    });
    await coordinator.resume(identity, "job-a");
    expect((await coordinator.waitForJob(identity, "job-a")).phase).toBe("complete");
  });
});
