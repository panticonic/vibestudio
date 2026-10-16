/**
 * What `pnpm dev:terminal`, `pnpm start:terminal` and `vibestudio terminal` tell the person while the
 * terminal browser is still being made ready.
 *
 * Every line is the report of something that really happened: a step began, a
 * step reported its own detail (templates prepared 2/3, the server's current
 * activation status), a step finished and how long it took, a step failed.
 * Nothing here estimates, animates or invents progress. The output is
 * append-only, so it reads the same on a terminal, in a pipe and in a log.
 */
export interface LaunchProgress {
  /** Begin the next step. The previous step, if still open, ends first. */
  step(label: string): LaunchStep;
  /** A standalone fact that belongs to no step (a restart the person should know about). */
  note(line: string): void;
}

export interface LaunchStep {
  /** A fact the step learned while running (a count, the current item, a status). */
  note(line: string): void;
  /** The step succeeded; reports how long it took. */
  done(): void;
  /** The step failed; the caller reports the error and its next step. */
  fail(): void;
}

export interface LaunchProgressOptions {
  write(line: string): void;
  /** Steps this launch will run, when that is known up front. */
  total?: number;
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
}

export function createLaunchProgress(options: LaunchProgressOptions): LaunchProgress {
  const now = options.now ?? (() => performance.now());
  let index = 0;
  let open: { close(outcome: "done" | "failed"): void } | null = null;
  return {
    step(label) {
      open?.close("done");
      index += 1;
      const startedAt = now();
      // A later pass (an app update, a workspace switch) runs past the count
      // announced for the first launch; it is then simply not numbered.
      const prefix = options.total && index <= options.total ? `[${index}/${options.total}] ` : "";
      const indent = " ".repeat(prefix.length || 2);
      options.write(`${prefix}${label}…`);
      let closed = false;
      const close = (outcome: "done" | "failed") => {
        if (closed) return;
        closed = true;
        if (open === handle) open = null;
        options.write(`${indent}${outcome} after ${formatElapsed(now() - startedAt)}`);
      };
      const handle = { close };
      open = handle;
      return {
        note(line) {
          if (!closed) options.write(`${indent}${line}`);
        },
        done: () => close("done"),
        fail: () => close("failed"),
      };
    },
    note: (line) => options.write(line),
  };
}

export function formatElapsed(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 120) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Run one step: it ends `done` when `run` resolves and `failed` when it throws. */
export async function runStep<T>(
  progress: LaunchProgress,
  label: string,
  run: (step: LaunchStep) => Promise<T>
): Promise<T> {
  const step = progress.step(label);
  try {
    const result = await run(step);
    step.done();
    return result;
  } catch (error) {
    step.fail();
    throw error;
  }
}
