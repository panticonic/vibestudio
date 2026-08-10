/**
 * Electron does not turn terminal signals into its asynchronous quit events.
 * Keep the main process alive on the first signal and enter app.quit() so the
 * canonical before-quit/will-quit resource teardown owns the whole shutdown.
 */
interface ProcessSignalTarget {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export function installProcessSignalShutdown(target: ProcessSignalTarget, quit: () => void): void {
  let requested = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    target.on(signal, () => {
      if (requested) return;
      requested = true;
      quit();
    });
  }
  target.on("message", (message: unknown) => {
    if (
      !requested &&
      message !== null &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "vibestudio:dev-shutdown"
    ) {
      requested = true;
      quit();
    }
  });
}
