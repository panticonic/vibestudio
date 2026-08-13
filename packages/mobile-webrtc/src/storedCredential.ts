import {
  normalizeFingerprint,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  type ConnectPairing,
  type ReconnectReach,
} from "@vibestudio/shared/connect";
import { isDeviceId, isDeviceRefreshToken } from "@vibestudio/shared/deviceCredentials";

export type FreshShellPairing = ConnectPairing;
export type StoredShellPairing = ReconnectReach;

export interface ShellCredential {
  deviceId: string;
  refreshToken: string;
}

interface StoredMobileConnectionBase {
  schemaVersion: 4;
  credential: ShellCredential;
  controlPairing: StoredShellPairing;
  selectedWorkspaceId: string;
  pairedAt: number;
}

export interface StoredPairedMobileConnection extends StoredMobileConnectionBase {
  phase: "paired";
}

export interface StoredRoutedMobileConnection extends StoredMobileConnectionBase {
  phase: "routed";
  workspacePairing: StoredShellPairing;
}

export type StoredMobileConnection = StoredPairedMobileConnection | StoredRoutedMobileConnection;

const CREDENTIAL_KEYS = new Set(["deviceId", "refreshToken"]);
const PAIRING_KEYS = new Set(["room", "fp", "sig", "v", "ice"]);
const FRESH_PAIRING_KEYS = new Set([...PAIRING_KEYS, "code", "exp"]);
const PAIRED_STORED_KEYS = new Set([
  "schemaVersion",
  "phase",
  "credential",
  "controlPairing",
  "selectedWorkspaceId",
  "pairedAt",
]);
const ROUTED_STORED_KEYS = new Set([...PAIRED_STORED_KEYS, "workspacePairing"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => keys.has(key));
}

function isCurrentShellCredential(value: unknown): value is ShellCredential {
  if (!isRecord(value) || !hasOnlyKeys(value, CREDENTIAL_KEYS)) return false;
  return isDeviceId(value["deviceId"]) && isDeviceRefreshToken(value["refreshToken"]);
}

function isCurrentStoredPairing(
  value: unknown,
  requireCanonical: boolean
): value is StoredShellPairing {
  if (!isRecord(value) || !hasOnlyKeys(value, PAIRING_KEYS)) {
    return false;
  }
  const fingerprint = typeof value["fp"] === "string" ? normalizeFingerprint(value["fp"]) : null;
  const signaling = typeof value["sig"] === "string" ? parseSignalingEndpoint(value["sig"]) : null;
  if (
    typeof value["room"] !== "string" ||
    !PAIRING_ROOM_PATTERN.test(value["room"]) ||
    typeof value["fp"] !== "string" ||
    fingerprint === null ||
    !/^[0-9A-F]{64}$/.test(fingerprint) ||
    (requireCanonical && value["fp"] !== fingerprint) ||
    typeof value["sig"] !== "string" ||
    signaling?.kind !== "ok" ||
    (requireCanonical && signaling.url !== value["sig"]) ||
    value["v"] !== PAIRING_PROTOCOL_VERSION ||
    (value["ice"] !== "all" && value["ice"] !== "relay")
  ) {
    return false;
  }
  return true;
}

function isCurrentFreshPairing(value: unknown): value is FreshShellPairing {
  if (!isRecord(value) || !hasOnlyKeys(value, FRESH_PAIRING_KEYS)) return false;
  const reach = {
    room: value["room"],
    fp: value["fp"],
    sig: value["sig"],
    v: PAIRING_PROTOCOL_VERSION,
    ice: value["ice"],
  };
  return (
    isCurrentStoredPairing(reach, false) &&
    value["v"] === PAIRING_PROTOCOL_VERSION &&
    typeof value["code"] === "string" &&
    PAIRING_CODE_PATTERN.test(value["code"]) &&
    typeof value["exp"] === "number" &&
    Number.isSafeInteger(value["exp"]) &&
    value["exp"] > 0
  );
}

function describePairingValidationFailure(value: unknown): string {
  if (!isRecord(value)) return "is not an object";
  const allowedKeys = FRESH_PAIRING_KEYS;
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    return `contains unexpected field(s): ${unexpectedKeys.sort().join(", ")}`;
  }
  if (typeof value["room"] !== "string" || !PAIRING_ROOM_PATTERN.test(value["room"])) {
    return "has an invalid signaling room";
  }
  const fingerprint = typeof value["fp"] === "string" ? normalizeFingerprint(value["fp"]) : null;
  if (fingerprint === null || !/^[0-9A-F]{64}$/.test(fingerprint)) {
    return "has an invalid DTLS fingerprint";
  }
  const signaling = typeof value["sig"] === "string" ? parseSignalingEndpoint(value["sig"]) : null;
  if (signaling?.kind !== "ok") return "has an invalid signaling endpoint";
  if (value["v"] !== PAIRING_PROTOCOL_VERSION) return "has an unsupported protocol version";
  if (value["ice"] !== "all" && value["ice"] !== "relay") {
    return "has an invalid ICE transport policy";
  }
  if (typeof value["code"] !== "string" || !PAIRING_CODE_PATTERN.test(value["code"])) {
    return "has an invalid pairing code";
  }
  return "is not a current WebRTC pairing";
}

