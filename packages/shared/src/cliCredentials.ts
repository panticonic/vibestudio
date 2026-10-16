import { assertIrohReach, type IrohReach } from "@vibestudio/iroh-transport";
import { selectedWorkspacePath } from "./connect.js";
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

export type CliStoredPairing = IrohReach;

interface CliDeviceCredentialsBase {
  schemaVersion: 6;
  phase: "workspace";
  kind: "device";
  url: string;
  workspaceId: string;
  workspaceName: string;
  serverId: string;
  deviceId: string;
  refreshToken: string;
  pairedAt: number;
}

export interface CliIrohDeviceCredentials extends CliDeviceCredentialsBase {
  transport: "iroh";
  deviceSecret: string;
  controlPairing: CliStoredPairing;
  workspacePairing: CliStoredPairing;
}

export interface CliLocalDeviceCredentials extends CliDeviceCredentialsBase {
  transport: "local";
}

export type CliDeviceCredentials = CliIrohDeviceCredentials | CliLocalDeviceCredentials;

interface CliAccountDeviceCredentialsBase {
  schemaVersion: 6;
  kind: "device";
  phase: "account";
  /** Actual authenticated account-control endpoint, not a workspace route. */
  url: string;
  deviceId: string;
  refreshToken: string;
  pairedAt: number;
}

export interface CliLocalAccountCredentials extends CliAccountDeviceCredentialsBase {
  transport: "local";
  serverId: string;
}

export interface CliIrohAccountCredentials extends CliAccountDeviceCredentialsBase {
  transport: "iroh";
  deviceSecret: string;
  controlPairing: CliStoredPairing;
}

export type CliAccountDeviceCredentials = CliLocalAccountCredentials | CliIrohAccountCredentials;
export type CliDeviceIdentity = CliDeviceCredentials | CliAccountDeviceCredentials;
export type CliIdentity = CliDeviceIdentity | CliAgentCredentials;

/** One entity-scoped ordinary CLI login. It never contains or reuses a human
 * device refresh identity; an optional pairing contributes transport reach only. */
interface CliAgentCredentialsBase {
  schemaVersion: 2;
  kind: "agent";
  url: string;
  workspaceId: string;
  workspaceName: string;
  serverId: string;
  entityId: string;
  contextId: string;
  agentId: string;
  agentToken: string;
  signedInAt: number;
}

export interface CliIrohAgentCredentials extends CliAgentCredentialsBase {
  transport: "iroh";
  deviceSecret: string;
  workspacePairing: CliStoredPairing;
}

export interface CliLocalAgentCredentials extends CliAgentCredentialsBase {
  transport: "local";
}

export type CliAgentCredentials = CliIrohAgentCredentials | CliLocalAgentCredentials;

export type CliCredentials = CliDeviceCredentials | CliAgentCredentials;

const DEVICE_KEYS = new Set([
  "schemaVersion",
  "phase",
  "kind",
  "url",
  "workspaceId",
  "workspaceName",
  "serverId",
  "deviceId",
  "refreshToken",
  "transport",
  "deviceSecret",
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
  "transport",
  "deviceSecret",
  "workspacePairing",
  "signedInAt",
]);

const STORED_PAIRING_KEYS = new Set(["endpointId", "relays", "v"]);
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isCliStoredPairing(value: unknown): value is CliStoredPairing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !STORED_PAIRING_KEYS.has(key))) return false;
  try {
    assertIrohReach(value as CliStoredPairing);
    return true;
  } catch {
    return false;
  }
}

export function canonicalStoredPairing(reach: CliStoredPairing): CliStoredPairing {
  const canonical: CliStoredPairing = {
    endpointId: reach.endpointId,
    relays: [...reach.relays],
    v: reach.v,
  };
  if (!isCliStoredPairing(canonical)) {
    throw new Error("Hub returned non-canonical Iroh reach coordinates");
  }
  return canonical;
}

