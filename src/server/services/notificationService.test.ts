import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { productCodeHasCapability } from "./productAuthorityGrants.js";
import { createNotificationService } from "./notificationService.js";

describe("server notification service", () => {
  it("scopes transient runtime notifications to the caller's verified account", async () => {
    const eventService = {
      emit: vi.fn(),
      emitToUser: vi.fn(() => true),
    };
    const service = createNotificationService({ eventService: eventService as never }).definition;
    const caller = createVerifiedCaller("panel:alice", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });

    const id = await service.handler({ caller }, "show", [
      { type: "info", title: "Private notice" },
    ]);

    expect(eventService.emitToUser).toHaveBeenCalledWith("usr_alice", "notification:show", {
      id,
      type: "info",
      title: "Private notice",
    });
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("routes an opaque durable-inbox nudge only to the requested verified account", async () => {
    const eventService = {
      emit: vi.fn(),
      emitToUser: vi.fn(() => true),
    };
    const service = createNotificationService({ eventService: eventService as never }).definition;

    await expect(
      service.handler(
        {
          caller: createVerifiedCaller(
            "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
            "do"
          ),
        },
        "signalUserInbox",
        ["usr_alice"]
      )
    ).resolves.toBe(true);

    expect(eventService.emitToUser).toHaveBeenCalledWith(
      "usr_alice",
      "user-notifications-changed",
      { changedAt: expect.any(Number) }
    );
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("does not grant cross-user inbox signaling to ordinary panel code", () => {
    expect(productCodeHasCapability("panels/chat", "service:notification.signalUserInbox")).toBe(
      false
    );
    expect(
      productCodeHasCapability("product/bootstrap", "service:notification.signalUserInbox")
    ).toBe(true);
  });
});
