import { describe, expect, it, vi } from "vitest";
import type {
  BrowserEnvironmentIdentity,
  BrowserImportProvider,
  ImportBatchSink,
  ImportJobSnapshot,
} from "./environment.js";
import { BrowserImportCoordinator, type BrowserImportStore } from "./importCoordinator.js";

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
      breakdowns: [],
      warnings: [],
      openTabCount: 0,
      localDataSetCount: 1,
    })),
    openImport: vi.fn(async (_sourceId, _types, signal) => ({
      consume: async (sink: ImportBatchSink) => {
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
      },
    })),
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
  it("waits for its owning start during admission and observes real changes without cancelling the import", async () => {
    const backing = store();
    let finishStorageRead!: (job: ImportJobSnapshot | null) => void;
    const storageRead = new Promise<ImportJobSnapshot | null>((resolve) => {
      finishStorageRead = resolve;
    });
    vi.mocked(backing.value.getJob).mockImplementationOnce(async () => storageRead);
    const coordinator = new BrowserImportCoordinator(backing.value);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const importProvider = provider();
    importProvider.openImport = vi.fn(async () => ({
      consume: async () => {
        await finished;
        return { dataTypes: [], warnings: [] };
      },
    }));
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: identity.ownerUserId,
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });
    const starting = coordinator.start(
      identity,
      {
        hostId: "desktop-a",
        sourceId: "source-a",
        dataTypes: ["bookmarks"],
      },
      "observed-operation"
    );
    await vi.waitFor(() => expect(backing.value.getJob).toHaveBeenCalledOnce());
    const admissionObservation = coordinator.observeJob(identity, "observed-operation");
    let observed = false;
    void admissionObservation.then(() => {
      observed = true;
    });
    await Promise.resolve();
    expect(observed).toBe(false);
    finishStorageRead(null);
    await starting;
    expect((await admissionObservation).job.jobId).toBe("observed-operation");
    const reading = await coordinator.observeJob(identity, "observed-operation");
    expect(reading.job.phase).toBe("reading");
    const observation = new AbortController();
    const released = coordinator.observeJob(identity, "observed-operation", {
      afterVersion: reading.version,
      signal: observation.signal,
    });
    observation.abort(new Error("Panel closed"));
    await expect(released).rejects.toThrow("Panel closed");
    expect(coordinator.getJob(identity, "observed-operation")?.phase).toBe("reading");
    const completion = coordinator.observeJob(identity, "observed-operation", {
      afterVersion: reading.version,
    });
    finish();
    expect((await completion).job.phase).toBe("complete");
    await coordinator.waitForJob(identity, "observed-operation");
    expect((await coordinator.observeJob(identity, "observed-operation")).job.phase).toBe(
      "complete"
    );
  });

  it("propagates admission lookup failure to an observer before a job row exists", async () => {
    const backing = store();
    let fail!: (error: Error) => void;
    const lookup = new Promise<ImportJobSnapshot | null>((_resolve, reject) => {
      fail = reject;
    });
    vi.mocked(backing.value.getJob).mockImplementationOnce(() => lookup);
    const coordinator = new BrowserImportCoordinator(backing.value);
    const starting = coordinator.start(
      identity,
      { hostId: "desktop-a", sourceId: "source-a", dataTypes: ["bookmarks"] },
      "lookup-failure"
    );
    await vi.waitFor(() => expect(backing.value.getJob).toHaveBeenCalledOnce());
    const observing = coordinator.observeJob(identity, "lookup-failure");
    const failure = new Error("Import store disconnected");
    fail(failure);
    await expect(starting).rejects.toBe(failure);
    await expect(observing).rejects.toBe(failure);
  });

  it("isolates observations by environment and releases missing-job waits on cancellation", async () => {
    const coordinator = new BrowserImportCoordinator(store().value);
    const observation = new AbortController();
    const waiting = coordinator.observeJob(identity, "never-admitted", {
      signal: observation.signal,
    });
    observation.abort(new Error("Invocation ended"));
    await expect(waiting).rejects.toThrow("Invocation ended");
    expect(coordinator.listJobs(identity)).toEqual([]);
  });

  it("rejects an observation for an unknown job instead of waiting without an owner", async () => {
    const coordinator = new BrowserImportCoordinator(store().value);

    await expect(coordinator.observeJob(identity, "missing-operation")).rejects.toThrow(
      "Browser import job was not found: missing-operation"
    );
  });

  it("recovers a persisted job when another environment has a live job with the same id", async () => {
    const backing = store();
    const coordinator = new BrowserImportCoordinator(backing.value);
    const otherIdentity = {
      ...identity,
      workspaceId: "workspace-b",
      environmentKey: "environment-b",
    };
    const stale = {
      jobId: "shared-operation",
      hostId: "desktop-a",
      sourceId: "source-a",
      phase: "reading" as const,
      requestedDataTypes: ["bookmarks" as const],
      startedAt: 1,
      updatedAt: 1,
      progress: [],
      warnings: [],
      resumable: true,
    };
    const getPersistedJob = vi.mocked(backing.value.getJob);
    getPersistedJob.mockImplementation(async (requestedIdentity, jobId) =>
      requestedIdentity.environmentKey === otherIdentity.environmentKey && jobId === stale.jobId
        ? structuredClone(stale)
        : null
    );

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const importProvider = provider();
    importProvider.openImport = vi.fn(async () => ({
      consume: async () => {
        await finished;
        return { dataTypes: [], warnings: [] };
      },
    }));
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: identity.ownerUserId,
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });

    try {
      await coordinator.start(
        identity,
        { hostId: "desktop-a", sourceId: "source-a", dataTypes: ["bookmarks"] },
        stale.jobId
      );
      await vi.waitFor(() =>
        expect(coordinator.getJob(identity, stale.jobId)?.phase).toBe("reading")
      );

      await expect(coordinator.observeJob(otherIdentity, stale.jobId)).resolves.toMatchObject({
        job: {
          phase: "failed",
          error: "The previous browser import process stopped before the job completed",
        },
      });
    } finally {
      finish();
      await coordinator.waitForJob(identity, stale.jobId);
    }
  });

  it("keeps identical job IDs in different environments independent", async () => {
    const backing = store();
    // Durable lookups are environment scoped in production.
    backing.value.getJob = vi.fn(async () => null);
    const coordinator = new BrowserImportCoordinator(backing.value);
    const other = { ...identity, workspaceId: "workspace-b", environmentKey: "environment-b" };
    let finish!: () => void;
    const reading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const importProvider = provider();
    importProvider.openImport = vi.fn(async (_sourceId, _dataTypes, signal) => ({
      consume: async () => {
        await reading;
        signal.throwIfAborted();
        return { dataTypes: [], warnings: [] };
      },
    }));
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: identity.ownerUserId,
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });
    const selection = {
      hostId: "desktop-a",
      sourceId: "source-a",
      dataTypes: ["bookmarks" as const],
    };
    try {
      await coordinator.start(identity, selection, "same-id");
      await coordinator.start(other, selection, "same-id");
      expect(coordinator.getJob(identity, "same-id")?.phase).toBe("reading");
      expect(coordinator.getJob(other, "same-id")?.phase).toBe("reading");
      coordinator.cancel(other, "same-id");
      expect(coordinator.getJob(identity, "same-id")?.phase).toBe("reading");
    } finally {
      finish();
      await Promise.all([
        coordinator.waitForJob(identity, "same-id"),
        coordinator.waitForJob(other, "same-id"),
      ]);
    }
    expect((await coordinator.observeJob(identity, "same-id")).job.phase).toBe("complete");
    expect((await coordinator.observeJob(other, "same-id")).job.phase).toBe("cancelled");
  });

  it("shows hosts only to their verified owner", () => {
    const coordinator = new BrowserImportCoordinator(store().value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
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
      location: "device",
      connected: true,
      provider: providerA,
    });
    coordinator.registerHost({
      hostId: "desktop",
      ownerUserId: ownerB.ownerUserId,
      displayName: "Owner B laptop",
      platform: "linux",
      location: "device",
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
      location: "device",
      connected: true,
      provider: provider(),
    });
    const started = await coordinator.start(
      identity,
      {
        hostId: "desktop-a",
        sourceId: "source-a",
        dataTypes: ["bookmarks", "bookmarks"],
      },
      "public-operation"
    );
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

  it("keeps start attached until the discovering job is durably accepted", async () => {
    const backing = store();
    let releasePersistence!: () => void;
    const firstPersistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let persistCount = 0;
    backing.value.persistJob = vi.fn(async (_identity, job) => {
      persistCount += 1;
      if (persistCount === 1) await firstPersistence;
      backing.jobs.set(job.jobId, structuredClone(job));
    });
    const importProvider = provider();
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });

    let accepted = false;
    const starting = coordinator
      .start(
        identity,
        {
          hostId: "desktop-a",
          sourceId: "source-a",
          dataTypes: ["bookmarks"],
        },
        "public-operation"
      )
      .then((job) => {
        accepted = true;
        return job;
      });
    await vi.waitFor(() => expect(backing.value.persistJob).toHaveBeenCalledOnce());
    expect(accepted).toBe(false);
    expect(importProvider.openImport).not.toHaveBeenCalled();

    releasePersistence();
    const started = await starting;
    expect(started.phase).toBe("discovering");
    await expect(coordinator.waitForJob(identity, started.jobId)).resolves.toMatchObject({
      phase: "complete",
    });
  });

  it("opens the provider read before accepting detached background work", async () => {
    const backing = store();
    let releaseOpen!: () => void;
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const importProvider = provider();
    const originalOpen = importProvider.openImport;
    importProvider.openImport = vi.fn(async (sourceId, dataTypes, signal) => {
      await opening;
      return originalOpen(sourceId, dataTypes, signal);
    });
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });

    let accepted = false;
    const starting = coordinator
      .start(
        identity,
        {
          hostId: "desktop-a",
          sourceId: "source-a",
          dataTypes: ["bookmarks"],
        },
        "public-operation"
      )
      .then((job) => {
        accepted = true;
        return job;
      });
    await vi.waitFor(() => expect(importProvider.openImport).toHaveBeenCalledOnce());
    expect(accepted).toBe(false);
    await expect(coordinator.observeJob(identity, "public-operation")).resolves.toMatchObject({
      job: { phase: "discovering" },
    });
    let completed = false;
    const waiting = coordinator.waitForJob(identity, "public-operation").then((job) => {
      completed = true;
      return job;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseOpen();
    const started = await starting;
    expect(accepted).toBe(true);
    await expect(waiting).resolves.toMatchObject({ phase: "complete" });
    await expect(coordinator.waitForJob(identity, started.jobId)).resolves.toMatchObject({
      phase: "complete",
    });
  });

  it("does not report completion until stored data is reconciled", async () => {
    const backing = store();
    let releaseReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    backing.value.reconcileImport = vi.fn(async () => reconciliation);
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: provider(),
    });

    const started = await coordinator.start(
      identity,
      {
        hostId: "desktop-a",
        sourceId: "source-a",
        dataTypes: ["bookmarks"],
      },
      "public-operation"
    );
    await vi.waitFor(() => expect(backing.jobs.get(started.jobId)?.phase).toBe("reconciling"));

    let completed = false;
    const waiting = coordinator.waitForJob(identity, started.jobId).then((job) => {
      completed = true;
      return job;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(backing.value.reconcileImport).toHaveBeenCalledWith(identity, ["bookmarks"]);

    releaseReconciliation();
    await expect(waiting).resolves.toMatchObject({ phase: "complete" });
  });

  it("terminates in memory when durable job persistence fails", async () => {
    const backing = store();
    backing.value.persistJob = vi.fn(async () => {
      throw new Error("durable store unavailable");
    });
    const changed = vi.fn();
    const importProvider = provider();
    const coordinator = new BrowserImportCoordinator(backing.value, changed);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: importProvider,
    });

    await expect(
      coordinator.start(
        identity,
        {
          hostId: "desktop-a",
          sourceId: "source-a",
          dataTypes: ["bookmarks"],
        },
        "public-operation"
      )
    ).rejects.toThrow("durable store unavailable");

    expect(coordinator.listJobs(identity)[0]).toMatchObject({
      phase: "failed",
      error: "durable store unavailable",
      resumable: true,
    });
    expect(importProvider.openImport).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(
      identity,
      expect.objectContaining({ phase: "failed", error: "durable store unavailable" })
    );
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
      location: "device",
      connected: true,
      provider: provider(),
    });
    await coordinator.resume(identity, "job-a");
    expect((await coordinator.waitForJob(identity, "job-a")).phase).toBe("complete");
  });

  it("resumes a persisted nonterminal job orphaned by a coordinator restart", async () => {
    const backing = store();
    backing.jobs.set("job-a", {
      jobId: "job-a",
      hostId: "desktop-a",
      sourceId: "source-a",
      phase: "discovering",
      requestedDataTypes: ["bookmarks"],
      startedAt: 1,
      updatedAt: 2,
      progress: [],
      warnings: [],
      resumable: true,
    });
    const coordinator = new BrowserImportCoordinator(backing.value);
    coordinator.registerHost({
      hostId: "desktop-a",
      ownerUserId: "user-a",
      displayName: "Laptop",
      platform: "linux",
      location: "device",
      connected: true,
      provider: provider(),
    });

    await coordinator.resume(identity, "job-a");

    expect((await coordinator.waitForJob(identity, "job-a")).phase).toBe("complete");
  });
});
