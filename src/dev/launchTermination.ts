import * as path from "node:path";
import type { StdioOptions } from "node:child_process";
import type { Ownership } from "@vibestudio/shared/ownership";

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
      const listener = () => this.request(name);
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
   * Request termination programmatically, as a signal would: the lease that
   * keeps this launcher alive was revoked, or its reaper was lost. Joins the
   * same single cancellation.
   */
  request(name: TerminationSignal): void {
    if (!this.controller.signal.aborted) this.controller.abort(new LaunchTerminated(name));
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
 * Run one child process to its exit as a member of `ownership`: its group is
 * registered with the reaper at spawn, so even this process dying retires it.
 * A termination request asks the child to stop (graceful) and the returned
 * promise still settles only when the child has exited and its group is
 * retired, so the launcher never removes state under it.
 */
export async function runOwnedChild(
  ownership: Ownership,
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    termination?: LaunchTermination;
  }
): Promise<number> {
  options.termination?.signal.throwIfAborted();
  const name = path.basename(command);
  const owned = ownership.spawn(command, args, {
    cwd: process.cwd(),
    env: options.env,
    stdio: options.stdio ?? "inherit",
    kill: "graceful",
    label: name,
  });
  const unregister = options.termination?.onRequest(() => {
    // The join below settles the retirement and reports its failure.
    void owned.retire().catch(() => undefined);
  });
  try {
    const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        owned.child.once("error", reject);
        owned.child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    await owned.join();
    if (options.termination?.signal.aborted) throw options.termination.signal.reason;
    if (status.signal) throw new Error(`${name} exited on ${status.signal}`);
    const exitCode = status.code ?? 1;
    if (exitCode !== 0) throw new Error(`${name} exited with code ${exitCode}`);
    return exitCode;
  } finally {
    unregister?.();
  }
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
