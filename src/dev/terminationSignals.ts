import type { ChildProcess } from "node:child_process";

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Hand a termination signal addressed to this process to `child`, which owns
 * the work, instead of dying on it. This process then ends the way it ends
 * when the child fails, so everything it owns (device drivers started for the
 * command) is retired on its ordinary exit path, not abandoned by the default
 * action of the signal. Returns the release for the forwarding.
 */
export function forwardTerminationSignals(
  child: Pick<ChildProcess, "kill">,
  target: NodeJS.Process = process
): () => void {
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of TERMINATION_SIGNALS) target.on(signal, forward);
  return () => {
    for (const signal of TERMINATION_SIGNALS) target.off(signal, forward);
  };
}

/**
 * Keep this process alive through termination signals while it retires what it
 * owns. Returns the release for the hold.
 */
export function holdThroughTerminationSignals(
  retiring: () => void,
  target: NodeJS.Process = process
): () => void {
  for (const signal of TERMINATION_SIGNALS) target.on(signal, retiring);
  return () => {
    for (const signal of TERMINATION_SIGNALS) target.off(signal, retiring);
  };
}
