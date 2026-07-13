/**
 * HeadlessHostManager — spawns the standalone headless Chromium panel host
 * (apps/headless-host) on demand, making it the renderer of last resort: when
 * a worker/agent needs a panel hosted and no CDP-capable client is connected,
 * the manager forks the host, waits for it to register, and the caller
 * retries lease assignment.
 *
 * The shell token is delivered over the fork IPC channel (never via
 * env/argv). Idle shutdown: when the spawned host holds zero leases for
 * idleShutdownMs, it gets SIGTERM (the host also self-exits via its own
 * idle-exit backstop). Crash backoff: respawn only on next demand, with
 * exponential delay; hard-disable after repeated failures.
 */
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import type { ClientSession } from "@vibestudio/shared/panel/panelLease";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";

const log = createDevLogger("HeadlessHostManager");

const HEADLESS_HOST_CALLER_ID = "headless-host";

interface HeadlessHostChildMessage {
  type?: unknown;
  clientSessionId?: unknown;
  diagnostic?: unknown;
}

interface HeadlessHostBridgeDiagnostic {
  state?: string;
  attempt?: number;
  url?: string;
  opened?: boolean;
  authSent?: boolean;
  authenticated?: boolean;
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
  /** Test seam. */
  spawnFn?: (entryPath: string) => ChildProcess;
  /** Test seam for POSIX process-group signaling. */
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

function defaultEntryPath(): string {
  const override = process.env["VIBESTUDIO_HEADLESS_HOST_ENTRY"];
  if (override) return override;

  const baseDirs = new Set<string>();
  const addDir = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) baseDirs.add(path.resolve(value));
  };
  addDir(typeof __dirname === "string" ? __dirname : undefined);
  addDir(
    typeof require === "function" && typeof require.main?.filename === "string"
      ? path.dirname(require.main.filename)
      : undefined
  );
  addDir(process.argv[1] ? path.dirname(process.argv[1]) : undefined);
  addDir(process.cwd());

  const candidates: string[] = [];
  for (const base of baseDirs) {
    candidates.push(
      // Root build copies the bundle here; from dist/server.mjs, base is dist/.
      path.resolve(base, "headless-host", "main.js"),
      // Repo root layout after a root build.
      path.resolve(base, "dist", "headless-host", "main.js"),
      // Source/dev layout from repo root, dist, or src/server.
      path.resolve(base, "apps", "headless-host", "dist", "main.js"),
      path.resolve(base, "..", "apps", "headless-host", "dist", "main.js"),
      path.resolve(base, "..", "..", "apps", "headless-host", "dist", "main.js")
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), "dist", "headless-host", "main.js");
}

function parseBridgeDiagnostic(value: unknown): HeadlessHostBridgeDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const diagnostic: HeadlessHostBridgeDiagnostic = {};
  if (typeof record["state"] === "string") diagnostic.state = record["state"];
  if (typeof record["attempt"] === "number") diagnostic.attempt = record["attempt"];
  if (typeof record["url"] === "string") diagnostic.url = record["url"];
  if (typeof record["opened"] === "boolean") diagnostic.opened = record["opened"];
  if (typeof record["authSent"] === "boolean") diagnostic.authSent = record["authSent"];
  if (typeof record["authenticated"] === "boolean")
    diagnostic.authenticated = record["authenticated"];
  if (typeof record["lastError"] === "string") diagnostic.lastError = record["lastError"];
  if (typeof record["lastCloseCode"] === "number")
    diagnostic.lastCloseCode = record["lastCloseCode"];
  if (typeof record["lastCloseReason"] === "string")
    diagnostic.lastCloseReason = record["lastCloseReason"];
  if (typeof record["lastMessageType"] === "string")
    diagnostic.lastMessageType = record["lastMessageType"];
  if (typeof record["nextRetryMs"] === "number") diagnostic.nextRetryMs = record["nextRetryMs"];
  return diagnostic;
}

function formatBridgeDiagnostic(diagnostic: HeadlessHostBridgeDiagnostic): string {
  const parts = [`state=${diagnostic.state ?? "unknown"}`, `attempt=${diagnostic.attempt ?? 0}`];
  if (diagnostic.url) parts.push(`url=${diagnostic.url}`);
  parts.push(`opened=${diagnostic.opened === true ? "yes" : "no"}`);
  parts.push(`authSent=${diagnostic.authSent === true ? "yes" : "no"}`);
  parts.push(`authenticated=${diagnostic.authenticated === true ? "yes" : "no"}`);
  if (diagnostic.lastMessageType) parts.push(`lastMessage=${diagnostic.lastMessageType}`);
  if (diagnostic.lastCloseCode !== undefined) parts.push(`closeCode=${diagnostic.lastCloseCode}`);
  if (diagnostic.lastCloseReason) parts.push(`closeReason=${diagnostic.lastCloseReason}`);
  if (diagnostic.lastError) parts.push(`error=${diagnostic.lastError}`);
  if (diagnostic.nextRetryMs !== undefined) parts.push(`nextRetryMs=${diagnostic.nextRetryMs}`);
  return parts.join(" ");
}

