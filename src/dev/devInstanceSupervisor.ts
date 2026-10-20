import * as fs from "node:fs";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import * as path from "node:path";
import type { ChildProcess, StdioOptions } from "node:child_process";
import type { OwnedProcessIdentity } from "@vibestudio/shared/ownedProcessIdentity";
import type { OwnedProcess, Ownership } from "@vibestudio/shared/ownership";

export interface DevInstanceSupervisorOptions {
  /**
   * The caller's ownership. The child's process group is registered with its
   * reaper in the spawn's own turn, so a caller that dies at any point still
   * has the child retired.
   */
  ownership: Ownership;
  /** Exact materialized source/execution root. Never inferred from process.cwd(). */
  sourceRoot: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  /** Name in the ownership ledger; defaults to the command's basename. */
  label?: string;
  /**
   * When present, readiness belongs to this exact child generation. The file
   * is observation only; callers publish their durable instance-ready record
   * after `onReady` verifies and bootstraps the payload.
   */
  readiness?: {
    file: string;
    onReady(value: unknown): Promise<void>;
  };
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

/**
 * Observe a server's ready-file handoff for one exact child generation. The
 * child's exit before readiness, or the caller's abort, is the authoritative
 * terminal event; there is no deadline.
 */
export async function waitForReady(
  file: string,
  child: ChildProcess,
  signal: AbortSignal
): Promise<unknown> {
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
  private owned: OwnedProcess | null = null;
  private readonly lifetime = new AbortController();
  private readinessWait: Promise<unknown> | null = null;
  private exit: Promise<number> | null = null;
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
    return this.owned?.child ?? null;
  }

  get processIdentity(): OwnedProcessIdentity | null {
    return this.owned?.identity ? { ...this.owned.identity } : null;
  }

  async start(): Promise<void> {
    if (this.owned) throw new Error("DevInstanceSupervisor has already started");
    const sourceRoot = fs.realpathSync(this.options.sourceRoot);
    // Graceful: a stop is the leader's own ordered shutdown, and only what it
    // leaves behind is killed. The owner's reaper runs the same retirement if
    // this process dies, so no lifetime channel is needed between them.
    const owned = this.options.ownership.spawn(this.options.command, [...this.options.args], {
      cwd: sourceRoot,
      env: this.options.env,
      stdio: this.options.stdio ?? "inherit",
      kill: "graceful",
      label: this.options.label ?? path.basename(this.options.command),
    });
    this.owned = owned;
    const child = owned.child;
    this.exit = waitForExit(child);
    // The leader's exit is observed through `this.exit`; a failure to start or
    // to register must surface from start() with its original error.
    this.exit.catch(() => undefined);
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    spawnFailure.catch(() => undefined);
    try {
      if (child.pid === undefined) await spawnFailure;
      await owned.registered;
      if (owned.identity) await this.options.onSpawn?.(owned.identity);
      if (this.options.readiness) {
        this.readinessWait = waitForReady(this.options.readiness.file, child, this.lifetime.signal);
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
      }
      throw error;
    }
  }

  /**
   * The leader's exit status, once the leader exited and everything it left in
   * its process group was retired. Event-driven: the exit and the reaper's
   * retirement are the only things it waits for.
   */
  wait(): Promise<number> {
    if (!this.exit || !this.owned) throw new Error("DevInstanceSupervisor has not started");
    const owned = this.owned;
    this.retirement ??= (async () => {
      const [leader] = await Promise.allSettled([this.exit!]);
      // After the leader's authoritative exit, remaining members are orphaned
      // and are retired by identity.
      const [joined] = await Promise.allSettled([owned.join()]);
      // One failure may surface through both the leader and its registration.
      const failures = [
        ...new Set([
          ...(leader!.status === "rejected" ? [leader!.reason] : []),
          ...(joined!.status === "rejected" ? [joined!.reason] : []),
        ]),
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
    const owned = this.owned;
    if (!owned || !this.exit) return 0;
    const child = owned.child;
    if (signal === "SIGKILL") {
      // An explicit force request can preempt an existing graceful stop. The
      // retained group identity fences PID reuse and joins physical retirement.
      await owned.retire("immediate");
    } else if (
      !this.stopRequested &&
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      this.stopRequested = true;
      const delivered = child.kill(signal);
      if (!delivered && child.exitCode === null && child.signalCode === null) {
        throw new Error(`Could not signal developer instance child ${child.pid ?? "unknown"}`);
      }
    }
    await Promise.allSettled([this.readinessWait]);
    return this.wait();
  }

  /** End this supervisor's scope after its process and persistent state retire. */
  async close(): Promise<void> {
    await this.stop();
  }
}
