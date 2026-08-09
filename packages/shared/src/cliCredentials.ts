import {
  normalizeFingerprint,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  selectedWorkspacePath,
  type ConnectPairing,
  type TurnPolicy,
} from "./connect.js";
import { isDeviceId, isDeviceRefreshToken, isServerId } from "./deviceCredentials.js";

export const AGENT_ID_PATTERN = /^agt_[A-Za-z0-9_-]{24}$/;
export const AGENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AGENT_TOKEN_PATTERN = /^agent:agt_[A-Za-z0-9_-]{24}:[A-Za-z0-9_-]{43}$/;

export interface ParsedAgentToken {
  agentId: string;
  secret: string;
}

/** Parse the canonical server-issued agent bearer without accepting partial or
 * legacy token shapes. Identity derivation must always go through this parser. */
export function parseAgentToken(token: string): ParsedAgentToken | null {
  if (!AGENT_TOKEN_PATTERN.test(token)) return null;
  const match = /^agent:(agt_[A-Za-z0-9_-]{24}):([A-Za-z0-9_-]{43})$/.exec(token);
  return match?.[1] && match[2] ? { agentId: match[1], secret: match[2] } : null;
}

export type CliStoredPairing = Omit<ConnectPairing, "code" | "v" | "ice"> & {
  v: typeof PAIRING_PROTOCOL_VERSION;
  ice: TurnPolicy;
};

export interface CliDeviceCredentials {
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

/** One entity-scoped ordinary CLI login. It never contains or reuses a human
 * device refresh identity; an optional pairing contributes transport reach only. */
export interface CliAgentCredentials {
  schemaVersion: 1;
  kind: "agent";
  url: string;
  workspaceId: string;
  workspaceName: string;
  serverId: string;
  entityId: string;
  contextId: string;
  agentId: string;
  agentToken: string;
  workspacePairing?: CliStoredPairing;
  signedInAt: number;
}

export type CliCredentials = CliDeviceCredentials | CliAgentCredentials;

const DEVICE_KEYS = new Set([
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

const AGENT_KEYS = new Set([
  "schemaVersion",
  "kind",
  "url",
  "workspaceId",
  "workspaceName",
  "serverId",
  "entityId",
  "contextId",
  "agentId",
  "agentToken",
  "workspacePairing",
  "signedInAt",
]);

const STORED_PAIRING_KEYS = new Set(["room", "fp", "sig", "v", "ice"]);

export function isCliStoredPairing(value: unknown): value is CliStoredPairing {
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
  if (!isCliStoredPairing(canonical)) {
    throw new Error("Hub returned non-canonical WebRTC reach coordinates");
  }
  return canonical;
}

export function isCliDeviceCredentials(value: unknown): value is CliDeviceCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !DEVICE_KEYS.has(key))) return false;
  const candidate = value as Partial<CliDeviceCredentials>;
  if (
    candidate.schemaVersion !== 4 ||
    candidate.kind !== "device" ||
    !commonWorkspaceIdentity(candidate) ||
    !isDeviceId(candidate.deviceId) ||
    !isDeviceRefreshToken(candidate.refreshToken) ||
    !isCliStoredPairing(candidate.controlPairing) ||
    !isCliStoredPairing(candidate.workspacePairing) ||
    !positiveSafeInteger(candidate.pairedAt)
  ) {
    return false;
  }
  const canonical = candidate as CliDeviceCredentials;
  return canonical.url === workspacePairingUrl(canonical.workspaceName, canonical.workspacePairing);
}

export function isCliAgentCredentials(value: unknown): value is CliAgentCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !AGENT_KEYS.has(key))) return false;
  const candidate = value as Partial<CliAgentCredentials>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== "agent" ||
    !commonWorkspaceIdentity(candidate) ||
    typeof candidate.entityId !== "string" ||
    !exactNonempty(candidate.entityId) ||
    typeof candidate.contextId !== "string" ||
    !exactNonempty(candidate.contextId) ||
    typeof candidate.agentId !== "string" ||
    !AGENT_ID_PATTERN.test(candidate.agentId) ||
    typeof candidate.agentToken !== "string" ||
    parseAgentToken(candidate.agentToken)?.agentId !== candidate.agentId ||
    !positiveSafeInteger(candidate.signedInAt)
  ) {
    return false;
  }
  const canonical = candidate as CliAgentCredentials;
  if (canonical.workspacePairing !== undefined) {
    return (
      isCliStoredPairing(canonical.workspacePairing) &&
      canonical.url === workspacePairingUrl(canonical.workspaceName, canonical.workspacePairing)
    );
  }
  return isDirectWorkspaceUrl(canonical.url, canonical.workspaceName);
}

export function isCliCredentials(value: unknown): value is CliCredentials {
  return isCliDeviceCredentials(value) || isCliAgentCredentials(value);
}

export function cliCredentialJson(credentials: CliCredentials): string {
  if (!isCliCredentials(credentials)) {
    throw new Error("Refusing to serialize a non-canonical CLI credential");
  }
  return `${JSON.stringify(credentials, null, 2)}\n`;
}

function commonWorkspaceIdentity(value: {
  workspaceId?: unknown;
  workspaceName?: unknown;
  serverId?: unknown;
  url?: unknown;
}): boolean {
  return (
    typeof value.workspaceId === "string" &&
    exactNonempty(value.workspaceId) &&
    typeof value.workspaceName === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.workspaceName) &&
    isServerId(value.serverId) &&
    typeof value.url === "string" &&
    exactNonempty(value.url)
  );
}

function workspacePairingUrl(workspaceName: string, pairing: CliStoredPairing): string {
  return `webrtc://${pairing.room}${selectedWorkspacePath(workspaceName)}`;
}

function isDirectWorkspaceUrl(raw: string, workspaceName: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === selectedWorkspacePath(workspaceName))
    );
  } catch {
    return false;
  }
}

function exactNonempty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
