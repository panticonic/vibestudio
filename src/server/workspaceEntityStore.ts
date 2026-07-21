/**
 * WorkspaceEntityStore — the SINGLE owner of WorkspaceDO-backed entity state.
 *
 * The server keeps a synchronous hot cache (`EntityCache`) mirroring the
 * WorkspaceDO entity table, because principal/context/policy resolution happens
 * on every RPC call and can't pay an async DO dispatch. The invariant that
 * matters: a durable entity mutation and its cache mirror must ALWAYS happen
 * together. Previously that was upheld by convention — every caller had to
 * remember to call `entityCache._onActivate` after dispatching `entityActivate`
 * — and the eval service forgot, so every EvalDO→main RPC 403'd with
 * "Unknown principal kind" (the EvalDO's id wasn't in the cache).
 *
 * This store makes the invariant STRUCTURAL: it is the only thing that
 * dispatches `entityActivate`/`entityRetire` to the WorkspaceDO, and each
 * mutation pairs the durable write with the cache update atomically. The
 * write-owners (`runtimeService`, `evalService`) receive the store and never
 * touch raw entity dispatch or the cache mutators, so they CAN'T drift.
 *
 * NOT in scope: cache-only synthetic entities (apps / device principals in
 * `appHost`, which have no WorkspaceDO row) and the boot hydrate path
 * (`index.ts`). Those are genuinely cache-only — there is no durable write to
 * pair — and keep using `EntityCache` directly.
 */

import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type {
  EntityActivationInput,
  EntityKind,
  EntityRecord,
} from "@vibestudio/shared/runtime/entitySpec";
import type {
  ContextEdge,
  ContextEdgeByChild,
  ContextEdgeKind,
} from "@vibestudio/shared/runtime/contextEdges";

const WORKSPACE_DO_CLASS = "WorkspaceDO";

/** Input accepted by `WorkspaceDO.entityActivate` (built by the write-owners). */
export type EntityActivateInput = EntityActivationInput;

export interface WorkspaceEntityStoreDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  entityCache: EntityCache;
}

export class WorkspaceEntityStore {
  private readonly ref: { source: string; className: string; objectKey: string };

  constructor(private readonly deps: WorkspaceEntityStoreDeps) {
    this.ref = {
      source: INTERNAL_DO_SOURCE,
      className: WORKSPACE_DO_CLASS,
      objectKey: deps.workspaceId,
    };
  }

  private dispatch<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.ref, method, ...args) as Promise<T>;
  }

  // --- mutations: durable write + cache mirror, atomic ---

  /**
   * Activate (or refresh) a WorkspaceDO entity and mirror it into the hot cache.
   * The ONLY sanctioned way to activate a WorkspaceDO-backed entity.
   */
  async activate(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await this.dispatch<EntityRecord>("entityActivate", input);
    this.deps.entityCache._onActivate(record);
    return record;
  }

  /** Retire a WorkspaceDO entity and mirror the retirement. Null if already gone. */
  async retire(id: string): Promise<EntityRecord | null> {
    const record = await this.dispatch<EntityRecord | null>("entityRetire", id);
    if (record) this.deps.entityCache._onRetire(record);
    return record;
  }

  /** Mark post-retire cleanup complete (durable only — no cache state changes). */
  async cleanupComplete(id: string): Promise<void> {
    await this.dispatch<undefined>("entityCleanupComplete", id);
  }

  // --- reads: cache-first, WorkspaceDO fallback ---

  /** Owner context for an entity. Cache-first; falls back to the WorkspaceDO. */
  async resolveContext(id: string): Promise<string | null> {
    const cached = this.deps.entityCache.resolveContext(id);
    return cached != null ? cached : this.dispatch<string | null>("entityResolveContext", id);
  }

  /** Resolve a (possibly retired) record by its canonical id from the WorkspaceDO. */
  resolveRecord(canonicalId: string): Promise<EntityRecord | null> {
    return this.dispatch<EntityRecord | null>("entityResolve", canonicalId);
  }

  /**
   * Durable nav→slot mapping: the OPEN slot id whose current runtime entity is
   * `entityId`, or null. Authoritative + lease-independent (backed by the slot
   * store's `current_entity_id` index) — used to resolve a launch's owning panel slot.
   */
  resolveSlotByEntity(entityId: string): Promise<string | null> {
    return this.dispatch<string | null>("slotResolveByEntity", entityId);
  }

  /** List active entities (optionally by kind) from the WorkspaceDO source of truth. */
  listActive(kind?: EntityKind | string): Promise<EntityRecord[]> {
    return kind
      ? this.dispatch<EntityRecord[]>("entityListActiveByKind", kind)
      : this.dispatch<EntityRecord[]>("entityListActive");
  }

  // --- context-relationship registry (durable edges, no cache mirror) ---

  /** Idempotently upsert a context-relationship edge. */
  recordContextEdge(input: {
    contextId: string;
    ownerContextId: string;
    kind: ContextEdgeKind;
    ownerEntityId?: string;
  }): Promise<void> {
    return this.dispatch<undefined>("contextEdgeUpsert", input);
  }

  /** List edges owned BY a context, optionally scoped to one kind. */
  listContextEdgesByOwner(input: {
    ownerContextId: string;
    kind?: ContextEdgeKind;
  }): Promise<ContextEdge[]> {
    return this.dispatch<ContextEdge[]>("contextEdgeListByOwner", input);
  }

  /** List edges INTO a context (child side) — walk up for authz/teardown. */
  listContextEdgesByChild(contextId: string): Promise<ContextEdgeByChild[]> {
    return this.dispatch<ContextEdgeByChild[]>("contextEdgeListByChild", contextId);
  }

  /** Delete every inbound edge of a context (teardown). */
  deleteContextEdges(contextId: string): Promise<void> {
    return this.dispatch<undefined>("contextEdgeDeleteByChild", contextId);
  }

  /** The hot cache, for synchronous reads (resolve/resolveActive/resolveContext/…). */
  get cache(): EntityCache {
    return this.deps.entityCache;
  }
}
