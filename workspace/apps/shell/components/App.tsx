import { useEffect, useCallback, useState, lazy, Suspense } from "react";
import { useSetAtom } from "jotai";
import { Theme, Flex, Spinner, Text } from "@radix-ui/themes";
import { Vibez1Logo, type AppTheme } from "@workspace/ui";

import { workspaceChooserDialogOpenAtom, activeWorkspaceNameAtom } from "../state/appModeAtoms";
import {
  effectiveThemeAtom,
  loadThemePreferenceAtom,
  themeConfigAtom,
  loadThemeConfigAtom,
} from "../state/themeAtoms";
import { useAtomValue } from "jotai";
import { useShellEvent } from "../shell/useShellEvent";
import { panel, workspace } from "../shell/client";
import { ChunkErrorBoundary } from "./ChunkErrorBoundary";
import { AppCommandPalette } from "./AppCommandPalette";

// Lazy-load MainMode — this creates a separate chunk containing PanelApp,
// PanelStack, TitleBar, LazyPanelTreeSidebar, @dnd-kit/*, and all transitive deps.
// Mutable: reassigned on retry because React.lazy caches rejected promises permanently.
let LazyMainMode = lazy(() => import("./MainMode"));

function LoadingSpinner() {
  return (
    <Flex direction="column" align="center" justify="center" gap="3" style={{ height: "100dvh" }}>
      <Vibez1Logo size={72} variant="tile" />
      <Spinner size="3" />
      <Text size="2" color="gray">
        Loading Vibez1
      </Text>
    </Flex>
  );
}

/**
 * Root App component that renders the main panel app.
 */
export function App() {
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const loadThemeConfig = useSetAtom(loadThemeConfigAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);
  // Counter to force remount of lazy component after a chunk load failure.
  const [lazyRetryKey, setLazyRetryKey] = useState(0);

  // Load theme preference on mount
  useEffect(() => {
    loadThemePreference();
    loadThemeConfig();
  }, [loadThemePreference, loadThemeConfig]);

  // Broadcast the theme identity to every panel whenever it changes, so a
  // user-picked accent/radius propagates live over the runtime bridge.
  useEffect(() => {
    void panel.updateThemeConfig(themeConfig).catch((error) => {
      console.error("Failed to broadcast theme identity", error);
    });
  }, [themeConfig]);

  // Eagerly load active workspace name on mount (independent of chooser dialog)
  useEffect(() => {
    workspace
      .getActive()
      .then((name) => {
        setActiveWorkspaceName(name);
      })
      .catch((err) => console.error("[App] Failed to get active workspace:", err));
  }, [setActiveWorkspaceName]);

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Listen for workspace switcher menu event via shell event
  const handleOpenWorkspaceSwitcher = useCallback(() => {
    setWorkspaceChooserOpen(true);
  }, [setWorkspaceChooserOpen]);
  useShellEvent("open-workspace-switcher", handleOpenWorkspaceSwitcher);

  // Listen for navigate-about menu event via shell event
  const handleNavigateAbout = useCallback(async (payload: { page: string }) => {
    try {
      const result = await panel.createAboutPanel(payload.page);
      window.dispatchEvent(
        new CustomEvent("shell-panel-created", { detail: { panelId: result.id } })
      );
    } catch (error) {
      console.error(`[App] Failed to create shell panel for ${payload.page}:`, error);
    }
  }, []);
  useShellEvent("navigate-about", handleNavigateAbout);

  return (
    <Theme appearance={effectiveTheme} {...(themeConfig as AppTheme)} className="app-shell-theme">
      <AppCommandPalette />
      <ChunkErrorBoundary
        onRetry={() => {
          // Reassign to create a fresh lazy() with a new import() promise
          LazyMainMode = lazy(() => import("./MainMode"));
          setLazyRetryKey((k) => k + 1);
        }}
      >
        <Suspense key={lazyRetryKey} fallback={<LoadingSpinner />}>
          <LazyMainMode />
        </Suspense>
      </ChunkErrorBoundary>
    </Theme>
  );
}
