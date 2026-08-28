// Shipped React Native host bootstrap.
//
// This file is intentionally not the workspace mobile app. It is the minimal
// native-host recovery surface used only when no approved workspace app bundle
// is active yet. The workspace app is fetched through VibestudioMobileHost,
// verified by rnHostAbi + integrity, activated from native-owned storage, and
// then the RN bridge reloads onto that bundle.

// Must precede any @vibestudio/rpc import: installs a TextDecoder polyfill that
// Hermes lacks (the Iroh control-frame codec needs it).
import "@vibestudio/mobile-iroh/polyfills";
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppRegistry,
  Linking,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { Camera, useCameraDevice, useCodeScanner } from "react-native-vision-camera";
import {
  connectPairingFromLink,
  parseConnectLink,
  isConnectLink,
  markConnectLinkConsumed,
  consumeConnectLinkReplay,
} from "@vibestudio/mobile-iroh/connectLink";
import {
  establishIrohConnection,
  reconnectMobileSession,
  retryAfterConnectionLoss,
  persistStoredMobileConnection,
  replaceMobileConnectionCredential,
  completeFreshMobilePairing,
  loadShellCredential,
  clearShellCredential,
  makeFreshShellTokenProvider,
  makeReturningShellTokenProvider,
  createMobileIrohIdentity,
  deleteMobileIrohIdentity,
  activateApprovedWorkspaceApp as activateApprovedWorkspaceAppShared,
} from "@vibestudio/mobile-iroh";
import { launchGateView } from "@vibestudio/shared/bootstrapLaunchGate";
import { HostLaunchClient } from "@vibestudio/service-schemas/clients/hostLaunchClient";
import { name as appName } from "./app.json";
import { createSuccessfulConnectCoalescer, routeIncomingConnectLink } from "./connectLinkRouter";
import { VibestudioLogo } from "./VibestudioLogo";

const nativeHost = NativeModules.VibestudioMobileHost;
const MOBILE_LAUNCH_RECOVERY_TIMEOUT_MS = 3 * 60_000;
const MOBILE_LAUNCH_RECONNECT_WAIT_MS = 30_000;

let lastSmokePhase = null;
let lastSmokePhaseAt = 0;

function smokePhase(phase) {
  const now = Date.now();
  if (phase === lastSmokePhase && now - lastSmokePhaseAt < 5000) return;
  lastSmokePhase = phase;
  lastSmokePhaseAt = now;
  console.log(`[VibestudioMobileSmoke] phase=${phase}`);
}

function parseConnectDeepLink(rawUrl) {
  if (!isConnectLink(rawUrl)) return null;
  const parsed = parseConnectLink(rawUrl);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  // Iroh pairing carries the server Endpoint ID, its ordered relay set, and a
  // one-time pairing code plus expiry. Project it rather than retyping fields —
  // omitting one field here fails validation only after the server has issued a
  // credential, which reads as pairing hanging.
  return connectPairingFromLink(parsed);
}

/** Pairing reach is transport data, not a display identity. */
function pairingLabel() {
  return "this Vibestudio server";
}

async function activateApprovedWorkspaceApp(connection, options = {}) {
  await activateApprovedWorkspaceAppShared(connection, { ...options, nativeHost, smokePhase });
  return true;
}

// ===========================================================================
// Iroh connection layer — replaces the HTTP `/rpc` transport and the native
// HTTP pairing. The host binds one durable Endpoint identity, opens a `shell`
// logical session, and round-trips RPC envelopes over QUIC streams.
// ===========================================================================

// The shell-credential store + the Iroh connect helpers
// (establishIrohConnection / reconnectViaIroh / persist+loadShellCredential /
// makeShellTokenProvider) now live in
// @vibestudio/mobile-iroh, shared with the post-reload workspace app. Only the
// fresh-pairing flow below (which emits the smoke phases) stays here.

