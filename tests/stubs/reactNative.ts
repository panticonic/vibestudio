export const Alert = {
  alert: (..._args: unknown[]): void => undefined,
};

export const NativeModules: Record<string, unknown> = {};

export const Platform = {
  OS: "ios",
  select<T>(specifics: Record<string, T>): T | undefined {
    return specifics.ios ?? specifics.native ?? specifics.default;
  },
};

export const AppState = {
  currentState: "active",
  addEventListener: () => ({ remove: () => undefined }),
};

export const Linking = {
  openURL: async (_url: string): Promise<void> => undefined,
  addEventListener: () => ({ remove: () => undefined }),
  getInitialURL: async (): Promise<string | null> => null,
};

export const Appearance = {
  getColorScheme: (): "light" | "dark" | null => "light",
  addChangeListener: () => ({ remove: () => undefined }),
};

export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
};

export const View = "View";
export const Text = "Text";
export const Pressable = "Pressable";
export const SafeAreaView = "SafeAreaView";
export const ActivityIndicator = "ActivityIndicator";

export default {
  Alert,
  NativeModules,
  Platform,
  AppState,
  Linking,
  Appearance,
  StyleSheet,
  View,
  Text,
  Pressable,
  SafeAreaView,
  ActivityIndicator,
};
