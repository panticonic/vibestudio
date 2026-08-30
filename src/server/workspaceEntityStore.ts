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
 * mutation pairs the durable write with the cache update and post-commit
 * execution materialization. The write-owners (`runtimeService`, `evalService`)
 * receive the store and never touch raw entity dispatch or the cache mutators,
 * so they CAN'T publish an executable identity that its runtime cannot load.
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
  EntityReservationInput,
  RuntimeResourceBindingInput,
} from "@vibestudio/shared/runtime/entitySpec";
import type {
  ContextEdge,
  ContextEdgeByChild,
  ContextEdgeKind,
} from "@vibestudio/shared/runtime/contextEdges";
import {
  publishExecutionOwnerAsync,
  type ExecutionPublication,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";

const WORKSPACE_DO_CLASS = "WorkspaceDO";

/** Input accepted by `WorkspaceDO.entityActivate` (built by the write-owners). */
export type EntityActivateInput = EntityActivationInput;

export interface WorkspaceEntityStoreDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  entityCache: EntityCache;
  executionPublicationPort?: ExecutionPublicationPort;
  /** Materialize derived runtime state only after the durable row and cache mirror exist. */
  materializeExecution: (record: EntityRecord) => Promise<void>;
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
    const record = await publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      this.publication(input),
      () => this.dispatch<EntityRecord>("entityActivate", input)
    );
    this.deps.entityCache._onActivate(record);
    await this.deps.materializeExecution(record);
    return record;
  }

  /**
   * Reserve stable coordinates for a panel without making it executable.
   * Connection grants and code-principal resolution remain fail-closed until
   * advanceExecution() commits the sealed runtime image.
   */
  async reserve(input: EntityReservationInput): Promise<EntityRecord> {
    const record = await this.dispatch<EntityRecord>("entityReserve", input);
    this.deps.entityCache._onActivate(record);
    return record;
  }

  /** Complete a reserved executable entity, or atomically advance an active one. */
  async advanceExecution(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      this.publication(input),
      () => this.dispatch<EntityRecord>("entityAdvanceExecution", input)
    );
    this.deps.entityCache._onActivate(record);
    await this.deps.materializeExecution(record);
    return record;
  }

  /** Atomically publish one execution incarnation to a set of durable identities. */
  async advanceExecutions(inputs: EntityActivateInput[]): Promise<EntityRecord[]> {
    if (inputs.length === 0) return [];
    const publications = inputs.map((input) => this.publication(input));
    const records = await publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      {
        owner: "runtime-entity",
        ownerId: `batch:${publications
          .map(({ ownerId }) => ownerId)
          .sort()
          .join(",")}`,
        artifacts: publications.flatMap(({ artifacts }) => artifacts),
      },
      () => this.dispatch<EntityRecord[]>("entityAdvanceExecutions", inputs)
    );
    for (const record of records) this.deps.entityCache._onActivate(record);
    await Promise.all(records.map((record) => this.deps.materializeExecution(record)));
    return records;
  }

  /** Durably move a self-hosted agent to its current channel and refresh auth cache. */
  async rebindAgentChannel(id: string, channelId: string): Promise<EntityRecord> {
    const record = await this.dispatch<EntityRecord>("entityRebindAgentChannel", id, channelId);
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

  replaceResourceBindings(id: string, bindings: RuntimeResourceBindingInput[]): Promise<void> {
    return this.dispatch<void>("runtimeResourceBindingsReplace", id, bindings);
  }

  releaseResourceBindings(id: string): Promise<void> {
    return this.dispatch<void>("runtimeResourceBindingsRelease", id);
  }

  entitiesBoundToResources(resourceKind: string, resourceIds: string[]): Promise<string[]> {
    return this.dispatch<string[]>("runtimeResourceBindingEntities", resourceKind, resourceIds);
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
   * Resolve a live or preparing record from the structurally mirrored cache,
   * falling back to durable history only when this process has no current row.
   * Runtime activation uses this boundary so an already committed reservation
   * does not queue a redundant WorkspaceDO read before user-visible work.
   */
  async resolveCurrentRecord(canonicalId: string): Promise<EntityRecord | null> {
    const cached = this.deps.entityCache.resolve(canonicalId);
    return cached && cached.status !== "retired"
      ? cached
      : this.dispatch<EntityRecord | null>("entityResolve", canonicalId);
  }

  /** Resolve the active durable identity, repairing a lost hot-cache mirror. */
  async resolveActiveRecord(canonicalId: string): Promise<EntityRecord | null> {
    const cached = this.deps.entityCache.resolveActive(canonicalId);
    if (cached) return cached;
    const record = await this.dispatch<EntityRecord | null>("entityResolveActive", canonicalId);
    if (record) this.deps.entityCache._onActivate(record);
    return record;
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

  /** Durable reservations whose executable incarnation has not committed yet. */
  listPreparing(kind?: EntityKind | string): Promise<EntityRecord[]> {
    return kind
      ? this.dispatch<EntityRecord[]>("entityListPreparingByKind", kind)
      : this.dispatch<EntityRecord[]>("entityListPreparing");
  }

  /** Active executions plus retired panel-history entries that remain selectable. */
  listExecutionRoots(): Promise<EntityRecord[]> {
    return this.dispatch<EntityRecord[]>("entityListExecutionRoots");
  }

  /** All active or retired entity records that establish a context's creator lineage. */
  listByContext(contextId: string): Promise<EntityRecord[]> {
    return this.dispatch<EntityRecord[]>("entityListByContext", contextId);
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

  private publication(input: EntityActivateInput): ExecutionPublication {
    const ownerId = canonicalEntityId({
      kind: input.kind,
      source: input.source.repoPath,
      className: input.className,
      key: input.key,
    });
    const current = this.deps.entityCache.resolve(ownerId);
    const unchanged =
      current?.activeBuildKey === (input.activeBuildKey ?? null) &&
      current?.activeExecutionDigest === (input.activeExecutionDigest ?? null);
    return {
      owner: "runtime-entity",
      ownerId,
      artifacts:
        !unchanged && input.activeBuildKey && input.activeExecutionDigest
          ? [
              {
                buildKey: input.activeBuildKey,
                executionDigest: input.activeExecutionDigest,
              },
            ]
          : [],
    };
  }
}
