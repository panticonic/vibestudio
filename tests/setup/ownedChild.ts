import type { ChildProcess } from "node:child_process";

/** Observe retirement from allocation, before a fast child can emit close. */
export function ownChild(child: ChildProcess): { retire(): Promise<void> } {
  let closed = false;
  const failures: Error[] = [];
  const closure = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  child.on("error", (error) => {
    failures.push(error);
  });
  return {
    async retire() {
      if (!closed && child.exitCode === null && child.signalCode === null) {
        // A refusal is not retirement: callers must keep the child's state.
        const sent = child.kill("SIGTERM");
        if (!sent)
          throw (
            failures[0] ?? new Error(`Owned child ${child.pid ?? "without PID"} refused SIGTERM`)
          );
      }
      // exit is insufficient: inherited stdio and child resources own close.
      await closure;
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Owned child retirement failed", { cause: failures[0] });
    },
  };
}

export async function attemptCleanup(actions: Array<() => void | Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Independent resource cleanup failed", { cause: errors[0] });
}
