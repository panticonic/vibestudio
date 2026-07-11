/**
 * Detached local hub lifecycle.
 *
 * The desktop owns one machine hub process, pairs one global device credential,
 * and asks the hub to route that device into the selected workspace child. It
 * never launches or authenticates a workspace child directly.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { createDevLogger } from "@vibestudio/dev-log";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { serverAuthRouteUrl, serverRpcHttpUrl, serverRpcWsUrl } from "@vibestudio/shared/connect";
import type { CentralDataManager, HubRuntimeRecord } from "@vibestudio/shared/centralData";
import { SERVER_BOOT_ID_PATTERN, SERVER_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import {
  HubReadyPayloadSchema,
  type HubReadyPayload,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import { getEsbuildBinaryPath, getServerProcessEntryPath } from "./paths.js";
import {
  loadDeviceCredentialByServerId,
  loadPendingLoopbackPairing,
  saveDeviceCredential,
  savePendingLoopbackPairing,
  type DeviceCredentialEntry,
} from "./services/deviceCredentialStore.js";

const log = createDevLogger("HubProcessManager");
const READY_POLL_INTERVAL_MS = 250;
const READY_TIMEOUT_MS = 120_000;
const HEALTHZ_TIMEOUT_MS = 1_500;
const HEALTH_RETRY_ATTEMPTS = 3;
const HEALTH_RETRY_INTERVAL_MS = 250;
const STOP_SIGTERM_TIMEOUT_MS = 12_000;

export interface HubProcessManagerConfig {
  workspaceName: string;
  appRoot: string;
  appVersion: string;
  logLevel?: string;
  centralData: CentralDataManager;
  onCrash: (code: number | null) => void;
}

export interface HubWorkspaceTarget {
  gatewayPort: number;
  serverUrl: string;
  wsUrl: string;
  authToken: string;
  deviceId: string;
  refreshToken: string;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
  attached: boolean;
}

const HealthzPayloadSchema = z
  .object({
    ok: z.literal(true),
    mode: z.literal("hub"),
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    gatewayPort: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    version: z.string().min(1),
  })
  .strict();

type HealthzPayload = z.infer<typeof HealthzPayloadSchema>;

export type HubReadyFilePayload = HubReadyPayload;

export function parseHubReadyFile(value: unknown): HubReadyFilePayload {
  const parsed = HubReadyPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Hub ready file does not match the canonical contract: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

interface HubProcessTarget {
  record: HubRuntimeRecord;
  rootInviteCode: string | null;
  rootInviteExpiresAt: number | null;
  attached: boolean;
}

interface RoutedWorkspace {
  workspace?: unknown;
  workspaceId?: unknown;
  serverUrl?: unknown;
  serverBootId?: unknown;
}

async function probeHealthz(gatewayPort: number): Promise<HealthzPayload | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = HealthzPayloadSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function recordedPidIsHub(pid: number): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const readyFlag = command.indexOf("--ready-file");
    const expectedReadyFile = path.join(getCentralDataPath(), "server-auth", "hub-ready.json");
    return (
      command.includes(getServerProcessEntryPath()) &&
      readyFlag >= 0 &&
      command[readyFlag + 1] === expectedReadyFile
    );
  } catch {
    return null;
  }
}

async function postJson(
  url: URL,
  body: Record<string, unknown>,
  authorization?: string
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof payload["error"] === "string"
        ? payload["error"]
        : `${url.pathname} failed with HTTP ${response.status}`
    );
  }
  return payload;
}

export class HubProcessManager {
  private current: HubWorkspaceTarget | null = null;
  private restartTimestamps: number[] = [];
  private isStopping = false;
  private ensureAlivePromise: Promise<void> | null = null;
  /** PIDs proven to be this manager's hub, either by spawn or authenticated health metadata. */
  private verifiedHubPids = new Set<number>();

  constructor(private readonly config: HubProcessManagerConfig) {}

  async attachOrSpawn(): Promise<HubWorkspaceTarget> {
    const existing = this.config.centralData.getHubRuntime();
    let processTarget = existing ? await this.tryAttach(existing) : null;
    if (!processTarget) {
      if (existing) this.config.centralData.clearHubRuntime();
      processTarget = await this.spawnDetached();
    }
    const credential = await this.ensureDeviceCredential(processTarget);
    const target = await this.routeWorkspace(processTarget, credential);
    this.current = target;
    return target;
  }

  private async tryAttach(record: HubRuntimeRecord): Promise<HubProcessTarget | null> {
    let health: HealthzPayload | null = null;
    for (let attempt = 1; attempt <= HEALTH_RETRY_ATTEMPTS; attempt += 1) {
      health = await probeHealthz(record.gatewayPort);
      if (health?.serverId === record.serverId && health.gatewayPort === record.gatewayPort) break;
      if (attempt < HEALTH_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_INTERVAL_MS));
      }
    }
    if (
      !health ||
      health.serverId !== record.serverId ||
      health.gatewayPort !== record.gatewayPort
    ) {
      // A failed probe is not proof of process death. Conclusively retire the
      // recorded writer before the caller is allowed to clear its row/spawn.
      const processIdentity = recordedPidIsHub(record.pid);
      if (processIdentity === true) {
        this.verifiedHubPids.add(record.pid);
        await this.waitForExit(record.pid, false);
      } else if (processIdentity === null && pidAlive(record.pid)) {
        throw new Error(
          `Hub health check failed, but live PID ${record.pid} could not be verified; refusing to terminate an unrelated process`
        );
      }
      return null;
    }
    if (health.pid !== record.pid) {
      throw new Error(
        `Hub health PID ${health.pid} does not match recorded process ${record.pid}; refusing to signal either process`
      );
    }
    this.verifiedHubPids.add(record.pid);
    if (health.version !== this.config.appVersion) {
      log.info(
        `[attach] hub version mismatch (${health.version ?? "?"} != ${this.config.appVersion}); replacing it`
      );
      await this.waitForExit(record.pid, false);
      return null;
    }
    return {
      record: {
        ...record,
        serverBootId: health.serverBootId,
      },
      rootInviteCode: null,
      rootInviteExpiresAt: null,
      attached: true,
    };
  }

  private async spawnDetached(preferredGatewayPort?: number): Promise<HubProcessTarget> {
    const bundlePath = getServerProcessEntryPath();
    const esbuildBinaryPath = getEsbuildBinaryPath();
    const stateDir = path.join(getCentralDataPath(), "server-auth");
    const readyFile = path.join(stateDir, "hub-ready.json");
    const logDir = path.join(getCentralDataPath(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.rmSync(readyFile, { force: true });
    const logFd = fs.openSync(path.join(logDir, "hub.log"), "w");
    const env: Record<string, string | undefined> = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VIBESTUDIO_APP_ROOT: this.config.appRoot,
      VIBESTUDIO_APP_VERSION: this.config.appVersion,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      ...(this.config.logLevel ? { VIBESTUDIO_LOG_LEVEL: this.config.logLevel } : {}),
      VIBESTUDIO_PROCESS_ROLE: undefined,
      VIBESTUDIO_WORKSPACE_DIR: undefined,
      VIBESTUDIO_WORKSPACE: undefined,
      VIBESTUDIO_IDENTITY_DB_PATH: undefined,
      VIBESTUDIO_WORKSPACE_ID: undefined,
      VIBESTUDIO_HUB_URL: undefined,
      VIBESTUDIO_HUB_CONTROL_TOKEN: undefined,
      ...(preferredGatewayPort !== undefined
        ? { VIBESTUDIO_GATEWAY_PORT: String(preferredGatewayPort) }
        : {}),
    };
    const maxOldSpaceMb = Number(process.env["VIBESTUDIO_SERVER_MAX_OLD_SPACE_MB"]) || 4096;
    const spawnedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${maxOldSpaceMb}`,
        bundlePath,
        "--ready-file",
        readyFile,
        "--bootstrap-workspace",
        this.config.workspaceName,
      ],
      { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env }
    );
    fs.closeSync(logFd);
    let exitedWith: number | null | undefined;
    child.on("exit", (code) => {
      exitedWith = code;
    });
    child.on("error", () => {
      exitedWith = -1;
    });
    child.unref();
    if (child.pid) this.verifiedHubPids.add(child.pid);

    let ready: HubReadyFilePayload;
    try {
      ready = parseHubReadyFile(
        await this.waitForReadyFile(readyFile, spawnedAt, () => exitedWith)
      );
      if (!child.pid || ready.pid !== child.pid) {
        throw new Error(
          `Hub ready PID ${ready.pid} does not match spawned process ${child.pid ?? "unknown"}`
        );
      }
      if (exitedWith !== undefined) {
        throw new Error(`Local hub exited during startup with ${exitedWith}`);
      }
    } catch (error) {
      if (exitedWith === undefined && child.pid) {
        await this.waitForExit(child.pid, false);
      }
      fs.rmSync(readyFile, { force: true });
      throw error;
    }
    const record: HubRuntimeRecord = {
      gatewayPort: ready.gatewayPort,
      pid: ready.pid,
      serverId: ready.serverId,
      serverBootId: ready.serverBootId,
      startedAt: spawnedAt,
      version: ready.version,
    };
    this.config.centralData.setHubRuntime(record);
    return {
      record,
      rootInviteCode: ready.rootInvites === null ? null : ready.rootInvites.desktop.code,
      rootInviteExpiresAt: ready.rootInvites === null ? null : ready.rootInvites.desktop.expiresAt,
      attached: false,
    };
  }

  private async ensureDeviceCredential(target: HubProcessTarget): Promise<DeviceCredentialEntry> {
    const existing = loadDeviceCredentialByServerId(target.record.serverId);
    if (existing) return existing;
    let pending = loadPendingLoopbackPairing(target.record.serverId);
    if (!pending) {
      const inviteCode = target.rootInviteCode;
      const expiresAt = target.rootInviteExpiresAt;
      if (!inviteCode || !expiresAt) {
        throw new Error(
          "The local hub already has users but this desktop is not paired. Pair this device from an existing member."
        );
      }
      const preparedAt = Date.now();
      pending = {
        serverId: target.record.serverId,
        transport: "pending-loopback",
        deviceId: `dev_${randomBytes(18).toString("base64url")}`,
        refreshToken: randomBytes(32).toString("base64url"),
        inviteCode,
        expiresAt,
        preparedAt,
        label: `${os.hostname()} desktop`,
      };
      // The clear secret and invite are encrypted+fsynced before the hub can
      // consume the one-time root code. A post-response save failure therefore
      // replays the exact same receipt on the next attach.
      savePendingLoopbackPairing(pending);
    }
    if (pending.expiresAt <= Date.now()) {
      throw new Error("The durable local pairing activation expired before it could complete");
    }
    const baseUrl = `http://127.0.0.1:${target.record.gatewayPort}`;
    const paired = await postJson(serverAuthRouteUrl(baseUrl, "complete-pairing"), {
      code: pending.inviteCode,
      handle: "root",
      displayName: os.userInfo().username || "Root",
      label: pending.label,
      platform: "desktop",
      deviceId: pending.deviceId,
      refreshToken: pending.refreshToken,
    });
    if (
      paired["deviceId"] !== pending.deviceId ||
      paired["refreshToken"] !== pending.refreshToken
    ) {
      throw new Error("Local hub pairing did not replay the prepared device credential");
    }
    const credential: DeviceCredentialEntry = {
      serverId: target.record.serverId,
      deviceId: pending.deviceId,
      refreshToken: pending.refreshToken,
      transport: "loopback",
      label: pending.label,
      pairedAt: Date.now(),
    };
    saveDeviceCredential(credential);
    return credential;
  }

  private async routeWorkspace(
    target: HubProcessTarget,
    credential: DeviceCredentialEntry
  ): Promise<HubWorkspaceTarget> {
    const baseUrl = `http://127.0.0.1:${target.record.gatewayPort}`;
    const session = await postJson(serverAuthRouteUrl(baseUrl, "refresh-shell"), {
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
    });
    if (typeof session["shellToken"] !== "string") {
      throw new Error("Hub refresh returned no shell session token");
    }
    const rpcResponse = await postJson(
      serverRpcHttpUrl(baseUrl),
      {
        method: "hubControl.routeWorkspace",
        args: [{ workspace: this.config.workspaceName }],
      },
      session["shellToken"]
    );
    const routed = rpcResponse["result"] as RoutedWorkspace | undefined;
    if (!routed || typeof routed !== "object") {
      throw new Error("Hub returned no workspace routing result");
    }
    if (typeof routed.serverUrl !== "string" || typeof routed.workspaceId !== "string") {
      throw new Error("Hub returned invalid workspace routing coordinates");
    }
    return {
      gatewayPort: target.record.gatewayPort,
      serverUrl: routed.serverUrl,
      wsUrl: serverRpcWsUrl(routed.serverUrl),
      authToken: `refresh:${credential.deviceId}:${credential.refreshToken}`,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      serverId: target.record.serverId,
      serverBootId:
        typeof routed.serverBootId === "string" ? routed.serverBootId : target.record.serverBootId,
      workspaceId: routed.workspaceId,
      attached: target.attached,
    };
  }

  private async waitForReadyFile(
    readyFile: string,
    spawnedAt: number,
    exitCode: () => number | null | undefined
  ): Promise<unknown> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const exited = exitCode();
      if (exited !== undefined) throw new Error(`Local hub exited during startup with ${exited}`);
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs >= spawnedAt) {
          return JSON.parse(fs.readFileSync(readyFile, "utf8")) as unknown;
        }
      } catch {
        // Not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`Local hub did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }

  getAuthToken(): string {
    if (!this.current) throw new Error("No routed local workspace");
    return this.current.authToken;
  }

  getCurrentWsUrl(): string | null {
    return this.current?.wsUrl ?? null;
  }

  getCurrentServerUrl(): string | null {
    return this.current?.serverUrl ?? null;
  }

  getGatewayPort(): number | null {
    return this.current?.gatewayPort ?? null;
  }

  handleDisconnect(): void {
    if (this.isStopping) return;
    this.ensureAlivePromise ??= this.ensureAlive().finally(() => {
      this.ensureAlivePromise = null;
    });
  }

  private async ensureAlive(): Promise<void> {
    const current = this.current;
    const record = this.config.centralData.getHubRuntime();
    if (!current || !record) return;
    const attached = await this.tryAttach(record);
    if (attached) return;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((at) => now - at < 60_000);
    if (this.restartTimestamps.length >= 5) {
      this.config.onCrash(null);
      return;
    }
    this.restartTimestamps.push(now);
    this.config.centralData.clearHubRuntime();
    try {
      // The desktop session exposes the gateway port to panel and asset
      // consumers. Rebind the replacement hub to that same port so a successful
      // supervised restart is atomic for every consumer, not only RPC reconnects.
      const target = await this.spawnDetached(current.gatewayPort);
      const credential = await this.ensureDeviceCredential(target);
      this.current = await this.routeWorkspace(target, credential);
    } catch (error) {
      log.warn(`[supervise] hub restart failed: ${error instanceof Error ? error.message : error}`);
      this.config.onCrash(null);
    }
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.current = null;
    const record = this.config.centralData.getHubRuntime();
    if (record) await this.waitForExit(record.pid, false);
    this.config.centralData.clearHubRuntime();
  }

  detach(): void {
    this.isStopping = true;
  }

  private async waitForExit(pid: number, alreadyRequested: boolean): Promise<void> {
    if (!this.verifiedHubPids.has(pid)) {
      throw new Error(`Refusing to terminate unverified hub PID ${pid}`);
    }
    if (!pidAlive(pid)) return;
    if (!alreadyRequested) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
    }
    const deadline = Date.now() + STOP_SIGTERM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline) {
      if (!pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (pidAlive(pid)) {
      throw new Error(`Hub process ${pid} did not exit after SIGKILL`);
    }
    this.verifiedHubPids.delete(pid);
  }
}
