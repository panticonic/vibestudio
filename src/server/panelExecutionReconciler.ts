import type { WorkspacePanelDetail } from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type {
  EntityRecord,
  RuntimeCodePanelEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import type { SlotStateChange } from "./services/workspaceStateService.js";

export interface PanelExecutionReconcilerDeps {
  getDetail(slotId: string): Promise<WorkspacePanelDetail | null>;
  resolveSlotByEntity(entityId: string): Promise<string | null>;
  listPreparingPanels(): Promise<EntityRecord[]>;
  activate(spec: RuntimeCodePanelEntityCreateSpec): Promise<RuntimeEntityHandle>;
  onError(error: unknown, slotId: string, entityId: string): void;
}

/**
 * Level-triggered owner of the preparing -> executable panel transition.
 *
 * Slot creation commits the durable intent. From that point onward activation
 * belongs to the server, not to the RPC/eval request that happened to create
 * the slot. Replaying a change or the startup sweep is therefore safe.
 */
export class PanelExecutionReconciler {
  // A failed execution remains owned until its slot is replaced or closed.
  // Re-observing the same intent joins its original outcome, not another build.
  private readonly executions = new Map<string, { entityId: string; promise: Promise<void> }>();

  constructor(private readonly deps: PanelExecutionReconcilerDeps) {}

  observe(change?: SlotStateChange): void {
    if (change?.kind === "closed") {
      for (const slotId of change.slotIds) this.executions.delete(slotId);
      return;
    }
    if (change?.kind !== "current-entity") return;
    if (this.executions.get(change.slotId)?.entityId !== change.currentEntityId) {
      this.executions.delete(change.slotId);
    }
    if (change.presentation !== "awaiting-execution") return;
    void this.resume(
      change.slotId,
      change.currentEntityId,
      change.desiredExecution
        ? {
            kind: "panel",
            execution: {
              surface: "code",
              source: change.desiredExecution.source,
              ...(change.desiredExecution.ref ? { ref: change.desiredExecution.ref } : {}),
              ...(change.desiredExecution.artifact
                ? { artifact: change.desiredExecution.artifact }
                : {}),
            },
            key: change.desiredExecution.key,
            contextId: change.desiredExecution.contextId,
            stateArgs: change.desiredExecution.stateArgs,
          }
        : undefined
    ).catch(() => {
      // The activation owner has published the failure; event delivery has no caller.
    });
  }

  async recoverPreparingPanels(): Promise<void> {
    const preparing = await this.deps.listPreparingPanels();
    const outcomes = await Promise.allSettled(
      preparing.map(async (entity) => {
        const slotId = await this.deps.resolveSlotByEntity(entity.id);
        if (slotId) await this.resume(slotId, entity.id);
      })
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Panel recovery failed"
      );
    }
  }

  /**
   * Join the authoritative activation for the entity currently presented by a
   * slot. Runtime hosts use this as a level-triggered boundary before they
   * materialize a lease, so correctness does not depend on observing the
   * one-shot executionActivated event.
   */
  async ensureExecutable(slotId: string, entityId: string): Promise<boolean> {
    await this.resume(slotId, entityId);
    const detail = await this.deps.getDetail(slotId);
    if (!detail || detail.slot.current_entity_id !== entityId || detail.entity.id !== entityId) {
      return false;
    }
    if (detail.entity.status !== "active") {
      throw new Error(
        `Panel execution target ${entityId} did not become executable (status: ${detail.entity.status})`
      );
    }
    return true;
  }

  private resume(
    slotId: string,
    entityId: string,
    desiredSpec?: RuntimeCodePanelEntityCreateSpec
  ): Promise<void> {
    const existing = this.executions.get(slotId);
    if (existing?.entityId === entityId) return existing.promise;
    const startedAt = performance.now();
    console.info(
      `[PanelExecution] Activating ${entityId} for ${slotId} (${desiredSpec ? "committed handoff" : "durable recovery"})`
    );
    let failed = false;
    const work = this.activateCurrent(slotId, entityId, desiredSpec)
      .then(() => {
        console.info(
          `[PanelExecution] Activated ${entityId} for ${slotId} in ${Math.round(performance.now() - startedAt)}ms`
        );
      })
      .catch((error) => {
        failed = true;
        if (this.executions.get(slotId)?.promise === work) {
          this.deps.onError(error, slotId, entityId);
        }
        throw error;
      })
      .finally(() => {
        if (!failed && this.executions.get(slotId)?.promise === work) {
          this.executions.delete(slotId);
        }
      });
    this.executions.set(slotId, { entityId, promise: work });
    return work;
  }

  private async activateCurrent(
    slotId: string,
    entityId: string,
    desiredSpec?: RuntimeCodePanelEntityCreateSpec
  ): Promise<void> {
    // slot.create has already committed both the reservation and its durable
    // slot binding before it emits the in-process handoff. That exact intent
    // can enter execution directly; querying it back first adds no validation
    // and lets unrelated WorkspaceDO traffic head-of-line block first paint.
    if (desiredSpec) {
      await this.deps.activate(desiredSpec);
      return;
    }
    const detail = await this.deps.getDetail(slotId);
    if (!detail || detail.slot.current_entity_id !== entityId || detail.entity.id !== entityId)
      return;
    if (detail.entity.status !== "preparing") return;
    if (detail.entity.kind !== "panel") {
      throw new Error(`Slot ${slotId} points at non-panel reservation ${entityId}`);
    }
    if (detail.currentHistory.source.startsWith("browser:")) {
      throw new Error(`Browser slot ${slotId} cannot have a preparing code reservation`);
    }
    const options = detail.currentHistory.options
      ? (JSON.parse(detail.currentHistory.options) as { ref?: unknown; artifact?: unknown })
      : {};
    const stateArgs = detail.currentHistory.state_args
      ? (JSON.parse(detail.currentHistory.state_args) as unknown)
      : {};
    const ref = typeof options.ref === "string" && options.ref.length > 0 ? options.ref : undefined;
    const artifact =
      options.artifact && typeof options.artifact === "object"
        ? (options.artifact as { buildKey: string; executionDigest: string })
        : undefined;
    await this.deps.activate({
      kind: "panel",
      execution: {
        surface: "code",
        source: detail.currentHistory.source,
        ...(ref ? { ref } : {}),
        ...(artifact ? { artifact } : {}),
      },
      key: detail.entity.key,
      contextId: detail.entity.contextId,
      stateArgs,
    });
  }
}
