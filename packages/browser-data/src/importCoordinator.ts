import type {
  BrowserEnvironmentIdentity,
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSelection,
  BrowserImportSource,
  ImportBatch,
  ImportHostSummary,
  ImportJobSnapshot,
  ImportedBrowserOpenTab,
} from "./environment.js";
import type { ImportPreview } from "./client/browserDataClient.js";

export interface BrowserImportHostRegistration extends ImportHostSummary {
  ownerUserId: string;
  provider: BrowserImportProvider;
}

export interface BrowserImportStore {
  storeBatch(identity: BrowserEnvironmentIdentity, batch: ImportBatch): Promise<void>;
  persistJob(identity: BrowserEnvironmentIdentity, job: ImportJobSnapshot): Promise<void>;
  getJob(
    identity: BrowserEnvironmentIdentity,
    jobId: string
  ): Promise<ImportJobSnapshot | null>;
}

interface JobState {
  identity: BrowserEnvironmentIdentity;
  snapshot: ImportJobSnapshot;
  abort: AbortController;
  running: Promise<void>;
}

function importHostKey(ownerUserId: string, hostId: string): string {
  return `${ownerUserId.length}:${ownerUserId}${hostId}`;
}

/**
 * Owns browser import jobs independently of where source data lives. Provider
 * adapters may be in-process or backed by an authenticated host-capability
 * channel; panels see the same host/source/job contract either way.
 */
export class BrowserImportCoordinator {
  private readonly hosts = new Map<string, BrowserImportHostRegistration>();
  private readonly jobs = new Map<string, JobState>();

  constructor(
    private readonly store: BrowserImportStore,
    private readonly onJobChanged?: (
      identity: BrowserEnvironmentIdentity,
      job: ImportJobSnapshot
    ) => void
  ) {}

  registerHost(registration: BrowserImportHostRegistration): () => void {
    if (!registration.hostId.trim()) throw new Error("Import host id is required");
    if (!registration.ownerUserId.trim()) throw new Error("Import host owner is required");
    const key = importHostKey(registration.ownerUserId, registration.hostId);
    if (this.hosts.has(key)) {
      throw new Error(`Browser import host is already registered: ${registration.hostId}`);
    }
    this.hosts.set(key, registration);
    return () => {
      if (this.hosts.get(key) === registration) {
        this.hosts.delete(key);
        for (const job of this.jobs.values()) {
          if (
            job.identity.ownerUserId === registration.ownerUserId &&
            job.snapshot.hostId === registration.hostId &&
            !this.isTerminal(job.snapshot.phase)
          ) {
            job.abort.abort(new Error(`${registration.displayName} disconnected`));
          }
        }
      }
    };
  }

