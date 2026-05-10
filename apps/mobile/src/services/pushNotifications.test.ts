import { AppState } from "react-native";
import {
  registerForPushNotifications,
  reconcilePushNotifications,
} from "./pushNotifications";
import { handleBackgroundNotifeeEvent } from "./backgroundHandlers";
import { backgroundActionQueueStorageKeys, SYNCING_NOTIFICATION_BODY } from "./backgroundActionQueue";

type MockShellClient = {
  transport: {
    status: "connected" | "connecting" | "disconnected";
    call: jest.Mock;
    onReconnect: jest.Mock;
  };
};

const mockStorage = new Map<string, string>();
const mockListeners = {
  tokenRefresh: undefined as ((token: string) => void) | undefined,
  message: undefined as ((message: unknown) => void) | undefined,
  foreground: undefined as ((event: unknown) => void) | undefined,
  reconnect: undefined as (() => void) | undefined,
  appState: undefined as ((state: string) => void) | undefined,
};

const mockMessagingInstance = {
  requestPermission: jest.fn(async () => 1),
  getToken: jest.fn(async () => "token-1"),
  deleteToken: jest.fn(async () => undefined),
  onTokenRefresh: jest.fn((callback: (token: string) => void) => {
    mockListeners.tokenRefresh = callback;
    return jest.fn();
  }),
  onMessage: jest.fn((callback: (message: unknown) => void) => {
    mockListeners.message = callback;
    return jest.fn();
  }),
  onNotificationOpenedApp: jest.fn(() => jest.fn()),
  getInitialNotification: jest.fn(async () => null),
};

const mockMessagingFactory = jest.fn(() => mockMessagingInstance);

const mockNotifee = {
  cancelNotification: jest.fn(async () => undefined),
  displayNotification: jest.fn(async () => undefined),
  getDisplayedNotifications: jest.fn(async () => []),
  onForegroundEvent: jest.fn((callback: (event: unknown) => void) => {
    mockListeners.foreground = callback;
    return jest.fn();
  }),
  requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
};

jest.mock("@react-native-firebase/messaging", () => mockMessagingFactory, { virtual: true });
jest.mock(
  "@notifee/react-native",
  () => ({
    __esModule: true,
    default: mockNotifee,
    EventType: { ACTION_PRESS: 1, PRESS: 2 },
  }),
  { virtual: true },
);
jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
  }),
  { virtual: true },
);
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => true),
}));

const appStateSpy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
  mockListeners.appState = callback as (state: string) => void;
  return { remove: jest.fn() };
});

function createShellClient(status: MockShellClient["transport"]["status"] = "connected"): MockShellClient {
  return {
    transport: {
      status,
      call: jest.fn(async (_target: string, method: string) => {
        if (method === "shellApproval.listPending") {
          return [{ approvalId: "approval-1" }];
        }
        return undefined;
      }),
      onReconnect: jest.fn((callback: () => void) => {
        mockListeners.reconnect = callback;
        return jest.fn();
      }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.clear();
  mockListeners.tokenRefresh = undefined;
  mockListeners.message = undefined;
  mockListeners.foreground = undefined;
  mockListeners.reconnect = undefined;
  mockListeners.appState = undefined;
  mockMessagingInstance.requestPermission.mockResolvedValue(1);
  mockMessagingInstance.getInitialNotification.mockResolvedValue(null);
  mockMessagingInstance.getToken.mockResolvedValue("token-1");
  mockNotifee.getDisplayedNotifications.mockResolvedValue([]);
});

afterAll(() => {
  appStateSpy.mockRestore();
});

describe("pushNotifications", () => {
  it("registers the initial token and refreshed tokens", async () => {
    const shellClient = createShellClient();

    await registerForPushNotifications(shellClient as never);
    mockListeners.tokenRefresh?.("token-2");
    await Promise.resolve();

    expect(shellClient.transport.call).toHaveBeenCalledWith(
      "main",
      "push.register",
      expect.objectContaining({ token: "token-1", platform: expect.stringMatching(/^(android|ios)$/) }),
    );
    expect(shellClient.transport.call).toHaveBeenCalledWith(
      "main",
      "push.register",
      expect.objectContaining({ token: "token-2", platform: expect.stringMatching(/^(android|ios)$/) }),
    );
  });

  it("resolves foreground deny actions immediately and cancels notification", async () => {
    const shellClient = createShellClient();
    await registerForPushNotifications(shellClient as never);

    await mockListeners.foreground?.({
      type: 1,
      detail: {
        notification: { id: "approval-1", data: { approvalId: "approval-1" } },
        pressAction: { id: "deny" },
      },
    });

    expect(shellClient.transport.call).toHaveBeenCalledWith(
      "main",
      "shellApproval.resolve",
      "approval-1",
      "deny",
    );
    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
  });

  it("queues background-equivalent foreground actions when disconnected without cancelling", async () => {
    const shellClient = createShellClient("disconnected");
    await registerForPushNotifications(shellClient as never);

    await mockListeners.foreground?.({
      type: 1,
      detail: {
        notification: { id: "approval-1", title: "Approval", data: { approvalId: "approval-1" } },
        pressAction: { id: "deny" },
      },
    });

    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("approval-1");
    expect(mockNotifee.displayNotification).toHaveBeenCalledWith(expect.objectContaining({
      id: "approval-1",
      body: SYNCING_NOTIFICATION_BODY,
    }));
    expect(mockStorage.get(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toContain("approval-1");
  });

  it("queues background deny actions without cancelling the notification", async () => {
    const backgroundNotifee = {
      cancelNotification: jest.fn(async () => undefined),
      displayNotification: jest.fn(async () => undefined),
    };

    await handleBackgroundNotifeeEvent(
      {
        type: 1,
        detail: {
          notification: { id: "approval-bg", title: "Approval", data: { approvalId: "approval-bg" } },
          pressAction: { id: "deny" },
        },
      },
      backgroundNotifee,
      { ACTION_PRESS: 1, PRESS: 2 },
    );

    expect(backgroundNotifee.cancelNotification).not.toHaveBeenCalled();
    expect(backgroundNotifee.displayNotification).toHaveBeenCalledWith(expect.objectContaining({
      id: "approval-bg",
      body: SYNCING_NOTIFICATION_BODY,
    }));
    expect(mockStorage.get(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toContain("approval-bg");
  });

  it("drains queued actions on reconnect with resolve then cancel", async () => {
    mockStorage.set(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY, JSON.stringify({
      version: 1,
      actions: [{ approvalId: "approval-1", decision: "session", queuedAt: Date.now() }],
    }));
    const shellClient = createShellClient();
    await registerForPushNotifications(shellClient as never);

    await mockListeners.reconnect?.();

    expect(shellClient.transport.call).toHaveBeenCalledWith(
      "main",
      "shellApproval.resolve",
      "approval-1",
      "session",
    );
    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
    expect(mockStorage.has(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toBe(false);
  });

  it("handles silent cancel data messages", async () => {
    const shellClient = createShellClient();
    await registerForPushNotifications(shellClient as never);

    mockListeners.message?.({
      data: {
        kind: "approval-cancel",
        cancelKey: "approval-1",
      },
    });
    await Promise.resolve();

    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
  });

  it("reconciles stale displayed notifications", async () => {
    const shellClient = createShellClient();
    mockNotifee.getDisplayedNotifications.mockResolvedValue([
      { notification: { id: "approval-1" } },
      { notification: { id: "stale-approval" } },
    ] as never);

    await reconcilePushNotifications(shellClient as never, mockNotifee);

    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("stale-approval");
    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("approval-1");
  });
});
