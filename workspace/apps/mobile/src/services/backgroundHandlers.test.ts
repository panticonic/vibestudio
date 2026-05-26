jest.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

import { handleBackgroundMessage, handleBackgroundNotifeeEvent } from "./backgroundHandlers";
import { setApprovedAppCapabilities } from "./appCapabilities";

describe("backgroundHandlers", () => {
  beforeEach(() => {
    setApprovedAppCapabilities([]);
  });

  it("rejects direct background notification handlers without the notifications capability", async () => {
    const notifee = {
      cancelNotification: jest.fn(async () => undefined),
      displayNotification: jest.fn(async () => undefined),
    };

    await expect(handleBackgroundMessage(
      { data: { kind: "approval-cancel", cancelKey: "approval-bg" } },
      notifee,
    )).rejects.toThrow("background notification message requires approved app capability 'notifications'");

    await expect(handleBackgroundNotifeeEvent(
      {
        type: 1,
        detail: {
          notification: { id: "approval-bg", data: { approvalId: "approval-bg" } },
          pressAction: { id: "deny" },
        },
      },
      notifee,
      { ACTION_PRESS: 1, PRESS: 2 },
    )).rejects.toThrow("background notification action requires approved app capability 'notifications'");

    expect(notifee.cancelNotification).not.toHaveBeenCalled();
    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it("allows approved background notification cancellation", async () => {
    setApprovedAppCapabilities(["notifications"]);
    const notifee = {
      cancelNotification: jest.fn(async () => undefined),
      displayNotification: jest.fn(async () => undefined),
    };

    await handleBackgroundMessage(
      { data: { kind: "approval-cancel", cancelKey: "approval-bg" } },
      notifee,
    );

    expect(notifee.cancelNotification).toHaveBeenCalledWith("approval-bg");
    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });
});
