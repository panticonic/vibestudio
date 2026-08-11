/**
 * Detached local hub lifecycle.
 *
 * The desktop owns one machine hub process, pairs one global device credential,
 * and asks the hub to route that device into the selected workspace child. It
 * never launches or authenticates a workspace child directly.
 */

import { spawn } from "node:child_process";
import { EPHEMERAL_DEV_WORKSPACE_NAME } from "@vibestudio/workspace-contracts/ephemeral";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { createDevLogger } from "@vibestudio/dev-log";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { createConnectionlessRpcClient } from "@vibestudio/rpc";
import { serverAuthRouteUrl, serverRpcWsUrl } from "@vibestudio/shared/connect";
import type { CentralDataManager, HubProcessLeaseRecord } from "@vibestudio/shared/centralData";
import { bootstrapInstanceCliFromDevice } from "../dev/bootstrapInstanceCli.js";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  isDeviceId,
  isDeviceRefreshToken,
  SERVER_BOOT_ID_PATTERN,
  SERVER_ID_PATTERN,
} from "@vibestudio/shared/deviceCredentials";
import {
  HubReadyPayloadSchema,
  HubWorkspaceEntrySchema,
  hubControlMethods,
  type HubReadyPayload,
} from "@vibestudio/service-schemas/hubControl";
import { getEsbuildBinaryPath, getServerProcessEntryPath } from "./paths.js";
import {
  loadDeviceCredentialByServerId,
  saveDeviceCredential,
  type DeviceCredentialEntry,
} from "./services/deviceCredentialStore.js";
import {
  terminateOwnedProcessTree,
  type ProcessTreeTerminationResult,
} from "../../scripts/owned-process-tree.mjs";

const log = createDevLogger("HubProcessManager");
const READY_POLL_INTERVAL_MS = 250;
const HEALTHZ_TIMEOUT_MS = 1_500;
const HEALTH_RETRY_ATTEMPTS = 3;
const HEALTH_RETRY_INTERVAL_MS = 250;
const STOP_SIGTERM_TIMEOUT_MS = 12_000;
const STOP_RETRY_INTERVAL_MS = 1_000;

/** The detached machine hub owns every local workspace child's captured output. */
export function getLocalHubLogPath(): string {
  return path.join(getCentralDataPath(), "logs", "hub.log");
}

