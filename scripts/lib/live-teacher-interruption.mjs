import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import path from "node:path";

/** Forward once to the command itself, then let its canonical cancellation join. */
export function forwardCommandInterruption(signal, child) {
  const forward = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal.reason?.signal ?? "SIGTERM");
  };
  signal.addEventListener("abort", forward, { once: true });
  if (signal.aborted) forward();
  return () => signal.removeEventListener("abort", forward);
}

/** Async command boundary: signals remain observable while a managed run waits. */
export async function runTeacherCommand(command, args, options, signal) {
  signal?.throwIfAborted();
  const child = spawn(command, args, options);
  const remove = signal ? forwardCommandInterruption(signal, child) : () => {};
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, exitSignal) =>
        resolve({ status: status ?? 1, signal: exitSignal, stdout })
      );
    });
  } finally {
    remove();
  }
}

/** One explicit request stops admission; retirement/evidence commands stay usable. */
export function collectionInterruption({ requestPath, out, cases, processSignals = process }) {
  const controller = new AbortController();
  const completed = new Set();
  const interruptedReasons = new Map();
  let request;
  let watcher;
  const persist = () => {
    if (!request) return;
    writeFileSync(
      path.join(out, "collection-interruption.json"),
      JSON.stringify(
        {
          ...request,
          interruptedCases: cases.filter((name) => !completed.has(name)),
          completedCases: cases.filter((name) => completed.has(name)),
          ...(interruptedReasons.size ? { interruptedReasons: Object.fromEntries(interruptedReasons) } : {}),
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );
  };
  const receive = (signal, reason, abort = true) => {
    if (controller.signal.aborted || request && !abort) return;
    request = {
      ...(request ?? { requestedAt: new Date().toISOString() }),
      ...(signal ? { signal } : {}),
      reason,
      mode: abort ? "interrupt" : "drain",
    };
    persist();
    if (abort) controller.abort(request);
  };
  let unixSignalReceived = false;
  const onSignal = (signal) => {
    if (unixSignalReceived) {
      // A file checkpoint plus its first Unix signal is one request. Only a
      // second actual Unix signal explicitly abandons canonical cleanup.
      watcher?.close();
      for (const registered of signals) processSignals.off(registered, onSignal);
      processSignals.kill(processSignals.pid, signal);
      return;
    }
    unixSignalReceived = true;
    receive(signal, `Interrupted by ${signal}`);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) processSignals.on(signal, onSignal);
  const checkRequest = () => {
    if (!existsSync(requestPath)) return;
    let value;
    try {
      value = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch {
      /* Creation itself is the request; metadata is optional. */
    }
    receive(undefined, typeof value?.reason === "string" ? value.reason : "Checkpoint requested");
  };
  if (requestPath) {
    watcher = watch(path.dirname(requestPath), (_event, name) => {
      if (name === null || String(name) === path.basename(requestPath)) checkRequest();
    });
    checkRequest();
  }
  return {
    signal: controller.signal,
    get requested() { return request !== undefined; },
    drainAtBoundary(drainPath) {
      if (!drainPath || !existsSync(drainPath)) return false;
      receive(undefined, "Graceful runtime boundary drain requested", false);
      return true;
    },
    stopAdmission(reason) {
      receive(undefined, reason, false);
    },
    complete(names) {
      for (const name of names) if (cases.includes(name)) { completed.add(name); interruptedReasons.delete(name); }
      persist();
    },
    defer(name, reason) {
      completed.delete(name);
      interruptedReasons.set(name, reason);
      persist();
    },
    dispose() {
      watcher?.close();
      for (const signal of signals) processSignals.off(signal, onSignal);
    },
  };
}
