import * as fs from "node:fs";
import * as path from "node:path";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { CentralDataManager, type HubProcessLeaseRecord } from "@vibestudio/shared/centralData";
import type { CliCredentials } from "./credentialStore.js";

interface HubHealth {
  serverId: string;
  serverBootId: string;
  gatewayPort: number;
  pid: number;
}

export interface LocalHubControlTransport {
  serverUrl: string;
}

export interface LocalHubTransportDeps {
  now?: () => number;
  fetch?: typeof fetch;
  readLease?: () => HubProcessLeaseRecord | null;
}

export function localHubIdentityDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["VIBESTUDIO_IDENTITY_DB_PATH"]?.trim();
  return override || path.join(getCentralDataPath(), "server-auth", "identity.db");
}

function readCanonicalLease(): HubProcessLeaseRecord | null {
  // The hub's identity-path override moves the identity and central-data
  // stores together. Local CLI discovery must read the same lease database or
  // an isolated/dev hub is indistinguishable from an unreachable remote one.
  const databasePath = localHubIdentityDatabasePath();
  if (!fs.existsSync(databasePath)) return null;
  const central = new CentralDataManager({ databasePath });
  try {
    return central.getHubProcessLease();
  } finally {
    central.close();
  }
}

function healthRecord(value: unknown): HubHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record["ok"] === true &&
    record["mode"] === "hub" &&
    typeof record["serverId"] === "string" &&
    typeof record["serverBootId"] === "string" &&
    Number.isInteger(record["gatewayPort"]) &&
    Number.isInteger(record["pid"])
    ? {
        serverId: record["serverId"],
        serverBootId: record["serverBootId"],
        gatewayPort: record["gatewayPort"] as number,
        pid: record["pid"] as number,
      }
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => null);
}

async function resolveLiveLocalHub(
  credentials: CliCredentials,
  deps: LocalHubTransportDeps
): Promise<{
  serverUrl: string;
} | null> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const lease = (deps.readLease ?? readCanonicalLease)();
  if (!lease || lease.expiresAt <= now()) return null;

  const serverUrl = `http://127.0.0.1:${lease.gatewayPort}`;
  let healthResponse: Response;
  try {
    healthResponse = await fetchImpl(new URL("/healthz", serverUrl));
  } catch {
    return null;
  }
  if (!healthResponse.ok) return null;
  const health = healthRecord(await readJson(healthResponse));
  if (
    !health ||
    health.serverId !== credentials.serverId ||
    health.serverBootId !== lease.ownerBootId ||
    health.gatewayPort !== lease.gatewayPort ||
    health.pid !== lease.pid
  ) {
    return null;
  }

  return { serverUrl };
}

/** Resolve the machine control endpoint without touching any workspace runtime. */
export async function resolveLocalHubControlTransport(
  credentials: CliCredentials,
  deps: LocalHubTransportDeps = {}
): Promise<LocalHubControlTransport | null> {
  const live = await resolveLiveLocalHub(credentials, deps);
  return live;
}
