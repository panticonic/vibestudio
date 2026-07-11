// Must be the first import: react-native-gesture-handler requires its native
// side to be initialized before anything renders. The drawer navigator and the
// panel-tree swipe gestures depend on it.
import "react-native-gesture-handler";
import "./src/setupGlobals";
import React, { useEffect, useRef } from "react";
import { AppRegistry, Appearance, Linking, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { setApprovedAppCapabilities } from "./src/services/appCapabilities";
import { registerBackgroundHandlers } from "./src/services/backgroundHandlers";
import { setupOAuthHandler } from "./src/services/oauthHandler";
import { setupNotificationCategories } from "./src/services/notificationCategories";
import { registerForPushNotifications } from "./src/services/pushNotifications";
import { colorSchemeAtom, isDarkModeAtom } from "./src/state/themeAtoms";
import { shellClientAtom } from "./src/state/shellClientAtom";
import { approvalDeepLinkAtom } from "./src/state/approvalDeepLinkAtom";
import { pushToastAtom } from "./src/state/toastAtoms";
import { parsePanelLocationLink, type PanelLocation } from "@vibestudio/shared/panelLocation";

const APPROVED_APP_CAPABILITIES = [
  "notifications",
  "keychain",
  "clipboard",
  "open-external",
] satisfies readonly AppCapability[];

setApprovedAppCapabilities(APPROVED_APP_CAPABILITIES);
registerBackgroundHandlers();

function AppContent() {
  const shellClient = useAtomValue(shellClientAtom);
  const isDark = useAtomValue(isDarkModeAtom);
  const setColorScheme = useSetAtom(colorSchemeAtom);
  const setApprovalDeepLink = useSetAtom(approvalDeepLinkAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const consumedPanelLinks = useRef(new Set<string>());

  // Track the system color scheme at the app root so the theme follows the OS
  // on every screen (login, settings, panels) — not only while MainScreen is
  // mounted. When a shell session exists, mirror the change to managed panels.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme: nextScheme }) => {
      setColorScheme(nextScheme);
      if (shellClient) {
        void shellClient.panels.updateTheme(nextScheme === "light" ? "light" : "dark");
      }
    });
    return () => subscription.remove();
  }, [shellClient, setColorScheme]);

  // Set up OAuth deep link handler when the shell client is available
  useEffect(() => {
    if (!shellClient) return;
    const cleanup = setupOAuthHandler(shellClient);
    return cleanup;
  }, [shellClient]);

  useEffect(() => {
    if (!shellClient) return;
    const openLocation = async (location: PanelLocation) => {
      if (location.workspace && location.workspace !== shellClient.workspaceId) {
        pushToast({
          title: "Panel link targets another workspace",
          message: `Switch to ${location.workspace} before opening this link.`,
          tone: "warning",
        });
        return;
      }
      const focusedPanelId = shellClient.panels.registry.getFocusedPanelId();
      const common = {
        ref: location.ref,
        contextId: location.contextId,
        stateArgs: location.stateArgs,
      };
      const disposition = location.disposition ?? "root";
      if (disposition === "current" && focusedPanelId) {
        await shellClient.panels.navigatePanel(focusedPanelId, location.source, common);
      } else if (disposition === "child" && focusedPanelId) {
        await shellClient.panels.createChildPanel(focusedPanelId, location.source, {
          ...common,
          name: location.name,
          focus: location.focus ?? true,
        });
      } else {
        await shellClient.panels.createRootPanel(location.source, {
          ...common,
          name: location.name,
          focus: location.focus ?? true,
        });
      }
    };
    const handleUrl = (raw: string) => {
      const parsed = parsePanelLocationLink(raw);
      if (parsed.kind !== "ok" || consumedPanelLinks.current.has(raw)) return;
      consumedPanelLinks.current.add(raw);
      void openLocation(parsed.location).catch((error: unknown) => {
        pushToast({
          title: "Panel link could not be opened",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      });
    };
    void Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, [pushToast, shellClient]);

  useEffect(() => {
    if (!shellClient) return;
    let cleanup: (() => void) | null = null;
    let disposed = false;

    void setupNotificationCategories()
      .then(() =>
        registerForPushNotifications(shellClient, {
          onApprovalDeepLink: (approvalId) => setApprovalDeepLink(approvalId),
          onToast: (toast) => pushToast(toast),
        })
      )
      .then((nextCleanup) => {
        if (disposed) {
          nextCleanup();
          return;
        }
        cleanup = nextCleanup;
      })
      .catch((error) => {
        console.warn("[App] Failed to initialize push notifications:", error);
        pushToast({
          durationMs: 7000,
          message: error instanceof Error ? error.message : String(error),
          title: "Push notifications unavailable",
          tone: "warning",
        });
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [pushToast, setApprovalDeepLink, shellClient]);

  return (
    <>
      <StatusBar
        barStyle={isDark ? "light-content" : "dark-content"}
        translucent
        backgroundColor="transparent"
      />
      <ErrorBoundary label="App">
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </ErrorBoundary>
    </>
  );
}

function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <JotaiProvider>
          <AppContent />
        </JotaiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

AppRegistry.registerComponent("Vibestudio", () => App);

export default App;
