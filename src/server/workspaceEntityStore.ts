import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
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
  DurableEntityRecord,
  EntityKind,
  EntityRecord,
  EntityReservationInput,
  RuntimeResourceBindingInput,
} from "@vibestudio/shared/runtime/entitySpec";
import type {
  ContextEdge,
  ContextCloneDefinition,
  ContextCloneCompletion,
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
  resolveDurableWorkQueues: (
    input: EntityActivationInput
  ) => import("@vibestudio/shared/durableWork").DurableWorkQueue[];
  /** Materialize derived runtime state only after the durable row and cache mirror exist. */
  materializeExecution: (record: EntityRecord) => Promise<void>;
}

export class WorkspaceEntityStore {
  private readonly ref: { source: string; className: string; objectKey: string };

  private readonly receiver: TypedServiceClient<typeof workspaceStateEngineMethods>;
  /** Only rows read or committed by this durable owner admit invocation. */
  private readonly publishedRecords = new Map<string, EntityRecord>();
  private readonly entityOperations = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: WorkspaceEntityStoreDeps) {
    this.ref = {
      source: INTERNAL_DO_SOURCE,
      className: WORKSPACE_DO_CLASS,
      objectKey: deps.workspaceId,
    };
    deps.entityCache.onChange((id) => this.publishedRecords.delete(id));
    this.receiver = createTypedServiceClient(
      "workspace-state",
      workspaceStateEngineMethods,
      (_service, method, args) => deps.doDispatch.dispatch(this.ref, method, ...args)
    );
  }

  private entityId(input: EntityReservationInput | EntityActivateInput): string {
    return canonicalEntityId({
      kind: input.kind,
      source: input.source.repoPath,
      className: input.className,
      key: input.key,
    });
  }

  /** Serialize overlapping writes; disjoint entities remain independent. */
  private mutate<T>(ids: readonly string[], commit: () => Promise<T>): Promise<T> {
    const owners = [...new Set(ids)];
    const previous = [
      ...new Set(owners.map((id) => this.entityOperations.get(id)).filter(Boolean)),
    ];
    const operation = Promise.allSettled(previous).then(async () => {
      for (const id of owners) this.publishedRecords.delete(id);
      try {
        return await commit();
      } catch (error) {
        // A failed transport may have committed. Only an explicit durable read
        // can re-establish admission; never resurrect the previous snapshot.
        for (const id of owners) {
          this.publishedRecords.delete(id);
          this.deps.entityCache._invalidate(id);
        }
        throw error;
      }
    });
    for (const id of owners) this.entityOperations.set(id, operation);
    const release = () => {
      for (const id of owners) {
        if (this.entityOperations.get(id) === operation) this.entityOperations.delete(id);
      }
    };
    void operation.then(release, release);
    return operation;
  }

  private publishRecord(record: EntityRecord, expectedId = record.id): EntityRecord {
    if (record.id !== expectedId)
      throw new Error(`Entity owner resolved ${record.id} for ${expectedId}`);
    // Callers can retain and edit returned values; authority publication owns
    // a separate immutable snapshot, including its nested authority manifest.
    const snapshot = structuredClone(record);
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(snapshot);
    if (snapshot.status === "retired") this.deps.entityCache._onRetire(snapshot);
    else this.deps.entityCache._onActivate(snapshot);
    this.publishedRecords.set(snapshot.id, snapshot);
    return snapshot;
  }

  async activate(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      this.publication(input),
      () => this.mutate([this.entityId(input)], () => this.activateCommitted(input))
    );
    await this.deps.materializeExecution(record);
    return record;
  }

  reserve(input: EntityReservationInput): Promise<EntityRecord> {
    return this.mutate([this.entityId(input)], () => this.reserveCommitted(input));
  }

  prepareExecution(input: EntityActivateInput): Promise<EntityRecord> {
    return publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      this.publication(input),
      () => this.mutate([this.entityId(input)], () => this.prepareExecutionCommitted(input))
    );
  }

  async advanceExecution(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await publishExecutionOwnerAsync(
      this.deps.executionPublicationPort,
      this.publication(input),
      () => this.mutate([this.entityId(input)], () => this.advanceExecutionCommitted(input))
    );
    await this.deps.materializeExecution(record);
    return record;
  }

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
      () =>
        this.mutate(
          inputs.map((input) => this.entityId(input)),
          () => this.advanceExecutionsCommitted(inputs)
        )
    );
    await Promise.all(records.map((record) => this.deps.materializeExecution(record)));
    return records;
  }

  rebindAgentChannel(id: string, channelId: string): Promise<EntityRecord> {
    return this.mutate([id], () => this.rebindAgentChannelCommitted(id, channelId));
  }

  retire(id: string): Promise<EntityRecord | null> {
    return this.mutate([id], async () => {
      const record = await this.retireCommitted(id);
      // An absent durable row cannot retain an incidental cached identity.
      if (!record) this.deps.entityCache._onDelete(id);
      return record;
    });
  }

  /**
   * Linearized live admission from the single durable publication owner.
   * Bootstrap/cache-only rows never establish durable authority. Recovery reads
   * occur once per missing publication, rather than before every invocation.
   */
  private currentPublication(id: string): EntityRecord | null {
    const publication = this.publishedRecords.get(id);
    // Hydration can replace rows without a mutation notification. Admission
    // belongs to the exact owner-published snapshot, never merely its ID.
    if (publication && this.deps.entityCache.resolve(id) === publication) return publication;
    this.publishedRecords.delete(id);
    return null;
  }

  resolveInvocationRecord(id: string): Promise<EntityRecord | null> {
    const previous = this.entityOperations.get(id);
    const publication = this.currentPublication(id);
    if (!previous && publication) return Promise.resolve(publication);
    const operation = (previous ?? Promise.resolve()).then(async () => {
      const publication = this.currentPublication(id);
      if (publication) return publication;
      const record = await this.receiver.entityResolve(id);
      if (record && record.id !== id)
        throw new Error(`Entity owner resolved ${record.id} for ${id}`);
      if (record) return this.publishRecord(record);
      else {
        this.publishedRecords.delete(id);
        this.deps.entityCache._onDelete(id);
      }
      return null;
    });
    this.entityOperations.set(id, operation);
    const release = () => {
      if (this.entityOperations.get(id) === operation) this.entityOperations.delete(id);
    };
    void operation.then(release, release);
    return operation;
  }

  // --- mutations: durable write + cache mirror, atomic ---

  /**
   * Activate (or refresh) a WorkspaceDO entity and mirror it into the hot cache.
   * The ONLY sanctioned way to activate a WorkspaceDO-backed entity.
   */
  private activationCommand(input: EntityActivationInput) {
    return { ...input, durableWorkQueues: this.deps.resolveDurableWorkQueues(input) };
  }

  private async activateCommitted(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await this.receiver.entityActivate(this.activationCommand(input));
    this.publishRecord(record, this.entityId(input));
    return record;
  }

  /**
   * Reserve stable coordinates for a panel without making it executable.
   * Connection grants and code-principal resolution remain fail-closed until
   * advanceExecution() commits the sealed runtime image.
   */
  private async reserveCommitted(input: EntityReservationInput): Promise<EntityRecord> {
    const record = await this.receiver.entityReserve(input);
    this.publishRecord(record, this.entityId(input));
    return record;
  }

  /** Pin the image while preparation owns the non-executable reservation. */
  private async prepareExecutionCommitted(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await this.receiver.entityPrepareExecution(input);
    this.publishRecord(record, this.entityId(input));
    return record;
  }

  /** Complete a reserved executable entity, or atomically advance an active one. */
  private async advanceExecutionCommitted(input: EntityActivateInput): Promise<EntityRecord> {
    const record = await this.receiver.entityAdvanceExecution(this.activationCommand(input));
    this.publishRecord(record, this.entityId(input));
    return record;
  }

  /** Atomically publish one execution incarnation to a set of durable identities. */
  private async advanceExecutionsCommitted(inputs: EntityActivateInput[]): Promise<EntityRecord[]> {
    if (inputs.length === 0) return [];
    const records = await this.receiver.entityAdvanceExecutions(
      inputs.map((input) => this.activationCommand(input))
    );
    const expected = new Set(inputs.map((input) => this.entityId(input)));
    if (
      records.length !== expected.size ||
      new Set(records.map((record) => record.id)).size !== expected.size ||
      records.some((record) => !expected.has(record.id))
    ) {
      throw new Error("Entity execution batch returned different owner identities");
    }
    for (const record of records) this.publishRecord(record);
    return records;
  }

  /** Durably move a self-hosted agent to its current channel and refresh auth cache. */
  private async rebindAgentChannelCommitted(id: string, channelId: string): Promise<EntityRecord> {
    const record = await this.receiver.entityRebindAgentChannel(id, channelId);
    this.publishRecord(record, id);
    return record;
  }

  /** Retire a WorkspaceDO entity and mirror the retirement. Null if already gone. */
  private async retireCommitted(id: string): Promise<EntityRecord | null> {
    const record = await this.receiver.entityRetire(id);
    if (record) this.publishRecord(record, id);
    return record;
  }

  /** Mark post-retire cleanup complete (durable only — no cache state changes). */
  async cleanupComplete(id: string, authoritySessionId: string): Promise<void> {
    await this.receiver.entityCleanupComplete(id, authoritySessionId);
  }

  replaceResourceBindings(id: string, bindings: RuntimeResourceBindingInput[]): Promise<void> {
    return this.receiver.runtimeResourceBindingsReplace(id, bindings);
  }

  releaseResourceBindings(id: string): Promise<void> {
    return this.receiver.runtimeResourceBindingsRelease(id);
  }

  entitiesBoundToResources(resourceKind: string, resourceIds: string[]): Promise<string[]> {
    return this.receiver.runtimeResourceBindingEntities(resourceKind, resourceIds);
  }

  resourceBindingsForEntity(id: string): Promise<RuntimeResourceBindingInput[]> {
    return this.receiver.runtimeResourceBindingsForEntity(id);
  }

  // --- reads: cache-first, WorkspaceDO fallback ---

  /** Owner context for an entity. Cache-first; falls back to the WorkspaceDO. */
  async resolveContext(id: string): Promise<string | null> {
    const cached = this.deps.entityCache.resolveContext(id);
    return cached != null ? cached : this.receiver.entityResolveContext(id);
  }

  /** Resolve a (possibly retired) record by its canonical id from the WorkspaceDO. */
  resolveRecord(canonicalId: string): Promise<EntityRecord | null> {
    return this.receiver.entityResolve(canonicalId);
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
      : this.receiver.entityResolve(canonicalId);
  }

  /** Resolve the active durable identity, repairing a lost hot-cache mirror. */
  async resolveActiveRecord(canonicalId: string): Promise<EntityRecord | null> {
    const cached = this.deps.entityCache.resolveActive(canonicalId);
    if (cached) return cached;
    const record = await this.receiver.entityResolveActive(canonicalId);
    if (record) this.deps.entityCache._onActivate(record);
    return record;
  }

  /**
   * Durable nav→slot mapping: the OPEN slot id whose current runtime entity is
   * `entityId`, or null. Authoritative + lease-independent (backed by the slot
   * store's `current_entity_id` index) — used to resolve a launch's owning panel slot.
   */
  resolveSlotByEntity(entityId: string): Promise<string | null> {
    return this.receiver.slotResolveByEntity(entityId);
  }

  /** List active entities (optionally by kind) from the WorkspaceDO source of truth. */
  listActive(kind?: EntityKind): Promise<DurableEntityRecord[]> {
    return kind ? this.receiver.entityListActiveByKind(kind) : this.receiver.entityListActive();
  }

  /** Durable reservations whose executable incarnation has not committed yet. */
  listPreparing(kind?: EntityKind): Promise<DurableEntityRecord[]> {
    return kind
      ? this.receiver.entityListPreparingByKind(kind)
      : this.receiver.entityListPreparing();
  }

  /** Active executions plus retired panel-history entries that remain selectable. */
  listExecutionRoots(): Promise<DurableEntityRecord[]> {
    return this.receiver.entityListExecutionRoots();
  }

  /** All active or retired entity records that establish a context's creator lineage. */
  listByContext(contextId: string): Promise<DurableEntityRecord[]> {
    return this.receiver.entityListByContext(contextId);
  }

  // --- context-relationship registry (durable edges, no cache mirror) ---

  /** Idempotently upsert a context-relationship edge. */
  recordContextEdge(input: {
    contextId: string;
    ownerContextId: string;
    kind: ContextEdgeKind;
    ownerEntityId?: string;
    cloneDefinition?: ContextCloneDefinition;
    cloneCompletion?: ContextCloneCompletion;
  }): Promise<void> {
    return this.receiver.contextEdgeUpsert(input);
  }

  /** List edges owned BY a context, optionally scoped to one kind. */
  listContextEdgesByOwner(input: {
    ownerContextId: string;
    kind?: ContextEdgeKind;
  }): Promise<ContextEdge[]> {
    return this.receiver.contextEdgeListByOwner(input);
  }

  /** List edges INTO a context (child side) — walk up for authz/teardown. */
  listContextEdgesByChild(contextId: string): Promise<ContextEdgeByChild[]> {
    return this.receiver.contextEdgeListByChild(contextId);
  }

  /** Delete every inbound edge of a context (teardown). */
  deleteContextEdges(contextId: string): Promise<void> {
    return this.receiver.contextEdgeDeleteByChild(contextId);
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
