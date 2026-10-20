/**
 * HeadlessHostManager — spawns the standalone headless Chromium panel host
 * (packages/headless-renderer) on demand, making it the renderer of last resort: when
 * a worker/agent needs a panel hosted and no CDP-capable client is connected,
 * the manager forks the host, waits for it to register, and the caller
 * retries lease assignment.
 *
 * The shell token is delivered over the fork IPC channel (never via
 * env/argv). Idle shutdown: when the spawned host holds zero leases for
 * idleShutdownMs, it is retired gracefully (SIGTERM, then whatever its group
 * still holds once the host has exited; the host also self-exits via its own
 * idle-exit backstop). The host and the Chromium it starts form one group owned
 * by the server's ownership, so even a killed server has them reaped. Crash backoff: respawn only on next demand, with
 * exponential delay; hard-disable after repeated failures.
 */
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import type { OwnedProcess, Ownership } from "@vibestudio/shared/ownership";
import type { ClientSession } from "@vibestudio/shared/panel/panelLease";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { resolveRequiredHostArtifactRoot } from "./appRoot.js";

const log = createDevLogger("HeadlessHostManager");

const HEADLESS_HOST_CALLER_ID = "headless-host";

interface HeadlessHostChildMessage {
  type?: unknown;
  clientSessionId?: unknown;
  diagnostic?: unknown;
  error?: unknown;
}

export type HeadlessHostBridgeDiagnosticPhase =
  | "idle"
  | "acquiring-credential"
  | "connecting"
  | "admitted"
  | "closed"
  | "error"
  | "retrying";

export interface HeadlessHostBridgeDiagnostic {
  state?: HeadlessHostBridgeDiagnosticPhase;
  attempt?: number;
  url?: string;
  lastError?: string;
  lastCloseCode?: number;
  lastCloseReason?: string;
  lastMessageType?: string;
  nextRetryMs?: number;
}

export interface HeadlessHostManagerConfig {
  enabled: boolean;
  /** Entry of the built headless host; resolved from the repo by default. */
  entryPath?: string;
  spawnTimeoutMs?: number;
  idleShutdownMs?: number;
  maxRestarts?: number;
  /**
   * Keep a headless host running for the server's whole lifetime: spawn one at
   * boot and re-spawn it whenever the child exits, so a programmatic panel
   * always has a default CDP host to lease to. Disables the idle-shutdown
   * timer (an always-on host must not self-terminate when momentarily idle).
   * Spawn failures still degrade gracefully via the existing backoff — boot
   * never blocks on, or crashes from, an unresolvable Chromium.
   */
  keepAlive?: boolean;
}

export interface HeadlessHostManagerDeps {
  tokenManager: TokenManager;
  coordinator: PanelRuntimeCoordinator;
  isHostAvailable: (hostConnectionId: string) => boolean;
  getServerUrl: () => string;
  config: HeadlessHostManagerConfig;
  /** The server's ownership; opened on first spawn. */
  ownership: () => Promise<Pick<Ownership, "spawn" | "scope">>;
}

export function resolveHeadlessHostEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["VIBESTUDIO_HEADLESS_HOST_ENTRY"];
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error("VIBESTUDIO_HEADLESS_HOST_ENTRY must be an absolute executable path");
    }
    return path.normalize(override);
  }

  // Root builds, source-server prerequisites, packaged desktop builds, and
  // staged npm packages all publish the same artifact beneath the app root.
  // Every launcher pins the exact application root. An operator override is
  // likewise an exact path; the process working directory is never artifact
  // identity.
  return path.resolve(resolveRequiredHostArtifactRoot(env), "headless-host", "main.js");
}