function hubStartupFailureDetail(logPath: string): string | null {
  try {
    const tail = fs.readFileSync(logPath, "utf8").slice(-16_000);
    const fatalLines = [...tail.matchAll(/^Fatal: (.+)$/gmu)];
    return fatalLines.at(-1)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export interface HubProcessManagerConfig {
  workspaceName: string;
  ephemeral: boolean;
  ephemeralLifecycle: "replace" | "resume" | null;
  appRoot: string;
  appVersion: string;
  /** SHA-256 identity of the exact server bundle this desktop will execute. */
  buildId: string;
  logLevel?: string;
  centralData: CentralDataManager;
  onCrash: (code: number | null) => void;
  /** Desktop-only confirmation before reusing a live detached hub. */
  confirmExistingHub?: (lease: HubProcessLeaseRecord) => Promise<"attach" | "replace" | "cancel">;
}

export interface HubWorkspaceTarget {
  gatewayPort: number;
  serverUrl: string;
  wsUrl: string;
  authToken: string;
  deviceId: string;
  refreshToken: string;
  serverId: string;
  /** Stable machine-hub process identity, never the routed child's boot id. */
  hubServerBootId: string;
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
    buildId: z.string().regex(/^[a-f0-9]{64}$/),
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
  record: HubRuntime;
  rootInviteCode: string | null;
  rootInviteExpiresAt: number | null;
  attached: boolean;
}

interface HubRuntime {
  gatewayPort: number;
  pid: number;
  serverId: string;
  serverBootId: string;
  startedAt: number;
  version: string;
  buildId: string;
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
  private currentHubPid: number | null = null;
  /** Consumed once the new dev session owns a freshly established lifecycle. */
  private ephemeralReplacementPending = false;
  private restartTimestamps: number[] = [];
  private isStopping = false;
  private ensureAlivePromise: Promise<void> | null = null;
  /** PIDs proven to be this manager's hub, either by spawn or authenticated health metadata. */
  private verifiedHubPids = new Set<number>();

  constructor(private readonly config: HubProcessManagerConfig) {
    if (config.ephemeral !== (config.ephemeralLifecycle !== null)) {
      throw new Error("Ephemeral workspace mode requires one explicit lifecycle intent");
    }
    if (config.ephemeral && config.workspaceName !== EPHEMERAL_DEV_WORKSPACE_NAME) {
      throw new Error(
        `Ephemeral desktop sessions use the canonical workspace "${EPHEMERAL_DEV_WORKSPACE_NAME}"`
      );
    }
    this.ephemeralReplacementPending = config.ephemeralLifecycle === "replace";
  }

  async attachOrSpawn(options: { onHubReady?: () => void } = {}): Promise<HubWorkspaceTarget> {
    const existing = this.liveLease();
    let processTarget: HubProcessTarget | null = null;
    if (existing) {
      const decision = this.config.confirmExistingHub
        ? await this.config.confirmExistingHub(existing)
        : "attach";
      if (decision === "cancel") throw new Error("Local server connection cancelled");
      if (decision === "replace") {
        const attached = await this.tryAttach(existing);
        if (attached) {
          await this.terminateVerifiedHub(existing.pid);
          this.config.centralData.releaseHubProcessLease(existing.ownerBootId);
          this.verifiedHubPids.delete(existing.pid);
        }
      } else {
        processTarget = await this.tryAttach(existing);
      }
    }
    if (!processTarget) {
      processTarget = await this.spawnDetached();
    }
    this.currentHubPid = processTarget.record.pid;
    try {
      const credential = await this.ensureDeviceCredential(processTarget);
      // Hub process readiness and selected-workspace readiness are distinct
      // lifecycle facts. Routing may coalesce onto a cold workspace child for
      // many seconds; expose the boundary so the desktop does not misleadingly
      // attribute that wait to starting the local server.
      options.onHubReady?.();
      const target = await this.routeWorkspace(processTarget, credential);
      this.current = target;
      return target;
    } catch (error) {
      if (processTarget.attached) {
        // This launch did not create the incumbent. It may still serve other
        // devices or background work, so failed routing only relinquishes our
        // local reference.
        this.detach();
        throw error;
      }
      try {
        await this.discardSpawnedHub(processTarget);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Local workspace routing failed and the newly spawned hub could not be stopped"
        );
      }
      throw error;
    }
  }

  private liveLease(): HubProcessLeaseRecord | null {
    const lease = this.config.centralData.getHubProcessLease();
    return lease && lease.expiresAt > Date.now() ? lease : null;
  }

  private async tryAttach(lease: HubProcessLeaseRecord): Promise<HubProcessTarget | null> {
    let health: HealthzPayload | null = null;
    for (let attempt = 1; attempt <= HEALTH_RETRY_ATTEMPTS; attempt += 1) {
      health = await probeHealthz(lease.gatewayPort);
      if (
        health?.serverBootId === lease.ownerBootId &&
        health.gatewayPort === lease.gatewayPort &&
        health.pid === lease.pid
      ) {
        break;
      }
      if (attempt < HEALTH_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_INTERVAL_MS));
      }
    }
    if (
      !health ||
      health.serverBootId !== lease.ownerBootId ||
      health.gatewayPort !== lease.gatewayPort ||
      health.pid !== lease.pid
    ) {
      if (health) {
        throw new Error(
          `Hub health identity does not match fenced lease ${lease.ownerBootId}; refusing to signal either process`
        );
      }
      // A failed probe is not proof of process death. Conclusively retire the
      // recorded writer before the caller is allowed to clear its row/spawn.
      const processIdentity = recordedPidIsHub(lease.pid);
      if (processIdentity === true) {
        this.verifiedHubPids.add(lease.pid);
        await this.waitForExit(lease.pid, false);
      } else if (processIdentity === null && pidAlive(lease.pid)) {
        throw new Error(
          `Hub health check failed, but live PID ${lease.pid} could not be verified; refusing to terminate an unrelated process`
        );
      }
      return null;
    }
    this.verifiedHubPids.add(lease.pid);
    if (health.buildId !== this.config.buildId) {
      log.info(
        `[attach] hub build mismatch (${health.buildId} != ${this.config.buildId}); replacing it`
      );
      await this.waitForExit(lease.pid, false);
      return null;
    }
    return {
      record: {
        gatewayPort: health.gatewayPort,
        pid: health.pid,
        serverId: health.serverId,
        serverBootId: health.serverBootId,
        startedAt: lease.acquiredAt,
        version: health.version,
        buildId: health.buildId,
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
    const logPath = getLocalHubLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.rmSync(readyFile, { force: true });
    const logFd = fs.openSync(logPath, "w");
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
      VIBESTUDIO_WORKSPACE_CHILD_TOKEN: undefined,
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
        ...(this.config.ephemeral ? ["--ephemeral"] : []),
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
      const detail = hubStartupFailureDetail(logPath);
      if (detail) {
        const summary = error instanceof Error ? error.message : String(error);
        throw new Error(`${summary}: ${detail}`, { cause: error });
      }
      throw error;
    }
    const record: HubRuntime = {
      gatewayPort: ready.gatewayPort,
      pid: ready.pid,
      serverId: ready.serverId,
      serverBootId: ready.serverBootId,
      startedAt: spawnedAt,
      version: ready.version,
      buildId: ready.buildId,
    };
    return {
      record,
      rootInviteCode: ready.rootInvite?.code ?? null,
      rootInviteExpiresAt: ready.rootInvite?.expiresAt ?? null,
      attached: false,
    };
  }

  private async ensureDeviceCredential(target: HubProcessTarget): Promise<DeviceCredentialEntry> {
    const existing = loadDeviceCredentialByServerId(target.record.serverId);
    if (existing) return existing;
    const inviteCode = target.rootInviteCode;
    const expiresAt = target.rootInviteExpiresAt;
    if (!inviteCode || !expiresAt) {
      throw new Error(
        "The local hub already has users but this desktop is not paired. Pair this device from an existing member."
      );
    }
    if (expiresAt <= Date.now()) {
      throw new Error("The local desktop pairing invite expired before it could complete");
    }
    const label = `${os.hostname()} desktop`;
    const baseUrl = `http://127.0.0.1:${target.record.gatewayPort}`;
    const paired = await postJson(serverAuthRouteUrl(baseUrl, "complete-pairing"), {
      code: inviteCode,
      label,
      platform: "desktop",
    });
    if (
      paired["serverId"] !== target.record.serverId ||
      !isDeviceId(paired["deviceId"]) ||
      !isDeviceRefreshToken(paired["refreshToken"])
    ) {
      throw new Error("Local hub pairing returned an invalid device credential");
    }
    const credential: DeviceCredentialEntry = {
      serverId: target.record.serverId,
      deviceId: paired["deviceId"],
      refreshToken: paired["refreshToken"],
      transport: "loopback",
      label,
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
    const rpc = createConnectionlessRpcClient({
      selfId: `shell:${credential.deviceId}`,
      callerKind: "shell",
      serverUrl: baseUrl,
      authToken: session["shellToken"],
      fetch: globalThis.fetch,
    }).client;
    const hubControl = createTypedServiceClient(
      "hubControl",
      hubControlMethods,
      (service, method, args) => rpc.call("main", `${service}.${method}`, args)
    );
    let workspace: z.infer<typeof HubWorkspaceEntrySchema>;
    if (this.config.ephemeral) {
      if (target.attached && this.ephemeralReplacementPending) {
        const visible = await hubControl.listWorkspaces();
        const previous = visible.find((entry) => entry.name === this.config.workspaceName);
        if (previous && previous.ephemeral !== true) {
          throw new Error(
            `Cannot replace persistent workspace "${this.config.workspaceName}" with ephemeral dev`
          );
        }
        if (previous) {
          const deleted = await hubControl.deleteWorkspace({
            workspace: this.config.workspaceName,
          });
          if (!deleted.deleted || deleted.workspaceId !== previous.workspaceId) {
            throw new Error("Hub did not retire the previous ephemeral workspace lifecycle");
          }
          log.info(
            `[ephemeral] Retired previous ${this.config.workspaceName} lifecycle ${previous.workspaceId}`
          );
        }
      }
      workspace = await hubControl.ensureEphemeralWorkspace();
      // The replace intent belongs to this desktop launch, not to every later
      // reconnect. A freshly spawned hub already satisfies it; an attached hub
      // satisfies it after the delete+ensure sequence above.
      this.ephemeralReplacementPending = false;
      if (workspace.name !== this.config.workspaceName || workspace.ephemeral !== true) {
        throw new Error("Hub did not establish the requested ephemeral workspace lifecycle");
      }
    } else {
      const visible = await hubControl.listWorkspaces();
      const selected = visible.find((entry) => entry.name === this.config.workspaceName);
      if (!selected) {
        throw new Error(`Workspace "${this.config.workspaceName}" is not visible to this device`);
      }
      workspace = selected;
    }
    const routed = await hubControl.routeWorkspace({ workspaceId: workspace.workspaceId });
    if (routed.workspaceId !== workspace.workspaceId || routed.workspace !== workspace.name) {
      throw new Error("Hub routed a different workspace than the one requested");
    }
    if (process.env["VIBESTUDIO_INSTANCE_ROOT"]?.trim()) {
      await bootstrapInstanceCliFromDevice({
        gatewayUrl: baseUrl,
        serverId: target.record.serverId,
        workspaceName: routed.workspace,
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
      });
    }
    return {
      gatewayPort: target.record.gatewayPort,
      serverUrl: routed.serverUrl,
      wsUrl: serverRpcWsUrl(routed.serverUrl),
      authToken: `refresh:${credential.deviceId}:${credential.refreshToken}`,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      serverId: target.record.serverId,
      hubServerBootId: target.record.serverBootId,
      workspaceId: routed.workspaceId,
      attached: target.attached,
    };
  }

  private async waitForReadyFile(
    readyFile: string,
    spawnedAt: number,
    exitCode: () => number | null | undefined
  ): Promise<unknown> {
    // The hub owns its workspace child's progress diagnostics and exits when
    // that child cannot start. Waiting here therefore follows process
    // liveness rather than imposing a second, shorter startup deadline that
    // can abandon a healthy cold build.
    for (;;) {
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

  /** Stable hub RPC coordinate; unlike getCurrentServerUrl this never points at a child. */
  getHubWsUrl(): string {
    const current = this.current;
    if (!current) throw new Error("No routed local workspace");
    return serverRpcWsUrl(`http://127.0.0.1:${current.gatewayPort}`);
  }

  /** Refresh the paired desktop's short-lived shell session on the stable hub. */
  async getHubAuthToken(): Promise<string> {
    const current = this.current;
    if (!current) throw new Error("No routed local workspace");
    const response = await postJson(
      serverAuthRouteUrl(`http://127.0.0.1:${current.gatewayPort}`, "refresh-shell"),
      { deviceId: current.deviceId, refreshToken: current.refreshToken }
    );
    const shellToken = response["shellToken"];
    if (typeof shellToken !== "string" || shellToken.length === 0) {
      throw new Error("Hub refresh returned no shell session token");
    }
    return shellToken;
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
    if (!current || this.isStopping) return;
    const lease = this.liveLease();
    const attached = lease ? await this.tryAttach(lease) : null;
    if (attached?.record.serverBootId === current.hubServerBootId) return;
    if (attached) {
      const credential = await this.ensureDeviceCredential(attached);
      const routed = await this.routeWorkspace(attached, credential);
      if (this.isStopping) {
        await this.discardReplacementHub(attached);
        return;
      }
      this.current = routed;
      this.currentHubPid = attached.record.pid;
      return;
    }
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((at) => now - at < 60_000);
    if (this.restartTimestamps.length >= 5) {
      this.config.onCrash(null);
      return;
    }
    this.restartTimestamps.push(now);
    let target: HubProcessTarget | null = null;
    try {
      // The desktop session exposes the gateway port to panel and asset
      // consumers. Rebind the replacement hub to that same port so a successful
      // supervised restart is atomic for every consumer, not only RPC reconnects.
      target = await this.spawnDetached(current.gatewayPort);
      const credential = await this.ensureDeviceCredential(target);
      const routed = await this.routeWorkspace(target, credential);
      if (this.isStopping) {
        await this.discardReplacementHub(target);
        return;
      }
      this.current = routed;
      this.currentHubPid = target.record.pid;
    } catch (error) {
      if (this.isStopping && target) await this.discardReplacementHub(target);
      log.warn(`[supervise] hub restart failed: ${error instanceof Error ? error.message : error}`);
      if (!this.isStopping) this.config.onCrash(null);
    }
  }

  private async discardReplacementHub(target: HubProcessTarget): Promise<void> {
    try {
      await this.discardVerifiedHub(target);
    } catch (error) {
      log.error(
        `[supervise] replacement hub termination deferred: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /** Terminate only a hub returned by this manager's spawn path. */
  private async discardSpawnedHub(target: HubProcessTarget): Promise<void> {
    if (target.attached) throw new Error("Refusing to discard a hub this manager only attached to");
    await this.discardVerifiedHub(target);
  }

  private async discardVerifiedHub(target: HubProcessTarget): Promise<void> {
    this.currentHubPid = target.record.pid;
    await this.terminateVerifiedHub(target.record.pid);
    this.verifiedHubPids.delete(target.record.pid);
    if (this.currentHubPid === target.record.pid) this.currentHubPid = null;
    const lease = this.config.centralData.getHubProcessLease();
    if (lease?.pid === target.record.pid) {
      this.config.centralData.releaseHubProcessLease(lease.ownerBootId);
    }
  }

  async stop(): Promise<void> {
    await this.stopUntilGone();
  }

  /**
   * Stop the verified detached hub once and return only after its complete
   * owned process tree is gone. User-facing shutdown uses stopUntilGone when
   * it must remain fail-closed across transient termination failures.
   */
  async stopTree(): Promise<ProcessTreeTerminationResult> {
    this.isStopping = true;
    this.current = null;
    const recovery = this.ensureAlivePromise;
    if (recovery) {
      await recovery.catch((error) => {
        log.error(
          `[stop] hub recovery ended during shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
    // Keep the PID until termination is proven. A failed SIGKILL must be
    // retryable even after the lease expires; clearing it here would turn a
    // live owned hub into an untracked process.
    const lease = this.config.centralData.getHubProcessLease();
    const pids = new Set(this.verifiedHubPids);
    if (this.currentHubPid !== null) pids.add(this.currentHubPid);
    if (lease) pids.add(lease.pid);
    if (pids.size === 0) return { gone: true, escalated: false };

    let escalated = false;
    for (const pid of pids) {
      if (!this.verifiedHubPids.has(pid)) {
        throw new Error(`Refusing to terminate unverified hub PID ${pid}`);
      }
      if (recordedPidIsHub(pid) === false) {
        if (!pidAlive(pid)) {
          this.verifiedHubPids.delete(pid);
          if (this.currentHubPid === pid) this.currentHubPid = null;
          continue;
        }
        throw new Error(`Refusing to terminate PID ${pid}; it is no longer the verified hub`);
      }
      const result = await this.terminateVerifiedHub(pid);
      escalated ||= result.escalated;
      this.verifiedHubPids.delete(pid);
      if (this.currentHubPid === pid) this.currentHubPid = null;
    }
    this.currentHubPid = null;
    if (lease) this.config.centralData.releaseHubProcessLease(lease.ownerBootId);
    return { gone: true, escalated };
  }

  /**
   * Stop requested by the user. This deliberately has no failure exit: the
   * caller must not be allowed to quit while an owned hub process tree is
   * still alive. A transient signal/identity race is retried until the
   * termination proof succeeds.
   */
  async stopUntilGone(): Promise<ProcessTreeTerminationResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.stopTree();
      } catch (error) {
        attempt += 1;
        log.error(
          `[stop] local hub termination attempt ${attempt} failed; refusing to release it: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_INTERVAL_MS));
      }
    }
  }

  private async terminateVerifiedHub(pid: number): Promise<ProcessTreeTerminationResult> {
    if (!this.verifiedHubPids.has(pid)) {
      throw new Error(`Refusing to terminate unverified hub PID ${pid}`);
    }
    if (recordedPidIsHub(pid) === false) {
      throw new Error(`Refusing to terminate PID ${pid}; it is no longer the verified hub`);
    }
    const result = await terminateOwnedProcessTree(pid, {
      termTimeoutMs: STOP_SIGTERM_TIMEOUT_MS,
      killTimeoutMs: 5_000,
    });
    if (!result.gone) {
      throw new Error(result.detail ?? `Hub process tree ${pid} survived termination`);
    }
    return result;
  }

  detach(): void {
    this.isStopping = true;
    this.currentHubPid = null;
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
