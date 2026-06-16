// Shipped React Native host bootstrap.
//
// This file is intentionally not the workspace mobile app. It is the minimal
// native-host recovery surface used only when no approved workspace app bundle
// is active yet. The workspace app is fetched through NatStackMobileHost,
// verified by rnHostAbi + integrity, activated from native-owned storage, and
// then the RN bridge reloads onto that bundle.

import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppRegistry,
  Button,
  Linking,
  NativeModules,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseConnectLink } from "@natstack/shared/connect";
import { name as appName } from "./app.json";

const RN_HOST_ABI = "rn-host-1";
const CONSUMED_CONNECT_LINK_KEY = "natstack:connect:consumed-url";
const nativeHost = NativeModules.NatStackMobileHost;

function smokePhase(phase) {
  console.log(`[NatStackMobileSmoke] phase=${phase}`);
}

function platformName() {
  return Platform.OS === "ios" ? "ios" : "android";
}

function missingNativeHostError() {
  return new Error("NatStackMobileHost native module is unavailable");
}

function parseConnectDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return null;
  const parsed = parseConnectLink(rawUrl);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  return { serverUrl: parsed.url, code: parsed.code };
}

async function markConnectLinkConsumed(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return;
  await AsyncStorage.setItem(
    CONSUMED_CONNECT_LINK_KEY,
    JSON.stringify({ url: rawUrl, consumedAt: Date.now() })
  );
}

function approvalTitle(approval) {
  const units = Array.isArray(approval?.units) ? approval.units : [];
  const unit = units[0];
  return (
    unit?.displayName ||
    unit?.unitName ||
    approval?.title ||
    approval?.description ||
    approval?.approvalId ||
    "Workspace app"
  );
}

function unitTargetLabel(unit) {
  if (unit?.target === "react-native") return "Mobile app";
  if (unit?.target === "electron") return "Desktop app";
  if (unit?.target === "terminal") return "Terminal app";
  return unit?.unitKind === "extension" ? "Extension" : "App";
}

function unitSourceLabel(unit) {
  const repo = unit?.source?.repo;
  const ref = unit?.source?.ref;
  if (typeof repo !== "string" || typeof ref !== "string") return "Source unavailable";
  const ev = typeof unit?.ev === "string" && unit.ev ? ` (${unit.ev.slice(0, 12)})` : "";
  return `${repo}@${ref}${ev}`;
}

function unitCapabilitiesLabel(unit) {
  const capabilities = Array.isArray(unit?.capabilities)
    ? unit.capabilities.filter((capability) => typeof capability === "string")
    : [];
  return capabilities.length > 0 ? capabilities.join(", ") : "No declared capabilities";
}

async function activateApprovedWorkspaceApp(options = {}) {
  if (!nativeHost) throw missingNativeHostError();
  const credentials = await nativeHost.getCredentials();
  if (!credentials) {
    if (options.allowMissingCredentials) return false;
    throw new Error("Pair this device from the desktop app before loading the workspace app.");
  }
  smokePhase("embedded-bundle-activate-start");
  const prepared = await nativeHost.prepareAppBundle(
    RN_HOST_ABI,
    platformName(),
    options.source ?? null
  );
  await nativeHost.activatePreparedAppBundle(
    prepared.localPath,
    prepared.buildKey,
    prepared.integrity
  );
  smokePhase("embedded-bundle-activate-complete");
  return true;
}