function canonicalizeFreshPairing(pairing: FreshShellPairing, label: string): StoredShellPairing {
  if (!isCurrentFreshPairing(pairing)) {
    throw new Error(
      `Cannot persist the ${label} WebRTC pairing: ${describePairingValidationFailure(pairing)}`
    );
  }
  const signaling = parseSignalingEndpoint(pairing.sig);
  if (signaling.kind === "error") throw new Error("Cannot persist a non-canonical WebRTC pairing");
  return {
    room: pairing.room,
    fp: normalizeFingerprint(pairing.fp),
    sig: signaling.url,
    v: PAIRING_PROTOCOL_VERSION,
    ice: pairing.ice,
  };
}

function canonicalizeStoredPairing(pairing: StoredShellPairing, label: string): StoredShellPairing {
  if (!isCurrentStoredPairing(pairing, false)) {
    throw new Error(`Cannot persist the ${label} WebRTC pairing: invalid reconnect reach`);
  }
  const signaling = parseSignalingEndpoint(pairing.sig);
  if (signaling.kind === "error") throw new Error("Cannot persist a non-canonical WebRTC pairing");
  return {
    room: pairing.room,
    fp: normalizeFingerprint(pairing.fp),
    sig: signaling.url,
    v: PAIRING_PROTOCOL_VERSION,
    ice: pairing.ice,
  };
}

function validateSelectedWorkspaceId(selectedWorkspaceId: string): void {
  if (
    !selectedWorkspaceId ||
    selectedWorkspaceId !== selectedWorkspaceId.trim() ||
    selectedWorkspaceId.length > 512 ||
    selectedWorkspaceId.includes("\0")
  ) {
    throw new Error("Cannot persist an invalid selected workspace identity");
  }
}

function validateCredentialAndTimestamp(credential: ShellCredential, pairedAt: number): void {
  if (!isCurrentShellCredential(credential)) {
    throw new Error(
      "Cannot persist a device credential that was not emitted by the current issuer"
    );
  }
  if (!Number.isSafeInteger(pairedAt) || pairedAt <= 0) {
    throw new Error("Cannot persist a device credential with an invalid pairing timestamp");
  }
}

export function createPairedMobileConnection(
  credential: ShellCredential,
  controlPairing: FreshShellPairing,
  selectedWorkspaceId: string,
  pairedAt = Date.now()
): StoredPairedMobileConnection {
  validateCredentialAndTimestamp(credential, pairedAt);
  validateSelectedWorkspaceId(selectedWorkspaceId);
  return {
    schemaVersion: 4,
    phase: "paired",
    credential: { ...credential },
    controlPairing: canonicalizeFreshPairing(controlPairing, "control"),
    selectedWorkspaceId,
    pairedAt,
  };
}

export function createRoutedMobileConnection(
  paired: StoredPairedMobileConnection,
  workspacePairing: StoredShellPairing
): StoredRoutedMobileConnection {
  return {
    ...paired,
    phase: "routed",
    workspacePairing: canonicalizeStoredPairing(workspacePairing, "workspace"),
  };
}

export function replaceMobileConnectionCredential(
  connection: StoredMobileConnection,
  credential: ShellCredential
): StoredMobileConnection {
  validateCredentialAndTimestamp(credential, connection.pairedAt);
  return { ...connection, credential: { ...credential } };
}

export function parseStoredMobileConnection(
  raw: string | null | undefined
): StoredMobileConnection | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const phase = parsed["phase"];
    const allowedKeys = phase === "paired" ? PAIRED_STORED_KEYS : ROUTED_STORED_KEYS;
    if (parsed["schemaVersion"] !== 4 || !hasOnlyKeys(parsed, allowedKeys)) return null;
    const credential = parsed["credential"];
    const controlPairing = parsed["controlPairing"];
    const workspacePairing = parsed["workspacePairing"];
    const selectedWorkspaceId = parsed["selectedWorkspaceId"];
    const pairedAt = parsed["pairedAt"];
    if (
      !isCurrentShellCredential(credential) ||
      !isCurrentStoredPairing(controlPairing, true) ||
      (phase === "routed" && !isCurrentStoredPairing(workspacePairing, true)) ||
      (phase !== "paired" && phase !== "routed") ||
      typeof selectedWorkspaceId !== "string" ||
      !selectedWorkspaceId ||
      selectedWorkspaceId !== selectedWorkspaceId.trim() ||
      selectedWorkspaceId.length > 512 ||
      selectedWorkspaceId.includes("\0") ||
      typeof pairedAt !== "number" ||
      !Number.isSafeInteger(pairedAt) ||
      pairedAt <= 0
    ) {
      return null;
    }
    const base = {
      schemaVersion: 4 as const,
      credential,
      controlPairing,
      selectedWorkspaceId,
      pairedAt,
    };
    return phase === "paired"
      ? { ...base, phase }
      : { ...base, phase, workspacePairing: workspacePairing as StoredShellPairing };
  } catch {
    return null;
  }
}
