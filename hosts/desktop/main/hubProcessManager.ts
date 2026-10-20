/**
 * Detached local hub lifecycle.
 *
 * The desktop owns one machine hub process, pairs one global device credential,
 * and asks the hub to route that device into the selected workspace child. It
 * never launches or authenticates a workspace child directly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { createDevLogger } from "@vibestudio/dev-log";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { createInternalConnectionlessRpcClient as createConnectionlessRpcClient } from "@vibestudio/rpc/internal";
import { serverAuthRouteUrl, serverRpcWsUrl } from "@vibestudio/shared/connect";
import type { CentralDataManager, HubProcessOwnerRecord } from "@vibestudio/shared/centralData";
import { pairLocalCliFromDevice } from "../../../src/cli/localPairing.js";
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
import type { DeviceCredentialEntry } from "./services/deviceCredentialStore.js";
import {
  captureOwnedProcessIdentity,
  type OwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";
import type { OwnedProcess, Ownership } from "@vibestudio/shared/ownership";
import { retireGroup } from "@vibestudio/shared/ownershipLedger";

const log = createDevLogger("HubProcessManager");
const READY_POLL_INTERVAL_MS = 250;

/** The machine hub owns every local workspace child's captured output. */
export function getLocalHubLogPath(): string {
  return path.join(getCentralDataPath(), "logs", "hub.log");
}

function hubStartupFailureDetail(logPath: string, startOffset: number): string | null {
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const offset = Math.max(startOffset, size - 16_000);
      const buffer = Buffer.alloc(Math.max(0, size - offset));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      const tail = buffer.subarray(0, bytesRead).toString("utf8");
      const fatalLines = [...tail.matchAll(/^(?:\[workspace:[^\n]+?\] )?Fatal: (.+)$/gmu)];
      return fatalLines.at(-1)?.[1]?.trim() || null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Presentation can prepare its selected workspace as soon as account routing
 * resolves it; transport-only clients need not open an unused workspace. */
export type InitialWorkspaceResolved = (workspaceId: string, prepare: () => Promise<void>) => void;

/**
 * The local hub's device credential. The OS keystore is reachable only from the
 * Electron main process, so the connection process reads and commits it there.
 */
export interface LocalDeviceCredentials {
  load(serverId: string): Promise<DeviceCredentialEntry | null>;
  save(credential: DeviceCredentialEntry): Promise<void>;
}

export interface HubProcessManagerConfig {
  workspaceName: string | null;
  credentials: LocalDeviceCredentials;
  onInitialWorkspaceResolved?: InitialWorkspaceResolved;
  appRoot: string;
  appVersion: string;
  /** SHA-256 identity of the exact server bundle this desktop will execute. */
  buildId: string;
  logLevel?: string;
  centralData: CentralDataManager;
  onRecoveryFailure: (error: Error) => void;
  /**
   * Owns the hub this manager spawns: the hub's group is registered with the
   * ownership's reaper before it runs, so it is retired (gracefully: the hub
   * holds SQLite state) when the ownership is released or the process that
   * opened it dies. The hub's lifetime is therefore leased to that process.
   * `stopTree()` releases it after retiring the hub.
   */
  ownership: Ownership;
  /** Desktop-only confirmation before reusing a live detached hub. */
  confirmExistingHub?: (owner: HubProcessOwnerRecord) => Promise<"attach" | "replace" | "cancel">;
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
  workspaceName: string;
  initialFocusedWorkspaceId: string;
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

async function probeHealthz(gatewayPort: number, signal: AbortSignal): Promise<HealthzPayload> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, { signal });
  if (!response.ok) throw new Error(`Hub health request returned HTTP ${response.status}`);
  return HealthzPayloadSchema.parse(await response.json());
}

