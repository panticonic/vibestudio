import { assertIrohReach, type ConnectPairing, type IrohReach } from "@vibestudio/iroh-transport";
import { isDeviceId, isDeviceRefreshToken } from "@vibestudio/shared/deviceCredentials";

export type FreshShellPairing = ConnectPairing;
export type StoredShellPairing = IrohReach;

export interface ShellCredential {
  deviceId: string;
  refreshToken: string;
}

interface StoredMobileConnectionBase {
  schemaVersion: 5;
  transport: "iroh";
  endpointIdentityId: string;
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

function validText(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

function reach(value: unknown): IrohReach | null {
  try {
    assertIrohReach(value as IrohReach);
    const current = value as IrohReach;
    return { v: 4, endpointId: current.endpointId, relays: [...current.relays] };
  } catch {
    return null;
  }
}

function credential(value: unknown): ShellCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "deviceId,refreshToken") return null;
  return isDeviceId(item["deviceId"]) && isDeviceRefreshToken(item["refreshToken"])
    ? { deviceId: item["deviceId"], refreshToken: item["refreshToken"] }
    : null;
}

export function createPairedMobileConnection(
  deviceCredential: ShellCredential,
  controlPairing: FreshShellPairing,
  selectedWorkspaceId: string,
  endpointIdentityId: string,
  pairedAt = Date.now()
): StoredPairedMobileConnection {
  const currentCredential = credential(deviceCredential);
  const currentReach = reach(controlPairing);
  if (!currentCredential || !currentReach)
    throw new Error("Cannot persist invalid Iroh pairing state");
  if (!validText(selectedWorkspaceId) || !validText(endpointIdentityId, 256)) {
    throw new Error("Cannot persist invalid Iroh mobile identity state");
  }
  return {
    schemaVersion: 5,
    transport: "iroh",
    phase: "paired",
    endpointIdentityId,
    credential: currentCredential,
    controlPairing: currentReach,
    selectedWorkspaceId,
    pairedAt,
  };
}

export function selectMobileConnectionWorkspace(
  connection: StoredMobileConnection,
  selectedWorkspaceId: string
): StoredPairedMobileConnection {
  if (!validText(selectedWorkspaceId)) throw new Error("Invalid workspace identity");
  const { workspacePairing: _removed, ...base } = connection as StoredRoutedMobileConnection;
  return { ...base, phase: "paired", selectedWorkspaceId };
}

export function createRoutedMobileConnection(
  paired: StoredPairedMobileConnection,
  workspacePairing: StoredShellPairing
): StoredRoutedMobileConnection {
  const currentReach = reach(workspacePairing);
  if (!currentReach) throw new Error("Cannot persist an invalid workspace Iroh reach");
  return { ...paired, phase: "routed", workspacePairing: currentReach };
}

export function replaceMobileConnectionCredential(
  connection: StoredMobileConnection,
  nextCredential: ShellCredential
): StoredMobileConnection {
  const current = credential(nextCredential);
  if (!current) throw new Error("Cannot persist an invalid rotated device credential");
  return { ...connection, credential: current };
}

export function parseStoredMobileConnection(
  raw: string | null | undefined
): StoredMobileConnection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value["schemaVersion"] !== 5 || value["transport"] !== "iroh") return null;
    if (value["phase"] !== "paired" && value["phase"] !== "routed") return null;
    const currentCredential = credential(value["credential"]);
    const controlPairing = reach(value["controlPairing"]);
    const workspacePairing = value["phase"] === "routed" ? reach(value["workspacePairing"]) : null;
    if (
      !currentCredential ||
      !controlPairing ||
      (value["phase"] === "routed" && !workspacePairing) ||
      !validText(value["endpointIdentityId"], 256) ||
      !validText(value["selectedWorkspaceId"]) ||
      !Number.isSafeInteger(value["pairedAt"]) ||
      (value["pairedAt"] as number) <= 0
    )
      return null;
    const pairedAt = value["pairedAt"] as number;
    const base = {
      schemaVersion: 5 as const,
      transport: "iroh" as const,
      endpointIdentityId: value["endpointIdentityId"],
      credential: currentCredential,
      controlPairing,
      selectedWorkspaceId: value["selectedWorkspaceId"],
      pairedAt,
    };
    return value["phase"] === "routed"
      ? { ...base, phase: "routed", workspacePairing: workspacePairing! }
      : { ...base, phase: "paired" };
  } catch {
    return null;
  }
}
