import { describe, expect, it, vi } from "vitest";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import {
  cdpDefaultHostAssignmentError,
  createKnownPanelSlotResolver,
} from "./panelRuntimeRegistration.js";
import { authorizeVerifiedCaller } from "./services/authorityRuntime.js";
import { createWorkspaceStateService } from "./services/workspaceStateService.js";

describe("createKnownPanelSlotResolver", () => {
  it("performs the authoritative slot lookup as an explicit product-host call", async () => {
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:nav-slot-a",
      current_entry_key: "entry-a",
      position_id: "root",
      owner_user_id: "root",
      created_at: Date.now(),
      closed_at: null,
    };
    const doDispatch = {
      dispatch: vi.fn(async () => slot),
    };
    const authorityResolver = vi.fn(
      ({
        caller,
        service,
        capability,
        resourceKey,
      }: Parameters<NonNullable<Parameters<ServiceDispatcher["setAuthorityResolver"]>[0]>>[0]) =>
        authorizeVerifiedCaller(caller, {
          workspaceId: "ws-test",
          workspaceMember: caller.hostOriginated === true,
          sessionId: caller.runtime.id,
          audience: `service:${service}`,
          capability,
          resourceKey,
        })
    );
    const dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(authorityResolver);
    dispatcher.registerService(
      createWorkspaceStateService({
        doDispatch,
        workspaceId: "ws-test",
      })
    );
    dispatcher.markInitialized();
    const isKnownPanelSlot = createKnownPanelSlotResolver(dispatcher);

    await expect(isKnownPanelSlot("panel:tree/slot-a")).resolves.toBe(true);
    expect(authorityResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          runtime: { id: "server", kind: "server" },
          hostOriginated: true,
        }),
        service: "workspace-state",
        method: "slot.get",
      })
    );
    expect(doDispatch.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      "slotGet",
      "panel:tree/slot-a"
    );
  });

  it("propagates control-plane failures instead of misclassifying a live target as stale", async () => {
    const lookupFailure = new Error("workspace-state unavailable");
    const dispatch = vi.fn(async () => {
      throw lookupFailure;
    });
    const isKnownPanelSlot = createKnownPanelSlotResolver({ dispatch });

    await expect(isKnownPanelSlot("panel:tree/slot-a")).rejects.toBe(lookupFailure);
  });

  it("returns false only for a successful missing or closed-slot lookup", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ closed_at: Date.now() });
    const isKnownPanelSlot = createKnownPanelSlotResolver({ dispatch });

    await expect(isKnownPanelSlot("panel:tree/missing")).resolves.toBe(false);
    await expect(isKnownPanelSlot("panel:tree/closed")).resolves.toBe(false);
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
    const error = cdpDefaultHostAssignmentError(
      "panel:tree/slot-a",
      "no_default_cdp_host"
    ) as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: panel:tree/slot-a");
    expect(error.code).toBe("cdp_no_default_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(cdpDefaultHostAssignmentError("panel:tree/slot-a", "already_held")).toBeNull();
  });
});
