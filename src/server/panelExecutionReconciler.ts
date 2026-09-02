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
  retryDelayMs?(attempt: number): number;
}

/**
 * Level-triggered owner of the preparing -> executable panel transition.
 *
 * Slot creation commits the durable intent. From that point onward activation
 * belongs to the server, not to the RPC/eval request that happened to create
 * the slot. Replaying a change or the startup sweep is therefore safe.
 */
export class PanelExecutionReconciler {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: PanelExecutionReconcilerDeps) {}

  observe(change?: SlotStateChange): void {
    if (change?.kind !== "current-entity" || change.presentation !== "awaiting-execution") return;
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
    );
  }

  async recoverPreparingPanels(): Promise<void> {
    const preparing = await this.deps.listPreparingPanels();
    await Promise.all(
      preparing.map(async (entity) => {
        const slotId = await this.deps.resolveSlotByEntity(entity.id);
        if (slotId) await this.resume(slotId, entity.id);
      })
    );
  }

  /**
   * Join the authoritative activation for the entity currently presented by a
   * slot. Runtime hosts use this as a level-triggered boundary before they
   * materialize a lease, so correctness does not depend on observing the
   * one-shot executionActivated event.
   */
  async ensureExecutable(slotId: string, entityId: string): Promise<void> {
    await this.resume(slotId, entityId);
    const detail = await this.deps.getDetail(slotId);
    if (!detail || detail.slot.current_entity_id !== entityId || detail.entity.id !== entityId) {
      throw new Error(`Panel execution target ${entityId} is no longer current for ${slotId}`);
    }
    if (detail.entity.status !== "active") {
      throw new Error(
        `Panel execution target ${entityId} did not become executable (status: ${detail.entity.status})`
      );
    }
  }

  private resume(
    slotId: string,
    entityId: string,
    desiredSpec?: RuntimeCodePanelEntityCreateSpec
  ): Promise<void> {
    const existing = this.inFlight.get(entityId);
    if (existing) return existing;
    const startedAt = performance.now();
    console.info(
      `[PanelExecution] Activating ${entityId} for ${slotId} (${desiredSpec ? "committed handoff" : "durable recovery"})`
    );
    let failed = false;
    const work = this.activateCurrent(slotId, entityId, desiredSpec)
      .then(() => {
        this.retryAttempts.delete(entityId);
        console.info(
          `[PanelExecution] Activated ${entityId} for ${slotId} in ${Math.round(performance.now() - startedAt)}ms`
        );
      })
      .catch((error) => {
        failed = true;
        this.deps.onError(error, slotId, entityId);
      })
      .finally(() => {
        if (this.inFlight.get(entityId) !== work) return;
        this.inFlight.delete(entityId);
        if (failed) this.scheduleRetry(slotId, entityId);
      });
    this.inFlight.set(entityId, work);
    return work;
  }

  private scheduleRetry(slotId: string, entityId: string): void {
    if (this.retryTimers.has(entityId)) return;
    const attempt = (this.retryAttempts.get(entityId) ?? 0) + 1;
    this.retryAttempts.set(entityId, attempt);
    const delay =
      this.deps.retryDelayMs?.(attempt) ?? Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
    const timer = setTimeout(() => {
      if (this.retryTimers.get(entityId) !== timer) return;
      this.retryTimers.delete(entityId);
      void this.resume(slotId, entityId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(entityId, timer);
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
