/** Join the process and its owned streams, including explicit IPC revocation.
 * Node 22 can leave ChildProcess.close unsettled after disconnect(): the
 * process and pipes have closed, but its internal IPC close counter is short.
 * The native owner's exit is its descendant-join receipt. */
export function joinChildProcess(child) {
  return new Promise((resolve) => {
    let terminal = child.exitCode !== null || child.signalCode !== null;
    let code = child.exitCode,
      signal = child.signalCode,
      error;
    const streams = [child.stdout, child.stderr].filter(Boolean);
    const finish = () => {
      if (!terminal || child.connected || streams.some((stream) => !stream.closed)) return;
      child.off("exit", exited);
      child.off("error", failed);
      child.off("disconnect", finish);
      for (const stream of streams) stream.off("close", finish);
      resolve({ code, signal, error });
    };
    const exited = (exitCode, exitSignal) => {
      terminal = true;
      code = exitCode;
      signal = exitSignal;
      finish();
    };
    const failed = (failure) => {
      error ??= failure;
      if (child.pid === undefined) terminal = true;
      finish();
    };
    child.on("exit", exited);
    child.on("error", failed);
    child.on("disconnect", finish);
    for (const stream of streams) stream.on("close", finish);
    finish();
  });
}
