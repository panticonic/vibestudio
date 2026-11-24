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
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );
  };
  const receive = (signal, reason) => {
    if (request) return;
    request = { requestedAt: new Date().toISOString(), ...(signal ? { signal } : {}), reason };
    persist();
    controller.abort(request);
  };
  const onSignal = (signal) => receive(signal, `Interrupted by ${signal}`);
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
    complete(names) {
      for (const name of names) if (cases.includes(name)) completed.add(name);
      persist();
    },
    dispose() {
      watcher?.close();
      for (const signal of signals) processSignals.off(signal, onSignal);
    },
  };
}
