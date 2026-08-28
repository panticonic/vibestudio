import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalStoredPairing,
  isCliCredentials,
  isCliStoredPairing,
  type CliAgentCredentials,
  type CliIrohAgentCredentials,
  type CliCredentials,
  type CliDeviceCredentials,
  type CliIrohDeviceCredentials,
  type CliLocalDeviceCredentials,
  type CliStoredPairing,
} from "@vibestudio/shared/cliCredentials";
import { writeFileAtomicSync } from "../atomicFile.js";
import { cliCredentialPath } from "./configPaths.js";

export {
  canonicalStoredPairing,
  type CliAgentCredentials,
  type CliIrohAgentCredentials,
  type CliCredentials,
  type CliDeviceCredentials,
  type CliIrohDeviceCredentials,
  type CliLocalDeviceCredentials,
  type CliStoredPairing,
};

export const credentialPath = cliCredentialPath;

export function loadCliCredentials(filePath: string = credentialPath()): CliCredentials | null {
  const p = path.resolve(filePath);
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
    `[vibestudio] credential file is not a canonical CLI credential: ${p}\n` +
      "             delete it and sign in again, or restore a good copy."
  );
  return null;
}

/** Narrow an ordinary CLI login for human-device lifecycle operations. Agent
 * profiles are workspace principals and must never impersonate a paired device. */
export function requireDeviceCliCredentials(
  credentials: CliCredentials,
  operation: string
): CliDeviceCredentials {
  if (credentials.kind !== "device") {
    throw new Error(
      `${operation} requires a paired human device profile; agent profiles cannot manage device identity`
    );
  }
  return credentials;
}

export function saveCliCredentials(
  creds: CliCredentials,
  filePath: string = credentialPath()
): void {
  if (!isCliCredentials(creds)) {
    throw new Error("Refusing to persist a non-canonical CLI credential");
  }
  const p = path.resolve(filePath);
  if (fs.existsSync(p)) {
    const existing = readCanonicalCredentialForWrite(p);
    if (
      existing.serverId !== creds.serverId ||
      existing.kind !== creds.kind ||
      (existing.kind === "device" &&
        creds.kind === "device" &&
        existing.deviceId !== creds.deviceId) ||
      (existing.kind === "agent" &&
        creds.kind === "agent" &&
        (existing.agentId !== creds.agentId || existing.entityId !== creds.entityId))
    ) {
      throw new Error(
        "Refusing to replace the signed-in CLI identity; run " +
          "`vibestudio remote logout` before using another server or principal"
      );
    }
  }
  writeFileAtomicSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Pairing is an explicit identity transition, not an ordinary credential
 * refresh. Call before redeeming a one-time invite so an existing profile is
 * never silently repointed after the remote server has already created a new
 * device.
 */
export function assertCliProfileIsUnpaired(): void {
  const p = credentialPath();
  if (!fs.existsSync(p)) return;
  readCanonicalCredentialForWrite(p);
  throw new Error(
    "CLI is already paired; run `vibestudio remote logout` before pairing another server or device"
  );
}

export function clearCliCredentials(): void {
  const p = credentialPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function isIrohCredential<T extends { workspacePairing?: unknown }>(
  creds: T | null | undefined
): creds is T & { workspacePairing: CliStoredPairing } {
  return !!creds?.workspacePairing && isCliStoredPairing(creds.workspacePairing);
}

function readCanonicalCredentialForWrite(filePath: string): CliCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(
      `Refusing to replace unreadable CLI credential state at ${filePath}; ` +
        "restore it or run `vibestudio remote logout` first"
    );
  }
  if (!isCliCredentials(parsed)) {
    throw new Error(
      `Refusing to replace non-canonical CLI credential state at ${filePath}; ` +
        "restore it or run `vibestudio remote logout` first"
    );
  }
  return parsed;
}
