import * as fs from "node:fs";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import * as path from "node:path";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { OwnedProcessIdentity } from "./ownedProcessIdentity.js";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import { createOwnedProcessGroupReceiver } from "@vibestudio/shared/ownedProcessRegistration";

export interface DevInstanceSupervisorOptions {
  /** Exact materialized source/execution root. Never inferred from process.cwd(). */
  sourceRoot: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  /**
   * When present, readiness belongs to this exact child generation. The file
   * is observation only; callers publish their durable instance-ready record
   * after `onReady` verifies and bootstraps the payload.
   */
  readiness?: {
    file: string;
    timeoutMs?: number;
    onReady(value: unknown): Promise<void>;
  };
  /** CLI adapter behavior. Call close() after owned state cleanup to release it. */
  forwardParentSignals?: boolean;
  /** Durable, PID-reuse-resistant identity is available before readiness. */
  onSpawn?(identity: OwnedProcessIdentity): void | Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(signalExitCode(signal));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function waitForReady(
  file: string,
  child: ChildProcess,
  timeoutMs: number | undefined,
  signal: AbortSignal
): Promise<unknown> {
  const startedAt = Date.now();
  for (;;) {
    signal.throwIfAborted();
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const outcome =
        child.signalCode !== null
          ? `on signal ${child.signalCode}`
          : `with code ${child.exitCode ?? 1}`;
      throw new Error(`Vibestudio server exited ${outcome} before publishing readiness`);
    }
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for Vibestudio readiness at ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function forwardSignals(requestStop: (signal: NodeJS.Signals) => Promise<number>): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      // Every cancellation request joins the same owned retirement. Package
      // runners may forward a terminal signal more than once; those deliveries
      // must not create competing force-stop operations inside the child.
      void requestStop(signal).catch((error: unknown) => {
        console.error("[DevInstanceSupervisor] requested shutdown failed", error);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/**
 * One exact child-process owner shared by the source CLI and in-product
 * development orchestration.
 *
 * Instance registration, credentials, and state-root allocation remain with
 * the caller because those are durable policy decisions. This class owns the
 * process, readiness barrier, signal forwarding, and ordered stop/wait only.
 */
export class DevInstanceSupervisor {
  private child: ChildProcess | null = null;
  private readonly lifetime = new AbortController();
  private readinessWait: Promise<unknown> | null = null;
  private stopForwarding: (() => void) | null = null;
  private exit: Promise<number> | null = null;
  private ownedIdentity: OwnedProcessIdentity | null = null;
  private ownedGroup: OwnedProcessGroup | null = null;
  private registeredGroups: ReturnType<typeof createOwnedProcessGroupReceiver> | null = null;
  private stopRequested = false;
  private retirement: Promise<number> | null = null;

  constructor(private readonly options: DevInstanceSupervisorOptions) {
    if (!path.isAbsolute(options.sourceRoot)) {
      throw new Error("DevInstanceSupervisor sourceRoot must be absolute");
    }
    if (!path.isAbsolute(options.command)) {
      throw new Error("DevInstanceSupervisor command must be absolute");
    }
    if (options.readiness && !path.isAbsolute(options.readiness.file)) {
      throw new Error("DevInstanceSupervisor readiness file must be absolute");
    }
  }

  get process(): ChildProcess | null {
    return this.child;
  }

  get processIdentity(): OwnedProcessIdentity | null {
    return this.ownedIdentity ? { ...this.ownedIdentity } : null;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("DevInstanceSupervisor has already started");
    const sourceRoot = fs.realpathSync(this.options.sourceRoot);
    const configuredStdio = this.options.stdio ?? "inherit";
    const stdio: Exclude<StdioOptions, string> =
      typeof configuredStdio === "string"
        ? [configuredStdio, configuredStdio, configuredStdio]
        : [...configuredStdio];
    while (stdio.length < 3) stdio.push("ignore");
    if (!stdio.includes("ipc")) stdio.push("ipc");
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: sourceRoot,
      env: this.options.env,
      // The child owns a detached group, but its lifetime still belongs to
      // this supervisor. Native IPC revokes it even if this owner is killed.
      stdio,
      // The owner is the terminal/server process. Keeping the child out of the
      // terminal process group prevents one Ctrl-C from reaching it twice.
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.exit = waitForExit(child);
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    try {
      if (child.pid === undefined) await spawnFailure;
      this.ownedGroup = OwnedProcessGroup.create(child);
      this.ownedIdentity = this.ownedGroup.identity;
      if (this.options.forwardParentSignals) {
        this.stopForwarding = forwardSignals((signal) => this.stop(signal));
      }
      if (this.ownedIdentity) {
        this.registeredGroups = createOwnedProcessGroupReceiver(
          child,
          this.ownedIdentity,
          (identity) => OwnedProcessGroup.adopt(identity)
        );
      }
      if (this.ownedIdentity) await this.options.onSpawn?.(this.ownedIdentity);
      if (this.options.readiness) {
        this.readinessWait = waitForReady(
          this.options.readiness.file,
          child,
          this.options.readiness.timeoutMs,
          this.lifetime.signal
        );
        const ready = await Promise.race([this.readinessWait, spawnFailure]);
        await this.options.readiness.onReady(ready);
      }
    } catch (error) {
      try {
        await this.stop("SIGTERM");
      } catch (cleanupError) {
        if (cleanupError === error) throw error;
        throw Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Developer instance startup and resource retirement failed",
            { cause: error }
          ),
          { code: "EOWNERSHIP" }
        );
      } finally {
        this.releaseSignalForwarding();
      }
      throw error;
    }
  }

  wait(): Promise<number> {
    if (!this.exit) throw new Error("DevInstanceSupervisor has not started");
    this.retirement ??= (async () => {
      const [leader] = await Promise.allSettled([this.exit!]);
      // Join the exact original group and every acknowledged detached group
      // after authoritative leader exit. Remaining executors are orphaned,
      // so force retirement is warranted without a graceful time budget.
      const results = await Promise.allSettled([
        this.ownedGroup?.retire("SIGKILL"),
        this.registeredGroups?.close(),
      ]);
      const failures = [
        ...(leader!.status === "rejected" ? [leader!.reason] : []),
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ];
      if (failures.length === 1 && leader!.status === "rejected") throw leader!.reason;
      if (failures.length)
        throw Object.assign(
          new AggregateError(failures, "Developer instance resources did not retire", {
            cause: failures[0],
          }),
          { code: "EOWNERSHIP" }
        );
      return (leader as PromiseFulfilledResult<number>).value;
    })();
    return this.retirement;
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    this.lifetime.abort(new Error("Developer instance stopped"));
    if (!this.child || !this.exit) return 0;
    if (signal === "SIGKILL") {
      // An explicit force request can preempt an existing graceful stop. The
      // retained group receipt fences PID reuse and joins physical retirement.
      await this.ownedGroup?.retire("SIGKILL");
    } else if (
      !this.stopRequested &&
      this.child.pid !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.stopRequested = true;
      const delivered = this.child.kill(signal);
      if (!delivered && this.child.exitCode === null && this.child.signalCode === null) {
        throw new Error(`Could not signal developer instance child ${this.child.pid ?? "unknown"}`);
      }
    }
    await Promise.allSettled([this.readinessWait]);
    return this.wait();
  }

  /** End the CLI ownership scope after its process and persistent state retire. */
  async close(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.releaseSignalForwarding();
    }
  }

  private releaseSignalForwarding(): void {
    this.stopForwarding?.();
    this.stopForwarding = null;
  }
}
