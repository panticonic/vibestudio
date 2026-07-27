import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { captureOwnedProcessIdentity, type OwnedProcessIdentity } from "./ownedProcessIdentity.js";

const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

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
  /** CLI adapter behavior. Embedded owners normally leave this false. */
  forwardParentSignals?: boolean;
  /** Grace period before the exact owned process group is killed. */
  stopTimeoutMs?: number;
  /** Durable, PID-reuse-resistant identity is available before readiness. */
  onSpawn?(identity: OwnedProcessIdentity): void | Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + (process.platform === "win32" ? 0 : 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function waitForReady(
  file: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<unknown> {
  const startedAt = Date.now();
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const outcome =
        child.signalCode !== null
          ? `on signal ${child.signalCode}`
          : `with code ${child.exitCode ?? 1}`;
      throw new Error(`Vibestudio server exited ${outcome} before publishing readiness`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for Vibestudio readiness at ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function forwardSignals(child: ChildProcess): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      signalOwnedProcess(child, signal);
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
  private stopForwarding: (() => void) | null = null;
  private exit: Promise<number> | null = null;
  private ownedIdentity: OwnedProcessIdentity | null = null;

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
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: sourceRoot,
      env: this.options.env,
      stdio: this.options.stdio ?? "inherit",
      // The owner is the terminal/server process. Keeping the child out of the
      // terminal process group prevents one Ctrl-C from reaching it twice.
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.exit = waitForExit(child);
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    if (this.options.forwardParentSignals) {
      this.stopForwarding = forwardSignals(child);
    }
    try {
      if (child.pid === undefined) throw new Error("DevInstanceSupervisor child has no PID");
      this.ownedIdentity = captureOwnedProcessIdentity(child.pid);
      await this.options.onSpawn?.(this.ownedIdentity);
      if (this.options.readiness) {
        const ready = await Promise.race([
          waitForReady(
            this.options.readiness.file,
            child,
            this.options.readiness.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
          ),
          spawnFailure,
        ]);
        await this.options.readiness.onReady(ready);
      }
    } catch (error) {
      try {
        await this.stop("SIGTERM");
      } catch (cleanupError) {
        console.warn(
          "[DevInstanceSupervisor] child cleanup after start failure also failed",
          cleanupError
        );
      }
      throw error;
    }
  }

  wait(): Promise<number> {
    if (!this.exit) throw new Error("DevInstanceSupervisor has not started");
    return this.exit.finally(() => {
      this.stopForwarding?.();
      this.stopForwarding = null;
    });
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    if (!this.child || !this.exit) return 0;
    signalOwnedProcess(this.child, signal);
    if (signal === "SIGKILL") return this.wait();

    const timeoutMs = this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      timeout.unref();
    });
    const outcome = await Promise.race([this.wait().then((code) => ({ code })), timedOut]);
    if (timeout) clearTimeout(timeout);
    if (outcome !== "timeout") return outcome.code;

    signalOwnedProcess(this.child, "SIGKILL");
    return this.wait();
  }
}
