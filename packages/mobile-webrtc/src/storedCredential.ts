import {
  normalizeFingerprint,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  type TurnPolicy,
} from "@vibestudio/shared/connect";
import { isDeviceId, isDeviceRefreshToken } from "@vibestudio/shared/deviceCredentials";

export interface ShellPairing {
  room: string;
  fp: string;
  sig: string;
  ice: TurnPolicy;
  v: typeof PAIRING_PROTOCOL_VERSION;
  /** Present only while redeeming a fresh invite; never persisted. */
  code?: string;
}

export interface ShellCredential {
  deviceId: string;
  refreshToken: string;
}

export type StoredShellPairing = Omit<ShellPairing, "code">;

export interface StoredShellCredential extends ShellCredential {
  schemaVersion: 3;
  controlPairing: StoredShellPairing;
  workspacePairing: StoredShellPairing;
  pairedAt: number;
}

const CREDENTIAL_KEYS = new Set(["deviceId", "refreshToken"]);
const PAIRING_KEYS = new Set(["room", "fp", "sig", "v", "ice"]);
const FRESH_PAIRING_KEYS = new Set([...PAIRING_KEYS, "code"]);
const STORED_KEYS = new Set([
  "schemaVersion",
  "deviceId",
  "refreshToken",
  "controlPairing",
  "workspacePairing",
  "pairedAt",
]);

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

function isCurrentPairing(
  value: unknown,
  allowCode: boolean,
  requireCanonical: boolean
): value is ShellPairing {
  if (!isRecord(value) || !hasOnlyKeys(value, allowCode ? FRESH_PAIRING_KEYS : PAIRING_KEYS)) {
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
  return (
    !allowCode ||
    value["code"] === undefined ||
    (typeof value["code"] === "string" && PAIRING_CODE_PATTERN.test(value["code"]))
  );
}

function describePairingValidationFailure(value: unknown, allowCode: boolean): string {
  if (!isRecord(value)) return "is not an object";
  const allowedKeys = allowCode ? FRESH_PAIRING_KEYS : PAIRING_KEYS;
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
  if (
    allowCode &&
    value["code"] !== undefined &&
    (typeof value["code"] !== "string" || !PAIRING_CODE_PATTERN.test(value["code"]))
  ) {
    return "has an invalid pairing code";
  }
  return "is not a current WebRTC pairing";
}

export function createStoredShellCredential(
  credential: ShellCredential,
  controlPairing: ShellPairing,
  workspacePairing: ShellPairing,
  pairedAt = Date.now()
): StoredShellCredential {
  if (!isCurrentShellCredential(credential)) {
    throw new Error(
      "Cannot persist a device credential that was not emitted by the current issuer"
    );
  }
  if (!isCurrentPairing(controlPairing, true, false)) {
    throw new Error(
      `Cannot persist the control WebRTC pairing: ${describePairingValidationFailure(controlPairing, true)}`
    );
  }
  if (!isCurrentPairing(workspacePairing, true, false)) {
    throw new Error(
      `Cannot persist the workspace WebRTC pairing: ${describePairingValidationFailure(workspacePairing, true)}`
    );
  }
  if (!Number.isSafeInteger(pairedAt) || pairedAt <= 0) {
    throw new Error("Cannot persist a device credential with an invalid pairing timestamp");
  }
  const canonicalize = (pairing: ShellPairing): StoredShellPairing => {
    const signaling = parseSignalingEndpoint(pairing.sig);
    if (signaling.kind === "error") {
      throw new Error("Cannot persist a non-canonical WebRTC pairing");
    }
    return {
      room: pairing.room,
      fp: normalizeFingerprint(pairing.fp),
      sig: signaling.url,
      v: PAIRING_PROTOCOL_VERSION,
      ice: pairing.ice,
    };
  };
  return {
    schemaVersion: 3,
    deviceId: credential.deviceId,
    refreshToken: credential.refreshToken,
    controlPairing: canonicalize(controlPairing),
    workspacePairing: canonicalize(workspacePairing),
    pairedAt,
  };
}

export function parseStoredShellCredential(
  raw: string | null | undefined
): StoredShellCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !hasOnlyKeys(parsed, STORED_KEYS)) return null;
    const credential = {
      deviceId: parsed["deviceId"],
      refreshToken: parsed["refreshToken"],
    };
    const controlPairing = parsed["controlPairing"];
    const workspacePairing = parsed["workspacePairing"];
    const pairedAt = parsed["pairedAt"];
    if (
      parsed["schemaVersion"] !== 3 ||
      !isCurrentShellCredential(credential) ||
      !isCurrentPairing(controlPairing, false, true) ||
      !isCurrentPairing(workspacePairing, false, true) ||
      typeof pairedAt !== "number" ||
      !Number.isSafeInteger(pairedAt) ||
      pairedAt <= 0
    ) {
      return null;
    }
    return {
      schemaVersion: 3,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      controlPairing,
      workspacePairing,
      pairedAt,
    };
  } catch {
    return null;
  }
}
