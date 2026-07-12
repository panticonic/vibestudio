import React from "react";
import { View, Text, StyleSheet, Pressable, SafeAreaView, ScrollView, Alert } from "react-native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useAtomValue, useSetAtom } from "jotai";
import {
  clearShellCredential,
  loadShellCredential,
  persistStoredShellCredential,
  type MobileHubWorkspace,
  type StoredShellCredential,
} from "@vibestudio/mobile-webrtc";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { resetToNativeBootstrap } from "../services/auth";
import { listMobileWorkspaces, selectMobileWorkspace } from "../services/workspaceSelection";
import { panelForestAtom, shellClientAtom } from "../state/shellClientAtom";
import { isAuthenticatedAtom } from "../state/authAtoms";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { themeColorsAtom } from "../state/themeAtoms";
import { ConnectionBar } from "./ConnectionBar";
import { MobileAccountProfileSection } from "./MobileAccountProfileSection";

type SettingsScreenNavigationProp = StackNavigationProp<RootStackParamList, "Settings">;

interface SettingsScreenProps {
  navigation: SettingsScreenNavigationProp;
}

export function SettingsScreen({ navigation }: SettingsScreenProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const connectionStatus = useAtomValue(connectionStatusAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setPanelForest = useSetAtom(panelForestAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const colors = useAtomValue(themeColorsAtom);
  const [workspaces, setWorkspaces] = React.useState<MobileHubWorkspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = React.useState(true);
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadWorkspaces = React.useCallback(async () => {
    setWorkspacesLoading(true);
    setWorkspaceError(null);
    try {
      const next = await listMobileWorkspaces();
      if (mountedRef.current) setWorkspaces(next);
    } catch (error) {
      if (mountedRef.current) {
        setWorkspaceError(
          error instanceof Error ? error.message : "Could not load your workspaces."
        );
      }
    } finally {
      if (mountedRef.current) setWorkspacesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const handleWorkspaceSelection = React.useCallback(
    async (workspace: MobileHubWorkspace) => {
      if (workspace.workspaceId === shellClient?.workspaceId || switchingWorkspace) return;
      setSwitchingWorkspace(workspace.name);
      setWorkspaceError(null);
      try {
        await selectMobileWorkspace(workspace.name);
        // Success schedules a native reload. Keep the pending state visible until
        // React Native tears this workspace tree down.
      } catch (error) {
        if (mountedRef.current) {
          setWorkspaceError(
            error instanceof Error ? error.message : "Could not switch workspaces."
          );
          setSwitchingWorkspace(null);
        }
      }
    },
    [shellClient?.workspaceId, switchingWorkspace]
  );

  const performDisconnect = async () => {
    let previousCredential: StoredShellCredential | null;
    try {
      previousCredential = await loadShellCredential();
      await clearShellCredential();
    } catch (error) {
      Alert.alert(
        "Could not disconnect securely",
        error instanceof Error ? error.message : "The device credential could not be cleared."
      );
      return;
    }

    try {
      const reset = await resetToNativeBootstrap();
      if (!reset.reloading) throw new Error("The native host did not start the pairing reload.");
    } catch (error) {
      try {
        if (previousCredential) await persistStoredShellCredential(previousCredential);
      } catch (rollbackError) {
        Alert.alert(
          "Disconnect needs attention",
          `The native reload failed and the prior credential could not be restored: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`
        );
        return;
      }
      Alert.alert(
        "Could not open pairing",
        error instanceof Error ? error.message : "The native host could not reload."
      );
      return;
    }

    // Keychain is clear and native reload is committed; now release the old
    // workspace resources. Failure paths above intentionally leave them live.
    shellClient?.dispose();
    setShellClient(null);
    setPanelForest({ revision: 0, forest: [] });
    setActivePanelId(null);
    setAuthenticated(false);
  };

  const handleDisconnect = () => {
    Alert.alert(
      "Disconnect this device?",
      "This clears the stored pairing and returns to the native pairing screen.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Disconnect", style: "destructive", onPress: () => void performDisconnect() },
      ],
      { cancelable: true }
    );
  };

  const handleBack = () => {
    navigation.goBack();
  };

  const statusLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
        ? "Connecting..."
        : "Disconnected";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar onRepair={handleDisconnect} />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Pressable onPress={handleBack} style={styles.backButton}>
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Settings</Text>
          <View style={styles.backButton} />
        </View>

        <MobileAccountProfileSection client={shellClient} />

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Connection</Text>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Status: {statusLabel}</Text>
          <Text style={[styles.label, { color: colors.textSecondary }]}>
            Device: {shellClient?.credentials.deviceId ?? "not connected"}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeadingRow}>
            <Text style={[styles.sectionTitle, styles.workspaceTitle, { color: colors.text }]}>
              Workspace
            </Text>
            {!workspacesLoading && workspaceError ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void loadWorkspaces()}
                style={styles.retryButton}
              >
                <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={[styles.workspaceHelp, { color: colors.textSecondary }]}>
            Choose where this device opens. Switching reloads the approved mobile app for that
            workspace.
          </Text>

          {workspacesLoading ? (
            <View style={styles.workspaceLoading}>
              <Text style={[styles.workspaceStatus, { color: colors.textSecondary }]}>
                Loading workspaces…
              </Text>
            </View>
          ) : null}

          {workspaceError ? (
            <Text
              accessibilityRole="alert"
              style={[styles.workspaceError, { color: colors.danger }]}
            >
              {workspaceError}
            </Text>
          ) : null}

          {!workspacesLoading && workspaces.length === 0 && !workspaceError ? (
            <Text style={[styles.workspaceStatus, { color: colors.textSecondary }]}>
              No workspaces are available for this account.
            </Text>
          ) : null}

          {workspaces.map((workspace) => {
            const current = workspace.workspaceId === shellClient?.workspaceId;
            const switching = switchingWorkspace === workspace.name;
            const disabled = current || switchingWorkspace !== null || workspacesLoading;
            return (
              <Pressable
                key={workspace.workspaceId}
                testID={`workspace-option-${workspace.workspaceId}`}
                accessibilityRole="button"
                accessibilityLabel={`${workspace.name}${current ? ", current workspace" : ""}`}
                accessibilityState={{ disabled, selected: current, busy: switching }}
                disabled={disabled}
                onPress={() => void handleWorkspaceSelection(workspace)}
                style={[
                  styles.workspaceRow,
                  { borderColor: current ? colors.primary : colors.border },
                  disabled && !current && !switching ? styles.disabledWorkspace : null,
                ]}
              >
                <View style={styles.workspaceCopy}>
                  <Text style={[styles.workspaceName, { color: colors.text }]}>
                    {workspace.name}
                  </Text>
                  <Text style={[styles.workspaceMeta, { color: colors.textSecondary }]}>
                    {current
                      ? "Current workspace"
                      : workspace.running
                        ? "Ready to open"
                        : "Starts when selected"}
                  </Text>
                </View>
                {switching ? (
                  <View style={styles.switchingState}>
                    <Text style={[styles.switchingText, { color: colors.primary }]}>
                      Switching…
                    </Text>
                  </View>
                ) : current ? (
                  <View style={[styles.currentBadge, { backgroundColor: colors.accentSoft }]}>
                    <Text style={[styles.currentBadgeText, { color: colors.primary }]}>
                      Current
                    </Text>
                  </View>
                ) : (
                  <Text style={[styles.openText, { color: colors.primary }]}>Open</Text>
                )}
              </Pressable>
            );
          })}
        </View>

        <Pressable
          style={[styles.disconnectButton, { backgroundColor: colors.danger }]}
          onPress={handleDisconnect}
        >
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: 24,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  backButton: {
    width: 60,
  },
  backText: {
    fontSize: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  workspaceTitle: {
    marginBottom: 0,
  },
  workspaceHelp: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 12,
  },
  retryButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  retryText: {
    fontSize: 14,
    fontWeight: "600",
  },
  workspaceLoading: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
  },
  workspaceStatus: {
    fontSize: 14,
  },
  workspaceError: {
    fontSize: 14,
    lineHeight: 20,
    marginVertical: 8,
  },
  workspaceRow: {
    minHeight: 64,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  disabledWorkspace: {
    opacity: 0.55,
  },
  workspaceCopy: {
    flex: 1,
  },
  workspaceName: {
    fontSize: 16,
    fontWeight: "600",
  },
  workspaceMeta: {
    fontSize: 13,
    marginTop: 3,
  },
  switchingState: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 12,
  },
  switchingText: {
    fontSize: 13,
    fontWeight: "600",
  },
  currentBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginLeft: 12,
  },
  currentBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  openText: {
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 12,
  },
  label: {
    fontSize: 14,
    marginBottom: 6,
  },
  disconnectButton: {
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 16,
  },
  disconnectText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