export function parseBridgeDiagnostic(value: unknown): HeadlessHostBridgeDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const diagnostic: HeadlessHostBridgeDiagnostic = {};
  if (isBridgeDiagnosticPhase(record["state"])) diagnostic.state = record["state"];
  if (typeof record["attempt"] === "number") diagnostic.attempt = record["attempt"];
  if (typeof record["url"] === "string") diagnostic.url = record["url"];
  if (typeof record["lastError"] === "string") diagnostic.lastError = record["lastError"];
  if (typeof record["lastCloseCode"] === "number")
    diagnostic.lastCloseCode = record["lastCloseCode"];
  if (typeof record["lastCloseReason"] === "string")
    diagnostic.lastCloseReason = record["lastCloseReason"];
  if (typeof record["lastMessageType"] === "string")
    diagnostic.lastMessageType = record["lastMessageType"];
  if (typeof record["nextRetryMs"] === "number") diagnostic.nextRetryMs = record["nextRetryMs"];
  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
}

function isBridgeDiagnosticPhase(value: unknown): value is HeadlessHostBridgeDiagnosticPhase {
  return (
    value === "idle" ||
    value === "acquiring-credential" ||
    value === "connecting" ||
    value === "admitted" ||
    value === "closed" ||
    value === "error" ||
    value === "retrying"
  );
}

export function formatBridgeDiagnostic(
  diagnostic: HeadlessHostBridgeDiagnostic,
  includeLastMessage = true
): string {
  const parts = [`phase=${diagnostic.state ?? "unknown"}`, `attempt=${diagnostic.attempt ?? 0}`];
  if (diagnostic.url) parts.push(`url=${diagnostic.url}`);
  if (includeLastMessage && diagnostic.lastMessageType) {
    parts.push(`lastMessage=${diagnostic.lastMessageType}`);
  }
  if (diagnostic.lastCloseCode !== undefined) parts.push(`closeCode=${diagnostic.lastCloseCode}`);
  if (diagnostic.lastCloseReason) parts.push(`closeReason=${diagnostic.lastCloseReason}`);
  if (diagnostic.lastError) parts.push(`error=${diagnostic.lastError}`);
  if (diagnostic.nextRetryMs !== undefined) parts.push(`nextRetryMs=${diagnostic.nextRetryMs}`);
  return parts.join(" ");
}

