import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createNotificationService } from "./notificationService.js";

describe("server notification service", () => {
  it("issues a caller-attributed id and scopes the notification to the verified account", async () => {
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
      sourcePanelId: "panel:alice",
    });
    expect(id).toMatch(/^notif-panel-[0-9a-f]{16}-/u);
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("rejects caller-provided ids and cross-caller dismissal", async () => {
    const eventService = {
      emit: vi.fn(),
      emitToUser: vi.fn(() => true),
    };
    const service = createNotificationService({ eventService: eventService as never }).definition;
    const alice = createVerifiedCaller("panel:alice", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });
    const bob = createVerifiedCaller("panel:bob", "panel", null, null, {
      userId: "usr_bob",
      handle: "bob",
    });

    await expect(
      service.handler({ caller: alice }, "show", [{ id: "chosen", type: "info", title: "Spoofed" }])
    ).rejects.toThrow();

    const id = await service.handler({ caller: alice }, "show", [{ type: "info", title: "Owned" }]);
    await expect(service.handler({ caller: bob }, "dismiss", [id])).rejects.toThrow(
      "Notification does not belong to this caller"
    );
    await expect(service.handler({ caller: alice }, "dismiss", [id])).resolves.toBeUndefined();
  });

  it("accepts user actions only from the shell belonging to the addressed account", async () => {
    const eventService = {
      emit: vi.fn(),
      emitToUser: vi.fn(() => true),
    };
    const result = createNotificationService({ eventService: eventService as never });
    const panel = createVerifiedCaller("panel:alice", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });
    const aliceShell = createVerifiedCaller("shell:alice", "shell", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });
    const bobShell = createVerifiedCaller("shell:bob", "shell", null, null, {
      userId: "usr_bob",
      handle: "bob",
    });
    const id = await result.definition.handler({ caller: panel }, "show", [
      { type: "info", title: "Actionable" },
    ]);

    await expect(
      result.definition.handler({ caller: panel }, "reportAction", [id, "open"])
    ).rejects.toThrow("Only a shell");
    await expect(
      result.definition.handler({ caller: bobShell }, "reportAction", [id, "open"])
    ).rejects.toThrow("does not belong to this user");
    await expect(
      result.definition.handler({ caller: aliceShell }, "reportAction", [id, "open"])
    ).resolves.toBeUndefined();
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
            "do:workers/workspace-source:GadWorkspaceDO:workspace",
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

  it("lets background code address a transient notification to its recorded owner", async () => {
    const eventService = {
      emit: vi.fn(),
      emitToUser: vi.fn(() => true),
    };
    const service = createNotificationService({ eventService: eventService as never }).definition;
    const caller = createVerifiedCaller("do:vibestudio/internal:MissionsDO:workspace", "do");

    const id = await service.handler({ caller }, "showToUser", [
      "usr_alice",
      {
        type: "info",
        title: "Running Daily summary",
        ttl: 6_000,
        actions: [
          {
            id: "view-automation",
            label: "View automation",
            command: {
              type: "panel.open",
              source: "about/automations",
              stateArgs: { missionId: "msn_daily" },
            },
          },
        ],
      },
    ]);

    expect(eventService.emitToUser).toHaveBeenCalledWith("usr_alice", "notification:show", {
      id,
      type: "info",
      title: "Running Daily summary",
      ttl: 6_000,
      actions: [
        expect.objectContaining({
          command: expect.objectContaining({
            type: "panel.open",
            stateArgs: { missionId: "msn_daily" },
          }),
        }),
      ],
    });
    expect(eventService.emit).not.toHaveBeenCalled();
  });
});
