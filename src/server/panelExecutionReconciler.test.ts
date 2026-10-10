import { describe, expect, it, vi } from "vitest";
import type { WorkspacePanelDetail } from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type {
  EntityRecord,
  RuntimeEntityHandle,
  RuntimeCodePanelEntityCreateSpec,
} from "@vibestudio/shared/runtime/entitySpec";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { PanelExecutionReconciler } from "./panelExecutionReconciler.js";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { WorkspaceDOTestable } from "@panticonic/builtin/workspace-state/test-fixture";

it.each([
  { source: "about/new", stateArgs: { welcome: true } },
  {
    source: "panels/chat",
    stateArgs: {
      initialPrompt: "I just opened this workspace for the first time, help me get onboarded.",
      systemPrompt: "Read skills/onboarding/SKILL.md and render onboarding-setup-overview inline.",
    },
  },
])(
  "activates durable $source template seeds through ordinary preparing-panel recovery",
  async (initialPanel) => {
    const { instance } = await createTestDO(WorkspaceDOTestable);
    const [seed] = instance.initializePanels([initialPanel]);
    const activate = vi.fn(async (spec: RuntimeCodePanelEntityCreateSpec) => {
      const active = instance.entityAdvanceExecution({
        durableWorkQueues: [],
        kind: "panel",
        source: { repoPath: spec.execution.source, effectiveVersion: "seed-ev" },
        key: spec.key!,
        contextId: spec.contextId!,
        stateArgs: spec.stateArgs,
        parentId: "server",
        activeBuildKey: "a".repeat(64),
        activeExecutionDigest: "b".repeat(64),
        activeAuthority: { requests: [], provides: [] },
      });
      return {
        id: active.id,
        kind: "panel" as const,
        source: active.source,
        contextId: active.contextId,
        targetId: active.id,
      };
    });
    const onError = vi.fn();
    const reconciler = new PanelExecutionReconciler({
      getDetail: async (slotId) => instance.panelTreeDetail(slotId),
      resolveSlotByEntity: async (id) => instance.slotResolveByEntity(id),
      listPreparingPanels: async () => instance.entityListPreparingByKind("panel"),
      activate,
      onError,
    });
    await reconciler.recoverPreparingPanels();
    expect(onError).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith({
      kind: "panel",
      execution: { surface: "code", source: initialPanel.source },
      key: seed!.entity.key,
      contextId: seed!.entity.contextId,
      stateArgs: initialPanel.stateArgs,
    });
    expect(instance.panelTreeDetail(seed!.slot.slot_id)?.entity.status).toBe("active");
    // Exercise the real native lease boundary: reserved runtime keys must use
    // the same panel:nav- namespace as ordinary panel navigation.
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "seed-viewer",
      ownerCallerId: "shell:seed-viewer",
      label: "Seed viewer",
      platform: "desktop",
    });
    const acquisition = coordinator.acquire(seed!.entity.id, {
      slotId: seed!.slot.slot_id,
      clientSessionId: "seed-viewer",
      connectionId: "seed-connection",
    });
    expect(acquisition.acquired).toBe(true);
    expect(coordinator.authorizePanelConnection(seed!.entity.id, "seed-connection")).toEqual({
      ok: true,
    });
    coordinator.release(seed!.entity.id, "seed-connection");
    await reconciler.recoverPreparingPanels();
    expect(activate).toHaveBeenCalledOnce();
  }
);

const entity = {
  id: "panel:nav-entry-1",
  kind: "panel",
  status: "preparing",
  source: { repoPath: "about/browser-import-inspector", effectiveVersion: "" },
  contextId: "ctx-1",
  key: "entry-1",
  stateArgs: { mode: "inspect" },
  createdAt: 1,
  cleanupComplete: false,
} satisfies EntityRecord;

