/**
 * Node-side hot cache for WorkspaceDO active-entity reads.
 *
 * WorkspaceDO is the source of truth, but synchronous reads happen on every
 * RPC call (policy check, source/context resolution). The cache
 * is updated by `runtimeService` after each successful `entityActivate` /
 * `entityRetire`. On boot, `hydrate()` loads the initial set from
 * `entityListActive()`.
 *
 * Reads are synchronous and never trigger a DO dispatch. Writes are internal:
 * only `runtimeService` (and tests) call the `_*` methods.
 *
 * Replaces the old PrincipalRegistry, which conflated identity ownership
 * with the cache layer. Here, this object only mirrors; it has no
 * authority over identity.
 */

import type { EntityKind, EntityRecord, EntitySource } from "./entitySpec.js";

export type EntityChangeKind = "activate" | "retire" | "delete";

export interface EntityCacheHydrationFence {
  readonly revision: number;
}

export class EntityCache {
  private readonly records = new Map<string, EntityRecord>();
  private readonly bootstrapRecords = new Map<string, EntityRecord>();
  private readonly recordRevisions = new Map<string, number>();
  private readonly listeners = new Set<(id: string, change: EntityChangeKind) => void>();
  private revision = 0;

  beginHydration(): EntityCacheHydrationFence {
    return { revision: this.revision };
  }

  hydrate(records: EntityRecord[], fence?: EntityCacheHydrationFence): void {
    if (!fence) {
      this.records.clear();
      for (const record of records) {
        this.records.set(record.id, record);
      }
    } else {
      const snapshot = new Map(records.map((record) => [record.id, record]));
      const ids = new Set([...this.records.keys(), ...snapshot.keys()]);
      for (const id of ids) {
        if ((this.recordRevisions.get(id) ?? 0) > fence.revision) continue;
        const record = snapshot.get(id);
        if (record) this.records.set(id, record);
        else this.records.delete(id);
      }
    }
    for (const record of this.bootstrapRecords.values()) {
      this.records.set(record.id, record);
    }
  }

  /** Internal: called by runtimeService after WorkspaceDO commits an activate. */
  _onActivate(record: EntityRecord): void {
    // A bootstrap entry is only a bridge until the durable WorkspaceDO row is
    // committed. Once that row exists, never let a later hydrate re-install
    // the stale bootstrap build identity over the authoritative record.
    this.bootstrapRecords.delete(record.id);
    this.records.set(record.id, record);
    this.recordRevisions.set(record.id, ++this.revision);
    this.emit(record.id, "activate");
  }

  /** Internal: called after entity is retired (kept in cache as 'retired' for grace window). */
  _onRetire(record: EntityRecord): void {
    this.records.set(record.id, record);
    this.recordRevisions.set(record.id, ++this.revision);
    this.emit(record.id, "retire");
  }

  /** Internal: called after entityGc hard-deletes a row. */
  _onDelete(id: string): void {
    if (this.records.delete(id)) {
      this.recordRevisions.set(id, ++this.revision);
      this.emit(id, "delete");
    }
  }

  resolve(id: string): EntityRecord | null {
    return this.records.get(id) ?? null;
  }

  resolveActive(id: string): EntityRecord | null {
    const record = this.records.get(id);
    if (!record || record.status !== "active") return null;
    return record;
  }

  /**
   * The live entity for a workspace source path.
   *
   * Used to answer "what version of this part is running right now", which is
   * how an update finds the clearance the outgoing version already holds
   * (docs/template-install-unit-approval-ux-plan.md §7.3).
   */
  resolveActiveBySource(repoPath: string): EntityRecord | null {
    for (const record of this.records.values()) {
      if (record.status === "active" && record.source.repoPath === repoPath) return record;
    }
    return null;
  }

  resolveContext(id: string): string | null {
    return this.resolveActive(id)?.contextId ?? null;
  }

  resolveSource(id: string): EntitySource | null {
    const record = this.resolveActive(id);
    return record ? record.source : null;
  }

  resolveKind(id: string): EntityKind | null {
    return this.resolveActive(id)?.kind ?? null;
  }

  listActive(): EntityRecord[] {
    return Array.from(this.records.values()).filter((r) => r.status === "active");
  }

  /** Bootstrap entries that don't have a WorkspaceDO row (server, shell). */
  registerBootstrap(record: {
    id: string;
    kind: "server" | "shell";
    source?: EntitySource;
    contextId?: string;
  }): void {
    const entry: EntityRecord = {
      id: record.id,
      kind: record.kind,
      source: record.source ?? { repoPath: "", effectiveVersion: "" },
      contextId: record.contextId ?? "",
      key: record.id,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.records.set(record.id, entry);
    this.recordRevisions.set(record.id, ++this.revision);
    this.emit(record.id, "activate");
  }

  /**
   * Register the manifest-declared bootstrap service before WorkspaceDO can
   * mirror runtime entity rows. Hydration preserves this ordinary userland
   * entity across the later WorkspaceDO reconcile.
   */
  registerBootstrapEntity(record: {
    id: string;
    source: EntitySource;
    activeBuildKey: string;
    activeExecutionDigest: string;
    activeAuthority: import("../authorityManifest.js").UnitAuthorityManifest;
    contextId: string;
    className: string;
    key: string;
  }): void {
    const entry: EntityRecord = {
      ...record,
      kind: "do",
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.bootstrapRecords.set(entry.id, entry);
    this.records.set(entry.id, entry);
    this.recordRevisions.set(entry.id, ++this.revision);
    this.emit(entry.id, "activate");
  }

  onChange(listener: (id: string, change: EntityChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clear the cache. Tests only. */
  _clear(): void {
    this.records.clear();
    this.bootstrapRecords.clear();
    this.recordRevisions.clear();
    this.revision = 0;
  }

  private emit(id: string, change: EntityChangeKind): void {
    for (const listener of this.listeners) listener(id, change);
  }
}
