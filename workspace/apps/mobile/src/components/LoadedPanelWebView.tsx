import React, { memo, useCallback } from "react";
import { StyleSheet, View } from "react-native";
import type { WebViewNavigation } from "react-native-webview/lib/WebViewTypes";
import type { ThemeColors } from "../state/themeAtoms";
import type { WebViewEntry } from "./webViewStack";
import { PanelWebView, type PanelNavigationEvent, type PanelWebViewHandle } from "./PanelWebView";
import { WebViewErrorBoundary } from "./WebViewErrorBoundary";

export interface LoadedPanelWebViewProps {
  entry: WebViewEntry;
  visible: boolean;
  colors: ThemeColors;
  managedBasePath: string;
  diagnosticsEnabled: boolean;
  onHandleChange: (panelId: string, handle: PanelWebViewHandle | null) => void;
  onPanelNavigate: (event: PanelNavigationEvent) => void;
  onNavigationStateChange: (panelId: string, managed: boolean, navState: WebViewNavigation) => void;
  onTitleChange: (panelId: string, title: string) => void;
  onBridgeCall: (panelId: string, method: string, args: unknown[]) => Promise<unknown>;
  onUnmount: (panelId: string) => void;
}

/**
 * Render boundary for one expensive native WebView.
 *
 * MainScreen owns a large amount of unrelated shell state (notifications,
 * approvals, address suggestions, drawer state). Keeping the per-panel
 * closures here means those updates no longer invalidate every loaded WebView.
 */
function LoadedPanelWebViewImpl({
  entry,
  visible,
  colors,
  managedBasePath,
  diagnosticsEnabled,
  onHandleChange,
  onPanelNavigate,
  onNavigationStateChange,
  onTitleChange,
  onBridgeCall,
  onUnmount,
}: LoadedPanelWebViewProps) {
  const handleRef = useCallback(
    (handle: PanelWebViewHandle | null) => onHandleChange(entry.panelId, handle),
    [entry.panelId, onHandleChange]
  );
  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) =>
      onNavigationStateChange(entry.panelId, entry.managed, navState),
    [entry.managed, entry.panelId, onNavigationStateChange]
  );

  return (
    <View
      style={styles.webViewSlot}
      pointerEvents={visible ? "auto" : "none"}
      testID={`loaded-panel-${entry.panelId}`}
    >
      <WebViewErrorBoundary
        panelId={entry.panelId}
        colors={{
          background: colors.background,
          text: colors.text,
          textSecondary: colors.textSecondary,
          accent: colors.primary,
          accentText: colors.text,
        }}
      >
        <PanelWebView
          ref={handleRef}
          panelId={entry.panelId}
          url={entry.url}
          visible={visible}
          managed={entry.managed}
          panelInit={entry.panelInit}
          managedBasePath={managedBasePath}
          onPanelNavigate={onPanelNavigate}
          onNavigationStateChange={handleNavigationStateChange}
          onTitleChange={onTitleChange}
          onBridgeCall={onBridgeCall}
          onUnmount={onUnmount}
          diagnosticsEnabled={diagnosticsEnabled}
          colors={{
            background: colors.background,
            text: colors.text,
            textSecondary: colors.textSecondary,
            primary: colors.primary,
          }}
        />
      </WebViewErrorBoundary>
    </View>
  );
}

export const LoadedPanelWebView = memo(LoadedPanelWebViewImpl);

const styles = StyleSheet.create({
  webViewSlot: {
    ...StyleSheet.absoluteFillObject,
  },
});
