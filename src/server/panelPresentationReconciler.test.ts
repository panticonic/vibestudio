import { describe, expect, it, vi } from "vitest";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { reconcilePanelPresentationChange } from "./panelPresentationReconciler.js";

const change = {
  kind: "current-entity" as const,
  slotId: "panel:tree/news",
  previousEntityId: "panel:nav-about-new",
  currentEntityId: "panel:nav-news",
  presentation: "executable" as const,
};

describe("reconcilePanelPresentationChange", () => {
  it("moves an existing slot lease to the durable current entity", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });
    coordinator.acquire(change.previousEntityId, {
      slotId: change.slotId,
      clientSessionId: "desktop",
      connectionId: "old-connection",
    });

    reconcilePanelPresentationChange(coordinator, change);

    expect(coordinator.getLease(change.previousEntityId)).toBeNull();
    expect(coordinator.getLease(change.currentEntityId)).toMatchObject({
      slotId: change.slotId,
      runtimeEntityId: change.currentEntityId,
      clientSessionId: "desktop",
    });
  });

  it("leaves an unleased executable slot unloaded even when a host is available", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "headless",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });

    expect(reconcilePanelPresentationChange(coordinator, change)).toBeNull();
    expect(coordinator.getLease(change.currentEntityId)).toBeNull();
  });

  it("ignores changes which do not alter desired presentation", () => {
    const coordinator = { advanceResidentSlotEntity: vi.fn() };
    expect(reconcilePanelPresentationChange(coordinator, { kind: "tree" })).toBeNull();
    expect(
      reconcilePanelPresentationChange(coordinator, {
        ...change,
        previousEntityId: change.currentEntityId,
      })
    ).toBeNull();
    expect(coordinator.advanceResidentSlotEntity).not.toHaveBeenCalled();
  });

  it("does not host a reserved entity before its execution identity is sealed", () => {
    const coordinator = { advanceResidentSlotEntity: vi.fn() };
    expect(
      reconcilePanelPresentationChange(coordinator, {
        ...change,
        presentation: "awaiting-execution",
      })
    ).toBeNull();
    expect(coordinator.advanceResidentSlotEntity).not.toHaveBeenCalled();
  });
});
