import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { isPermanentRuntimeReadinessError } from "./runtimeReadinessError.js";

export interface DurableObjectExecutionIncident {
  entityId: string;
  buildKey: string;
  executionDigest: string;
  message: string;
  incidentCount: number;
}

export interface DurableObjectExecutionReadinessMetrics {
  cachedExecutions: number;
  cacheHits: number;
  cacheMisses: number;
  coalescedRestores: number;
  restoreAttempts: number;
  restoreSuccesses: number;
  restoreFailures: number;
  restoreDurationMs: number;
  permanentIncidents: number;
  blockedIncarnations: number;
}

export interface DurableObjectExecutionReadinessDeps {
  /** Resolve the durable identity including retired records. */
  resolveEntity(id: string): Promise<EntityRecord | null>;
  /** Rebuild only disposable runtime state from an exact durable identity. */
  restoreExactExecution(record: EntityRecord): Promise<void>;
  /** Generation of the disposable workerd process that will receive the call. */
  getBootGeneration?: () => number;
  /** Surface an integrity incident without creating a second semantic owner. */
  onPermanentFailure?: (incident: DurableObjectExecutionIncident) => void;
  onRecovered?: (incident: Omit<DurableObjectExecutionIncident, "message">) => void;
}

export class DurableObjectRetiredError extends Error {
  readonly code = "DURABLE_OBJECT_RETIRED";
  constructor(entityId: string) {
    super(`Durable Object ${entityId} is retired or absent`);
    this.name = "DurableObjectRetiredError";
  }
}

/**
 * The one boundary between durable DO identity and disposable workerd state.
 *
 * Entity publication calls `materialize()` before exposing post-activation
 * hooks. Every userland invocation independently re-resolves and validates the
 * authoritative WorkspaceDO row. Restoring disposable runtime state is cached
 * only for the exact sealed execution identity in the current workerd boot;
 * execution advancement and process replacement therefore miss naturally.
 */
export class DurableObjectExecutionReadiness {
  private readonly blockedIncarnations = new Set<string>();
  private readonly ready = new Map<string, string>();
  private readonly restoreFlights = new Map<string, Promise<void>>();
  private readonly metrics: DurableObjectExecutionReadinessMetrics = {
    cachedExecutions: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalescedRestores: 0,
    restoreAttempts: 0,
    restoreSuccesses: 0,
    restoreFailures: 0,
    restoreDurationMs: 0,
    permanentIncidents: 0,
    blockedIncarnations: 0,
  };

  constructor(private readonly deps: DurableObjectExecutionReadinessDeps) {}

  inspect(): DurableObjectExecutionReadinessMetrics {
    return {
      ...this.metrics,
      cachedExecutions: this.ready.size,
      blockedIncarnations: this.blockedIncarnations.size,
    };
  }

  /** Release process-local evidence after the durable entity is retired. */
  forget(entityId: string): void {
    this.ready.delete(entityId);
    const prefix = `${entityId}\u0000`;
    for (const incident of this.blockedIncarnations) {
      if (incident.startsWith(prefix)) this.blockedIncarnations.delete(incident);
    }
  }

  async materialize(record: EntityRecord): Promise<void> {
    if (record.kind !== "do") return;
    this.requireExecutable(record);
    // Publication is the lifecycle boundary that makes an incarnation active.
    // Force restoration even if an earlier incarnation happened to seal the
    // same bytes: retirement may have removed its disposable routing state.
    await this.restore(record, this.readinessKey(record), true);
  }

  async ensureReady(ref: DORef): Promise<EntityRecord> {
    const id = canonicalEntityId({
      kind: "do",
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
    });
    const record = await this.deps.resolveEntity(id);
    if (!record || record.status === "retired") throw new DurableObjectRetiredError(id);
    if (record.id !== id) {
      throw new Error(`Durable Object readiness resolved ${record.id} for ${id}`);
    }
    this.requireExecutable(record);
    const readinessKey = this.readinessKey(record);
    if (this.ready.get(record.id) === readinessKey) {
      this.metrics.cacheHits += 1;
      return record;
    }
    this.metrics.cacheMisses += 1;
    await this.restore(record, readinessKey, false);
    return record;
  }

  private readinessKey(record: EntityRecord): string {
    return [
      record.activeExecutionDigest,
      canonicalJson(record.activeAuthority),
      this.deps.getBootGeneration?.() ?? 0,
    ].join("\u0000");
  }

  private async restore(record: EntityRecord, readinessKey: string, force: boolean): Promise<void> {
    if (!force && this.ready.get(record.id) === readinessKey) return;
    const flightKey = `${record.id}\u0000${readinessKey}`;
    const existing = this.restoreFlights.get(flightKey);
    if (existing) {
      this.metrics.coalescedRestores += 1;
      await existing;
      return;
    }
    const flight = this.restoreOnce(record, readinessKey);
    this.restoreFlights.set(flightKey, flight);
    try {
      await flight;
    } finally {
      if (this.restoreFlights.get(flightKey) === flight) this.restoreFlights.delete(flightKey);
    }
  }

  private async restoreOnce(record: EntityRecord, readinessKey: string): Promise<void> {
    this.metrics.restoreAttempts += 1;
    const startedAt = Date.now();
    const incidentKey = `${record.id}\u0000${record.activeExecutionDigest ?? ""}`;
    try {
      await this.deps.restoreExactExecution(record);
      this.metrics.restoreSuccesses += 1;
      this.ready.set(record.id, readinessKey);
      if (
        this.blockedIncarnations.delete(incidentKey) &&
        record.activeBuildKey &&
        record.activeExecutionDigest
      ) {
        this.deps.onRecovered?.({
          entityId: record.id,
          buildKey: record.activeBuildKey,
          executionDigest: record.activeExecutionDigest,
          incidentCount: this.metrics.permanentIncidents,
        });
      }
    } catch (error) {
      this.metrics.restoreFailures += 1;
      if (this.ready.get(record.id) === readinessKey) this.ready.delete(record.id);
      if (
        isPermanentRuntimeReadinessError(error) &&
        record.activeBuildKey &&
        record.activeExecutionDigest
      ) {
        if (!this.blockedIncarnations.has(incidentKey)) {
          this.blockedIncarnations.add(incidentKey);
          this.metrics.permanentIncidents += 1;
          this.deps.onPermanentFailure?.({
            entityId: record.id,
            buildKey: record.activeBuildKey,
            executionDigest: record.activeExecutionDigest,
            message: error instanceof Error ? error.message : String(error),
            incidentCount: this.metrics.permanentIncidents,
          });
        }
      }
      throw error;
    } finally {
      this.metrics.restoreDurationMs += Math.max(0, Date.now() - startedAt);
    }
  }

  private requireExecutable(record: EntityRecord): void {
    const canonicalId = canonicalEntityId({
      kind: record.kind,
      source: record.source.repoPath,
      className: record.className,
      key: record.key,
    });
    if (
      record.id !== canonicalId ||
      record.status !== "active" ||
      record.kind !== "do" ||
      !record.className ||
      !record.activeBuildKey ||
      !record.activeExecutionDigest ||
      !record.activeAuthority
    ) {
      throw new Error(`Durable Object ${record.id} has no sealed active execution identity`);
    }
  }
}
