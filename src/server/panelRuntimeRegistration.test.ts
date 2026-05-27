import { describe, expect, it, vi } from "vitest";
import {
  cdpDefaultHostAssignmentError,
  panelHostCommandAssignmentError,
  resolveImplicitCreateParentId,
  snapshotBrowserPanelFromCdpBridge,
} from "./panelRuntimeRegistration.js";

describe("resolveImplicitCreateParentId", () => {
  it("uses an explicit parent id when provided", () => {
    const parentId = resolveImplicitCreateParentId({
      explicitParentId: "slot-explicit",
      callerId: "panel:entity-caller",
      callerKind: "panel",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-explicit",
    });

    expect(parentId).toBe("slot-explicit");
  });

  it("maps panel caller runtime entity ids to their leased slot for implicit parents", () => {
    const parentId = resolveImplicitCreateParentId({
      callerId: "panel:entity-caller",
      callerKind: "panel",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-caller",
    });

    expect(parentId).toBe("slot-caller");
  });

  it("does not invent an implicit parent for non-panel callers", () => {
    const parentId = resolveImplicitCreateParentId({
      callerId: "worker-1",
      callerKind: "worker",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-caller",
    });

    expect(parentId).toBeUndefined();
  });
});

describe("cdpDefaultHostAssignmentError", () => {
  it("classifies non-CDP mobile holders distinctly", () => {
    const error = cdpDefaultHostAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe(
      "CDP is unavailable while panel slot-mobile is held by a non-CDP host"
    );
    expect(error.code).toBe("cdp_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = cdpDefaultHostAssignmentError("slot-a", "no_default_cdp_host") as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: slot-a");
    expect(error.code).toBe("cdp_no_default_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(cdpDefaultHostAssignmentError("slot-a", "already_held")).toBeNull();
  });
});

describe("panelHostCommandAssignmentError", () => {
  it("classifies mobile-held structural host commands distinctly", () => {
    const error = panelHostCommandAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe("Panel slot-mobile is held by a non-CDP host");
    expect(error.code).toBe("panel_host_command_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = panelHostCommandAssignmentError("slot-a", "no_default_cdp_host") as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: slot-a");
    expect(error.code).toBe("panel_host_command_no_default_cdp_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(panelHostCommandAssignmentError("slot-a", "already_held")).toBeNull();
  });
});

describe("snapshotBrowserPanelFromCdpBridge", () => {
  it("serves browser panel snapshots through the host accessibility command", async () => {
    const nodes = [
      { role: { value: "RootWebArea" }, name: { value: "Example" } },
      { role: { value: "button" }, name: { value: "Submit" } },
    ];
    const cdpBridge = {
      isTargetRegistered: () => true,
      sendHostCommand: vi.fn(async () => nodes),
    };

    const snapshot = await snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot");

    expect(snapshot).toEqual({
      kind: "ax",
      text: "RootWebArea: Example\nbutton: Submit",
      structure: nodes,
    });
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("browser-slot", "accessibilityTree", []);
  });

  it("does not auto-load browser targets for snapshots", async () => {
    const cdpBridge = {
      isTargetRegistered: () => false,
      sendHostCommand: vi.fn(),
    };

    await expect(snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot")).rejects.toThrow(
      "target-not-loaded: browser-slot"
    );
    expect(cdpBridge.sendHostCommand).not.toHaveBeenCalled();
  });
});
