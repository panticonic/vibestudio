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
} from "../services/mobileCredentials";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { resetToNativeBootstrap } from "../services/auth";
import { listMobileWorkspaces, selectMobileWorkspace } from "../services/workspaceSelection";
import { panelForestAtom, shellClientAtom } from "../state/shellClientAtom";
import { isAuthenticatedAtom } from "../state/authAtoms";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { themeColorsAtom, themePreferenceAtom, type ThemePreference } from "../state/themeAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import { copyToClipboard } from "../services/nativeCapabilities";
import { spacing, radius, type, pressedOpacity, touchTarget } from "../design/tokens";
import { ArrowLeft, Copy, Sun, Moon, Smartphone, Unplug, type IconComponent } from "../design/icons";
import { Card, SectionHeader, Badge, Button, IconButton } from "./ui/primitives";
import { ConnectionBar } from "./ConnectionBar";
import { MobileAccountProfileSection } from "./MobileAccountProfileSection";

type SettingsScreenNavigationProp = StackNavigationProp<RootStackParamList, "Settings">;

interface SettingsScreenProps {
  navigation: SettingsScreenNavigationProp;
}

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string; icon: IconComponent }[] = [
  { value: "system", label: "System", icon: Smartphone },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function SettingsScreen({ navigation }: SettingsScreenProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const connectionStatus = useAtomValue(connectionStatusAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setPanelForest = useSetAtom(panelForestAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const colors = useAtomValue(themeColorsAtom);
  const themePreference = useAtomValue(themePreferenceAtom);
  const setThemePreference = useSetAtom(themePreferenceAtom);
  const pushToast = useSetAtom(pushToastAtom);
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

  const deviceId = shellClient?.credentials.deviceId ?? null;

  const handleCopyDeviceId = () => {
    if (!deviceId) return;
    copyToClipboard(deviceId);
    pushToast({ message: "Device ID copied", tone: "success" });
  };

  const statusLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
        ? "Connecting..."
        : "Disconnected";

  const statusTone =
    connectionStatus === "connected"
      ? "success"
      : connectionStatus === "connecting"
        ? "warning"
        : "danger";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar onRepair={handleDisconnect} />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <IconButton icon={ArrowLeft} label="Back" onPress={handleBack} />
          <Text style={[type.title, styles.title, { color: colors.text }]}>Settings</Text>
          <View style={styles.headerSpacer} />
        </View>

        <MobileAccountProfileSection client={shellClient} />

        <SectionHeader label="Connection" />
        <Card>
          <View style={styles.connectionRow}>
            <Text style={[type.body, { color: colors.textSecondary }]}>Status</Text>
            <Badge label={statusLabel} tone={statusTone} />
          </View>
          <View style={[styles.connectionRow, styles.deviceRow]}>
            <Text style={[type.body, styles.deviceLabel, { color: colors.textSecondary }]}>
              Device
            </Text>
            <Text
              style={[styles.deviceId, { color: colors.text }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {deviceId ?? "not connected"}
            </Text>
            {deviceId ? (
              <IconButton icon={Copy} label="Copy device ID" onPress={handleCopyDeviceId} />
            ) : null}
          </View>
        </Card>

        <SectionHeader label="Appearance" />
        <Card>
          <Text style={[type.caption, styles.appearanceHelp, { color: colors.textSecondary }]}>
            Choose how Vibestudio looks on this device.
          </Text>
          <View
            style={[styles.segmentGroup, { backgroundColor: colors.surfaceSunken }]}
            accessibilityRole="radiogroup"
          >
            {APPEARANCE_OPTIONS.map((option) => {
              const selected = themePreference === option.value;
              const Icon = option.icon;
              return (
                <Pressable
                  key={option.value}
                  testID={`appearance-option-${option.value}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${option.label} appearance`}
                  accessibilityState={{ selected }}
                  onPress={() => setThemePreference(option.value)}
                  style={({ pressed }) => [
                    styles.segment,
                    selected && { backgroundColor: colors.accentSoft },
                    pressed && !selected && { opacity: pressedOpacity },
                  ]}
                >
                  <Icon size={16} color={selected ? colors.primary : colors.textSecondary} />
                  <Text
                    style={[
                      type.bodyStrong,
                      styles.segmentLabel,
                      { color: selected ? colors.primary : colors.textSecondary },
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <SectionHeader
          label="Workspace"
          trailing={
            !workspacesLoading && workspaceError ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void loadWorkspaces()}
                style={styles.retryButton}
              >
                <Text style={[type.caption, styles.retryText, { color: colors.primary }]}>
                  Retry
                </Text>
              </Pressable>
            ) : undefined
          }
        />
        <Card>
          <Text style={[type.caption, styles.workspaceHelp, { color: colors.textSecondary }]}>
            Choose where this device opens. Switching reloads the approved mobile app for that
            workspace.
          </Text>

          {workspacesLoading ? (
            <View style={styles.workspaceLoading}>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                Loading workspaces…
              </Text>
            </View>
          ) : null}

          {workspaceError ? (
            <Text
              accessibilityRole="alert"
              style={[type.caption, styles.workspaceError, { color: colors.danger }]}
            >
              {workspaceError}
            </Text>
          ) : null}

          {!workspacesLoading && workspaces.length === 0 && !workspaceError ? (
            <Text style={[type.caption, { color: colors.textSecondary }]}>
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
                style={({ pressed }) => [
                  styles.workspaceRow,
                  {
                    borderColor: current ? colors.primary : colors.border,
                    backgroundColor: current ? colors.accentSoft : colors.surfaceSunken,
                  },
                  disabled && !current && !switching ? styles.disabledWorkspace : null,
                  pressed && !disabled ? { opacity: pressedOpacity } : null,
                ]}
              >
                <View style={styles.workspaceCopy}>
                  <Text style={[type.bodyStrong, { color: colors.text }]}>{workspace.name}</Text>
                  <Text style={[type.caption, styles.workspaceMeta, { color: colors.textSecondary }]}>
                    {current
                      ? "Current workspace"
                      : workspace.running
                        ? "Ready to open"
                        : "Starts when selected"}
                  </Text>
                </View>
                {switching ? (
                  <View style={styles.switchingState}>
                    <Text style={[type.caption, styles.switchingText, { color: colors.primary }]}>
                      Switching…
                    </Text>
                  </View>
                ) : current ? (
                  <View style={styles.trailingBadge}>
                    <Badge label="Current" tone="primary" />
                  </View>
                ) : (
                  <Text style={[type.bodyStrong, styles.openText, { color: colors.primary }]}>
                    Open
                  </Text>
                )}
              </Pressable>
            );
          })}
        </Card>

        <Button
          label="Disconnect"
          variant="danger"
          icon={Unplug}
          onPress={handleDisconnect}
          style={styles.disconnectButton}
        />
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
    padding: spacing.xl,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  headerSpacer: {
    width: touchTarget - 4,
  },
  title: {
    flex: 1,
    textAlign: "center",
  },
  connectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceRow: {
    marginTop: spacing.sm,
  },
  deviceLabel: {
    marginRight: spacing.md,
  },
  deviceId: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Courier",
    fontSize: 13,
    marginRight: spacing.xs,
  },
  appearanceHelp: {
    marginBottom: spacing.md,
  },
  segmentGroup: {
    flexDirection: "row",
    borderRadius: radius.md,
    padding: spacing.xxs,
  },
  segment: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    minHeight: touchTarget - 8,
    borderRadius: radius.sm,
  },
  segmentLabel: {
    fontSize: 14,
  },
  retryButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  retryText: {
    fontWeight: "600",
  },
  workspaceHelp: {
    marginBottom: spacing.md,
  },
  workspaceLoading: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.lg,
  },
  workspaceError: {
    marginVertical: spacing.sm,
  },
  workspaceRow: {
    minHeight: 64,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
  },
  disabledWorkspace: {
    opacity: 0.55,
  },
  workspaceCopy: {
    flex: 1,
  },
  workspaceMeta: {
    marginTop: 3,
  },
  switchingState: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: spacing.md,
  },
  switchingText: {
    fontWeight: "600",
  },
  trailingBadge: {
    marginLeft: spacing.md,
  },
  openText: {
    marginLeft: spacing.md,
  },
  disconnectButton: {
    marginTop: spacing.lg,
  },
});