export class HeadlessHostManager {
  private child: ChildProcess | null = null;
  private spawnInFlight: Promise<ClientSession | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.scheduleEnsure();
  }

  private scheduleEnsure(delayMs = 0): void {
    if (!this.keepAlive || this.stopped || this.disabled) return;
    if (this.respawnTimer) return;
    this.respawnTimer = setTimeout(
      () => {
        this.respawnTimer = null;
        if (!this.keepAlive || this.stopped) return;
        // ensureDefaultHost is single-flight, backoff-aware, and never throws.
        void this.ensureDefaultHost().then((host) => {
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

  /**
   * Ensure a default CDP host exists, spawning the headless host if needed.
   * Single-flight; returns null when disabled, backing off, or timed out.
   */
  async ensureDefaultHost(timeoutMs?: number): Promise<ClientSession | null> {
    const existing = this.availableDefaultHost();
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    this.terminateChild("manager stopping");
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async spawnAndWait(timeoutMs?: number): Promise<ClientSession | null> {
    const entryPath = this.config.entryPath ?? defaultEntryPath();
    if (!fs.existsSync(entryPath) && !this.deps.spawnFn) {
      log.warn(`headless host entry not found at ${entryPath} — build apps/headless-host first`);
      this.recordFailure();
      return null;
    }
    const registrationTimeout = timeoutMs ?? this.config.spawnTimeoutMs ?? 45_000;
    log.info(`spawning headless host (${entryPath})`);

    let child: ChildProcess;
    try {
      child =
        this.deps.spawnFn?.(entryPath) ??
        fork(entryPath, [], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          // Give the host and the Chromium it spawns their own process group.
          // The manager can then terminate the whole renderer tree on shutdown
          // instead of orphaning Chromium under the user service manager.
          detached: process.platform !== "win32",
        });
    } catch (error) {
      log.warn(`headless host spawn failed: ${String(error)}`);
      this.recordFailure();
      return null;
    }
    this.child = child;
    let childReportedRegistered = false;
    let childReportedReady = false;
    let reportedClientSessionId: string | null = null;
    let lastBridgeDiagnostic: HeadlessHostBridgeDiagnostic | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      log.info(`[host] ${String(chunk).trimEnd()}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log.warn(`[host] ${String(chunk).trimEnd()}`);
    });
    child.once("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.spawnedClientSessionId = null;
      }
      log.info(`headless host exited (code ${code})`);
      // Keep-alive: a host we intend to always run just died — bring it back
      // (unless the manager is stopping). Backoff-respecting via scheduleEnsure.
      if (this.keepAlive && !this.stopped) this.scheduleEnsure(250);
    });
    child.on("message", (message: HeadlessHostChildMessage) => {
      if (message?.type !== "registered" && message?.type !== "ready" && message?.type !== "bridge")
        return;
      if (typeof message.clientSessionId === "string") {
        reportedClientSessionId = message.clientSessionId;
      }
      if (message.type === "bridge") {
        const diagnostic = parseBridgeDiagnostic(message.diagnostic);
        if (!diagnostic) return;
        lastBridgeDiagnostic = diagnostic;
        log.info(`headless host bridge ${formatBridgeDiagnostic(diagnostic)}`);
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

    const registrationDeadline = Date.now() + registrationTimeout;
    while (child.exitCode === null) {
      const host = this.availableDefaultHost();
      if (host) {
        this.consecutiveFailures = 0;
        this.spawnedClientSessionId = host.clientSessionId;
        this.updateIdleTimer();
        log.info(`headless host registered as ${host.clientSessionId}`);
        return host;
      }
      if (!childReportedRegistered && Date.now() >= registrationDeadline) {
        log.warn("headless host did not register with the server in time");
        this.terminateChild("registration timeout");
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
    if (this.keepAlive) return;
    if (!this.child || !this.spawnedClientSessionId) return;
    const sessionId = this.spawnedClientSessionId;
    const holdsLeases = this.deps.coordinator
      .getSnapshot()
      .leases.some((lease) => lease.clientSessionId === sessionId);
    if (holdsLeases) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer) return;
    const idleMs = this.config.idleShutdownMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const stillIdle = !this.deps.coordinator
        .getSnapshot()
        .leases.some((lease) => lease.clientSessionId === sessionId);
      if (stillIdle) this.terminateChild("idle shutdown");
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private terminateChild(reason: string): void {
    if (!this.child) return;
    log.info(`terminating headless host: ${reason}`);
    const child = this.child;
    this.child = null;
    this.spawnedClientSessionId = null;
    this.signalChildTree(child, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) this.signalChildTree(child, "SIGKILL");
    }, 5_000);
    killTimer.unref?.();
  }

  private signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (typeof child.pid === "number" && this.deps.signalProcessGroup) {
      try {
        this.deps.signalProcessGroup(child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        log.warn(`failed to signal headless host process group ${child.pid}: ${String(error)}`);
      }
    }
    if (process.platform !== "win32" && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        log.warn(`failed to signal headless host process group ${child.pid}: ${String(error)}`);
      }
    }
    child.kill(signal);
  }
}
