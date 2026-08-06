import type { SlotStateChange } from "./services/workspaceStateService.js";

export interface PanelPresentationCoordinator {
  advanceResidentSlotEntity(slotId: string, runtimeEntityId: string): unknown;
}

/**
 * Keep an existing presentation lease aligned with the WorkspaceDO's current
 * immutable entity.
 *
 * Executability and residency are independent facts. This projection is
 * deliberately unable to allocate a host: an unloaded slot remains unloaded.
 * Explicit consumers create residency through panelRuntime.ensureSlot, native
 * visible-pane loading, or CDP automation.
 */
export function reconcilePanelPresentationChange(
  coordinator: PanelPresentationCoordinator,
  change?: SlotStateChange
): unknown | null {
  if (change?.kind !== "current-entity") return null;
  if (change.presentation !== "executable") return null;
  if (change.previousEntityId === change.currentEntityId) return null;
  return coordinator.advanceResidentSlotEntity(change.slotId, change.currentEntityId);
}
