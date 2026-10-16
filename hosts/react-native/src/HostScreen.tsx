import React, { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { Camera, useCameraDevice, useCodeScanner } from "react-native-vision-camera";
import { launchGateView } from "@vibestudio/shared/bootstrapLaunchGate";
import { VibestudioLogo } from "../VibestudioLogo";
import type { HostRuntime, HostUiState } from "./host/hostRuntime";

function ActionButton({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  testID?: string;
}) {
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
      testID={testID}
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

function StepIndicator({ activeStep }: { activeStep: "pair" | "approve" | "load" }) {
  const steps = [
    { id: "pair", label: "Pair" },
    { id: "approve", label: "Approve" },
    { id: "load", label: "Load" },
  ] as const;
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

type TimelineState = "complete" | "active" | "pending";

function LaunchTimeline({ ui }: { ui: HostUiState }) {
  const status = ui.launchStatus;
  if (!status) return null;
  const timeline: Array<{ id: string; label: string; state: TimelineState; detail?: string }> = [
    {
      id: "review",
      label: "Review trust",
      state: status === "approval-required" ? "active" : "complete",
    },
    {
      id: "activate",
      label: "Prepare app",
      state: status === "preparing" ? "active" : status === "ready" ? "complete" : "pending",
      ...(status === "preparing" && ui.launchDetail ? { detail: ui.launchDetail } : {}),
    },
    { id: "start", label: "Start", state: status === "ready" ? "complete" : "pending" },
  ];
  return (
    <View style={styles.timeline}>
      {timeline.map((phase) => (
        <View key={phase.id} style={styles.timelineRow}>
          <View
            style={[
              styles.timelineDot,
              phase.state === "complete"
                ? styles.timelineDot_complete
                : phase.state === "active"
                  ? styles.timelineDot_active
                  : null,
            ]}
          />
          <View style={styles.timelineText}>
            <Text
              style={[
                styles.timelineLabel,
                phase.state === "complete"
                  ? styles.timelineLabel_complete
                  : phase.state === "active"
                    ? styles.timelineLabel_active
                    : null,
              ]}
            >
              {phase.label}
            </Text>
            {phase.detail ? <Text style={styles.timelineDetail}>{phase.detail}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The host's own screen: pairing, the launch review and messages. A running
 * client has its own screen; this one is what the person sees before a client
 * exists, when something needs their decision, and when a client ended.
 */
export function createHostScreen(runtime: HostRuntime) {
  return function HostScreen() {
    const ui = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.get);
    const [scannerOpen, setScannerOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const scannerLastValue = useRef<string | null>(null);
    const cameraDevice = useCameraDevice("back");

    const present = useCallback(
      async (rawUrl: string): Promise<boolean> => {
        const handled = await runtime.handleLink(rawUrl);
        if (!handled) {
          setNotice(
            "That is not a Vibestudio link. Keep the camera pointed at the QR shown by your trusted desktop or server."
          );
        } else {
          setNotice(null);
        }
        return handled;
      },
      []
    );

    const codeScanner = useCodeScanner({
      codeTypes: ["qr"],
      onCodeScanned: (codes) => {
        const rawUrl = codes.find((code) => typeof code.value === "string" && code.value)?.value;
        if (!rawUrl || scannerLastValue.current === rawUrl) return;
        scannerLastValue.current = rawUrl;
        void present(rawUrl).then((handled) => {
          if (handled) setScannerOpen(false);
          else scannerLastValue.current = null;
        });
      },
    });

    const openScanner = useCallback(async () => {
      try {
        let permission = await Camera.getCameraPermissionStatus();
        if (permission !== "granted") permission = await Camera.requestCameraPermission();
        if (permission !== "granted") {
          setNotice("Camera access is required to scan a Vibestudio pairing QR code.");
          return;
        }
        scannerLastValue.current = null;
        setScannerOpen(true);
        setNotice(null);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    }, []);

    const pasteLink = useCallback(async () => {
      const rawUrl = (await Clipboard.getString()).trim();
      if (!rawUrl) {
        setNotice("Clipboard is empty. Copy a Vibestudio pairing link first.");
        return;
      }
      await present(rawUrl);
    }, [present]);

    const gate = ui.approvals.length > 0 ? launchGateView({ approvals: ui.approvals }) : null;
    const gateDetailsOpen = Boolean(gate?.sourcesExpandedByDefault) || detailsOpen;
    const activeStep = gate ? "approve" : ui.pendingPairing || !ui.launchStatus ? "pair" : "load";

    return (
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.panel}>
            <View style={styles.brandRow}>
              <VibestudioLogo size={44} variant="symbol" style={undefined} />
              <View style={styles.brandText}>
                <Text style={styles.eyebrow}>Vibestudio</Text>
                <Text style={styles.title}>Your workspace</Text>
              </View>
            </View>
            <View style={styles.statusPanel}>
              <StepIndicator activeStep={activeStep} />
              <Text style={styles.message}>{notice ?? ui.message}</Text>
              <LaunchTimeline ui={ui} />
              {ui.busy ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color="#3d6ff0" />
                  <Text style={styles.loadingText}>Preparing secure workspace access</Text>
                </View>
              ) : null}
            </View>
            {ui.busy ? null : gate ? (
              <View style={styles.actions}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.eyebrow}>Workspace trust</Text>
                  <Text style={styles.sectionTitle}>{gate.title}</Text>
                </View>
                <View style={styles.approvalBox}>
                  <Text style={styles.approval}>{gate.summary}</Text>
                  {gate.domainLine ? <Text style={styles.unitMeta}>{gate.domainLine}</Text> : null}
                  {gate.firstEncounterLine ? (
                    <Text style={styles.approvalEmphasis}>{gate.firstEncounterLine}</Text>
                  ) : null}
                  {gate.programsLine ? (
                    <Text style={styles.unitMeta}>{gate.programsLine}</Text>
                  ) : null}
                  {gate.nativeCodeWarning ? (
                    <Text style={styles.approvalEmphasis}>{gate.nativeCodeWarning}</Text>
                  ) : null}
                  <ActionButton
                    title={gate.acceptLabel}
                    onPress={() => void runtime.resolveApprovals("once")}
                    testID="launch-gate-accept"
                  />
                  <ActionButton
                    title={gate.declineLabel}
                    onPress={() => void runtime.resolveApprovals("deny")}
                    variant="danger"
                  />
                  <ActionButton
                    title={gateDetailsOpen ? "Hide details" : gate.disclosureLabel}
                    onPress={() => setDetailsOpen((open) => !open)}
                    variant="secondary"
                  />
                  {gateDetailsOpen
                    ? gate.sources.map((source) => (
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
                            <View key={unit.identityKey} style={styles.unitRow}>
                              <Text style={styles.unitRowName}>{unit.name}</Text>
                              <Text style={styles.unitMeta}>{unit.notable || unit.purpose}</Text>
                            </View>
                          ))}
                        </View>
                      ))
                    : null}
                  <Text style={styles.unitMeta}>{gate.declineConsequence}</Text>
                </View>
              </View>
            ) : ui.pendingPairing ? (
              <View style={styles.actions}>
                <View style={styles.connectCard}>
                  <Text style={styles.eyebrow}>Pairing request</Text>
                  <Text style={styles.sectionTitle}>Connect this device?</Text>
                  <Text style={styles.hostLabel}>this Vibestudio server</Text>
                </View>
                <ActionButton title="Pair" onPress={() => void runtime.confirmPairing()} />
                <ActionButton
                  title="Cancel"
                  onPress={() => runtime.cancelPairing()}
                  variant="secondary"
                />
              </View>
            ) : ui.phase === "running" ? null : (
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
                    {ui.phase === "needs-pairing" ? (
                      <>
                        <ActionButton title="Scan QR" onPress={() => void openScanner()} />
                        <ActionButton title="Paste pairing link" onPress={() => void pasteLink()} />
                      </>
                    ) : null}
                    <ActionButton
                      title="Retry"
                      onPress={() => void runtime.retry()}
                      variant="secondary"
                    />
                  </>
                )}
              </View>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  };
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#111419",
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
    color: "#b1bbcb",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  actions: {
    gap: 12,
  },
  title: {
    color: "#eef1f6",
    fontSize: 26,
    fontWeight: "800",
  },
  statusPanel: {
    backgroundColor: "#171b22",
    borderColor: "#434d5f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  message: {
    color: "#eef1f6",
    fontSize: 16,
    lineHeight: 23,
  },
  timeline: {
    borderColor: "#434d5f",
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
    backgroundColor: "#6b778c",
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
    backgroundColor: "#434d5f",
  },
  timelineText: {
    flex: 1,
  },
  timelineLabel: {
    color: "#b1bbcb",
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
    color: "#78849a",
  },
  timelineDetail: {
    color: "#b1bbcb",
    fontSize: 12,
    lineHeight: 17,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  loadingText: {
    color: "#b1bbcb",
    flex: 1,
    fontSize: 13,
  },
  steps: {
    flexDirection: "row",
    gap: 8,
  },
  step: {
    alignItems: "center",
    borderColor: "#434d5f",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  stepActive: {
    backgroundColor: "#252b36",
    borderColor: "#3d6ff0",
  },
  stepDot: {
    backgroundColor: "#6b778c",
    borderRadius: 999,
    height: 6,
    width: 6,
  },
  stepDotActive: {
    backgroundColor: "#3d6ff0",
  },
  stepText: {
    color: "#b1bbcb",
    fontSize: 12,
    fontWeight: "700",
  },
  stepTextActive: {
    color: "#eef1f6",
  },
  sectionHeader: {
    gap: 3,
  },
  sectionTitle: {
    color: "#eef1f6",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
  },
  approval: {
    color: "#eef1f6",
    fontSize: 14,
    lineHeight: 20,
  },
  approvalEmphasis: {
    color: "#eef1f6",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  approvalBox: {
    backgroundColor: "#171b22",
    borderColor: "#434d5f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  unitCard: {
    backgroundColor: "#171b22",
    borderColor: "#434d5f",
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
    color: "#eef1f6",
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
    color: "#b1bbcb",
    fontSize: 13,
    lineHeight: 18,
  },
  unitRow: {
    borderTopColor: "#434d5f",
    borderTopWidth: 1,
    gap: 3,
    paddingTop: 8,
  },
  unitRowName: {
    color: "#eef1f6",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  connectCard: {
    backgroundColor: "#171b22",
    borderColor: "#434d5f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  scannerCard: {
    backgroundColor: "#111419",
    borderColor: "#434d5f",
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
    color: "#eef1f6",
    fontSize: 14,
    lineHeight: 20,
  },
  workspaceButton: {
    backgroundColor: "#171b22",
    borderColor: "#434d5f",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  workspaceName: {
    color: "#eef1f6",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 22,
  },
  workspaceMeta: {
    color: "#b1bbcb",
    fontSize: 13,
    lineHeight: 18,
  },
  hint: {
    color: "#b1bbcb",
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
    backgroundColor: "#3d6ff0",
    borderColor: "#3d6ff0",
  },
  secondaryButton: {
    backgroundColor: "#252b36",
    borderColor: "#434d5f",
  },
  dangerButton: {
    backgroundColor: "#321e25",
    borderColor: "#a24b5a",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButtonText: {
    color: "#eef1f6",
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