export class HeadlessHostManager {
  private child: ChildProcess | null = null;
  private owned: OwnedProcess | null = null;
  /** The server's ownership scope: every retirement is tracked there, so a failure surfaces when the server closes its ownership. */
  private scope: Pick<Ownership["scope"], "track"> | null = null;
  /** Retirements in flight; `stop()` joins them. */
  private readonly retirements = new Set<Promise<void>>();
  private spawnInFlight: Promise<ClientSession | null> | null = null;
  private idleTimer: {
    handle: ReturnType<typeof setTimeout>;
    child: ChildProcess;
    sessionId: string;
  } | null = null;
  private consecutiveFailures = 0;
  private firstFailureAt = 0;
  private nextAttemptAt = 0;
  private disabled = false;
  private stopLeaseListener: (() => void) | null = null;
  private spawnedClientSessionId: string | null = null;
  private keepAlive = false;
  private stopped = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HeadlessHostManagerDeps) {
    this.stopLeaseListener = deps.coordinator.onLeaseChanged(() => this.updateIdleTimer());
  }

  /**
   * Spawn a headless host now and keep one alive for the server's lifetime:
   * re-ensure it whenever the child exits. Non-blocking and crash-proof —
   * a spawn failure degrades through the existing backoff (callers then fall
   * back to the desktop host), it never rejects or throws into boot.
   */
  startKeepAlive(): void {
    if (!this.config.enabled) return;
    this.keepAlive = true;
    this.clearIdleTimer();
    this.scheduleEnsure();
  }

  private scheduleEnsure(delayMs = 0): void {
    if (!this.keepAlive || this.stopped || this.disabled) return;
    if (this.respawnTimer) return;
    this.respawnTimer = setTimeout(
      () => {
        this.respawnTimer = null;
        if (!this.keepAlive || this.stopped) return;
        // Explicit keep-alive requires a headless renderer even when another
        // CDP-capable client is connected.
        void this.ensureHeadlessHost().then((host) => {
          // If we still don't have a host (disabled, backing off, or timed out)
          // and keep-alive is on, retry on the next backoff window.
          if (!host && this.keepAlive && !this.stopped && !this.disabled) {
            const wait = Math.max(0, this.nextAttemptAt - Date.now()) || 1_000;
            this.scheduleEnsure(wait);
          }
        });
      },
      Math.max(0, delayMs)
    );
    this.respawnTimer.unref?.();
  }

  private get config() {
    return this.deps.config;
  }

  /** A default CDP host that is registered AND bridge-connected, if any. */
  private availableDefaultHost(): ClientSession | null {
    return this.deps.coordinator.getDefaultCdpHostClient({
      isHostAvailable: (id) => this.deps.isHostAvailable(id),
    });
  }

  /** A registered, bridge-connected headless host specifically. */
  private availableHeadlessHost(): ClientSession | null {
    return this.deps.coordinator.getDefaultCdpHostClient({
      isHostAvailable: (id) => this.deps.isHostAvailable(id),
      requiredPlatform: "headless",
    });
  }

  /**
   * Ensure a default CDP host exists, spawning the headless host if needed.
   * Single-flight; returns null when disabled, backing off, or timed out.
   */
  async ensureDefaultHost(timeoutMs?: number): Promise<ClientSession | null> {
    const existing = this.availableDefaultHost();
    if (existing) return existing;
    return this.ensureHeadlessHost(timeoutMs);
  }

  /** Ensure the standalone headless renderer exists even when desktop is connected. */
  async ensureHeadlessHost(timeoutMs?: number): Promise<ClientSession | null> {
    const existing = this.availableHeadlessHost();
    if (existing) return existing;
    if (!this.config.enabled || this.disabled) return null;
    if (Date.now() < this.nextAttemptAt) return null;
    this.spawnInFlight ??= this.spawnAndWait(timeoutMs).finally(() => {
      this.spawnInFlight = null;
    });
    return this.spawnInFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.keepAlive = false;
    this.stopLeaseListener?.();
    this.clearIdleTimer();
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    void this.retireChild("manager stopping").catch(() => undefined);
    // Join every retirement. A failure is reported once, by the server's
    // ownership scope when it closes, with the original error.
    await Promise.allSettled([...this.retirements]);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async spawnAndWait(timeoutMs?: number): Promise<ClientSession | null> {
    const entryPath = this.config.entryPath ?? resolveHeadlessHostEntryPath();
    if (!fs.existsSync(entryPath)) {
      log.warn(
        `headless host entry not found at ${entryPath} — build packages/headless-renderer first`
      );
      this.recordFailure();
      return null;
    }
    const registrationTimeout = timeoutMs ?? this.config.spawnTimeoutMs ?? 45_000;
    log.info(`spawning headless host (${entryPath})`);

    const ownership = await this.deps.ownership();
    this.scope = ownership.scope;
    let owned: OwnedProcess;
    let child: ChildProcess;
    try {
      // The host and the Chromium it spawns form one group, registered with
      // the server's reaper before this call returns, so the whole renderer
      // tree is retired on shutdown (or server death) instead of orphaned.
      // The host closes its browser profile on SIGTERM: graceful.
      owned = ownership.spawn(process.execPath, [...process.execArgv, entryPath], {
        kill: "graceful",
        label: "headless-host",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child = owned.child;
    } catch (error) {
      log.warn(`headless host spawn failed: ${String(error)}`);
      this.recordFailure();
      return null;
    }
    // A child is the physical owner of its idle deadline. A prior process may
    // still deliver its exit event after this replacement is installed, so
    // retire that generation's timer before publishing the new child.
    this.clearIdleTimer();
    this.child = child;
    this.owned = owned;
    let childReportedRegistered = false;
    let childReportedReady = false;
    let reportedClientSessionId: string | null = null;
    let lastBridgeDiagnostic: HeadlessHostBridgeDiagnostic | null = null;
    let startupError: string | null = null;
    let lastLoggedBridgeState: string | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      log.info(`[host] ${String(chunk).trimEnd()}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log.warn(`[host] ${String(chunk).trimEnd()}`);
    });
    child.once("exit", (code) => {
      if (this.child === child) {
        this.clearIdleTimer(child);
        this.child = null;
        this.owned = null;
        this.spawnedClientSessionId = null;
      }
      log.info(`headless host exited (code ${code})`);
      // Chromium is a descendant of the host's group. The host can exit
      // without taking Chromium with it (for example after a crash), so join
      // the group here and respawn a keep-alive host only once it is drained.
      // Explicit stop() already performs this operation; this covers the
      // unexpected-leader-exit path that otherwise leaves Chrome orphaned.
      const drained = this.track(owned.join());
      void drained.then(
        () => {
          // Keep-alive: a host we intend to always run just died — bring it
          // back (unless the manager is stopping). Backoff-respecting.
          if (this.keepAlive && !this.stopped) this.scheduleEnsure(250);
        },
        () => undefined
      );
    });
    child.on("message", (message: HeadlessHostChildMessage) => {
      if (
        message?.type !== "registered" &&
        message?.type !== "ready" &&
        message?.type !== "bridge" &&
        message?.type !== "startup-error"
      )
        return;
      if (message.type === "startup-error") {
        startupError = typeof message.error === "string" ? message.error : "unknown startup error";
        log.warn(`headless host startup failed: ${startupError}`);
        return;
      }
      if (typeof message.clientSessionId === "string") {
        reportedClientSessionId = message.clientSessionId;
      }
      if (message.type === "bridge") {
        const diagnostic = parseBridgeDiagnostic(message.diagnostic);
        if (!diagnostic) return;
        lastBridgeDiagnostic = diagnostic;
        // The host updates lastMessageType for every CDP command. Keep the full
        // diagnostic for timeout/error reporting, but operational logs should
        // describe transport state transitions rather than readiness-poll
        // traffic.
        const bridgeState = formatBridgeDiagnostic(diagnostic, false);
        if (bridgeState !== lastLoggedBridgeState) {
          lastLoggedBridgeState = bridgeState;
          log.info(`headless host bridge ${formatBridgeDiagnostic(diagnostic)}`);
        }
        return;
      }
      childReportedRegistered = true;
      if (message.type === "registered") {
        log.info(
          `headless host registered with server${
            reportedClientSessionId ? ` as ${reportedClientSessionId}` : ""
          }; waiting for CDP bridge`
        );
      } else if (message.type === "ready") {
        childReportedReady = true;
        log.info(
          `headless host reported ready${
            reportedClientSessionId ? ` as ${reportedClientSessionId}` : ""
          }`
        );
      }
    });

    // Token over the IPC channel — not visible in /proc/*/environ or ps.
    const token = this.deps.tokenManager.ensureToken(HEADLESS_HOST_CALLER_ID, "shell");
    child.send({
      type: "init",
      token,
      serverUrl: this.deps.getServerUrl(),
      label: "Headless (server)",
    });

    const readinessDeadline = Date.now() + registrationTimeout;
    while (child.exitCode === null) {
      if (startupError) {
        await this.retireChild("startup failed");
        this.recordFailure();
        return null;
      }
      const host = this.availableHeadlessHost();
      if (host) {
        this.consecutiveFailures = 0;
        this.spawnedClientSessionId = host.clientSessionId;
        this.updateIdleTimer();
        log.info(`headless host registered as ${host.clientSessionId}`);
        return host;
      }
      if (Date.now() >= readinessDeadline) {
        const readiness = childReportedRegistered
          ? `registered but its CDP bridge did not become available${
              lastBridgeDiagnostic ? ` (${formatBridgeDiagnostic(lastBridgeDiagnostic)})` : ""
            }`
          : "did not register with the server";
        log.warn(`headless host ${readiness} in time`);
        await this.retireChild("readiness timeout");
        this.recordFailure();
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (childReportedReady) {
      log.warn(
        `headless host reported ready${
          reportedClientSessionId ? ` as ${reportedClientSessionId}` : ""
        } but exited before the server observed CDP availability`
      );
    } else if (childReportedRegistered) {
      log.warn(
        `headless host registered${
          reportedClientSessionId ? ` as ${reportedClientSessionId}` : ""
        } but exited before CDP became ready${
          lastBridgeDiagnostic ? ` (${formatBridgeDiagnostic(lastBridgeDiagnostic)})` : ""
        }`
      );
    } else {
      log.warn("headless host exited before registering with the server");
    }
    this.recordFailure();
    return null;
  }

  private recordFailure(): void {
    const now = Date.now();
    if (now - this.firstFailureAt > 5 * 60_000) {
      this.firstFailureAt = now;
      this.consecutiveFailures = 0;
    }
    this.consecutiveFailures += 1;
    const maxRestarts = this.config.maxRestarts ?? 3;
    if (this.consecutiveFailures >= maxRestarts) {
      this.disabled = true;
      log.warn(
        `headless host failed ${this.consecutiveFailures} times in 5 minutes — auto-spawn disabled ` +
          `until server restart (run \`vibestudio remote host\` manually or fix the host build)`
      );
      return;
    }
    const delay = Math.min(1_000 * 2 ** (this.consecutiveFailures - 1), 60_000);
    this.nextAttemptAt = now + delay;
  }

  private updateIdleTimer(): void {
    // An always-on host must never idle-terminate.
    if (this.keepAlive) {
      this.clearIdleTimer();
      return;
    }
    const child = this.child;
    const sessionId = this.spawnedClientSessionId;
    if (!child || !sessionId) {
      this.clearIdleTimer();
      return;
    }
    const holdsLeases = this.deps.coordinator
      .getSnapshot()
      .leases.some((lease) => lease.clientSessionId === sessionId);
    if (holdsLeases) {
      this.clearIdleTimer();
      return;
    }
    if (this.idleTimer?.child === child && this.idleTimer.sessionId === sessionId) return;
    this.clearIdleTimer();
    const idleMs = this.config.idleShutdownMs ?? 10 * 60_000;
    const handle = setTimeout(() => {
      const owner = this.idleTimer;
      if (
        owner?.handle !== handle ||
        owner.child !== child ||
        owner.sessionId !== sessionId ||
        this.child !== child ||
        this.spawnedClientSessionId !== sessionId
      ) {
        return;
      }
      this.idleTimer = null;
      const stillIdle = !this.deps.coordinator
        .getSnapshot()
        .leases.some((lease) => lease.clientSessionId === sessionId);
      if (stillIdle) void this.retireChild("idle shutdown").catch(() => undefined);
    }, idleMs);
    this.idleTimer = { handle, child, sessionId };
    handle.unref?.();
  }

  /** Record a retirement with the server's scope (which owns its failure) and with `stop()`. */
  private track(retirement: Promise<void>): Promise<void> {
    this.retirements.add(retirement);
    const tracked = this.scope ? this.scope.track(retirement) : retirement;
    void retirement.then(
      () => this.retirements.delete(retirement),
      () => this.retirements.delete(retirement)
    );
    return tracked;
  }

  private retireChild(reason: string): Promise<void> {
    const owned = this.owned;
    if (!owned || !this.child) return Promise.resolve();
    log.info(`terminating headless host: ${reason}`);
    this.clearIdleTimer(this.child);
    this.child = null;
    this.owned = null;
    this.spawnedClientSessionId = null;
    // Graceful: SIGTERM to the host, then whatever its group still holds once
    // the host has exited. No deadline: the host's exit is the event.
    return this.track(owned.retire());
  }

  private clearIdleTimer(expectedChild?: ChildProcess): void {
    const owner = this.idleTimer;
    if (!owner || (expectedChild && owner.child !== expectedChild)) return;
    clearTimeout(owner.handle);
    this.idleTimer = null;
  }
}
