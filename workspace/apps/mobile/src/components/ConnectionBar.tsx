/**
 * ConnectionBar -- Status bar showing the WebRTC pipe connection state.
 *
 * Displays a thin colored bar at the top of the screen:
 * - Connected: green, auto-hides after 3 seconds
 * - Connecting: yellow, stays visible (initial connection)
 * - Reconnecting: yellow, stays visible (after a previous connection)
 * - No network: red, stays visible (device has no network link at all)
 * - Disconnected: red, stays visible (server unreachable)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Pressable, Alert } from "react-native";
import { useAtomValue } from "jotai";
import { connectionStatusAtom, networkReachableAtom } from "../state/connectionAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import type { ConnectionStatus } from "../services/mobileTransport";

interface ConnectionBarProps {
  /**
   * Invoked when the user chooses "Re-pair" from the disconnected bar.
   * Screens that can return to the native pairing bootstrap pass this; when
   * omitted, only an immediate reconnect is offered.
   */
  onRepair?: () => void;
}

interface StatusConfig {
  label: string;
  colorKey: "statusConnected" | "statusConnecting" | "statusDisconnected";
}

const STATUS_CONFIG: Record<ConnectionStatus, StatusConfig> = {
  connected: { label: "Connected", colorKey: "statusConnected" },
  connecting: { label: "Connecting...", colorKey: "statusConnecting" },
  disconnected: { label: "Disconnected", colorKey: "statusDisconnected" },
};

/**
 * Derive the display config from connection status + network reachability.
 * - Connected: a live pipe IS reachable by definition — never overridden by a
 *   NetInfo "no internet" signal. This is what makes a LAN-only home server
 *   (Wi-Fi without internet, ICE over the local link) show "Connected".
 * - No network: "No network" only when there's genuinely no link AND the pipe
 *   isn't up.
 * - Connecting after a disconnect: "Reconnecting..." if transport was previously connected
 * - Otherwise: standard status label
 */
function getDisplayConfig(
  status: ConnectionStatus,
  networkReachable: boolean,
  wasConnected: boolean
): StatusConfig {
  if (status === "connected") {
    return STATUS_CONFIG.connected;
  }
  if (!networkReachable) {
    return { label: "No network", colorKey: "statusDisconnected" };
  }
  if (status === "connecting" && wasConnected) {
    return { label: "Reconnecting...", colorKey: "statusConnecting" };
  }
  return STATUS_CONFIG[status];
}

/** Natural height of the bar: paddingVertical(4)*2 + dot(6) + fontSize(~12) ≈ 24 */
const BAR_HEIGHT = 24;

export function ConnectionBar({ onRepair }: ConnectionBarProps = {}) {
  const status = useAtomValue(connectionStatusAtom);
  const networkReachable = useAtomValue(networkReachableAtom);
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // Track whether we've been connected before to distinguish
  // "Connecting..." (initial) from "Reconnecting..." (after disconnect)
  const wasConnectedRef = useRef(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const animatedHeight = useRef(new Animated.Value(BAR_HEIGHT)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status === "connected") {
      wasConnectedRef.current = true;
      setReconnectAttempt(0);
    }
  }, [status]);

  useEffect(() => {
    if (!shellClient) return;
    return shellClient.transport.onReconnectProgress((progress) => {
      setReconnectAttempt(progress.attempt);
    });
  }, [shellClient]);

  useEffect(() => {
    // Clear any pending hide timer
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    // Always show on status change
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: false,
      }),
      Animated.timing(animatedHeight, {
        toValue: BAR_HEIGHT,
        duration: 200,
        useNativeDriver: false,
      }),
    ]).start();

    // Auto-hide when connected (after 3 seconds). A live pipe is reachable by
    // definition, so don't gate this on NetInfo's "internet reachable" signal.
    if (status === "connected") {
      hideTimer.current = setTimeout(() => {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 500,
            useNativeDriver: false,
          }),
          Animated.timing(animatedHeight, {
            toValue: 0,
            duration: 500,
            useNativeDriver: false,
          }),
        ]).start();
      }, 3000);
    }

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
    };
  }, [status, networkReachable, opacity, animatedHeight]);

  // The bar is actionable whenever the connection is in a problem state
  // (disconnected, or offline) so the user is never stuck without a way to
  // retry or re-pair. A live pipe is never a problem, even if NetInfo reports
  // "no internet" (LAN-only), so a connected status is excluded.
  const isProblem = status !== "connected";

  const handlePress = useCallback(() => {
    const reconnect = () => shellClient?.transport.reconnect();
    const buttons: Parameters<typeof Alert.alert>[2] = [{ text: "Reconnect", onPress: reconnect }];
    if (onRepair) {
      buttons.push({ text: "Re-pair device", onPress: onRepair });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(
      networkReachable ? "Connection lost" : "No network",
      networkReachable
        ? "Vibestudio isn't connected to your server."
        : "Your device appears to be offline. Reconnect once your network is back.",
      buttons,
      { cancelable: true }
    );
  }, [networkReachable, onRepair, shellClient]);

  const config = getDisplayConfig(status, networkReachable, wasConnectedRef.current);
  const backgroundColor = colors[config.colorKey];
  const reconnectLabel =
    wasConnectedRef.current && reconnectAttempt > 0
      ? `Reconnecting (attempt ${reconnectAttempt})…`
      : config.label;
  const label = isProblem ? `${reconnectLabel} — tap for options` : config.label;
  const accessibilityHint = onRepair
    ? "Opens actions to reconnect or re-pair the device."
    : "Opens actions to reconnect.";

  const content = (
    <Animated.View
      style={[
        styles.container,
        { backgroundColor, opacity, height: animatedHeight, overflow: "hidden" },
      ]}
    >
      <View style={styles.dot} />
      <Text style={styles.text}>{label}</Text>
    </Animated.View>
  );

  if (!isProblem) {
    return content;
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={config.label}
      accessibilityHint={accessibilityHint}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.8)",
    marginRight: 6,
  },
  text: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
});