const detail = {
  revision: 1,
  slot: {
    slot_id: asPanelSlotId("panel:tree/import"),
    parent_slot_id: null,
    current_entity_id: asPanelEntityId(entity.id),
    current_entry_key: entity.key,
    sort_key: 1,
    created_at: 1,
    closed_at: null,
  },
  currentHistory: {
    slot_id: asPanelSlotId("panel:tree/import"),
    cursor: 0,
    entry_key: entity.key,
    entity_id: asPanelEntityId(entity.id),
    source: "about/browser-import-inspector",
    context_id: entity.contextId,
    state_args: JSON.stringify({ mode: "inspect" }),
    options: JSON.stringify({ ref: "main" }),
    recorded_at: 1,
  },
  entity,
} satisfies WorkspacePanelDetail;

const activeHandle = {
  id: entity.id,
  kind: "panel",
  source: { repoPath: entity.source.repoPath, effectiveVersion: "ev-1" },
  buildKey: "a".repeat(64),
  executionDigest: "b".repeat(64),
  contextId: entity.contextId,
  targetId: entity.id,
} satisfies RuntimeEntityHandle;

function harness() {
  const activate = vi.fn(async () => activeHandle);
  const onError = vi.fn();
  const getDetail = vi.fn(async () => detail);
  const reconciler = new PanelExecutionReconciler({
    getDetail,
    resolveSlotByEntity: vi.fn(async () => detail.slot.slot_id),
    listPreparingPanels: vi.fn(async () => [entity]),
    activate,
    onError,
  });
  return { reconciler, activate, onError, getDetail };
}

