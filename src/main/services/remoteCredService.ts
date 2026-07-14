import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { requirePanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  HubWorkspaceRouteSchema,
  hubControlMethods,
  type HubWorkspaceRoute,
} from "@vibestudio/service-schemas/hubControl";
import { remoteCredMethods } from "@vibestudio/service-schemas/remoteCred";
import type { ServerClient } from "../serverClient.js";
import { relaunchApp } from "../relaunchApp.js";
import { PAIR_CONFIRMED_ARG } from "../startupInvocation.js";
import {
  createConnectDeepLink,
  normalizeFingerprint,
  parseConnectLink,
} from "@vibestudio/shared/connect";
import {
  clearStoredRemotePairing as clearStoredRemotePairingInStore,
  loadStoredRemotePairing as loadStoredRemotePairingFromStore,
  saveDeviceCredential,
  type StoredRemote,
} from "./deviceCredentialStore.js";

function remoteCredentialPersistenceDisabled(): boolean {
  const value = process.env["VIBESTUDIO_DISABLE_REMOTE_CRED_PERSISTENCE"];
  return value === "1" || value === "true";
}

const PAIR_LABEL_ARG_PREFIX = "--vibestudio-pair-label=";

/** Recover the device label carried across the pairing relaunch. */
export function readPendingPairLabel(argv: readonly string[] = process.argv): string | undefined {
  const arg = argv.find((value) => value.startsWith(PAIR_LABEL_ARG_PREFIX));
  if (!arg) return undefined;
  try {
    return decodeURIComponent(arg.slice(PAIR_LABEL_ARG_PREFIX.length)).trim() || undefined;
  } catch {
    return undefined;
  }
}

function persistOrWarn(description: string, persist: () => void): void {
  try {
    persist();
  } catch (error) {
    console.error(
      `[remoteCred] ${description}: ${error instanceof Error ? error.message : String(error)} ` +
        "— the device will need to re-pair on next launch."
    );
  }
}

/** Read the encrypted WebRTC pairing used by serverSession auto-reconnect. */
export function loadStoredRemotePairing(): StoredRemote | null {
  return loadStoredRemotePairingFromStore();
}

/** Forget the paired remote after an explicit disconnect or terminal rejection. */
export function clearStoredRemotePairing(): void {
  clearStoredRemotePairingInStore();
}

/** Persist a refresh-token rotation against the existing encrypted pairing. */
export function persistRotatedRemoteCredential(credential: {
  deviceId: string;
  refreshToken: string;
}): void {
  if (remoteCredentialPersistenceDisabled()) return;
  const existing = loadStoredRemotePairingFromStore();
  if (!existing) return;
  persistOrWarn("could not persist rotated credential", () =>
    saveDeviceCredential({
      ...existing,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      rotatedAt: Date.now(),
    })
  );
}

/** Persist a freshly paired WebRTC device using Electron safeStorage. */
export function saveStoredRemote(value: StoredRemote): void {
  if (remoteCredentialPersistenceDisabled()) return;
  persistOrWarn("could not persist remote pairing", () => saveDeviceCredential(value));
}

/** Persist a device-specific workspace route before the desktop relaunches. */
export function persistStoredRemoteWorkspaceRoute(rawRoute: HubWorkspaceRoute): boolean {
  const existing = loadStoredRemotePairingFromStore();
  if (!existing) return false;
  const route = HubWorkspaceRouteSchema.parse(rawRoute);
  if (route.serverId !== existing.serverId) {
    throw new Error("Workspace route changed the paired server identity");
  }
  const storedReach = (reach: HubWorkspaceRoute["controlReach"]) => ({
    room: reach.room,
    fp: normalizeFingerprint(reach.fp),
    sig: reach.sig,
    v: reach.v,
    ice: reach.ice,
    ...(reach.srv ? { srv: reach.srv } : {}),
  });
  saveDeviceCredential({
    ...existing,
    workspaceName: route.workspace,
    controlPairing: storedReach(route.controlReach),
    workspacePairing: storedReach(route.workspaceReach),
  });
  return true;
}