async function rpc(serverUrl, token, method, args = []) {
  const response = await fetch(`${serverUrl}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, args }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error || `RPC ${method} failed with HTTP ${response.status}`);
  }
  return json.result;
}

async function pairParsedLink(parsed) {
  let pairingCompleted = false;
  smokePhase("embedded-pairing-start");
  try {
    const grant = await nativeHost.completePairing(parsed.serverUrl, parsed.code, null);
    pairingCompleted = true;
    smokePhase("embedded-pairing-complete");
    await markConnectLinkConsumed(parsed.rawUrl).catch(() => {});
    return grant;
  } catch (error) {
    if (pairingCompleted) {
      await nativeHost.clearCredentials?.().catch(() => {});
    }
    throw error;
  }
}

function NatStackMobileHostBootstrap() {
  const [status, setStatus] = useState("Loading approved workspace app...");
  const [busy, setBusy] = useState(true);
  const [pendingConnect, setPendingConnect] = useState(null);
  const [launchGrant, setLaunchGrant] = useState(null);
  const [approvals, setApprovals] = useState([]);

  const runLaunchGate = useCallback(async (grant) => {
    setBusy(true);
    setApprovals([]);
    setLaunchGrant(grant);
    setStatus("Checking workspace app approval...");
    const launch = await rpc(
      grant.serverUrl,
      grant.connectionGrant,
      "workspace.hostTargets.launch",
      ["react-native"]
    );
    if (launch?.status === "ready") {
      setStatus("Workspace app approved. Activating bundle...");
      await activateApprovedWorkspaceApp({ source: launch.source ?? null });
      setStatus("Workspace app activated. Reloading...");
      return;
    }
    if (launch?.status === "approval-required") {
      setApprovals(Array.isArray(launch.approvals) ? launch.approvals : []);
      setStatus(
        "Do you trust the code in this workspace?\n\nApproving will run this workspace app on your device."
      );
      return;
    }
    const details = Array.isArray(launch?.details) ? launch.details.join("\n") : "";
    setStatus(
      [launch?.reason || "No launchable mobile workspace app is available.", details]
        .filter(Boolean)
        .join("\n")
    );
  }, []);

  const resolveLaunchApprovals = useCallback(
    async (decision) => {
      if (!launchGrant) return;
      setBusy(true);
      setStatus(decision === "once" ? "Approving workspace app..." : "Denying workspace app...");
      try {
        for (const approval of approvals) {
          await rpc(
            launchGrant.serverUrl,
            launchGrant.connectionGrant,
            "shellApproval.resolveBootstrap",
            [approval.approvalId, decision]
          );
        }
        if (decision === "once") {
          await runLaunchGate(launchGrant);
        } else {
          setApprovals([]);
          setStatus("Workspace app approval denied.");
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [approvals, launchGrant, runLaunchGate]
  );

  const presentConnectLink = useCallback((rawUrl) => {
    try {
      const parsed = parseConnectDeepLink(rawUrl);
      if (!parsed) {
        setPendingConnect(null);
        setStatus("Open a NatStack connect link to pair this device.");
        setBusy(false);
        return;
      }
      smokePhase("embedded-deep-link-received");
      setPendingConnect({ ...parsed, rawUrl });
      setStatus(`Pair this device with ${parsed.serverUrl}?`);
      setBusy(false);
    } catch (error) {
      setPendingConnect(null);
      setStatus(
        `${
          error instanceof Error ? error.message : String(error)
        }\n\nScan a fresh NatStack pairing QR code to re-pair this device.`
      );
      setBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setApprovals([]);
    setStatus("Loading approved workspace app...");
    try {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl && initialUrl.startsWith("natstack://connect")) {
        presentConnectLink(initialUrl);
        return;
      }
      if (!nativeHost) throw missingNativeHostError();
      const credentials = await nativeHost.getCredentials();
      if (!credentials) {
        setStatus("Pair this device from the desktop app.");
        return;
      }
      const grant = await nativeHost.issueConnectionGrant();
      await runLaunchGate(grant);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [presentConnectLink, runLaunchGate]);

  const confirmPendingConnect = useCallback(async () => {
    if (!pendingConnect) return;
    setBusy(true);
    setStatus("Pairing device...");
    try {
      const grant = await pairParsedLink(pendingConnect);
      setPendingConnect(null);
      await runLaunchGate(grant);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [pendingConnect]);

  const cancelPendingConnect = useCallback(() => {
    setPendingConnect(null);
    setStatus("Pairing cancelled.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      presentConnectLink(event.url);
    });
    return () => subscription.remove();
  }, [presentConnectLink]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.panel}>
          <Text style={styles.title}>NatStack Mobile Host</Text>
          <Text style={styles.message}>{status}</Text>
          {busy ? (
            <ActivityIndicator />
          ) : approvals.length > 0 ? (
            <View style={styles.actions}>
              <View style={styles.approvalBox}>
                {approvals.map((approval, approvalIndex) => {
                  const units = Array.isArray(approval?.units) ? approval.units : [];
                  return (
                    <View
                      key={approval.approvalId ?? `approval-${approvalIndex}`}
                      style={styles.approvalGroup}
                    >
                      <Text style={styles.approvalGroupTitle}>{approvalTitle(approval)}</Text>
                      {units.length > 0 ? (
                        units.map((unit, unitIndex) => (
                          <View
                            key={`${approval.approvalId ?? approvalIndex}:${
                              unit.unitName ?? unit.displayName ?? unitIndex
                            }`}
                            style={styles.unitCard}
                          >
                            <View style={styles.unitHeader}>
                              <Text style={styles.unitName}>
                                {unit.displayName || unit.unitName || "Workspace unit"}
                              </Text>
                              <Text style={styles.unitBadge}>{unitTargetLabel(unit)}</Text>
                            </View>
                            <Text style={styles.unitMeta}>{unitSourceLabel(unit)}</Text>
                            <Text style={styles.unitMeta}>{unitCapabilitiesLabel(unit)}</Text>
                          </View>
                        ))
                      ) : (
                        <Text style={styles.approval}>
                          {approval.description || approval.approvalId || "Approval required"}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
              <Button title="Trust and start" onPress={() => resolveLaunchApprovals("once")} />
              <Button title="Deny" onPress={() => resolveLaunchApprovals("deny")} />
            </View>
          ) : pendingConnect ? (
            <View style={styles.actions}>
              <Button title="Pair" onPress={confirmPendingConnect} />
              <Button title="Cancel" onPress={cancelPendingConnect} />
            </View>
          ) : (
            <Button title="Retry" onPress={load} />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101418",
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    gap: 16,
  },
  actions: {
    gap: 12,
  },
  title: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700",
  },
  message: {
    color: "#cbd5e1",
    fontSize: 16,
    lineHeight: 22,
  },
  approval: {
    color: "#e2e8f0",
    fontSize: 14,
    lineHeight: 20,
  },
  approvalBox: {
    borderColor: "#334155",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 12,
  },
  approvalGroup: {
    gap: 10,
  },
  approvalGroupTitle: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700",
  },
  unitCard: {
    borderColor: "#334155",
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
    borderColor: "#475569",
    borderRadius: 999,
    borderWidth: 1,
    color: "#e2e8f0",
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  unitMeta: {
    color: "#cbd5e1",
    fontSize: 13,
    lineHeight: 18,
  },
});

AppRegistry.registerComponent(appName, () => NatStackMobileHostBootstrap);