/** Fresh pairing: redeem the code, capture + persist the issued device credential. */
async function pairViaIroh(pairing) {
  smokePhase("embedded-pairing-start");
  const identity = await createMobileIrohIdentity();
  const tokenProvider = makeFreshShellTokenProvider(pairing);
  let pairedCredential = null;
  let pairingContext = null;
  try {
    const connection = await establishIrohConnection(
      pairing,
      tokenProvider,
      identity.identityId,
      "client-loopback",
      {
        onPaired: (credential, context) => {
          pairedCredential = credential;
          pairingContext = context ?? null;
          tokenProvider.setCredential(credential);
        },
      }
    );
    const workspaceConnection = await completeFreshMobilePairing({
      controlConnection: connection,
      credential: pairedCredential,
      pairingContext,
      controlPairing: pairing,
      persistConnection: persistStoredMobileConnection,
      connectWorkspace: async (workspacePairing, credential, controlConnection) => {
        const workspaceTokenProvider = makeReturningShellTokenProvider(credential);
        return establishIrohConnection(
          workspacePairing,
          workspaceTokenProvider,
          identity.identityId,
          "client-loopback",
          {
            onPaired: async (nextCredential) => {
              workspaceTokenProvider.setCredential(nextCredential);
              const current = await loadShellCredential();
              if (!current || current.schemaVersion !== 5 || current.phase !== "routed") {
                throw new Error(
                  "Routed mobile connection disappeared during workspace authentication"
                );
              }
              await persistStoredMobileConnection(
                replaceMobileConnectionCredential(current, nextCredential)
              );
            },
          },
          controlConnection.endpointPool
        );
      },
    });
    smokePhase("embedded-pairing-complete");
    return workspaceConnection;
  } catch (error) {
    const stored = await loadShellCredential().catch(() => null);
    if (stored?.endpointIdentityId !== identity.identityId) {
      await deleteMobileIrohIdentity(identity.identityId).catch(() => undefined);
    }
    throw error;
  }
}

async function rpc(connection, method, args = []) {
  // All control-plane RPC now rides the Iroh session (target the server "main").
  return connection.rpc.call("main", method, args);
}

async function closeBootstrapConnectionAfterFailure(connection, error) {
  if (!connection) return error;
  try {
    await connection.close();
    return error;
  } catch (closeError) {
    const failure = error instanceof Error ? error.message : String(error);
    const cleanup = closeError instanceof Error ? closeError.message : String(closeError);
    return new Error(
      `Mobile bootstrap failed (${failure}) and connection cleanup failed (${cleanup})`
    );
  }
}

function ActionButton({ title, onPress, variant = "primary", disabled = false }) {
  const buttonStyle =
    variant === "danger"
      ? styles.dangerButton
      : variant === "secondary"
        ? styles.secondaryButton
        : styles.primaryButton;
  const textStyle = variant === "primary" ? styles.primaryButtonText : styles.secondaryButtonText;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        buttonStyle,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={textStyle}>{title}</Text>
    </Pressable>
  );
}

