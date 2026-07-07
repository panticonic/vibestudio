jest.mock(
  "@react-native-firebase/messaging",
  () => {
    const messaging = jest.fn(() => ({
      getToken: jest.fn(async () => "test-fcm-token"),
      onTokenRefresh: jest.fn(() => jest.fn()),
      onMessage: jest.fn(() => jest.fn()),
      setBackgroundMessageHandler: jest.fn(),
      requestPermission: jest.fn(async () => 1),
      hasPermission: jest.fn(async () => 1),
    }));
    return messaging;
  },
  { virtual: true }
);

jest.mock(
  "@notifee/react-native",
  () => ({
    __esModule: true,
    default: {
      cancelNotification: jest.fn(async () => undefined),
      createChannel: jest.fn(async () => "approvals"),
      displayNotification: jest.fn(async () => undefined),
      onBackgroundEvent: jest.fn(),
      onForegroundEvent: jest.fn(() => jest.fn()),
      requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
      setNotificationCategories: jest.fn(async () => undefined),
    },
    AndroidImportance: { HIGH: 4 },
    AuthorizationStatus: { AUTHORIZED: 1, PROVISIONAL: 2 },
    EventType: { ACTION_PRESS: 1, PRESS: 2, DISMISSED: 3 },
    IOSNotificationCategoryActionForeground: true,
  }),
  { virtual: true }
);

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => undefined),
    multiRemove: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
  setGenericPassword: jest.fn(async () => true),
}));

jest.mock("react-native-haptic-feedback", () => ({
  trigger: jest.fn(),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  },
}));

jest.mock("react-native-webrtc", () => ({
  mediaDevices: {},
  RTCIceCandidate: jest.fn(),
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
}));

jest.mock(
  "@react-native-clipboard/clipboard",
  () => ({
    __esModule: true,
    default: {
      setString: jest.fn(),
      getString: jest.fn(async () => ""),
    },
  }),
  { virtual: true }
);

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  SafeAreaView: "SafeAreaView",
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  },
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const { NativeModules } = jest.requireActual("react-native");
NativeModules.VibestudioMobileHost = {
  firebaseConfigured: true,
  clearCredentials: jest.fn(async () => undefined),
  resetToNativeBootstrap: jest.fn(async () => ({ reloading: true })),
  appendBundleChunk: jest.fn(async () => undefined),
  finalizeBundleWrite: jest.fn(async () => ({ localPath: "/bundle.js" })),
  activatePreparedAppBundle: jest.fn(async () => ({ activated: false })),
};