export function isCliDeviceCredentials(value: unknown): value is CliDeviceCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !DEVICE_KEYS.has(key))) return false;
  const candidate = value as Partial<CliDeviceCredentialsBase> & {
    transport?: unknown;
    deviceSecret?: unknown;
    controlPairing?: unknown;
    workspacePairing?: unknown;
  };
  if (
    candidate.schemaVersion !== 6 ||
    (value as { phase?: unknown }).phase !== "workspace" ||
    candidate.kind !== "device" ||
    !commonWorkspaceIdentity(candidate) ||
    !isDeviceId(candidate.deviceId) ||
    !isDeviceRefreshToken(candidate.refreshToken) ||
    !positiveSafeInteger(candidate.pairedAt)
  ) {
    return false;
  }
  if (candidate.transport === "local") {
    return (
      candidate.deviceSecret === undefined &&
      candidate.controlPairing === undefined &&
      candidate.workspacePairing === undefined &&
      isDirectWorkspaceUrl(candidate.url!, candidate.workspaceName!)
    );
  }
  if (candidate.transport !== "iroh") return false;
  if (
    typeof candidate.deviceSecret !== "string" ||
    !DEVICE_SECRET_PATTERN.test(candidate.deviceSecret) ||
    !isCliStoredPairing(candidate.controlPairing) ||
    !isCliStoredPairing(candidate.workspacePairing)
  )
    return false;
  const canonical = candidate as CliIrohDeviceCredentials;
  return canonical.url === workspacePairingUrl(canonical.workspaceName, canonical.workspacePairing);
}

export function isCliAgentCredentials(value: unknown): value is CliAgentCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !AGENT_KEYS.has(key))) return false;
  const candidate = value as Partial<CliAgentCredentialsBase> & {
    transport?: unknown;
    deviceSecret?: unknown;
    workspacePairing?: unknown;
  };
  if (
    candidate.schemaVersion !== 2 ||
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
  if (candidate.transport === "iroh") {
    if (
      typeof candidate.deviceSecret !== "string" ||
      !DEVICE_SECRET_PATTERN.test(candidate.deviceSecret) ||
      !isCliStoredPairing(candidate.workspacePairing)
    )
      return false;
    const canonical = candidate as CliIrohAgentCredentials;
    return (
      canonical.url === workspacePairingUrl(canonical.workspaceName, canonical.workspacePairing)
    );
  }
  if (candidate.transport !== "local") return false;
  return (
    candidate.deviceSecret === undefined &&
    candidate.workspacePairing === undefined &&
    isDirectWorkspaceUrl(candidate.url!, candidate.workspaceName!)
  );
}

export function isCliCredentials(value: unknown): value is CliCredentials {
  return isCliDeviceCredentials(value) || isCliAgentCredentials(value);
}

export function isCliAccountDeviceCredentials(
  value: unknown
): value is CliAccountDeviceCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CliAccountDeviceCredentialsBase> & {
    transport?: unknown;
    serverId?: unknown;
    deviceSecret?: unknown;
    controlPairing?: unknown;
  };
  const keys = new Set([
    "schemaVersion",
    "kind",
    "phase",
    "url",
    "deviceId",
    "refreshToken",
    "pairedAt",
    "transport",
  ]);
  if (candidate.transport === "local") keys.add("serverId");
  else {
    keys.add("deviceSecret");
    keys.add("controlPairing");
  }
  if (
    Object.keys(value).some((key) => !keys.has(key)) ||
    candidate.schemaVersion !== 6 ||
    candidate.kind !== "device" ||
    candidate.phase !== "account" ||
    !isDeviceId(candidate.deviceId) ||
    !isDeviceRefreshToken(candidate.refreshToken) ||
    !positiveSafeInteger(candidate.pairedAt) ||
    typeof candidate.url !== "string"
  )
    return false;
  if (candidate.transport === "local") {
    try {
      const url = new URL(candidate.url);
      return (
        isServerId(candidate.serverId) &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    } catch {
      return false;
    }
  }
  return (
    candidate.transport === "iroh" &&
    typeof candidate.deviceSecret === "string" &&
    DEVICE_SECRET_PATTERN.test(candidate.deviceSecret) &&
    isCliStoredPairing(candidate.controlPairing) &&
    candidate.url === `iroh://${candidate.controlPairing.endpointId}`
  );
}

export function isCliIdentity(value: unknown): value is CliIdentity {
  return isCliCredentials(value) || isCliAccountDeviceCredentials(value);
}

/** The only old device format accepted is a fully validated routed v5 record. */
export function migrateCliIdentity(value: unknown): CliIdentity | null {
  if (isCliIdentity(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const old = value as Record<string, unknown>;
  if (old["schemaVersion"] !== 5 || old["kind"] !== "device" || "phase" in old) return null;
  const migrated = { ...old, schemaVersion: 6, phase: "workspace" };
  return isCliDeviceCredentials(migrated) ? migrated : null;
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
  return `iroh://${pairing.endpointId}${selectedWorkspacePath(workspaceName)}`;
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
