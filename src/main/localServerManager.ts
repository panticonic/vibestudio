/**
 * LocalServerManager — attach-or-spawn lifecycle for DETACHED local workspace
 * servers (replaces the deleted ServerProcessManager / Electron utilityProcess
 * child model).
 *
 * The workspace server is a detached OS process that outlives the app. On
 * launch the desktop attaches to a healthy recorded server (validated against
 * `/healthz` — serverId + workspaceId, never the pid alone) and authenticates
 * with the persisted device refresh credential; otherwise it spawns a fresh
 * detached server (ELECTRON_RUN_AS_NODE) and pairs over loopback WS with the
 * startup pairing code from the ready file. Quitting the app merely detaches;
 * stopping the server is an explicit `stop()` (hostLifecycle.shutdown RPC →
 * SIGTERM → SIGKILL). A detached server with no app is unsupervised by design —
 * the server's own idle-exit and stale-record cleanup on next launch cover it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import type { WorkspaceEntry } from "@vibestudio/shared/types";
import { getEsbuildBinaryPath, getServerProcessEntryPath } from "./paths.js";
import {
  clearLocalServerCredential,
  loadLocalServerCredential,
  saveLocalServerCredential,
  type LocalServerCredential,
} from "./services/localServerCredStore.js";

const log = createDevLogger("LocalServerManager");

const READY_POLL_INTERVAL_MS = 250;
const READY_TIMEOUT_MS = 120_000;
const HEALTHZ_TIMEOUT_MS = 1_500;
const STOP_SIGTERM_TIMEOUT_MS = 12_000;

type LocalServerRecord = NonNullable<WorkspaceEntry["localServer"]>;

export interface LocalServerManagerConfig {
  /** Managed workspace root directory (contains source/ and state/) */
  wsDir: string;
  workspaceName: string;
  workspaceId: string;
  appRoot: string;
  /** Current app build version — a running server on another version is stopped and respawned. */
  appVersion: string;
  isEphemeral?: boolean;
  autoApproveStartupUnits?: boolean;
  logLevel?: string;
  centralData: CentralDataManager;
  /** Called when the server died and could not be respawned (restart throttle exceeded). */
  onCrash: (code: number | null) => void;
}

/** What serverSession needs to open the loopback WS session. */
export interface LocalAttachTarget {
  gatewayPort: number;
  /** Pairing code (fresh spawn) or `refresh:<deviceId>:<token>` (attach). */
  authToken: string;
  serverId: string;
  serverBootId: string;
  /** True when we attached to an already-running server rather than spawning. */
  attached: boolean;
}

interface HealthzPayload {
  ok?: boolean;
  serverId?: string;
  serverBootId?: string;
  workspaceId?: string;
  version?: string;
  pid?: number;
}

interface ReadyFilePayload {
  gatewayPort?: number;
  pairingCode?: string | null;
  serverId?: string;
  serverBootId?: string;
  pid?: number;
  version?: string;
}

