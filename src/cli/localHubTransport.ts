import * as fs from "node:fs";
import * as path from "node:path";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { CentralDataManager, type HubProcessOwnerRecord } from "@vibestudio/shared/centralData";
import type { CliDeviceCredentials } from "./credentialStore.js";

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
  fetch?: typeof fetch;
  readOwner?: () => HubProcessOwnerRecord | null;
}

export function localHubIdentityDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["VIBESTUDIO_IDENTITY_DB_PATH"]?.trim();
  return override || path.join(getCentralDataPath(), "server-auth", "identity.db");
}

function readCanonicalOwner(): HubProcessOwnerRecord | null {
  // The hub's identity-path override moves the identity and central-data
  // stores together. Local CLI discovery must read the same ownership database or
  // an isolated/dev hub is indistinguishable from an unreachable remote one.
  const databasePath = localHubIdentityDatabasePath();
  if (!fs.existsSync(databasePath)) return null;
  const central = new CentralDataManager({ databasePath });
  try {
    return central.getHubProcessOwner();
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
  credentials: CliDeviceCredentials,
  deps: LocalHubTransportDeps
): Promise<{
  serverUrl: string;
} | null> {
  const fetchImpl = deps.fetch ?? fetch;
  const owner = (deps.readOwner ?? readCanonicalOwner)();
  if (!owner) return null;

  const serverUrl = `http://127.0.0.1:${owner.gatewayPort}`;
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
    health.serverBootId !== owner.ownerBootId ||
    health.gatewayPort !== owner.gatewayPort ||
    health.pid !== owner.pid
  ) {
    return null;
  }

  return { serverUrl };
}

/** Resolve the machine control endpoint without touching any workspace runtime. */
export async function resolveLocalHubControlTransport(
  credentials: CliDeviceCredentials,
  deps: LocalHubTransportDeps = {}
): Promise<LocalHubControlTransport | null> {
  // A local profile already names its paired gateway. Workspace selection
  // changes only the path; machine control belongs to that gateway's root.
  // Reading this process's owner record would instead discover the parent host when
  // it manages a separately paired isolated child.
  if (credentials.transport === "local") {
    return { serverUrl: new URL(credentials.url).origin };
  }
  const live = await resolveLiveLocalHub(credentials, deps);
  return live;
}
