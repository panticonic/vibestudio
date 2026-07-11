import { randomUUID } from "node:crypto";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import {
  type ConnectPairing,
  createConnectDeepLink,
  createConnectPairUrl,
} from "@vibestudio/shared/connect";
import { DEFAULT_PAIRING_CODE_TTL_MS, type DeviceAuthStore } from "../deviceAuthStore.js";

/**
 * The WebRTC pairing material the running server advertises (its DTLS `fp` and
 * signaling endpoint `sig`, plus optional turn policy / label). `code` AND
 * `room` are minted PER-INVITE (plan §2.1 — one signaling room per invite, not
 * one per server), so neither is part of the seam. The server-side WebRTC
 * wiring populates this; without it, invite minting fails.
 */
export type ConnectPairingSeam = Omit<ConnectPairing, "code" | "room" | "v">;

/** The ingress-pool surface invite minting needs (arm a room per invite). */
export interface PairingRoomArmer {
  armRoom(room: string, meta: { deviceId?: string; inviteCode?: string }): void;
}

export interface AuthConnectionInfo {
  serverUrl: string;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
  /** WebRTC pairing material (room/fp/sig) used to mint the pairing deep link. */
  pairing?: ConnectPairingSeam;
}

export interface ConnectionInfoResponse {
  serverUrl: string;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

export interface PairingInviteResponse extends ConnectionInfoResponse {
  code: string;
  expiresInMs: number;
  expiresAt: number;
  deepLink: string;
  pairUrl: string;
  /** The invite's freshly minted signaling room. */
  room: string;
  fp: string;
  sig: string;
  ice?: ConnectPairing["ice"];
  srv?: string;
}

export interface DeviceCredentialResponse {
  deviceId: string;
  refreshToken: string;
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
  getWorkspaceId: () => string | null | undefined;
  getConnectionInfo?: () => AuthConnectionInfo;
}): ConnectionInfoResponse {
  const info = deps.getConnectionInfo?.() ?? { serverUrl: "" };
  return {
    serverUrl: info.serverUrl,
    protocol: info.protocol,
    externalHost: info.externalHost,
    gatewayPort: info.gatewayPort,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId() ?? null,
  };
}

export interface MintedPairingInvite {
  code: string;
  room: string;
  deepLink: string;
  pairUrl: string;
  expiresInMs: number;
  expiresAt: number;
  fp: string;
  sig: string;
  ice?: ConnectPairing["ice"];
  srv?: string;
}

/**
 * Mint one pairing invite: a registered pairing code plus, when WebRTC ingress
 * is live, a FRESH signaling room (plan §2.1 — room-per-invite) armed on the
 * pool and embedded in the `vibestudio://connect` deep link. The room follows the
 * invite's lifecycle: redemption persists it onto the device record (the store
 * re-tags the armed room via `onPairingRoomRedeemed`); expiry unredeemed
 * releases it (`onPairingRoomReleased` → disarm). Without ingress, invite
 * minting fails loud; there is no bare-code invite mode.
 */
export function mintPairingInvite(deps: {
  deviceAuthStore: DeviceAuthStore;
  pairing?: ConnectPairingSeam | null;
  ingress?: PairingRoomArmer | null;
  ttlMs?: number;
}): MintedPairingInvite {
  const expiresInMs = deps.ttlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  const { pairing, ingress } = deps;
  if (!pairing || !ingress) {
    throw new Error(
      "Cannot create a pairing invite because WebRTC ingress is not ready. Run `vibestudio remote doctor` and repair signaling/identity before inviting devices."
    );
  }
  const room = randomUUID();
  const code = deps.deviceAuthStore.createPairingCode(expiresInMs, { room });
  ingress.armRoom(room, { inviteCode: code });
  const expiresAt = Date.now() + expiresInMs;
  const payload = { ...pairing, room, code, exp: expiresAt };
  return {
    code,
    room,
    deepLink: createConnectDeepLink(payload),
    pairUrl: createConnectPairUrl(payload),
    expiresInMs,
    expiresAt,
    fp: pairing.fp,
    sig: pairing.sig,
    ice: pairing.ice,
    srv: pairing.srv,
  };
}

export function createPairingInviteResponse(
  deps: {
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string | null | undefined;
    getConnectionInfo?: () => AuthConnectionInfo;
    getWebRtcIngress?: () => PairingRoomArmer | null;
  },
  ttlMs?: number
): PairingInviteResponse {
  const info = connectionInfoResponse(deps);
  const invite = mintPairingInvite({
    deviceAuthStore: deps.deviceAuthStore,
    pairing: deps.getConnectionInfo?.().pairing ?? null,
    ingress: deps.getWebRtcIngress?.() ?? null,
    ttlMs,
  });
  return {
    ...info,
    code: invite.code,
    expiresInMs: invite.expiresInMs,
    expiresAt: invite.expiresAt,
    deepLink: invite.deepLink,
    pairUrl: invite.pairUrl,
    room: invite.room,
    fp: invite.fp,
    sig: invite.sig,
    ice: invite.ice,
    srv: invite.srv,
  };
}

export function responseForCredential(
  deps: {
    tokenManager: TokenManager;
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string | null | undefined;
  },
  credential: { deviceId: string; refreshToken: string; label: string; platform?: string },
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