async function probeHealthz(gatewayPort: number): Promise<HealthzPayload | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthzPayload;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class LocalServerManager {
  private current: { gatewayPort: number; authToken: string; pid: number } | null = null;
  private restartTimestamps: number[] = [];
  private isStopping = false;
  private ensureAlivePromise: Promise<void> | null = null;

  constructor(private config: LocalServerManagerConfig) {}

  /**
   * Attach to a healthy recorded server or spawn a fresh detached one.
   * Never trusts the recorded pid alone — the record is validated against
   * `/healthz` (serverId + workspaceId), which makes pid reuse and port
   * collisions harmless (an imposter fails the check and we spawn anew).
   */
  async attachOrSpawn(): Promise<LocalAttachTarget> {
    const record = this.config.centralData.getWorkspaceLocalServer(this.config.workspaceName);
    if (record) {
      const target = await this.tryAttach(record);
      if (target) return target;
      // Stale/imposter/version-mismatch: forget the record (and its credential
      // when the server identity is gone) and fall through to a fresh spawn.
      this.config.centralData.clearWorkspaceLocalServer(this.config.workspaceName);
    }
    return this.spawnDetached();
  }

  private async tryAttach(record: LocalServerRecord): Promise<LocalAttachTarget | null> {
    const health = await probeHealthz(record.gatewayPort);
    if (
      !health?.ok ||
      health.serverId !== record.serverId ||
      health.workspaceId !== this.config.workspaceId
    ) {
      log.info(
        `[attach] recorded server at :${record.gatewayPort} is gone or not ours — will spawn`
      );
      clearLocalServerCredential(this.config.workspaceId);
      return null;
    }
    if (health.version !== this.config.appVersion) {
      // Pre-release policy: converge to the current build. Stop the old server
      // and spawn the current one — no prompt, no compatibility window.
      log.info(
        `[attach] version mismatch (server ${health.version ?? "?"} ≠ app ${this.config.appVersion}) — stopping old server`
      );
      await this.terminateByRecord(record, health.pid);
      return null;
    }
    const credential = loadLocalServerCredential(this.config.workspaceId);
    if (!credential || credential.serverId !== record.serverId) {
      // Healthy server but no credential to authenticate with: we cannot pair
      // (the startup pairing code was consumed). Stop it and respawn fresh.
      log.warn("[attach] healthy server but no usable credential — stopping and respawning");
      await this.terminateByRecord(record, health.pid);
      return null;
    }
    this.current = {
      gatewayPort: record.gatewayPort,
      authToken: `refresh:${credential.deviceId}:${credential.refreshToken}`,
      pid: health.pid ?? record.pid,
    };
    log.info(`[attach] reattached to server pid ${this.current.pid} at :${record.gatewayPort}`);
    return {
      gatewayPort: record.gatewayPort,
      authToken: this.current.authToken,
      serverId: record.serverId,
      serverBootId: health.serverBootId ?? record.serverBootId,
      attached: true,
    };
  }

  private async spawnDetached(): Promise<LocalAttachTarget> {
    const bundlePath = getServerProcessEntryPath();
    const esbuildBinaryPath = getEsbuildBinaryPath();
    const stateDir = path.join(this.config.wsDir, "state");
    const readyFile = path.join(stateDir, "server-ready.json");
    const logDir = path.join(stateDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "server.log");
    // Truncate on spawn — stdout no longer flows through the app.
    const logFd = fs.openSync(logFile, "w");
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      /* stale ready file is handled by the freshness check below anyway */
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VIBESTUDIO_FORCE_WORKSPACE_SERVER: "1",
      VIBESTUDIO_WORKSPACE_DIR: this.config.wsDir,
      VIBESTUDIO_APP_ROOT: this.config.appRoot,
      VIBESTUDIO_APP_VERSION: this.config.appVersion,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      ...(this.config.isEphemeral ? { VIBESTUDIO_WORKSPACE_EPHEMERAL: "1" } : {}),
      ...(this.config.autoApproveStartupUnits
        ? { VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1" }
        : {}),
      ...(this.config.logLevel ? { VIBESTUDIO_LOG_LEVEL: this.config.logLevel } : {}),
    };

    // Heap headroom for the server: a single Node process running builds
    // (esbuild), git, and the DO relay hub is tight under V8's default ~2 GB
    // old-space limit. Override with VIBESTUDIO_SERVER_MAX_OLD_SPACE_MB.
    const maxOldSpaceMb = Number(process.env["VIBESTUDIO_SERVER_MAX_OLD_SPACE_MB"]) || 4096;
    const spawnedAt = Date.now();
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${maxOldSpaceMb}`, bundlePath, "--ready-file", readyFile],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        env,
      }
    );
    fs.closeSync(logFd);
    let exitedWith: number | null | undefined;
    child.on("exit", (code) => {
      exitedWith = code;
    });
    child.on("error", (err) => {
      log.warn(`[spawn] child error: ${err.message}`);
      exitedWith = -1;
    });
    child.unref();
    log.info(`[spawn] detached server pid ${child.pid} (log: ${logFile})`);

    const ready = await this.waitForReadyFile(readyFile, spawnedAt, () => exitedWith);
    if (
      typeof ready.gatewayPort !== "number" ||
      typeof ready.serverId !== "string" ||
      typeof ready.serverBootId !== "string" ||
      typeof ready.pairingCode !== "string"
    ) {
      throw new Error("Local server ready file is missing gatewayPort/serverId/pairingCode");
    }
    const pid = ready.pid ?? child.pid ?? 0;
    this.current = { gatewayPort: ready.gatewayPort, authToken: ready.pairingCode, pid };
    this.config.centralData.setWorkspaceLocalServer(this.config.workspaceName, {
      gatewayPort: ready.gatewayPort,
      pid,
      serverId: ready.serverId,
      serverBootId: ready.serverBootId,
      startedAt: spawnedAt,
      version: ready.version ?? this.config.appVersion,
    });
    return {
      gatewayPort: ready.gatewayPort,
      authToken: ready.pairingCode,
      serverId: ready.serverId,
      serverBootId: ready.serverBootId,
      attached: false,
    };
  }

  private async waitForReadyFile(
    readyFile: string,
    spawnedAt: number,
    exitCode: () => number | null | undefined
  ): Promise<ReadyFilePayload> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const exited = exitCode();
      if (exited !== undefined) {
        throw new Error(`Local server exited during startup with code ${exited}`);
      }
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs >= spawnedAt) {
          return JSON.parse(fs.readFileSync(readyFile, "utf8")) as ReadyFilePayload;
        }
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`Local server did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }

  /**
   * Persist the device credential issued when the loopback session paired with
   * the startup pairing code (or rotated an existing credential).
   */
  persistPairedCredential(cred: { deviceId: string; refreshToken: string }): void {
    const record = this.config.centralData.getWorkspaceLocalServer(this.config.workspaceName);
    const credential: LocalServerCredential = {
      deviceId: cred.deviceId,
      refreshToken: cred.refreshToken,
      serverId: record?.serverId ?? "",
      pairedAt: Date.now(),
    };
    saveLocalServerCredential(this.config.workspaceId, credential);
    // Reconnects (and the next launch) authenticate with the refresh credential.
    if (this.current) {
      this.current.authToken = `refresh:${cred.deviceId}:${cred.refreshToken}`;
    }
  }

  /** Current session auth token (refresh credential once paired). */
  getAuthToken(): string {
    const token = this.current?.authToken;
    if (!token) throw new Error("Local server has no auth token (not attached)");
    return token;
  }

  getCurrentGatewayUrl(): string | null {
    return this.current ? serverRpcWsUrl(`http://127.0.0.1:${this.current.gatewayPort}`) : null;
  }

  getGatewayPort(): number | null {
    return this.current?.gatewayPort ?? null;
  }

  /**
   * Supervision (only while the app is attached): call on WS disconnect. Probes
   * the server; if the process is dead, respawns with restart throttling
   * (5 restarts/60s → onCrash). The reconnecting WS client follows the new
   * port/token via getCurrentGatewayUrl/getAuthToken.
   */
  handleDisconnect(): void {
    if (this.isStopping) return;
    this.ensureAlivePromise ??= this.ensureAlive().finally(() => {
      this.ensureAlivePromise = null;
    });
  }

  private async ensureAlive(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const health = await probeHealthz(current.gatewayPort);
    if (health?.ok) return; // transient socket drop — the WS client reconnects
    if (pidAlive(current.pid)) return; // still starting/stopping; let reconnect retry
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < 60_000);
    if (this.restartTimestamps.length >= 5) {
      this.config.onCrash(null);
      return;
    }
    this.restartTimestamps.push(now);
    log.warn("[supervise] server process died — respawning");
    this.config.centralData.clearWorkspaceLocalServer(this.config.workspaceName);
    try {
      await this.spawnDetached();
    } catch (error) {
      log.warn(`[supervise] respawn failed: ${error instanceof Error ? error.message : error}`);
      this.config.onCrash(null);
    }
  }

  /**
   * Explicitly stop the server: graceful RPC shutdown (caller passes the RPC
   * shutdown call when a live client exists) → SIGTERM → timeout SIGKILL.
   * Clears the attachment record and credential.
   */
  async stop(rpcShutdown?: () => Promise<void>): Promise<void> {
    this.isStopping = true;
    const current = this.current;
    this.current = null;
    if (current) {
      let requested = false;
      if (rpcShutdown) {
        try {
          await rpcShutdown();
          requested = true;
        } catch (error) {
          log.warn(
            `[stop] hostLifecycle.shutdown failed, falling back to SIGTERM: ${
              error instanceof Error ? error.message : error
            }`
          );
        }
      }
      await this.waitForExit(current.pid, requested);
    }
    this.config.centralData.clearWorkspaceLocalServer(this.config.workspaceName);
    clearLocalServerCredential(this.config.workspaceId);
  }

  /** Detach without stopping: keep the record so the next launch reattaches. */
  detach(): void {
    this.isStopping = true;
  }

  private async terminateByRecord(record: LocalServerRecord, livePid?: number): Promise<void> {
    // No live RPC client here — best-effort SIGTERM by the healthz-validated
    // pid (fall back to the recorded one).
    await this.waitForExit(livePid ?? record.pid, false);
    this.config.centralData.clearWorkspaceLocalServer(this.config.workspaceName);
    clearLocalServerCredential(this.config.workspaceId);
  }

  private async waitForExit(pid: number, alreadyRequested: boolean): Promise<void> {
    if (!pidAlive(pid)) return;
    if (!alreadyRequested) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }
    const deadline = Date.now() + STOP_SIGTERM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    log.warn(`[stop] server pid ${pid} did not exit after SIGTERM — SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
