/**
 * useAppLifecycle -- Coordinates all app lifecycle events for Vibez1 mobile.
 *
 * Handles:
 * - AppState transitions (foreground/background): reconnect transport + toggle
 *   periodic sync, with a delayed disconnect when backgrounded.
 * - NetInfo changes: reconnect when network comes back, update connection atoms
 *   when network is lost.
 * - Cleanup on unmount: dispose shell client + disconnect transport.
 */

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useSetAtom } from "jotai";
import type { ShellClient } from "../services/shellClient";
import { connectionStatusAtom, networkReachableAtom } from "../state/connectionAtoms";

/** How long to wait (ms) before disconnecting after the app is backgrounded */
const BACKGROUND_DISCONNECT_DELAY_MS = 30_000;

/**
 * Coordinate app lifecycle events: AppState, NetInfo, and cleanup.
 *
 * Call this once in your top-level screen component (MainScreen).
 * Requires a ShellClient instance (or null if not yet connected).
 */
export function useAppLifecycle(shellClient: ShellClient | null): void {
  const setConnectionStatus = useSetAtom(connectionStatusAtom);
  const setNetworkReachable = useSetAtom(networkReachableAtom);

  // Track the delayed disconnect timer so we can cancel it on resume
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether the app is currently in the foreground
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Track network reachability
  const isNetworkReachableRef = useRef<boolean>(true);

  useEffect(() => {
    if (!shellClient) return;

    const transport = shellClient.transport;

    // === AppState listener ===

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextAppState;

      // Transition to foreground (active)
      if (nextAppState === "active" && prevState !== "active") {
        // Cancel any pending background disconnect
        if (backgroundTimerRef.current !== null) {
          clearTimeout(backgroundTimerRef.current);
          backgroundTimerRef.current = null;
        }

        // Reconnect if the transport is not already connected
        if (transport.status !== "connected") {
          transport.reconnect();
        }
        // Resume periodic sync
        shellClient.startPeriodicSync();
      }

      // Transition to background or inactive
      if (nextAppState !== "active" && prevState === "active") {
        // Stop periodic sync immediately -- no need to poll in background
        shellClient.stopPeriodicSync();

        // Schedule a delayed disconnect to save resources.
        // If the user returns within the delay, we cancel this timer.
        backgroundTimerRef.current = setTimeout(() => {
          backgroundTimerRef.current = null;
          transport.disconnect();
        }, BACKGROUND_DISCONNECT_DELAY_MS);
      }
    };

    const appStateSub = AppState.addEventListener("change", handleAppStateChange);

    // === NetInfo listener ===

    const handleNetInfoChange = (state: NetInfoState) => {
      const wasReachable = isNetworkReachableRef.current;
      const isReachable = state.isConnected === true && state.isInternetReachable !== false;
      isNetworkReachableRef.current = isReachable;
      setNetworkReachable(isReachable);

      if (isReachable && !wasReachable) {
        // Network came back -- reconnect if we're in the foreground
        // and the transport is not already connected
        if (appStateRef.current === "active" && transport.status !== "connected") {
          transport.reconnect();
        }
      }

      if (!isReachable && wasReachable) {
        // Network lost -- update connection status atom to reflect offline state
        setConnectionStatus("disconnected");
      }
    };

    const netInfoUnsub = NetInfo.addEventListener(handleNetInfoChange);

    // === Cleanup on unmount ===

    return () => {
      appStateSub.remove();
      netInfoUnsub();

      // Cancel any pending background disconnect timer
      if (backgroundTimerRef.current !== null) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }

      // Full teardown
      shellClient.dispose();
    };
  }, [shellClient, setConnectionStatus, setNetworkReachable]);
}
