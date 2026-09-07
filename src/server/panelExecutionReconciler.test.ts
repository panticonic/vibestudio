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
import { WorkspaceDOTestable } from "../../packages/builtin/src/workspace-state/testFixture.js";

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
  "activates durable $source distribution seeds through ordinary preparing-panel recovery",
  async (initialPanel) => {
    const { instance } = await createTestDO(WorkspaceDOTestable);
    const [seed] = instance.initializePanels([initialPanel]);
    const activate = vi.fn(async (spec: RuntimeCodePanelEntityCreateSpec) => {
      const active = instance.entityAdvanceExecution({
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

    await reconciler.ensureExecutable(detail.slot.slot_id, entity.id);

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("retries a transient activation failure without another slot event", async () => {
    vi.useFakeTimers();
    try {
      const activate = vi
        .fn<() => Promise<RuntimeEntityHandle>>()
        .mockRejectedValueOnce(new Error("build cache warming"))
        .mockResolvedValue(activeHandle);
      const onError = vi.fn();
      const reconciler = new PanelExecutionReconciler({
        getDetail: async () => detail,
        resolveSlotByEntity: async () => detail.slot.slot_id,
        listPreparingPanels: async () => [entity],
        activate,
        onError,
        retryDelayMs: () => 10,
      });

      await reconciler.recoverPreparingPanels();
      expect(activate).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(activate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
