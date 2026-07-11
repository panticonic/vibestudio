import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  HubWorkspaceRouteSchema,
  hubControlMethods,
  type HubWorkspaceRoute,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import type { ViewManager } from "../viewManager.js";
import { requireChromeAppCallerOrHost } from "./appCapabilities.js";
import { remoteCredMethods } from "@vibestudio/shared/serviceSchemas/remoteCred";
import type { ServerClient } from "../serverClient.js";
import { relaunchApp } from "../relaunchApp.js";
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
  if (!existing) {
    throw new Error("Cannot persist a rotated device credential without its stored pairing");
  }
  saveDeviceCredential({
    ...existing,
    deviceId: credential.deviceId,
    refreshToken: credential.refreshToken,
    rotatedAt: Date.now(),
  });
}

/** Persist a freshly paired WebRTC device using Electron safeStorage. */
export function saveStoredRemote(value: StoredRemote): void {
  if (remoteCredentialPersistenceDisabled()) return;
  saveDeviceCredential(value);
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
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  const requireLiveClient = (): ServerClient => {
    const client = deps.getServerClient?.() ?? null;
    if (!client?.isConnected()) throw new Error("Not connected to a Vibestudio server");
    return client;
  };

  return {
    name: "remoteCred",
    description: "Manage this desktop's encrypted WebRTC device pairing",
    policy: { allowed: ["shell", "app"] },
    methods: remoteCredMethods,
    handler: async (ctx, method, args) => {
      if (ctx.caller.runtime.kind === "app") {
        if (!deps.getViewManager) {
          throw new Error(`remoteCred.${method} app capability unavailable`);
        }
        requireChromeAppCallerOrHost(ctx, deps.getViewManager(), `remoteCred.${method}`);
      }

      switch (method) {
        case "getCurrent": {
          const stored = loadStoredRemotePairingFromStore();
          const client = deps.getServerClient?.() ?? null;
          return {
            connected: client?.isConnected() ?? false,
            configured: stored !== null,
            isActive: stored !== null && (client?.isConnected() ?? false),
            deviceId: stored?.deviceId,
            workspaceName: stored?.workspaceName,
          };
        }
        case "pair": {
          const { link } = args[0] as { link: string };
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
                !arg.startsWith("vibestudio://") && !arg.startsWith("https://vibestudio.app/pair")
            );
          relaunchArgs.push(deepLink);
          relaunchApp({ args: relaunchArgs });
          return { ok: true };
        }
        case "pairDevice": {
          const client = hubControlClientFor(requireLiveClient());
          return await client.pairDevice(
            args[0] as { workspace?: string; ttlMs?: number } | undefined
          );
        }
        case "listDevices": {
          const response = await hubControlClientFor(requireLiveClient()).listDevices();
          return response.devices;
        }
        case "revokeDevice": {
          const deviceId = args[0] as string;
          const stored = loadStoredRemotePairingFromStore();
          const result = await hubControlClientFor(requireLiveClient()).revokeDevice(deviceId);
          const currentDevice = result.revoked && stored?.deviceId === deviceId;
          if (currentDevice) clearStoredRemotePairingInStore();
          return { ...result, currentDevice };
        }
        case "clear":
          clearStoredRemotePairingInStore();
          return { ok: true };
        case "relaunch":
          relaunchApp();
          return { ok: true };
        default:
          throw new Error(`Unknown remoteCred method: ${method}`);
      }
    },
  };
}
