import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalStoredPairing,
  isCliIdentity,
  isLegacyCliCredential,
  migrateCliIdentity,
  isCliStoredPairing,
  type CliAgentCredentials,
  type CliIrohAgentCredentials,
  type CliCredentials,
  type CliDeviceCredentials,
  type CliDeviceIdentity,
  type CliIdentity,
  type CliAccountDeviceCredentials,
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
  type CliDeviceIdentity,
  type CliIdentity,
  type CliAccountDeviceCredentials,
  type CliIrohDeviceCredentials,
  type CliLocalDeviceCredentials,
  type CliStoredPairing,
};

export const credentialPath = cliCredentialPath;

function assertNotLegacy(parsed: unknown, filePath: string): void {
  if (isLegacyCliCredential(parsed)) {
    throw new Error(
      `The CLI credential at ${filePath} was paired with an older Vibestudio build and cannot be used. ` +
        "Run `vibestudio remote logout` to remove it, then pair this device again."
    );
  }
}

export function loadCliCredentials(filePath: string = credentialPath()): CliCredentials | null {
  const identity = loadCliIdentity(filePath);
  if (identity?.kind === "device" && identity.phase === "account") {
    throw new Error(
      "This CLI is paired, but no workspace is selected; run `vibestudio remote select Personal` or `vibestudio terminal` to finish opening your account"
    );
  }
  return identity;
}

export function loadCliIdentity(filePath: string = credentialPath()): CliIdentity | null {
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
  assertNotLegacy(parsed, p);
  const identity = migrateCliIdentity(parsed);
  if (identity) {
    if (!isCliIdentity(parsed))
      writeFileAtomicSync(p, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }
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

export function requireDeviceCliIdentity(
  identity: CliIdentity,
  operation: string
): CliDeviceIdentity {
  if (identity.kind !== "device")
    throw new Error(
      `${operation} requires a paired human device profile; agent profiles cannot manage device identity`
    );
  return identity;
}

export function saveCliCredentials(creds: CliIdentity, filePath: string = credentialPath()): void {
  if (!isCliIdentity(creds)) {
    throw new Error("Refusing to persist a non-canonical CLI credential");
  }
  const p = path.resolve(filePath);
  if (fs.existsSync(p)) {
    const existing = readCanonicalCredentialForWrite(p);
    if (
      ("serverId" in existing && "serverId" in creds && existing.serverId !== creds.serverId) ||
      existing.kind !== creds.kind ||
      (existing.kind === "device" &&
        creds.kind === "device" &&
        (existing.deviceId !== creds.deviceId ||
          existing.transport !== creds.transport ||
          (existing.phase === "account" &&
            existing.transport === "iroh" &&
            creds.transport === "iroh" &&
            existing.controlPairing.endpointId !== creds.controlPairing.endpointId))) ||
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
export function assertCliProfileIsUnpaired(filePath: string = credentialPath()): void {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) return;
  readCanonicalCredentialForWrite(p);
  throw new Error(
    "CLI is already paired; run `vibestudio remote logout` before pairing another server or device"
  );
}

/** True when the file holds a credential from an older build; `remote logout`
 * must be able to remove it even though it can no longer be loaded. */
export function hasLegacyCliCredential(filePath: string = credentialPath()): boolean {
  try {
    return isLegacyCliCredential(JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")));
  } catch {
    return false;
  }
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

function readCanonicalCredentialForWrite(filePath: string): CliIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(
      `Refusing to replace unreadable CLI credential state at ${filePath}; ` +
        "restore it or run `vibestudio remote logout` first"
    );
  }
  assertNotLegacy(parsed, filePath);
  const identity = migrateCliIdentity(parsed);
  if (!identity) {
    throw new Error(
      `Refusing to replace non-canonical CLI credential state at ${filePath}; ` +
        "restore it or run `vibestudio remote logout` first"
    );
  }
  return identity;
}
