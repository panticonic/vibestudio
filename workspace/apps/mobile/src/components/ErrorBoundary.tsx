/**
 * ErrorBoundary -- Top-level error boundary for the Vibestudio mobile app.
 *
 * Catches unhandled React render errors and shows a recovery screen
 * instead of crashing the entire app. Uses static colors since Jotai
 * atoms may not be available in the error state.
 */

import React, { type ErrorInfo, type ReactNode } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { EmptyState, Button } from "./ui/primitives";
import { AlertTriangle, RefreshCw } from "../design/icons";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown in the error screen (e.g. "App" or "Panel") */
  label?: string;
  /** Optional color overrides for theming the error screen */
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    accent?: string;
    accentText?: string;
  };
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}] Uncaught error:`,
      error,
      errorInfo.componentStack
    );
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      const label = this.props.label ?? "App";
      const colors = this.props.colors;

      return (
        <View
          style={[
            styles.container,
            colors?.background != null && { backgroundColor: colors.background },
          ]}
        >
          <View style={styles.content}>
            <EmptyState
              icon={AlertTriangle}
              title="Something went wrong"
              message={`${label} encountered an unexpected error.`}
              action={
                <Button label="Retry" variant="filled" icon={RefreshCw} onPress={this.handleRetry} />
              }
            />
            {error?.message ? <Text style={styles.errorMessage}>{error.message}</Text> : null}

            {__DEV__ && error?.stack ? (
              <ScrollView style={styles.stackContainer}>
                <Text style={styles.stackText}>{error.stack}</Text>
              </ScrollView>
            ) : null}
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0b0c",
  },
  content: {
    flex: 1,
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: "100%",
    maxWidth: 400,
  },
  errorMessage: {
    fontSize: 13,
    color: "#cc6666",
    textAlign: "center",
    marginTop: 16,
    marginBottom: 24,
    lineHeight: 20,
  },
  stackContainer: {
    maxHeight: 200,
    width: "100%",
    backgroundColor: "#111122",
    borderRadius: 8,
    padding: 12,
  },
  stackText: {
    fontSize: 11,
    color: "#888",
    fontFamily: "monospace",
  },
});
