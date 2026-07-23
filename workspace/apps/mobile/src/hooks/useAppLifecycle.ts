/**
 * useAppLifecycle -- Coordinates all app lifecycle events for Vibestudio mobile.
 *
 * Handles:
 * - AppState transitions (foreground/background): reconnect transport on resume,
 *   pause periodic sync + trim the asset cache when backgrounded.
 * - NetInfo changes: reconnect when the network link returns, reflect a genuine
 *   loss of link (not merely "no internet") in the connection atoms.
 * - Memory-warning: trim the panel-asset LRU.
 * - Cleanup on unmount: dispose shell client + disconnect transport.
 */

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useSetAtom } from "jotai";
import type { ShellClient } from "../services/shellClient";
import { connectionStatusAtom, networkReachableAtom } from "../state/connectionAtoms";

/**
 * Coordinate app lifecycle events: AppState, NetInfo, and cleanup.
 *
 * Call this once in your top-level screen component (MainScreen).
 * Requires a ShellClient instance (or null if not yet connected).
 */
export function useAppLifecycle(shellClient: ShellClient | null): void {
  const setConnectionStatus = useSetAtom(connectionStatusAtom);
  const setNetworkReachable = useSetAtom(networkReachableAtom);

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

      // Transition to foreground (active).
      if (nextAppState === "active" && prevState !== "active") {
        // Reconnect if the pipe dropped while suspended (the OS freezes the
        // socket in the background; the transport keepalive marks it down).
        if (transport.status !== "connected") {
          transport.reconnect();
        }
        // Resume periodic sync
        void shellClient.panels.refresh().catch(() => {});
      }

      // Transition to background or inactive.
      //
      // We deliberately do NOT run a timed disconnect here: a JS setTimeout is
      // suspended in the background on iOS (so it never fires), and on resume it
      // raced the "active" handler and could tear down a perfectly healthy pipe
      // just as the user returned. Instead we stop polling and free reclaimable
      // memory, and let the OS suspend the socket; the transport's own idle /
      // keepalive handling reports the drop and the "active" branch reconnects.
      if (nextAppState !== "active" && prevState === "active") {
        shellClient.trimMemory();
      }
    };

    const appStateSub = AppState.addEventListener("change", handleAppStateChange);
    // iOS raises `memoryWarning` under pressure; drop the 256 MiB asset LRU.
    const memoryWarningSub = AppState.addEventListener("memoryWarning", () => {
      shellClient.trimMemory();
    });

    // === NetInfo listener ===

    const handleNetInfoChange = (state: NetInfoState) => {
      const wasReachable = isNetworkReachableRef.current;
      // Reachability = a network LINK is present, NOT "the internet is reachable".
      // A home server on Wi-Fi-without-internet (LAN ICE candidates) is exactly
      // reachable over the WebRTC pipe, so `isInternetReachable === false` must
      // NOT be treated as offline — that would paint a red "No network" over a
      // live LAN-only connection. Only a genuine absence of link (airplane mode,
      // no Wi-Fi/cell) counts as unreachable.
      const isReachable = state.isConnected === true;
      isNetworkReachableRef.current = isReachable;
      setNetworkReachable(isReachable);

      if (isReachable && !wasReachable) {
        // Link came back -- reconnect if we're in the foreground
        // and the transport is not already connected
        if (appStateRef.current === "active" && transport.status !== "connected") {
          transport.reconnect();
        }
      }

      if (!isReachable && wasReachable) {
        // Link genuinely lost -- reflect offline state
        setConnectionStatus("disconnected");
      }
    };

    const netInfoUnsub = NetInfo.addEventListener(handleNetInfoChange);

    // === Cleanup on unmount ===

    return () => {
      appStateSub.remove();
      memoryWarningSub.remove();
      netInfoUnsub();

      // Full teardown
      shellClient.dispose();
    };
  }, [shellClient, setConnectionStatus, setNetworkReachable]);
}