  listHosts(identity: BrowserEnvironmentIdentity): ImportHostSummary[] {
    return [...this.hosts.values()]
      .filter((host) => host.ownerUserId === identity.ownerUserId)
      .map(({ ownerUserId: _owner, provider: _provider, ...summary }) => summary)
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.displayName.localeCompare(b.displayName));
  }

  async listSources(
    identity: BrowserEnvironmentIdentity,
    hostId: string,
    signal?: AbortSignal
  ): Promise<BrowserImportSource[]> {
    const host = this.host(identity, hostId);
    return host.provider.listSources(signal ?? new AbortController().signal);
  }

  async preview(
    identity: BrowserEnvironmentIdentity,
    selection: BrowserImportSelection,
    signal?: AbortSignal
  ): Promise<ImportPreview> {
    const host = this.host(identity, selection.hostId);
    const abort = this.linkedAbort(signal);
    const startedAt = Date.now();
    const job = this.newJob(selection, startedAt, host.displayName);
    job.phase = "discovering";
    await this.persist(identity, job);
    try {
      const summary = await host.provider.preview(
        selection.sourceId,
        this.uniqueDataTypes(selection.dataTypes),
        {
          progress: async (progress) => {
            job.progress = [
              ...job.progress.filter((item) => item.dataType !== progress.dataType),
              progress,
            ];
            job.updatedAt = Date.now();
            await this.persist(identity, job);
          },
          // Masked samples are deliberately not persisted in the canonical
          // store; the current migration UI only needs category counts.
          sample: () => {},
        },
        abort.signal
      );
      job.phase = "complete";
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      job.progress = summary.dataTypes;
      job.warnings = summary.warnings;
      job.resumable = false;
      await this.persist(identity, job);
      return {
        job: this.clone(job),
        openTabCount: summary.openTabCount,
        localDataSetCount: summary.localDataSetCount,
      };
    } catch (error) {
      this.failJob(job, abort.signal, error);
      await this.persist(identity, job);
      throw error;
    }
  }

  start(
    identity: BrowserEnvironmentIdentity,
    selection: BrowserImportSelection
  ): ImportJobSnapshot {
    const host = this.host(identity, selection.hostId);
    const startedAt = Date.now();
    const snapshot = this.newJob(selection, startedAt, host.displayName);
    const abort = new AbortController();
    const state: JobState = {
      identity,
      snapshot,
      abort,
      running: Promise.resolve(),
    };
    this.jobs.set(snapshot.jobId, state);
    state.running = this.runImport(state, host.provider);
    return this.clone(snapshot);
  }

  async resume(
    identity: BrowserEnvironmentIdentity,
    jobId: string
  ): Promise<ImportJobSnapshot> {
    let current = this.jobs.get(jobId);
    if (!current || !this.sameEnvironment(current.identity, identity)) {
      const persisted = await this.store.getJob(identity, jobId);
      if (!persisted) throw new Error(`Browser import job was not found: ${jobId}`);
      current = {
        identity,
        snapshot: persisted,
        abort: new AbortController(),
        running: Promise.resolve(),
      };
      this.jobs.set(jobId, current);
    }
    if (!current.snapshot.resumable || !this.isTerminal(current.snapshot.phase)) {
      throw new Error(`Import job cannot be resumed: ${jobId}`);
    }
    const host = this.host(identity, current.snapshot.hostId);
    current.abort = new AbortController();
    current.snapshot.phase = "queued";
    current.snapshot.error = undefined;
    current.snapshot.finishedAt = undefined;
    current.snapshot.updatedAt = Date.now();
    current.running = this.runImport(current, host.provider);
    return this.clone(current.snapshot);
  }

  cancel(identity: BrowserEnvironmentIdentity, jobId: string): void {
    const job = this.ownedJob(identity, jobId);
    if (!this.isTerminal(job.snapshot.phase)) {
      job.abort.abort(new DOMException("Import cancelled", "AbortError"));
    }
  }

  getJob(identity: BrowserEnvironmentIdentity, jobId: string): ImportJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job && this.sameEnvironment(job.identity, identity) ? this.clone(job.snapshot) : null;
  }

  async waitForJob(
    identity: BrowserEnvironmentIdentity,
    jobId: string
  ): Promise<ImportJobSnapshot> {
    const job = this.ownedJob(identity, jobId);
    await job.running;
    return this.clone(job.snapshot);
  }

  listJobs(identity: BrowserEnvironmentIdentity): ImportJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => this.sameEnvironment(job.identity, identity))
      .map((job) => this.clone(job.snapshot))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listOpenTabs(
    identity: BrowserEnvironmentIdentity,
    hostId: string,
    sourceId: string,
    signal?: AbortSignal
  ): Promise<ImportedBrowserOpenTab[]> {
    return this.host(identity, hostId).provider.listOpenTabs(
      sourceId,
      signal ?? new AbortController().signal
    );
  }

  private async runImport(state: JobState, provider: BrowserImportProvider): Promise<void> {
    const { identity, snapshot, abort } = state;
    snapshot.phase = "discovering";
    snapshot.updatedAt = Date.now();
    await this.persist(identity, snapshot);
    try {
      snapshot.phase = "reading";
      snapshot.updatedAt = Date.now();
      await this.persist(identity, snapshot);
      const summary = await provider.import(
        snapshot.sourceId,
        snapshot.requestedDataTypes,
        {
          store: async (providerBatch) => {
            const batch: ImportBatch = {
              ...providerBatch,
              jobId: snapshot.jobId,
              sourceId: snapshot.sourceId,
              idempotencyKey: `${snapshot.jobId}:${providerBatch.dataType}:${providerBatch.batchIndex}`,
            };
            snapshot.phase = "storing";
            snapshot.updatedAt = Date.now();
            await this.store.storeBatch(identity, batch);
            await this.persist(identity, snapshot);
          },
          progress: async (progress) => {
            snapshot.progress = [
              ...snapshot.progress.filter((item) => item.dataType !== progress.dataType),
              progress,
            ];
            snapshot.updatedAt = Date.now();
            await this.persist(identity, snapshot);
          },
        },
        abort.signal
      );
      snapshot.phase = summary.dataTypes.some((item) => item.errors > 0)
        ? "partial"
        : "complete";
      snapshot.progress = summary.dataTypes;
      snapshot.warnings = summary.warnings;
      snapshot.updatedAt = Date.now();
      snapshot.finishedAt = snapshot.updatedAt;
      snapshot.resumable = snapshot.phase === "partial";
      await this.persist(identity, snapshot);
    } catch (error) {
      this.failJob(snapshot, abort.signal, error);
      await this.persist(identity, snapshot);
    }
  }

  private newJob(
    selection: BrowserImportSelection,
    startedAt: number,
    hostLabel: string
  ): ImportJobSnapshot {
    return {
      jobId: crypto.randomUUID(),
      hostId: selection.hostId,
      hostLabel,
      sourceId: selection.sourceId,
      phase: "queued",
      requestedDataTypes: this.uniqueDataTypes(selection.dataTypes),
      startedAt,
      updatedAt: startedAt,
      progress: [],
      warnings: [],
      resumable: true,
    };
  }

  private failJob(
    job: ImportJobSnapshot,
    signal: AbortSignal,
    error: unknown
  ): void {
    job.phase = signal.aborted ? "cancelled" : "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = Date.now();
    job.finishedAt = job.updatedAt;
    job.resumable = true;
  }

  private async persist(
    identity: BrowserEnvironmentIdentity,
    snapshot: ImportJobSnapshot
  ): Promise<void> {
    const value = this.clone(snapshot);
    await this.store.persistJob(identity, value);
    this.onJobChanged?.(identity, value);
  }

  private host(
    identity: BrowserEnvironmentIdentity,
    hostId: string
  ): BrowserImportHostRegistration {
    const host = this.hosts.get(importHostKey(identity.ownerUserId, hostId));
    if (!host) {
      throw new Error(`Browser import host is unavailable: ${hostId}`);
    }
    if (!host.connected) throw new Error(`${host.displayName} is disconnected`);
    return host;
  }

  private ownedJob(identity: BrowserEnvironmentIdentity, jobId: string): JobState {
    const job = this.jobs.get(jobId);
    if (!job || !this.sameEnvironment(job.identity, identity)) {
      throw new Error(`Browser import job was not found: ${jobId}`);
    }
    return job;
  }

  private sameEnvironment(
    left: BrowserEnvironmentIdentity,
    right: BrowserEnvironmentIdentity
  ): boolean {
    return left.environmentKey === right.environmentKey;
  }

  private uniqueDataTypes(types: BrowserImportDataType[]): BrowserImportDataType[] {
    if (types.length === 0) throw new Error("At least one browser data type is required");
    return [...new Set(types)];
  }

  private linkedAbort(signal: AbortSignal | undefined): AbortController {
    const abort = new AbortController();
    if (!signal) return abort;
    if (signal.aborted) abort.abort(signal.reason);
    else signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
    return abort;
  }

  private isTerminal(phase: ImportJobSnapshot["phase"]): boolean {
    return ["complete", "cancelled", "failed", "partial"].includes(phase);
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }
}
