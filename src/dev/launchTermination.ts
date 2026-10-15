import * as path from "node:path";
import { spawn, type StdioOptions } from "node:child_process";

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/** The reason a launch was cancelled: the termination request itself. */
export class LaunchTerminated extends Error {
  readonly code = "ECANCELLED";
  constructor(readonly signal: TerminationSignal) {
    super(`Interrupted by ${signal}`);
    this.name = "LaunchTerminated";
  }
}

interface SignalProcess {
  on(signal: TerminationSignal, listener: () => void): unknown;
  off(signal: TerminationSignal, listener: () => void): unknown;
}

/**
 * Termination requests (Ctrl-C, SIGTERM, a terminal hang-up) for one
 * launcher's whole ownership scope.
 *
 * Node's default action for these signals ends the process at once, skipping
 * the `finally` that stops and joins owned children and removes owned state.
 * Listening replaces that default for as long as the launcher owns anything:
 * the first request aborts `signal`, each owned operation started under it
 * stops and settles through its own exit, and the launcher's cleanup then
 * runs to completion. Later requests join the same cancellation.
 */
export class LaunchTermination {
  private readonly controller = new AbortController();
  private readonly listeners = new Map<TerminationSignal, () => void>();

  constructor(private readonly processLike: SignalProcess = process) {
    for (const name of TERMINATION_SIGNALS) {
      const listener = () => {
        if (!this.controller.signal.aborted) this.controller.abort(new LaunchTerminated(name));
      };
      this.listeners.set(name, listener);
      processLike.on(name, listener);
    }
  }

  /** Aborted by the first termination request; its reason is a `LaunchTerminated`. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The signal that requested termination, or null while none has. */
  get requested(): TerminationSignal | null {
    return this.controller.signal.aborted
      ? (this.controller.signal.reason as LaunchTerminated).signal
      : null;
  }

  /**
   * Run `stop` once termination is requested (immediately when it already
   * was). Owned resources register their stop request here; the launcher
   * still joins each one in its own cleanup. Returns a function that
   * unregisters `stop` once its resource has settled.
   */
  onRequest(stop: (signal: TerminationSignal) => void): () => void {
    const signal = this.controller.signal;
    const run = () => stop((signal.reason as LaunchTerminated).signal);
    if (signal.aborted) {
      run();
      return () => {};
    }
    signal.addEventListener("abort", run, { once: true });
    return () => signal.removeEventListener("abort", run);
  }

  /** End the ownership scope; the signals' default actions apply again. */
  dispose(): void {
    for (const [name, listener] of this.listeners) this.processLike.off(name, listener);
    this.listeners.clear();
  }
}

/**
 * Run one owned child process to its exit. A termination request asks the
 * child to stop (SIGTERM) and the returned promise still settles only when
 * the child has exited, so the launcher never retires state under it.
 */
export function runOwnedChild(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    termination?: LaunchTermination;
  }
): Promise<number> {
  return new Promise((resolve, reject) => {
    options.termination?.signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    const unregister = options.termination?.onRequest(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      unregister?.();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      unregister?.();
      const name = path.basename(command);
      if (options.termination?.signal.aborted) {
        reject(options.termination.signal.reason);
        return;
      }
      if (signal) {
        reject(new Error(`${name} exited on ${signal}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        reject(new Error(`${name} exited with code ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
  });
}

/**
 * Stop a workspace-release producer and join it. Its `completed` settles only
 * after the producer process and its streams are joined, so a rejection from
 * `stop` is the producer's own outcome, never a failure to retire it: the
 * launch already observed that outcome by awaiting `completed`, or it is the
 * effect of a termination request (a hang-up reaches the producer, which
 * shares the terminal's process group, before the launcher can ask it to
 * stop). Owned state under the producer may be removed once this settles.
 */
export async function joinProducer(producer: { stop(): Promise<void> } | undefined): Promise<void> {
  await producer?.stop().catch(() => {});
}
