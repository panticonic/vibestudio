import { describe, expect, it, vi } from "vitest";
import type { EventService } from "@natstack/shared/eventsService";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";

describe("PanelRuntimeCoordinator", () => {
  function createCoordinator() {
    const eventService = { emit: vi.fn() };
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "desktop-a",
      label: "Desktop A",
      platform: "desktop",
    });
    coordinator.registerClient({
      clientSessionId: "desktop-b",
      label: "Desktop B",
      platform: "desktop",
    });
    return { coordinator, eventService, closeConnection };
  }

  it("stores leases by runtime entity while exposing the owning slot", () => {
    const { coordinator } = createCoordinator();

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    expect(result.acquired).toBe(true);
    expect(result.lease).toMatchObject({
      slotId: "slot-a",
      runtimeEntityId: "panel:nav-entity-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });
    expect(coordinator.getLease("panel:nav-entity-a")?.slotId).toBe("slot-a");
    expect(coordinator.getSnapshot().leases).toMatchObject([
      {
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
      },
    ]);
  });

  it("lets the same client session reacquire on reconnect without takeover", () => {
    const { coordinator, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a2",
    });

    expect(result.acquired).toBe(true);
    expect(result.lease.connectionId).toBe("conn-a2");
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it("does not grant a live runtime lease to a different client session", () => {
    const { coordinator } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-b",
      connectionId: "conn-b1",
    });

    expect(result.acquired).toBe(false);
    expect(result.lease.clientSessionId).toBe("desktop-a");
    expect(result.lease.connectionId).toBe("conn-a1");
  });

  it("emits slot and runtime entity ids separately on takeover", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.takeOver("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-b",
      connectionId: "conn-b1",
    });

    expect(result.acquired).toBe(true);
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-entity-a",
      "conn-a1",
      4091,
      "Panel runtime lease revoked"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "desktop-b" }),
      })
    );
  });

  it("closes and releases runtime leases when the entity is retired", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    coordinator.retireRuntimeEntity("panel:nav-entity-a");

    expect(coordinator.getLease("panel:nav-entity-a")).toBeNull();
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-entity-a",
      "conn-a1",
      4093,
      "Panel runtime entity retired"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "retired",
        next: null,
      })
    );
  });
});
