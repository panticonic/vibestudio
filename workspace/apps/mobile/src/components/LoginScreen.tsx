import React from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Button } from "./ui/primitives";
import { radius, spacing, type } from "../design/tokens";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useAtomValue, useSetAtom } from "jotai";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { resetToNativeBootstrap } from "../services/auth";
import { readClipboardText } from "../services/nativeCapabilities";
import { loadShellCredential, clearShellCredential } from "../services/mobileCredentials";
import { parseConnectLink } from "@vibestudio/shared/connect";
import {
  MobileHostTargetApprovalRequiredError,
  ShellClient,
  type Credentials,
} from "../services/shellClient";
import {
  serverUrlAtom,
  isAuthenticatedAtom,
  authLoadingAtom,
  authErrorAtom,
  pairingIdentityAtom,
} from "../state/authAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { panelForestAtom, shellClientAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { VibestudioLogo } from "./VibestudioLogo";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[VibestudioMobileSmoke] phase=${phase}${suffix}`);
}

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, "Login">;

interface LoginScreenProps {
  navigation: LoginScreenNavigationProp;
}

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [retryNonce, setRetryNonce] = React.useState(0);
  const colors = useAtomValue(themeColorsAtom);

  const setServerUrlAtom = useSetAtom(serverUrlAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setAuthLoading = useSetAtom(authLoadingAtom);
  const setAuthError = useSetAtom(authErrorAtom);
  const setConnectionStatus = useSetAtom(connectionStatusAtom);
  const setPairingIdentity = useSetAtom(pairingIdentityAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const setPanelForest = useSetAtom(panelForestAtom);
  const authLoading = useAtomValue(authLoadingAtom);
  const authError = useAtomValue(authErrorAtom);
  const [connectionPhase, setConnectionPhase] = React.useState("Reading saved pairing…");
  const [connectionAttempt, setConnectionAttempt] = React.useState(0);
  const [needsHostApproval, setNeedsHostApproval] = React.useState(false);
  const cancelConnectionRef = React.useRef<(() => void) | null>(null);

  const resetToBootstrap = React.useCallback(
    async (clearPairing: boolean) => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        if (clearPairing) await clearShellCredential();
        await resetToNativeBootstrap();
      } catch (error) {
        setAuthLoading(false);
        setAuthError(error instanceof Error ? error.message : "Could not return to pairing.");
      }
    },
    [setAuthError, setAuthLoading]
  );

  const handleResetToBootstrap = React.useCallback(() => {
    Alert.alert(
      "Replace this pairing?",
      "Retry first if the server may only be temporarily unavailable. Re-pairing removes this device's saved connection.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Re-pair", style: "destructive", onPress: () => void resetToBootstrap(true) },
      ]
    );
  }, [resetToBootstrap]);

  const handlePastePairingLink = React.useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const rawUrl = (await readClipboardText()).trim();
      if (!rawUrl) {
        throw new Error("Clipboard is empty. Copy a Vibestudio pairing link first.");
      }
      // Validate the pasted link (shape + protocol version) BEFORE touching the
      // stored credential. Clearing first meant clipboard garbage — or an https
      // pair link that Android hands straight to the app — wiped the only saved
      // pairing and stranded the device. Only a well-formed current link may
      // proceed; anything else surfaces a clear error and leaves the credential
      // intact so the device can still reconnect.
      const parsed = parseConnectLink(rawUrl);
      if (parsed.kind === "error") {
        throw new Error(`That doesn't look like a valid Vibestudio pairing link. ${parsed.reason}`);
      }
      await Linking.openURL(rawUrl);
      // Opening a URL is not proof that iOS delivered it back to this app. Keep
      // the working credential until a successful pairing overwrites it.
    } catch (error) {
      setAuthLoading(false);
      setAuthError(error instanceof Error ? error.message : "Could not open pairing link.");
    }
  }, [setAuthError, setAuthLoading]);

  React.useEffect(() => {
    let cancelled = false;
    let pendingClient: ShellClient | null = null;

    const finishConnectedClient = (client: ShellClient, credentials: Credentials) => {
      smokePhase("workspace-connected");
      client.startPeriodicSync();

      setShellClient(client);
      setServerUrlAtom(client.serverUrl);
      setAuthenticated(true);
      setAuthLoading(false);
      setAuthError(null);

      navigation.replace("Main");
    };

    const connect = async () => {
      setAuthLoading(true);
      setAuthError(null);
      setNeedsHostApproval(false);
      setConnectionAttempt(0);
      setConnectionPhase("Reading saved pairing…");
      try {
        smokePhase("workspace-login-connect-start");
        // WebRTC model: the device identity is the stored shell credential
        // (deviceId + the signaling-room pairing). There is no native "workspace
        // credential" to read — the bootstrap pairs straight to a room — so the
        // workspace id is resolved from the server (getInfo) once the pipe is up.
        const stored = await loadShellCredential();
        smokePhase("workspace-login-credentials", { hasShellCredential: Boolean(stored) });
        if (!stored) {
          throw new Error(
            "No Vibestudio pairing is stored on this device. Scan a pairing QR code from a trusted desktop or terminal."
          );
        }
        const credentials: Credentials = {
          deviceId: stored.deviceId,
        };
        setPairingIdentity({
          server:
            stored.workspacePairing.srv || stored.controlPairing.srv || "Paired workspace server",
          deviceId: stored.deviceId,
        });
        setConnectionPhase("Contacting your workspace server…");

        const client = new ShellClient({
          credentials,
          onStatusChange: (status) => {
            setConnectionStatus(status);
            if (status === "connected") {
              setConnectionAttempt(0);
              setConnectionPhase("Preparing the mobile workspace…");
            }
          },
          onTreeUpdated: (snapshot) => {
            setPanelForest(snapshot);
          },
        });
        pendingClient = client;
        const offProgress = client.transport.onReconnectProgress?.((progress) => {
          if (cancelled) return;
          setConnectionAttempt(progress.attempt);
          setConnectionPhase(
            progress.phase === "scheduled"
              ? "Waiting to retry the server…"
              : progress.layer === "signaling"
                ? "Contacting the pairing service…"
                : "Connecting securely to your workspace…"
          );
        });
        cancelConnectionRef.current = () => {
          cancelled = true;
          offProgress?.();
          client.dispose();
          setAuthLoading(false);
          setAuthError("Connection cancelled. Your saved pairing is unchanged.");
        };

        await client.init();
        if (cancelled) {
          client.dispose();
          return;
        }
        finishConnectedClient(client, credentials);
        offProgress?.();
        cancelConnectionRef.current = null;
        pendingClient = null;
      } catch (error) {
        pendingClient?.dispose();
        pendingClient = null;
        if (cancelled) return;
        setAuthLoading(false);
        const message =
          error instanceof Error ? error.message : "Could not open the selected workspace.";
        if (error instanceof MobileHostTargetApprovalRequiredError) {
          setNeedsHostApproval(true);
          setAuthError("The workspace's mobile app needs your approval before it can run.");
          return;
        }
        smokePhase("workspace-login-error", {
          message,
          name: error instanceof Error ? error.name : typeof error,
          stack:
            error instanceof Error && error.stack
              ? error.stack.split("\n").slice(0, 5).join(" || ")
              : undefined,
        });
        setAuthError(message);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      pendingClient?.dispose();
      cancelConnectionRef.current = null;
    };
  }, [
    navigation,
    retryNonce,
    setAuthError,
    setAuthLoading,
    setAuthenticated,
    setConnectionStatus,
    setPanelForest,
    setServerUrlAtom,
    setShellClient,
    setPairingIdentity,
  ]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <VibestudioLogo size={84} variant="tile" style={styles.brandMark} />
        <Text style={[styles.title, { color: colors.text }]}>Vibestudio</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Opening the selected workspace
        </Text>

        {authLoading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={[styles.message, { color: colors.textSecondary }]}>
              {connectionPhase}
              {connectionAttempt > 0 ? ` Attempt ${connectionAttempt}.` : ""}
            </Text>
            <Button
              label="Cancel"
              variant="outline"
              onPress={() => cancelConnectionRef.current?.()}
              style={styles.fullButton}
            />
          </View>
        ) : null}

        {authError ? (
          <View style={styles.errorBlock}>
            <View
              style={[
                styles.errorCallout,
                { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
              ]}
            >
              <Text
                style={[type.bodyStrong, { color: colors.danger }]}
                accessibilityRole="alert"
              >
                {authError}
              </Text>
              <Text style={[type.caption, styles.calloutHint, { color: colors.textSecondary }]}>
                {needsHostApproval
                  ? "Review the workspace app in the pairing screen. Your saved pairing will stay intact."
                  : "Retry keeps your saved pairing. Only re-pair if you want to replace this connection."}
              </Text>
            </View>
            <Button
              label={needsHostApproval ? "Review and approve" : "Retry"}
              variant="filled"
              onPress={() =>
                needsHostApproval
                  ? void resetToBootstrap(false)
                  : setRetryNonce((value) => value + 1)
              }
              style={styles.fullButton}
            />
            <Button
              label="Paste pairing link"
              variant="outline"
              onPress={() => void handlePastePairingLink()}
              style={styles.fullButton}
            />
            <Button
              label="Re-pair device…"
              variant="outline"
              onPress={handleResetToBootstrap}
              style={styles.fullButton}
            />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
  },
  brandMark: {
    marginBottom: spacing.lg,
  },
  title: {
    ...type.title,
    fontSize: 32,
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...type.body,
    fontSize: 16,
    marginBottom: spacing.xxl,
    textAlign: "center",
  },
  loadingBlock: {
    alignItems: "center",
    gap: spacing.md,
    width: "100%",
  },
  errorBlock: {
    alignItems: "center",
    gap: spacing.md,
    width: "100%",
  },
  message: {
    ...type.caption,
    textAlign: "center",
  },
  errorCallout: {
    width: "100%",
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  calloutHint: {
    marginTop: spacing.xs,
  },
  fullButton: {
    width: "100%",
  },
});
