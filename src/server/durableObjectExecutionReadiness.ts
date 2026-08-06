import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { isPermanentRuntimeReadinessError } from "./runtimeReadinessError.js";

export interface DurableObjectExecutionIncident {
  entityId: string;
  buildKey: string;
  executionDigest: string;
  message: string;
  incidentCount: number;
}

export interface DurableObjectExecutionReadinessMetrics {
  restoreAttempts: number;
  restoreSuccesses: number;
  restoreFailures: number;
  permanentIncidents: number;
  blockedIncarnations: number;
}

export interface DurableObjectExecutionReadinessDeps {
  /** Resolve the currently active durable identity; null means it must not execute. */
  resolveActiveEntity(id: string): Promise<EntityRecord | null>;
  /** Rebuild only disposable runtime state from an exact durable identity. */
  restoreExactExecution(record: EntityRecord): Promise<void>;
  /** Surface an integrity incident without creating a second semantic owner. */
  onPermanentFailure?: (incident: DurableObjectExecutionIncident) => void;
  onRecovered?: (incident: Omit<DurableObjectExecutionIncident, "message">) => void;
}

/**
 * The one boundary between durable DO identity and disposable workerd state.
 *
 * Entity publication calls `materialize()` before exposing post-activation
 * hooks. Every userland invocation independently calls `ensureReady()`. The
 * second check is intentional: workerd and its in-memory attachment maps may
 * disappear at any time, while the WorkspaceDO row remains authoritative.
 */
export class DurableObjectExecutionReadiness {
  private readonly blockedIncarnations = new Set<string>();
  private readonly metrics: DurableObjectExecutionReadinessMetrics = {
    restoreAttempts: 0,
    restoreSuccesses: 0,
    restoreFailures: 0,
    permanentIncidents: 0,
    blockedIncarnations: 0,
  };

  constructor(private readonly deps: DurableObjectExecutionReadinessDeps) {}

  inspect(): DurableObjectExecutionReadinessMetrics {
    return { ...this.metrics, blockedIncarnations: this.blockedIncarnations.size };
  }

  async materialize(record: EntityRecord): Promise<void> {
    if (record.kind !== "do") return;
    this.requireExecutable(record);
    await this.restore(record);
  }

  async ensureReady(ref: DORef): Promise<EntityRecord> {
    const id = canonicalEntityId({
      kind: "do",
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
    });
    const record = await this.deps.resolveActiveEntity(id);
    if (!record) {
      throw new Error(`Durable Object ${id} has no active durable execution`);
    }
    if (record.id !== id) {
      throw new Error(`Durable Object readiness resolved ${record.id} for ${id}`);
    }
    this.requireExecutable(record);
    await this.restore(record);
    return record;
  }

  private async restore(record: EntityRecord): Promise<void> {
    this.metrics.restoreAttempts += 1;
    const incidentKey = `${record.id}\u0000${record.activeExecutionDigest ?? ""}`;
    try {
      await this.deps.restoreExactExecution(record);
      this.metrics.restoreSuccesses += 1;
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
