import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import { cliConfigRoot } from "./configPaths.js";

export type CliStoredPairing = Omit<ConnectPairing, "code">;

export interface CliHubCredential {
  url: string;
  deviceId: string;
  refreshToken: string;
  pairing?: CliStoredPairing;
  pairedAt?: number;
}

export interface CliCredentials {
  schemaVersion: 1;
  kind: "device";
  url: string;
  hubUrl?: string;
  workspaceName?: string;
  deviceId: string;
  refreshToken: string;
  pairing?: CliStoredPairing;
  pairedAt?: number;
  hubCredential?: CliHubCredential;
}

export function credentialPath(): string {
  // Honor XDG_CONFIG_HOME so the CLI, remote-doctor, and remote-setup-signaling
  // all agree on the config dir (otherwise a split-brain: doctor writes to
  // $XDG_CONFIG_HOME while this store reads ~/.config).
  return path.join(cliConfigRoot(), "cli-credentials.json");
}

export function loadCliCredentials(): CliCredentials | null {
  const p = credentialPath();
  if (!fs.existsSync(p)) return null;
  let parsed: Partial<CliCredentials>;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<CliCredentials>;
  } catch {
    // The file EXISTS but is unreadable/corrupt — surface it rather than silently
    // reporting "not paired", which sends the user down a re-pair path blind.
    console.warn(
      `[vibestudio] credential file exists but is not valid JSON: ${p}\n` +
        `             delete it and re-pair, or restore a good copy.`
    );
    return null;
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "device" ||
    typeof parsed.url !== "string" ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    (parsed.pairing !== undefined && !isStoredPairing(parsed.pairing)) ||
    (parsed.hubCredential !== undefined && !isHubCredential(parsed.hubCredential))
  ) {
    console.warn(
      `[vibestudio] credential file exists but failed validation: ${p}\n` +
        `             it is malformed or from an incompatible version — re-pair to regenerate it.`
    );
    return null;
  }
  return parsed as CliCredentials;
}

export function saveCliCredentials(creds: CliCredentials): void {
  const p = credentialPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function clearCliCredentials(): void {
  const p = credentialPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function isWebRtcCredential(
  creds: Pick<CliCredentials, "pairing"> | null | undefined
): creds is CliCredentials & { pairing: CliStoredPairing } {
  return !!creds?.pairing && isStoredPairing(creds.pairing);
}

function isStoredPairing(value: unknown): value is CliStoredPairing {
  if (!value || typeof value !== "object") return false;
  const pairing = value as Partial<CliStoredPairing>;
  return (
    typeof pairing.room === "string" &&
    typeof pairing.fp === "string" &&
    typeof pairing.sig === "string" &&
    (pairing.v === undefined || typeof pairing.v === "number") &&
    (pairing.ice === undefined || pairing.ice === "all" || pairing.ice === "relay") &&
    (pairing.srv === undefined || typeof pairing.srv === "string")
  );
}

function isHubCredential(value: unknown): value is CliHubCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<CliHubCredential>;
  return (
    typeof credential.url === "string" &&
    typeof credential.deviceId === "string" &&
    typeof credential.refreshToken === "string" &&
    (credential.pairing === undefined || isStoredPairing(credential.pairing)) &&
    (credential.pairedAt === undefined || typeof credential.pairedAt === "number")
  );
}
