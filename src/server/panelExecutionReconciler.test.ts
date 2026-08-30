import { describe, expect, it, vi } from "vitest";
import type { WorkspacePanelDetail } from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type { EntityRecord, RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { PanelExecutionReconciler } from "./panelExecutionReconciler.js";

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
