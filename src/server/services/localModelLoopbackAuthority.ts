import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const LOCAL_MODEL_USE_CAPABILITY = "internal-model-runtime.use";
const LOCAL_MODEL_RESOURCE = "local-models";
const OWNER_SCHEMA_VERSION = 1;

interface LocalModelOwner {
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
  pid: number;
  bootId: string;
  ports: { utility: number; main: number };
  workspaceId: string;
  since: number;
  serverPids: { utility?: number; main?: number };
}

export interface InternalRequestAuthorizationInput {
  caller: VerifiedCaller;
  targetUrl: URL;
  method: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export interface LocalModelLoopbackAuthorityDeps {
  rootDir?: string;
  pidAlive?: (pid: number) => boolean;
}

/**
 * Verifies the dynamic bearer capability minted by the local-model supervisor.
 * Nothing here grants general loopback access: the exact reviewed caller,
 * live endpoint, and in-flight destination credential must all agree.
 */
export class LocalModelLoopbackAuthority {
  private readonly rootDir: string;
  private readonly pidAlive: (pid: number) => boolean;

  constructor(deps: LocalModelLoopbackAuthorityDeps = {}) {
    this.rootDir =
      deps.rootDir ??
      process.env["VIBESTUDIO_LOCAL_MODELS_DIR"] ??
      join(homedir(), ".vibestudio", "local-models");
    this.pidAlive = deps.pidAlive ?? isPidAlive;
  }

  async authorize(input: InternalRequestAuthorizationInput): Promise<boolean> {
    if (!isApprovedAgentModelRuntime(input.caller)) return false;
    if (input.targetUrl.protocol !== "http:" || !isLoopback(input.targetUrl.hostname)) return false;
    if (!input.targetUrl.pathname.startsWith("/v1/")) return false;

    const authorization = readHeader(input.headers, "authorization");
    if (!authorization?.startsWith("Bearer ")) return false;
    const presentedKey = authorization.slice("Bearer ".length);
    if (!presentedKey) return false;

    try {
      const [ownerText, keyText, ownerStat, keyStat] = await Promise.all([
        readFile(join(this.rootDir, "owner.json"), "utf8"),
        readFile(join(this.rootDir, "auth.key"), "utf8"),
        stat(join(this.rootDir, "owner.json")),
        stat(join(this.rootDir, "auth.key")),
      ]);
      if (!ownerStat.isFile() || !keyStat.isFile()) return false;
      const owner = parseOwner(ownerText);
      if (!owner || !this.pidAlive(owner.pid)) return false;

      const port = Number(input.targetUrl.port || "80");
      const serverKind =
        owner.ports.utility === port ? "utility" : owner.ports.main === port ? "main" : null;
      if (!serverKind) return false;
      const serverPid = owner.serverPids[serverKind];
      if (!serverPid || !this.pidAlive(serverPid)) return false;

      const expectedKey = keyText.trim();
      return expectedKey.length > 0 && constantTimeStringEqual(presentedKey, expectedKey);
    } catch {
      return false;
    }
  }
}

function isApprovedAgentModelRuntime(caller: VerifiedCaller): boolean {
  const code = caller.code;
  if (
    caller.codeApproved !== true ||
    !code ||
    code.callerId !== caller.runtime.id ||
    code.callerKind !== caller.runtime.kind ||
    !code.executionDigest
  ) {
    return false;
  }
  return Boolean(
    code.requested?.some(
      (request) =>
        request.capability === LOCAL_MODEL_USE_CAPABILITY &&
        ((request.resource.kind === "exact" && request.resource.key === LOCAL_MODEL_RESOURCE) ||
          (request.resource.kind === "prefix" &&
            LOCAL_MODEL_RESOURCE.startsWith(request.resource.prefix)))
    )
  );
}

function parseOwner(text: string): LocalModelOwner | null {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "pid",
    "bootId",
    "ports",
    "workspaceId",
    "since",
    "serverPids",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (record["schemaVersion"] !== OWNER_SCHEMA_VERSION) return null;
  if (!isPositiveInteger(record["pid"]) || typeof record["bootId"] !== "string") return null;
  if (typeof record["workspaceId"] !== "string" || typeof record["since"] !== "number") return null;
  const ports = parsePorts(record["ports"]);
  const serverPids = parseServerPids(record["serverPids"]);
  if (!ports || !serverPids) return null;
  return {
    schemaVersion: OWNER_SCHEMA_VERSION,
    pid: record["pid"],
    bootId: record["bootId"],
    ports,
    workspaceId: record["workspaceId"],
    since: record["since"],
    serverPids,
  };
}

function parsePorts(value: unknown): LocalModelOwner["ports"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "utility" && key !== "main")) return null;
  if (!isPort(record["utility"]) || !isPort(record["main"])) return null;
  return { utility: record["utility"], main: record["main"] };
}

function parseServerPids(value: unknown): LocalModelOwner["serverPids"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "utility" && key !== "main")) return null;
  if (record["utility"] !== undefined && !isPositiveInteger(record["utility"])) return null;
  if (record["main"] !== undefined && !isPositiveInteger(record["main"])) return null;
  return {
    ...(typeof record["utility"] === "number" ? { utility: record["utility"] } : {}),
    ...(typeof record["main"] === "number" ? { main: record["main"] } : {}),
  };
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function readHeader(
  headers: InternalRequestAuthorizationInput["headers"],
  name: string
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() ?? null;
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
