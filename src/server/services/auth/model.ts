import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { DeviceAuthStore } from "../deviceAuthStore.js";

export interface AuthConnectionInfo {
  serverUrl: string;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
}

export interface ConnectionInfoResponse {
  serverUrl: string;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
}

export interface DeviceCredentialResponse {
  deviceId: string;
  refreshToken: string;
  /** Owning user of the issued device (WP0 §3.2) — the redeemed subject. */
  userId: string;
  label: string;
  platform?: string;
  shellToken?: string;
  callerId?: string;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

export function shellCallerId(deviceId: string): string {
  return `shell:${deviceId}`;
}

/**
 * Runtime principal id for an entity-scoped agent credential.
 * One agent principal per entity, so
 * all credentials minted for the same entity authenticate as the same caller id.
 */
export function agentCallerId(entityId: string): string {
  return `agent:${entityId}`;
}

export function connectionInfoResponse(deps: {
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  getConnectionInfo: () => AuthConnectionInfo;
}): ConnectionInfoResponse {
  const info = deps.getConnectionInfo();
  return {
    serverUrl: info.serverUrl,
    protocol: info.protocol,
    externalHost: info.externalHost,
    gatewayPort: info.gatewayPort,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}

export function responseForCredential(
  deps: {
    tokenManager: TokenManager;
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string | null | undefined;
  },
  credential: {
    deviceId: string;
    refreshToken: string;
    userId: string;
    label: string;
    platform?: string;
  },
  options: { includeShellToken: boolean }
): DeviceCredentialResponse {
  const shellFields = options.includeShellToken
    ? {
        shellToken: deps.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell"),
        callerId: shellCallerId(credential.deviceId),
      }
    : {};
  return {
    ...credential,
    ...shellFields,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId() ?? null,
  };
}
