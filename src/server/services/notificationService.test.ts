import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
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

  it("does not expose cross-user inbox signaling to panels", async () => {
    const service = createNotificationService({
      eventService: { emit: vi.fn(), emitToUser: vi.fn() } as never,
    }).definition;
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("panel:chat", "panel") },
        "notification",
        "signalUserInbox",
        ["usr_bob"]
      )
    ).rejects.toThrow(/not accessible/);
  });
});
