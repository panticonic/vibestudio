import * as fs from "node:fs";
import {
  normalizeFingerprint,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  selectedWorkspacePath,
  type ConnectPairing,
  type TurnPolicy,
} from "@vibestudio/shared/connect";
import { isDeviceId, isDeviceRefreshToken, isServerId } from "@vibestudio/shared/deviceCredentials";
import { writeFileAtomicSync } from "../atomicFile.js";
import { cliCredentialPath } from "./configPaths.js";

export type CliStoredPairing = Omit<ConnectPairing, "code" | "v" | "ice"> & {
  v: typeof PAIRING_PROTOCOL_VERSION;
  ice: TurnPolicy;
};

export interface CliCredentials {
  schemaVersion: 4;
  kind: "device";
  url: string;
  workspaceId: string;
  workspaceName: string;
  serverId: string;
  deviceId: string;
  refreshToken: string;
  controlPairing: CliStoredPairing;
  workspacePairing: CliStoredPairing;
  pairedAt: number;
}

const CREDENTIAL_KEYS = new Set([
  "schemaVersion",
  "kind",
  "url",
  "workspaceId",
  "workspaceName",
  "serverId",
  "deviceId",
  "refreshToken",
  "controlPairing",
  "workspacePairing",
  "pairedAt",
]);

const STORED_PAIRING_KEYS = new Set(["room", "fp", "sig", "v", "ice"]);

export const credentialPath = cliCredentialPath;

export function loadCliCredentials(): CliCredentials | null {
  const p = credentialPath();
  if (!fs.existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  } catch {
    // The file EXISTS but is unreadable/corrupt — surface it rather than silently
    // reporting "not paired", which sends the user down a re-pair path blind.
    console.warn(
      `[vibestudio] credential file exists but is not valid JSON: ${p}\n` +
        `             delete it and re-pair, or restore a good copy.`
    );
    return null;
  }
  if (isCliCredentials(parsed)) return parsed;
  console.warn(
    `[vibestudio] credential file is not a canonical device credential: ${p}\n` +
      "             delete it and pair again, or restore a good copy."
  );
  return null;
}

export function saveCliCredentials(creds: CliCredentials): void {
  if (!isCliCredentials(creds)) {
    throw new Error("Refusing to persist a non-canonical CLI device credential");
  }
  const p = credentialPath();
  writeFileAtomicSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCliCredentials(): void {
  const p = credentialPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function isWebRtcCredential<T extends { workspacePairing?: unknown }>(
  creds: T | null | undefined
): creds is T & { workspacePairing: CliStoredPairing } {
  return !!creds?.workspacePairing && isStoredPairing(creds.workspacePairing);
}

/** Canonical persisted form of a hub-returned WebRTC reach record. */
export function canonicalStoredPairing(reach: CliStoredPairing): CliStoredPairing {
  const signaling = parseSignalingEndpoint(reach.sig);
  if (signaling.kind === "error") throw new Error(signaling.reason);
  const canonical: CliStoredPairing = {
    room: reach.room,
    fp: normalizeFingerprint(reach.fp),
    sig: signaling.url,
    v: reach.v,
    ice: reach.ice,
  };
  if (!isStoredPairing(canonical)) {
    throw new Error("Hub returned non-canonical WebRTC reach coordinates");
  }
  return canonical;
}

function isStoredPairing(value: unknown): value is CliStoredPairing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !STORED_PAIRING_KEYS.has(key))) return false;
  const pairing = value as Partial<CliStoredPairing>;
  const signaling = typeof pairing.sig === "string" ? parseSignalingEndpoint(pairing.sig) : null;
  return (
    typeof pairing.room === "string" &&
    PAIRING_ROOM_PATTERN.test(pairing.room) &&
    typeof pairing.fp === "string" &&
    pairing.fp === normalizeFingerprint(pairing.fp) &&
    /^[0-9A-F]{64}$/.test(pairing.fp) &&
    typeof pairing.sig === "string" &&
    signaling?.kind === "ok" &&
    signaling.url === pairing.sig &&
    pairing.v === PAIRING_PROTOCOL_VERSION &&
    (pairing.ice === "all" || pairing.ice === "relay")
  );
}

function isCliCredentials(value: unknown): value is CliCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !CREDENTIAL_KEYS.has(key))) return false;
  const candidate = value as Partial<CliCredentials>;
  if (
    candidate.schemaVersion !== 4 ||
    candidate.kind !== "device" ||
    typeof candidate.workspaceId !== "string" ||
    candidate.workspaceId.length === 0 ||
    candidate.workspaceId.trim() !== candidate.workspaceId ||
    typeof candidate.workspaceName !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.workspaceName) ||
    !isServerId(candidate.serverId) ||
    !isDeviceId(candidate.deviceId) ||
    !isDeviceRefreshToken(candidate.refreshToken) ||
    !isStoredPairing(candidate.controlPairing) ||
    !isStoredPairing(candidate.workspacePairing) ||
    !Number.isSafeInteger(candidate.pairedAt) ||
    (candidate.pairedAt ?? 0) <= 0
  ) {
    return false;
  }
  const expectedUrl = `webrtc://${candidate.workspacePairing.room}${selectedWorkspacePath(candidate.workspaceName)}`;
  return candidate.url === expectedUrl;
}