describe("PanelExecutionReconciler", () => {
  it("activates a committed preparing slot independently of its creator", async () => {
    const { reconciler, activate } = harness();
    reconciler.observe({
      kind: "current-entity",
      slotId: detail.slot.slot_id,
      previousEntityId: null,
      currentEntityId: entity.id,
      presentation: "awaiting-execution",
      desiredExecution: {
        source: entity.source.repoPath,
        key: entity.key,
        contextId: entity.contextId,
        stateArgs: { mode: "inspect" },
        ref: "main",
      },
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith({
      kind: "panel",
      execution: { surface: "code", source: entity.source.repoPath, ref: "main" },
      key: entity.key,
      contextId: entity.contextId,
      stateArgs: { mode: "inspect" },
    });
  });

  it("preserves an exact test artifact through committed handoff and durable recovery", async () => {
    const artifact = {
      buildKey: "c".repeat(64),
      executionDigest: "d".repeat(64),
    };
    const { reconciler, activate } = harness();
    reconciler.observe({
      kind: "current-entity",
      slotId: detail.slot.slot_id,
      previousEntityId: null,
      currentEntityId: entity.id,
      presentation: "awaiting-execution",
      desiredExecution: {
        source: entity.source.repoPath,
        key: entity.key,
        contextId: entity.contextId,
        stateArgs: { mode: "inspect" },
        artifact,
      },
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: { surface: "code", source: entity.source.repoPath, artifact },
      })
    );

    const recovery = harness();
    recovery.getDetail.mockResolvedValue({
      ...detail,
      currentHistory: {
        ...detail.currentHistory,
        options: JSON.stringify({ artifact }),
      },
    });
    await recovery.reconciler.recoverPreparingPanels();
    expect(recovery.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: { surface: "code", source: entity.source.repoPath, artifact },
      })
    );
  });

  it("does not reread durable slot state on the committed execution handoff", async () => {
    const { reconciler, activate, getDetail } = harness();

    reconciler.observe({
      kind: "current-entity",
      slotId: detail.slot.slot_id,
      previousEntityId: null,
      currentEntityId: entity.id,
      presentation: "awaiting-execution",
      desiredExecution: {
        source: entity.source.repoPath,
        key: entity.key,
        contextId: entity.contextId,
        stateArgs: { mode: "inspect" },
      },
    });

    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(getDetail).not.toHaveBeenCalled();
  });

  it("recovers preparing panel reservations on startup", async () => {
    const { reconciler, activate } = harness();
    await reconciler.recoverPreparingPanels();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("lets a runtime host join activation and verifies the durable executable state", async () => {
    let currentDetail: WorkspacePanelDetail = detail;
    const activate = vi.fn(async () => {
      currentDetail = {
        ...detail,
        entity: { ...detail.entity, status: "active" as const },
      };
      return activeHandle;
    });
    const reconciler = new PanelExecutionReconciler({
      getDetail: vi.fn(async () => currentDetail),
      resolveSlotByEntity: vi.fn(async () => detail.slot.slot_id),
      listPreparingPanels: vi.fn(async () => [entity]),
      activate,
      onError: vi.fn(),
    });

    await expect(reconciler.ensureExecutable(detail.slot.slot_id, entity.id)).resolves.toBe(true);

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("reports supersession as convergence state when the slot changes during activation", async () => {
    let currentDetail: WorkspacePanelDetail = detail;
    const reconciler = new PanelExecutionReconciler({
      getDetail: async () => currentDetail,
      resolveSlotByEntity: async () => detail.slot.slot_id,
      listPreparingPanels: async () => [],
      activate: async () => {
        currentDetail = {
          ...detail,
          entity: { ...detail.entity, id: "panel:replacement", status: "active" },
        };
        return activeHandle;
      },
      onError: vi.fn(),
    });
    await expect(reconciler.ensureExecutable(detail.slot.slot_id, entity.id)).resolves.toBe(false);
  });

  it("retains the original activation failure without rebuilding on observation or acquisition", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("No matching export: createMdxComponents");
      const { reconciler, activate, onError } = harness();
      activate.mockRejectedValue(failure);

      await expect(reconciler.recoverPreparingPanels()).rejects.toBe(failure);
      await expect(reconciler.ensureExecutable(detail.slot.slot_id, entity.id)).rejects.toBe(
        failure
      );
      await expect(reconciler.recoverPreparingPanels()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(activate).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure, detail.slot.slot_id, entity.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a failed seed before any viewer attaches and retains the diagnostic for late observation", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const failure = new Error("No matching export: createMdxComponents");
    const reconciler = new PanelExecutionReconciler({
      getDetail: async () => detail,
      resolveSlotByEntity: async () => detail.slot.slot_id,
      listPreparingPanels: async () => [entity],
      activate: async () => {
        throw failure;
      },
      onError: (error, slotId, entityId) => {
        const attempt = coordinator.ensureAttemptForSlot(slotId, entityId);
        coordinator.setBuildState(slotId, { state: "failed" });
        coordinator.reportAttemptPhase(attempt.attemptId, {
          phase: "failed",
          reporter: "build",
          failure: { stage: "build", code: "compile_failed", message: (error as Error).message },
        });
      },
    });
    await expect(reconciler.recoverPreparingPanels()).rejects.toBe(failure);
    coordinator.registerClient({
      clientSessionId: "late-viewer",
      label: "Viewer",
      platform: "desktop",
    });
    const observation = coordinator.observeSlotLifecycle(detail.slot.slot_id);
    expect(observation.build?.state).toBe("failed");
    expect(observation.attempt).toMatchObject({
      phase: "failed",
      failure: { stage: "build", code: "compile_failed", message: failure.message },
    });
    await expect(reconciler.ensureExecutable(detail.slot.slot_id, entity.id)).rejects.toBe(failure);
  });

  it("allows a new execution intent after a failed intent is replaced", async () => {
    const { reconciler, activate } = harness();
    activate.mockRejectedValueOnce(new Error("broken source"));
    await expect(reconciler.recoverPreparingPanels()).rejects.toThrow("broken source");
    reconciler.observe({
      kind: "current-entity",
      slotId: detail.slot.slot_id,
      previousEntityId: entity.id,
      currentEntityId: "panel:replacement",
      presentation: "awaiting-execution",
      desiredExecution: {
        source: entity.source.repoPath,
        key: "replacement",
        contextId: entity.contextId,
        stateArgs: {},
      },
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ key: "replacement" }));
  });

  it("ignores executable presentation changes", async () => {
    const { reconciler, activate } = harness();
    reconciler.observe({
      kind: "current-entity",
      slotId: detail.slot.slot_id,
      previousEntityId: null,
      currentEntityId: entity.id,
      presentation: "executable",
    });
    await Promise.resolve();
    expect(activate).not.toHaveBeenCalled();
  });
});