function StepIndicator({ activeStep }) {
  const steps = [
    { id: "pair", label: "Pair" },
    { id: "approve", label: "Approve" },
    { id: "load", label: "Load" },
  ];
  return (
    <View style={styles.steps}>
      {steps.map((step) => {
        const active = step.id === activeStep;
        return (
          <View key={step.id} style={[styles.step, active ? styles.stepActive : null]}>
            <View style={[styles.stepDot, active ? styles.stepDotActive : null]} />
            <Text style={[styles.stepText, active ? styles.stepTextActive : null]}>
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function formatLaunchSessionStatus(session) {
  if (!session) return "Preparing secure workspace access";
  if (session.status === "approval-required") return "Review workspace app access";
  if (session.status === "ready") return "Workspace app is ready";
  return session.reason ?? "Preparing secure workspace access";
}

function LaunchTimeline({ session }) {
  if (!session) return null;
  const timeline = [
    {
      id: "review",
      label: "Review trust",
      state:
        session.status === "approval-required"
          ? "active"
          : session.status === "preparing" || session.status === "ready"
            ? "complete"
            : "pending",
    },
    {
      id: "activate",
      label: "Activate app",
      state:
        session.status === "preparing"
          ? "active"
          : session.status === "ready"
            ? "complete"
            : "pending",
      detail: session.status === "preparing" ? session.reason : undefined,
    },
    {
      id: "connected",
      label: "Connected",
      state: session.status === "ready" ? "complete" : "pending",
    },
  ];
  return (
    <View style={styles.timeline}>
      {timeline.map((phase) => (
        <View key={phase.id} style={styles.timelineRow}>
          <View style={[styles.timelineDot, styles[`timelineDot_${phase.state}`]]} />
          <View style={styles.timelineText}>
            <Text style={[styles.timelineLabel, styles[`timelineLabel_${phase.state}`]]}>
              {phase.label}
            </Text>
            {phase.detail ? <Text style={styles.timelineDetail}>{phase.detail}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function VibestudioMobileHostBootstrap() {
  const [status, setStatus] = useState("Loading approved workspace app...");
  const [busy, setBusy] = useState(true);
  const [pendingConnect, setPendingConnect] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [launchGrant, setLaunchGrant] = useState(null);
  const [launchSession, setLaunchSession] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [openApprovalIds, setOpenApprovalIds] = useState(() => new Set());
  const launchGateGeneration = useRef(0);
  const scannerLastValueRef = useRef(null);
  const acceptedConnectLinksRef = useRef(new Set());
  const cameraDevice = useCameraDevice("back");

  const runLaunchGate = useCallback(async (grant) => {
    const generation = ++launchGateGeneration.current;
    const isCurrent = () => generation === launchGateGeneration.current;
    const launchClient = new HostLaunchClient((service, method, args) =>
      grant.rpc.call("main", `${service}.${method}`, args)
    );
    setBusy(true);
    setApprovals([]);
    setOpenApprovalIds(new Set());
    setLaunchGrant(grant);
    try {
      for (;;) {
        const launch = await launchClient.launch("react-native");
        if (!isCurrent()) return;
        setLaunchSession(launch);
        setStatus(formatLaunchSessionStatus(launch));
        if (launch.status === "ready") {
          setBusy(true);
          setApprovals([]);
          setStatus("Workspace app approved. Activating bundle...");
          await activateApprovedWorkspaceApp(grant, { source: launch.entity.source });
          if (!isCurrent()) return;
          setStatus("Workspace app activated. Reloading...");
          return;
        }
        if (launch.status === "approval-required") {
          smokePhase("embedded-host-target-approval-required");
          setApprovals(launch.approvals);
          // Approval may be resolved on the already-running desktop/server rather
          // than on this phone. Keep observing the canonical launch state so an
          // externally approved request advances without requiring another tap.
          // Leave the local buttons enabled while waiting; a local decision starts
          // a new launch-gate generation and naturally retires this poller.
          setBusy(false);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!isCurrent()) return;
          continue;
        }
        if (launch.status === "preparing") {
          setBusy(true);
          setApprovals([]);
          smokePhase("embedded-host-target-preparing");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        setApprovals([]);
        return;
      }
    } catch (error) {
      console.error(
        `[MobileLaunchGate] failed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`
      );
      throw error;
    }
  }, []);

  const resolveLaunchApprovals = useCallback(
    async (decision) => {
      if (!launchGrant) return;
      if (!approvals.length) return;
      setBusy(true);
      setStatus(decision === "once" ? "Approving workspace app..." : "Denying workspace app...");
      try {
        const launchClient = new HostLaunchClient((service, method, args) =>
          launchGrant.rpc.call("main", `${service}.${method}`, args)
        );
        await launchClient.resolveApprovals(approvals, decision);
        if (decision === "once") {
          // The existing launch-gate observer owns this connection and will
          // see the canonical state advance. Starting a second observer here
          // briefly lets the first one's cleanup expose Retry while the second
          // is still preparing; an automated tap can then open a second mobile
          // session and make both offerers supersede each other.
          setApprovals([]);
          setStatus("Workspace app approved. Preparing bundle...");
          return;
        } else {
          setLaunchSession(null);
          setApprovals([]);
          setStatus("Workspace app approval denied.");
          setBusy(false);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
        setBusy(false);
      }
    },
    [approvals, launchGrant]
  );

  const presentConnectLink = useCallback((rawUrl) => {
    try {
      const parsed = parseConnectDeepLink(rawUrl);
      if (!parsed) {
        setPendingConnect(null);
        setStatus(
          "That is not a Vibestudio pairing code. Keep the camera pointed at the QR shown by your trusted desktop or server."
        );
        setBusy(false);
        return false;
      }
      smokePhase("embedded-deep-link-received");
      setPendingConnect({ pairing: parsed, rawUrl });
      setStatus(`Pair this device with ${pairingLabel(parsed)}?`);
      setBusy(false);
      return true;
    } catch (error) {
      setPendingConnect(null);
      setStatus(
        `${
          error instanceof Error ? error.message : String(error)
        }\n\nScan a fresh Vibestudio pairing QR code to re-pair this device.`
      );
      setBusy(false);
      return false;
    }
  }, []);

  const connectFromInviteAttempt = useCallback(
    async (connect) => {
      setBusy(true);
      setStatus("Pairing over a secure Iroh pipe...");
      let connection = null;
      try {
        connection = await pairViaIroh(connect.pairing);
        smokePhase("embedded-workspace-selected");
        if (connect.rawUrl) {
          await markConnectLinkConsumed(connect.rawUrl);
        }
        setPendingConnect(null);
        await retryAfterConnectionLoss(() => runLaunchGate(connection), {
          timeoutMs: MOBILE_LAUNCH_RECOVERY_TIMEOUT_MS,
          reconnectWaitMs: MOBILE_LAUNCH_RECONNECT_WAIT_MS,
          waitUntilConnected: (timeoutMs) => connection.waitUntilConnected(timeoutMs),
          onRetry: (error) => {
            smokePhase("embedded-launch-reconnect");
            console.warn(
              `[MobileLaunchGate] connection interrupted; waiting to resume: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            setStatus("Secure connection interrupted. Reconnecting automatically...");
          },
        });
        return true;
      } catch (error) {
        const failure = await closeBootstrapConnectionAfterFailure(connection, error);
        setLaunchGrant(null);
        setLaunchSession(null);
        setApprovals([]);
        setStatus(failure instanceof Error ? failure.message : String(failure));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runLaunchGate]
  );
  const connectFromInvite = useMemo(
    () => createSuccessfulConnectCoalescer(connectFromInviteAttempt),
    [connectFromInviteAttempt]
  );

  const handleIncomingConnectLink = useCallback(
    async (rawUrl) =>
      routeIncomingConnectLink(rawUrl, {
        consumeReplay: consumeConnectLinkReplay,
        parse: parseConnectDeepLink,
        claim: (url) => {
          if (acceptedConnectLinksRef.current.has(url)) return false;
          acceptedConnectLinksRef.current.add(url);
          return true;
        },
        release: (url) => acceptedConnectLinksRef.current.delete(url),
        markConsumed: markConnectLinkConsumed,
        consumeUsbApproval: async (url) => await nativeHost?.consumeUsbProvisioningApproval?.(url),
        connect: connectFromInvite,
        present: presentConnectLink,
        onUsbApproved: () => smokePhase("embedded-usb-provisioning-approved"),
      }),
    [connectFromInvite, presentConnectLink]
  );

  const codeScanner = useCodeScanner({
    codeTypes: ["qr"],
    onCodeScanned: (codes) => {
      const rawUrl = codes.find((code) => typeof code.value === "string" && code.value)?.value;
      if (!rawUrl || scannerLastValueRef.current === rawUrl) return;
      scannerLastValueRef.current = rawUrl;
      if (presentConnectLink(rawUrl)) {
        setScannerOpen(false);
      } else {
        scannerLastValueRef.current = null;
      }
    },
  });

  const load = useCallback(async () => {
    setBusy(true);
    setApprovals([]);
    setLaunchSession(null);
    setStatus("Loading approved workspace app...");
    let connection = null;
    try {
      const initialUrl = await Linking.getInitialURL();
      if (isConnectLink(initialUrl)) {
        const outcome = await handleIncomingConnectLink(initialUrl);
        if (outcome !== "replay") return;
      }
      // A returning device reconnects with the same durable endpoint identity and
      // stored refresh secret — no HTTP, no native credential read.
      const stored = await loadShellCredential();
      if (!stored) {
        setStatus(
          "Open a Vibestudio pairing link or scan a QR code from a trusted desktop or terminal."
        );
        return;
      }
      setStatus(`Reconnecting to ${pairingLabel()}...`);
      connection = await reconnectMobileSession(stored);
      await runLaunchGate(connection);
    } catch (error) {
      const failure = await closeBootstrapConnectionAfterFailure(connection, error);
      setLaunchGrant(null);
      setLaunchSession(null);
      setApprovals([]);
      // A rejected refresh secret is terminal — drop it so the next launch asks
      // for a fresh QR instead of looping on a credential the server won't honor.
      if (error?.code === "SESSION_AUTH_FAILED") {
        try {
          await clearShellCredential();
          setStatus("Your saved pairing was rejected. Scan a fresh Vibestudio QR code to re-pair.");
        } catch (clearError) {
          setStatus(
            `Your saved pairing was rejected and could not be cleared securely: ${
              clearError instanceof Error ? clearError.message : String(clearError)
            }`
          );
        }
      } else {
        setStatus(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setBusy(false);
    }
  }, [handleIncomingConnectLink, runLaunchGate]);

  const confirmPendingConnect = useCallback(async () => {
    if (!pendingConnect) return;
    await connectFromInvite(pendingConnect);
  }, [connectFromInvite, pendingConnect]);

  const cancelPendingConnect = useCallback(() => {
    setPendingConnect(null);
    setStatus("Pairing cancelled.");
  }, []);

  const pasteConnectLink = useCallback(async () => {
    setBusy(true);
    try {
      const rawUrl = (await Clipboard.getString()).trim();
      if (!rawUrl) {
        setStatus("Clipboard is empty. Copy a Vibestudio pairing link first.");
        return;
      }
      presentConnectLink(rawUrl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [presentConnectLink]);

  const openScanner = useCallback(async () => {
    setBusy(true);
    try {
      let permission = await Camera.getCameraPermissionStatus();
      if (permission !== "granted") {
        permission = await Camera.requestCameraPermission();
      }
      if (permission !== "granted") {
        setStatus("Camera access is required to scan a Vibestudio pairing QR code.");
        return;
      }
      scannerLastValueRef.current = null;
      setScannerOpen(true);
      setStatus("Scanning a Vibestudio pairing QR code...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleApprovalDetails = useCallback((approvalId) => {
    setOpenApprovalIds((current) => {
      const next = new Set(current);
      if (next.has(approvalId)) next.delete(approvalId);
      else next.add(approvalId);
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      void handleIncomingConnectLink(event.url);
    });
    return () => subscription.remove();
  }, [handleIncomingConnectLink]);

  const activeStep = approvals.length > 0 ? "approve" : pendingConnect ? "pair" : "load";
  const launchGate = approvals.length > 0 ? launchGateView({ approvals }) : null;
  const launchGateDetailsKey = launchGate?.approvalIds[0] ?? "launch-gate";
  const launchGateDetailsOpen =
    launchGate?.sourcesExpandedByDefault || openApprovalIds.has(launchGateDetailsKey);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.panel}>
          <View style={styles.brandRow}>
            <VibestudioLogo size={44} variant="tile" />
            <View style={styles.brandText}>
              <Text style={styles.eyebrow}>Vibestudio</Text>
              <Text style={styles.title}>Mobile Host</Text>
            </View>
          </View>
          <View style={styles.statusPanel}>
            <StepIndicator activeStep={activeStep} />
            <Text style={styles.message}>{status}</Text>
            <LaunchTimeline session={launchSession} />
            {busy ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#a874ff" />
                <Text style={styles.loadingText}>Preparing secure workspace access</Text>
              </View>
            ) : null}
          </View>
          {busy ? null : launchGate ? (
            <View style={styles.actions}>
              <View style={styles.sectionHeader}>
                <Text style={styles.eyebrow}>Workspace trust</Text>
                <Text style={styles.sectionTitle}>{launchGate.title}</Text>
              </View>
              <View style={styles.approvalBox}>
                <Text style={styles.approval}>{launchGate.summary}</Text>
                {launchGate.domainLine ? (
                  <Text style={styles.unitMeta}>{launchGate.domainLine}</Text>
                ) : null}
                {launchGate.firstEncounterLine ? (
                  <Text style={styles.approvalEmphasis}>{launchGate.firstEncounterLine}</Text>
                ) : null}
                {launchGate.programsLine ? (
                  <Text style={styles.unitMeta}>{launchGate.programsLine}</Text>
                ) : null}
                {launchGate.nativeCodeWarning ? (
                  <Text style={styles.approvalEmphasis}>{launchGate.nativeCodeWarning}</Text>
                ) : null}
                <ActionButton
                  title={launchGate.acceptLabel}
                  onPress={() => resolveLaunchApprovals("once")}
                />
                <ActionButton
                  title={launchGate.declineLabel}
                  onPress={() => resolveLaunchApprovals("deny")}
                  variant="danger"
                />
                <ActionButton
                  title={launchGateDetailsOpen ? "Hide details" : launchGate.disclosureLabel}
                  onPress={() => toggleApprovalDetails(launchGateDetailsKey)}
                  variant="secondary"
                />
                {launchGateDetailsOpen
                  ? launchGate.sources.map((source) => (
                      <View key={source.origin.originKey} style={styles.unitCard}>
                        <View style={styles.unitHeader}>
                          <Text style={styles.unitName}>{source.label}</Text>
                          <Text style={styles.unitBadge}>{source.counts}</Text>
                        </View>
                        {source.domainLine ? (
                          <Text style={styles.unitMeta}>{source.domainLine}</Text>
                        ) : null}
                        {source.origin.selfName && !source.origin.isHostBuild ? (
                          <Text style={styles.unitMeta}>
                            &quot;{source.origin.selfName}&quot; — name given by this template
                          </Text>
                        ) : null}
                        {source.firstEncounterLine ? (
                          <Text style={styles.unitMeta}>{source.firstEncounterLine}</Text>
                        ) : null}
                        {source.units.map((unit) => (
                          <View
                            key={`${source.origin.originKey}:${unit.name}`}
                            style={styles.unitRow}
                          >
                            <Text style={styles.unitRowName}>{unit.name}</Text>
                            <Text style={styles.unitMeta}>{unit.notable || unit.purpose}</Text>
                          </View>
                        ))}
                      </View>
                    ))
                  : null}
                <Text style={styles.unitMeta}>{launchGate.declineConsequence}</Text>
              </View>
            </View>
          ) : pendingConnect ? (
            <View style={styles.actions}>
              <View style={styles.connectCard}>
                <Text style={styles.eyebrow}>Pairing request</Text>
                <Text style={styles.sectionTitle}>Connect this device?</Text>
                <Text style={styles.hostLabel}>{pairingLabel(pendingConnect)}</Text>
              </View>
              <ActionButton title="Pair" onPress={confirmPendingConnect} />
              <ActionButton title="Cancel" onPress={cancelPendingConnect} variant="secondary" />
            </View>
          ) : (
            <View style={styles.actions}>
              {scannerOpen ? (
                <View style={styles.scannerCard}>
                  {cameraDevice ? (
                    <Camera
                      style={styles.cameraPreview}
                      device={cameraDevice}
                      isActive={scannerOpen}
                      codeScanner={codeScanner}
                    />
                  ) : (
                    <Text style={styles.hint}>No camera is available on this device.</Text>
                  )}
                  <ActionButton
                    title="Cancel scan"
                    onPress={() => setScannerOpen(false)}
                    variant="secondary"
                  />
                </View>
              ) : (
                <>
                  <Text style={styles.hint}>
                    Open a Vibestudio pairing link or scan a QR code from a trusted desktop or
                    terminal.
                  </Text>
                  <ActionButton title="Scan QR" onPress={openScanner} />
                  <ActionButton title="Paste pairing link" onPress={pasteConnectLink} />
                  <ActionButton title="Retry" onPress={load} variant="secondary" />
                </>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#100b18",
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    gap: 16,
  },
  brandRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  brandText: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    color: "#aab6c8",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  actions: {
    gap: 12,
  },
  title: {
    color: "#f8fafc",
    fontSize: 26,
    fontWeight: "800",
  },
  statusPanel: {
    backgroundColor: "#1a1f2b",
    borderColor: "#49305f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  message: {
    color: "#e6eaf2",
    fontSize: 16,
    lineHeight: 23,
  },
  timeline: {
    borderColor: "#49305f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  timelineRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
  },
  timelineDot: {
    backgroundColor: "#63708a",
    borderRadius: 999,
    height: 9,
    marginTop: 5,
    width: 9,
  },
  timelineDot_complete: {
    backgroundColor: "#7dd3a7",
  },
  timelineDot_active: {
    backgroundColor: "#facc6b",
  },
  timelineDot_failed: {
    backgroundColor: "#f87171",
  },
  timelineDot_blocked: {
    backgroundColor: "#f87171",
  },
  timelineDot_skipped: {
    backgroundColor: "#4b5568",
  },
  timelineText: {
    flex: 1,
  },
  timelineLabel: {
    color: "#aab6c8",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  timelineLabel_complete: {
    color: "#bdf4d3",
  },
  timelineLabel_active: {
    color: "#fff3bd",
  },
  timelineLabel_failed: {
    color: "#fecaca",
  },
  timelineLabel_blocked: {
    color: "#fecaca",
  },
  timelineLabel_skipped: {
    color: "#7d8796",
  },
  timelineDetail: {
    color: "#8d9bb0",
    fontSize: 12,
    lineHeight: 17,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  loadingText: {
    color: "#aab6c8",
    flex: 1,
    fontSize: 13,
  },
  steps: {
    flexDirection: "row",
    gap: 8,
  },
  step: {
    alignItems: "center",
    borderColor: "#33415c",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  stepActive: {
    backgroundColor: "#243347",
    borderColor: "#a874ff",
  },
  stepDot: {
    backgroundColor: "#63708a",
    borderRadius: 999,
    height: 6,
    width: 6,
  },
  stepDotActive: {
    backgroundColor: "#a874ff",
  },
  stepText: {
    color: "#aab6c8",
    fontSize: 12,
    fontWeight: "700",
  },
  stepTextActive: {
    color: "#f5fbff",
  },
  sectionHeader: {
    gap: 3,
  },
  sectionTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
  },
  approval: {
    color: "#e6eaf2",
    fontSize: 14,
    lineHeight: 20,
  },
  approvalEmphasis: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  approvalBox: {
    backgroundColor: "#181d27",
    borderColor: "#343d51",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  unitCard: {
    backgroundColor: "#111722",
    borderColor: "#49305f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    padding: 10,
  },
  unitHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "space-between",
  },
  unitName: {
    color: "#f8fafc",
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
  },
  unitBadge: {
    backgroundColor: "#2a2416",
    borderColor: "#7c5e1e",
    borderRadius: 999,
    borderWidth: 1,
    color: "#fde68a",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  unitMeta: {
    color: "#aab6c8",
    fontSize: 13,
    lineHeight: 18,
  },
  unitRow: {
    borderTopColor: "#343d51",
    borderTopWidth: 1,
    gap: 3,
    paddingTop: 8,
  },
  unitRowName: {
    color: "#e8eef7",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  connectCard: {
    backgroundColor: "#1b202b",
    borderColor: "#3a455d",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  scannerCard: {
    backgroundColor: "#101722",
    borderColor: "#49305f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    overflow: "hidden",
    padding: 12,
  },
  cameraPreview: {
    aspectRatio: 1,
    borderRadius: 8,
    minHeight: 260,
    overflow: "hidden",
    width: "100%",
  },
  hostLabel: {
    color: "#e6eaf2",
    fontSize: 14,
    lineHeight: 20,
  },
  workspaceButton: {
    backgroundColor: "#18202b",
    borderColor: "#36465f",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  workspaceName: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 22,
  },
  workspaceMeta: {
    color: "#9eabc0",
    fontSize: 13,
    lineHeight: 18,
  },
  hint: {
    color: "#aab6c8",
    fontSize: 14,
    lineHeight: 20,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryButton: {
    backgroundColor: "#a874ff",
    borderColor: "#a874ff",
  },
  secondaryButton: {
    backgroundColor: "#202633",
    borderColor: "#3a455d",
  },
  dangerButton: {
    backgroundColor: "#321e25",
    borderColor: "#a24b5a",
  },
  primaryButtonText: {
    color: "#071522",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButtonText: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "800",
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
});

AppRegistry.registerComponent(appName, () => VibestudioMobileHostBootstrap);
