/**
 * WebViewErrorBoundary -- Error boundary scoped to individual PanelWebView instances.
 *
 * If a single panel's WebView throws during render, this catches it and shows
 * a "Panel failed to load" screen with a reload button. Other panels continue
 * working normally. Uses static colors since theme atoms may be unavailable.
 */

import React, { type ErrorInfo, type ReactNode } from "react";
import { View, StyleSheet } from "react-native";
import { EmptyState, Button } from "./ui/primitives";
import { RefreshCw } from "../design/icons";

interface WebViewErrorBoundaryProps {
  children: ReactNode;
  /** Panel ID for logging */
  panelId: string;
  /** Optional color overrides for theming the error screen */
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    accent?: string;
    accentText?: string;
  };
}

interface WebViewErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey: number;
}

export class WebViewErrorBoundary extends React.Component<
  WebViewErrorBoundaryProps,
  WebViewErrorBoundaryState
> {
  constructor(props: WebViewErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<WebViewErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[WebViewErrorBoundary] Panel ${this.props.panelId} crashed:`,
      error,
      errorInfo.componentStack
    );
  }

  private handleReload = () => {
    this.setState((prev) => ({ hasError: false, error: null, resetKey: (prev.resetKey ?? 0) + 1 }));
  };

  render() {
    if (this.state.hasError) {
      const colors = this.props.colors;
      return (
        <View
          style={[
            styles.container,
            colors?.background != null && { backgroundColor: colors.background },
          ]}
        >
          <EmptyState
            icon={RefreshCw}
            title="Panel failed to load"
            message={this.state.error?.message || "An unexpected error occurred."}
            action={
              <Button
                label="Reload"
                variant="filled"
                icon={RefreshCw}
                onPress={this.handleReload}
              />
            }
          />
        </View>
      );
    }

    return (
      <View key={this.state.resetKey} style={{ flex: 1 }}>
        {this.props.children}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0b0c",
  },
});