function hubControlClientFor(client: ServerClient) {
  return createTypedServiceClient("hubControl", hubControlMethods, (service, method, args) =>
    client.call(service, method, args)
  );
}

export function createRemoteCredService(deps: {
  getServerClient?: () => ServerClient | null;
  /**
   * The current session's transport mode. `getCurrent` reports a remote as
   * ACTIVE only when the live client is genuinely the remote pipe — after a
   * `--skip-remote-pairing` fallback the live client is the LOCAL loopback one,
   * and reporting its `isConnected()` as "remote active" is a lie (the dialog
   * would show a green "connected to remote" while actually on local).
   */
  getConnectionMode?: () => "local" | "remote";
}): ServiceDefinition {
  const requireLiveClient = (): ServerClient => {
    const client = deps.getServerClient?.() ?? null;
    if (!client?.isConnected()) throw new Error("Not connected to a Vibestudio server");
    return client;
  };
  return {
    name: "remoteCred",
    description: "Manage this desktop's encrypted WebRTC device pairing",
    authority: { principals: ["user", "code"] },
    methods: remoteCredMethods,
    handler: defineServiceHandler("remoteCred", remoteCredMethods, {
      getCurrent: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.getCurrent");
        const stored = loadStoredRemotePairingFromStore();
        const client = deps.getServerClient?.() ?? null;
        return {
          connected: client?.isConnected() ?? false,
          configured: stored !== null,
          isActive:
            stored !== null &&
            deps.getConnectionMode?.() === "remote" &&
            (client?.isConnected() ?? false),
          bootstrap: stored ? "device" : "none",
          deviceId: stored?.deviceId,
          workspaceName: stored?.workspaceName,
        };
      },
      pair: async (ctx, [{ link, label }]) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.pair");
        const parsed = parseConnectLink(link);
        if (parsed.kind === "error") {
          return { ok: false, error: "invalid-link", message: parsed.reason };
        }
        const { kind: _kind, ...pairing } = parsed;
        const deepLink = createConnectDeepLink(pairing);
        const relaunchArgs = process.argv
          .slice(1)
          .filter(
            (arg) =>
              !arg.startsWith("vibestudio://") &&
              !arg.startsWith("https://vibestudio.app/pair") &&
              !arg.startsWith(PAIR_LABEL_ARG_PREFIX)
          );
        relaunchArgs.push(deepLink);
        // This link came from an explicit in-app Save/Switch action, so the
        // trust confirmation already happened. External deep links omit it.
        relaunchArgs.push(PAIR_CONFIRMED_ARG);
        if (typeof label === "string" && label.trim()) {
          relaunchArgs.push(`${PAIR_LABEL_ARG_PREFIX}${encodeURIComponent(label.trim())}`);
        }
        relaunchApp({ args: relaunchArgs });
        return { ok: true };
      },
      pairDevice: async (ctx, [options]) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.pairDevice");
        const client = hubControlClientFor(requireLiveClient());
        return await client.pairDevice(options);
      },
      listDevices: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.listDevices");
        const response = await hubControlClientFor(requireLiveClient()).listDevices();
        return response.devices;
      },
      revokeDevice: async (ctx, [deviceId]) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.revokeDevice");
        const stored = loadStoredRemotePairingFromStore();
        const result = await hubControlClientFor(requireLiveClient()).revokeDevice(deviceId);
        const currentDevice = result.revoked && stored?.deviceId === deviceId;
        if (currentDevice) clearStoredRemotePairingInStore();
        return { ...result, currentDevice };
      },
      reconnectNow: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.reconnectNow");
        const client = deps.getServerClient?.() ?? null;
        if (!client?.nudge) {
          throw new Error(
            "Reconnect isn't available for this connection — try relaunching Vibestudio."
          );
        }
        client.nudge();
        return;
      },
      clear: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.clear");
        clearStoredRemotePairingInStore();
        return { ok: true };
      },
      relaunch: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "remoteCred.relaunch");
        relaunchApp();
        return { ok: true };
      },
    }),
  };
}