async function postJson(
  url: URL,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
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
  private isStopping = false;
  private ensureAlivePromise: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  /**
   * PIDs proven to be this manager's hub, either by spawn (then `owned` is the
   * library's handle for the group) or authenticated health metadata (a hub
   * someone else started: retired by its exact identity, never by pid alone).
   */
  private verifiedHubs = new Map<
    number,
    { identity: OwnedProcessIdentity | null; owned: OwnedProcess | null }
  >();

  constructor(private readonly config: HubProcessManagerConfig) {}

  async attachOrSpawn(options: { onHubReady?: () => void } = {}): Promise<HubWorkspaceTarget> {
    const existing = this.liveOwner();
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
          this.verifiedHubs.delete(existing.pid);
        }
      } else {
        processTarget = await this.tryAttach(existing);
        if (processTarget && processTarget.record.buildId !== this.config.buildId)
          throw new Error(
            "The existing hub uses a different build. Stop or explicitly replace it before connecting this desktop."
          );
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

  private liveOwner(): HubProcessOwnerRecord | null {
    const owner = this.config.centralData.getHubProcessOwner();
    return owner && this.config.centralData.isHubProcessOwned() ? owner : null;
  }

  private async tryAttach(owner: HubProcessOwnerRecord): Promise<HubProcessTarget | null> {
    if (!this.config.centralData.isHubProcessOwned()) return null;
    const identity =
      process.platform === "linux" || process.platform === "darwin"
        ? captureOwnedProcessIdentity(owner.pid)
        : null;
    const health = await probeHealthz(owner.gatewayPort, this.lifetime.signal);
    if (
      health.serverBootId !== owner.ownerBootId ||
      health.gatewayPort !== owner.gatewayPort ||
      health.pid !== owner.pid
    ) {
      throw new Error(
        `Hub health identity does not match owner ${owner.ownerBootId}; refusing to signal either process`
      );
    }
    this.verifiedHubs.set(owner.pid, { identity, owned: null });
    return {
      record: {
        gatewayPort: health.gatewayPort,
        pid: health.pid,
        serverId: health.serverId,
        serverBootId: health.serverBootId,
        startedAt: owner.acquiredAt,
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
    // Restarts must preserve the failure that caused them. Scope startup
    // diagnostics to this launch so an older fatal error is never attributed
    // to the replacement process.
    const logFd = fs.openSync(logPath, "a", 0o600);
    const logStartOffset = fs.fstatSync(logFd).size;
    const spawnedAt = Date.now();
    fs.writeSync(
      logFd,
      `\n[HubProcessManager] Launch ${new Date(spawnedAt).toISOString()} (gateway ${preferredGatewayPort ?? "automatic"})\n`
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VIBESTUDIO_APP_ROOT: this.config.appRoot,
      ...(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]
        ? { VIBESTUDIO_HOST_ARTIFACT_ROOT: process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] }
        : {}),
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
    // Graceful: the hub holds SQLite state and owns its workspace children, so
    // retirement is SIGTERM, then the hub's exit, then whatever its group
    // still holds. The hub no longer needs an IPC lease to find out its owner
    // is gone: the reaper that registered this group retires it.
    const owned = this.config.ownership.spawn(
      process.execPath,
      [
        `--max-old-space-size=${maxOldSpaceMb}`,
        bundlePath,
        "--ready-file",
        readyFile,
        ...(this.config.workspaceName ? ["--bootstrap-workspace", this.config.workspaceName] : []),
      ],
      {
        kill: "graceful",
        label: "local-hub",
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        env,
      }
    );
    const child = owned.child;
    fs.closeSync(logFd);
    let exitedWith: number | null | undefined;
    let startupFailure: Error | undefined;
    child.on("exit", (code) => {
      exitedWith = code;
      // A hub that died on its own may leave members of its group behind.
      this.config.ownership.scope.track(owned.join());
    });
    child.on("error", (error) => {
      startupFailure = error;
    });
    let ready: HubReadyFilePayload;
    try {
      if (child.pid) {
        this.verifiedHubs.set(child.pid, { identity: owned.identity, owned });
        // Durable with the reaper before the hub is trusted with readiness.
        await owned.registered;
      }
      child.unref();
      ready = parseHubReadyFile(
        await this.waitForReadyFile(
          readyFile,
          spawnedAt,
          () => exitedWith,
          () => startupFailure
        )
      );
      if (!child.pid || ready.pid !== child.pid) {
        throw new Error(
          `Hub ready PID ${ready.pid} does not match spawned process ${child.pid ?? "unknown"}`
        );
      }
      if (startupFailure) throw startupFailure;
      if (exitedWith !== undefined) {
        throw new Error(`Local hub exited during startup with ${exitedWith}`);
      }
    } catch (error) {
      let failure: unknown = error;
      let retired = exitedWith !== undefined;
      if (!retired && child.pid) {
        try {
          await this.terminateVerifiedHub(child.pid);
          retired = true;
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            "Hub startup and process cleanup failed"
          );
        }
      }
      if (retired) fs.rmSync(readyFile, { force: true });
      const detail = hubStartupFailureDetail(logPath, logStartOffset);
      const summary = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`${summary}${detail ? `: ${detail}` : ""} (hub log: ${logPath})`, {
        cause: failure,
      });
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
    const existing = await this.config.credentials.load(target.record.serverId);
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
    const paired = await postJson(
      serverAuthRouteUrl(baseUrl, "complete-pairing"),
      {
        code: inviteCode,
        label,
        platform: "desktop",
      },
      this.lifetime.signal
    );
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
    await this.config.credentials.save(credential);
    return credential;
  }

  private async routeWorkspace(
    target: HubProcessTarget,
    credential: DeviceCredentialEntry
  ): Promise<HubWorkspaceTarget> {
    const baseUrl = `http://127.0.0.1:${target.record.gatewayPort}`;
    const session = await postJson(
      serverAuthRouteUrl(baseUrl, "refresh-shell"),
      {
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
      },
      this.lifetime.signal
    );
    if (typeof session["shellToken"] !== "string") {
      throw new Error("Hub refresh returned no shell session token");
    }
    const rpc = createConnectionlessRpcClient({
      selfId: `shell:${credential.deviceId}`,
      callerKind: "shell",
      serverUrl: baseUrl,
      authToken: session["shellToken"],
      fetch: (input, init) =>
        globalThis.fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([this.lifetime.signal, init.signal])
            : this.lifetime.signal,
        }),
    }).client;
    const hubControl = createTypedServiceClient(
      "hubControl",
      hubControlMethods,
      (service, method, args) => rpc.call("main", `${service}.${method}`, args)
    );
    let workspace: z.infer<typeof HubWorkspaceEntrySchema> | undefined;
    if (this.config.workspaceName) {
      const visible = await hubControl.listWorkspaces();
      const selected = visible.find((entry) => entry.name === this.config.workspaceName);
      if (!selected) {
        throw new Error(`Workspace "${this.config.workspaceName}" is not visible to this device`);
      }
      workspace = selected;
    }
    // Native application source belongs to the user's designated System.
    // The requested project is a focus target, never a replacement client app.
    const { personal, system } = await hubControl.ensureUserWorkspaces();
    workspace ??= personal;
    const initialWorkspaceId = workspace.workspaceId;
    if (initialWorkspaceId !== system.workspaceId) {
      this.config.onInitialWorkspaceResolved?.(initialWorkspaceId, async () => {
        await hubControl.routeWorkspace({ workspaceId: initialWorkspaceId });
      });
    }
    const routed = await hubControl.routeWorkspace({ workspaceId: system.workspaceId });
    if (routed.workspaceId !== system.workspaceId || routed.workspace !== system.name) {
      throw new Error("Hub routed a different workspace than the designated System");
    }
    if (process.env["VIBESTUDIO_INSTANCE_ROOT"]?.trim()) {
      await pairLocalCliFromDevice({
        gatewayUrl: baseUrl,
        serverId: target.record.serverId,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
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
      workspaceName: routed.workspace,
      initialFocusedWorkspaceId: workspace.workspaceId,
      attached: target.attached,
    };
  }

  private async waitForReadyFile(
    readyFile: string,
    spawnedAt: number,
    exitCode: () => number | null | undefined,
    failure: () => Error | undefined
  ): Promise<unknown> {
    // The hub owns its workspace child's progress diagnostics and exits when
    // that child cannot start. Waiting here therefore follows process
    // liveness rather than imposing a second, shorter startup deadline that
    // can abandon a healthy cold build.
    for (;;) {
      this.lifetime.signal.throwIfAborted();
      const startupFailure = failure();
      if (startupFailure) throw startupFailure;
      const exited = exitCode();
      if (exited !== undefined) throw new Error(`Local hub exited during startup with ${exited}`);
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs >= spawnedAt) {
          return JSON.parse(fs.readFileSync(readyFile, "utf8")) as unknown;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      { deviceId: current.deviceId, refreshToken: current.refreshToken },
      this.lifetime.signal
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

  /** Reconnection joins readiness before issuing admission requests to the workspace. */
  handleDisconnect(): Promise<void> {
    if (this.isStopping) return Promise.resolve();
    this.ensureAlivePromise ??= this.ensureAlive().finally(() => {
      this.ensureAlivePromise = null;
    });
    return this.ensureAlivePromise;
  }

  private async ensureAlive(): Promise<void> {
    const current = this.current;
    if (!current || this.isStopping) return;
    let target: HubProcessTarget | null = null;
    try {
      // The desktop session exposes the gateway port to panel and asset
      // consumers. Rebind the replacement hub to that same port so a successful
      // supervised restart is atomic for every consumer, not only RPC reconnects.
      const owner = this.liveOwner();
      target = owner ? await this.tryAttach(owner) : null;
      // Only an absent ownership lock permits creating a replacement hub.
      target ??= await this.spawnDetached(current.gatewayPort);
      if (target.record.buildId !== this.config.buildId)
        throw new Error(
          "Hub recovery found a different build; refusing to replace a live owner automatically"
        );
      const credential = await this.ensureDeviceCredential(target);
      const routed = await this.routeWorkspace(target, credential);
      if (this.isStopping) {
        if (!target.attached) await this.discardSpawnedHub(target);
        return;
      }
      this.current = routed;
      this.currentHubPid = target.record.pid;
    } catch (error) {
      let failure: unknown = error;
      if (target && !target.attached) {
        try {
          await this.discardSpawnedHub(target);
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            "Hub recovery and replacement cleanup failed"
          );
        }
      }
      log.warn(
        `[supervise] hub recovery failed: ${failure instanceof Error ? failure.message : failure}`
      );
      if (!this.isStopping) {
        const original = failure instanceof Error ? failure : new Error(String(failure));
        this.config.onRecoveryFailure(original);
        throw original;
      }
      if (failure !== error) throw failure;
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
    this.verifiedHubs.delete(target.record.pid);
    if (this.currentHubPid === target.record.pid) this.currentHubPid = null;
  }

  async stop(): Promise<void> {
    await this.stopTree();
  }

  /**
   * Stop the verified detached hub once and return only after its complete
   * owned process tree is gone. Failures retain the receipt and propagate to
   * the caller; elapsed time never releases ownership.
   */
  beginShutdown(): void {
    this.isStopping = true;
    this.lifetime.abort(new Error("Local hub session is shutting down"));
  }

  /**
   * Retire every verified hub, then release the ownership that held it,
   * returning only once all of it is gone. Failures retain their receipts and
   * propagate to the caller with the original cause; elapsed time never
   * releases ownership.
   */
  async stopTree(): Promise<void> {
    this.beginShutdown();
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
    // Keep each verified process receipt until termination is proven. A
    // routing row belonging to a successor never grants us its lifetime.

    const pids = new Set(this.verifiedHubs.keys());
    if (this.currentHubPid !== null) pids.add(this.currentHubPid);
    const failures: unknown[] = [];
    for (const pid of pids) {
      try {
        if (!this.verifiedHubs.has(pid)) {
          throw new Error(`Refusing to terminate unverified hub PID ${pid}`);
        }
        await this.terminateVerifiedHub(pid);
        this.verifiedHubs.delete(pid);
        if (this.currentHubPid === pid) this.currentHubPid = null;
      } catch (error) {
        failures.push(error);
      }
    }
    // The reaper is joined even after a failure: it is what retires whatever
    // the failed retirement left, and its own failures are part of the result.
    try {
      await this.config.ownership.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Local hub shutdown failed");
    this.currentHubPid = null;
  }

  private async terminateVerifiedHub(pid: number): Promise<void> {
    const hub = this.verifiedHubs.get(pid);
    if (!hub) {
      throw new Error(`Refusing to terminate unverified hub PID ${pid}`);
    }
    if (hub.owned) {
      await hub.owned.retire();
      return;
    }
    // A hub this manager only attached to: retire it by its exact identity.
    await retireGroup({
      key: hub.identity ? `${hub.identity.pid}:${hub.identity.startCoordinate}` : String(pid),
      pid,
      identity: hub.identity,
      kill: "graceful",
      label: "attached-local-hub",
    });
  }

  /**
   * Stop managing the hub. The hub's lifetime is leased to the process that
   * owns this manager's ownership, so it is retired when that process closes
   * the ownership or dies; only an attached hub (started by someone else) is
   * left running.
   */
  detach(): void {
    this.beginShutdown();
    this.currentHubPid = null;
  }
}
