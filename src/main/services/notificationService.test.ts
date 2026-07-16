import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createNotificationService } from "./notificationService.js";

function createHarness() {
  const eventService = { emit: vi.fn(), emitToUser: vi.fn(() => true) };
  const service = createNotificationService({
    eventService: eventService as never,
  });
  return { service, eventService };
}

const panelCaller = (notifications: boolean) =>
  createVerifiedCaller("panel:test", "panel", {
    callerId: "panel:test",
    callerKind: "panel",
    repoPath: "panels/test",
    executionDigest: "a".repeat(64),
    delegations: [],
    requested: [
      {
        capability: "service:notification.show",
        resource: { kind: "prefix", prefix: "" },
      },
      ...(notifications
        ? [{ capability: "notifications", resource: { kind: "prefix" as const, prefix: "" } }]
        : []),
    ],
  });

async function dispatchShow(
  service: ReturnType<typeof createNotificationService>,
  notifications: boolean
) {
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return dispatcher.dispatch({ caller: panelCaller(notifications) }, "notification", "show", [
    { type: "info", title: notifications ? "Allowed" : "Denied" },
  ]);
}

describe("createNotificationService", () => {
  it("gates notification calls on the declared notifications prerequisite", async () => {
    const { service } = createHarness();

    await expect(dispatchShow(service, false)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("emits notification events when the exact code requests both capabilities", async () => {
    const { service, eventService } = createHarness();

    const id = await dispatchShow(service, true);

    expect(id).toMatch(/^notif-/);
    expect(eventService.emit).toHaveBeenCalledWith("notification:show", {
      id,
      type: "info",
      title: "Allowed",
    });
  });

  it("allows panel callers through the dispatcher policy", async () => {
    const { service, eventService } = createHarness();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    const id = await dispatcher.dispatch(
      {
        caller: createVerifiedCaller("panel:test", "panel", {
          callerId: "panel:test",
          callerKind: "panel",
          repoPath: "panels/test",
          executionDigest: "a".repeat(64),
          delegations: [],
          requested: [
            {
              capability: "service:notification.show",
              resource: { kind: "prefix", prefix: "" },
            },
            { capability: "notifications", resource: { kind: "prefix", prefix: "" } },
          ],
        }),
      },
      "notification",
      "show",
      [{ type: "info", title: "Panel notice" }]
    );

    expect(id).toMatch(/^notif-/);
    expect(eventService.emit).toHaveBeenCalledWith("notification:show", {
      id,
      type: "info",
      title: "Panel notice",
    });
  });

  it("preserves typed notification action commands", async () => {
    const { service, eventService } = createHarness();

    await service.handler({ caller: panelCaller(true) }, "show", [
      {
        type: "info",
        title: "Update",
        actions: [
          {
            id: "app.applyUpdate",
            label: "Load update",
            command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
          },
        ],
      },
    ]);

    expect(eventService.emit).toHaveBeenCalledWith(
      "notification:show",
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
          }),
        ],
      })
    );
  });

  it("implements the server-only user inbox signal declared by the schema", async () => {
    const { service, eventService } = createHarness();

    await expect(
      service.handler({ caller: createVerifiedCaller("server", "server") }, "signalUserInbox", [
        "usr_alice",
      ])
    ).resolves.toBe(true);

    expect(eventService.emitToUser).toHaveBeenCalledWith(
      "usr_alice",
      "user-notifications-changed",
      { changedAt: expect.any(Number) }
    );
  });
});
