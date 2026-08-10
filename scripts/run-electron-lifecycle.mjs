const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

export function createRunnerShutdown({
  activeChildren,
  exit,
  requestGracefulStop = (child, signal) => child.kill(signal),
  graceMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let requestedSignal = null;
  let forceTimer = null;

  const liveChildren = () =>
    [...activeChildren].filter((child) => child.exitCode === null && child.signalCode === null);

  const finish = () => {
    if (!requestedSignal) return;
    if (forceTimer) clearTimer(forceTimer);
    forceTimer = null;
    exit(signalExitCode(requestedSignal));
  };

  return {
    request(signal) {
      if (requestedSignal) return;
      requestedSignal = signal;
      const children = liveChildren();
      if (children.length === 0) {
        finish();
        return;
      }
      for (const child of children) requestGracefulStop(child, signal);
      forceTimer = setTimer(() => {
        for (const child of liveChildren()) child.kill("SIGKILL");
        finish();
      }, graceMs);
    },

    childExited() {
      if (requestedSignal && liveChildren().length === 0) finish();
    },

    requestedSignal() {
      return requestedSignal;
    },
  };
}
